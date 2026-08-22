// voiceLevelMeasurementTool.js
// TEMPORARY developer-only tool for collecting real classroom mic-level
// data (median/p75/p90/peak per scenario) to inform future Voice Level
// LEVEL_DELTAS tuning. Reuses the existing audio.js capture/smoothing
// pipeline exactly as-is (startAudio/stopAudio, unmodified) — no second
// microphone implementation, no sample transforms, no changes to
// classifier/calibration/Wake Meter math. Opened only via
// window.qcDebugOpenMeasurementTool() (see app.js); never linked from
// teacher-facing UI. Refuses to open or sample while a real mission is
// running or paused.

import { startAudio, stopAudio } from "../core/audio.js";
import { getState } from "../core/state.js";
import { getCalibrationState } from "../core/calibration.js";

const SAMPLE_DURATION_MS = 10000;
const PANEL_ID = "qc-measurement-tool";
const STYLE_ID = "qc-measurement-tool-style";

const SCENARIOS = [
  { id: "room_quiet", label: "Room Quiet" },
  { id: "whisper", label: "Whisper" },
  { id: "partner_talk", label: "Partner Talk" },
  { id: "group_work", label: "Group Work" },
  { id: "loud_disruptive", label: "Loud / Disruptive" },
];

let results = {}; // scenarioId -> stats | undefined
let capturing = false;
let captureTimeoutId = null;
let samples = [];
let rowEls = {}; // scenarioId -> cell refs

function injectStyles() {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = `
#${PANEL_ID} {
  position: fixed; top: 16px; right: 16px; z-index: 999999;
  width: 440px; max-width: calc(100vw - 32px);
  background: #14161c; color: #e8eaf0; border: 1px solid #3a3f4b;
  border-radius: 10px; padding: 14px; font: 12px/1.4 -apple-system, system-ui, sans-serif;
  box-shadow: 0 8px 28px rgba(0,0,0,0.45);
}
#${PANEL_ID} h2 { font-size: 13px; margin: 0 0 2px; }
#${PANEL_ID} .qc-mt-sub { color: #9aa0ad; margin: 0 0 10px; font-size: 11px; }
#${PANEL_ID} table { width: 100%; border-collapse: collapse; margin-bottom: 10px; }
#${PANEL_ID} th, #${PANEL_ID} td { text-align: left; padding: 4px 6px; border-bottom: 1px solid #2a2d36; font-size: 11px; white-space: nowrap; }
#${PANEL_ID} th { color: #9aa0ad; font-weight: 500; }
#${PANEL_ID} button { font: inherit; cursor: pointer; border-radius: 6px; border: 1px solid #3a3f4b; background: #22252e; color: #e8eaf0; padding: 4px 8px; }
#${PANEL_ID} button:hover:not(:disabled) { background: #2c2f3a; }
#${PANEL_ID} button:disabled { opacity: 0.45; cursor: default; }
#${PANEL_ID} .qc-mt-sample-btn { min-width: 74px; }
#${PANEL_ID} .qc-mt-actions { display: flex; gap: 8px; flex-wrap: wrap; }
#${PANEL_ID} .qc-mt-status { margin: 0 0 8px; min-height: 14px; color: #ffb454; font-size: 11px; }
#${PANEL_ID} .qc-mt-close { position: absolute; top: 10px; right: 10px; border: none; background: none; color: #9aa0ad; font-size: 14px; padding: 2px 6px; cursor: pointer; }
`;
  document.head.appendChild(style);
}

function computeStats(levelSamples) {
  if (!levelSamples.length) return null;
  const sorted = [...levelSamples].sort((a, b) => a - b);
  const at = (p) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
  return {
    count: sorted.length,
    median: at(0.5),
    p75: at(0.75),
    p90: at(0.9),
    peak: sorted[sorted.length - 1],
  };
}

function fmt(n) {
  return typeof n === "number" ? n.toFixed(3) : "—";
}

function currentBaseline() {
  const cal = getCalibrationState();
  return cal.calibrated ? cal.baseline : 0;
}

function renderRow(scenario) {
  const stats = results[scenario.id];
  const cells = rowEls[scenario.id];
  if (!stats) {
    cells.medianEl.textContent = cells.p75El.textContent = cells.p90El.textContent =
      cells.peakEl.textContent = cells.deltaEl.textContent = "—";
    return;
  }
  cells.medianEl.textContent = fmt(stats.median);
  cells.p75El.textContent = fmt(stats.p75);
  cells.p90El.textContent = fmt(stats.p90);
  cells.peakEl.textContent = fmt(stats.peak);
  cells.deltaEl.textContent = fmt(stats.median - currentBaseline());
}

function renderAllRows() {
  SCENARIOS.forEach(renderRow);
}

function setStatus(text) {
  const statusEl = document.querySelector(`#${PANEL_ID} .qc-mt-status`);
  if (statusEl) statusEl.textContent = text || "";
}

function setSampleButtonsDisabled(disabled) {
  document.querySelectorAll(`#${PANEL_ID} .qc-mt-sample-btn`).forEach((btn) => {
    btn.disabled = disabled;
  });
}

