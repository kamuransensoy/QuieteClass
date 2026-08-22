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
  reportFailEventFinished, qcDebugForceFail,
} from "./session.js";
import { registerTheme, getTheme, getAllThemes } from "./themeRegistry.js";
import {
  getCalibrationState, setSensitivity, runCalibration, clearCalibration, getClassifierConfig,
  sensitivityPercentToFactor,
} from "./calibration.js";
import { getMissionRating } from "./rating.js";
import { getClassStreak } from "./streak.js";
import * as missionAudio from "./missionAudio.js";
import * as brandAudio from "./brandAudio.js";

// qcDebugAudioStatus(): read-only snapshot of mission-audio internal state
// (enabled/paused/targets/current volumes/what's actually playing) — same
// development-only pattern as qcDebugStatus() below. Never shown in
// production UI, changes nothing.
window.qcDebugAudioStatus = () => {
  const snapshot = missionAudio.qcDebugAudioStatus();
  console.table(snapshot.playing || {});
  console.log(snapshot);
  return snapshot;
};
import dragonTheme from "../themes/dragon/dragon_theme.js";
import rocketTheme from "../themes/rocket/rocket_theme.js";

registerTheme(dragonTheme);
registerTheme(rocketTheme);

// Both missions are offered as choices on setup — Dragon's PNG+GSAP live
// renderer has passed QA (see project history) and is production-ready.
const AVAILABLE_MISSION_IDS = ["rocket", "dragon"];

const CUSTOM_MIN_SECONDS = 30;
const CUSTOM_MAX_SECONDS = 1800;
const CUSTOM_STEP_SECONDS = 30;
const CUSTOM_DEFAULT_SECONDS = 150; // 02:30

// Voice Level: teacher-facing replacement for raw Sensitivity as the
// primary room control. UI-only for now — carried into state via
// startSession() but not yet mapped to the classifier/sensitivity value.
const VOICE_LEVELS = [
  { level: 0, name: "Silent", description: "No talking" },
  { level: 1, name: "Whisper", description: "Talk quietly to one person" },
  { level: 2, name: "Partner Talk", description: "Quiet partner/table conversation" },
  { level: 3, name: "Group Work", description: "Controlled group conversation" },
];

// Mission Rating copy: same star counts (rating.js), different wording per
// context — a live in-progress mission reads as a goal to protect, a
// completed one reads as a final grade. Theme-agnostic core gameplay
// copy, not specific to Rocket.
const LIVE_RATING_LABELS = { 3: "Perfect Mission", 2: "Great Mission", 1: "Keep It Grounded" };
const RESULT_WIN_RATING_LABELS = { 3: "Perfect Mission", 2: "Great Mission", 1: "Mission Complete" };

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
  welcome: document.getElementById("screen-welcome"),
  setup: document.getElementById("screen-setup"),
  denied: document.getElementById("screen-denied"),
  countdown: document.getElementById("screen-countdown"),
  session: document.getElementById("screen-session"),
  result: document.getElementById("screen-result"),
};

const welcomeStartBtn = document.getElementById("welcome-start-btn");
const welcomeSoundToggleBtn = document.getElementById("welcome-sound-toggle-btn");
const welcomeSoundLabelEl = document.getElementById("welcome-sound-label");
const howItWorksBtn = document.getElementById("how-it-works-btn");
const howItWorksModal = document.getElementById("how-it-works-modal");
const howItWorksCloseBtn = document.getElementById("how-it-works-close-btn");
const howItWorksGotItBtn = document.getElementById("how-it-works-got-it-btn");
const countdownNumberEl = document.getElementById("countdown-number");

