import logging
import threading
import time
from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

import config
import db
from modbus_client import ModbusDevice

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("novus.main")

device = ModbusDevice(config.MODBUS_HOST, config.MODBUS_PORT, config.MODBUS_UNIT_ID)

_state_lock = threading.Lock()
_latest_values: dict[str, float] = {}
_latest_ts: float | None = None
_connected = False

_stop_event = threading.Event()


def _poll_once():
    global _latest_ts, _connected

    values = {}
    for item in config.READINGS:
        result = device.read(item)
        if result is not None:
            values[item["key"]] = result

    for item in config.CONTROLS:
        if item["type"] == "coil" and item.get("control_type") == "toggle":
            result = device.read_coil(item)
            if result is not None:
                values[item["key"]] = 1.0 if result else 0.0

    with _state_lock:
        _latest_values.update(values)
        _latest_ts = time.time()
        _connected = len(values) > 0

    db.insert_readings({k: v for k, v in values.items() if k in config.READINGS_BY_KEY})


def _poll_loop():
    while not _stop_event.is_set():
        try:
            _poll_once()
        except Exception:
            logger.exception("poll cycle failed")
        _stop_event.wait(config.POLL_INTERVAL_SECONDS)


@asynccontextmanager
async def lifespan(app: FastAPI):
    db.init_db()
    thread = threading.Thread(target=_poll_loop, daemon=True)
    thread.start()
    yield
    _stop_event.set()
    thread.join(timeout=5)
    device.close()


app = FastAPI(lifespan=lifespan)


@app.get("/api/config")
def get_config():
    return {"readings": config.READINGS, "controls": config.CONTROLS}


@app.get("/api/status")
def get_status():
    with _state_lock:
        return {
            "connected": _connected,
            "timestamp": _latest_ts,
            "values": dict(_latest_values),
        }


@app.get("/api/history")
def get_history(key: str, minutes: float = 60):
    if key not in config.REGISTERS_BY_KEY:
        raise HTTPException(404, "unknown key")
    since = time.time() - minutes * 60
    return db.history(key, since)


@app.post("/api/control/{key}")
def set_control(key: str, body: dict):
    item = config.CONTROLS_BY_KEY.get(key)
    if item is None:
        raise HTTPException(404, "unknown control")
    if "value" not in body:
        raise HTTPException(422, "missing 'value' in request body")
    value = body["value"]

    control_type = item.get("control_type")

    if control_type == "toggle":
        if not isinstance(value, bool):
            raise HTTPException(422, "toggle control requires a boolean value")
        raw = value
    elif control_type == "select":
        allowed = {opt["value"] for opt in item.get("options", [])}
        if value not in allowed:
            raise HTTPException(422, f"value must be one of {sorted(allowed)}")
        raw = value
    elif control_type == "number":
        if not isinstance(value, (int, float)):
            raise HTTPException(422, "number control requires a numeric value")
        if "min" in item and value < item["min"]:
            raise HTTPException(422, f"value below minimum {item['min']}")
        if "max" in item and value > item["max"]:
            raise HTTPException(422, f"value above maximum {item['max']}")
        scale = item.get("scale", 1)
        raw = round(value / scale)
    else:
        raise HTTPException(500, f"unsupported control_type: {control_type}")

    try:
        device.write(item, raw)
    except Exception as e:
        logger.exception("control write failed for %s", key)
        raise HTTPException(502, f"write to device failed: {e}") from None

    with _state_lock:
        _latest_values[key] = float(value) if not isinstance(value, bool) else (1.0 if value else 0.0)

    return {"ok": True, "key": key, "value": value}


app.mount("/static", StaticFiles(directory="static"), name="static")


@app.get("/")
def index():
    return FileResponse("static/index.html")
