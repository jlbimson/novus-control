const OVERVIEW_SERIES = [
  { key: "process_variable", color: "#4f9dff", axis: "left" },
  { key: "setpoint", color: "#f5a623", axis: "left" },
  { key: "output_power", color: "#3ec97a", axis: "right" },
];

let cfg = { readings: [], controls: [] };
let itemsByKey = {};
let selectedMinutes = 60;
let visibleSeries = Object.fromEntries(OVERVIEW_SERIES.map((s) => [s.key, true]));
let lastSeries = [];
let lastLayout = null;
let logicalWidth = 900;
let logicalHeight = 320;

const cardsEl = document.getElementById("overview-cards");
const legendEl = document.getElementById("chart-legend");
const canvas = document.getElementById("overview-chart");
const ctx = canvas.getContext("2d");
const canvasWrap = canvas.parentElement;
const tooltipEl = document.getElementById("chart-tooltip");
const stateEl = document.getElementById("device-state");

function resizeCanvas() {
  const dpr = window.devicePixelRatio || 1;
  const cssWidth = canvasWrap.clientWidth;
  const cssHeight = canvas.clientHeight || 320;
  canvas.width = Math.round(cssWidth * dpr);
  canvas.height = Math.round(cssHeight * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  logicalWidth = cssWidth;
  logicalHeight = cssHeight;
}

let resizeTimer = null;
window.addEventListener("resize", () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    resizeCanvas();
    drawOverviewChart(lastSeries);
  }, 150);
});

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
  legendEl.innerHTML = "";
  for (const { key, color } of OVERVIEW_SERIES) {
    const item = itemsByKey[key];
    if (!item) continue;
    const el = document.createElement("span");
    el.className = "legend-item" + (visibleSeries[key] ? "" : " off");
    el.dataset.key = key;
    el.title = "Click to toggle on the graph";
    el.innerHTML = `<span class="swatch" style="background:${color}"></span>${item.label}`;
    el.addEventListener("click", () => {
      visibleSeries[key] = !visibleSeries[key];
      el.classList.toggle("off", !visibleSeries[key]);
      hideTooltip();
      drawOverviewChart(lastSeries);
    });
    legendEl.appendChild(el);
  }
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
      return { key, label: item ? item.label : key, color, axis, unit: item ? item.unit : "", points };
    })
  );
  lastSeries = series;
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

