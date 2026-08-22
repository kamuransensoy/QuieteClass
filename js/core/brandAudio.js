// brandAudio.js
// QuietClass PRODUCT-level brand audio (Welcome screen: logo intro, menu
// click, screen-transition whoosh) — deliberately separate from
// missionAudio.js's Rocket-specific sound config (ambience/engine/
// critical/etc.) so brand identity audio never mixes with, or is
// hardcoded alongside, mission gameplay sounds. A future theme's own
// audio stays entirely unaffected by anything in this file.
//
// Reuses missionAudio.js's single persisted "Mission Sounds" preference
// (isEnabled()) rather than creating a second mute state — Welcome, Setup,
// and the live HUD all read/write the exact same preference.

import { isEnabled } from "./missionAudio.js";

// NOTE: the approved assets were placed at assets/audio/rocket/brand/
// (not assets/audio/brand/ as specified) — referenced here at their
// actual location, unrenamed and unmoved.
const BRAND_AUDIO = {
  intro: "assets/audio/rocket/brand/cinematic-logo-intro-warm-inspiring.mp3",
  click: "assets/audio/rocket/brand/menu-click.mp3",
  transition: "assets/audio/rocket/brand/soft-futuristic-interface-transition.mp3",
  // Available for future use — deliberately not auto-layered onto the
  // Welcome screen this sprint (the cinematic intro already carries the
  // logo-reveal moment; stacking both risks audio clutter).
  chime: "assets/audio/rocket/brand/warm-ambient-notification-chime.mp3",
  // NOTE: specified at assets/audio/menu-music.mp3 / countdown_dong.mp3 —
  // the approved files actually live under assets/audio/rocket/ (same
  // "nested under rocket/" pattern as the rest of BRAND_AUDIO above).
  // Referenced here at their real, unmoved location.
  menuMusic: "assets/audio/rocket/menu-music.mp3",
  dong: "assets/audio/rocket/countdown_dong.mp3",
};

const MASTER_VOLUME = 1.0;
const INTRO_VOLUME = 0.3;
const CLICK_VOLUME = 0.25;
const TRANSITION_VOLUME = 0.22;
const FADE_OUT_MS = 300;

// Setup background music: subtle atmosphere, not foreground — see brief
// section 15 (target ~0.08-0.12, initial 0.10).
const MENU_MUSIC_VOLUME = 0.1;
const MENU_MUSIC_FADE_IN_MS = 1200;
const MENU_MUSIC_FADE_OUT_MS = 700;

// Countdown dong: source file is ~13s (a full bell decay); only the first
// ~1.4s is ever audible — stopped/faded early rather than played through,
// per the "soft mindfulness bell, not a gong" requirement (brief section
// 25-27). Conservative volume — a cue, not an alarm.
const DONG_VOLUME = 0.32;
const DONG_MAX_MS = 1400;
const DONG_FADE_MS = 350;

let sounds = null;
// Per-element fade state (WeakMap keyed by the <audio> element) rather
// than one shared rAF id — menu-music's fade-out and the dong's own
// fade-out can now run concurrently without one cancelling the other's
// animation frame loop.
const fadeRafIds = new WeakMap();
let dongTimeoutId = null;

function createElement(src) {
  const el = new Audio(src);
  el.preload = "auto";
  el.volume = 0;
  el.addEventListener("error", () => {
    console.warn(`QuietClass brand audio: failed to load "${src}" — continuing without it.`);
  });
  return el;
}

function ensureSounds() {
  if (sounds) return sounds;
  sounds = {
    intro: createElement(BRAND_AUDIO.intro),
    click: createElement(BRAND_AUDIO.click),
    transition: createElement(BRAND_AUDIO.transition),
    menuMusic: createElement(BRAND_AUDIO.menuMusic),
    dong: createElement(BRAND_AUDIO.dong),
  };
  sounds.menuMusic.loop = true;
  return sounds;
}

function safePlay(el) {
  if (!el) return;
  const p = el.play();
  if (p && typeof p.catch === "function") {
    p.catch(() => {
      // Autoplay rejection (expected on first load, before any user
      // gesture) or a transient decode issue — never surfaced as an
      // error, never blocks the Welcome screen.
    });
  }
}

function stopFade(el) {
  const id = fadeRafIds.get(el);
  if (id !== undefined) {
    cancelAnimationFrame(id);
    fadeRafIds.delete(el);
  }
}

function fadeOutAndStop(el, ms) {
  if (!el || el.paused) return;
  stopFade(el);
  const startVolume = el.volume;
  const startTime = performance.now();
  if (startVolume <= 0 || ms <= 0) {
    try { el.pause(); } catch { /* already stopped */ }
    return;
  }
  const step = (now) => {
    const t = Math.min(1, (now - startTime) / ms);
    el.volume = Math.max(0, startVolume * (1 - t));
    if (t >= 1) {
      try { el.pause(); } catch { /* already stopped */ }
      fadeRafIds.delete(el);
    } else {
      fadeRafIds.set(el, requestAnimationFrame(step));
    }
  };
  fadeRafIds.set(el, requestAnimationFrame(step));
}

