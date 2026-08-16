// rocket/scene.js
// Builds the Rocket SVG scene ONCE and returns cached references to every
// node the renderer will animate. No node is ever created or removed
// after buildScene() runs — renderer.js only ever reads/writes properties
// on the nodes returned here.
//
// Composition (viewBox 0 0 340 460): deep navy sky, sparse stars, distant
// horizon glow, a gantry/service tower, a launch platform with an engine
// trench and two hold-down clamps, ground lighting, a small reusable
// vapor pool, and a two-stage rocket with a booster pair and three
// engine nozzles. Kept intentionally larger than the 250-line JS
// guideline — this file is pure markup construction, and splitting it
// further would hurt readability more than it would help.

const svgNS = "http://www.w3.org/2000/svg";

function el(tag, attrs) {
  const node = document.createElementNS(svgNS, tag);
  for (const key in attrs) node.setAttribute(key, attrs[key]);
  return node;
}

const STAR_COUNT = 42;
const VAPOR_COUNT = 5;
// Rocket/pad geometry keeps its original 170-centered coordinates (see
// buildRocket/buildPlatform/buildFlame) — only the viewBox window around
// it widens (and recenters via a negative min-x) so the scene covers a
// full-screen landscape viewport with "slice" instead of letterboxing.
const VIEW_MIN_X = -280;
const VIEW_WIDTH = 900;
const VIEW_HEIGHT = 460;

export function buildScene(stageEl) {
  const svg = el("svg", {
    viewBox: `${VIEW_MIN_X} 0 ${VIEW_WIDTH} ${VIEW_HEIGHT}`,
    preserveAspectRatio: "xMidYMid slice",
    width: "100%",
    height: "100%",
    class: "theme-rocket",
  });

  const style = el("style", {});
  style.textContent = `.theme-rocket .rocket-stars circle { animation: rocket-twinkle 3.6s ease-in-out infinite; opacity: 0.5; }
    .theme-rocket .rocket-vapor ellipse { animation: rocket-puff var(--vapor-dur, 2.6s) ease-out infinite; opacity: 0; }
    @keyframes rocket-twinkle { 0%, 100% { opacity: 0.3; } 50% { opacity: 0.85; } }
    @keyframes rocket-puff {
      0% { opacity: 0; transform: translateY(0) scale(0.7); }
      35% { opacity: var(--vapor-peak, 0.35); }
      100% { opacity: 0; transform: translateY(-28px) scale(1.5); }
    }`;
  svg.appendChild(style);

  const defs = el("defs", {});
  defs.append(
    buildSkyGradient(), buildHorizonGlow(), buildHazeGradient(),
    buildEngineGlowGradient(), buildFlameGradient(), buildBodyGradient(), buildGroundLightGradient(),
    buildMetalGradient(), buildAtmoGradient(), buildWindowGradient(),
  );
  svg.appendChild(defs);

  const sky = el("rect", { x: String(VIEW_MIN_X), y: "0", width: String(VIEW_WIDTH), height: String(VIEW_HEIGHT), fill: "url(#rocket-sky)" });
  svg.appendChild(sky);

  // Faint blue/purple wash across the full width for atmospheric depth,
  // independent of the horizon glow (which stays centered on the pad).
  const atmo = el("rect", { x: String(VIEW_MIN_X), y: "0", width: String(VIEW_WIDTH), height: String(VIEW_HEIGHT), fill: "url(#rocket-atmo)" });
  svg.appendChild(atmo);

  const stars = buildStars();
  svg.appendChild(stars.group);

  const horizonGlow = el("ellipse", { cx: "170", cy: "420", rx: "520", ry: "90", fill: "url(#rocket-horizon-glow)" });
  svg.appendChild(horizonGlow);

  // Very subtle, low-contrast distant ground silhouette (close to the
  // sky's own darkest tone) so the horizon reads as a place, not a void.
  const groundSilhouette = el("path", {
    d: `M${VIEW_MIN_X},460 L${VIEW_MIN_X},432 C${VIEW_MIN_X + 160},408 ${VIEW_MIN_X + 320},426 ${VIEW_MIN_X + 470},414 C${VIEW_MIN_X + 620},402 ${VIEW_MIN_X + 760},420 ${VIEW_MIN_X + VIEW_WIDTH},406 L${VIEW_MIN_X + VIEW_WIDTH},460 Z`,
    fill: "#070b16",
    opacity: "0.65",
  });
  svg.appendChild(groundSilhouette);

  const tower = buildTower();
  svg.appendChild(tower.group);

  const groundLight = buildGroundLights();
  svg.appendChild(groundLight.group);

  const platform = buildPlatform();
  svg.appendChild(platform.group);

  const clampL = buildClamp(-52);
  const clampR = buildClamp(52);
  svg.append(clampL.group, clampR.group);

  const engineMount = buildEngineMount();
  svg.appendChild(engineMount.group);

  const vapor = buildVaporPool();
  svg.appendChild(vapor.group);

  const flame = buildFlame();
  svg.appendChild(flame.group);

  const haze = el("rect", { x: String(VIEW_MIN_X), y: "330", width: String(VIEW_WIDTH), height: "130", fill: "url(#rocket-haze)" });
  svg.appendChild(haze);

  const rocket = buildRocket();
  svg.appendChild(rocket.group);

  stageEl.appendChild(svg);

  return { svg, sky, stars, horizonGlow, haze, tower, groundLight, platform, clampL, clampR, engineMount, vapor, flame, rocket };
}

