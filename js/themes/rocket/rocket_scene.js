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

const STAR_COUNT = 16;
const VAPOR_COUNT = 5;

export function buildScene(stageEl) {
  const svg = el("svg", { viewBox: "0 0 340 460", width: "100%", height: "100%", class: "theme-rocket" });

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
  );
  svg.appendChild(defs);

  const sky = el("rect", { x: "0", y: "0", width: "340", height: "460", fill: "url(#rocket-sky)" });
  svg.appendChild(sky);

  const stars = buildStars();
  svg.appendChild(stars.group);

  const horizonGlow = el("ellipse", { cx: "170", cy: "420", rx: "260", ry: "80", fill: "url(#rocket-horizon-glow)" });
  svg.appendChild(horizonGlow);

  const tower = buildTower();
  svg.appendChild(tower.group);

  const groundLight = buildGroundLights();
  svg.appendChild(groundLight.group);

  const platform = buildPlatform();
  svg.appendChild(platform.group);

  const clampL = buildClamp(-42);
  const clampR = buildClamp(42);
  svg.append(clampL.group, clampR.group);

  const vapor = buildVaporPool();
  svg.appendChild(vapor.group);

  const flame = buildFlame();
  svg.appendChild(flame.group);

  const haze = el("rect", { x: "0", y: "330", width: "340", height: "130", fill: "url(#rocket-haze)" });
  svg.appendChild(haze);

  const rocket = buildRocket();
  svg.appendChild(rocket.group);

  stageEl.appendChild(svg);

  return { svg, sky, stars, horizonGlow, haze, tower, groundLight, platform, clampL, clampR, vapor, flame, rocket };
}

// --- gradients (built once, referenced by fill="url(#...)") ---------------

function buildSkyGradient() {
  const g = el("linearGradient", { id: "rocket-sky", x1: "0", y1: "0", x2: "0", y2: "1" });
  [["0%", "#050810"], ["60%", "#0b1224"], ["100%", "#131c34"]].forEach(([offset, color]) => {
    g.appendChild(el("stop", { offset, "stop-color": color }));
  });
  return g;
}

function buildHorizonGlow() {
  const g = el("radialGradient", { id: "rocket-horizon-glow", cx: "50%", cy: "50%", r: "50%" });
  g.appendChild(el("stop", { offset: "0%", "stop-color": "#3d5a80", "stop-opacity": "0.32" }));
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
  const g = el("linearGradient", { id: "rocket-body-gradient", x1: "0", y1: "0", x2: "1", y2: "0" });
  [["0%", "#c7cede"], ["45%", "#f4f6fa"], ["70%", "#dfe6f0"], ["100%", "#b9c2d6"]].forEach(([offset, color]) => {
    g.appendChild(el("stop", { offset, "stop-color": color }));
  });
  return g;
}

function buildGroundLightGradient() {
  const g = el("radialGradient", { id: "rocket-ground-light", cx: "50%", cy: "50%", r: "50%" });
  g.appendChild(el("stop", { offset: "0%", "stop-color": "#ffb347", "stop-opacity": "0.45" }));
  g.appendChild(el("stop", { offset: "100%", "stop-color": "#ffb347", "stop-opacity": "0" }));
  return g;
}

// --- scene elements ---------------------------------------------------

