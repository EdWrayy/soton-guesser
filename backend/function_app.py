import azure.functions as func
import datetime
import json
import logging

app = func.FunctionApp()

@app.function_name(name="health_check")
@app.route(route="health_check", methods=["GET"], auth_level=func.AuthLevel.FUNCTION)
def health(req: func.HttpRequest) -> func.HttpResponse:
    return func.HttpResponse(
        json.dumps({"status": "ok"}),
        mimetype="application/json",
        status_code=200
    )