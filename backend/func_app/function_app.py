import azure.functions as func
import datetime
import json
import logging
import os
import re
import uuid
import bcrypt
from azure.cosmos import CosmosClient

app = func.FunctionApp()

# Initialize Cosmos DB client
cosmos_connection_string = os.environ.get("COSMOS_CONNECTION_STRING")
database_name = os.environ.get("COSMOS_DATABASE_NAME", "soton-guessr")
users_container_name = os.environ.get("COSMOS_USERS_CONTAINER", "users")

cosmos_client = CosmosClient.from_connection_string(cosmos_connection_string)
database = cosmos_client.get_database_client(database_name)
users_container = database.get_container_client(users_container_name)



# Constants
MIN_PASSWORD_LENGTH = 8
MAX_USERNAME_LENGTH = 26
MAX_PASSWORD_LENGTH = 26

@app.function_name(name="health_check")
@app.route(route="health_check", methods=["GET"], auth_level=func.AuthLevel.ANONYMOUS)
def health(req: func.HttpRequest) -> func.HttpResponse:
    return func.HttpResponse(
        json.dumps({"status": "ok"}),
        mimetype="application/json",
        status_code=200
    )


@app.route(route="login", auth_level=func.AuthLevel.FUNCTION, methods=["POST"])
def login(req: func.HttpRequest) -> func.HttpResponse:
    try:
        req_body = req.get_json()
        username = req_body["username"].lower().strip()
        password = req_body["password"]

        # Query for user by username
        query = f"SELECT * FROM c WHERE c.username = '{username}'"
        users = list(users_container.query_items(
            query=query,
            enable_cross_partition_query=True
        ))

        # Check if user exists and password matches
        if len(users) == 1:
            user = users[0]
            password_hash = user["passwordHash"]

            # Verify password with bcrypt
            if bcrypt.checkpw(password.encode("utf-8"), password_hash.encode("utf-8")):
                response = {
                    "result": True,
                    "msg": "OK"
                }
                return func.HttpResponse(
                    json.dumps(response),
                    mimetype="application/json")

        # Either user doesn't exist OR password is wrong
        response = {
            "result": False,
            "msg": "Username or password incorrect"
        }
        return func.HttpResponse(
            json.dumps(response),
            mimetype="application/json")

    except Exception as e:
        logging.error(f"Error in login: {str(e)}")
        response = {
            "result": False,
            "msg": f"Error: {str(e)}"
        }
        return func.HttpResponse(
            json.dumps(response),
            mimetype="application/json",
            status_code=500)


@app.route(route="register", auth_level=func.AuthLevel.FUNCTION, methods=["POST"])
def register(req: func.HttpRequest) -> func.HttpResponse:
    try:
        req_body = req.get_json()
        username = req_body["username"].lower().strip()
        password = req_body["password"]

        # Validate username length
        if len(username) < 3 or len(username) > MAX_USERNAME_LENGTH:
            response = {
                "result": False,
                "msg": f"Username must be between 3 and {MAX_USERNAME_LENGTH} characters"
            }
            return func.HttpResponse(
                json.dumps(response),
                mimetype="application/json")

        # Validate password length
        if len(password) < MIN_PASSWORD_LENGTH or len(password) > MAX_PASSWORD_LENGTH:
            response = {
                "result": False,
                "msg": f"Password must be between {MIN_PASSWORD_LENGTH} and {MAX_PASSWORD_LENGTH} characters"
            }
            return func.HttpResponse(
                json.dumps(response),
                mimetype="application/json")

        # Check if username already exists
        query = f"SELECT * FROM c WHERE c.username = '{username}'"
        existing_users = list(users_container.query_items(
            query=query,
            enable_cross_partition_query=True
        ))

        if len(existing_users) > 0:
            response = {
                "result": False,
                "msg": "Username already exists"
            }
            return func.HttpResponse(
                json.dumps(response),
                mimetype="application/json")

        # Hash password
        password_hash = bcrypt.hashpw(
            password.encode("utf-8"),
            bcrypt.gensalt()
        ).decode("utf-8")

        # Create new user document with auto-generated ID
        new_user = {
            "id": str(uuid.uuid4()),
            "username": username,
            "passwordHash": password_hash,
            "createdAt": datetime.datetime.now(datetime.timezone.utc).isoformat().replace("+00:00", "Z")
        }

        # Insert into Cosmos DB
        users_container.create_item(body=new_user)

        response = {
            "result": True,
            "msg": "OK"
        }
        return func.HttpResponse(
            json.dumps(response),
            mimetype="application/json")

    except Exception as e:
        logging.error(f"Error in register: {str(e)}")
        response = {
            "result": False,
            "msg": f"Error: {str(e)}"
        }
        return func.HttpResponse(
            json.dumps(response),
            mimetype="application/json",
            status_code=500)