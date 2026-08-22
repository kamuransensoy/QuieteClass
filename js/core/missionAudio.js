// missionAudio.js
// Dedicated mission-PLAYBACK controller — entirely separate from audio.js
// (which owns microphone INPUT and must stay untouched). This module only
// ever reacts to gameplay state already produced elsewhere (Wake Meter,
// Mission Rating, pause/resume, win/fail); it never influences the Wake
// Meter, the noise classifier, Mission Rating, or Class Streak.
//
// Native <audio> elements only — no Web Audio graph, no dependency. Every
// element is created once and reused; nothing is ever created per frame.

// Centralized per-theme sound config. Keeping this shape (rather than
// scattering filenames through app.js/session.js) is what lets a future
// theme (assets/audio/dragon/, assets/audio/weather/) plug in its own set
// without any core session/audio logic changing.
const ROCKET_AUDIO = {
  ambience: "assets/audio/rocket/control-room-ambient-rumble.mp3",
  engine: "assets/audio/rocket/rocket-thruster-rumble-loop.mp3",
  warning1: "assets/audio/rocket/sci-fi-interface-beep-subtle.mp3",
  warning2: "assets/audio/rocket/sci-fi-alert-short.mp3",
  critical: "assets/audio/rocket/sci-fi-proximity-alarm-soft.mp3",
  fail: "assets/audio/rocket/space-shuttle-launch-ignition.mp3",
  success: "assets/audio/rocket/cinematic-success-chime.mp3",
};

// Single centralized output lever — every sound's final volume is
// (per-sound target) * MASTER_VOLUME. Individual targets below are already
// tuned conservative (classroom-safe); MASTER_VOLUME exists so the whole
// mix can be pulled down (or, once real classroom testing is done, tuned
// up) from exactly one place rather than editing scattered numbers.
const MASTER_VOLUME = 1.0;

// Conservative starting references (see the sprint brief) — not sacred,
// tune here only.
const AMBIENCE_TARGET_VOLUME = 0.06;
// Piecewise reference curve for engine volume vs. current Wake Meter %.
// Interpolated linearly between points, then further eased by the
// smoothing loop below — avoids both hard steps and a single misleading
// "linear the whole way" curve.
const ENGINE_CURVE = [
  [0, 0], [55, 0], [60, 0.03], [70, 0.07], [80, 0.12], [90, 0.18], [99, 0.24], [100, 0.24],
];
const CRITICAL_MIN_PCT = 90;
const CRITICAL_MAX_PCT = 99;
const CRITICAL_MIN_VOLUME = 0.02;
const CRITICAL_MAX_VOLUME = 0.10; // deliberately below the engine's peak (0.24)
const WARNING1_VOLUME = 0.18;
const WARNING2_VOLUME = 0.22;
const SUCCESS_VOLUME = 0.35;
const FAIL_VOLUME = 0.3;

const SMOOTH_FACTOR = 0.06; // per-frame ease toward target, same EMA shape as audio.js's own mic smoothing
const SETTLE_EPSILON = 0.002;
const FAIL_FADE_OUT_MS = 350;
const QUICK_FADE_MS = 220; // critical/engine transition when a fail begins

const ENABLED_STORAGE_KEY = "quietclass.missionSoundsEnabled";

let sounds = null; // { ambience, engine, critical, warning1, warning2, fail, success } HTMLAudioElement
let unlocked = false;
let enabled = true;
let paused = false;
let lastWakeMeter = 0;
let warning1Played = false;
let warning2Played = false;
let smoothRafId = null;
let failFadeRafId = null;

const targets = { ambience: 0, engine: 0, critical: 0 };
const current = { ambience: 0, engine: 0, critical: 0 };

function readEnabledPreference() {
  try {
    const raw = localStorage.getItem(ENABLED_STORAGE_KEY);
    if (raw === "true") return true;
    if (raw === "false") return false;
    return true; // default ON; also covers missing/invalid values
  } catch {
    return true;
  }
}

function writeEnabledPreference(value) {
  try {
    localStorage.setItem(ENABLED_STORAGE_KEY, value ? "true" : "false");
  } catch {
    // Non-fatal: preference simply won't persist in this context.
  }
}

enabled = readEnabledPreference();

function createElement(src, { loop = false } = {}) {
  const el = new Audio(src);
  el.loop = loop;
  el.preload = "auto";
  el.volume = 0;
  // Audio is an enhancement — a failed decode/network load must never
  // block or break the mission.
  el.addEventListener("error", () => {
    console.warn(`QuietClass mission audio: failed to load "${src}" — continuing without it.`);
  });
  return el;
}

