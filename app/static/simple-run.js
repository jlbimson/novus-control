const activeRunSection = document.getElementById("active-run-section");
const activeRunCard = document.getElementById("active-run-card");
const form = document.getElementById("simple-run-form");
const setpointInput = document.getElementById("run-setpoint");
const durationInput = document.getElementById("run-duration");
const formStatus = document.getElementById("run-form-status");

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  const setpoint = Number(setpointInput.value);
  const duration_hours = Number(durationInput.value);

  const ok = confirm(
    `Start a run at ${setpoint}°C for ${formatDuration(duration_hours)}?`
  );
  if (!ok) return;

  formStatus.textContent = "starting…";
  try {
    const res = await fetch("/api/run/start_adhoc", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ setpoint, duration_hours }),
    });
    if (!res.ok) {
      const errBody = await res.json().catch(() => ({}));
      throw new Error(errBody.detail || res.statusText);
    }
    formStatus.textContent = "";
    form.reset();
    await loadActiveRun();
  } catch (err) {
    formStatus.textContent = `failed: ${err.message}`;
  }
});

async function loadActiveRun() {
  const run = await fetchActiveRun();
  renderActiveRunCard(run, activeRunSection, activeRunCard, loadActiveRun);
}

(async function init() {
  await loadActiveRun();
  fetchStatus();
  setInterval(fetchStatus, STATUS_POLL_MS);
  setInterval(loadActiveRun, STATUS_POLL_MS);
})();
