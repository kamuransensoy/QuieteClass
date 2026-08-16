// app.js
// Entry point. Wires screens/chrome to state.js, the mission lifecycle,
// calibration/sensitivity, and the active theme. app.js is the only
// module allowed to import both themeRegistry.js and individual theme
// modules (per the theme contract in themeRegistry.js). app.js also
// owns theme-aware copy (mission title/hint, win/fail messages, meter
// label) by reading it from each theme's own metadata — no theme-
// specific text is hardcoded here.

import { subscribe, getState, setState } from "./state.js";
import {
  startSession, pauseSession, resumeSession, endSession, retryMicPermission,
  reportFailEventFinished,
} from "./session.js";
import { registerTheme, getTheme, getAllThemes } from "./themeRegistry.js";
import {
  getCalibrationState, setSensitivity, runCalibration, clearCalibration, getClassifierConfig,
  sensitivityPercentToFactor,
} from "./calibration.js";
import dragonTheme from "../themes/dragon/dragon_theme.js";
import rocketTheme from "../themes/rocket/rocket_theme.js";

registerTheme(dragonTheme);
registerTheme(rocketTheme);

const CUSTOM_MIN_SECONDS = 30;
const CUSTOM_MAX_SECONDS = 1800;
const CUSTOM_STEP_SECONDS = 30;
const CUSTOM_DEFAULT_SECONDS = 150; // 02:30

// Student-facing Launch Energy / Wake Meter status bands — a word
// alongside the percentage so meaning isn't conveyed by color alone.
const METER_BANDS = [
  { max: 40, level: "safe", label: "Safe" },
  { max: 70, level: "building", label: "Building" },
  { max: 90, level: "warning", label: "Warning" },
  { max: 100, level: "final", label: "Final Warning" },
  { max: Infinity, level: "launch", label: "Launch" },
];

const screens = {
  setup: document.getElementById("screen-setup"),
  denied: document.getElementById("screen-denied"),
  session: document.getElementById("screen-session"),
  result: document.getElementById("screen-result"),
};

const startBtn = document.getElementById("start-btn");
const retryBtn = document.getElementById("retry-btn");
const pauseBtn = document.getElementById("pause-btn");
const endBtn = document.getElementById("end-btn");
const stageEl = document.getElementById("stage");
const themePickerEl = document.getElementById("theme-picker");
const durationPickerEl = document.getElementById("duration-picker");
const customBtn = document.getElementById("custom-duration-btn");
const customControlEl = document.getElementById("custom-duration-control");
const customValueEl = document.getElementById("custom-duration-value");
const customMinusBtn = document.getElementById("custom-minus");
const customPlusBtn = document.getElementById("custom-plus");
const countdownEl = document.getElementById("countdown");
const hudMissionTitleEl = document.getElementById("hud-mission-title");
const hudMissionHintEl = document.getElementById("hud-mission-hint");
const hudBottomEl = document.getElementById("hud-bottom");
const meterLabelEl = document.getElementById("meter-label");
const meterStatusEl = document.getElementById("meter-status");
const meterPercentEl = document.getElementById("meter-percent");
const meterFillEl = document.getElementById("wake-meter-fill");
const resultTitleEl = document.getElementById("result-title");
const resultSubtitleEl = document.getElementById("result-subtitle");
const resultLineEl = document.getElementById("result-line");
const resultBtn = document.getElementById("result-btn");
const resultFxEl = document.getElementById("result-fx");

const calibrateBtn = document.getElementById("calibrate-btn");
const recalibrateBtn = document.getElementById("recalibrate-btn");
const calibrationRetryBtn = document.getElementById("calibration-retry-btn");
const calibrationCountdownEl = document.getElementById("calibration-countdown");
const calibrationStates = {
  idle: document.getElementById("calibration-idle"),
  running: document.getElementById("calibration-running"),
  done: document.getElementById("calibration-done"),
  failed: document.getElementById("calibration-failed"),
};
const sensitivitySlider = document.getElementById("sensitivity-slider");
const sensitivityValueEl = document.getElementById("sensitivity-value");
const roomSetupStatusEl = document.getElementById("room-setup-summary-status");

