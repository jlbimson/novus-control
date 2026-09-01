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

function renderActiveRunCard(run, sectionEl, cardEl, onChange) {
  if (!run || !run.active) {
    sectionEl.hidden = true;
    return;
  }
  sectionEl.hidden = false;
  const pct = Math.min(100, (run.elapsed_hours / run.duration_hours) * 100);

  cardEl.innerHTML = `
    <div class="active-run-header">
      <div>
        <div class="active-run-label">Currently Running</div>
        <div class="active-run-name">${run.preset_name}</div>
      </div>
      <button class="stop-btn" data-stop>Stop</button>
    </div>
    <div class="active-run-meta">
      ${run.setpoint}°C — ${formatDuration(run.elapsed_hours)} elapsed / ${formatDuration(run.duration_hours)} total
      (${formatDuration(run.remaining_hours)} remaining)
    </div>
    <div class="progress-bar">
      <div class="progress-bar-fill" style="width:${pct}%"></div>
    </div>
  `;

  cardEl.querySelector("[data-stop]").addEventListener("click", async () => {
    const ok = confirm(`Stop "${run.preset_name}" now and turn the oven off?`);
    if (!ok) return;
    try {
      const res = await fetch("/api/run/stop", { method: "POST" });
      if (!res.ok) throw new Error(res.statusText);
      if (onChange) onChange();
    } catch (err) {
      alert(`Failed to stop run: ${err.message}`);
    }
  });
}
