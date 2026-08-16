// themeRegistry.js
// Flat map of registered themes. This is the only core module aware that
// themes exist at all — it never imports a theme itself; app.js does.

const themes = new Map();

/**
 * Registers a theme implementing the approved contract:
 * {
 *   id, name, thumbnail,
 *   missionTitle, missionHint, successMessage, failMessage, meterLabel,  // theme-specific copy — see app.js
 *   mount(stageEl),
 *   updateProgress(wakeMeter),                    // wakeMeter is 0-100. This is the ONLY
 *                                                  // progress signal a theme receives — core
 *                                                  // never forwards raw microphone noiseState.
 *                                                  // How a theme maps that number to visuals
 *                                                  // (discrete buckets, continuous curves, etc.)
 *                                                  // is entirely up to the theme.
 *   triggerFailEvent(onComplete?),                // core calls this once wakeMeter reaches 100.
 *                                                  // onComplete is invoked once the theme's own
 *                                                  // fail event has actually finished, so a
 *                                                  // mission-level result can wait for it without
 *                                                  // core knowing what the event looks like.
 *   resolveFailEvent(),
 *   onSessionEnd(),
 *   unmount(stageEl),
 * }
 * @param {object} themeModule
 */
export function registerTheme(themeModule) {
  themes.set(themeModule.id, themeModule);
}

export function getTheme(id) {
  return themes.get(id) || null;
}

export function getAllThemes() {
  return Array.from(themes.values());
}
