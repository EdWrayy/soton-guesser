import random
import azure.functions as func
import datetime
import json
import logging
import os
import uuid
import bcrypt
import base64
import binascii
from typing import Any, Dict, Optional
from azure.storage.blob import BlobServiceClient, ContentSettings
from azure.cosmos import exceptions

from azure.cosmos import CosmosClient, exceptions
from azure.servicebus import ServiceBusClient, ServiceBusMessage

app = func.FunctionApp()

# ----- Cosmos init -----
COSMOS_CONNECTION_STRING = os.environ["COSMOS_CONNECTION_STRING"]
DB_NAME = os.environ.get("COSMOS_DATABASE_NAME", "soton-guessr")

USERS = os.environ.get("COSMOS_USERS_CONTAINER", "users")
SCORES = os.environ.get("COSMOS_SCORES_CONTAINER", "scores")
LEADERBOARD = os.environ.get("COSMOS_LEADERBOARD_CONTAINER", "leaderboard")
MATCHES = os.environ.get("COSMOS_MATCHES_CONTAINER", "matches")
PLACES = os.environ.get("COSMOS_PLACES_CONTAINER", "places")
LEASES = os.environ.get("COSMOS_LEASES_CONTAINER", "leases")
RESULTS = os.environ.get("COSMOS_RESULTS_CONTAINER", "Results")

client = CosmosClient.from_connection_string(COSMOS_CONNECTION_STRING)
db = client.get_database_client(DB_NAME)

users_container = db.get_container_client(USERS)
scores_container = db.get_container_client(SCORES)
leaderboard_container = db.get_container_client(LEADERBOARD)
matches_container = db.get_container_client(MATCHES)
places_container = db.get_container_client(PLACES)
results_container = db.get_container_client(RESULTS)


# ---- Blob init ---- 
AZURE_STORAGE_CONNECTION_STRING = os.environ["AZURE_STORAGE_CONNECTION_STRING"]
BLOB_CONTAINER_NAME = os.environ.get("BLOB_CONTAINER_NAME", "places-images")
blob_service = BlobServiceClient.from_connection_string(AZURE_STORAGE_CONNECTION_STRING)
blob_container = blob_service.get_container_client(BLOB_CONTAINER_NAME)

# ----- Helpers -----
def _json(payload: Dict[str, Any], status: int = 200) -> func.HttpResponse:
    return func.HttpResponse(json.dumps(payload), status_code=status, mimetype="application/json")

def _now_z() -> str:
    return datetime.datetime.now(datetime.timezone.utc).isoformat().replace("+00:00", "Z")

def _month_scope() -> str:
    return "month:" + datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m")

def _norm_username(u: str) -> str:
    return u.lower().strip()

def _get_user_by_username(username: str) -> Optional[Dict[str, Any]]:
    # Parameterised query to avoid injection
    query = "SELECT TOP 1 * FROM c WHERE c.username = @u"
    params = [{"name": "@u", "value": username}]
    results = list(users_container.query_items(query=query, parameters=params, enable_cross_partition_query=True))
    return results[0] if results else None

def _get_user_by_user_id(user_id: str) -> Optional[Dict[str, Any]]:
    # Parameterised query to avoid injection
    query = "SELECT TOP 1 * FROM c WHERE c.userId = @u"
    params = [{"userId": "@u", "value": user_id}]
    results = list(users_container.query_items(query=query, parameters=params, enable_cross_partition_query=True))
    return results[0] if results else None

def _inc_score(user_id: str, scope: str, display_name: str, delta: int) -> None:
    now = _now_z()
    try:
        # PK is /userId
        doc = scores_container.read_item(item=scope, partition_key=user_id)
    except exceptions.CosmosResourceNotFoundError:
        doc = {
            "id": scope,          # id is just the scope now
            "userId": user_id,    # must exist because it's your PK path
            "scope": scope,
            "score": 0,
            "displayName": display_name,
        }

    doc["score"] = int(doc.get("score", 0)) + int(delta)
    doc["displayName"] = display_name
    doc["updatedAt"] = now

    scores_container.upsert_item(doc)

def _enqueue_guess(game_id:str, player_id: str, lat: float, lon: float):
    conn_str = os.environ["ServiceBusConnection"]
    queue_name = "guesses"

    payload = {
        "game_id": game_id,
        "player_id": player_id,
        "lat": lat,
        "lon": lon
    }

    with ServiceBusClient.from_connection_string(conn_str) as client:
        with client.get_queue_sender(queue_name) as sender:
            sender.send_messages(
                ServiceBusMessage(
                    json.dumps(payload),
                    content_type="application/json"
                )
            )

