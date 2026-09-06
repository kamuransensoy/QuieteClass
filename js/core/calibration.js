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

// Voice Level (0-3, teacher-facing "how much talking is allowed") → a
// divisor applied to the sensitivity-scaled threshold gap in
// deriveThresholds() below. Voice 0 (least tolerant/most sensitive)
// shrinks the gap (divides by >1), so it takes LESS extra noise above
// baseline to escalate. Voice 3 (most tolerant) grows the gap (divides by
// <1). Voice 2 divides by exactly 1.00, reproducing the existing/default
// threshold behavior. Widened from the original 1.35/1.15/1.00/0.80 beta
// values — verified correct-but-too-weak (see the Voice Level investigation:
// the old full range moved thresholds ~2.4x less than Sensitivity's own
// full range) — so Voice Level alone is now a meaningfully distinct
// control, not something that only matters once Sensitivity is also
// touched. Magnitude only; the formula/architecture is unchanged.
export const VOICE_MULTIPLIERS = { 0: 1.75, 1: 1.30, 2: 1.00, 3: 0.60 };
const DEFAULT_VOICE_LEVEL = 2;

export function voiceLevelToMultiplier(level) {
  return VOICE_MULTIPLIERS[level] ?? VOICE_MULTIPLIERS[DEFAULT_VOICE_LEVEL];
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

function medianAndSpread(samples) {
  const sorted = [...samples].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
  const p10 = sorted[Math.floor(sorted.length * 0.1)];
  const p90 = sorted[Math.floor(sorted.length * 0.9)];
  return { median, spread: p90 - p10 };
}

// --- Lightweight automatic calibration -----------------------------------
// Runs once, silently, before the first mission of a page session — no
// teacher action, no "stay silent" modal, just a brief ambient sample
// using the same capture path as the manual flow above. Beta heuristics
// below (sample floor, stability ratio) are not tuned from real classroom
// data; they only decide whether a sample is trustworthy enough to save,
// never how the resulting threshold gap is scaled.
const AUTO_SAMPLE_MIN_MS = 3000;
const AUTO_SAMPLE_MAX_MS = 5000;
const AUTO_SAMPLE_POLL_MS = 250;
const AUTO_MIN_SAMPLE_COUNT = 20; // sanity floor only — a healthy 3s capture yields far more than this
const AUTO_MAX_RELATIVE_SPREAD = 0.6; // (p90-p10) / max(median, floor) — "has the ambient reading settled"

let autoCalibrationAttempted = false;

/** True once runAutoCalibration() has been attempted this page load (success or not) — it only ever runs once automatically; manual Recalibrate is the only other trigger. */
export function hasAttemptedAutoCalibration() {
  return autoCalibrationAttempted;
}

function isStable(samples) {
  if (samples.length < AUTO_MIN_SAMPLE_COUNT) return false;
  const { median, spread } = medianAndSpread(samples);
  return spread <= Math.max(median, 0.05) * AUTO_MAX_RELATIVE_SPREAD;
}

/**
 * Samples ambient mic input for AUTO_SAMPLE_MIN_MS, extending up to
 * AUTO_SAMPLE_MAX_MS if the reading hasn't settled yet. Only overwrites
 * the stored calibration if the final sample set is both large enough and
 * stable enough — an unreliable read never replaces a previously-good
 * calibration (or safe uncalibrated defaults), it simply leaves whatever
 * was already active untouched. Caller (app.js) is responsible for
 * ensuring no app music/effects are audible during this window and for
 * not calling this concurrently with a mission's own mic capture — this
 * function itself only ever runs startAudio()/stopAudio() sequentially,
 * fully awaited, so it can never overlap a mission's own capture.
 * @param {(status: "sampling"|"done") => void} [onStatus]
 * @returns {Promise<{ok: boolean, baseline?: number}>}
 */
export async function runAutoCalibration(onStatus) {
  autoCalibrationAttempted = true;
  const samples = [];
  const granted = await startAudio((level) => samples.push(level));
  if (!granted) return { ok: false };

  if (onStatus) onStatus("sampling");
  const startTime = performance.now();
  await new Promise((resolve) => {
    const check = () => {
      const elapsedMs = performance.now() - startTime;
      const pastMin = elapsedMs >= AUTO_SAMPLE_MIN_MS;
      const pastMax = elapsedMs >= AUTO_SAMPLE_MAX_MS;
      if (pastMax || (pastMin && isStable(samples))) {
        resolve();
      } else {
        setTimeout(check, AUTO_SAMPLE_POLL_MS);
      }
    };
    setTimeout(check, AUTO_SAMPLE_POLL_MS);
  });

  stopAudio();
  if (onStatus) onStatus("done");

  if (!isStable(samples)) return { ok: false }; // insufficient/unreliable — previous calibration (if any) stays active, nothing saved

  const { median } = medianAndSpread(samples);
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
 *   derivedThreshold = baseline + (defaultThreshold * sensitivityFactor) / voiceMultiplier
 *
 * baseline itself is never multiplied — only the gap above it is scaled.
 * Each default threshold is re-anchored above the room's measured
 * baseline and scaled by the sensitivity factor. A larger factor (low
 * sensitivity %, up to 1.40x at 0%) stretches every gap above baseline,
 * so it takes MORE noise above the room's normal volume to escalate. A
 * smaller factor (high sensitivity %, down to 0.45x at 100%) compresses
 * those gaps, so it takes LESS. voiceMultiplier applies the same shrink/
 * grow relationship for the selected Voice Level (see VOICE_MULTIPLIERS
 * above) — dividing by it, so Voice 0's 1.35 shrinks the gap (more
 * sensitive) and Voice 3's 0.80 grows it (more tolerant); Voice 2's 1.00
 * is a no-op, reproducing prior behavior exactly.
 *
 * Each derived value is clamped to [MIN_THRESHOLD, MAX_THRESHOLD], then
 * the four are forced into strict ascending order with at least MIN_GAP
 * between neighbors. This only actually changes anything at extreme
 * baseline/sensitivity/voice combinations near the top of the scale,
 * where independent clamping alone could otherwise let two thresholds
 * collide.
 */
export function deriveThresholds(baseline, factor, voiceMultiplier = 1) {
  const scale = factor / voiceMultiplier;
  let low = clamp(baseline + BASE_DELTAS.LOW * scale, MIN_THRESHOLD, MAX_THRESHOLD);
  let medium = clamp(baseline + BASE_DELTAS.MEDIUM * scale, MIN_THRESHOLD, MAX_THRESHOLD);
  let high = clamp(baseline + BASE_DELTAS.HIGH * scale, MIN_THRESHOLD, MAX_THRESHOLD);
  let critical = clamp(baseline + BASE_DELTAS.CRITICAL * scale, MIN_THRESHOLD, MAX_THRESHOLD);

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
 * noiseState.js defines them in every case — calibration/sensitivity/
 * Voice Level only ever change WHERE the thresholds sit, never the
 * classifier's anti-flicker/debounce behavior, and never the Wake Meter's
 * own integration rate (see wakeMeter.js, untouched).
 *
 * @param {number} [voiceLevel] - the selected Voice Level (0-3); defaults
 *   to 2 (no-op multiplier) for any caller that doesn't have one handy
 *   (e.g. a dev-only diagnostic snapshot) rather than throwing.
 */
export function getClassifierConfig(voiceLevel = DEFAULT_VOICE_LEVEL) {
  const factor = sensitivityPercentToFactor(sensitivityPercent);
  const baseline = calibration ? calibration.baseline : 0;
  const voiceMultiplier = voiceLevelToMultiplier(voiceLevel);
  return {
    thresholds: deriveThresholds(baseline, factor, voiceMultiplier),
    hysteresisMargin: NOISE_CONFIG.hysteresisMargin,
    criticalResolveDwellSeconds: NOISE_CONFIG.criticalResolveDwellSeconds,
  };
}
