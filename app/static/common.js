const STATUS_POLL_MS = 3000;

function fmt(value, unit) {
  if (value === undefined || value === null || Number.isNaN(value)) return "--";
  const rounded = Math.abs(value) < 10 ? value.toFixed(2) : Math.round(value * 10) / 10;
  return `${rounded}${unit ? ` <span class="unit">${unit}</span>` : ""}`;
}

async function loadConfig() {
  const res = await fetch("/api/config");
  return res.json();
}

function updateConnStatus(connected) {
  const el = document.getElementById("conn-status");
  if (!el) return;
  el.classList.remove("status-ok", "status-bad", "status-unknown");
  el.classList.add(connected ? "status-ok" : "status-bad");
  el.querySelector(".label").textContent = connected ? "connected" : "disconnected";
}

async function fetchStatus() {
  try {
    const res = await fetch("/api/status");
    const data = await res.json();
    updateConnStatus(data.connected);
    return data;
  } catch (err) {
    updateConnStatus(false);
    console.error("status poll failed", err);
    return null;
  }
}

async function fetchActiveRun() {
  try {
    const res = await fetch("/api/run/active");
    return await res.json();
  } catch (err) {
    console.error("active run poll failed", err);
    return null;
  }
}

function formatDuration(hours) {
  if (hours === undefined || hours === null || Number.isNaN(hours)) return "--";
  const totalMinutes = Math.max(0, Math.round(hours * 60));
  const h = Math.floor(totalMinutes / 60);
  const m = totalMinutes % 60;
  if (h === 0) return `${m}m`;
  if (m === 0) return `${h}h`;
  return `${h}h ${m}m`;
}