@app.route(route="register", auth_level=func.AuthLevel.FUNCTION, methods=["POST"])
def register(req: func.HttpRequest) -> func.HttpResponse:
    try:
        body = req.get_json()
        username = _norm_username(body["username"])
        password = body["password"]

        if _get_user_by_username(username):
            return _json({"result": False, "msg": "Username already exists"}, 409)

        user_doc = {
            "id": str(uuid.uuid4()),
            "username": username,
            "displayName": username,
            "passwordHash": bcrypt.hashpw(password.encode("utf-8"), bcrypt.gensalt()).decode("utf-8"),
            "createdAt": _now_z(),
        }
        users_container.create_item(user_doc)
        return _json({"result": True, "msg": "OK"}, 201)

    except Exception as e:
        logging.exception("register failed")
        return _json({"result": False, "msg": str(e)}, 500)

@app.route(route="login", auth_level=func.AuthLevel.FUNCTION, methods=["POST"])
def login(req: func.HttpRequest) -> func.HttpResponse:
    try:
        body = req.get_json()
        username = _norm_username(body["username"])
        password = body["password"]

        user = _get_user_by_username(username)
        if not user:
            return _json({"result": False, "msg": "Username or password incorrect"}, 401)

        if not bcrypt.checkpw(password.encode("utf-8"), user["passwordHash"].encode("utf-8")):
            return _json({"result": False, "msg": "Username or password incorrect"}, 401)

        return _json({"result": True, "msg": "OK", "userId": user["id"], "displayName": user.get("displayName", username)})

    except Exception as e:
        logging.exception("login failed")
        return _json({"result": False, "msg": str(e)}, 500)



@app.route(route="add_score", auth_level=func.AuthLevel.FUNCTION, methods=["POST"])
def add_score(req: func.HttpRequest) -> func.HttpResponse:
    """
    Called when a game ends.
    Body: {"username":"bob","delta":123}
    Updates scores for:
      - alltime
      - current month
    Leaderboard updates via change feed.
    """
    try:
        body = req.get_json()
        username = _norm_username(body["username"])
        delta = int(body["delta"])

        if delta < 0:
            return _json({"result": False, "msg": "delta must be non-negative"}, 400)

        user = _get_user_by_username(username)
        if not user:
            return _json({"result": False, "msg": "User not found"}, 404)

        user_id = user["id"]
        display_name = user.get("displayName", username)

        _inc_score(user_id, "alltime", display_name, delta)
        _inc_score(user_id, _month_scope(), display_name, delta)

        return _json({"result": True, "msg": "OK"})

    except Exception as e:
        logging.exception("add_score failed")
        return _json({"result": False, "msg": str(e)}, 500)



@app.route(route="leaderboard", auth_level=func.AuthLevel.FUNCTION, methods=["GET"])
def leaderboard(req: func.HttpRequest) -> func.HttpResponse:
    """
    Reads leaderboard
    GET /leaderboard?scope=alltime&limit=10
    GET /leaderboard?scope=month:2025-12&limit=10
    """
    try:
        scope = req.params.get("scope") or "alltime"
        limit = int(req.params.get("limit") or "10")
        limit = max(1, min(limit, 100))

        query = f"""
        SELECT TOP {limit} c.userId, c.displayName, c.score, c.updatedAt
        FROM c
        WHERE c.scope = @s
        ORDER BY c.score DESC
        """
        params = [{"name": "@s", "value": scope}]

        items = list(leaderboard_container.query_items(
            query=query,
            parameters=params,
            enable_cross_partition_query=False
        ))

        return _json({"result": True, "scope": scope, "top": items})

    except Exception as e:
        logging.exception("leaderboard failed")
        return _json({"result": False, "msg": str(e)}, 500)

# Updates leaderboard automatically when score updates are made
@app.function_name(name="scores_to_leaderboard")
@app.cosmos_db_trigger(
    arg_name="documents",
    database_name=DB_NAME,
    container_name=SCORES,
    connection="COSMOS_CONNECTION_STRING",
    lease_container_name=LEASES,
    create_lease_container_if_not_exists=True,
)
def scores_to_leaderboard(documents: func.DocumentList) -> None:
    """
    For each changed score doc, upsert leaderboard row:
      leaderboard pk = /scope
      leaderboard id = userId
    """
    if not documents:
        return

    for d in documents:
        try:
            doc = dict(d)
            lb = {
                "id": doc["userId"],
                "scope": doc["scope"],
                "userId": doc["userId"],
                "displayName": doc.get("displayName", ""),
                "score": int(doc.get("score", 0)),
                "updatedAt": doc.get("updatedAt", _now_z()),
            }
            leaderboard_container.upsert_item(lb)
        except Exception:
            logging.exception("projection failed")


