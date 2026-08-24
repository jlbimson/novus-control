const STATUS_POLL_MS = 3000;

let cfg = { readings: [], controls: [] };
let selectedKey = null;
let selectedMinutes = 60;

const connStatusEl = document.getElementById("conn-status");
const cardsEl = document.getElementById("reading-cards");
const controlsEl = document.getElementById("control-list");
const chartSection = document.getElementById("chart-section");
const chartTitleEl = document.getElementById("chart-title");
const canvas = document.getElementById("chart");
const ctx = canvas.getContext("2d");

function fmt(value, unit) {
  if (value === undefined || value === null || Number.isNaN(value)) return "--";
  const rounded = Math.abs(value) < 10 ? value.toFixed(2) : Math.round(value * 10) / 10;
  return `${rounded}${unit ? ` <span class="unit">${unit}</span>` : ""}`;
}

async function loadConfig() {
  const res = await fetch("/api/config");
  cfg = await res.json();
  renderCards();
  renderControls();
}

function renderCards() {
  cardsEl.innerHTML = "";
  for (const item of cfg.readings) {
    const card = document.createElement("div");
    card.className = "card";
    card.dataset.key = item.key;
    card.innerHTML = `
      <div class="label">${item.label}</div>
      <div class="value" data-value></div>
    `;
    card.addEventListener("click", () => selectReading(item));
    cardsEl.appendChild(card);
  }
}

function selectReading(item) {
  selectedKey = item.key;
  chartTitleEl.textContent = item.label;
  chartSection.hidden = false;
  document.querySelectorAll(".card").forEach((el) => {
    el.classList.toggle("selected", el.dataset.key === item.key);
  });
  loadHistory();
}

function renderControls() {
  controlsEl.innerHTML = "";
  for (const item of cfg.controls) {
    const row = document.createElement("div");
    row.className = "control";
    row.dataset.key = item.key;

    let inputHtml = "";
    if (item.control_type === "toggle") {
      inputHtml = `
        <label class="switch">
          <input type="checkbox" data-input />
          <span class="slider"></span>
        </label>
      `;
    } else if (item.control_type === "number") {
      const attrs = [
        item.min !== undefined ? `min="${item.min}"` : "",
        item.max !== undefined ? `max="${item.max}"` : "",
        item.step !== undefined ? `step="${item.step}"` : "",
      ].join(" ");
      inputHtml = `
        <input type="number" data-input ${attrs} />
        <span>${item.unit || ""}</span>
        <button class="apply" data-apply>Set</button>
      `;
    } else if (item.control_type === "select") {
      const opts = (item.options || [])
        .map((o) => `<option value="${o.value}">${o.label}</option>`)
        .join("");
      inputHtml = `
        <select data-input>${opts}</select>
        <button class="apply" data-apply>Set</button>
      `;
    }

    row.innerHTML = `
      <div class="label">${item.label}</div>
      <div class="input-group">
        ${inputHtml}
        <span class="status-msg" data-status></span>
      </div>
    `;
    controlsEl.appendChild(row);

    const input = row.querySelector("[data-input]");
    const statusMsg = row.querySelector("[data-status]");

    if (item.control_type === "toggle") {
      input.addEventListener("change", () => applyControl(item, input.checked, statusMsg));
    } else {
      const applyBtn = row.querySelector("[data-apply]");
      applyBtn.addEventListener("click", () => {
        const raw = item.control_type === "select" ? Number(input.value) : Number(input.value);
        applyControl(item, raw, statusMsg);
      });
    }
  }
}

