// wakeMeter.js
// Pure logic, shared by every theme: Wake Meter velocity tuning and
// time-based integration. No DOM, no audio, no session lifecycle, and
// NO theme-specific visual-state derivation lives here — how a given
// theme turns the Wake Meter into visuals is entirely up to that theme
// (see themeRegistry.js's updateProgress(wakeMeter) contract).

// V1 tuning constants — percentage points of Wake Meter per second.
// Calibrate ONLY here after classroom testing; nothing else in the
// project should hardcode a velocity number.
//
// Sprint 4.1 diagnosis (see final report): LOW previously drained at
// -1/sec. Tracing the classification math (see noiseState.js) shows
// LOW covers normalized level 0.15-0.35, i.e. raw mic RMS roughly
// 0.0375-0.0875 — a band that ordinary room conversation from across a
// room plausibly sits in without ever reaching MEDIUM (RMS >= 0.0875).
// With LOW actively draining, that kind of moderate, audible-but-not-
// loud talking could never accumulate any Wake Meter progress at all.
// Changed LOW from -1 to 0 (neutral hold) so only genuine CALM/silence
// actively drains the meter; LOW no longer fights against MEDIUM+
// bursts. This is the only tuning change made this sprint — the mic
// capture (audio.js) and the noiseState thresholds themselves were left
// untouched, since neither was demonstrated broken by static tracing.
export const WAKE_METER_CONFIG = {
  velocityPerSecond: {
    CALM: -5,
    LOW: 0, // was -1
    MEDIUM: 3,
    HIGH: 7,
    CRITICAL: 12,
  },
  min: 0,
  max: 100,
};

/**
 * Integrates the Wake Meter by dtSeconds using the velocity for the given
 * noise state. Time-based, not frame-based: a given dtSeconds always
 * produces the same delta regardless of how many calls happened along
 * the way, so behavior is consistent across frame rates.
 */
export function integrateWakeMeter(current, noiseState, dtSeconds) {
  const rate = WAKE_METER_CONFIG.velocityPerSecond[noiseState] ?? 0;
  const next = current + rate * dtSeconds;
  return Math.min(WAKE_METER_CONFIG.max, Math.max(WAKE_METER_CONFIG.min, next));
}