// Fades an already-playing (or about-to-play) element UP to a target
// volume — used for the menu-music fade-in. Same per-element WeakMap
// cancellation as fadeOutAndStop() so the two never fight over one
// shared timer.
function fadeIn(el, targetVolume, ms) {
  if (!el) return;
  stopFade(el);
  const startVolume = el.volume;
  const startTime = performance.now();
  if (ms <= 0) {
    el.volume = targetVolume;
    return;
  }
  const step = (now) => {
    const t = Math.min(1, (now - startTime) / ms);
    el.volume = startVolume + (targetVolume - startVolume) * t;
    if (t >= 1) {
      fadeRafIds.delete(el);
    } else {
      fadeRafIds.set(el, requestAnimationFrame(step));
    }
  };
  fadeRafIds.set(el, requestAnimationFrame(step));
}

/**
 * Best-effort only — call once when the Welcome screen first appears.
 * Browsers will very likely block this (no user gesture yet); that's
 * expected and handled silently. Never blocks or disables Start a
 * Mission, never shows an error/permission UI.
 */
export function tryPlayIntro() {
  if (!isEnabled()) return;
  const s = ensureSounds();
  s.intro.currentTime = 0;
  s.intro.volume = Math.max(0, Math.min(1, INTRO_VOLUME * MASTER_VOLUME));
  safePlay(s.intro);
}

/** Fades out the intro if it happened to be playing (e.g. Sound turned off, or Welcome dismissed mid-intro). */
export function stopIntro() {
  if (!sounds) return;
  fadeOutAndStop(sounds.intro, FADE_OUT_MS);
}

/**
 * The single subtle click used for ALL intentional QuietClass UI
 * activation feedback (app.js's global delegated listener calls this for
 * every eligible button/control app-wide, not just Welcome's CTA) —
 * cached element, currentTime reset before each replay, restrained
 * volume, autoplay/rejection handled silently. Always called from a real
 * click event (a genuine user gesture), so it's never blocked once sound
 * is enabled.
 */
export function playClick() {
  if (!isEnabled()) return;
  const s = ensureSounds();
  s.click.currentTime = 0;
  s.click.volume = Math.max(0, Math.min(1, CLICK_VOLUME * MASTER_VOLUME));
  safePlay(s.click);
}

/** Call alongside playClick() on the Welcome → Setup transition. Left to fade/finish on its own; never blocks navigation. */
export function playTransition() {
  if (!isEnabled()) return;
  const s = ensureSounds();
  s.transition.currentTime = 0;
  s.transition.volume = Math.max(0, Math.min(1, TRANSITION_VOLUME * MASTER_VOLUME));
  safePlay(s.transition);
}

/**
 * Setup-only background atmosphere. Idempotent: calling this while the
 * track is already playing (or mid fade-in) just leaves it alone, so no
 * caller needs to track "did I already start this" — safe to call from
 * every genuine Setup-entry point without ever restarting the loop or
 * stacking a second instance (single cached, looping <audio> element).
 */
export function playMenuMusic() {
  if (!isEnabled()) return;
  const s = ensureSounds();
  if (!s.menuMusic.paused) return;
  s.menuMusic.currentTime = 0;
  s.menuMusic.volume = 0;
  safePlay(s.menuMusic);
  fadeIn(s.menuMusic, Math.max(0, Math.min(1, MENU_MUSIC_VOLUME * MASTER_VOLUME)), MENU_MUSIC_FADE_IN_MS);
}

/** Fades the Setup menu music out. Safe to call even if it isn't playing. */
export function stopMenuMusic(ms = MENU_MUSIC_FADE_OUT_MS) {
  if (!sounds) return;
  fadeOutAndStop(sounds.menuMusic, ms);
}

/**
 * The short countdown-reveal chime, played once after "1". The source
 * file is a long bell decay (~13s) — this always truncates playback to a
 * perceived ~1-1.4s with a gentle fade, regardless of the file's real
 * length, so it never lingers under the mission reveal.
 */
export function playDong() {
  if (!isEnabled()) return;
  const s = ensureSounds();
  if (dongTimeoutId !== null) {
    clearTimeout(dongTimeoutId);
    dongTimeoutId = null;
  }
  stopFade(s.dong);
  s.dong.currentTime = 0;
  s.dong.volume = Math.max(0, Math.min(1, DONG_VOLUME * MASTER_VOLUME));
  safePlay(s.dong);
  dongTimeoutId = setTimeout(() => {
    dongTimeoutId = null;
    fadeOutAndStop(s.dong, DONG_FADE_MS);
  }, Math.max(0, DONG_MAX_MS - DONG_FADE_MS));
}

/** Hard stop for all brand audio — no orphaned playback surviving past any screen transition. */
export function stopAll() {
  if (dongTimeoutId !== null) {
    clearTimeout(dongTimeoutId);
    dongTimeoutId = null;
  }
  if (!sounds) return;
  Object.values(sounds).forEach((el) => {
    stopFade(el);
    try { el.pause(); } catch { /* already stopped */ }
    el.volume = 0;
  });
}