// --- gradients (built once, referenced by fill="url(#...)") ---------------

function buildSkyGradient() {
  // Richer tonal steps (was 3 flat stops) for subtle night-sky depth.
  const g = el("linearGradient", { id: "rocket-sky", x1: "0", y1: "0", x2: "0", y2: "1" });
  [["0%", "#04060c"], ["35%", "#0a1020"], ["65%", "#101a30"], ["100%", "#182440"]].forEach(([offset, color]) => {
    g.appendChild(el("stop", { offset, "stop-color": color }));
  });
  return g;
}

function buildHorizonGlow() {
  const g = el("radialGradient", { id: "rocket-horizon-glow", cx: "50%", cy: "50%", r: "50%" });
  g.appendChild(el("stop", { offset: "0%", "stop-color": "#3d5a80", "stop-opacity": "0.4" }));
  g.appendChild(el("stop", { offset: "100%", "stop-color": "#3d5a80", "stop-opacity": "0" }));
  return g;
}

function buildHazeGradient() {
  const g = el("linearGradient", { id: "rocket-haze", x1: "0", y1: "0", x2: "0", y2: "1" });
  g.appendChild(el("stop", { offset: "0%", "stop-color": "#ff9d3f", "stop-opacity": "0" }));
  g.appendChild(el("stop", { offset: "100%", "stop-color": "#ff9d3f", "stop-opacity": "0.10" }));
  return g;
}

function buildEngineGlowGradient() {
  const g = el("radialGradient", { id: "rocket-engine-glow", cx: "50%", cy: "50%", r: "50%" });
  g.appendChild(el("stop", { offset: "0%", "stop-color": "#ffdca0", "stop-opacity": "0.9" }));
  g.appendChild(el("stop", { offset: "55%", "stop-color": "#ff9d3f", "stop-opacity": "0.5" }));
  g.appendChild(el("stop", { offset: "100%", "stop-color": "#ff9d3f", "stop-opacity": "0" }));
  return g;
}

function buildFlameGradient() {
  const g = el("radialGradient", { id: "rocket-flame-gradient", cx: "50%", cy: "10%", r: "80%" });
  [["0%", "#fff6d5"], ["40%", "#ffb347"], ["100%", "#e2492a"]].forEach(([offset, color]) => {
    g.appendChild(el("stop", { offset, "stop-color": color }));
  });
  return g;
}

