// dragon/renderer.js
// Theme entry point / dispatcher — dragon_theme.js imports only this
// file, unchanged from before this sprint. Two real implementations live
// behind it:
//
//   dragon_renderer_frames.js  — production: the reversible 20fps WAKE
//                                 timeline (assets/dragon/timeline/wake/)
//                                 plus the forward-playing FAIL cinematic
//                                 (assets/dragon/timeline/fail/), both cut
//                                 from the same source Kling video.
//   dragon_renderer_pose.js    — preserved fallback: the original,
//                                 QA-approved PNG+GSAP 4-pose renderer.
//
// mount() waits for the frame timeline's preload to settle and picks
// whichever implementation to actually use. The frame renderer uses a
// windowed cache for the WAKE range (see dragon_renderer_frames.js)
// rather than loading everything up front, so
// preload() only guarantees frame 0 specifically — that is the one
// health signal available before mount, and the one that actually
// matters (a Dragon that can't even show Sleeping isn't worth mounting).
// Individual frame failures discovered later during real gameplay are
// handled inline by the frame renderer itself (nearest-neighbor
// substitution — see findNearestCachedTexture there), not by falling
// back to the pose renderer mid-mission. Every other contract method
// simply forwards to whichever implementation is active.

import * as frames from "./dragon_renderer_frames.js";
import * as pose from "./dragon_renderer_pose.js";

let active = null; // frames module | pose module

/**
 * Kicks off frame preloading early (see dragon_theme.js's optional
 * preload() hook, called from app.js as soon as Dragon is selected on
 * Setup) — mount() awaits this same in-flight/completed promise rather
 * than starting a second load.
 */
export function preload() {
  return frames.preload().catch((err) => {
    console.error("QuietClass Dragon: frame timeline preload failed entirely — will fall back to the pose renderer.", err);
    return { frame0Ready: false, failedCount: Infinity, total: 1 };
  });
}

export async function mount(stageEl) {
  const status = await preload();

  if (!status.frame0Ready) {
    console.warn("QuietClass Dragon: frame 0 of the timeline failed to load — using the PNG+GSAP pose renderer for this mission instead.");
    active = pose;
  } else {
    active = frames;
  }
  return active.mount(stageEl);
}

export function updateProgress(wakeMeter) {
  if (active) active.updateProgress(wakeMeter);
}

export function triggerFailEvent(onComplete) {
  if (active) active.triggerFailEvent(onComplete);
}

export function resolveFailEvent() {
  if (active) active.resolveFailEvent();
}

export function onSessionEnd() {
  if (active) active.onSessionEnd();
}

export function unmount(stageEl) {
  if (active) {
    active.unmount(stageEl);
    active = null;
  }
}

// Dev-only: which implementation actually served the last/current
// mission, and the frame-timeline's own load status regardless of which
// one is active. Never shown in production UI.
export function qcDebugDragonStatus() {
  return {
    activeRenderer: active === pose ? "pose (fallback)" : active === frames ? "frames (production)" : null,
    frameLoadStatus: frames.getLoadStatus(),
    frameLiveSnapshot: frames.getDebugSnapshot(),
  };
}
