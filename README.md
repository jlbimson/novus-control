# novus-control

Simple webpage for LAN control of a Novus N20K48 over wifi using the CG-WiFi module.

The CG WiFi module bridges the inverter's RS485/Modbus interface to the
network as Modbus TCP. This project polls it, stores history, and serves a
small dashboard: live readings, a history chart per reading, and a
control panel for writeable registers (on/off, setpoints, mode selects).

## Before this will do anything useful

**`app/registers.yaml` is a placeholder.** Novus doesn't publish a public
Modbus register map for the N20K48, so the addresses in that file are
stand-ins, not real ones. The app, API, and UI are all generated from that
file, so once you have the real register map you only need to edit YAML —
no code changes.

To find the real addresses:
- Ask Novus support or your installer for the Modbus/RS485 register table.
- Capture traffic between the vendor's phone app and the module while
  changing settings, and match reads/writes to what changes.
- Probe common holding-register ranges with a Modbus tool (e.g.
  `pymodbus.console`, `modpoll`) and correlate values against the
  inverter's own display.

See the comments in `app/registers.yaml` for the field format.

## Running

```
cp .env.example .env
# edit .env with your CG WiFi module's IP, and app/registers.yaml with real
# register addresses
docker compose up --build
```

Then open http://localhost:8080 (or whatever `HTTP_PORT` you set).

## Layout

- `app/main.py` — FastAPI app: serves the UI, polls the device on a
  background thread, exposes `/api/status`, `/api/history`,
  `/api/config`, `/api/control/{key}`.
- `app/modbus_client.py` — thread-safe Modbus TCP client wrapper.
- `app/registers.yaml` — defines every reading and control; drives both
  the backend and the UI. Edit this, not the Python, to add/change
  registers.
- `app/db.py` — SQLite history storage (in the `novus-data` volume).
- `app/static/` — the dashboard (vanilla HTML/CSS/JS, no build step).

## Notes

- No authentication is built in — this is meant for a trusted home LAN.
  Don't port-forward it to the internet without adding auth/TLS in front.
- History is stored in a Docker volume (`novus-data`), independent of the
  container lifecycle.
