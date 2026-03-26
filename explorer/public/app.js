const STATE_ICON = { ACCEPTED: "✅", ESCALATED: "❌", RUNNING: "🔄", RETRYING: "🔄", INIT: "⏳" };
const DECISION_CLASS = { accept: "accept", reject: "reject", retry: "retry", escalate: "escalate" };

async function loadRuns() {
  const res = await fetch("/runs");
  const runs = await res.json();
  const container = document.getElementById("runs");
  if (!runs.length) { container.innerHTML = "<em>No runs yet. Run a task first.</em>"; return; }
  container.innerHTML = "";
  runs.forEach((run) => {
    const div = document.createElement("div");
    div.className = `run ${run.state}`;
    div.innerHTML = `${STATE_ICON[run.state] ?? "?"} <b>Run ${run.id}</b> — ${run.state} (${run.iterations} step${run.iterations === 1 ? "" : "s"})`;
    div.onclick = () => loadRun(run.id);
    container.appendChild(div);
  });
}

async function loadRun(id) {
  const res = await fetch(`/run/${id}`);
  const run = await res.json();
  const container = document.getElementById("details");
  container.innerHTML = `<h2>${STATE_ICON[run.state] ?? "?"} Run ${run.id} — ${run.state}</h2>`;
  (run.history ?? []).forEach((step) => {
    const div = document.createElement("div");
    div.className = "step";
    const cls = DECISION_CLASS[step.decision] ?? "";
    div.innerHTML = `
      <b>Iteration ${step.iteration}</b> —
      <span class="${cls}">${step.decision.toUpperCase()}</span>
      ${step.failure ? ` | failure: <b>${step.failure.type}</b>` : ""}
      ${step.strategy ? ` | strategy: <b>${step.strategy.action}</b>` : ""}
      <pre>${(step.result?.logs ?? "").slice(0, 300)}</pre>
    `;
    container.appendChild(div);
  });
}

loadRuns();
