import datetime
import azure.functions as func
import azure.durable_functions as df
import json
import logging
import random
from datetime import timedelta
import os
import redis
from azure.cosmos import CosmosClient

app = df.DFApp(http_auth_level=func.AuthLevel.ANONYMOUS)

COSMOS_STR = os.getenv("CosmosDBConnectionString")
REDIS_HOST = os.getenv("RedisHost")
REDIS_PORT = os.getenv("RedisPort", 6380)
REDIS_KEY = os.getenv("RedisKey")
BLOB_STR = os.getenv("AzureWebJobsStorage")

DB_NAME = os.getenv("COSMOS_DATABASE_NAME", "soton-guessr")
PLACES_CONTAINER = os.getenv("COSMOS_PLACES_CONTAINER", "places")
RESULTS_CONTAINER = os.getenv("COSMOS_RESULTS_CONTAINER", "Results")

cosmos_client = CosmosClient.from_connection_string(COSMOS_STR)
db = cosmos_client.get_database_client(DB_NAME)
places_col = db.get_container_client(PLACES_CONTAINER)
results_col = db.get_container_client(RESULTS_CONTAINER)
# Allow local runs without Redis configured
r = None
if REDIS_HOST and "your-redis-host" not in REDIS_HOST:
    r = redis.StrictRedis(host=REDIS_HOST, port=REDIS_PORT, password=REDIS_KEY, ssl=True, decode_responses=True)

# TRIGGER
@app.route(route="start_game_trigger")
@app.durable_client_input(client_name="client")
async def http_start(req: func.HttpRequest, client: df.DurableOrchestrationClient):
    payload = req.get_json()
    game_id = payload.get("game_id")
    
    # Normalize payload to accept game_id, gameId, or matchCode
    if not game_id:
        game_id = payload.get("gameId") or payload.get("matchCode")
    if not game_id:
        return func.HttpResponse("Missing game_id/gameId/matchCode", status_code=400)
    
    # Update payload with normalized game_id
    payload["game_id"] = game_id
    
    # Use game_id as instance_id to prevent duplicate orchestrations
    instance_id = await client.start_new("game_orchestrator", str(game_id), payload)
    
    logging.warning(f"Started orchestration with ID = '{instance_id}' for game_id={game_id}.")
    return client.create_check_status_response(req, instance_id)

# ORCHESTRATOR
@app.orchestration_trigger(context_name="context")
def game_orchestrator(context: df.DurableOrchestrationContext):
    input_data = context.get_input()
    game_id = input_data.get("game_id")
    logging.warning(f"game_orchestrator: Starting game_id={game_id}")
    num_rounds = input_data.get("rounds", 3)

    for round_num in range(1, num_rounds + 1):
    
        round_setup = yield context.call_activity("prepare_round", {"game_id": game_id, "round": round_num})
        
        yield context.call_activity("signalr_broadcast", {
            "game_id": game_id,
            "target": "newRound",
            "arguments": [round_setup['image_url'], round_setup['location_id']]
        })

        round_timeout = context.current_utc_datetime + timedelta(seconds=30)
        yield context.create_timer(round_timeout)

        yield context.call_activity("signalr_broadcast", {
            "game_id": game_id,
            "target": "roundEnded",
            "arguments": ["Time is up!"]
        })

        round_results = yield context.call_activity("process_scores", game_id)
        
        yield context.call_activity("signalr_broadcast", {
            "game_id": game_id,
            "target": "updateLeaderboard",
            "arguments": [round_results]
        })
        
        # Short pause between rounds
        inter_round_timeout = context.current_utc_datetime + timedelta(seconds=10)
        yield context.create_timer(inter_round_timeout)
        
    yield context.call_activity("final_scores_to_cosmos", {"game_id": game_id})

    yield context.call_activity("signalr_broadcast", {
        "game_id": game_id,
        "target": "gameOver",
        "arguments": ["Game Over! Thanks for playing."]
    })

    return "Game Completed"

# ACTIVITIES

@app.activity_trigger(input_name="params")
def prepare_round(params: dict):
    """
    Logic for Steps 2, 3, 4: 
    - Picks a location from CosmosDB
    - Generates a Blob SAS token
    - Saves the 'answer' to Redis for score validation later
    """
    game_id = params['game_id']
    round_num = params['round']

    # Randomly pick any document from the container
    total_items = list(places_col.query_items(
        query="SELECT VALUE COUNT(1) FROM c",
        enable_cross_partition_query=True,
    ))
    total_count = total_items[0] if total_items else 0
    if total_count == 0:
        logging.error("prepare_round: No places found in Cosmos container")
        raise Exception("No places found in Cosmos container")

    random_index = random.randint(0, total_count - 1)
    query = f"SELECT * FROM c OFFSET {random_index} LIMIT 1"
    logging.warning(f"prepare_round: game_id={game_id} round={round_num} selecting random place at index {random_index} of {total_count}")
    items = list(places_col.query_items(
        query=query,
        enable_cross_partition_query=True,
    ))

    place = items[0]
    logging.warning(f"prepare_round: selected place id={place.get('id')}")


    answer_key = f"match:{game_id}:round:{round_num}:answer"
    coords = {"lat": place["location"]["lat"], "lon": place["location"]["lon"]}
    if r:
        try:
            r.set(answer_key, json.dumps(coords))
            logging.warning(f"prepare_round: cached answer in Redis key='{answer_key}'")
        except Exception as e:
            logging.warning(f"Redis not available, skipping answer cache: {e}")

    from azure.storage.blob import BlobServiceClient, generate_blob_sas, BlobSasPermissions
    blob_service_client = BlobServiceClient.from_connection_string(BLOB_STR)
    blob_container = place["blob"]["container"]
    blob_name = place["blob"]["name"]
    blob_client = blob_service_client.get_blob_client(container=blob_container, blob=blob_name)
    sas_token = generate_blob_sas(
        account_name=blob_service_client.account_name,
        container_name=blob_container,
        blob_name=blob_name,
        account_key=blob_service_client.credential.account_key,
        permission=BlobSasPermissions(read=True),
        expiry=datetime.datetime.utcnow() + timedelta(minutes=5)
    )

    signed_url = f"{blob_client.url}?{sas_token}"
    logging.warning("prepare_round: generated SAS URL for image")

    return {
        "image_url": signed_url,
        "round": round_num,
        "location_id": place['id']
    }