function buildBodyGradient() {
  // Wider, sharper light/shadow spread (was a fairly flat silver) for much
  // stronger metallic separation between lit and shadow sides: a darker
  // cool shadow edge, a tight bright specular band, and a deeper trailing
  // shadow than before.
  const g = el("linearGradient", { id: "rocket-body-gradient", x1: "0", y1: "0", x2: "1", y2: "0" });
  [["0%", "#7f8aa6"], ["22%", "#f9fbfe"], ["40%", "#e4e9f2"], ["65%", "#c7cede"], ["100%", "#5f6a86"]].forEach(([offset, color]) => {
    g.appendChild(el("stop", { offset, "stop-color": color }));
  });
  return g;
}

// Glossy dark-glass look for the window (was a flat near-black), matching
// the reference's reflective cockpit glass.
function buildWindowGradient() {
  const g = el("radialGradient", { id: "rocket-window-gradient", cx: "35%", cy: "30%", r: "75%" });
  g.appendChild(el("stop", { offset: "0%", "stop-color": "#4d7bff" }));
  g.appendChild(el("stop", { offset: "35%", "stop-color": "#182642" }));
  g.appendChild(el("stop", { offset: "100%", "stop-color": "#05070d" }));
  return g;
}

function buildGroundLightGradient() {
  const g = el("radialGradient", { id: "rocket-ground-light", cx: "50%", cy: "50%", r: "50%" });
  g.appendChild(el("stop", { offset: "0%", "stop-color": "#ffb347", "stop-opacity": "0.45" }));
  g.appendChild(el("stop", { offset: "100%", "stop-color": "#ffb347", "stop-opacity": "0" }));
  return g;
}

// Subtle cool blue/purple atmospheric depth wash, centered above the pad.
function buildAtmoGradient() {
  const g = el("radialGradient", { id: "rocket-atmo", cx: "50%", cy: "38%", r: "75%" });
  g.appendChild(el("stop", { offset: "0%", "stop-color": "#3d5aff", "stop-opacity": "0.10" }));
  g.appendChild(el("stop", { offset: "55%", "stop-color": "#7a4dff", "stop-opacity": "0.06" }));
  g.appendChild(el("stop", { offset: "100%", "stop-color": "#7a4dff", "stop-opacity": "0" }));
  return g;
}

// Shared dark-metal material for fins/engine body/side nozzles, so those
// pieces read as one machined assembly instead of separate flat-color
// shapes (nozzleMain excluded — renderer.js owns its fill at runtime).
function buildMetalGradient() {
  // Darker overall with a brighter mechanical sheen band (was a narrower,
  // lighter-average range) so engine/fin parts read as darker, harder
  // machined metal against the brighter hull.
  const g = el("linearGradient", { id: "rocket-metal-gradient", x1: "0", y1: "0", x2: "1", y2: "0" });
  [["0%", "#0c1020"], ["38%", "#3d4a70"], ["65%", "#1c2438"], ["100%", "#080a14"]].forEach(([offset, color]) => {
    g.appendChild(el("stop", { offset, "stop-color": color }));
  });
  return g;
}

// --- scene elements ---------------------------------------------------

function buildStars() {
  const group = el("g", { class: "rocket-stars" });
  const nodes = [];
  for (let i = 0; i < STAR_COUNT; i++) {
    const x = VIEW_MIN_X + ((i * 41.3) % VIEW_WIDTH);
    const y = ((i * 67.3) % 300) + 6;
    const r = 0.6 + ((i * 11) % 5) * 0.2;
    const star = el("circle", { cx: x.toFixed(1), cy: y.toFixed(1), r: r.toFixed(2), fill: "#dfe6f5" });
    star.style.animationDelay = `${(i % 8) * 0.5}s`;
    group.appendChild(star);
    nodes.push(star);
  }
  return { group, nodes };
}

