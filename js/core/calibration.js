// calibration.js
// Owns room calibration and teacher sensitivity. Measures what a room's
// normal independent-work volume sounds like, and (combined with a
// sensitivity setting) derives a set of classifier THRESHOLDS for that
// room — rather than transforming every raw microphone sample.
//
// noiseState.js's createNoiseClassifier(config) already accepts a full
// config object (thresholds/hysteresisMargin/criticalResolveDwellSeconds)
// — that parameterization already existed and needed no changes. This
// module produces a config shaped exactly like noiseState.js's own
// NOISE_CONFIG, with thresholds derived via deriveThresholds() below in
// BOTH the calibrated and uncalibrated case (anchored at the measured
// room baseline, or at 0 when there isn't one) — so Sensitivity has an
// effect either way, not just after calibrating. session.js creates the
// classifier with that config ONCE per mission and then feeds it raw,
// unmodified mic levels for the rest of the session — calibration is a
// one-time adaptation of "what counts as loud," not a per-frame
// transform of the signal itself.
//
// Reuses audio.js's existing capture path for sampling — this module
// does not duplicate microphone access or processing logic. audio.js is
// untouched.

import { startAudio, stopAudio } from "./audio.js";
import { NOISE_CONFIG } from "./noiseState.js";

const STORAGE_KEY = "quietclass.calibration.v1";
const SAMPLE_DURATION_MS = 4500; // ~4-5s of samples, per product spec

// Sensitivity: a 0-100% teacher-facing dial for how much the gap between
// the room baseline and each classifier threshold gets stretched or
// compressed (see deriveThresholds below). Higher % = more reactive
// (thresholds compress closer to baseline); lower % = more forgiving
// (thresholds stretch further above baseline).
export const SENSITIVITY_MIN_PERCENT = 0;
export const SENSITIVITY_MAX_PERCENT = 100;
export const SENSITIVITY_STEP_PERCENT = 5;
export const DEFAULT_SENSITIVITY_PERCENT = 65;

// Linear interpolation from 1.40x (0%, most forgiving) down to 0.45x
// (100%, most reactive). Chosen to land close to the product's target
// mapping (0%→1.40, 25%→~1.15, 50%→~0.90, 65%→~0.75, 75%→~0.65,
// 100%→0.45) without a piecewise/lookup table.
const FACTOR_AT_MIN_PERCENT = 1.40;
const FACTOR_AT_MAX_PERCENT = 0.45;

export function sensitivityPercentToFactor(percent) {
  const clamped = Math.max(SENSITIVITY_MIN_PERCENT, Math.min(SENSITIVITY_MAX_PERCENT, percent));
  const t = clamped / SENSITIVITY_MAX_PERCENT;
  return FACTOR_AT_MIN_PERCENT + (FACTOR_AT_MAX_PERCENT - FACTOR_AT_MIN_PERCENT) * t;
}

function normalizeSensitivityPercent(value) {
  if (typeof value !== "number" || Number.isNaN(value)) return DEFAULT_SENSITIVITY_PERCENT;
  const stepped = Math.round(value / SENSITIVITY_STEP_PERCENT) * SENSITIVITY_STEP_PERCENT;
  return Math.max(SENSITIVITY_MIN_PERCENT, Math.min(SENSITIVITY_MAX_PERCENT, stepped));
}

// Safe bounds for derived thresholds, and the minimum gap enforced
// between adjacent thresholds so LOW < MEDIUM < HIGH < CRITICAL always
// holds even at extreme baseline/sensitivity combinations.
const MIN_THRESHOLD = 0.05;
const MAX_THRESHOLD = 0.97;
const MIN_GAP = 0.03;

// The default (uncalibrated) thresholds double as "how much louder than
// near-silence it normally takes to reach this state" — the deltas a
// calibrated config re-anchors above the measured room baseline.
const BASE_DELTAS = { ...NOISE_CONFIG.thresholds };

let calibration = null; // { baseline, calibratedAt } | null
let sensitivityPercent = DEFAULT_SENSITIVITY_PERCENT;

function loadFromStorage() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw);
    if (typeof parsed.baseline === "number") {
      calibration = { baseline: parsed.baseline, calibratedAt: parsed.calibratedAt || null };
    }
    // sensitivityPercent supersedes the old 3-step "sensitivity" index
    // (0/1/2) from before percentage-based sensitivity — that old field
    // is intentionally ignored rather than reinterpreted as a percent.
    if (typeof parsed.sensitivityPercent === "number") {
      sensitivityPercent = normalizeSensitivityPercent(parsed.sensitivityPercent);
    }
  } catch (err) {
    calibration = null; // corrupt/unavailable storage: fall back to uncalibrated, never throw
  }
}

function saveToStorage() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      baseline: calibration ? calibration.baseline : null,
      calibratedAt: calibration ? calibration.calibratedAt : null,
      sensitivityPercent,
    }));
  } catch (err) {
    // localStorage unavailable (private mode, quota, disabled, etc.) —
    // calibration/sensitivity still work for the current page session,
    // they just won't survive a reload. Never throw.
  }
}