async function applyControl(item, value, statusMsg) {
  statusMsg.textContent = "sending…";
  try {
    const res = await fetch(`/api/control/${item.key}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ value }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.detail || res.statusText);
    }
    statusMsg.textContent = "done";
  } catch (err) {
    statusMsg.textContent = "failed";
    console.error("control write failed", item.key, err);
  } finally {
    setTimeout(() => (statusMsg.textContent = ""), 2000);
  }
}

async function pollStatus() {
  try {
    const res = await fetch("/api/status");
    const data = await res.json();
    updateConnStatus(data.connected);
    for (const item of cfg.readings) {
      const card = cardsEl.querySelector(`.card[data-key="${item.key}"] [data-value]`);
      if (card) card.innerHTML = fmt(data.values[item.key], item.unit);
    }
    for (const item of cfg.controls) {
      const row = controlsEl.querySelector(`.control[data-key="${item.key}"]`);
      if (!row) continue;
      const input = row.querySelector("[data-input]");
      const value = data.values[item.key];
      if (value === undefined || document.activeElement === input) continue;
      if (item.control_type === "toggle") {
        input.checked = value >= 0.5;
      } else if (item.control_type === "number") {
        input.value = value;
      } else if (item.control_type === "select") {
        input.value = value;
      }
    }
  } catch (err) {
    updateConnStatus(false);
    console.error("status poll failed", err);
  }
}

function updateConnStatus(connected) {
  connStatusEl.classList.remove("status-ok", "status-bad", "status-unknown");
  connStatusEl.classList.add(connected ? "status-ok" : "status-bad");
  connStatusEl.querySelector(".label").textContent = connected ? "connected" : "disconnected";
}

async function loadHistory() {
  if (!selectedKey) return;
  const res = await fetch(`/api/history?key=${encodeURIComponent(selectedKey)}&minutes=${selectedMinutes}`);
  const points = await res.json();
  drawChart(points);
}

function drawChart(points) {
  const w = canvas.width;
  const h = canvas.height;
  ctx.clearRect(0, 0, w, h);

  if (points.length < 2) {
    ctx.fillStyle = "#8b93a1";
    ctx.font = "14px sans-serif";
    ctx.fillText("Not enough data yet", 16, h / 2);
    return;
  }

  const values = points.map((p) => p.value);
  const times = points.map((p) => p.ts);
  const minV = Math.min(...values);
  const maxV = Math.max(...values);
  const minT = Math.min(...times);
  const maxT = Math.max(...times);
  const padY = (maxV - minV) * 0.1 || 1;
  const yLo = minV - padY;
  const yHi = maxV + padY;

  const marginLeft = 50;
  const marginBottom = 20;
  const plotW = w - marginLeft - 10;
  const plotH = h - marginBottom - 10;

  const x = (t) => marginLeft + ((t - minT) / (maxT - minT || 1)) * plotW;
  const y = (v) => 10 + plotH - ((v - yLo) / (yHi - yLo || 1)) * plotH;

  // gridlines + labels
  ctx.strokeStyle = "#2a323f";
  ctx.fillStyle = "#8b93a1";
  ctx.font = "11px sans-serif";
  ctx.lineWidth = 1;
  const steps = 4;
  for (let i = 0; i <= steps; i++) {
    const v = yLo + ((yHi - yLo) * i) / steps;
    const yy = y(v);
    ctx.beginPath();
    ctx.moveTo(marginLeft, yy);
    ctx.lineTo(w - 10, yy);
    ctx.stroke();
    ctx.fillText(v.toFixed(1), 4, yy + 4);
  }

  // line
  ctx.strokeStyle = "#4f9dff";
  ctx.lineWidth = 2;
  ctx.beginPath();
  points.forEach((p, i) => {
    const px = x(p.ts);
    const py = y(p.value);
    if (i === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  });
  ctx.stroke();
}

document.querySelectorAll(".range-buttons button").forEach((btn) => {
  btn.addEventListener("click", () => {
    selectedMinutes = Number(btn.dataset.minutes);
    document.querySelectorAll(".range-buttons button").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    loadHistory();
  });
});
document.querySelector('.range-buttons button[data-minutes="60"]').classList.add("active");

loadConfig().then(() => {
  pollStatus();
  setInterval(pollStatus, STATUS_POLL_MS);
});
setInterval(() => {
  if (selectedKey) loadHistory();
}, 15000);