function buildStars() {
  const group = el("g", { class: "rocket-stars" });
  const nodes = [];
  for (let i = 0; i < STAR_COUNT; i++) {
    const x = (i * 53.1) % 340;
    const y = ((i * 67.3) % 260) + 8;
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
  const rungs = el("g", { fill: "none", stroke: "#242c46", "stroke-width": "3" });
  [40, 80, 120, 160, 200].forEach((y) => {
    rungs.appendChild(el("line", { x1: "-4", y1: String(y), x2: "4", y2: String(y) }));
  });
  const arm = el("rect", { x: "-34", y: "196", width: "34", height: "6", fill: "#1a2136" });
  const lightTop = el("circle", { cx: "0", cy: "8", r: "2.4", fill: "#ff6b6b" });
  const lightMid = el("circle", { cx: "0", cy: "110", r: "2.2", fill: "#ffb347" });
  group.append(mast, rungs, arm, lightTop, lightMid);
  return { group, lights: [lightTop, lightMid] };
}

function buildGroundLights() {
  const group = el("g", {});
  const left = el("ellipse", { cx: "118", cy: "418", rx: "34", ry: "10", fill: "url(#rocket-ground-light)" });
  const right = el("ellipse", { cx: "222", cy: "418", rx: "34", ry: "10", fill: "url(#rocket-ground-light)" });
  left.style.opacity = "0";
  right.style.opacity = "0";
  group.append(left, right);
  return { group, left, right };
}

function buildPlatform() {
  const group = el("g", {});
  const trench = el("path", { d: "M140,398 L200,398 L212,428 L128,428 Z", fill: "#070a12" });
  const base = el("rect", { x: "92", y: "398", width: "156", height: "16", rx: "3", fill: "#1c2438" });
  const baseHighlight = el("rect", { x: "92", y: "398", width: "156", height: "3", fill: "#2c3654" });
  const legL = el("rect", { x: "104", y: "412", width: "10", height: "18", fill: "#161d2c" });
  const legR = el("rect", { x: "226", y: "412", width: "10", height: "18", fill: "#161d2c" });
  group.append(trench, base, baseHighlight, legL, legR);
  return { group, trench, base };
}

function buildClamp(offsetX) {
  const anchorX = 170 + offsetX;
  const group = el("g", { transform: `translate(${anchorX},376)` });
  group.style.transformOrigin = `${anchorX}px 376px`;
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
  group.setAttribute("transform", "translate(170,396)");
  return { group, nodes };
}

function buildFlame() {
  const group = el("g", { transform: "translate(170,360)" });
  const main = el("path", { d: "M0,0 C-10,16 -12,30 0,48 C12,30 10,16 0,0 Z", fill: "url(#rocket-flame-gradient)" });
  const boosterL = el("path", { d: "M-30,0 C-35,10 -36,18 -30,28 C-24,18 -25,10 -30,0 Z", fill: "url(#rocket-flame-gradient)" });
  const boosterR = el("path", { d: "M30,0 C35,10 36,18 30,28 C24,18 25,10 30,0 Z", fill: "url(#rocket-flame-gradient)" });
  main.style.transformOrigin = "0px 0px";
  boosterL.style.transformOrigin = "-30px 0px";
  boosterR.style.transformOrigin = "30px 0px";
  group.append(main, boosterL, boosterR);
  group.style.opacity = "0";
  return { group, main, boosterL, boosterR };
}

function buildRocket() {
  const group = el("g", { transform: "translate(170,296)" });
  group.style.transformOrigin = "170px 296px";

  const engineGlow = el("ellipse", { cx: "0", cy: "64", rx: "34", ry: "16", fill: "url(#rocket-engine-glow)" });
  engineGlow.style.opacity = "0";

  // Boosters flank the main stage, attached roughly mid-body.
  const boosterL = buildBoosterShape(-26);
  const boosterR = buildBoosterShape(26);

  const finL = el("path", { d: "M-16,44 L-34,66 L-12,58 Z", fill: "#232c46" });
  const finR = el("path", { d: "M16,44 L34,66 L12,58 Z", fill: "#232c46" });

  // Two-stage body: lower stage (wider) + upper stage (tapered), divided
  // by a panel line so the silhouette reads as "multi-stage" at a glance.
  const lowerStage = el("path", {
    d: "M0,-18 C17,-8 19,20 19,44 L-19,44 C-19,20 -17,-8 0,-18 Z",
    fill: "url(#rocket-body-gradient)",
  });
  const upperStage = el("path", {
    d: "M0,-78 C13,-62 15,-34 15,-18 L-15,-18 C-15,-34 -13,-62 0,-78 Z",
    fill: "url(#rocket-body-gradient)",
  });
  const nose = el("path", { d: "M0,-78 C5,-70 8,-60 10,-50 L-10,-50 C-8,-60 -5,-70 0,-78 Z", fill: "#e4e9f2" });

  const panelLine = el("line", { x1: "-19", y1: "-18", x2: "19", y2: "-18", stroke: "#9aa4b8", "stroke-width": "1.5" });
  const stripe = el("rect", { x: "-19", y: "6", width: "38", height: "6", fill: "#5b8cff" });

  const windowGlass = el("circle", { cx: "0", cy: "-36", r: "9", fill: "#141a2b" });
  const windowRim = el("circle", { cx: "0", cy: "-36", r: "10.5", fill: "none", stroke: "#c7cede", "stroke-width": "1.5" });
  const windowHighlight = el("circle", { cx: "-2.5", cy: "-38.5", r: "2.4", fill: "#5b8cff", opacity: "0.55" });

  const engineBody = el("rect", { x: "-20", y: "44", width: "40", height: "18", rx: "3", fill: "#232c46" });
  const nozzleMain = el("ellipse", { cx: "0", cy: "62", rx: "10", ry: "5", fill: "#3d4a6b" });
  const nozzleL = el("ellipse", { cx: "-14", cy: "58", rx: "5", ry: "3", fill: "#3d4a6b" });
  const nozzleR = el("ellipse", { cx: "14", cy: "58", rx: "5", ry: "3", fill: "#3d4a6b" });

  group.append(
    engineGlow, boosterL.group, boosterR.group, finL, finR, lowerStage, upperStage, nose,
    panelLine, stripe, windowRim, windowGlass, windowHighlight,
    engineBody, nozzleMain, nozzleL, nozzleR,
  );

  return { group, engineGlow, nozzleMain, windowHighlight, boosterL, boosterR };
}

function buildBoosterShape(offsetX) {
  const group = el("g", {});
  const body = el("path", {
    d: `M${offsetX},-4 C${offsetX + 7 * Math.sign(offsetX)},4 ${offsetX + 7 * Math.sign(offsetX)},30 ${offsetX + 7 * Math.sign(offsetX)},46 L${offsetX - 7 * Math.sign(offsetX)},46 C${offsetX - 7 * Math.sign(offsetX)},30 ${offsetX - 7 * Math.sign(offsetX)},4 ${offsetX},-4 Z`,
    fill: "#dfe6f0",
  });
  const cap = el("path", { d: `M${offsetX},-4 L${offsetX + 6 * Math.sign(offsetX)},6 L${offsetX - 6 * Math.sign(offsetX)},6 Z`, fill: "#c7cede" });
  group.append(body, cap);
  return { group, body };
}
