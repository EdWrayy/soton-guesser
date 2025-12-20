import azure.functions as func
import json
import math
import redis
import os

r = redis.StrictRedis(
    host=os.getenv("RedisHost"), 
    port=6380, 
    password=os.getenv("RedisKey"), 
    ssl=True, 
    decode_responses=True
)

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
    body = json.loads(msg.get_body().decode('utf-8'))
    game_id = body['game_id']
    player_id = body['player_id']
    player_lat = body['lat']
    player_lon = body['lon']

    ans_raw = r.get(f"match:{game_id}:ans")
    if not ans_raw:
        return

    ans_data = json.loads(ans_raw)
    
    distance = calculate_distance(player_lat, player_lon, ans_data['lat'], ans_data['lon'])
    score = max(0, 5000 - int(distance))

    guess_entry = {
        "player_id": player_id,
        "dist_km": round(distance, 2),
        "score": score
    }
    
    r.hset(f"match:{game_id}:round_guesses", player_id, json.dumps(guess_entry))