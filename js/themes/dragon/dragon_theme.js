// dragon/theme.js
// Implements the theme contract from themeRegistry.js. Holds no rendering
// logic itself — delegates entirely to renderer.js.

import * as renderer from "./dragon_renderer.js";

// Setup-card preview only — a compact, hand-authored curled-sleeping-dragon
// scene distinct from (and much simpler than) the live video renderer. Kept
// as static markup, same as the previous flat thumbnail; nothing here is
// wired to the mission renderer.
const thumbnail = `<svg viewBox="0 0 160 120" xmlns="http://www.w3.org/2000/svg" preserveAspectRatio="xMidYMid slice">
  <defs>
    <linearGradient id="dragon-card-sky" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#161029" />
      <stop offset="55%" stop-color="#241a3d" />
      <stop offset="100%" stop-color="#33223f" />
    </linearGradient>
    <radialGradient id="dragon-card-ember" cx="50%" cy="100%" r="70%">
      <stop offset="0%" stop-color="#ff7a45" stop-opacity="0.3" />
      <stop offset="100%" stop-color="#ff7a45" stop-opacity="0" />
    </radialGradient>
  </defs>
  <rect x="0" y="0" width="160" height="120" fill="url(#dragon-card-sky)" />
  <circle cx="26" cy="18" r="1" fill="#e7e2f2" opacity="0.7" />
  <circle cx="42" cy="30" r="0.8" fill="#e7e2f2" opacity="0.6" />
  <circle cx="18" cy="42" r="1.1" fill="#e7e2f2" opacity="0.5" />
  <circle cx="140" cy="20" r="9" fill="#f4ecd8" />
  <circle cx="136" cy="17" r="7.5" fill="#241a3d" />
  <ellipse cx="80" cy="122" rx="80" ry="24" fill="url(#dragon-card-ember)" />
  <path d="M56,92 C32,84 28,58 48,48" stroke="#4a6b8a" stroke-width="15" stroke-linecap="round" fill="none" />
  <ellipse cx="82" cy="86" rx="38" ry="26" fill="#4a6b8a" />
  <ellipse cx="86" cy="98" rx="26" ry="13" fill="#5d81a3" opacity="0.55" />
  <path d="M62,64 L69,72 L58,73 Z" fill="#3d5877" />
  <path d="M78,58 L85,66 L74,68 Z" fill="#3d5877" />
  <path d="M96,58 L103,67 L92,68 Z" fill="#3d5877" />
  <circle cx="116" cy="55" r="17" fill="#557a9e" />
  <path d="M108,42 L112,50 L104,50 Z" fill="#3d5877" />
  <path d="M121,40 L125,49 L117,49 Z" fill="#3d5877" />
  <path d="M111,57 C113,55 117,55 119,57" stroke="#2c3f52" stroke-width="1.8" fill="none" stroke-linecap="round" />
  <text x="106" y="30" font-family="ui-rounded, system-ui, sans-serif" font-size="10" font-weight="700" fill="#cdd8ec" opacity="0.85">z</text>
  <text x="118" y="20" font-family="ui-rounded, system-ui, sans-serif" font-size="6.5" font-weight="700" fill="#cdd8ec" opacity="0.7">z</text>
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