function ensureSounds() {
  if (sounds) return sounds;
  sounds = {
    ambience: createElement(ROCKET_AUDIO.ambience, { loop: true }),
    engine: createElement(ROCKET_AUDIO.engine, { loop: true }),
    critical: createElement(ROCKET_AUDIO.critical, { loop: true }),
    warning1: createElement(ROCKET_AUDIO.warning1),
    warning2: createElement(ROCKET_AUDIO.warning2),
    fail: createElement(ROCKET_AUDIO.fail),
    success: createElement(ROCKET_AUDIO.success),
  };
  return sounds;
}

function safePlay(el) {
  if (!el) return;
  const p = el.play();
  if (p && typeof p.catch === "function") {
    p.catch(() => {
      // Autoplay rejection or transient decode issue — never surfaced as
      // an app error; the mission continues silently for this sound.
    });
  }
}

function safePause(el) {
  if (!el) return;
  try {
    el.pause();
  } catch {
    // Ignore — element may already be in a state where pause() throws in
    // some engines (e.g. never successfully started).
  }
}

// --- Continuous sound smoothing (ambience/engine/critical) --------------

function engineVolumeForPct(pct) {
  const curve = ENGINE_CURVE;
  if (pct <= curve[0][0]) return curve[0][1];
  for (let i = 1; i < curve.length; i++) {
    const [px, pv] = curve[i - 1];
    const [x, v] = curve[i];
    if (pct <= x) {
      const t = x === px ? 0 : (pct - px) / (x - px);
      return pv + (v - pv) * t;
    }
  }
  return curve[curve.length - 1][1];
}

function criticalVolumeForPct(pct) {
  if (pct < CRITICAL_MIN_PCT) return 0;
  const clamped = Math.min(CRITICAL_MAX_PCT, pct);
  const t = (clamped - CRITICAL_MIN_PCT) / (CRITICAL_MAX_PCT - CRITICAL_MIN_PCT);
  return CRITICAL_MIN_VOLUME + (CRITICAL_MAX_VOLUME - CRITICAL_MIN_VOLUME) * t;
}

function recomputeContinuousTargets() {
  if (!enabled || paused) {
    targets.ambience = 0;
    targets.engine = 0;
    targets.critical = 0;
  } else {
    targets.ambience = AMBIENCE_TARGET_VOLUME;
    targets.engine = engineVolumeForPct(lastWakeMeter);
    targets.critical = criticalVolumeForPct(lastWakeMeter);
  }
  ensureSmoothLoop();
}

function ensureSmoothLoop() {
  if (smoothRafId !== null || !sounds) return;
  const step = () => {
    let stillMoving = false;
    for (const key of ["ambience", "engine", "critical"]) {
      const el = sounds[key];
      const target = targets[key];
      let value = current[key];
      const diff = target - value;
      if (Math.abs(diff) > SETTLE_EPSILON) {
        value += diff * SMOOTH_FACTOR;
        stillMoving = true;
      } else {
        value = target;
      }
      current[key] = value;
      const outputVolume = Math.max(0, Math.min(1, value * MASTER_VOLUME));
      el.volume = outputVolume;
      if (outputVolume > SETTLE_EPSILON) {
        if (el.paused) safePlay(el);
      } else if (!el.paused) {
        safePause(el);
      }
    }
    smoothRafId = stillMoving ? requestAnimationFrame(step) : null;
  };
  smoothRafId = requestAnimationFrame(step);
}

// --- One-shot fade helper (used for the long fail/ignition clip) --------

function fadeOutAndStop(el, ms) {
  if (!el || el.paused) return;
  if (failFadeRafId !== null) {
    cancelAnimationFrame(failFadeRafId);
    failFadeRafId = null;
  }
  const startVolume = el.volume;
  const startTime = performance.now();
  if (startVolume <= 0 || ms <= 0) {
    safePause(el);
    return;
  }
  const step = (now) => {
    const t = Math.min(1, (now - startTime) / ms);
    el.volume = Math.max(0, startVolume * (1 - t));
    if (t >= 1) {
      safePause(el);
      failFadeRafId = null;
    } else {
      failFadeRafId = requestAnimationFrame(step);
    }
  };
  failFadeRafId = requestAnimationFrame(step);
}

// --- Public API -----------------------------------------------------------

/**
 * Must be called synchronously from within the Start Mission / Play Again
 * click handler (a genuine user gesture) — primes every element so later
 * programmatic play()/volume changes aren't blocked by autoplay policy.
 * Idempotent; safe to call every time.
 */
export function unlock() {
  const s = ensureSounds();
  if (unlocked) return;
  unlocked = true;
  Object.values(s).forEach((el) => {
    try {
      const p = el.play();
      if (p && typeof p.catch === "function") {
        p.then(() => {
          el.pause();
          el.currentTime = 0;
        }).catch(() => {});
      } else {
        el.pause();
      }
    } catch {
      // Enhancement only — a failed unlock attempt never blocks the mission.
    }
  });
}