@app.activity_trigger(input_name="game_id")
def process_scores(game_id: str):
    logging.info(f"process_scores: start for game_id={game_id}")
    if r is None:
        logging.warning("process_scores: Redis not configured; aborting")
        raise Exception("Redis not configured")

    guesses_key = f"match:{game_id}:round_guesses"
    scores_key = f"match:{game_id}:scores"
    try:
        all_guesses_raw = r.hgetall(guesses_key)
        logging.warning(f"process_scores: fetched {len(all_guesses_raw)} guesses from '{guesses_key}'")
    except Exception as e:
        logging.exception(f"process_scores: failed to read guesses from Redis key '{guesses_key}': {e}")
        raise
    
    round_results = []
    
    for player_id, json_data in all_guesses_raw.items():
        try:
            guess_data = json.loads(json_data)
        except Exception:
            logging.exception(f"process_scores: invalid JSON for player_id={player_id}: {json_data}")
            continue

        score = guess_data.get("score", 0)
        logging.warning(f"process_scores: player_id={player_id} score={score}")
        round_results.append({
            "player_id": player_id,
            "data": guess_data
        })

        try:
            r.zincrby(scores_key, score, player_id)
        except Exception:
            logging.exception(f"process_scores: failed to ZINCRBY '{scores_key}' for player_id={player_id}")

    
    
    try:
        r.delete(guesses_key)
        logging.warning(f"process_scores: deleted Redis key '{guesses_key}'")
    except Exception as e:
        logging.warning(f"process_scores: could not delete Redis key '{guesses_key}': {e}")

    logging.info("process_scores: completed")
    return round_results

@app.activity_trigger(input_name="payload")
def final_scores_to_cosmos(payload: dict):
    """
    Store final scores in CosmosDB
    game_result_doc = {
        "id": f"{game_id}_{int(datetime.datetime.utcnow().timestamp())}",
        "game_id": game_id,
        "round_scores": round_results,
        "timestamp": str(datetime.datetime.utcnow())
    }
    logging.warning(f"process_scores: upserting results to Cosmos. results_len={len(round_results)}")
    try:
        results_col.upsert_item(game_result_doc)
    except Exception:
        logging.exception("process_scores: failed to upsert results to Cosmos")
        raise
    """
    game_id = payload['game_id']
    
    # Get scores from Redis
    scores_key = f"match:{game_id}:scores"
    if r is None:
        logging.warning("final_scores_to_cosmos: Redis not configured; aborting")
        raise Exception("Redis not configured")
    try:
        all_scores = r.zrevrange(scores_key, 0, -1, withscores=True)
        logging.warning(f"final_scores_to_cosmos: fetched {len(all_scores)} final scores from Redis key '{scores_key}'")
    except Exception as e:
        logging.exception(f"final_scores_to_cosmos: failed to read final scores from Redis key '{scores_key}': {e}")
        raise e
    round_results = []
    for player_id, score in all_scores:
        round_results.append({
            "player_id": player_id,
            "score": int(score)
        })
    game_result_doc = {
        "id": f"{game_id}_{int(datetime.datetime.utcnow().timestamp())}",
        "game_id": game_id,
        "final_scores": round_results,
        "timestamp": str(datetime.datetime.utcnow())
    }
    logging.warning(f"final_scores_to_cosmos: upserting results to Cosmos. results_len={len(round_results)}")
    
    try:
        results_col.upsert_item(game_result_doc)
        logging.warning("final_scores_to_cosmos: upserted results to Cosmos successfully")
    except Exception:
        logging.exception("final_scores_to_cosmos: failed to upsert results to Cosmos")
        raise
    
    return
    
    

@app.activity_trigger(input_name="payload")
@app.generic_output_binding(arg_name="signalRMessages", type="signalR", hubName="test", connectionStringSetting="SignalRConnection")
def signalr_broadcast(payload: dict, signalRMessages: func.Out[str]):
    """
    Generic SignalR broadcaster
    """
    
    message = {
        "target": payload['target'],
        "arguments": payload['arguments']
    }
    signalRMessages.set(json.dumps(message))