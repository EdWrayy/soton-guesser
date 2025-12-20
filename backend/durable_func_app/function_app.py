import azure.functions as func
import azure.durable_functions as df
import json
import logging
from datetime import timedelta

app = df.DFApp(http_auth_level=func.AuthLevel.ANONYMOUS)


# TRIGGER
@app.route(route="start_game_trigger")
@app.durable_client_input(client_name="client")
async def http_start(req: func.HttpRequest, client: df.DurableOrchestrationClient):
    payload = req.get_json()
    game_id = payload.get("game_id")
    
    instance_id = await client.start_new("game_orchestrator", None, payload)
    
    logging.info(f"Started orchestration with ID = '{instance_id}'.")
    return client.create_check_status_response(req, instance_id)

# ORCHESTRATOR
@app.orchestration_trigger(context_name="context")
def game_orchestrator(context: df.DurableOrchestrationContext):
    input_data = context.get_input()
    game_id = input_data.get("game_id")
    num_rounds = input_data.get("rounds", 5)

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
    return {
        "image_url": f"https://mystorage.blob.core.windows.net/maps/loc.jpg?token=...",
        "location_id": "loc_123"
    }

@app.activity_trigger(input_name="gameId")
def process_scores(gameId: str):
    """
    Logic for Step 9:
    - Fetches all guesses collected by the /guess function (stored in Redis)
    - Calculates scores
    - Persists final round scores to Cosmos DB
    """
    return {"top_player": "Alice", "score": 1200}

@app.activity_trigger(input_name="data")
@app.generic_output_binding(arg_name="signalRMessages", type="signalR", hubName="test", connectionStringSetting="SignalRConnection")
def signalr_broadcast(data: dict, signalRMessages: func.Out[str]):
    """
    Generic SignalR broadcaster
    """
    message = {
        "target": data['target'],
        "arguments": data['arguments']
    }
    signalRMessages.set(json.dumps(message))