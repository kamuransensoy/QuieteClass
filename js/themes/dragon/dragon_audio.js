// dragon/dragon_audio.js
// Dragon-specific mission-PLAYBACK controller — isolated from
// missionAudio.js (which stays Rocket-only; app.js gates its calls to the
// active theme) and entirely separate from audio.js (microphone INPUT,
// never touched by anything here). Reuses missionAudio.isEnabled() as the
// single Sound On/Off source of truth rather than a second mute state —
// see isEnabled() below — so there is still only one preference, just as
// there is still only one native-<audio>-element approach, matching
// missionAudio.js's own pattern rather than inventing a new one.

import * as missionAudio from "../../core/missionAudio.js";

const SRC = {
  sleeping: "assets/dragon/audio/dragon_sleeping.mp3",
  angry: "assets/dragon/audio/dragon_angry.mp3",
  fire: "assets/dragon/audio/dragon_fire.mp3",
};

// Wake Meter thresholds (0-99 scale, the same number this theme's
// updateProgress() already receives from core). Sleeping ambience covers
// the calm start of the timeline; angry is a one-shot fired once the class
// has clearly pushed the Dragon into its tense/high-wake range — well
// below the renderer's own 90-99 "final warning" tension zone (see
// dragon_renderer_frames.js TENSION_START), since angry is meant to read
// as an earlier, distinct beat from that last-moment glow.
const SLEEPING_MAX_PCT = 20;
const ANGRY_TRIGGER_PCT = 70; // crossing UP through this fires the one-shot
const ANGRY_REARM_PCT = 50;   // must fall back below this before it can fire again (hysteresis)

// Conservative, classroom-safe levels — sleeping ambience in particular
// must stay subtle (background, not foreground) per the sprint brief.
const SLEEPING_VOLUME = 0.05;
const ANGRY_VOLUME = 0.35;
const FIRE_VOLUME = 0.4;

const SLEEPING_FADE_MS = 800;
const SMOOTH_FACTOR = 1 - Math.pow(0.5, 16 / SLEEPING_FADE_MS); // same "ease per animation-frame" shape as missionAudio.js
const SETTLE_EPSILON = 0.002;

let sounds = null; // { sleeping, angry, fire } HTMLAudioElement
let mounted = false;
let paused = false;
let lastWakeMeter = 0;
let angryArmed = true;     // eligible to fire on the next upward crossing
let fireTriggered = false; // guards double-play within one fail event
let sleepingRafId = null;

const sleepingState = { current: 0, target: 0 };

function isEnabled() {
  return missionAudio.isEnabled();
}

function createElement(src, { loop = false } = {}) {
  const el = new Audio(src);
  el.loop = loop;
  el.preload = "auto";
  el.volume = 0;
  el.addEventListener("error", () => {
    console.warn(`QuietClass Dragon audio: failed to load "${src}" — continuing without it.`);
  });
  return el;
}

function ensureSounds() {
  if (sounds) return sounds;
  sounds = {
    sleeping: createElement(SRC.sleeping, { loop: true }),
    angry: createElement(SRC.angry),
    fire: createElement(SRC.fire),
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
    // Ignore — element may already be in a state where pause() throws.
  }
}

// --- Sleeping ambience: smooth volume-only crossfade, never restarted ----
// Once started, the element is left playing for the rest of the mission —
// only .volume moves. This is what makes "do not repeatedly restart it as
// Wake Level fluctuates" true by construction: there is no stop/seek/replay
// path for this element outside of full mission teardown.

function recomputeSleepingTarget() {
  if (!mounted || paused || !isEnabled()) {
    sleepingState.target = 0;
  } else {
    sleepingState.target = lastWakeMeter <= SLEEPING_MAX_PCT ? SLEEPING_VOLUME : 0;
  }
  ensureSleepingLoop();
}

function ensureSleepingLoop() {
  if (sleepingRafId !== null || !sounds) return;
  const step = () => {
    const diff = sleepingState.target - sleepingState.current;
    const stillMoving = Math.abs(diff) > SETTLE_EPSILON;
    sleepingState.current = stillMoving ? sleepingState.current + diff * SMOOTH_FACTOR : sleepingState.target;
    sounds.sleeping.volume = Math.max(0, Math.min(1, sleepingState.current));
    // Never auto-resume a session-level pause here — setPaused(true) is the
    // one place that explicitly pauses this element, and a stray
    // updateEnergy() call while paused (render() ticks for both "running"
    // and "paused") must not silently undo that.
    if (!paused && sleepingState.current > SETTLE_EPSILON && sounds.sleeping.paused) {
      safePlay(sounds.sleeping);
    }
    sleepingRafId = stillMoving ? requestAnimationFrame(step) : null;
  };
  sleepingRafId = requestAnimationFrame(step);
}

// --- Public API ------------------------------------------------------------