@app.route(route="create_place", auth_level=func.AuthLevel.FUNCTION, methods=["POST"])
def create_place(req: func.HttpRequest) -> func.HttpResponse:
    """
    Expects JSON:
      {
        "name": "Somewhere",
        "lat": 50.93,
        "lon": -1.39,
        "fileType": "jpg" | "jpeg" | "png",
        "imageBase64": "<base64>"
      }
    """
    try:
        body = req.get_json()

        name = (body.get("name") or "").strip()
        file_type = (body.get("fileType") or "").strip().lower()
        lat_raw = body.get("lat")
        lon_raw = body.get("lon")
        image_b64 = body.get("imageBase64")

        if not name:
            return _json({"result": False, "msg": "Missing field: name"}, 400)
        if lat_raw is None or lon_raw is None:
            return _json({"result": False, "msg": "Missing field: lat/lon"}, 400)
        if file_type not in {"png", "jpg", "jpeg"}:
            return _json({"result": False, "msg": "fileType must be one of: png, jpeg, jpg"}, 400)
        if not image_b64:
            return _json({"result": False, "msg": "Missing field: imageBase64"}, 400)

        try:
            lat = float(lat_raw)
            lon = float(lon_raw)
        except (TypeError, ValueError):
            return _json({"result": False, "msg": "lat/lon must be numbers"}, 400)

        if not (-90.0 <= lat <= 90.0 and -180.0 <= lon <= 180.0):
            return _json({"result": False, "msg": "lat/lon out of range"}, 400)

        # Decode base64 (supports data URLs too)
        if isinstance(image_b64, str) and image_b64.startswith("data:"):
            image_b64 = image_b64.split(",", 1)[-1]

        try:
            image_bytes = base64.b64decode(image_b64, validate=True)
        except (binascii.Error, ValueError):
            return _json({"result": False, "msg": "imageBase64 is not valid base64"}, 400)

        if not image_bytes:
            return _json({"result": False, "msg": "Empty image"}, 400)
        if len(image_bytes) > 8 * 1024 * 1024:
            return _json({"result": False, "msg": "Image too large (max 8MB)"}, 413)

        place_id = str(uuid.uuid4())
        ext = f".{file_type}"
        content_type = "image/png" if file_type == "png" else "image/jpeg"
        blob_name = f"{place_id}{ext}"

        # Ensure container exists (ideally do this once at startup, but ok)
        try:
            blob_container.create_container()
        except Exception:
            pass

        blob_client = blob_container.get_blob_client(blob_name)
        blob_client.upload_blob(
            image_bytes,
            overwrite=False,
            content_settings=ContentSettings(content_type=content_type),
        )

        blob_url = blob_client.url

        place_doc = {
            "id": place_id,
            "name": name,
            "location": {"lat": lat, "lon": lon},
            "blob": {"container": BLOB_CONTAINER_NAME, "name": blob_name, "url": blob_url},
            "createdAt": _now_z(),
        }

        places_container = db.get_container_client(os.environ.get("COSMOS_PLACES_CONTAINER", "places"))
        places_container.create_item(place_doc)

        return _json({"result": True, "msg": "OK", "placeId": place_id, "blobUrl": blob_url}, 201)

    except Exception as e:
        logging.exception("Error in create_place")
        return _json({"result": False, "msg": str(e)}, 500)
    
@app.route(route="get_place", auth_level=func.AuthLevel.FUNCTION, methods=["GET"])
def get_place(req: func.HttpRequest) -> func.HttpResponse:
    # GET /get_place

    # Expects:
    # {id: "id"}

    # returns:
    # place : {
    #         "id": place_id,
    #         "name": name,
    #         "location": {"lat": lat, "lon": lon},
    #         "blob": {"container": BLOB_CONTAINER_NAME, "name": blob_name, "url": blob_url},
    #         "createdAt": _now_z(),
    # }
    
    try:
        id = req.params.get("id")
        query = f"SELECT * FROM places p WHERE p.id = {id}"

        place = list(places_container.query_items(query=query, enable_cross_partition_query=True))[0]
        return _json({"result": True, "msg": "OK", "place": place}, 200)
    
    except Exception as e:
        logging.exception("Error in get_place")
        return _json({"result": False, "msg": str(e)}, 500)


    
