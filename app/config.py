import os
from pathlib import Path

import yaml

REGISTERS_PATH = Path(os.environ.get("REGISTERS_PATH", "registers.yaml"))

MODBUS_HOST = os.environ["MODBUS_HOST"]
MODBUS_PORT = int(os.environ.get("MODBUS_PORT", "502"))
MODBUS_UNIT_ID = int(os.environ.get("MODBUS_UNIT_ID", "1"))
POLL_INTERVAL_SECONDS = float(os.environ.get("POLL_INTERVAL_SECONDS", "5"))
DB_PATH = os.environ.get("DB_PATH", "novus.db")


def load_registers():
    with open(REGISTERS_PATH) as f:
        doc = yaml.safe_load(f) or {}

    readings = doc.get("readings", [])
    controls = doc.get("controls", [])

    by_key = {}
    for item in readings + controls:
        if item["key"] in by_key:
            raise ValueError(f"duplicate register key: {item['key']}")
        by_key[item["key"]] = item

    readings_by_key = {item["key"]: item for item in readings}
    controls_by_key = {item["key"]: item for item in controls}

    return readings, controls, by_key, readings_by_key, controls_by_key


READINGS, CONTROLS, REGISTERS_BY_KEY, READINGS_BY_KEY, CONTROLS_BY_KEY = load_registers()
