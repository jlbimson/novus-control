import logging
import threading

from pymodbus.client import ModbusTcpClient

logger = logging.getLogger("novus.modbus")


def _decode(registers, data_type):
    if data_type == "uint16":
        return registers[0]
    if data_type == "int16":
        v = registers[0]
        return v - 0x10000 if v >= 0x8000 else v
    if data_type == "uint32":
        return (registers[0] << 16) | registers[1]
    if data_type == "int32":
        v = (registers[0] << 16) | registers[1]
        return v - 0x100000000 if v >= 0x80000000 else v
    raise ValueError(f"unsupported data_type: {data_type}")


def _register_count(data_type):
    return 2 if data_type in ("uint32", "int32") else 1


def _encode(value, data_type):
    if data_type in ("uint16", "int16"):
        return [value & 0xFFFF]
    if data_type in ("uint32", "int32"):
        return [(value >> 16) & 0xFFFF, value & 0xFFFF]
    raise ValueError(f"unsupported data_type: {data_type}")


class ModbusDevice:
    """Thread-safe wrapper around a single Modbus TCP connection.

    pymodbus's sync client isn't safe to share across threads without
    external locking, and the CG WiFi module (like most of these bridges)
    only accepts one active connection at a time anyway, so all reads and
    writes go through one client behind one lock.
    """

    def __init__(self, host, port, unit_id):
        self.unit_id = unit_id
        self._client = ModbusTcpClient(host, port=port, timeout=3)
        self._lock = threading.Lock()

    def _ensure_connected(self):
        if not self._client.connected:
            self._client.connect()

    def read(self, item):
        """Read one configured reading. Returns a float, or None on failure."""
        data_type = item.get("data_type", "uint16")
        count = _register_count(data_type)
        scale = item.get("scale", 1)
        with self._lock:
            try:
                self._ensure_connected()
                if item["type"] == "input":
                    resp = self._client.read_input_registers(
                        item["address"], count=count, slave=self.unit_id
                    )
                else:
                    resp = self._client.read_holding_registers(
                        item["address"], count=count, slave=self.unit_id
                    )
                if resp.isError():
                    logger.warning("read error for %s: %s", item["key"], resp)
                    return None
                raw = _decode(resp.registers, data_type)
                return raw * scale
            except Exception:
                logger.exception("read failed for %s", item["key"])
                return None

    def read_coil(self, item):
        with self._lock:
            try:
                self._ensure_connected()
                resp = self._client.read_coils(
                    item["address"], count=1, slave=self.unit_id
                )
                if resp.isError():
                    logger.warning("coil read error for %s: %s", item["key"], resp)
                    return None
                return bool(resp.bits[0])
            except Exception:
                logger.exception("coil read failed for %s", item["key"])
                return None

    def write(self, item, value):
        """Write a control value. `value` is already in device-raw units
        (i.e. after applying any scale/select mapping)."""
        with self._lock:
            self._ensure_connected()
            if item["type"] == "coil":
                resp = self._client.write_coil(
                    item["address"], bool(value), slave=self.unit_id
                )
            else:
                data_type = item.get("data_type", "uint16")
                words = _encode(int(value), data_type)
                if len(words) == 1:
                    resp = self._client.write_register(
                        item["address"], words[0], slave=self.unit_id
                    )
                else:
                    resp = self._client.write_registers(
                        item["address"], words, slave=self.unit_id
                    )
            if resp.isError():
                raise RuntimeError(f"write failed for {item['key']}: {resp}")

    def close(self):
        self._client.close()
