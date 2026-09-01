const OVERVIEW_SERIES = [
  { key: "process_variable", color: "#4f9dff", axis: "left" },
  { key: "setpoint", color: "#f5a623", axis: "left" },
  { key: "output_power", color: "#3ec97a", axis: "right" },
];

let cfg = { readings: [], controls: [] };
let itemsByKey = {};
let selectedMinutes = 60;

const cardsEl = document.getElementById("overview-cards");
const legendEl = document.getElementById("chart-legend");
const canvas = document.getElementById("overview-chart");
const ctx = canvas.getContext("2d");
const stateEl = document.getElementById("device-state");

function formatProgramState(values) {
  const progType = values.rs_prog_type;
  if (progType === undefined) return "Unknown";
  if (progType === 0) return "Fixed setpoint";
  if (progType === 1) return "Ramp to Soak";
  if (progType === 2) {
    const prn = values.rs_prn_exec;
    if (!prn) return "Ramps & Soaks (none selected)";
    const seg = values.rs_seg;
    return `Program ${prn}` + (seg !== undefined ? ` · segment ${seg}` : "");
  }
  return `Unknown (${progType})`;
}

function renderStateBadges(values, activeRun) {
  const running = values.control_run >= 0.5;
  const mode = values.control_mode >= 0.5 ? "Automatic" : "Manual";
  const program = formatProgramState(values);
  const presetText =
    activeRun && activeRun.active
      ? `${activeRun.preset_name} — ${formatDuration(activeRun.elapsed_hours)} / ${formatDuration(activeRun.duration_hours)}`
      : "None";

  stateEl.innerHTML = `
    <div class="badge ${running ? "badge-on" : "badge-off"}">
      <span class="badge-label">Run</span>
      <span class="badge-value">${running ? "Running" : "Stopped"}</span>
    </div>
    <div class="badge">
      <span class="badge-label">Mode</span>
      <span class="badge-value">${mode}</span>
    </div>
    <div class="badge">
      <span class="badge-label">Program</span>
      <span class="badge-value">${program}</span>
    </div>
    <div class="badge">
      <span class="badge-label">Preset</span>
      <span class="badge-value">${presetText}</span>
    </div>
  `;
}

function renderCards() {
  cardsEl.innerHTML = "";
  for (const { key, color } of OVERVIEW_SERIES) {
    const item = itemsByKey[key];
    if (!item) continue;
    const card = document.createElement("div");
    card.className = "card overview-card";
    card.dataset.key = key;
    card.innerHTML = `
      <div class="label"><span class="swatch" style="background:${color}"></span>${item.label}</div>
      <div class="value" data-value></div>
    `;
    cardsEl.appendChild(card);
  }
}

function renderLegend() {
  legendEl.innerHTML = OVERVIEW_SERIES.map(({ key, color }) => {
    const item = itemsByKey[key];
    if (!item) return "";
    return `<span class="legend-item"><span class="swatch" style="background:${color}"></span>${item.label}</span>`;
  }).join("");
}

async function pollStatus() {
  const data = await fetchStatus();
  if (!data) return;
  for (const { key } of OVERVIEW_SERIES) {
    const item = itemsByKey[key];
    if (!item) continue;
    const valEl = cardsEl.querySelector(`.card[data-key="${key}"] [data-value]`);
    if (valEl) valEl.innerHTML = fmt(data.values[key], item.unit);
  }
  const activeRun = await fetchActiveRun();
  renderStateBadges(data.values, activeRun);
}

async function loadChart() {
  const series = await Promise.all(
    OVERVIEW_SERIES.map(async ({ key, color, axis }) => {
      const res = await fetch(`/api/history?key=${encodeURIComponent(key)}&minutes=${selectedMinutes}`);
      const points = await res.json();
      const item = itemsByKey[key];
      return { key, label: item ? item.label : key, color, axis, points };
    })
  );
  drawOverviewChart(series);
}

function yScaleFor(seriesList, marginTop, plotH) {
  const values = seriesList.flatMap((s) => s.points.map((p) => p.value));
  if (values.length === 0) {
    return { lo: 0, hi: 1, y: () => marginTop + plotH };
  }
  const minV = Math.min(...values);
  const maxV = Math.max(...values);
  const pad = (maxV - minV) * 0.1 || 1;
  const lo = minV - pad;
  const hi = maxV + pad;
  return { lo, hi, y: (v) => marginTop + plotH - ((v - lo) / (hi - lo || 1)) * plotH };
}

function drawOverviewChart(series) {
  const w = canvas.width;
  const h = canvas.height;
  ctx.clearRect(0, 0, w, h);

  const allPoints = series.flatMap((s) => s.points);
  if (allPoints.length < 2) {
    ctx.fillStyle = "#8b93a1";
    ctx.font = "14px sans-serif";
    ctx.fillText("Not enough data yet", 16, h / 2);
    return;
  }

  const marginLeft = 55;
  const marginRight = 55;
  const marginBottom = 24;
  const marginTop = 10;
  const plotW = w - marginLeft - marginRight;
  const plotH = h - marginTop - marginBottom;

  const times = allPoints.map((p) => p.ts);
  const minT = Math.min(...times);
  const maxT = Math.max(...times);
  const x = (t) => marginLeft + ((t - minT) / (maxT - minT || 1)) * plotW;

  const leftSeries = series.filter((s) => s.axis === "left" && s.points.length);
  const rightSeries = series.filter((s) => s.axis === "right" && s.points.length);
  const leftScale = yScaleFor(leftSeries.length ? leftSeries : series, marginTop, plotH);
  const rightScale = yScaleFor(rightSeries.length ? rightSeries : series, marginTop, plotH);

  ctx.strokeStyle = "#2a323f";
  ctx.fillStyle = "#8b93a1";
  ctx.font = "11px sans-serif";
  ctx.lineWidth = 1;
  const steps = 4;
  for (let i = 0; i <= steps; i++) {
    const v = leftScale.lo + ((leftScale.hi - leftScale.lo) * i) / steps;
    const yy = leftScale.y(v);
    ctx.beginPath();
    ctx.moveTo(marginLeft, yy);
    ctx.lineTo(w - marginRight, yy);
    ctx.stroke();
    ctx.fillText(v.toFixed(1), 4, yy + 4);
  }
  if (rightSeries.length) {
    for (let i = 0; i <= steps; i++) {
      const v = rightScale.lo + ((rightScale.hi - rightScale.lo) * i) / steps;
      const yy = rightScale.y(v);
      ctx.fillText(v.toFixed(0), w - marginRight + 8, yy + 4);
    }
  }

  for (const s of series) {
    if (s.points.length < 2) continue;
    const scale = s.axis === "right" ? rightScale : leftScale;
    ctx.strokeStyle = s.color;
    ctx.lineWidth = 2;
    ctx.beginPath();
    s.points.forEach((p, i) => {
      const px = x(p.ts);
      const py = scale.y(p.value);
      if (i === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    });
    ctx.stroke();
  }
}

document.querySelectorAll(".range-buttons button").forEach((btn) => {
  btn.addEventListener("click", () => {
    selectedMinutes = Number(btn.dataset.minutes);
    document.querySelectorAll(".range-buttons button").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    loadChart();
  });
});

(async function init() {
  cfg = await loadConfig();
  itemsByKey = {};
  for (const item of [...cfg.readings, ...cfg.controls]) itemsByKey[item.key] = item;
  renderCards();
  renderLegend();
  await pollStatus();
  await loadChart();
  setInterval(pollStatus, STATUS_POLL_MS);
  setInterval(loadChart, 15000);
})();
