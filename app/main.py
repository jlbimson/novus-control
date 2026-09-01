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

# Single-setpoint runs (Simple Run, and "Simple" presets) drive the device's
# native Ramp-to-Soak feature (rs_prog_type=1). rs_tbas is always forced to
# minutes (1) since seconds only covers ~2.7h. Confirmed live that RUN alone
# does not start execution in this mode - rs_prn_exec must also be written
# to 1 to arm it.
_NATIVE_TBAS_MINUTES = 1

# Multi-segment "ramp program" presets drive the device's native Ramps and
# Soaks PROGRAM feature (rs_prog_type=2) instead, using one dedicated program
# slot on the device. Each program occupies a fixed 40-register block
# starting at 400 + (slot-1)*40: PTOL, LP (link), PSP0 (start point), then up
# to 9 segments of (time_minutes, event, setpoint). Confirmed live
# (2026-09-01) that segment time is a real fixed wall-clock ramp duration (a
# 1+1 minute 2-segment test completed and self-stopped at exactly 120s), not
# a rate like rs_max_rate in the single Ramp-to-Soak mode.
_PROGRAM_SLOT = 1
_PROGRAM_BASE = 400 + (_PROGRAM_SLOT - 1) * 40
_MAX_PROGRAM_SEGMENTS = 9

# Confirmed live for both native modes that the device reliably turns RUN off
# on its own once the program/soak completes. This backstop is kept anyway as
# cheap defense-in-depth - force-stops an overdue run so nothing can heat
# unattended indefinitely if that native completion ever doesn't fire.
_AUTO_STOP_SAFETY_MARGIN_HOURS = 1.0


def _disarm_native_program():
    """Return the device to plain fixed-setpoint control. Called whenever a
    run ends, so manual Run toggling from the Settings page afterward
    behaves as simple PID control rather than inheriting a stale program."""
    device.write(config.REGISTERS_BY_KEY["rs_prn_exec"], 0)
    device.write(config.REGISTERS_BY_KEY["rs_prog_type"], 0)


def _program_register(offset):
    return {"key": "program_reg", "address": _PROGRAM_BASE + offset, "type": "holding", "data_type": "int16"}


def _start_simple_run(setpoint: float, duration_hours: float):
    """Native single-segment Ramp to Soak (rs_prog_type=1)."""
    setpoint_item = config.CONTROLS_BY_KEY["setpoint"]
    scale = setpoint_item.get("scale", 1)
    raw_setpoint = round(setpoint / scale)
    soak_minutes = max(1, round(duration_hours * 60))

    device.write(config.CONTROLS_BY_KEY["control_run"], False)
    device.write(setpoint_item, raw_setpoint)
    device.write(config.REGISTERS_BY_KEY["rs_tbas"], _NATIVE_TBAS_MINUTES)
    device.write(config.REGISTERS_BY_KEY["rs_timer_soak"], soak_minutes)
    device.write(config.REGISTERS_BY_KEY["rs_prog_type"], 1)
    device.write(config.CONTROLS_BY_KEY["control_mode"], True)
    device.write(config.REGISTERS_BY_KEY["rs_prn_exec"], 1)
    device.write(config.CONTROLS_BY_KEY["control_run"], True)

    with _state_lock:
        _latest_values["setpoint"] = setpoint
        _latest_values["control_mode"] = 1.0
        _latest_values["control_run"] = 1.0
        _latest_values["rs_prog_type"] = 1.0
        _latest_values["rs_prn_exec"] = 1.0


def _start_ramp_program(segments: list):
    """Native multi-segment Ramps and Soaks program (rs_prog_type=2), written
    into our one dedicated program slot on the device."""
    current_pv = _latest_values.get("process_variable")
    if current_pv is None:
        raise RuntimeError("no current process variable reading available yet")

    device.write(config.CONTROLS_BY_KEY["control_run"], False)
    device.write(_program_register(0), 0)  # PTOL: no tolerance wait
    device.write(_program_register(1), 0)  # LP: no chained program
    device.write(_program_register(2), round(current_pv))  # PSP0: start from current PV

    for i in range(_MAX_PROGRAM_SEGMENTS):
        base = 3 + i * 3
        if i < len(segments):
            minutes = max(1, round(segments[i]["minutes"]))
            setpoint = round(segments[i]["setpoint"])
        else:
            minutes = 0  # zero-time segment marks end of program
            setpoint = 0
        device.write(_program_register(base), minutes)
        device.write(_program_register(base + 1), 0)  # event: none
        device.write(_program_register(base + 2), setpoint)

    device.write(config.REGISTERS_BY_KEY["rs_prog_type"], 2)
    device.write(config.CONTROLS_BY_KEY["control_mode"], True)
    device.write(config.REGISTERS_BY_KEY["rs_prn_exec"], _PROGRAM_SLOT)
    device.write(config.CONTROLS_BY_KEY["control_run"], True)

    with _state_lock:
        _latest_values["setpoint"] = segments[-1]["setpoint"]
        _latest_values["control_mode"] = 1.0
        _latest_values["control_run"] = 1.0
        _latest_values["rs_prog_type"] = 2.0
        _latest_values["rs_prn_exec"] = float(_PROGRAM_SLOT)