let selectedThemeId = null;
let selectedDurationSeconds = 300;
let customDurationSeconds = CUSTOM_DEFAULT_SECONDS; // preserved for the current page session only
let usingCustomDuration = false;
let activeTheme = null;
let calibrationInProgress = false; // guards against Start Mission racing calibration for the mic

// --- Theme selection ---------------------------------------------------

function selectTheme(themeId) {
  selectedThemeId = themeId;
  const theme = getTheme(themeId);
  if (!theme) return;
  hudMissionTitleEl.textContent = theme.missionTitle;
  hudMissionHintEl.textContent = theme.missionHint;
  meterLabelEl.textContent = theme.meterLabel;
  // Single color hook shared by the HUD goal area and the result screen —
  // set once here rather than duplicated per-consumer. Renderers never
  // read this; it's a chrome-only accent, not gameplay state.
  document.documentElement.style.setProperty("--mission-accent", theme.accentColor || "var(--color-accent)");
}

function renderThemePicker() {
  const themes = getAllThemes();
  themePickerEl.innerHTML = "";
  themePickerEl.hidden = themes.length <= 1; // stay out of the way until a second theme exists
  themes.forEach((theme, index) => {
    const themeOption = document.createElement("button");
    themeOption.type = "button";
    themeOption.className = "theme-option";
    themeOption.setAttribute("role", "option");
    themeOption.setAttribute("aria-selected", index === 0 ? "true" : "false");
    themeOption.style.setProperty("--card-accent", theme.accentColor || "var(--color-accent)");
    themeOption.innerHTML = `<span class="thumb">${theme.thumbnail}</span>
      <span class="theme-body">
        <span class="theme-name">${theme.name}</span>
        <span class="theme-objective">${theme.missionTitle}</span>
      </span>`;
    themeOption.addEventListener("click", () => {
      Array.from(themePickerEl.children).forEach((child) => child.setAttribute("aria-selected", "false"));
      themeOption.setAttribute("aria-selected", "true");
      selectTheme(theme.id);
    });
    themePickerEl.appendChild(themeOption);
  });
  if (themes.length > 0) selectTheme(themes[0].id);
}

// --- Mission duration (presets + custom) --------------------------------
//
// Duration state (selectedDurationSeconds/customDurationSeconds/
// usingCustomDuration) and theme state (selectedThemeId) are deliberately
// separate module-level variables, scoped to separate DOM subtrees
// (durationPickerEl vs themePickerEl) with their own event listeners.
// Nothing in this section may call selectTheme() or touch selectedThemeId
// — duration controls must never be able to change the selected theme.

function formatDuration(totalSeconds) {
  const clamped = Math.max(0, Math.ceil(totalSeconds));
  const m = Math.floor(clamped / 60).toString().padStart(2, "0");
  const s = Math.floor(clamped % 60).toString().padStart(2, "0");
  return `${m}:${s}`;
}

function selectPresetDuration(durationOption, durationOptions) {
  usingCustomDuration = false;
  selectedDurationSeconds = Number(durationOption.dataset.duration);
  customControlEl.hidden = true;
  durationOptions.forEach((o) => o.setAttribute("aria-selected", "false"));
  customBtn.setAttribute("aria-selected", "false");
  durationOption.setAttribute("aria-selected", "true");
}

function selectCustomDuration(durationOptions) {
  usingCustomDuration = true;
  selectedDurationSeconds = customDurationSeconds;
  customControlEl.hidden = false;
  durationOptions.forEach((o) => o.setAttribute("aria-selected", "false"));
  customBtn.setAttribute("aria-selected", "true");
}

function initDurationPicker() {
  const presetOptions = Array.from(durationPickerEl.querySelectorAll(".duration-option:not(.duration-option-custom)"));
  presetOptions.forEach((durationOption) => {
    if (durationOption.getAttribute("aria-selected") === "true") {
      selectedDurationSeconds = Number(durationOption.dataset.duration);
    }
    durationOption.addEventListener("click", () => selectPresetDuration(durationOption, presetOptions));
  });

  customValueEl.textContent = formatDuration(customDurationSeconds);
  customBtn.addEventListener("click", () => selectCustomDuration(presetOptions));

  customMinusBtn.addEventListener("click", () => {
    customDurationSeconds = Math.max(CUSTOM_MIN_SECONDS, customDurationSeconds - CUSTOM_STEP_SECONDS);
    customValueEl.textContent = formatDuration(customDurationSeconds);
    if (usingCustomDuration) selectedDurationSeconds = customDurationSeconds;
  });
  customPlusBtn.addEventListener("click", () => {
    customDurationSeconds = Math.min(CUSTOM_MAX_SECONDS, customDurationSeconds + CUSTOM_STEP_SECONDS);
    customValueEl.textContent = formatDuration(customDurationSeconds);
    if (usingCustomDuration) selectedDurationSeconds = customDurationSeconds;
  });
}

