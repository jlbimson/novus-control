# novus-control

Simple webpage for LAN control of a Novus N20K48 over wifi using the CG-WiFi module.

The N20K48 is a Novus modular process/PID controller. The CG WiFi module
bridges its RS485/Modbus RTU interface to the network. This project polls
it, stores history, and serves a small dashboard: live readings, a history
chart per reading, and a control panel for writeable registers (run/stop,
setpoint, output power, mode selects, PID tuning, alarm 1, etc).

## Register map

`app/registers.yaml` is transcribed from Novus's own
`communication_protocol_n20k48_v10x_a_en.pdf` (protocol v1.0x A) — real
addresses, not guesses. A few values (noted inline as `ASSUMPTION` in the
YAML comments) fill in decimal scaling the doc doesn't spell out for every
register; double-check those against what the device's own display shows
once you're connected. Ramps & Soaks programs, alarms 2-4, and a handful of
lower-priority config registers are documented in the PDF but not wired
into the YAML — see the comment block at the bottom of the file for what's
left out and why. The app, API, and UI are all generated from this file, so
extending it (e.g. adding alarm 2-4) is a YAML edit, not a code change.

One protocol wrinkle worth knowing: the device natively speaks Modbus RTU
over RS485, and only supports function codes 03/05/06/16 (no input
registers). Some cheap RS485-to-WiFi bridges forward raw RTU frames over a
plain TCP socket instead of real MBAP-framed Modbus TCP. If the module
accepts the TCP connection but every read/write fails, that's the likely
cause — the client would need to be switched to RTU-over-TCP framing.

## Running

```
cp .env.example .env
# edit .env with your CG WiFi module's IP
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