// Stop is driven by an independent setTimeout (not by counting frames
// inside the onLevel callback) so stopAudio() is never invoked from
// within audio.js's own rAF call stack — avoids racing its internal
// tick()/rafId lifecycle.
async function startSample(scenario) {
  if (capturing) return;
  const { status } = getState();
  if (status === "running" || status === "paused") {
    setStatus("Cannot sample while a real mission is active.");
    return;
  }

  capturing = true;
  samples = [];
  setSampleButtonsDisabled(true);
  setStatus(`Sampling "${scenario.label}"… behave as described for ~10s.`);

  const ok = await startAudio((level) => {
    if (capturing) samples.push(level);
  });

  if (!ok) {
    capturing = false;
    setSampleButtonsDisabled(false);
    setStatus("Microphone access failed — check permissions.");
    return;
  }

  captureTimeoutId = setTimeout(() => {
    capturing = false;
    captureTimeoutId = null;
    stopAudio();
    results[scenario.id] = computeStats(samples);
    samples = [];
    renderAllRows();
    setSampleButtonsDisabled(false);
    setStatus(`"${scenario.label}" sample complete.`);
  }, SAMPLE_DURATION_MS);
}

function buildResultsPayload() {
  const cal = getCalibrationState();
  const baseline = currentBaseline();
  const payload = {
    tool: "QuietClass Voice Level Measurement",
    timestamp: new Date().toISOString(),
    calibrated: cal.calibrated,
    calibrationBaseline: cal.calibrated ? Number(cal.baseline.toFixed(4)) : null,
    sensitivityPercent: cal.sensitivityPercent,
    sampleDurationMs: SAMPLE_DURATION_MS,
    scenarios: {},
  };
  SCENARIOS.forEach((scenario) => {
    const stats = results[scenario.id];
    payload.scenarios[scenario.id] = stats
      ? {
          count: stats.count,
          median: Number(stats.median.toFixed(4)),
          p75: Number(stats.p75.toFixed(4)),
          p90: Number(stats.p90.toFixed(4)),
          peak: Number(stats.peak.toFixed(4)),
          deltaAboveBaseline: Number((stats.median - baseline).toFixed(4)),
        }
      : null;
  });
  return payload;
}

async function copyResults() {
  const text = JSON.stringify(buildResultsPayload(), null, 2);
  try {
    await navigator.clipboard.writeText(text);
    setStatus("Results copied to clipboard.");
  } catch (err) {
    setStatus("Clipboard blocked — results logged to console instead.");
    console.log(text);
  }
}

function clearResults() {
  if (capturing) return;
  results = {};
  renderAllRows();
  setStatus("Measurements cleared.");
}

function closePanel() {
  if (captureTimeoutId) {
    clearTimeout(captureTimeoutId);
    captureTimeoutId = null;
  }
  if (capturing) {
    capturing = false;
    stopAudio();
  }
  const panel = document.getElementById(PANEL_ID);
  if (panel) panel.remove();
}

export function openMeasurementTool() {
  const { status } = getState();
  if (status === "running" || status === "paused") {
    console.warn("QuietClass measurement tool: cannot open during an active mission.");
    return;
  }
  if (document.getElementById(PANEL_ID)) return; // already open

  injectStyles();
  rowEls = {};

  const panel = document.createElement("div");
  panel.id = PANEL_ID;
  // Dev-only tool — opted out of the global UI click-feedback layer
  // (see app.js's initUiClickFeedback()).
  panel.dataset.uiSound = "off";

  const closeBtn = document.createElement("button");
  closeBtn.className = "qc-mt-close";
  closeBtn.textContent = "✕";
  closeBtn.setAttribute("aria-label", "Close measurement tool");
  closeBtn.addEventListener("click", closePanel);
  panel.appendChild(closeBtn);

  const heading = document.createElement("h2");
  heading.textContent = "Voice Level Measurement Tool";
  panel.appendChild(heading);

  const sub = document.createElement("p");
  sub.className = "qc-mt-sub";
  sub.textContent = "Dev-only. Samples the existing smoothed mic level for ~10s per scenario.";
  panel.appendChild(sub);

  const status = document.createElement("p");
  status.className = "qc-mt-status";
  panel.appendChild(status);

  const table = document.createElement("table");
  table.innerHTML = `<thead><tr>
    <th>Scenario</th><th>Median</th><th>p75</th><th>p90</th><th>Peak</th><th>&Delta; base</th><th></th>
  </tr></thead>`;
  const tbody = document.createElement("tbody");

  SCENARIOS.forEach((scenario) => {
    const row = document.createElement("tr");

    const nameCell = document.createElement("td");
    nameCell.textContent = scenario.label;

    const medianEl = document.createElement("td");
    const p75El = document.createElement("td");
    const p90El = document.createElement("td");
    const peakEl = document.createElement("td");
    const deltaEl = document.createElement("td");

    const actionCell = document.createElement("td");
    const sampleBtn = document.createElement("button");
    sampleBtn.className = "qc-mt-sample-btn";
    sampleBtn.textContent = "Start Sample";
    sampleBtn.addEventListener("click", () => startSample(scenario));
    actionCell.appendChild(sampleBtn);

    row.append(nameCell, medianEl, p75El, p90El, peakEl, deltaEl, actionCell);
    tbody.appendChild(row);

    rowEls[scenario.id] = { medianEl, p75El, p90El, peakEl, deltaEl };
  });

  table.appendChild(tbody);
  panel.appendChild(table);

  const actions = document.createElement("div");
  actions.className = "qc-mt-actions";

  const copyBtn = document.createElement("button");
  copyBtn.textContent = "Copy Results";
  copyBtn.addEventListener("click", copyResults);

  const clearBtn = document.createElement("button");
  clearBtn.textContent = "Clear Measurements";
  clearBtn.addEventListener("click", clearResults);

  actions.append(copyBtn, clearBtn);
  panel.appendChild(actions);

  document.body.appendChild(panel);
  renderAllRows();
}
