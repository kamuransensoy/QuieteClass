// gsap-esm.js
// Thin ESM re-export around the vendored UMD build (js/vendor/gsap.min.js,
// unmodified, GSAP 3.15.0, "Standard no-charge" license — see that file's
// own header). GSAP's dist build is UMD, not a native ES module, so it
// can't be `import`ed directly — index.html loads it first as a classic
// global <script>, which attaches `window.gsap`. This module exists only
// so consumers (dragon_renderer.js) can write a normal ES import instead
// of touching a bare global. No CDN, no second GSAP copy, no build step.

export const gsap = window.gsap;
