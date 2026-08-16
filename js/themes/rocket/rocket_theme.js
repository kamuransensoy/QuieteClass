// rocket/theme.js
// Implements the theme contract from themeRegistry.js. Holds no rendering
// logic itself — delegates entirely to renderer.js.

import * as renderer from "./rocket_renderer.js";

const thumbnail = `<svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg">
  <rect x="0" y="0" width="100" height="100" fill="#0b1224" />
  <path d="M50,20 C60,32 62,55 62,78 L38,78 C38,55 40,32 50,20 Z" fill="#eef1f7" />
  <path d="M50,20 C54,26 57,32 58,40 L42,40 C43,32 46,26 50,20 Z" fill="#dfe6f0" />
</svg>`;

export default {
  id: "rocket",
  name: "Rocket",
  thumbnail,
  missionTitle: "Keep the Rocket Grounded",
  missionHint: "Stay quiet until the timer reaches zero.",
  successMessage: "You Kept the Rocket Grounded!",
  failMessage: "Oh no... The Rocket Launched!",
  meterLabel: "Launch Energy",
  // Theme identity color: setup-screen card accent, session HUD goal-area
  // tint, and result-screen accent. Cool cyan, distinct from Dragon's
  // warm ember — purely a color hook, no renderer behavior depends on it.
  accentColor: "#22b8cf",
  mount: (stageEl) => renderer.mount(stageEl),
  updateProgress: (wakeMeter) => renderer.updateProgress(wakeMeter),
  triggerFailEvent: (onComplete) => renderer.triggerFailEvent(onComplete),
  resolveFailEvent: () => renderer.resolveFailEvent(),
  onSessionEnd: () => renderer.onSessionEnd(),
  unmount: (stageEl) => renderer.unmount(stageEl),
};
