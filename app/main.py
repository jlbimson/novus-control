import logging
import sqlite3
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

# Presets drive the device's native Ramp-to-Soak feature (rs_prog_type=1)
# instead of a purely software-timed hold, so a run keeps going even if this
# container is down. rs_tbas is always forced to minutes (1) since seconds
# only covers ~2.7h. Confirmed live that RUN alone does not start execution
# in this mode - rs_prn_exec must also be written to 1 to arm it.
_NATIVE_TBAS_MINUTES = 1
# We could not confirm in testing whether the device reliably turns RUN off
# on its own once the soak completes (only observed the ramp segment, which
# doesn't even count time - it just runs until PV reaches SP). This backstop
# force-stops an overdue run so nothing can heat unattended indefinitely if
# that native completion doesn't happen as expected.
_AUTO_STOP_SAFETY_MARGIN_HOURS = 1.0


def _disarm_native_program():
    """Return the device to plain fixed-setpoint control. Called whenever a
    preset run ends, so manual Run toggling from the Settings page afterward
    behaves as simple PID control rather than inheriting a stale program."""
    device.write(config.REGISTERS_BY_KEY["rs_prn_exec"], 0)
    device.write(config.REGISTERS_BY_KEY["rs_prog_type"], 0)


def _poll_once():
    global _latest_ts, _connected

    values = {}
    for item in config.READINGS:
        result = device.read(item)
        if result is not None:
            values[item["key"]] = result

    # Controls are RW holding/coil registers - otherwise write-only from the
    # poll loop's perspective, so read them back too each cycle. This is
    # what lets the settings page show each control's actual current value
    # on the device, not just what's pending in the input.
    for item in config.CONTROLS:
        if item["type"] == "coil":
            result = device.read_coil(item)
            if result is not None:
                values[item["key"]] = 1.0 if result else 0.0
        else:
            result = device.read(item)
            if result is not None:
                values[item["key"]] = result

    with _state_lock:
        _latest_values.update(values)
        _latest_ts = time.time()
        _connected = len(values) > 0

    db.insert_readings({k: v for k, v in values.items() if k in config.REGISTERS_BY_KEY})

    _check_active_run_expiry()


def _check_active_run_expiry():
    """Watch a preset run to completion. Runs every poll cycle so it
    self-heals across container restarts (started_at is an absolute
    timestamp persisted in the db, not an in-memory countdown).

    Primary path: the device's native Ramp-to-Soak stops itself (RUN drops
    to 0 on the device) - we just notice that and clear our tracking.
    Backstop: if RUN is still on well past the expected duration, force a
    stop ourselves rather than trust the native completion indefinitely.
    """
    active = db.get_active_run()
    if active is None:
        return

    run_value = _latest_values.get("control_run")
    if run_value is not None and run_value < 0.5:
        db.clear_active_run()
        logger.info("preset '%s' finished (device reported run stopped)", active["preset_name"])
        return

    elapsed_hours = (time.time() - active["started_at"]) / 3600
    deadline_hours = active["duration_hours"] + _AUTO_STOP_SAFETY_MARGIN_HOURS
    if elapsed_hours < deadline_hours:
        return

    logger.warning(
        "preset '%s' ran %.2fh (expected %.2fh) without the device reporting stop - "
        "forcing stop as a safety backstop",
        active["preset_name"],
        elapsed_hours,
        active["duration_hours"],
    )
    try:
        device.write(config.CONTROLS_BY_KEY["control_run"], False)
        _disarm_native_program()
    except Exception:
        logger.exception(
            "failed to force-stop overdue preset '%s' - will retry next cycle",
            active["preset_name"],
        )
        return

    db.clear_active_run()
    with _state_lock:
        _latest_values["control_run"] = 0.0


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


def _validate_preset_body(body: dict):
    name = (body.get("name") or "").strip()
    if not name:
        raise HTTPException(422, "name is required")
    folder = (body.get("folder") or "").strip() or None
    try:
        setpoint = float(body["setpoint"])
        duration_hours = float(body["duration_hours"])
    except (KeyError, TypeError, ValueError):
        raise HTTPException(422, "setpoint and duration_hours must be numbers")
    if duration_hours <= 0:
        raise HTTPException(422, "duration_hours must be positive")
    return name, folder, setpoint, duration_hours


@app.get("/api/presets")
def list_presets():
    return db.list_presets()


@app.post("/api/presets")
def create_preset(body: dict):
    name, folder, setpoint, duration_hours = _validate_preset_body(body)
    try:
        preset_id = db.create_preset(name, folder, setpoint, duration_hours)
    except sqlite3.IntegrityError:
        raise HTTPException(409, f"a preset named '{name}' already exists") from None
    return db.get_preset(preset_id)