def _start_native_run(setpoint: float, duration_hours: float, segments: list | None):
    if segments:
        _start_ramp_program(segments)
    else:
        _start_simple_run(setpoint, duration_hours)


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
        try:
            _disarm_native_program()
        except Exception:
            logger.exception(
                "finished preset '%s' but failed to disarm the native program - "
                "will retry next cycle",
                active["preset_name"],
            )
            return
        db.clear_active_run()
        with _state_lock:
            _latest_values["rs_prog_type"] = 0.0
            _latest_values["rs_prn_exec"] = 0.0
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


def _validate_segments(raw_segments):
    if not isinstance(raw_segments, list) or not raw_segments:
        raise HTTPException(422, "segments must be a non-empty list")
    if len(raw_segments) > _MAX_PROGRAM_SEGMENTS:
        raise HTTPException(422, f"a ramp program supports at most {_MAX_PROGRAM_SEGMENTS} segments")
    segments = []
    for i, seg in enumerate(raw_segments):
        try:
            setpoint = float(seg["setpoint"])
            minutes = float(seg["minutes"])
        except (KeyError, TypeError, ValueError):
            raise HTTPException(422, f"segment {i + 1}: setpoint and minutes must be numbers") from None
        if minutes <= 0:
            raise HTTPException(422, f"segment {i + 1}: minutes must be positive")
        segments.append({"setpoint": setpoint, "minutes": minutes})
    return segments


def _validate_preset_body(body: dict):
    name = (body.get("name") or "").strip()
    if not name:
        raise HTTPException(422, "name is required")
    folder = (body.get("folder") or "").strip() or None

    raw_segments = body.get("segments")
    if raw_segments:
        segments = _validate_segments(raw_segments)
        setpoint = segments[-1]["setpoint"]
        duration_hours = sum(s["minutes"] for s in segments) / 60
        return name, folder, setpoint, duration_hours, segments

    try:
        setpoint = float(body["setpoint"])
        duration_hours = float(body["duration_hours"])
    except (KeyError, TypeError, ValueError):
        raise HTTPException(422, "setpoint and duration_hours must be numbers") from None
    if duration_hours <= 0:
        raise HTTPException(422, "duration_hours must be positive")
    return name, folder, setpoint, duration_hours, None


@app.get("/api/presets")
def list_presets():
    return db.list_presets()


@app.post("/api/presets")
def create_preset(body: dict):
    name, folder, setpoint, duration_hours, segments = _validate_preset_body(body)
    try:
        preset_id = db.create_preset(name, folder, setpoint, duration_hours, segments)
    except sqlite3.IntegrityError:
        raise HTTPException(409, f"a preset named '{name}' already exists") from None
    return db.get_preset(preset_id)


@app.put("/api/presets/{preset_id}")
def update_preset(preset_id: int, body: dict):
    if db.get_preset(preset_id) is None:
        raise HTTPException(404, "unknown preset")
    name, folder, setpoint, duration_hours, segments = _validate_preset_body(body)
    try:
        db.update_preset(preset_id, name, folder, setpoint, duration_hours, segments)
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

    try:
        _start_native_run(preset["setpoint"], preset["duration_hours"], preset["segments"])
    except Exception as e:
        logger.exception("failed to start preset '%s'", preset["name"])
        raise HTTPException(502, f"failed to start: {e}") from None

    started_at = time.time()
    db.set_active_run(
        preset["id"], preset["name"], preset["setpoint"], preset["duration_hours"], started_at
    )

    logger.info(
        "started preset '%s': setpoint=%s duration=%.2fh%s",
        preset["name"],
        preset["setpoint"],
        preset["duration_hours"],
        f" ({len(preset['segments'])} segments)" if preset["segments"] else "",
    )
    return _active_run_response(db.get_active_run())


@app.post("/api/run/start_adhoc")
def start_adhoc_run(body: dict):
    try:
        setpoint = float(body["setpoint"])
        duration_hours = float(body["duration_hours"])
    except (KeyError, TypeError, ValueError):
        raise HTTPException(422, "setpoint and duration_hours must be numbers") from None
    if duration_hours <= 0:
        raise HTTPException(422, "duration_hours must be positive")

    try:
        _start_native_run(setpoint, duration_hours, None)
    except Exception as e:
        logger.exception("failed to start simple run")
        raise HTTPException(502, f"failed to start: {e}") from None

    started_at = time.time()
    db.set_active_run(None, "Simple Run", setpoint, duration_hours, started_at)

    logger.info("started simple run: setpoint=%s duration=%.2fh", setpoint, duration_hours)
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
