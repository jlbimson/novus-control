const MAX_SEGMENTS = 9;

let editingId = null;
let presetMode = "simple"; // "simple" | "program"
let segments = [{ setpoint: "", minutes: "" }];

const activeRunSection = document.getElementById("active-run-section");
const activeRunCard = document.getElementById("active-run-card");
const formTitle = document.getElementById("preset-form-title");
const form = document.getElementById("preset-form");
const nameInput = document.getElementById("preset-name");
const folderInput = document.getElementById("preset-folder");
const folderOptionsEl = document.getElementById("preset-folder-options");
const setpointInput = document.getElementById("preset-setpoint");
const durationInput = document.getElementById("preset-duration");
const simpleFieldsEl = document.getElementById("simple-fields");
const programFieldsEl = document.getElementById("program-fields");
const segmentListEl = document.getElementById("segment-list");
const addSegmentBtn = document.getElementById("add-segment-btn");
const segmentSummaryEl = document.getElementById("segment-summary");
const submitBtn = document.getElementById("preset-form-submit");
const cancelBtn = document.getElementById("preset-form-cancel");
const formStatus = document.getElementById("preset-form-status");
const listEl = document.getElementById("preset-list");

function setMode(mode) {
  presetMode = mode;
  document.querySelectorAll(".mode-btn").forEach((b) => b.classList.toggle("active", b.dataset.mode === mode));
  simpleFieldsEl.hidden = mode !== "simple";
  programFieldsEl.hidden = mode !== "program";
  setpointInput.required = mode === "simple";
  durationInput.required = mode === "simple";
}

document.querySelectorAll(".mode-btn").forEach((btn) => {
  btn.addEventListener("click", () => setMode(btn.dataset.mode));
});

function renderSegments() {
  segmentListEl.innerHTML = "";
  segments.forEach((seg, i) => {
    const row = document.createElement("div");
    row.className = "segment-row";
    row.innerHTML = `
      <span class="segment-index">${i + 1}</span>
      <label class="segment-field">
        <span>Setpoint (°C)</span>
        <input type="number" step="0.1" class="segment-setpoint" value="${seg.setpoint}" />
      </label>
      <label class="segment-field">
        <span>Time (min)</span>
        <input type="number" step="1" min="1" class="segment-minutes" value="${seg.minutes}" />
      </label>
      <button type="button" class="segment-remove" title="Remove segment" ${segments.length <= 1 ? "disabled" : ""}>✕</button>
    `;
    row.querySelector(".segment-setpoint").addEventListener("input", (e) => {
      segments[i].setpoint = e.target.value;
      updateSegmentSummary();
    });
    row.querySelector(".segment-minutes").addEventListener("input", (e) => {
      segments[i].minutes = e.target.value;
      updateSegmentSummary();
    });
    row.querySelector(".segment-remove").addEventListener("click", () => {
      segments.splice(i, 1);
      renderSegments();
    });
    segmentListEl.appendChild(row);
  });
  addSegmentBtn.disabled = segments.length >= MAX_SEGMENTS;
  updateSegmentSummary();
}

function updateSegmentSummary() {
  const totalMinutes = segments.reduce((sum, s) => sum + (Number(s.minutes) || 0), 0);
  segmentSummaryEl.textContent = `${segments.length} segment${segments.length === 1 ? "" : "s"} — ${formatDuration(totalMinutes / 60)} total`;
}

addSegmentBtn.addEventListener("click", () => {
  if (segments.length >= MAX_SEGMENTS) return;
  const last = segments[segments.length - 1];
  segments.push({ setpoint: last ? last.setpoint : "", minutes: "" });
  renderSegments();
});

function resetForm() {
  editingId = null;
  form.reset();
  segments = [{ setpoint: "", minutes: "" }];
  renderSegments();
  setMode("simple");
  formTitle.textContent = "New Preset";
  submitBtn.textContent = "Save Preset";
  cancelBtn.hidden = true;
}

function startEdit(preset) {
  editingId = preset.id;
  nameInput.value = preset.name;
  folderInput.value = preset.folder || "";
  if (preset.segments && preset.segments.length) {
    segments = preset.segments.map((s) => ({ setpoint: s.setpoint, minutes: s.minutes }));
    renderSegments();
    setMode("program");
  } else {
    setpointInput.value = preset.setpoint;
    durationInput.value = preset.duration_hours;
    setMode("simple");
  }
  formTitle.textContent = `Edit "${preset.name}"`;
  submitBtn.textContent = "Save Changes";
  cancelBtn.hidden = false;
  nameInput.focus();
}

cancelBtn.addEventListener("click", resetForm);

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  const body = {
    name: nameInput.value.trim(),
    folder: folderInput.value.trim(),
  };
  if (presetMode === "program") {
    body.segments = segments.map((s) => ({ setpoint: Number(s.setpoint), minutes: Number(s.minutes) }));
  } else {
    body.setpoint = Number(setpointInput.value);
    body.duration_hours = Number(durationInput.value);
  }

  formStatus.textContent = "saving…";
  try {
    const url = editingId ? `/api/presets/${editingId}` : "/api/presets";
    const method = editingId ? "PUT" : "POST";
    const res = await fetch(url, {
      method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const errBody = await res.json().catch(() => ({}));
      throw new Error(errBody.detail || res.statusText);
    }
    formStatus.textContent = "";
    resetForm();
    await loadPresets();
  } catch (err) {
    formStatus.textContent = `failed: ${err.message}`;
  }
});