function buildTower() {
  // Service gantry silhouette to one side — a slender lattice suggested
  // with a few horizontal rungs rather than dozens of decorative struts.
  const group = el("g", { transform: "translate(272,180)" });
  const mast = el("rect", { x: "-4", y: "0", width: "8", height: "220", fill: "#1a2136" });
  // Thin lit-edge highlight on one side of the mast (was flat with no edge
  // definition), matching the same light direction as the rocket's own
  // body gradient, without a heavy full outline.
  const mastEdge = el("rect", { x: "-4", y: "0", width: "1.5", height: "220", fill: "#3a4568" });
  const rungs = el("g", { fill: "none", stroke: "#2e3a5c", "stroke-width": "3" });
  [40, 80, 120, 160, 200].forEach((y) => {
    rungs.appendChild(el("line", { x1: "-4", y1: String(y), x2: "4", y2: String(y) }));
  });
  // Cross-braces at every rung gap for a clearly readable lattice truss.
  [40, 80, 120, 160].forEach((y) => {
    rungs.appendChild(el("line", { x1: "-4", y1: String(y), x2: "4", y2: String(y + 40) }));
    rungs.appendChild(el("line", { x1: "4", y1: String(y), x2: "-4", y2: String(y + 40) }));
  });
  // Raised from 196 to stay above the platform top (see buildPlatform —
  // now raised to close the gap under the rocket), so the arm doesn't
  // get buried inside the platform's solid base block.
  const arm = el("rect", { x: "-34", y: "170", width: "34", height: "6", fill: "#1a2136" });
  const lightTop = el("circle", { cx: "0", cy: "8", r: "2.4", fill: "#ff6b6b" });
  const lightMid = el("circle", { cx: "0", cy: "110", r: "2.2", fill: "#ffb347" });
  const lightLow = el("circle", { cx: "0", cy: "160", r: "2", fill: "#ffb347" });
  group.append(mast, mastEdge, rungs, arm, lightTop, lightMid, lightLow);
  return { group, lights: [lightTop, lightMid, lightLow] };
}

function buildGroundLights() {
  const group = el("g", {});
  const left = el("ellipse", { cx: "118", cy: "392", rx: "34", ry: "10", fill: "url(#rocket-ground-light)" });
  const right = el("ellipse", { cx: "222", cy: "392", rx: "34", ry: "10", fill: "url(#rocket-ground-light)" });
  left.style.opacity = "0";
  right.style.opacity = "0";
  group.append(left, right);
  return { group, left, right };
}

function buildPlatform() {
  // Widened to sit under the ~40% larger rocket (see buildRocket) — trench
  // bottom corners still match the clamp anchorX exactly, same relationship
  // as before, just at the new wider span. Raised 26px (398->372) so the
  // deck sits close under the engine cluster instead of leaving a large
  // unexplained gap — see buildEngineMount for what bridges the rest.
  const group = el("g", {});
  // Soft contact shadow so the platform reads as sitting on the ground
  // rather than floating over the dark sky/horizon.
  const groundShadow = el("ellipse", { cx: "170", cy: "410", rx: "220", ry: "16", fill: "#020308", opacity: "0.55" });
  const trench = el("path", { d: "M130,372 L210,372 L222,402 L118,402 Z", fill: "#070a12" });
  // Thicker deck (was 16, now 20) with a brighter top edge and a darker
  // underside band so the slab itself reads with real thickness/depth.
  const base = el("rect", { x: "82", y: "372", width: "176", height: "20", rx: "3", fill: "#1c2438" });
  const baseHighlight = el("rect", { x: "82", y: "372", width: "176", height: "3", fill: "#39466c" });
  const baseUnderside = el("rect", { x: "82", y: "388", width: "176", height: "4", fill: "#0e1424" });
  // A thin rivet/rail line partway down the deck face — one restrained
  // mechanical detail rather than a repeated grating pattern.
  const rail = el("line", { x1: "88", y1: "382", x2: "252", y2: "382", stroke: "#2c3654", "stroke-width": "1", opacity: "0.8" });
  // Four support legs (was two) spread across the wider deck for a
  // clearer sense of structure holding it up.
  const legL = el("rect", { x: "94", y: "392", width: "10", height: "18", fill: "#161d2c" });
  const legML = el("rect", { x: "148", y: "392", width: "8", height: "18", fill: "#12172a" });
  const legMR = el("rect", { x: "184", y: "392", width: "8", height: "18", fill: "#12172a" });
  const legR = el("rect", { x: "236", y: "392", width: "10", height: "18", fill: "#161d2c" });
  // Small always-on warm practical lights along the deck edge (distinct
  // from the renderer-driven ground-light glow, which stays off at idle).
  const practicalLights = [96, 128, 212, 244].map((x) => el("circle", { cx: String(x), cy: "375", r: "1.6", fill: "#ffb347" }));
  group.append(groundShadow, trench, base, baseHighlight, baseUnderside, rail, legL, legML, legMR, legR, ...practicalLights);
  return { group, trench, base };
}

