// rocket/theme.js
// Implements the theme contract from themeRegistry.js. Holds no rendering
// logic itself — delegates entirely to renderer.js.

import * as renderer from "./rocket_renderer.js";

// Setup-card preview only — the vintage-inspired retro-space illustration
// (assets/rocket/rocket_mission_card.png) that anchors the Rocket theme's
// warm palette (see --rocket-* tokens in layout.css). This is a static
// mission-card image only: it is NOT the live Rocket sprite and nothing
// here touches rocket_renderer.js or the PixiJS scene. object-fit: cover
// (layout.css) crops it cleanly inside the card's 4:3 artwork area.
const thumbnail = `<img src="assets/rocket/rocket_mission_card.png" alt="" />`;

export default {
  id: "rocket",
  name: "Rocket",
  thumbnail,
  missionTitle: "Keep the Rocket Grounded",
  missionHint: "Stay quiet until the timer reaches zero.",
  successMessage: "You Kept the Rocket Grounded!",
  failMessage: "Oh no... The Rocket Launched!",
  meterLabel: "Launch Energy",
  // Optional result-screen headline/line pair (app.js falls back to a
  // generic "Mission Complete"/"Mission Failed" + successMessage/
  // failMessage when a theme doesn't provide these).
  resultWinTitle: "Mission Complete",
  resultWinLine: "You kept the rocket grounded!",
  // The launch animation itself stays visually exciting — this copy is
  // what makes the RESULT unambiguous as a failure, not a celebration.
  resultFailTitle: "Mission Aborted",
  resultFailLine: "The rocket launched too early.",
  // Theme identity color: setup-screen card accent, session HUD goal-area
  // tint, and result-screen accent. Muted terracotta (matches
  // --rocket-orange in base.css) — softened from an earlier, more
  // saturated burnt-orange so it reads as calm/premium rather than
  // arcade-bright — purely a color hook, no renderer behavior depends on it.
  accentColor: "#b96e4f",
  mount: (stageEl) => renderer.mount(stageEl),
  updateProgress: (wakeMeter) => renderer.updateProgress(wakeMeter),
  triggerFailEvent: (onComplete) => renderer.triggerFailEvent(onComplete),
  resolveFailEvent: () => renderer.resolveFailEvent(),
  onSessionEnd: () => renderer.onSessionEnd(),
  unmount: (stageEl) => renderer.unmount(stageEl),
};