// --- Room calibration + sensitivity -------------------------------------

function showCalibrationState(name) {
  Object.entries(calibrationStates).forEach(([key, el]) => {
    if (el) el.hidden = key !== name;
  });
}

// Mirrors calibration.js's own calibrated flag into the collapsed Room
// Setup summary — display-only, no calibration state lives here.
function updateRoomSetupSummary(calibrated) {
  if (!roomSetupStatusEl) return;
  roomSetupStatusEl.textContent = calibrated ? "Room Ready ✓" : "Optional";
  roomSetupStatusEl.dataset.ready = calibrated ? "true" : "false";
}

function refreshCalibrationUI() {
  const cal = getCalibrationState();
  showCalibrationState(cal.calibrated ? "done" : "idle");
  sensitivitySlider.value = String(cal.sensitivityPercent);
  sensitivityValueEl.textContent = `${cal.sensitivityPercent}%`;
  updateRoomSetupSummary(cal.calibrated);
}

async function beginCalibration() {
  calibrationInProgress = true;
  startBtn.disabled = true;
  showCalibrationState("running");
  calibrationCountdownEl.textContent = "5";
  const result = await runCalibration((secondsRemaining) => {
    calibrationCountdownEl.textContent = String(secondsRemaining);
  });
  calibrationInProgress = false;
  startBtn.disabled = false;
  if (result.ok) {
    showCalibrationState("done");
  } else {
    showCalibrationState("failed");
  }
  updateRoomSetupSummary(getCalibrationState().calibrated);
}

function initCalibrationUI() {
  refreshCalibrationUI();
  calibrateBtn.addEventListener("click", beginCalibration);
  recalibrateBtn.addEventListener("click", beginCalibration);
  calibrationRetryBtn.addEventListener("click", beginCalibration);
  sensitivitySlider.addEventListener("input", () => {
    const state = setSensitivity(Number(sensitivitySlider.value));
    sensitivityValueEl.textContent = `${state.sensitivityPercent}%`;
  });
}

// --- Screens / render ----------------------------------------------------

function setActiveScreen(name) {
  Object.entries(screens).forEach(([key, el]) => {
    el.setAttribute("data-active", key === name ? "true" : "false");
  });
}

function meterBandFor(pct) {
  return METER_BANDS.find((band) => pct < band.max) || METER_BANDS[METER_BANDS.length - 1];
}

// Win celebration: a single fixed-size burst (CONFETTI_COUNT spans, CSS
// keyframe fall+fade) spawned once per win and discarded — never a
// per-frame or unbounded particle system. Colors are a bounded, celebratory
// palette rather than fully random hues, so it always reads as "confetti"
// rather than noise.
const CONFETTI_COUNT = 18;
const CONFETTI_HUES = [350, 200, 45, 265, 150];

function spawnConfetti() {
  for (let i = 0; i < CONFETTI_COUNT; i++) {
    const piece = document.createElement("span");
    piece.className = "confetti-piece";
    const xPercent = Math.round((i / CONFETTI_COUNT) * 100 + (Math.random() * 8 - 4));
    piece.style.left = `${xPercent}%`;
    piece.style.setProperty("--hue", CONFETTI_HUES[i % CONFETTI_HUES.length]);
    piece.style.setProperty("--delay", `${Math.round(Math.random() * 220)}ms`);
    piece.style.setProperty("--duration", `${900 + Math.round(Math.random() * 500)}ms`);
    piece.style.setProperty("--rotate", `${Math.round(Math.random() * 360)}deg`);
    resultFxEl.appendChild(piece);
  }
}

