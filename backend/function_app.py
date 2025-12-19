import azure.functions as func
import datetime
import json
import os
import re
import bcrypt
from azure.cosmos import CosmosClient

app = func.FunctionApp()

COSMOS_CONN = os.environ["COSMOS_CONNECTION_STRING"]
DB_NAME = os.environ.get("COSMOS_DATABASE_NAME", "soton_guessr")
USERS_CONTAINER = os.environ.get("COSMOS_USERS_CONTAINER", "users")

# Initialize Cosmos DB client
_cosmos_client = CosmosClient.from_connection_string(COSMOS_CONN)
_db = _cosmos_client.get_database_client(DB_NAME)
_users = _db.get_container_client(USERS_CONTAINER)

# Username: 3-26 chars, alphanumeric + underscore, must start with letter
USERNAME_RE = re.compile(r"^[a-z][a-z0-9_]{2,25}$")

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


@app.route(route="register", auth_level=func.AuthLevel.FUNCTION, methods=["POST"])
def register(req: func.HttpRequest) -> func.HttpResponse:
    # Parse request body
    try:
        body = req.get_json()
    except ValueError:
        return func.HttpResponse("Invalid JSON", status_code=400)

    username = (body.get("username") or "").lower().strip()
    password = body.get("password") or ""

    # Validate username
    if not username or len(username) > MAX_USERNAME_LENGTH:
        return func.HttpResponse(
            f"Username must be 1-{MAX_USERNAME_LENGTH} characters",
            status_code=400
        )

    if not USERNAME_RE.match(username):
        return func.HttpResponse(
            "Username must start with a letter and contain only letters, numbers, and underscores",
            status_code=400
        )

    # Validate password
    if len(password) < MIN_PASSWORD_LENGTH:
        return func.HttpResponse(
            f"Password must be at least {MIN_PASSWORD_LENGTH} characters",
            status_code=400
        )

    if len(password) > MAX_PASSWORD_LENGTH:
        return func.HttpResponse(
            f"Password must not exceed {MAX_PASSWORD_LENGTH} characters",
            status_code=400
        )

    # Hash password
    password_hash = bcrypt.hashpw(
        password.encode("utf-8"),
        bcrypt.gensalt()
    ).decode("utf-8")

    # Create user document
    user_doc = {
        "id": username,
        "username": username,
        "passwordHash": password_hash,
        "createdAt": datetime.datetime.now(datetime.timezone.utc).isoformat().replace("+00:00", "Z")
    }

    # Save to database
    try:
        _users.create_item(body=user_doc)
    except Exception:
        return func.HttpResponse(
            "Username already exists",
            status_code=409
        )

    return func.HttpResponse(
        json.dumps({"username": username}),
        status_code=201,
        mimetype="application/json"
    )