const startBtn = document.getElementById("start-btn");
const retryBtn = document.getElementById("retry-btn");
const pauseBtn = document.getElementById("pause-btn");
const endBtn = document.getElementById("end-btn");
const stageEl = document.getElementById("stage");
const themePickerEl = document.getElementById("theme-picker");
const voiceLevelPickerEl = document.getElementById("voice-level-picker");
const voiceLevelCaptionEl = document.getElementById("voice-level-caption");
const durationPickerEl = document.getElementById("duration-picker");
const customBtn = document.getElementById("custom-duration-btn");
const customControlEl = document.getElementById("custom-duration-control");
const customValueEl = document.getElementById("custom-duration-value");
const customMinusBtn = document.getElementById("custom-minus");
const customPlusBtn = document.getElementById("custom-plus");
const countdownEl = document.getElementById("countdown");
const hudMissionTitleEl = document.getElementById("hud-mission-title");
const hudMissionHintEl = document.getElementById("hud-mission-hint");
const hudVoiceLevelEl = document.getElementById("hud-voice-level");
const hudStreakChipEl = document.getElementById("hud-streak-chip");
const hudPausedBadgeEl = document.getElementById("hud-paused-badge");
const hudBottomEl = document.getElementById("hud-bottom");
const meterLabelEl = document.getElementById("meter-label");
const meterStatusEl = document.getElementById("meter-status");
const meterPercentEl = document.getElementById("meter-percent");
const meterFillEl = document.getElementById("wake-meter-fill");
const missionRatingStarEls = Array.from(document.querySelectorAll("#mission-rating .rating-star"));
const missionRatingLabelEl = document.getElementById("mission-rating-label");
const pauseBtnLabelEl = document.getElementById("pause-btn-label");
const pauseIconEl = document.querySelector(".control-btn-icon-pause");
const playIconEl = document.querySelector(".control-btn-icon-play");
const resultTitleEl = document.getElementById("result-title");
const resultLineEl = document.getElementById("result-line");
const resultRatingStarsEl = document.getElementById("result-rating-stars");
const resultRatingLabelEl = document.getElementById("result-rating-label");
const resultStreakLabelEl = document.getElementById("result-streak-label");
const resultStreakValueEl = document.getElementById("result-streak-value");
const resultPrimaryBtn = document.getElementById("result-primary-btn");
const resultSecondaryBtn = document.getElementById("result-secondary-btn");
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
const missionSoundsOptionEls = Array.from(document.querySelectorAll("#mission-sounds-toggle .mission-sounds-option"));
const soundToggleBtn = document.getElementById("sound-toggle-btn");
const soundToggleLabelEl = document.getElementById("sound-toggle-label");

let selectedThemeId = null;
let selectedVoiceLevel = 0;
let selectedDurationSeconds = 300;
let customDurationSeconds = CUSTOM_DEFAULT_SECONDS; // preserved for the current page session only
let usingCustomDuration = false;
let activeTheme = null;
let calibrationInProgress = false; // guards against Start Mission racing calibration for the mic

// countdownActive: true from the moment Start Mission (or Play Again) is
// pressed until the 5-4-3-2-1 + dong sequence finishes. Deliberately a
// local UI flag, not a state.js status value — see runCountdown() below.
// While true, render()'s running/paused branch is suppressed so the
// synthetic startSession()->pauseSession() "time freeze" used to hold the
// mission at its full duration never mounts the theme early.
let countdownActive = false;
// missionStarting: guards Start Mission / Play Again against a double or
// rapid click producing a second session/countdown/audio instance.
let missionStarting = false;

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
  // Lets the setup screen's ambient wash react per-theme (see layout.css)
  // beyond a single accent color — separate from #screen-session's own
  // data-theme (set only while a mission is actually mounted).
  document.documentElement.dataset.selectedTheme = theme.id;
}

