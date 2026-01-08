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
    a = (
        math.sin(d_lat / 2) ** 2
        + math.cos(math.radians(lat1)) * math.cos(math.radians(lat2)) * math.sin(d_lon / 2) ** 2
    )
    c = 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))
    return R * c

def score_city(distance_km: float, max_score: int = 5000, k: float = 0.5) -> int:
    """
    City-only scoring curve (exponential decay).
    k is the decay length in km:
      - k=0.25 => very strict (scores drop hard after ~250m)
      - k=0.35 => slightly more forgiving
    """
    score = int(round(max_score * math.exp(-distance_km / k)))
    return max(0, min(max_score, score))

@app.service_bus_queue_trigger(arg_name="msg", queue_name="guesses", connection="ServiceBusConn")
def process_guess_queue(msg: func.ServiceBusMessage):
    try:
        body = json.loads(msg.get_body().decode("utf-8"))
        logging.info(f"process_guess_queue: received message={body}")
    except Exception as e:
        logging.exception(f"process_guess_queue: failed to parse message body: {e}")
        return

    game_id = body.get("game_id")
    player_id = body.get("player_id")
    player_lat = body.get("lat")
    player_lon = body.get("lon")
    round_no = body.get("round_no")

    if not all([game_id, player_id, player_lat is not None, player_lon is not None, round_no is not None]):
        logging.warning(
            f"process_guess_queue: missing required fields. "
            f"game_id={game_id}, player_id={player_id}, round_no={round_no}"
        )
        return

    try:
        player_lat = float(player_lat)
        player_lon = float(player_lon)
    except Exception:
        logging.warning(
            f"process_guess_queue: invalid lat/lon types. "
            f"player_id={player_id} lat={player_lat} lon={player_lon}"
        )
        return

    logging.warning(
        f"process_guess_queue: game_id={game_id}, player_id={player_id}, guess=({player_lat}, {player_lon}), round_no={round_no}"
    )

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
        ans_lat = float(ans_data["lat"])
        ans_lon = float(ans_data["lon"])
        logging.info(f"process_guess_queue: answer location=({ans_lat}, {ans_lon})")
    except Exception as e:
        logging.exception(f"process_guess_queue: invalid JSON in answer: {e}")
        return

    distance = calculate_distance(player_lat, player_lon, ans_lat, ans_lon)

    # City-only scoring: make it much harder to score highly unless you are very close.
    # Tuning knob: k (km). Smaller = harsher, larger = more forgiving.
    score = score_city(distance, max_score=5000, k=0.25)

    logging.info(f"process_guess_queue: calculated distance={round(distance, 3)}km, score={score}")

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