/** Call exactly once per mission, at mount time. Resets per-mission guards and fades ambience in. */
export function startMission() {
  ensureSounds();
  paused = false;
  warning1Played = false;
  warning2Played = false;
  lastWakeMeter = 0;
  current.ambience = 0;
  current.engine = 0;
  current.critical = 0;
  recomputeContinuousTargets();
}

/** Call every tick with the CURRENT Wake Meter (0-100). Updates targets only — cheap, no-op if unchanged. */
export function updateEnergy(wakeMeter) {
  if (Math.abs(wakeMeter - lastWakeMeter) < 0.05) return;
  lastWakeMeter = wakeMeter;
  recomputeContinuousTargets();
}

/**
 * Call whenever the live Mission Rating star count changes. Fires the
 * appropriate warning one-shot exactly once per mission — guarded
 * internally, so repeated calls (or a rating that jumps straight from 3
 * to 1 stars) can never replay a warning that already happened.
 */
export function onRatingChanged(stars) {
  if (stars <= 2 && !warning1Played) {
    warning1Played = true;
    if (enabled && !paused) playOneShot("warning1", WARNING1_VOLUME);
  }
  if (stars <= 1 && !warning2Played) {
    warning2Played = true;
    if (enabled && !paused) playOneShot("warning2", WARNING2_VOLUME);
  }
}

function playOneShot(key, volume) {
  const s = ensureSounds();
  const el = s[key];
  if (!el) return;
  el.currentTime = 0;
  el.volume = Math.max(0, Math.min(1, volume * MASTER_VOLUME));
  safePlay(el);
}

/** Call at the exact instant the mission fails (Wake Meter reaches 100) — before the visual launch sequence's onComplete. */
export function playFailSequence() {
  const s = ensureSounds();
  paused = false;
  targets.ambience = 0;
  targets.engine = 0;
  targets.critical = 0;
  ensureSmoothLoop();
  // Quick, not instant — an abrupt cut reads as glitchy under a launch.
  [s.engine, s.critical].forEach((el) => fadeOutAndStop(el, QUICK_FADE_MS));
  if (!enabled) return;
  s.fail.currentTime = 0;
  s.fail.volume = Math.max(0, Math.min(1, FAIL_VOLUME * MASTER_VOLUME));
  safePlay(s.fail);
}

/** Call from the SAME onComplete the visual launch sequence already reports through — never a separate timer duplicating its duration. */
export function stopFailSequence() {
  if (!sounds) return;
  fadeOutAndStop(sounds.fail, FAIL_FADE_OUT_MS);
}

/** Call once when a win result is shown. */
export function playSuccessSequence() {
  const s = ensureSounds();
  targets.ambience = 0;
  targets.engine = 0;
  targets.critical = 0;
  ensureSmoothLoop();
  [s.ambience, s.engine, s.critical].forEach((el) => fadeOutAndStop(el, FAIL_FADE_OUT_MS));
  if (!enabled) return;
  s.success.currentTime = 0;
  s.success.volume = Math.max(0, Math.min(1, SUCCESS_VOLUME * MASTER_VOLUME));
  safePlay(s.success);
}

/** Mirrors the existing Pause/Resume — never replays warning one-shots. */
export function setPaused(isPaused) {
  if (paused === isPaused) return;
  paused = isPaused;
  recomputeContinuousTargets();
}

/** Hard stop for End / manual abort. No success/fail sound, no orphaned playback. */
export function stopAll() {
  if (failFadeRafId !== null) {
    cancelAnimationFrame(failFadeRafId);
    failFadeRafId = null;
  }
  targets.ambience = 0;
  targets.engine = 0;
  targets.critical = 0;
  current.ambience = 0;
  current.engine = 0;
  current.critical = 0;
  if (sounds) {
    Object.values(sounds).forEach((el) => {
      safePause(el);
      el.volume = 0;
    });
  }
}

export function isEnabled() {
  return enabled;
}

/** Persists the preference and immediately applies it to any in-progress mission — a single shared setting, never two independent mute states. */
export function setEnabled(value) {
  enabled = Boolean(value);
  writeEnabledPreference(enabled);
  recomputeContinuousTargets();
}

/**
 * Development-only, read-only: snapshot of every internal audio value for
 * diagnosing behavior without guessing from console silence. Same
 * "development-only diagnostics" pattern as app.js's window.qcDebugStatus.
 * Changes nothing.
 */
export function qcDebugAudioStatus() {
  return {
    enabled,
    unlocked,
    paused,
    lastWakeMeter,
    warning1Played,
    warning2Played,
    targets: { ...targets },
    current: { ...current },
    playing: sounds
      ? Object.fromEntries(Object.entries(sounds).map(([k, el]) => [k, { playing: !el.paused, volume: Number(el.volume.toFixed(4)) }]))
      : null,
  };
}