/**
 * Must be called synchronously from within the Start Mission / Play Again
 * click handler (a genuine user gesture) — same reasoning and pattern as
 * missionAudio.unlock(), so later programmatic play() calls from
 * startMission()/updateEnergy()/onFailStart() (which happen outside that
 * gesture, after the countdown) aren't blocked by autoplay policy. Safe to
 * call even when Rocket is the selected theme — it just primes elements
 * that won't be used that mission.
 */
export function unlock() {
  const s = ensureSounds();
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

/** Call once per mission, at mount time (mirrors missionAudio.startMission()). */
export function startMission() {
  ensureSounds();
  mounted = true;
  paused = false;
  lastWakeMeter = 0;
  angryArmed = true;
  fireTriggered = false;
  sleepingState.current = 0;
  sleepingState.target = 0;
  recomputeSleepingTarget();
}

/** Call every tick with the CURRENT Wake Meter (0-99). Drives sleeping ambience + the angry one-shot's arm/trigger logic. */
export function updateEnergy(wakeMeter) {
  if (!mounted) return;
  if (Math.abs(wakeMeter - lastWakeMeter) < 0.05) return; // cheap no-op guard, same as missionAudio.updateEnergy()
  const previous = lastWakeMeter;
  lastWakeMeter = wakeMeter;

  recomputeSleepingTarget();

  // Hysteresis: only eligible to fire again once it has dropped back below
  // the (lower) re-arm threshold — a single crossing back and forth right
  // at ANGRY_TRIGGER_PCT can never spam the one-shot.
  if (wakeMeter < ANGRY_REARM_PCT) angryArmed = true;
  if (angryArmed && previous < ANGRY_TRIGGER_PCT && wakeMeter >= ANGRY_TRIGGER_PCT) {
    angryArmed = false;
    if (!paused && isEnabled()) {
      const el = ensureSounds().angry;
      el.currentTime = 0;
      el.volume = ANGRY_VOLUME;
      safePlay(el);
    }
  }
}

/**
 * Call at the exact instant the FAIL/fire event begins (same call site as
 * the theme's triggerFailEvent(), before/alongside it — see app.js's onFail
 * handler) so the cue starts as close to the first FAIL frame as possible
 * without coupling this module to individual animation frames. Guarded so
 * it can never double-play within one fail event.
 */
export function onFailStart() {
  if (!mounted || fireTriggered) return;
  fireTriggered = true;
  // The fail cinematic ends the mission — no more Wake Meter fluctuation to
  // react to, and sleeping ambience has no business continuing under it.
  sleepingState.target = 0;
  if (!isEnabled()) return;
  const el = ensureSounds().fire;
  el.currentTime = 0;
  el.volume = FIRE_VOLUME;
  safePlay(el);
}

/** Mirrors missionAudio.setPaused() — pauses/resumes without replaying anything. */
export function setPaused(isPaused) {
  if (paused === isPaused) return;
  paused = isPaused;
  if (!sounds) return;
  if (paused) {
    safePause(sounds.sleeping);
    safePause(sounds.angry);
    safePause(sounds.fire);
  } else {
    recomputeSleepingTarget(); // resumes sleeping only if still appropriate; never replays angry/fire
  }
}

/**
 * Call whenever the Sound On/Off preference changes (missionAudio.setEnabled
 * already persisted it — this only reacts). Sound Off silences immediately;
 * Sound On resumes sleeping ambience if currently appropriate, but never
 * replays an already-consumed angry/fire one-shot.
 */
export function onSoundToggle() {
  if (!sounds) return;
  if (!isEnabled()) {
    sleepingState.target = 0;
    sleepingState.current = 0;
    sounds.sleeping.volume = 0;
    safePause(sounds.angry);
    safePause(sounds.fire);
  } else {
    recomputeSleepingTarget();
  }
}

/** Hard stop for mission teardown (session end, End Mission, Result, Try Again, switching themes). Safe to call even if Dragon was never mounted. */
export function stopAll() {
  mounted = false;
  paused = false;
  if (sleepingRafId !== null) {
    cancelAnimationFrame(sleepingRafId);
    sleepingRafId = null;
  }
  sleepingState.current = 0;
  sleepingState.target = 0;
  if (sounds) {
    Object.values(sounds).forEach((el) => {
      safePause(el);
      el.volume = 0;
    });
  }
}

/** Development-only, read-only diagnostic snapshot — same pattern as missionAudio.qcDebugAudioStatus(). Never shown in production UI. */
export function qcDebugAudioStatus() {
  return {
    mounted,
    paused,
    enabled: isEnabled(),
    lastWakeMeter,
    angryArmed,
    fireTriggered,
    sleeping: { current: Number(sleepingState.current.toFixed(4)), target: sleepingState.target },
    playing: sounds
      ? Object.fromEntries(Object.entries(sounds).map(([k, el]) => [k, { playing: !el.paused, volume: Number(el.volume.toFixed(4)), currentTime: Number(el.currentTime.toFixed(2)) }]))
      : null,
  };
}
