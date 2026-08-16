// session.js
// Owns mission lifecycle: countdown timing, Wake Meter accumulation, and
// win/fail determination. Requests the microphone only when a mission
// starts. This module has NO knowledge of any theme's visuals — it only
// produces the Wake Meter (0-100), the single progress signal every
// theme receives via its updateProgress(wakeMeter) contract method.
//
// Raw noise classification (noiseState.js) still runs here because it
// drives Wake Meter velocity, but it is never forwarded to a theme
// directly. See reportFailEventFinished() for how a FAIL result is
// finalized only after the active theme's fail event has actually
// finished playing — session.js doesn't know or care what that event
// looks like, only that the theme reports back when it's done.
//
// Sprint 5.1: the classifier is now created with a config derived from
// room calibration + sensitivity (see calibration.js's
// getClassifierConfig()), instead of transforming every raw mic sample.
// Calibration only ever shifts WHERE the classifier's thresholds sit —
// classifier.update() below always receives the completely raw,
// unmodified mic level, every frame, whether calibrated or not.
// Uncalibrated sessions get noiseState.js's own untouched default
// config, so that behavior is unchanged from before calibration existed.

import { startAudio, stopAudio } from "./audio.js";
import { createNoiseClassifier } from "./noiseState.js";
import { integrateWakeMeter } from "./wakeMeter.js";
import { getClassifierConfig } from "./calibration.js";
import { setState, getState } from "./state.js";

const MAX_TICK_DT_MS = 250; // clamp: protect against large gaps (tab suspend, laptop sleep)

let classifier = null;
let isStarting = false;    // guards against duplicate concurrent start calls (e.g. double-click)
let resultLocked = false;  // true once win/fail has been decided for this mission
let lastTickTime = 0;      // performance.now() at the previous "running" tick
let onFail = null;         // callback: notify app.js to trigger the active theme's fail event

/**
 * @param {object} [opts]
 * @param {number} [opts.durationSeconds] - selected mission length; defaults to the last-selected duration
 * @param {() => void} [opts.onFail] - called once when the Wake Meter reaches 100
 * @returns {Promise<boolean>} true if mic granted and the mission started.
 */
export async function startSession({ durationSeconds, onFail: failCb } = {}) {
  const { status } = getState();
  if (isStarting || status === "running" || status === "paused") return false;
  isStarting = true;

  onFail = failCb || null;
  classifier = createNoiseClassifier(getClassifierConfig());
  resultLocked = false;

  try {
    const granted = await startAudio(handleLevel);
    if (!granted) {
      setState({ status: "micDenied" });
      return false;
    }

    const duration = durationSeconds || getState().selectedDurationSeconds;
    lastTickTime = performance.now();
    setState({
      status: "running",
      result: null,
      locked: false,
      wakeMeter: 0,
      noiseLevel: 0,
      noiseState: "CALM",
      selectedDurationSeconds: duration,
      remainingSeconds: duration,
    });
    return true;
  } finally {
    isStarting = false;
  }
}

// Runs once per audio frame while a mission is active. Computes a
// drift-resistant dt from timestamps (not a frame-count assumption),
// integrates the Wake Meter and countdown by that dt, and resolves
// win/fail deterministically: Wake Meter reaching 100 is checked before
// the countdown deadline, so a same-tick tie always resolves as FAIL.
function handleLevel(level) {
  const state = getState();
  if (state.status !== "running" || resultLocked) return; // paused, ended, or already decided

  const now = performance.now();
  const dtSeconds = Math.min(now - lastTickTime, MAX_TICK_DT_MS) / 1000;
  lastTickTime = now;

  const { state: noiseState } = classifier.update(level);
  const wakeMeter = integrateWakeMeter(state.wakeMeter, noiseState, dtSeconds);
  const remainingSeconds = Math.max(0, state.remainingSeconds - dtSeconds);

  if (wakeMeter >= 100) {
    resultLocked = true;
    setState({ noiseLevel: level, noiseState, wakeMeter: 100, locked: true });
    stopAudio();
    if (onFail) onFail();
    return;
  }

  if (remainingSeconds <= 0) {
    resultLocked = true;
    setState({
      noiseLevel: level, noiseState, wakeMeter, remainingSeconds: 0,
      locked: true, status: "ended", result: "win",
    });
    stopAudio();
    return;
  }

  setState({ noiseLevel: level, noiseState, wakeMeter, remainingSeconds });
}

export function pauseSession() {
  const { status, locked } = getState();
  if (status !== "running" || locked) return;
  setState({ status: "paused" });
}

export function resumeSession() {
  const { status, locked } = getState();
  if (status !== "paused" || locked) return;
  lastTickTime = performance.now(); // don't count the paused duration as elapsed
  setState({ status: "running" });
}

/** Manual abort (or "New Mission"/"Try Again"): stops everything and returns to a clean, unresolved state. */
export function endSession() {
  stopAudio();
  classifier = null;
  resultLocked = true;
  setState({
    status: "ended",
    result: null,
    locked: false,
    wakeMeter: 0,
    noiseLevel: 0,
    noiseState: "CALM",
    remainingSeconds: getState().selectedDurationSeconds,
  });
}

/**
 * Called by app.js once the active theme's fail event has actually
 * finished playing (via the theme's triggerFailEvent(onComplete) hook) —
 * this is what makes the FAIL overlay appear after the event completes
 * rather than over it, for any theme, without session.js knowing what
 * that event looks like.
 */
export function reportFailEventFinished() {
  setState({ status: "ended", result: "fail" });
}

/** Re-requests microphone access after a prior denial, reusing the same duration/callback. */
export function retryMicPermission() {
  return startSession({ durationSeconds: getState().selectedDurationSeconds, onFail });
}