// Bridges the small remaining gap between the engine cluster and the
// platform deck — a dark mount/collar the engines visually sit in,
// funneling down to the trench opening, so there is no floating gap.
function buildEngineMount() {
  const group = el("g", {});
  const mount = el("path", { d: "M125,360 L215,360 L210,372 L130,372 Z", fill: "url(#rocket-metal-gradient)" });
  const mountRim = el("rect", { x: "125", y: "360", width: "90", height: "2", fill: "#4a5680" });
  group.append(mount, mountRim);
  return { group };
}

function buildClamp(offsetX) {
  const anchorX = 170 + offsetX;
  // Raised from 376 to 372 to grip right at the new (raised) platform
  // deck level — see buildPlatform.
  const group = el("g", { transform: `translate(${anchorX},372)` });
  group.style.transformOrigin = `${anchorX}px 372px`;
  const arm = el("rect", {
    x: offsetX < 0 ? "-30" : "0", y: "-4", width: "30", height: "8", rx: "2", fill: "#2a3550",
  });
  const jaw = el("rect", {
    x: offsetX < 0 ? "-8" : "0", y: "-9", width: "8", height: "18", rx: "1.5", fill: "#3a4666",
  });
  const light = el("circle", { cx: offsetX < 0 ? "-28" : "28", cy: "0", r: "2.2", fill: "#ff6b6b" });
  group.append(arm, jaw, light);
  return { group, light };
}

function buildVaporPool() {
  const group = el("g", { class: "rocket-vapor" });
  const nodes = [];
  const offsets = [-20, -10, 0, 10, 20];
  for (let i = 0; i < VAPOR_COUNT; i++) {
    const puff = el("ellipse", { cx: String(offsets[i] ?? 0), cy: "0", rx: "11", ry: "6", fill: "#c9d2da" });
    puff.style.transformOrigin = `${offsets[i] ?? 0}px 0px`;
    puff.style.animationDelay = `${i * 0.32}s`;
    group.appendChild(puff);
    nodes.push(puff);
  }
  // Raised from 396 to 372 (renderer.js only ever sets opacity/custom
  // properties on this group, never its position, so moving it is safe)
  // to billow from the new, closer platform deck level.
  group.setAttribute("transform", "translate(170,372)");
  return { group, nodes };
}

function buildFlame() {
  // Booster jets shifted from +-30 to +-36 to stay under the wider booster
  // pair once the rocket body itself is scaled up (see buildRocket).
  const group = el("g", { transform: "translate(170,360)" });
  const main = el("path", { d: "M0,0 C-10,16 -12,30 0,48 C12,30 10,16 0,0 Z", fill: "url(#rocket-flame-gradient)" });
  const boosterL = el("path", { d: "M-36,0 C-41,10 -42,18 -36,28 C-30,18 -31,10 -36,0 Z", fill: "url(#rocket-flame-gradient)" });
  const boosterR = el("path", { d: "M36,0 C41,10 42,18 36,28 C30,18 31,10 36,0 Z", fill: "url(#rocket-flame-gradient)" });
  main.style.transformOrigin = "0px 0px";
  boosterL.style.transformOrigin = "-36px 0px";
  boosterR.style.transformOrigin = "36px 0px";
  group.append(main, boosterL, boosterR);
  group.style.opacity = "0";
  return { group, main, boosterL, boosterR };
}

