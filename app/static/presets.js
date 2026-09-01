let editingId = null;

const activeRunSection = document.getElementById("active-run-section");
const activeRunCard = document.getElementById("active-run-card");
const formTitle = document.getElementById("preset-form-title");
const form = document.getElementById("preset-form");
const nameInput = document.getElementById("preset-name");
const setpointInput = document.getElementById("preset-setpoint");
const durationInput = document.getElementById("preset-duration");
const submitBtn = document.getElementById("preset-form-submit");
const cancelBtn = document.getElementById("preset-form-cancel");
const formStatus = document.getElementById("preset-form-status");
const listEl = document.getElementById("preset-list");

function resetForm() {
  editingId = null;
  form.reset();
  formTitle.textContent = "New Preset";
  submitBtn.textContent = "Save Preset";
  cancelBtn.hidden = true;
}

function startEdit(preset) {
  editingId = preset.id;
  nameInput.value = preset.name;
  setpointInput.value = preset.setpoint;
  durationInput.value = preset.duration_hours;
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
    setpoint: Number(setpointInput.value),
    duration_hours: Number(durationInput.value),
  };
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

function renderPresetCard(preset, isActive) {
  const card = document.createElement("div");
  card.className = "preset-card";
  card.dataset.id = preset.id;
  card.innerHTML = `
    <div class="preset-card-info">
      <div class="preset-card-name">${preset.name}</div>
      <div class="preset-card-detail">${preset.setpoint}°C for ${formatDuration(preset.duration_hours)}</div>
    </div>
    <div class="preset-card-actions">
      <button class="start-btn" ${isActive ? "disabled" : ""}>${isActive ? "Running" : "Start"}</button>
      <button class="edit-btn">Edit</button>
      <button class="delete-btn">Delete</button>
    </div>
  `;

  card.querySelector(".start-btn").addEventListener("click", async () => {
    const ok = confirm(
      `Start "${preset.name}"?\n\nThis will set the oven to ${preset.setpoint}°C and run it for ${formatDuration(preset.duration_hours)}.`
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

async function loadPresets() {
  const res = await fetch("/api/presets");
  const presets = await res.json();
  listEl.innerHTML = "";
  if (presets.length === 0) {
    listEl.innerHTML = `<div class="preset-empty">No presets yet - create one above.</div>`;
    return;
  }
  for (const preset of presets) {
    listEl.appendChild(renderPresetCard(preset, preset.id === activePresetId));
  }
}

function renderActiveRun(run) {
  if (!run || !run.active) {
    activeRunSection.hidden = true;
    if (activePresetId !== null) {
      activePresetId = null;
      loadPresets();
    }
    return;
  }

  activeRunSection.hidden = false;
  activePresetId = run.preset_id;
  const pct = Math.min(100, (run.elapsed_hours / run.duration_hours) * 100);

  activeRunCard.innerHTML = `
    <div class="active-run-header">
      <div>
        <div class="active-run-label">Currently Running</div>
        <div class="active-run-name">${run.preset_name}</div>
      </div>
      <button id="stop-run-btn" class="stop-btn">Stop</button>
    </div>
    <div class="active-run-meta">
      ${run.setpoint}°C — ${formatDuration(run.elapsed_hours)} elapsed / ${formatDuration(run.duration_hours)} total
      (${formatDuration(run.remaining_hours)} remaining)
    </div>
    <div class="progress-bar">
      <div class="progress-bar-fill" style="width:${pct}%"></div>
    </div>
  `;

  document.getElementById("stop-run-btn").addEventListener("click", async () => {
    const ok = confirm(`Stop "${run.preset_name}" now and turn the oven off?`);
    if (!ok) return;
    try {
      const res = await fetch("/api/run/stop", { method: "POST" });
      if (!res.ok) throw new Error(res.statusText);
      await Promise.all([loadPresets(), loadActiveRun()]);
    } catch (err) {
      alert(`Failed to stop run: ${err.message}`);
    }
  });
}

async function loadActiveRun() {
  const run = await fetchActiveRun();
  renderActiveRun(run);
}

(async function init() {
  await loadActiveRun();
  await loadPresets();
  fetchStatus();
  setInterval(fetchStatus, STATUS_POLL_MS);
  setInterval(loadActiveRun, STATUS_POLL_MS);
})();