function presetDetailText(preset) {
  if (preset.segments && preset.segments.length) {
    const path = preset.segments.map((s) => `${s.setpoint}°C`).join(" → ");
    return `${preset.segments.length} segments (${path}) — ${formatDuration(preset.duration_hours)} total`;
  }
  return `${preset.setpoint}°C for ${formatDuration(preset.duration_hours)}`;
}

function renderPresetCard(preset, isActive) {
  const card = document.createElement("div");
  card.className = "preset-card";
  card.dataset.id = preset.id;
  card.innerHTML = `
    <div class="preset-card-info">
      <div class="preset-card-name">${preset.name}</div>
      <div class="preset-card-detail">${presetDetailText(preset)}</div>
    </div>
    <div class="preset-card-actions">
      <button class="start-btn" ${isActive ? "disabled" : ""}>${isActive ? "Running" : "Start"}</button>
      <button class="edit-btn">Edit</button>
      <button class="delete-btn">Delete</button>
    </div>
  `;

  card.querySelector(".start-btn").addEventListener("click", async () => {
    const ok = confirm(
      `Start "${preset.name}"?\n\nThis will run the oven: ${presetDetailText(preset)}.`
    );
    if (!ok) return;
    try {
      const res = await fetch(`/api/run/start/${preset.id}`, { method: "POST" });
      if (!res.ok) {
        const errBody = await res.json().catch(() => ({}));
        throw new Error(errBody.detail || res.statusText);
      }
      await Promise.all([loadPresets(), loadActiveRun()]);
    } catch (err) {
      alert(`Failed to start preset: ${err.message}`);
    }
  });

  card.querySelector(".edit-btn").addEventListener("click", () => startEdit(preset));

  card.querySelector(".delete-btn").addEventListener("click", async () => {
    const ok = confirm(`Delete preset "${preset.name}"? This cannot be undone.`);
    if (!ok) return;
    try {
      const res = await fetch(`/api/presets/${preset.id}`, { method: "DELETE" });
      if (!res.ok) {
        const errBody = await res.json().catch(() => ({}));
        throw new Error(errBody.detail || res.statusText);
      }
      if (editingId === preset.id) resetForm();
      await loadPresets();
    } catch (err) {
      alert(`Failed to delete preset: ${err.message}`);
    }
  });

  return card;
}

let activePresetId = null;

function updateFolderOptions(presets) {
  const folders = [...new Set(presets.map((p) => p.folder).filter(Boolean))].sort();
  folderOptionsEl.innerHTML = folders.map((f) => `<option value="${f}"></option>`).join("");
}

function isFolderCollapsed(name) {
  try {
    return localStorage.getItem(`novus:preset-folder-collapsed:${name}`) === "1";
  } catch {
    return false;
  }
}

function setFolderCollapsed(name, collapsed) {
  try {
    localStorage.setItem(`novus:preset-folder-collapsed:${name}`, collapsed ? "1" : "0");
  } catch {
    /* ignore */
  }
}

async function loadPresets() {
  const res = await fetch("/api/presets");
  const presets = await res.json();
  updateFolderOptions(presets);

  listEl.innerHTML = "";
  if (presets.length === 0) {
    listEl.innerHTML = `<div class="preset-empty">No presets yet - create one above.</div>`;
    return;
  }

  const groups = new Map();
  for (const preset of presets) {
    const key = preset.folder || "Uncategorized";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(preset);
  }
  const sortedFolders = [...groups.keys()].sort((a, b) => {
    if (a === "Uncategorized") return 1;
    if (b === "Uncategorized") return -1;
    return a.localeCompare(b);
  });

  for (const folderName of sortedFolders) {
    const folderPresets = groups.get(folderName);
    const collapsed = isFolderCollapsed(folderName);

    const section = document.createElement("div");
    section.className = "preset-folder";

    const title = document.createElement("button");
    title.type = "button";
    title.className = "preset-folder-title" + (collapsed ? " collapsed" : "");
    title.innerHTML = `
      <svg class="folder-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>
      <span>${folderName}</span>
      <span class="preset-folder-count">${folderPresets.length}</span>
    `;

    const items = document.createElement("div");
    items.className = "preset-folder-items";
    items.hidden = collapsed;
    for (const preset of folderPresets) {
      items.appendChild(renderPresetCard(preset, preset.id === activePresetId));
    }

    title.addEventListener("click", () => {
      const nowCollapsed = !items.hidden;
      items.hidden = nowCollapsed;
      title.classList.toggle("collapsed", nowCollapsed);
      setFolderCollapsed(folderName, nowCollapsed);
    });

    section.append(title, items);
    listEl.appendChild(section);
  }
}

function renderActiveRun(run) {
  const wasActive = activePresetId !== null;
  activePresetId = run && run.active ? run.preset_id : null;
  renderActiveRunCard(run, activeRunSection, activeRunCard, () => {
    loadPresets();
    loadActiveRun();
  });
  if (wasActive && activePresetId === null) {
    loadPresets();
  }
}

async function loadActiveRun() {
  const run = await fetchActiveRun();
  renderActiveRun(run);
}

(async function init() {
  renderSegments();
  await loadActiveRun();
  await loadPresets();
  fetchStatus();
  setInterval(fetchStatus, STATUS_POLL_MS);
  setInterval(loadActiveRun, STATUS_POLL_MS);
})();