function buildRocket() {
  const group = el("g", { transform: "translate(170,296)" });
  group.style.transformOrigin = "170px 296px";

  // Rocket is ~40% larger (SCALE) than the original art, anchored at the
  // nozzle base (ANCHOR_Y, the lowest local point) rather than the group
  // origin, so growth reads as "taller rocket, same pad-mounted engine"
  // instead of the enlarged engine sinking into the platform. `group`
  // itself (translated/vibrated/scaleY'd by renderer.js) is untouched —
  // only this inner wrapper is new, so none of renderer.js's absolute
  // pixel math (ambient vibration, launch sequence) needs to change.
  // SCALE bumped 1.4 -> 1.55 (~11% more) for extra presence; ANCHOR_Y is
  // still the nozzle base, unmoved, so nozzle/platform/clamp/flame
  // alignment (tuned for that exact pixel) stays correct un-adjusted.
  const SCALE = 1.55;
  const ANCHOR_Y = 67;
  const scaleGroup = el("g", { transform: `translate(0,${(ANCHOR_Y * (1 - SCALE)).toFixed(2)}) scale(${SCALE})` });

  const engineGlow = el("ellipse", { cx: "0", cy: "64", rx: "34", ry: "16", fill: "url(#rocket-engine-glow)" });
  engineGlow.style.opacity = "0";

  // Boosters painted BEFORE the fuselage, but now sized so their outer
  // edge clears the fuselage's own edge by a clear margin at every height
  // (only a slim inner overlap remains, read as the attachment seam) —
  // they stay visible as external pods instead of disappearing behind it.
  const boosterL = buildBooster(-1);
  const boosterR = buildBooster(1);

  // One continuous tapered silhouette from nose tip to engine base — nose
  // tip position/height unchanged, but the body now flares much wider
  // through the middle/lower fuselage for a more substantial central body.
  // Thin, dark-blue-tinted edge stroke (not black) crisps the silhouette
  // against the sky without reading as a heavy cartoon outline.
  const fuselage = el("path", {
    d: "M0,-82 C14,-62 19,-38 20,-14 C21,6 24,22 28,44 L-28,44 C-24,22 -21,6 -20,-14 C-19,-38 -14,-62 0,-82 Z",
    fill: "url(#rocket-body-gradient)",
    stroke: "#4a5470",
    "stroke-width": "0.6",
  });

  // Layered engine section: a trapezoid skirt (was a plain rect) plus a
  // darker collar plate the nozzle cluster sits on, widened to match the
  // wider fuselage base. Same y-range (44-62) as before so nozzle
  // positions below stay correct un-adjusted.
  const engineSkirt = el("path", { d: "M-28,44 L28,44 L18,62 L-18,62 Z", fill: "url(#rocket-metal-gradient)" });
  const engineCollar = el("ellipse", { cx: "0", cy: "61", rx: "19", ry: "4", fill: "#080a14" });

  // Slimmer, more swept fin blades (was an oversized wedge) attached
  // further down the now-wider lower body.
  const finL = el("path", { d: "M-19,22 C-26,26 -33,36 -36,52 L-30,48 C-27,38 -22,30 -18,28 Z", fill: "url(#rocket-metal-gradient)" });
  const finR = el("path", { d: "M19,22 C26,26 33,36 36,52 L30,48 C27,38 22,30 18,28 Z", fill: "url(#rocket-metal-gradient)" });

  // Thin cool-blue specular highlight down the fuselage, plus one
  // restrained seam marking the fuselage/engine transition and a shorter
  // accent band — deliberately fewer, subtler lines than a hard ring.
  const highlightLine = el("line", { x1: "-7", y1: "-72", x2: "-7", y2: "34", stroke: "#8fb4ff", "stroke-width": "1.5", opacity: "0.45", "stroke-linecap": "round" });
  // Restrained white specular streak, positioned at the body gradient's own
  // brightest band so it reads as a real reflection rather than a decal.
  const specular = el("line", { x1: "-14", y1: "-64", x2: "-14", y2: "-4", stroke: "#ffffff", "stroke-width": "1", opacity: "0.35", "stroke-linecap": "round" });
  const engineSeam = el("line", { x1: "-28", y1: "44", x2: "28", y2: "44", stroke: "#6b7690", "stroke-width": "1.2", opacity: "0.7" });
  const stripe = el("rect", { x: "-19", y: "6", width: "38", height: "5", fill: "#5b8cff" });

  const windowGlass = el("circle", { cx: "0", cy: "-36", r: "9.5", fill: "url(#rocket-window-gradient)" });
  // Faint accent halo behind the rim for a slightly more premium cockpit-
  // window bezel, echoing the same accent blue used by the stripe/highlight.
  const windowOuterRing = el("circle", { cx: "0", cy: "-36", r: "13.5", fill: "none", stroke: "#5b8cff", "stroke-width": "1", opacity: "0.35" });
  const windowRim = el("circle", { cx: "0", cy: "-36", r: "11.5", fill: "none", stroke: "#c7cede", "stroke-width": "2" });
  const windowHighlight = el("circle", { cx: "-2.5", cy: "-38.5", r: "2.4", fill: "#5b8cff", opacity: "0.55" });

  const nozzleMain = el("ellipse", { cx: "0", cy: "62", rx: "10", ry: "5", fill: "#3d4a6b" });
  const nozzleL = el("ellipse", { cx: "-14", cy: "58", rx: "5", ry: "3", fill: "url(#rocket-metal-gradient)" });
  const nozzleR = el("ellipse", { cx: "14", cy: "58", rx: "5", ry: "3", fill: "url(#rocket-metal-gradient)" });

  scaleGroup.append(
    engineGlow, boosterL.group, boosterR.group, fuselage, engineSkirt, engineCollar, finL, finR,
    highlightLine, specular, engineSeam, stripe, windowOuterRing, windowRim, windowGlass, windowHighlight,
    nozzleMain, nozzleL, nozzleR,
  );
  group.appendChild(scaleGroup);

  return { group, engineGlow, nozzleMain, windowHighlight, boosterL, boosterR };
}