// Removes only generated confetti pieces. The three .smoke-puff spans are
// static markup (index.html) shown/hidden purely via CSS on data-result —
// they're never created or destroyed here.
function clearConfetti() {
  resultFxEl.querySelectorAll(".confetti-piece").forEach((el) => el.remove());
}

function showResult(result) {
  const theme = getTheme(selectedThemeId);
  clearConfetti();
  if (result === "win") {
    screens.result.setAttribute("data-result", "win");
    resultTitleEl.textContent = "Mission Complete";
    resultSubtitleEl.textContent = theme ? theme.successMessage : "Mission complete!";
    resultLineEl.textContent = "Amazing Focus!";
    resultBtn.textContent = "New Mission";
    spawnConfetti();
  } else {
    screens.result.setAttribute("data-result", "fail");
    resultTitleEl.textContent = "Mission Failed";
    resultSubtitleEl.textContent = theme ? theme.failMessage : "Mission failed.";
    resultLineEl.textContent = "Let's Try Again.";
    resultBtn.textContent = "Try Again";
  }
}

// setState fires on every raw audio frame. Track chrome's own last-rendered
// values so the DOM is only touched when a displayed value actually changed.
let lastStatus = null;
let lastResult = null;
let lastRemainingDisplay = null;
let lastMeterWidth = null;
let lastMeterLevel = null;
let lastLocked = null;

function render(state) {
  if (state.status !== lastStatus || state.result !== lastResult) {
    lastStatus = state.status;
    lastResult = state.result;

    if (state.status === "idle" || state.status === "ended") {
      if (activeTheme) {
        activeTheme.onSessionEnd();
        activeTheme.unmount(stageEl);
        activeTheme = null;
        screens.session.removeAttribute("data-theme");
      }
      if (state.status === "ended" && state.result) {
        setActiveScreen("result");
        showResult(state.result);
      } else {
        setActiveScreen("setup");
      }
      pauseBtn.textContent = "Pause";
    } else if (state.status === "micDenied") {
      setActiveScreen("denied");
    } else if (state.status === "running" || state.status === "paused") {
      setActiveScreen("session");
      if (!activeTheme) {
        const theme = getTheme(selectedThemeId);
        if (theme) {
          activeTheme = theme;
          // Lets HUD chrome (see layout.css) apply theme-specific styling
          // — e.g. the Rocket Launch Energy instrument — without any
          // theme reaching into shared HUD DOM itself.
          screens.session.dataset.theme = theme.id;
          activeTheme.mount(stageEl);
        } else {
          // No silent fallback to any theme (e.g. Dragon): if selectedThemeId
          // doesn't resolve, that's a bug to surface immediately, not paper over.
          console.error(`QuietClass: no theme registered for selectedThemeId "${selectedThemeId}" — nothing mounted.`);
        }
      }
    }
  }

  const onSessionScreen = state.status === "running" || state.status === "paused";
  if (onSessionScreen) {
    const display = formatDuration(state.remainingSeconds);
    if (display !== lastRemainingDisplay) {
      lastRemainingDisplay = display;
      countdownEl.textContent = display;
    }

    const pct = Math.round(Math.max(0, Math.min(100, state.wakeMeter)));
    if (pct !== lastMeterWidth) {
      lastMeterWidth = pct;
      // transform instead of width: same visual fill length (see
      // layout.css), but avoids triggering layout on every update.
      meterFillEl.style.transform = `scaleX(${(pct / 100).toFixed(4)})`;
      meterPercentEl.textContent = `${pct}%`;
    }
    const band = meterBandFor(pct);
    if (band.level !== lastMeterLevel) {
      lastMeterLevel = band.level;
      meterStatusEl.textContent = band.label;
      meterStatusEl.setAttribute("data-level", band.level);
      hudBottomEl.setAttribute("data-level", band.level);
    }

    // Forwarded on every update: each theme dedupes internally against
    // whatever it's already showing, so this stays cheap. Core only ever
    // hands over the raw Wake Meter — never the raw microphone state.
    if (activeTheme) activeTheme.updateProgress(state.wakeMeter);
  }

  if (state.locked !== lastLocked) {
    lastLocked = state.locked;
    pauseBtn.disabled = state.locked;
    endBtn.disabled = state.locked;
  }
}

