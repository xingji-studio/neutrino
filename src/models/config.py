import json
import os
from pathlib import Path
from datetime import datetime

NEUTRINO_DIR = Path.home() / ".neutrino"
MODEL_FILE = NEUTRINO_DIR / "model.json"
SESSION_DIR = NEUTRINO_DIR / "session"
CONFIG_FILE = NEUTRINO_DIR / "config.json"

DEFAULT_MODELS = {
    "providers": [
        {
            "name": "DeepSeek",
            "models": [
                {
                    "name": "deepseek-v4-pro",
                    "url": "https://api.deepseek.com/v1",
                    "api_key": "",
                    "supports_streaming": True
                },
                {
                    "name": "deepseek-chat",
                    "url": "https://api.deepseek.com/v1",
                    "api_key": "",
                    "supports_streaming": True
                }
            ]
        },
        {
            "name": "OpenAI",
            "models": [
                {
                    "name": "gpt-4o",
                    "url": "https://api.openai.com/v1",
                    "api_key": "",
                    "supports_streaming": True
                },
                {
                    "name": "gpt-4o-mini",
                    "url": "https://api.openai.com/v1",
                    "api_key": "",
                    "supports_streaming": True
                }
            ]
        },
        {
            "name": "Anthropic",
            "models": [
                {
                    "name": "claude-3-5-sonnet-20241022",
                    "url": "https://api.anthropic.com/v1",
                    "api_key": "",
                    "supports_streaming": True
                }
            ]
        }
    ]
}

DEFAULT_CONFIG = {
    "language": "en",
    "theme": "default"
}

INTENSITY_LEVELS = ["Low", "Medium", "High", "Max", "Ultra"]

INTENSITY_PARAMS = {
    "Low": {"temperature": 0.1, "top_p": 0.1},
    "Medium": {"temperature": 0.3, "top_p": 0.5},
    "High": {"temperature": 0.7, "top_p": 0.9},
    "Max": {"temperature": 1.0, "top_p": 1.0},
    "Ultra": {"temperature": 1.5, "top_p": 1.0}
}


def ensure_dirs():
    NEUTRINO_DIR.mkdir(parents=True, exist_ok=True)
    SESSION_DIR.mkdir(parents=True, exist_ok=True)


def load_models():
    ensure_dirs()
    if not MODEL_FILE.exists():
        save_models(DEFAULT_MODELS)
        return DEFAULT_MODELS
    try:
        with open(MODEL_FILE, encoding="utf-8") as f:
            return json.load(f)
    except (json.JSONDecodeError, IOError):
        return DEFAULT_MODELS


def save_models(data):
    ensure_dirs()
    with open(MODEL_FILE, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2)


def load_config():
    ensure_dirs()
    if not CONFIG_FILE.exists():
        save_config(DEFAULT_CONFIG)
        return DEFAULT_CONFIG
    try:
        with open(CONFIG_FILE, encoding="utf-8") as f:
            return json.load(f)
    except (json.JSONDecodeError, IOError):
        return DEFAULT_CONFIG


def save_config(data):
    ensure_dirs()
    with open(CONFIG_FILE, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2)


def get_all_models():
    data = load_models()
    providers = data.get("providers", [])
    result = []
    for provider in providers:
        for model in provider.get("models", []):
            result.append({
                "provider": provider["name"],
                "name": model["name"],
                "url": model["url"],
                "api_key": model.get("api_key", ""),
                "supports_streaming": model.get("supports_streaming", True)
            })
    return result


def get_models_by_provider():
    data = load_models()
    providers = data.get("providers", [])
    result = {}
    for provider in providers:
        result[provider["name"]] = provider.get("models", [])
    return result


def save_session(messages, model_name, provider, intensity):
    ensure_dirs()
    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    session = {
        "id": timestamp,
        "created_at": datetime.now().isoformat(),
        "updated_at": datetime.now().isoformat(),
        "model": model_name,
        "provider": provider,
        "intensity": intensity,
        "messages": messages
    }
    path = SESSION_DIR / f"{timestamp}.json"
    with open(path, "w", encoding="utf-8") as f:
        json.dump(session, f, indent=2, ensure_ascii=False)
    return timestamp


def load_session(session_id):
    path = SESSION_DIR / f"{session_id}.json"
    if not path.exists():
        return None
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def list_sessions():
    ensure_dirs()
    sessions = []
    for f in SESSION_DIR.glob("*.json"):
        try:
            with open(f, encoding="utf-8") as sf:
                data = json.load(sf)
            sessions.append({
                "id": data.get("id", f.stem),
                "created_at": data.get("created_at", ""),
                "model": data.get("model", ""),
                "provider": data.get("provider", ""),
                "intensity": data.get("intensity", ""),
                "message_count": len(data.get("messages", []))
            })
        except (json.JSONDecodeError, IOError):
            pass
    sessions.sort(key=lambda s: s["created_at"], reverse=True)
    return sessions