function formatAxisTime(ts) {
  const d = new Date(ts * 1000);
  if (selectedMinutes > 60 * 36) {
    return d.toLocaleDateString([], { month: "short", day: "numeric" });
  }
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function formatTooltipTime(ts) {
  const d = new Date(ts * 1000);
  return d.toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function nearestPoint(points, t) {
  if (!points.length) return null;
  let best = points[0];
  let bestDiff = Math.abs(points[0].ts - t);
  for (const p of points) {
    const diff = Math.abs(p.ts - t);
    if (diff < bestDiff) {
      best = p;
      bestDiff = diff;
    }
  }
  return best;
}

function drawOverviewChart(series, hoverX) {
  const w = logicalWidth;
  const h = logicalHeight;
  ctx.clearRect(0, 0, w, h);

  const compact = w < 480;
  const visible = series.filter((s) => visibleSeries[s.key]);
  const allPoints = visible.flatMap((s) => s.points);
  if (allPoints.length < 2) {
    ctx.fillStyle = "#8b93a1";
    ctx.font = "14px sans-serif";
    ctx.fillText(
      series.length && visible.length === 0 ? "All series hidden" : "Not enough data yet",
      16,
      h / 2
    );
    lastLayout = null;
    return;
  }

  const rightSeriesExists = visible.some((s) => s.axis === "right" && s.points.length);
  const marginLeft = compact ? 34 : 55;
  const marginRight = compact ? (rightSeriesExists ? 30 : 10) : 55;
  const marginBottom = 26;
  const marginTop = 10;
  const plotW = w - marginLeft - marginRight;
  const plotH = h - marginTop - marginBottom;
  const fontSize = compact ? 10 : 11;

  const times = allPoints.map((p) => p.ts);
  const minT = Math.min(...times);
  const maxT = Math.max(...times);
  const x = (t) => marginLeft + ((t - minT) / (maxT - minT || 1)) * plotW;
  const invX = (px) => minT + ((px - marginLeft) / plotW) * (maxT - minT || 1);

  const leftSeries = visible.filter((s) => s.axis === "left" && s.points.length);
  const rightSeries = visible.filter((s) => s.axis === "right" && s.points.length);
  const leftScale = yScaleFor(leftSeries.length ? leftSeries : visible, marginTop, plotH);
  const rightScale = yScaleFor(rightSeries.length ? rightSeries : visible, marginTop, plotH);

  ctx.strokeStyle = "#232b38";
  ctx.fillStyle = "#838da0";
  ctx.font = `${fontSize}px sans-serif`;
  ctx.lineWidth = 1;
  const steps = compact ? 3 : 4;
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
      ctx.fillText(v.toFixed(0), w - marginRight + 6, yy + 4);
    }
  }

  const xSteps = compact ? 2 : 5;
  ctx.textAlign = "center";
  for (let i = 0; i <= xSteps; i++) {
    const t = minT + ((maxT - minT) * i) / xSteps;
    let px = x(t);
    if (i === 0) {
      ctx.textAlign = "left";
      px = marginLeft;
    } else if (i === xSteps) {
      ctx.textAlign = "right";
      px = w - marginRight;
    } else {
      ctx.textAlign = "center";
    }
    ctx.fillText(formatAxisTime(t), px, h - 8);
  }
  ctx.textAlign = "left";

  for (const s of visible) {
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

  lastLayout = { marginLeft, marginRight, marginTop, plotW, plotH, minT, maxT, x, invX, leftScale, rightScale, visible };

  if (hoverX !== undefined && hoverX >= marginLeft && hoverX <= w - marginRight) {
    ctx.strokeStyle = "#4a5568";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(hoverX, marginTop);
    ctx.lineTo(hoverX, marginTop + plotH);
    ctx.stroke();

    const hoverT = invX(hoverX);
    for (const s of visible) {
      const p = nearestPoint(s.points, hoverT);
      if (!p) continue;
      const scale = s.axis === "right" ? rightScale : leftScale;
      ctx.beginPath();
      ctx.arc(x(p.ts), scale.y(p.value), 3.5, 0, Math.PI * 2);
      ctx.fillStyle = s.color;
      ctx.fill();
    }
  }
}

function hideTooltip() {
  tooltipEl.hidden = true;
}

function updateTooltip(dataX, cssX, cssY) {
  if (!lastLayout) return;
  const { marginLeft, marginRight, invX, visible } = lastLayout;
  if (dataX < marginLeft || dataX > logicalWidth - marginRight) {
    hideTooltip();
    drawOverviewChart(lastSeries);
    return;
  }

  const hoverT = invX(dataX);
  const rows = visible
    .map((s) => {
      const p = nearestPoint(s.points, hoverT);
      const val = p ? fmt(p.value, s.unit) : "--";
      return `<div class="chart-tooltip-row"><span class="swatch" style="background:${s.color}"></span><span>${s.label}</span><strong>${val}</strong></div>`;
    })
    .join("");
  tooltipEl.innerHTML = `<div class="chart-tooltip-time">${formatTooltipTime(hoverT)}</div>${rows}`;
  tooltipEl.hidden = false;

  const wrapRect = canvasWrap.getBoundingClientRect();
  const tw = tooltipEl.offsetWidth;
  let left = cssX + 14;
  if (left + tw > wrapRect.width - 4) left = cssX - tw - 14;
  tooltipEl.style.left = `${Math.max(4, left)}px`;
  tooltipEl.style.top = `${Math.max(4, cssY - 10)}px`;

  drawOverviewChart(lastSeries, dataX);
}

canvas.addEventListener("pointermove", (e) => {
  const rect = canvas.getBoundingClientRect();
  const dataX = e.clientX - rect.left;
  const wrapRect = canvasWrap.getBoundingClientRect();
  updateTooltip(dataX, e.clientX - wrapRect.left, e.clientY - wrapRect.top);
});

canvas.addEventListener("pointerleave", () => {
  hideTooltip();
  drawOverviewChart(lastSeries);
});

document.querySelectorAll(".range-buttons button").forEach((btn) => {
  btn.addEventListener("click", () => {
    selectedMinutes = Number(btn.dataset.minutes);
    document.querySelectorAll(".range-buttons button").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    hideTooltip();
    loadChart();
  });
});

(async function init() {
  cfg = await loadConfig();
  itemsByKey = {};
  for (const item of [...cfg.readings, ...cfg.controls]) itemsByKey[item.key] = item;
  renderCards();
  renderLegend();
  resizeCanvas();
  await pollStatus();
  await loadChart();
  setInterval(pollStatus, STATUS_POLL_MS);
  setInterval(loadChart, 15000);
})();