# Start game
# Initialises a lobby for the game
# Returns a game ID and signal R access token
@app.route(route="create_lobby", auth_level=func.AuthLevel.FUNCTION, methods=["POST"])
@app.signalr_connection_info(
    arg_name="connection_info",
    user_id="{json:playerId}",
    connection_string_setting="AzureSignalRConnectionString"
)
def create_lobby(req: func.HttpRequest, connection_info: dict) -> func.HttpResponse:
    # Expects:
    # {userId: "id"}

    # Adds to matches container:
    # {matchCode: "unique 6 digit code",
    # players: [{userId: "uuid"}] matchSettings:{noOfRounds:int, maxPlayers:int, countdown:int}"}

    try:
        body = req.get_json()
        host_id = body['userId']
        
        # generate 6 character match code
        match_id = random.randint(0, 999999)
        match_id = f"{match_id:06d}"

        # check if a code already exists within the matches container
        query = "SELECT m.matchId FROM matches m"

        codes = list(matches_container.query_items(query=query, enable_cross_partition_query=True))

        while match_id in codes:
            match_id = random.randint(0, 999999)
            match_id = f"{match_id:06d}"

        # add match to matches container
        default_match_settings = {"noOfRounds":8, "maxPlayers":8, "countdown":60}
        doc = {"matchId": match_id, "players": [{"userId": host_id}], "matchSettings": default_match_settings}
        matches_container.create_item(doc)

        # dynamically set hub_name
        connection_info['hub_name'] = match_id

        # return response
        return _json({"result": True, "msg": "OK", "matchCode": match_id, "signalR": {
                    "url": connection_info["url"],
                    "accessToken": connection_info["accessToken"]
                }, "matchSettings": default_match_settings}, 201)
    
    except Exception as e:
        logging.exception("Error in create_lobby")
        return _json({"result": False, "msg": str(e)}, 500)

# Join game
# Adds player to the lobby
# Returns signal R access token
@app.route(route="join_game", auth_level=func.AuthLevel.FUNCTION, methods=["POST"])
@app.signalr_connection_info(
    arg_name="connection_info",
    user_id="{json:playerId}",
    connection_string_setting="AzureSignalRConnectionString"
)
def join_game(req: func.HttpRequest, connection_info: dict) -> func.HttpResponse:
    # Expects:
    # {matchCode: str, playerId: str}

    # Adds the player to the lobby:
    # {matchId: unique 6 digit code}

    try:
        body = req.get_json()
        match_id = body['matchCode']
        player_id = body['playerId']

        # fetch current lobby state
        query = f"SELECT * FROM matches m WHERE m.matchId = {match_id}"
        item = list(matches_container.query_items(query=query, enable_cross_partition_query=True))[0]

        max_players = item["matchSettings"]["maxPlayers"]
        players = item["players"]

        player_in_lobby = any(player["userId"] == player_id for player in players)
        lobby_count_exceeded = len(players) >= max_players

        if (player_in_lobby):
            return _json({"result": False, "msg": "Player already in lobby"}, 409)
        elif (lobby_count_exceeded):
            return _json({"result": False, "msg": "Lobby is full"}, 409)
        else:
            # replace entry
            item["players"].append({"userId": player_id})
            matches_container.upsert_item(item)
            
            # dynamically set hub_name
            connection_info['hub_name'] = match_id

            # return response
            return _json({"result": True, "msg": "OK", "signalR": {
                    "url": connection_info["url"],
                    "accessToken": connection_info["accessToken"]
                }}, 201)

    except Exception as e:
        logging.exception("Error in join_game")
        return _json({"result": False, "msg": str(e)}, 500)

