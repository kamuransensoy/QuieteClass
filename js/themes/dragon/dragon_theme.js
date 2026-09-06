// dragon/theme.js
// Implements the theme contract from themeRegistry.js. Holds no rendering
// logic itself — delegates entirely to renderer.js.

import * as renderer from "./dragon_renderer.js";

// Setup-card preview only — a real illustrated sleeping-dragon-den scene,
// same pattern as rocket_theme.js's own mission-card <img>. UI artwork
// only: unrelated to (and never touched by) the live mission renderer's
// frame timeline.
const thumbnail = `<img src="assets/ui/missions/dragon-card.png" alt="" />`;

export default {
  id: "dragon",
  name: "Dragon",
  thumbnail,
  missionTitle: "Keep the Dragon Asleep",
  missionHint: "Stay quiet until the timer reaches zero.",
  successMessage: "You Kept the Dragon Asleep!",
  failMessage: "You Woke the Dragon!",
  meterLabel: "Wake Level",
  // Theme identity color: setup-screen card accent, session HUD goal-area
  // tint, and result-screen accent. Warm ember, distinct from Rocket's
  // cool cyan — purely a color hook, no renderer behavior depends on it.
  accentColor: "#ff7a45",
  // Optional — not part of the required themeRegistry contract. app.js
  // calls this opportunistically (if a theme defines it) as soon as the
  // teacher selects Dragon on Setup, so the frame timeline is already
  // warm well before Start Mission. Themes that don't need it (Rocket)
  // simply don't define it.
  preload: () => renderer.preload(),
  // Dev-only, optional — see window.qcDebugDragonStatus() in app.js.
  // Never shown in production UI.
  qcDebugStatus: () => renderer.qcDebugDragonStatus(),
  mount: (stageEl) => renderer.mount(stageEl),
  updateProgress: (wakeMeter) => renderer.updateProgress(wakeMeter),
  triggerFailEvent: (onComplete) => renderer.triggerFailEvent(onComplete),
  resolveFailEvent: () => renderer.resolveFailEvent(),
  onSessionEnd: () => renderer.onSessionEnd(),
  unmount: (stageEl) => renderer.unmount(stageEl),
};