function renderThemePicker() {
  const themes = getAllThemes().filter((theme) => AVAILABLE_MISSION_IDS.includes(theme.id));
  themePickerEl.innerHTML = "";
  themePickerEl.hidden = themes.length === 0;
  // Single-mission MVP state: center and enlarge the lone card instead of
  // leaving an empty gap where a second card would normally sit.
  themePickerEl.classList.toggle("theme-cards--single", themes.length === 1);
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

// --- Voice Level ---------------------------------------------------------

function selectVoiceLevel(level, options) {
  selectedVoiceLevel = level;
  options.forEach((o) => o.setAttribute("aria-selected", String(Number(o.dataset.level) === level)));
  const info = VOICE_LEVELS[level];
  voiceLevelCaptionEl.innerHTML = `<strong>${info.name}</strong> — ${info.description}`;
}

function initVoiceLevelPicker() {
  const options = Array.from(voiceLevelPickerEl.querySelectorAll(".voice-level-option"));
  options.forEach((option) => {
    option.addEventListener("click", () => selectVoiceLevel(Number(option.dataset.level), options));
  });
  selectVoiceLevel(selectedVoiceLevel, options);
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
  roomSetupStatusEl.textContent = calibrated ? "✓ Ready" : "Not Calibrated";
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

// --- Mission Sounds (single shared preference, two views) ----------------
//
// missionAudio.js is the one source of truth for whether QuietClass's own
// playback is enabled — the Setup toggle and the live Sound button are
// just two places that read/write it, never a second independent mute
// state. This controls QuietClass's own speaker output only; the
// microphone (audio.js) is entirely unaffected either way.

function syncSoundControls() {
  const on = missionAudio.isEnabled();
  missionSoundsOptionEls.forEach((opt) => {
    opt.setAttribute("aria-selected", String(opt.dataset.sounds === (on ? "on" : "off")));
  });
  soundToggleBtn.setAttribute("aria-pressed", String(on));
  soundToggleLabelEl.textContent = on ? "Sound On" : "Sound Off";
  welcomeSoundToggleBtn.setAttribute("aria-pressed", String(on));
  welcomeSoundLabelEl.textContent = on ? "Sounds On" : "Sounds Off";
}

function initSoundControls() {
  syncSoundControls();
  missionSoundsOptionEls.forEach((opt) => {
    opt.addEventListener("click", () => {
      missionAudio.setEnabled(opt.dataset.sounds === "on");
      syncSoundControls();
    });
  });
  soundToggleBtn.addEventListener("click", () => {
    missionAudio.setEnabled(!missionAudio.isEnabled());
    syncSoundControls();
  });
  welcomeSoundToggleBtn.addEventListener("click", () => {
    const nowOn = !missionAudio.isEnabled();
    missionAudio.setEnabled(nowOn);
    if (!nowOn) brandAudio.stopIntro();
    syncSoundControls();
  });
}

// --- Global UI click feedback --------------------------------------------
//
// One delegated listener at the document root, rather than manually
// wiring brandAudio.playClick() into every individual handler across
// Welcome/Setup/Live/Result. An element is eligible if it (or the
// nearest ancestor matching the selector) is a real <button>, carries
// role="button", or opts in via data-ui-sound="click" (used for the
// Room Setup <summary>, which is natively clickable but isn't a button
// element) — and it stays eligible unless it or an ancestor explicitly
// opts out via data-ui-sound="off" (used by the dev measurement tool).
//
// event.isTrusted excludes any programmatic .click() call from ever
// producing sound — only genuine pointer/keyboard activation counts.
// Using the "click" event (not keydown) is what makes Enter/Space
// keyboard activation of a real button produce exactly one sound: the
// browser already synthesizes a single trusted click for that natively,
// so there is nothing extra to wire up and nothing that could double-fire.
function isEligibleForUiSound(target) {
  const control = target.closest('button, [role="button"], [data-ui-sound="click"]');
  if (!control || control.disabled) return false;
  return !control.closest('[data-ui-sound="off"]');
}

function initUiClickFeedback() {
  document.addEventListener("click", (event) => {
    if (!event.isTrusted) return;
    if (!isEligibleForUiSound(event.target)) return;
    brandAudio.playClick();
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

// Single place that decides what Pause/End's Pause button looks like —
// driven by render() from state.status, not by the click handler, so the
// button always reflects the actual session state (e.g. after a resize or
// any other code path that changes status).
function setPauseButtonState(paused) {
  pauseIconEl.hidden = paused;
  playIconEl.hidden = !paused;
  pauseBtnLabelEl.textContent = paused ? "Resume" : "Pause";
}

// Updates the 3-star Mission Rating in place (dedupes on the star count,
// same pattern as the meter band above) — the soft fade/brightness
// transition lives in CSS, triggered by the .is-dim class change.
function renderMissionRating(stars, label) {
  missionRatingStarEls.forEach((starEl, i) => {
    starEl.classList.toggle("is-dim", i >= stars);
  });
  missionRatingLabelEl.textContent = label;
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

// Theme-driven result copy: a theme may supply its own headline/line pair
// (see rocket_theme.js) for a more specific end-state moment; any theme
// that doesn't (e.g. Dragon) falls back to a generic headline plus its
// existing successMessage/failMessage — same 2-line structure either way.
function showResult(result) {
  const theme = getTheme(selectedThemeId);
  const { peakWakeMeter, resultStreak } = getState();
  clearConfetti();
  if (result === "win") {
    screens.result.setAttribute("data-result", "win");
    resultTitleEl.textContent = theme?.resultWinTitle || "Mission Complete";
    resultLineEl.textContent = theme?.resultWinLine || theme?.successMessage || "Mission complete!";
    resultPrimaryBtn.textContent = "Play Again";
    const { stars } = getMissionRating(peakWakeMeter, false);
    resultRatingStarsEl.textContent = "★".repeat(stars) + "☆".repeat(3 - stars);
    resultRatingLabelEl.textContent = RESULT_WIN_RATING_LABELS[stars];
    resultStreakLabelEl.textContent = "🔥 Mission Streak";
    missionAudio.playSuccessSequence();
    spawnConfetti();
  } else {
    screens.result.setAttribute("data-result", "fail");
    resultTitleEl.textContent = theme?.resultFailTitle || "Mission Failed";
    resultLineEl.textContent = theme?.resultFailLine || theme?.failMessage || "Mission failed.";
    resultPrimaryBtn.textContent = "Try Again";
    resultRatingStarsEl.textContent = "☆☆☆";
    resultRatingLabelEl.textContent = "Mission Rating";
    resultStreakLabelEl.textContent = "🔥 Streak Lost";
  }
  // resultStreak is computed exactly once by session.js at the moment the
  // result locked — displayed here as-is, never recalculated.
  if (resultStreak) {
    resultStreakValueEl.textContent = `${resultStreak.previousStreak} → ${resultStreak.newStreak}`;
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
let lastRatingStars = null;

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
      } else if (state.status === "idle") {
        // "idle" is state.js's initial value and is never set again by
        // session.js after this — this branch runs exactly once, on the
        // very first render (a genuine fresh page load). Every later
        // return-to-setup goes through "ended" below instead, so Welcome
        // never reappears during normal classroom use.
        setActiveScreen("welcome");
      } else {
        // Manual End/abort (no result) — resolved win/fail sequences
        // already manage their own audio cleanup in showResult()/the
        // onFail chain below, so this only fires for a genuine abort.
        missionAudio.stopAll();
        setActiveScreen("setup");
      }
      setPauseButtonState(false);
      hudPausedBadgeEl.hidden = true;
    } else if (state.status === "micDenied") {
      setActiveScreen("denied");
    } else if ((state.status === "running" || state.status === "paused") && countdownActive) {
      // Synthetic startSession()->pauseSession() freeze while the visual
      // countdown runs (see runCountdown()/beginMission()) — the countdown
      // screen itself was already shown directly by beginMission(), so
      // there's nothing to do here except NOT mount the theme early.
    } else if (state.status === "running" || state.status === "paused") {
      setActiveScreen("session");
      setPauseButtonState(state.status === "paused");
      hudPausedBadgeEl.hidden = state.status !== "paused";
      missionAudio.setPaused(state.status === "paused");
      if (!activeTheme) {
        const theme = getTheme(selectedThemeId);
        if (theme) {
          activeTheme = theme;
          // Lets HUD chrome (see layout.css) apply theme-specific styling
          // — e.g. the Rocket Launch Energy instrument — without any
          // theme reaching into shared HUD DOM itself.
          screens.session.dataset.theme = theme.id;
          // Reads the Voice Level chosen at Start Mission time from the
          // single central state (no second source of truth) — same
          // element/copy for every theme, styled only via --mission-accent.
          const voiceInfo = VOICE_LEVELS[state.voiceLevel] || VOICE_LEVELS[0];
          hudVoiceLevelEl.textContent = `Voice ${voiceInfo.level} · ${voiceInfo.name}`;
          // Class Streak going INTO this mission — read once at mount, same
          // "set once at session start" pattern as the Voice Level chip.
          hudStreakChipEl.textContent = `🔥 ${getClassStreak()} Mission Streak`;
          lastRatingStars = null;
          renderMissionRating(3, LIVE_RATING_LABELS[3]);
          syncSoundControls();
          missionAudio.startMission();
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

    // Derived from peakWakeMeter (never the current wakeMeter) — a star
    // lost mid-mission never returns even if the room quiets back down.
    const { stars } = getMissionRating(state.peakWakeMeter, false);
    if (stars !== lastRatingStars) {
      lastRatingStars = stars;
      renderMissionRating(stars, LIVE_RATING_LABELS[stars]);
      missionAudio.onRatingChanged(stars);
    }

    // Continuous engine/critical-alarm intensity follows the CURRENT Wake
    // Meter (unlike the rating above, which follows peakWakeMeter) — audio
    // only observes this value, never writes it.
    missionAudio.updateEnergy(state.wakeMeter);

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

// --- Welcome -> Setup ------------------------------------------------------
//
// A pure one-time navigation event, not a session-lifecycle transition —
// deliberately does not touch state.js's status at all (Welcome isn't a
// mission concept). Fires exactly once per page load, from a real click,
// so brandAudio's click/transition sounds always satisfy autoplay policy.

const WELCOME_TRANSITION_MS = 260; // kept in sync with the CSS leave animation below

function dismissWelcome() {
  // playClick() is no longer called explicitly here — the global UI click
  // listener (see initUiClickFeedback() below) already covers this button
  // like every other one; calling it again here would double-play.
  brandAudio.playTransition();
  brandAudio.stopIntro(); // in case autoplay happened to succeed and it's still going
  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  screens.welcome.classList.add("screen-welcome--leaving");
  const delay = reduceMotion ? 0 : WELCOME_TRANSITION_MS;
  setTimeout(() => {
    screens.welcome.classList.remove("screen-welcome--leaving");
    screens.setup.classList.add("screen-setup--enter");
    setActiveScreen("setup");
    brandAudio.playMenuMusic(); // Welcome stays silent; Setup's atmosphere begins only now
    setTimeout(() => screens.setup.classList.remove("screen-setup--enter"), reduceMotion ? 0 : 400);
  }, delay);
}

welcomeStartBtn.addEventListener("click", dismissWelcome);

// --- How It Works modal ---------------------------------------------------

let howItWorksLastFocused = null;

function openHowItWorks() {
  howItWorksLastFocused = document.activeElement;
  howItWorksModal.hidden = false;
  howItWorksCloseBtn.focus();
  document.addEventListener("keydown", onHowItWorksKeydown);
}

function closeHowItWorks() {
  howItWorksModal.hidden = true;
  document.removeEventListener("keydown", onHowItWorksKeydown);
  if (howItWorksLastFocused && typeof howItWorksLastFocused.focus === "function") {
    howItWorksLastFocused.focus();
  }
}

function onHowItWorksKeydown(event) {
  if (event.key === "Escape") closeHowItWorks();
}

howItWorksBtn.addEventListener("click", openHowItWorks);
howItWorksCloseBtn.addEventListener("click", closeHowItWorks);
howItWorksGotItBtn.addEventListener("click", closeHowItWorks);
howItWorksModal.addEventListener("click", (event) => {
  if (event.target === howItWorksModal) closeHowItWorks(); // click on the backdrop itself
});

// --- Start / controls ----------------------------------------------------

// Countdown: 5-4-3-2-1, ~1s each (~5s total), driven purely by
// setTimeout — independent of any CSS animation duration, so the timing
// stays intact even under prefers-reduced-motion (which only zeroes the
// visual flourish via base.css's global override). Re-triggers the CSS
// opacity/scale keyframe per number by removing+reflowing+re-adding the
// element (a fresh element reference isn't needed just to restart a CSS
// animation on textContent change).
const COUNTDOWN_STEP_MS = 1000;
const COUNTDOWN_NUMBERS = [5, 4, 3, 2, 1];

function showCountdownNumber(n) {
  countdownNumberEl.textContent = String(n);
  countdownNumberEl.classList.remove("countdown-number--tick");
  void countdownNumberEl.offsetWidth; // force reflow so the animation restarts
  countdownNumberEl.classList.add("countdown-number--tick");
}

function runCountdown(onDone) {
  let i = 0;
  showCountdownNumber(COUNTDOWN_NUMBERS[i]);
  const step = () => {
    i += 1;
    if (i < COUNTDOWN_NUMBERS.length) {
      showCountdownNumber(COUNTDOWN_NUMBERS[i]);
      setTimeout(step, COUNTDOWN_STEP_MS);
    } else {
      // "1" has finished its ~1s display — the dong begins right as the
      // mission reveal starts (not before), so nothing plays underneath a
      // black screen for its own sake. onDone() flips countdownActive off
      // and resumes the frozen session immediately; the dong is left to
      // finish/fade on its own over that reveal (see brandAudio.playDong()).
      brandAudio.playDong();
      onDone();
    }
  };
  setTimeout(step, COUNTDOWN_STEP_MS);
}

function setMissionStartLocks(locked) {
  startBtn.disabled = locked;
  resultPrimaryBtn.disabled = locked;
}

// Both Start Mission and Play Again/Try Again route through this: start
// the mission (mic + full-duration state) immediately, freeze it via
// pauseSession() before any real time elapses, run the silent 5-4-3-2-1 +
// dong sequence on the new Countdown screen, then resume — so the mission
// timer only ever begins ticking from the FULL selected duration. Zero
// session.js changes: countdownActive (set before startSession(), so the
// very first "running" render is already suppressed) is what keeps
// render() from mounting the theme during the synthetic freeze.
async function beginMission() {
  if (missionStarting || countdownActive) return;
  missionStarting = true;
  countdownActive = true;
  setMissionStartLocks(true);

  const started = await startSession({
    durationSeconds: selectedDurationSeconds,
    voiceLevel: selectedVoiceLevel,
    // Audio reacts to the SAME onFail/onComplete chain the visual launch
    // sequence already uses — never a separate timer duplicating its
    // duration, never a call into rocket_renderer.js itself.
    onFail: () => {
      missionAudio.playFailSequence();
      activeTheme && activeTheme.triggerFailEvent(() => {
        missionAudio.stopFailSequence();
        reportFailEventFinished();
      });
    },
  });

  if (!started) {
    // Mic denied (or a genuine duplicate call) — render() already shows
    // the denied screen via its own unconditional status branch.
    countdownActive = false;
    missionStarting = false;
    setMissionStartLocks(false);
    return;
  }

  pauseSession(); // freezes remainingSeconds at the full duration for the countdown's duration
  brandAudio.stopMenuMusic(); // must be silent by the time the countdown is established
  setActiveScreen("countdown");
  runCountdown(() => {
    countdownActive = false;
    resumeSession(); // real countdown now begins ticking from the full duration
    missionStarting = false;
    setMissionStartLocks(false);
  });
}

startBtn.addEventListener("click", () => {
  if (calibrationInProgress) return; // never let a mission grab the mic mid-calibration
  missionAudio.unlock(); // must happen synchronously within this user gesture
  beginMission();
});

retryBtn.addEventListener("click", () => {
  retryMicPermission();
});

pauseBtn.addEventListener("click", () => {
  const { status, locked } = getState();
  if (locked) return;
  // Button label/icon is driven entirely by render() from state.status —
  // this handler only ever changes the session, never touches the DOM.
  if (status === "running") {
    pauseSession();
  } else if (status === "paused") {
    resumeSession();
  }
});

endBtn.addEventListener("click", () => {
  const { locked } = getState();
  if (locked) return;
  endSession();
  brandAudio.playMenuMusic(); // returning to Setup — same cached/looping track, never a second instance
});

// Play Again / Try Again: restart the same mission/voice level/duration
// without sending the teacher back through setup — routes through the
// same countdown as Start Mission, but must NOT play Setup music.
// selectedThemeId/selectedVoiceLevel/selectedDurationSeconds are untouched
// by endSession() or showResult(), so beginMission() naturally reuses them.
resultPrimaryBtn.addEventListener("click", () => {
  if (missionStarting || countdownActive) return; // duplicate/rapid-click guard
  missionAudio.unlock();
  endSession();
  beginMission();
});

// Choose New Mission: existing "return to setup" behavior — setup still
// shows the previous selections since nothing resets them.
resultSecondaryBtn.addEventListener("click", () => {
  endSession();
  brandAudio.playMenuMusic();
});

renderThemePicker();
initVoiceLevelPicker();
initDurationPicker();
initCalibrationUI();
initSoundControls();
initUiClickFeedback();
subscribe(render);
render(getState());
// Best-effort only — browsers will very likely block this before any user
// gesture; brandAudio handles that silently (see tryPlayIntro()).
brandAudio.tryPlayIntro();

// --- Development-only diagnostics (no visible UI) --------------------
//
// qcDebugSetWakeMeter(value): directly pokes the Wake Meter for a quick
// visual preview. The next real audio frame will keep pulling it toward
// whatever actual mic input dictates — for a stable look, call this and
// then stay quiet for a few seconds.
// qcDebugForceFail(): drives the SAME fail-resolution code path
// handleLevel() takes at wakeMeter>=100 (session.js), for QA without
// needing genuinely loud mic input. Development-only.
window.qcDebugForceFail = () => qcDebugForceFail();

window.qcDebugSetWakeMeter = (value) => {
  const state = getState();
  if (state.status !== "running" && state.status !== "paused") {
    console.warn("QuietClass debug: no active mission to preview against.");
    return;
  }
  const clamped = Math.max(0, Math.min(100, Number(value)));
  // Keeps peakWakeMeter (rating.js's input) consistent with a manually
  // previewed value — matches what a real session tick would do.
  setState({ wakeMeter: clamped, peakWakeMeter: Math.max(state.peakWakeMeter, clamped) });
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

// qcDebugOpenMeasurementTool(): opens a TEMPORARY developer-only floating
// panel that samples the existing smoothed mic level (audio.js, unmodified)
// across fixed classroom-noise scenarios, to collect real numbers for
// future Voice Level LEVEL_DELTAS tuning. Dynamically imported so it adds
// nothing to the normal load path unless explicitly opened. Never linked
// from teacher-facing UI; the tool itself refuses to run during a mission.
window.qcDebugOpenMeasurementTool = () => {
  import("../dev/voiceLevelMeasurementTool.js").then((mod) => mod.openMeasurementTool());
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
