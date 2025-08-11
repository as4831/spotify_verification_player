import os, json, base64, time, requests
from urllib.parse import urlencode
from flask import Flask, request, redirect, session, send_from_directory, jsonify

app = Flask(__name__, static_url_path='/static', static_folder='static')

# ====== CONFIG ======
app.secret_key = os.environ.get("FLASK_SECRET_KEY", "dev-secret-change-me")
CLIENT_ID = os.environ["SPOTIFY_CLIENT_ID"]
CLIENT_SECRET = os.environ["SPOTIFY_CLIENT_SECRET"]
REDIRECT_URI = os.environ.get("SPOTIFY_REDIRECT_URI", "https://YOUR-RENDER-URL.onrender.com/callback")

SCOPES = "streaming user-read-email user-read-private user-modify-playback-state user-read-playback-state"

TOKEN_URL = "https://accounts.spotify.com/api/token"
AUTH_URL  = "https://accounts.spotify.com/authorize"

def _basic_auth_header():
    creds = f"{CLIENT_ID}:{CLIENT_SECRET}".encode("utf-8")
    return {"Authorization": "Basic " + base64.b64encode(creds).decode("utf-8")}

def save_tokens(data):
    session["access_token"] = data["access_token"]
    session["expires_at"] = int(time.time()) + int(data.get("expires_in", 3600)) - 30
    if "refresh_token" in data:
        session["refresh_token"] = data["refresh_token"]

def ensure_token():
    if "access_token" not in session:
        return None
    if int(time.time()) < session.get("expires_at", 0):
        return session["access_token"]

    # Refresh
    refresh = session.get("refresh_token")
    if not refresh:
        return None
    payload = {
        "grant_type": "refresh_token",
        "refresh_token": refresh,
    }
    r = requests.post(TOKEN_URL, data=payload, headers=_basic_auth_header(), timeout=15)
    r.raise_for_status()
    save_tokens(r.json())
    return session["access_token"]

# ====== ROUTES ======

@app.route("/")
def root():
    return redirect("/static/index.html")

@app.route("/login")
def login():
    params = {
        "client_id": CLIENT_ID,
        "response_type": "code",
        "redirect_uri": REDIRECT_URI,
        "scope": SCOPES,
        "show_dialog": "false",
    }
    return redirect(f"{AUTH_URL}?{urlencode(params)}")

@app.route("/callback")
def callback():
    code = request.args.get("code")
    if not code:
        return "Missing code", 400
    data = {
        "grant_type": "authorization_code",
        "code": code,
        "redirect_uri": REDIRECT_URI,
    }
    r = requests.post(TOKEN_URL, data=data, headers=_basic_auth_header(), timeout=15)
    r.raise_for_status()
    save_tokens(r.json())
    return redirect("/static/index.html#logged-in")

@app.route("/debug-redirect")
def debug_redirect():
    return {"REDIRECT_URI": REDIRECT_URI}, 200

@app.route("/me/token")
def me_token():
    token = ensure_token()
    if not token:
        return jsonify({"authenticated": False}), 401
    return jsonify({"authenticated": True, "access_token": token})

@app.route("/health")
def health():
    return {"ok": True}, 200

@app.route("/spotify/play", methods=["PUT"])
def spotify_play():
    """
    Proxy for play endpoint to avoid CORS issues.
    Expects JSON: { "device_id": "...", "uris": ["spotify:track:..."], "position_ms": 12345 }
    """
    token = ensure_token()
    if not token:
        return "Unauthorized", 401
    payload = request.get_json(force=True) or {}
    device_id = payload.get("device_id")
    uris = payload.get("uris")
    position_ms = payload.get("position_ms", 0)

    params = {}
    if device_id:
        params["device_id"] = device_id

    r = requests.put(
        f"https://api.spotify.com/v1/me/player/play",
        params=params,
        headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
        json={"uris": uris, "position_ms": position_ms},
        timeout=15
    )
    if r.status_code not in (200, 202, 204):
        return r.text, r.status_code
    return "", 204

@app.route("/spotify/pause", methods=["PUT"])
def spotify_pause():
    token = ensure_token()
    if not token:
        return "Unauthorized", 401
    device_id = request.args.get("device_id")
    params = {}
    if device_id:
        params["device_id"] = device_id
    r = requests.put(
        "https://api.spotify.com/v1/me/player/pause",
        params=params,
        headers={"Authorization": f"Bearer {token}"},
        timeout=15
    )
    if r.status_code not in (200, 202, 204):
        return r.text, r.status_code
    return "", 204

@app.route("/spotify/track/<track_id>")
def track_meta(track_id):
    token = ensure_token()
    if not token:
        return "Unauthorized", 401
    r = requests.get(
        f"https://api.spotify.com/v1/tracks/{track_id}",
        headers={"Authorization": f"Bearer {token}"},
        timeout=15
    )
    return (r.text, r.status_code, {"Content-Type": "application/json"})

if __name__ == "__main__":
    app.run(host="0.0.0.0", port=int(os.environ.get("PORT", 10000)))