loadFromStorage();

export function getCalibrationState() {
  return {
    calibrated: calibration !== null,
    baseline: calibration ? calibration.baseline : null,
    calibratedAt: calibration ? calibration.calibratedAt : null,
    sensitivityPercent,
  };
}

export function setSensitivity(percent) {
  sensitivityPercent = normalizeSensitivityPercent(percent);
  saveToStorage();
  return getCalibrationState();
}

export function clearCalibration() {
  calibration = null;
  saveToStorage();
}

/**
 * Samples the microphone for SAMPLE_DURATION_MS and stores the MEDIAN
 * sampled level as the room baseline. Median (not mean/max) is used
 * specifically so a brief spike — a cough, a dropped pencil, a chair
 * scrape — can't dominate the result: it just becomes one high outlier
 * among many normal-volume samples and gets out-voted by the middle of
 * the distribution.
 * @param {(secondsRemaining: number) => void} [onTick] - fires ~4x/sec for a countdown UI.
 * @returns {Promise<{ok: boolean, baseline?: number}>}
 */
export async function runCalibration(onTick) {
  const samples = [];
  const granted = await startAudio((level) => samples.push(level));
  if (!granted) return { ok: false };

  await new Promise((resolve) => {
    const startTime = performance.now();
    const interval = setInterval(() => {
      const elapsedMs = performance.now() - startTime;
      if (onTick) onTick(Math.max(0, Math.ceil((SAMPLE_DURATION_MS - elapsedMs) / 1000)));
      if (elapsedMs >= SAMPLE_DURATION_MS) {
        clearInterval(interval);
        resolve();
      }
    }, 250);
  });

  stopAudio();

  if (samples.length === 0) return { ok: false };
  const sorted = [...samples].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];

  calibration = { baseline: median, calibratedAt: Date.now() };
  saveToStorage();
  return { ok: true, baseline: median };
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

/**
 * Derives classifier thresholds for a calibrated room:
 *
 *   derivedThreshold = baseline + defaultThreshold * sensitivityFactor
 *
 * Each default threshold is re-anchored above the room's measured
 * baseline and scaled by the sensitivity factor. A larger factor (low
 * sensitivity %, up to 1.40x at 0%) stretches every gap above baseline,
 * so it takes MORE noise above the room's normal volume to escalate. A
 * smaller factor (high sensitivity %, down to 0.45x at 100%) compresses
 * those gaps, so it takes LESS.
 *
 * Each derived value is clamped to [MIN_THRESHOLD, MAX_THRESHOLD], then
 * the four are forced into strict ascending order with at least MIN_GAP
 * between neighbors. This only actually changes anything at extreme
 * baseline/sensitivity combinations near the top of the scale, where
 * independent clamping alone could otherwise let two thresholds collide.
 */
export function deriveThresholds(baseline, factor) {
  let low = clamp(baseline + BASE_DELTAS.LOW * factor, MIN_THRESHOLD, MAX_THRESHOLD);
  let medium = clamp(baseline + BASE_DELTAS.MEDIUM * factor, MIN_THRESHOLD, MAX_THRESHOLD);
  let high = clamp(baseline + BASE_DELTAS.HIGH * factor, MIN_THRESHOLD, MAX_THRESHOLD);
  let critical = clamp(baseline + BASE_DELTAS.CRITICAL * factor, MIN_THRESHOLD, MAX_THRESHOLD);

  medium = Math.max(medium, low + MIN_GAP);
  high = Math.max(high, medium + MIN_GAP);
  critical = Math.max(critical, high + MIN_GAP);

  if (critical > MAX_THRESHOLD) {
    critical = MAX_THRESHOLD;
    high = Math.min(high, critical - MIN_GAP);
    medium = Math.min(medium, high - MIN_GAP);
    low = Math.min(low, medium - MIN_GAP);
  }

  return { LOW: low, MEDIUM: medium, HIGH: high, CRITICAL: critical };
}

/**
 * Returns a config object shaped exactly like noiseState.js's
 * NOISE_CONFIG, ready to pass straight into createNoiseClassifier().
 *
 * Thresholds always go through deriveThresholds() below, anchored at the
 * calibrated room baseline when one exists, or at 0 (no measured floor)
 * when it doesn't — so Sensitivity applies whether or not the room has
 * been calibrated, per product requirement ("Sensitivity should remain
 * useful even when calibration is skipped").
 *
 * hysteresisMargin and criticalResolveDwellSeconds are left exactly as
 * noiseState.js defines them in every case — calibration/sensitivity only
 * ever change WHERE the thresholds sit, never the classifier's
 * anti-flicker/debounce behavior.
 */
export function getClassifierConfig() {
  const factor = sensitivityPercentToFactor(sensitivityPercent);
  const baseline = calibration ? calibration.baseline : 0;
  return {
    thresholds: deriveThresholds(baseline, factor),
    hysteresisMargin: NOISE_CONFIG.hysteresisMargin,
    criticalResolveDwellSeconds: NOISE_CONFIG.criticalResolveDwellSeconds,
  };
}
