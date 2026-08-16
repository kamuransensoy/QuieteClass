// rocket/theme.js
// Implements the theme contract from themeRegistry.js. Holds no rendering
// logic itself — delegates entirely to renderer.js.

import * as renderer from "./rocket_renderer.js";

// Setup-card preview only — a compact, hand-authored night-launch scene
// distinct from (and much simpler than) the live rocket_scene.js. Kept as
// static markup, same as the previous flat thumbnail; nothing here is
// wired to the mission renderer.
const thumbnail = `<svg viewBox="0 0 160 120" xmlns="http://www.w3.org/2000/svg" preserveAspectRatio="xMidYMid slice">
  <defs>
    <linearGradient id="rocket-card-sky" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#050810" />
      <stop offset="55%" stop-color="#0b1224" />
      <stop offset="100%" stop-color="#131c34" />
    </linearGradient>
    <radialGradient id="rocket-card-horizon" cx="50%" cy="100%" r="65%">
      <stop offset="0%" stop-color="#ff9d3f" stop-opacity="0.5" />
      <stop offset="100%" stop-color="#ff9d3f" stop-opacity="0" />
    </radialGradient>
    <radialGradient id="rocket-card-flame" cx="50%" cy="0%" r="90%">
      <stop offset="0%" stop-color="#fff6d5" />
      <stop offset="45%" stop-color="#ffb347" />
      <stop offset="100%" stop-color="#e2492a" />
    </radialGradient>
  </defs>
  <rect x="0" y="0" width="160" height="120" fill="url(#rocket-card-sky)" />
  <circle cx="22" cy="20" r="1.1" fill="#dfe6f5" opacity="0.8" />
  <circle cx="132" cy="14" r="1" fill="#dfe6f5" opacity="0.6" />
  <circle cx="108" cy="34" r="0.9" fill="#dfe6f5" opacity="0.7" />
  <circle cx="46" cy="40" r="0.9" fill="#dfe6f5" opacity="0.5" />
  <circle cx="142" cy="54" r="1.1" fill="#dfe6f5" opacity="0.7" />
  <ellipse cx="80" cy="120" rx="72" ry="20" fill="url(#rocket-card-horizon)" />
  <path d="M80,30 C90,44 93,66 93,92 L67,92 C67,66 70,44 80,30 Z" fill="#dfe6f0" />
  <path d="M80,30 C84,38 87,48 88,58 L72,58 C73,48 76,38 80,30 Z" fill="#f4f6fa" />
  <rect x="67" y="70" width="26" height="6" fill="#22b8cf" />
  <path d="M67,80 L54,95 L67,90 Z" fill="#232c46" />
  <path d="M93,80 L106,95 L93,90 Z" fill="#232c46" />
  <path d="M80,92 C74,101 73,109 80,117 C87,109 86,101 80,92 Z" fill="url(#rocket-card-flame)" />
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
