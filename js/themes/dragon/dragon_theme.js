// dragon/theme.js
// Implements the theme contract from themeRegistry.js. Holds no rendering
// logic itself — delegates entirely to renderer.js.

import * as renderer from "./dragon_renderer.js";

const thumbnail = `<svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg">
  <ellipse cx="50" cy="60" rx="28" ry="20" fill="#4a6b8a" />
  <circle cx="50" cy="35" r="16" fill="#557a9e" />
</svg>`;

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
  mount: (stageEl) => renderer.mount(stageEl),
  updateProgress: (wakeMeter) => renderer.updateProgress(wakeMeter),
  triggerFailEvent: (onComplete) => renderer.triggerFailEvent(onComplete),
  resolveFailEvent: () => renderer.resolveFailEvent(),
  onSessionEnd: () => renderer.onSessionEnd(),
  unmount: (stageEl) => renderer.unmount(stageEl),
};