@app.put("/api/presets/{preset_id}")
def update_preset(preset_id: int, body: dict):
    if db.get_preset(preset_id) is None:
        raise HTTPException(404, "unknown preset")
    name, folder, setpoint, duration_hours = _validate_preset_body(body)
    try:
        db.update_preset(preset_id, name, folder, setpoint, duration_hours)
    except sqlite3.IntegrityError:
        raise HTTPException(409, f"a preset named '{name}' already exists") from None
    return db.get_preset(preset_id)


@app.delete("/api/presets/{preset_id}")
def delete_preset(preset_id: int):
    if db.get_preset(preset_id) is None:
        raise HTTPException(404, "unknown preset")
    active = db.get_active_run()
    if active and active["preset_id"] == preset_id:
        raise HTTPException(409, "cannot delete a preset while it is running")
    db.delete_preset(preset_id)
    return {"ok": True}


def _active_run_response(active):
    if active is None:
        return {"active": False}
    elapsed_hours = (time.time() - active["started_at"]) / 3600
    remaining_hours = max(0.0, active["duration_hours"] - elapsed_hours)
    return {
        "active": True,
        "preset_id": active["preset_id"],
        "preset_name": active["preset_name"],
        "setpoint": active["setpoint"],
        "duration_hours": active["duration_hours"],
        "started_at": active["started_at"],
        "elapsed_hours": elapsed_hours,
        "remaining_hours": remaining_hours,
    }


@app.get("/api/run/active")
def get_active_run():
    return _active_run_response(db.get_active_run())


@app.post("/api/run/start/{preset_id}")
def start_run(preset_id: int):
    preset = db.get_preset(preset_id)
    if preset is None:
        raise HTTPException(404, "unknown preset")

    setpoint_item = config.CONTROLS_BY_KEY["setpoint"]
    scale = setpoint_item.get("scale", 1)
    raw_setpoint = round(preset["setpoint"] / scale)
    soak_minutes = max(1, round(preset["duration_hours"] * 60))

    try:
        # Stop anything in progress first for a clean, predictable (re)start.
        device.write(config.CONTROLS_BY_KEY["control_run"], False)
        device.write(setpoint_item, raw_setpoint)
        device.write(config.REGISTERS_BY_KEY["rs_tbas"], _NATIVE_TBAS_MINUTES)
        device.write(config.REGISTERS_BY_KEY["rs_timer_soak"], soak_minutes)
        device.write(config.REGISTERS_BY_KEY["rs_prog_type"], 1)  # Ramp to Soak
        device.write(config.CONTROLS_BY_KEY["control_mode"], True)  # Automatic, needed to drive output
        device.write(config.REGISTERS_BY_KEY["rs_prn_exec"], 1)  # arm/start execution
        device.write(config.CONTROLS_BY_KEY["control_run"], True)
    except Exception as e:
        logger.exception("failed to start preset '%s'", preset["name"])
        raise HTTPException(502, f"write to device failed: {e}") from None

    started_at = time.time()
    db.set_active_run(
        preset["id"], preset["name"], preset["setpoint"], preset["duration_hours"], started_at
    )

    with _state_lock:
        _latest_values["setpoint"] = preset["setpoint"]
        _latest_values["control_mode"] = 1.0
        _latest_values["control_run"] = 1.0
        _latest_values["rs_prog_type"] = 1.0
        _latest_values["rs_prn_exec"] = 1.0

    logger.info(
        "started preset '%s' on native Ramp to Soak: setpoint=%s soak=%s min",
        preset["name"],
        preset["setpoint"],
        soak_minutes,
    )
    return _active_run_response(db.get_active_run())


@app.post("/api/run/stop")
def stop_run():
    active = db.get_active_run()
    try:
        device.write(config.CONTROLS_BY_KEY["control_run"], False)
        _disarm_native_program()
    except Exception as e:
        logger.exception("failed to stop run")
        raise HTTPException(502, f"write to device failed: {e}") from None

    db.clear_active_run()
    with _state_lock:
        _latest_values["control_run"] = 0.0
        _latest_values["rs_prog_type"] = 0.0
        _latest_values["rs_prn_exec"] = 0.0

    if active:
        logger.info("stopped preset '%s'", active["preset_name"])
    return {"ok": True}


app.mount("/static", StaticFiles(directory="static"), name="static")


@app.get("/")
def index():
    return FileResponse("static/index.html")
