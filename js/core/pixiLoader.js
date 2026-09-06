// pixiLoader.js
// Shared lazy PixiJS loader — one script tag, cached on window.PIXI,
// reused by any theme that wants Pixi (currently Rocket and Dragon).
// Both resolve to the exact same window.PIXI global, so there is still
// only ever one PixiJS on the page regardless of which theme mounts
// first or which loader call actually triggers the load.
//
// Vendored locally as js/vendor/pixi.min.js (PixiJS v8.19.0, byte-for-
// byte the same build previously fetched live from
// https://pixijs.download/release/pixi.min.js — see that file's own
// header comment) — no CDN, no network dependency, matching the same
// "classroom network reliability" reasoning already applied to GSAP.

let pixiLoadPromise = null;

export function ensurePixiLoaded() {
  if (window.PIXI) return Promise.resolve();
  if (pixiLoadPromise) return pixiLoadPromise;
  pixiLoadPromise = new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = "js/vendor/pixi.min.js";
    script.onload = () => resolve();
    script.onerror = () => reject(new Error("pixiLoader: failed to load PixiJS"));
    document.head.appendChild(script);
  });
  return pixiLoadPromise;
}