// --- Start / controls ----------------------------------------------------

function beginMission() {
  startSession({
    durationSeconds: selectedDurationSeconds,
    onFail: () => activeTheme && activeTheme.triggerFailEvent(() => reportFailEventFinished()),
  });
}

startBtn.addEventListener("click", () => {
  if (calibrationInProgress) return; // never let a mission grab the mic mid-calibration
  beginMission();
});

retryBtn.addEventListener("click", () => {
  retryMicPermission();
});

pauseBtn.addEventListener("click", () => {
  const { status, locked } = getState();
  if (locked) return;
  if (status === "running") {
    pauseSession();
    pauseBtn.textContent = "Resume";
  } else if (status === "paused") {
    resumeSession();
    pauseBtn.textContent = "Pause";
  }
});

endBtn.addEventListener("click", () => {
  const { locked } = getState();
  if (locked) return;
  endSession();
});

resultBtn.addEventListener("click", () => {
  endSession();
});

renderThemePicker();
initDurationPicker();
initCalibrationUI();
subscribe(render);
render(getState());

// --- Development-only diagnostics (no visible UI) --------------------
//
// qcDebugSetWakeMeter(value): directly pokes the Wake Meter for a quick
// visual preview. The next real audio frame will keep pulling it toward
// whatever actual mic input dictates — for a stable look, call this and
// then stay quiet for a few seconds.
window.qcDebugSetWakeMeter = (value) => {
  const { status } = getState();
  if (status !== "running" && status !== "paused") {
    console.warn("QuietClass debug: no active mission to preview against.");
    return;
  }
  setState({ wakeMeter: Math.max(0, Math.min(100, Number(value))) });
};

// qcDebugStatus(): snapshot of every value in the mic -> calibration ->
// Wake Meter -> theme pipeline, for diagnosing whether real classroom
// noise is actually reaching gameplay. Read-only; changes nothing.
// derivedThresholds shows the classifier config actually in effect for
// the CURRENT/last session — Sensitivity-derived thresholds anchored at
// the room baseline if calibrated, or at 0 if not (see calibration.js's
// getClassifierConfig()) — development-only, this is never shown in
// production UI. No raw threshold numbers are ever shown in production UI.
window.qcDebugStatus = () => {
  const state = getState();
  const cal = getCalibrationState();
  const config = getClassifierConfig();
  const snapshot = {
    micLevel: Number(state.noiseLevel.toFixed(4)),
    noiseState: state.noiseState,
    wakeMeter: Number(state.wakeMeter.toFixed(2)),
    themeProgress: Number((state.wakeMeter / 100).toFixed(4)),
    remainingSeconds: Math.ceil(state.remainingSeconds),
    sessionStatus: state.status,
    locked: state.locked,
    result: state.result,
    activeThemeId: selectedThemeId,
    calibrated: cal.calibrated,
    calibrationBaseline: cal.baseline,
    sensitivityPercent: cal.sensitivityPercent,
    sensitivityFactor: Number(sensitivityPercentToFactor(cal.sensitivityPercent).toFixed(4)),
    derivedThresholds: config.thresholds,
  };
  console.table(snapshot);
  return snapshot;
};

// qcDebugClearCalibration(): removes saved calibration and returns to
// default (uncalibrated) behavior, for easier repeated testing.
window.qcDebugClearCalibration = () => {
  clearCalibration();
  refreshCalibrationUI();
  console.info("QuietClass debug: calibration cleared.");
};

// qcDebugSetupState(): snapshot of every piece of setup-screen state that
// determines what a mission will start with, for verifying theme/duration/
// calibration stay a single source of truth across the setup flow.
// Calibration is fully optional now — there is no modal/prompt state to
// report; Start Mission always starts immediately. Development-only;
// never shown in production UI.
window.qcDebugSetupState = () => {
  const cal = getCalibrationState();
  const snapshot = {
    selectedThemeId,
    selectedDurationSeconds,
    usingCustomDuration,
    calibrated: cal.calibrated,
    calibrationRunning: calibrationInProgress,
    activeScreen: Object.keys(screens).find((key) => screens[key].getAttribute("data-active") === "true") || null,
  };
  console.table(snapshot);
  return snapshot;
};
