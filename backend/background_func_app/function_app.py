import azure.functions as func
import json
import math
import redis
import os
import logging

r = redis.StrictRedis(
    host=os.getenv("RedisHost"), 
    port=int(os.getenv("RedisPort", 6380)),
    password=os.getenv("RedisKey"), 
    ssl=True, 
    decode_responses=True
)

app = func.FunctionApp()

def calculate_distance(lat1, lon1, lat2, lon2):
    """Haversine formula to calculate distance in km"""
    R = 6371
    d_lat = math.radians(lat2 - lat1)
    d_lon = math.radians(lon2 - lon1)
    a = (math.sin(d_lat / 2)**2 + 
         math.cos(math.radians(lat1)) * math.cos(math.radians(lat2)) * math.sin(d_lon / 2)**2)
    c = 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))
    return R * c

@app.service_bus_queue_trigger(arg_name="msg", queue_name="guesses", connection="ServiceBusConn")
def process_guess_queue(msg: func.ServiceBusMessage):
    try:
        body = json.loads(msg.get_body().decode('utf-8'))
        logging.info(f"process_guess_queue: received message={body}")
    except Exception as e:
        logging.exception(f"process_guess_queue: failed to parse message body: {e}")
        return

    game_id = body.get('game_id')
    player_id = body.get('player_id')
    player_lat = body.get('lat')
    player_lon = body.get('lon')
    round_no = body.get('round_no')

    if not all([game_id, player_id, player_lat is not None, player_lon is not None]):
        logging.warning(f"process_guess_queue: missing required fields. game_id={game_id}, player_id={player_id}")
        return

    logging.warning(f"process_guess_queue: game_id={game_id}, player_id={player_id}, guess=({player_lat}, {player_lon})")

    ans_key = f"match:{game_id}:round:{round_no}:answer"
    try:
        ans_raw = r.get(ans_key)
        if not ans_raw:
            logging.warning(f"process_guess_queue: no answer found in Redis key '{ans_key}'")
            return
        logging.info(f"process_guess_queue: fetched answer from Redis key '{ans_key}'")
    except Exception as e:
        logging.exception(f"process_guess_queue: failed to read answer from Redis: {e}")
        return

    try:
        ans_data = json.loads(ans_raw)
        logging.info(f"process_guess_queue: answer location=({ans_data.get('lat')}, {ans_data.get('lon')})")
    except Exception as e:
        logging.exception(f"process_guess_queue: invalid JSON in answer: {e}")
        return
    
    distance = calculate_distance(player_lat, player_lon, ans_data['lat'], ans_data['lon'])
    score = max(0, 5000 - int(distance))
    logging.info(f"process_guess_queue: calculated distance={round(distance, 2)}km, score={score}")

    guess_entry = {
        "player_id": player_id,
        "dist_km": round(distance, 2),
        "score": score
    }
    
    guesses_key = f"match:{game_id}:round_guesses"
    try:
        r.hset(guesses_key, player_id, json.dumps(guess_entry))
        logging.info(f"process_guess_queue: stored guess in Redis key '{guesses_key}' for player_id={player_id}")
    except Exception as e:
        logging.exception(f"process_guess_queue: failed to write guess to Redis: {e}")
        return

    logging.info("process_guess_queue: completed successfully")