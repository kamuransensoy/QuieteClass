// noiseState.js
// Pure logic module: converts a raw 0-1 noise level into one of five
// semantic states, with hysteresis to prevent boundary flicker, and owns
// the CRITICAL enter-once / resolve-after-dwell behavior. No DOM, no
// audio, no session, no theme logic lives here.

export const NOISE_STATES = ["CALM", "LOW", "MEDIUM", "HIGH", "CRITICAL"];

// Centralized, tunable config. Nothing outside this file should hardcode
// thresholds, dwell time, or cooldown.
export const NOISE_CONFIG = {
  thresholds: {
    LOW: 0.15,
    MEDIUM: 0.35,
    HIGH: 0.6,
    CRITICAL: 0.8,
  },
  // Level must drop this far below a threshold before the state is allowed
  // to fall back down a level (prevents boundary flicker).
  hysteresisMargin: 0.05,
  // Seconds spent continuously at CALM or LOW required before CRITICAL
  // is considered "resolved" and can be triggered again.
  criticalResolveDwellSeconds: 3,
};

function classifyRaw(level, config) {
  const t = config.thresholds;
  if (level >= t.CRITICAL) return "CRITICAL";
  if (level >= t.HIGH) return "HIGH";
  if (level >= t.MEDIUM) return "MEDIUM";
  if (level >= t.LOW) return "LOW";
  return "CALM";
}

/**
 * Creates a stateful noise classifier instance. A factory (rather than
 * module-level state) so a fresh classifier can be created per session.
 */
export function createNoiseClassifier(config = NOISE_CONFIG) {
  let currentState = "CALM";
  let criticalActive = false;   // true from trigger until resolve
  let criticalResolved = true;  // true once dwell condition met, allows re-trigger
  let calmDwellStart = null;    // timestamp when continuous CALM/LOW dwell began

  /**
   * Feed a new raw level + current timestamp (ms).
   * @returns {{state: string, didEnterCritical: boolean, didResolveCritical: boolean}}
   */
  function update(level, nowMs = Date.now()) {
    const rawState = classifyRaw(level, config);
    const order = NOISE_STATES;
    const currentIndex = order.indexOf(currentState);
    const rawIndex = order.indexOf(rawState);

    // Hysteresis: escalate immediately, but only de-escalate once the
    // level has dropped past the boundary by the configured margin.
    let nextState = currentState;
    if (rawIndex > currentIndex) {
      nextState = rawState;
    } else if (rawIndex < currentIndex) {
      const t = config.thresholds;
      const downThresholds = { HIGH: t.CRITICAL, MEDIUM: t.HIGH, LOW: t.MEDIUM, CALM: t.LOW };
      const boundary = downThresholds[order[currentIndex]];
      if (boundary === undefined || level < boundary - config.hysteresisMargin) {
        nextState = rawState;
      }
    }

    currentState = nextState;

    let didEnterCritical = false;
    let didResolveCritical = false;

    if (currentState === "CRITICAL") {
      if (!criticalActive && criticalResolved) {
        criticalActive = true;
        criticalResolved = false;
        didEnterCritical = true;
      }
      calmDwellStart = null;
    } else if (currentState === "CALM" || currentState === "LOW") {
      if (criticalActive) {
        if (calmDwellStart === null) {
          calmDwellStart = nowMs;
        } else if (nowMs - calmDwellStart >= config.criticalResolveDwellSeconds * 1000) {
          criticalActive = false;
          criticalResolved = true;
          calmDwellStart = null;
          didResolveCritical = true;
        }
      }
    } else {
      // MEDIUM/HIGH while critical was active: dwell must be continuous
      // CALM/LOW, so any escape back up resets the dwell timer.
      calmDwellStart = null;
    }

    return { state: currentState, didEnterCritical, didResolveCritical };
  }

  function reset() {
    currentState = "CALM";
    criticalActive = false;
    criticalResolved = true;
    calmDwellStart = null;
  }

  return { update, reset };
}