// A clearly external, substantial booster (mirror: -1 left, 1 right) with
// its own dark nose cap and engine-nozzle terminus — wider and moved
// farther out than before, and extending lower so it visibly ends in its
// own engine area rather than trailing off level with the main body.
function buildBooster(mirror) {
  const m = mirror;
  const group = el("g", {});
  // Body now extends to local y=64 (was 58) and the nozzle sits lower and
  // bigger (was a small nub ending well above the main engine) so the
  // booster visibly reaches down toward the platform instead of trailing
  // off in mid-air beside the main engine.
  const body = el("path", {
    d: `M${20 * m},-24 C${29 * m},-14 ${34 * m},6 ${34 * m},24 C${34 * m},38 ${29 * m},52 ${24 * m},64 L${18 * m},64 C${18 * m},46 ${19 * m},22 ${21 * m},0 C${21 * m},-12 ${17 * m},-18 ${20 * m},-24 Z`,
    fill: "url(#rocket-body-gradient)",
    stroke: "#4a5470",
    "stroke-width": "0.6",
  });
  const noseCap = el("path", {
    d: `M${20 * m},-24 C${26 * m},-16 ${29 * m},-4 ${28 * m},8 L${18 * m},8 C${18 * m},-4 ${16 * m},-16 ${20 * m},-24 Z`,
    fill: "url(#rocket-metal-gradient)",
  });
  const nozzle = el("ellipse", { cx: `${24 * m}`, cy: "65", rx: "6", ry: "6", fill: "url(#rocket-metal-gradient)" });
  const highlight = el("line", {
    x1: `${25 * m}`, y1: "-10", x2: `${25 * m}`, y2: "36",
    stroke: "#8fb4ff", "stroke-width": "1", opacity: "0.4", "stroke-linecap": "round",
  });
  group.append(body, noseCap, nozzle, highlight);
  return { group, body };
}