# Quit game
# Removes player from the lobby
@app.route(route="quit_game", auth_level=func.AuthLevel.FUNCTION, methods=["POST"])
def quit_game(req: func.HttpRequest) -> func.HttpResponse:
    # Expects:
    # {matchCode: str, playerId: str}


    try:
        body = req.get_json()
        match_id = body['matchCode']
        player_id = body['playerId']

        # fetch current lobby state
        query = f"SELECT * FROM matches m WHERE m.matchId = {match_id}"
        item = list(matches_container.query_items(query=query, enable_cross_partition_query=True))[0]

        players = item["players"]

        player_in_lobby = any(player["userId"] == player_id for player in players)
        lobby_empty = len(players) <= 1

        if (not player_in_lobby):
            return _json({"result": False, "msg": "Player isn't in lobby"}, 400)
        elif (lobby_empty):
            # delete entry
            matches_container.delete_item(item)
            return _json({"result": True, "msg": "Lobby closed"}, 200)
        else:
            # replace entry
            item["players"] = [player for player in players if player["userId"] != player_id]
            matches_container.upsert_item(item)

            return _json({"result": True, "msg": "OK"}, 200)

    except Exception as e:
        logging.exception("Error in quit_game")
        return _json({"result": False, "msg": str(e)}, 500)


# Change settings
# Takes new settings and changes it in the database
@app.settings(route="change_settings", auth_level=func.AuthLevel.FUNCTION, methods=["PUT"])
def settings(req: func.HttpRequest) -> func.HttpResponse:
    # expects: {matchCode: code, matchSettings:{noOfRounds:int, maxPlayers:int, countdown:int}}
    
    try:
        body = req.get_json()
        match_id = body['matchCode']
        match_settings = body["matchSettings"]

        # fetch current lobby state
        query = f"SELECT * FROM matches m WHERE m.matchId = {match_id}"
        item = list(matches_container.query_items(query=query, enable_cross_partition_query=True))[0]

        
        # update entry
        item["matchSettings"] = match_settings
        matches_container.upsert_item(item)

        return _json({"result": True, "msg": "OK"}, 201)

    except Exception as e:
        logging.exception("Error in change_settings")
        return _json({"result": False, "msg": str(e)}, 500)

# Guess
# Add guess to service bus queue
@app.route(route="guess", auth_level=func.AuthLevel.FUNCTION, methods=["POST"])
def guess(req: func.HttpRequest) -> func.HttpResponse:
    # expects: {matchCode: code, playerId: "id", guess:{lat:lat, lon:lon}}

    try:
        body = req.get_json()
        match_id = body['matchCode']
        player_id = body["playerId"]
        player_guess = body["guess"]
        lat = float(player_guess["lat"])
        lon = float(player_guess["lon"])

        if not (-90 <= lat <= 90 and -180 <= lon <= 180):
            raise ValueError("Invalid coordinates")

        # Add to service bus queue
        _enqueue_guess(match_id, player_id, lat, lon)

        return _json({"result": True, "msg": "OK"}, 200)

    except KeyError as e:
        return _json({"result": False, "msg": f"Missing field: {e}"}, 400)
    
    except ValueError as e:
        return _json({"result": False, "msg": str(e)}, 400)
    
    except Exception as e:
        logging.exception("Error in guess")
        return _json({"result": False, "msg": str(e)}, 500)
    

# Get game results
# Write results to Cosmos
# End game
# Clears DBs and updates player data
@app.route(route="results", auth_level=func.AuthLevel.FUNCTION, methods=["POST"])
def results(req: func.HttpRequest) -> func.HttpResponse:
    # Expects: {matchCode: 6 digit code}
    # Returns: {playerScores: {
    #        "player_id": player_id,
    #        "data": guess_data
    #    }}
    try:
        body = req.get_json()
        match_id = body['matchCode']

        # Remove entry from matches container
        query = f"SELECT * FROM matches m WHERE m.matchId = {match_id}"
        item = list(matches_container.query_items(query=query, enable_cross_partition_query=True))[0]

        matches_container.delete_item(item=item, partition_key=item["partitionKey"])

        # get match results

        query = f"SELECT * FROM Results r WHERE r.game_id = {match_id}"
        item = list(results_container.query_items(query=query, enable_cross_partition_query=True))[0]

        player_scores = item["round_scores"]

        # Add scores to users
        for player_score in player_scores:

            # get user
            id = player_score["player_id"]
            user = _get_user_by_user_id(id)

            if (not user):
                continue
            else: 
                # Update players score data
                display_name = user["displayName"]
                delta = player_score["data"]
                if (delta > 0):
                    _inc_score(id, "alltime", display_name, delta)
                    _inc_score(id, _month_scope(), display_name, delta)

        return _json({"result": True, "msg": "OK", "playerScores": player_scores}, 200)

    except Exception as e:
        logging.exception("Error in results")
        return _json({"result": False, "msg": str(e)}, 500)

