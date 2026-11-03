import * as THREE from 'three';
import { OrbitControls } from 'three/addons/OrbitControls.js';

const D2R = Math.PI / 180;
const $ = id => document.getElementById(id);
const CHART = [[34, 79.5, 63, 87], [36, 83.5, 66.5, 92], [38, 87.5, 70.5, 96], [40, 91.5, 75, 99.5], [42, 95.5, 79.5, 103], [44, 100, 83.5, 106.5],
  [46, 105, 88, 110.5], [48, 110.5, 93, 114.5], [50, 116.5, 99, 119.5], [52, 122.5, 105.5, 125.5], [54, 128.5, 111.5, 131.5]];

// ---------- the law
const threadAngle = (g, a) => g >= 2 * a ? null : 2 * Math.asin(g / (2 * a)) / D2R;
const lockNeeded = (top, waist) => (2 * Math.atan(top / waist) - Math.PI / 2) / D2R;
// Working window: threads close by up to `lock` at the waist and open by up to half of it over the widest girth.
// Simulation shows closing is clean, while opening over the hip is what strains the cloth first.
const windowFor = (top, waist, lock) => {
  const g = lock * D2R;
  return [top / (2 * Math.sin(Math.PI / 4 + g / 4)), waist / (2 * Math.sin(Math.PI / 4 - g / 2))];
};
const balancedA = (top, waist, lock) => {
  const [lo, hi] = windowFor(top, waist, lock);
  return lo <= hi ? (lo + hi) / 2 : top / (2 * Math.sin(Math.PI / 4 + lockNeeded(top, waist) * D2R / 2));
};

function cover(lock) {
  const iv = CHART.map(([size, b, w, h]) => ({ size, top: Math.max(b, h), w, win: windowFor(Math.max(b, h), w, lock) }));
  if (iv.some(x => x.win[0] > x.win[1])) return { iv, groups: null };
  const sorted = [...iv].sort((p, q) => p.win[1] - q.win[1]);
  const groups = [];
  for (const x of sorted) {
    const g = groups[groups.length - 1];
    if (g && x.win[0] <= g.pin) g.members.push(x);
    else groups.push({ pin: x.win[1], members: [x] });
  }
  // Keep the fewest cuts, then choose the split with the most tolerance on its tightest cut.
  const k = groups.length, ordered = [...iv].sort((p, q) => p.size - q.size), n = ordered.length;
  const span = (i, j) => {
    const part = ordered.slice(i, j);
    return { lo: Math.max(...part.map(m => m.win[0])), hi: Math.min(...part.map(m => m.win[1])), members: part };
  };
  let best = null;
  const search = (start, left, acc) => {
    if (left === 1) {
      const all = [...acc, span(start, n)], margin = Math.min(...all.map(g => g.hi - g.lo));
      if (!best || margin > best.margin) best = { margin, all };
      return;
    }
    for (let e = start + 1; e <= n - left + 1; e++) search(e, left - 1, [...acc, span(start, e)]);
  };
  search(0, k, []);
  const chosen = best.all.map(g => ({ ...g, a: (g.lo + g.hi) / 2 }));
  return { iv, groups: chosen };
}


// ---------- dress form, same construction as engine/body.py
class Body {
  constructor(bust, waist, hip) {
    Object.assign(this, { bust, waist, hip });
    this.aspect = 1.32;
    this.bustAmp = 2.2 * bust / 88;
    this.seatAmp = 1.6 * hip / 97;
    this.heights = [-24, 0, 20, 40, 52];
    this.girths = [.93 * hip, hip, waist, bust, .94 * bust];
    this.scales = this.heights.map((z, i) => this.calibrate(z, this.girths[i]));
  }
  ellipse(t) { const A = Math.sqrt(this.aspect), B = 1 / A; return 1 / Math.sqrt((Math.cos(t) / A) ** 2 + (Math.sin(t) / B) ** 2); }
  bumps(t, z) {
    const wrap = a => Math.atan2(Math.sin(a), Math.cos(a));
    const g = (d, s) => Math.exp(-.5 * d * d / (s * s));
    const bust = g(z - 40, 5.5) * (g(wrap(t - (Math.PI / 2 - .5)), .36) + g(wrap(t - (Math.PI / 2 + .5)), .36));
    const seat = g(z, 8) * (g(wrap(t - (-Math.PI / 2 - .45)), .42) + g(wrap(t - (-Math.PI / 2 + .45)), .42));
    return this.bustAmp * bust + this.seatAmp * seat;
  }
  calibrate(z, target) {
    let lo = .5, hi = 90;
    for (let n = 0; n < 40; n++) {
      const mid = (lo + hi) / 2;
      let per = 0, px = 0, py = 0;
      for (let i = 0; i <= 360; i++) {
        const t = i * 2 * Math.PI / 360, r = mid * this.ellipse(t) + this.bumps(t, z);
        const x = r * Math.cos(t), y = r * Math.sin(t);
        if (i) per += Math.hypot(x - px, y - py);
        px = x; py = y;
      }
      if (per < target) lo = mid; else hi = mid;
    }
    return (lo + hi) / 2;
  }
  scale(z) {
    const H = this.heights;
    const zc = Math.min(H[4], Math.max(H[0], z));
    let j = 0;
    while (j < 3 && zc > H[j + 1]) j++;
    const u = (zc - H[j]) / (H[j + 1] - H[j]);
    return this.scales[j] + (this.scales[j + 1] - this.scales[j]) * .5 * (1 - Math.cos(Math.PI * u));
  }
  R(t, z) { return this.scale(z) * this.ellipse(t) + this.bumps(t, z); }
  P(t, z) { const r = this.R(t, z); return [r * Math.cos(t), r * Math.sin(t), z]; }
}

// ---------- fishnet: every new point lies one step from two neighbours in the previous row
function nextRow(body, row, h, sign) {
  const n = row.length, out = [];
  for (let i = 0; i < n; i++) {
    const a = row[i], b = row[(i + 1) % n];
    const t2 = i === n - 1 ? b[0] + 2 * Math.PI : b[0];
    let t = (a[0] + t2) / 2, z = (a[1] + b[1]) / 2;
    const A = body.P(a[0], a[1]), B = body.P(t2, b[1]);
    const half = Math.hypot(A[0] - B[0], A[1] - B[1], A[2] - B[2]) / 2;
    if (half >= h) return null;
    z += sign * Math.sqrt(h * h - half * half) * .9;
    for (let k = 0; k < 8; k++) {
      const e = 1e-3, P0 = body.P(t, z), Pt = body.P(t + e, z), Pm = body.P(t - e, z), Pz = body.P(t, z + e), Pn = body.P(t, z - e);
      const dT = [0, 1, 2].map(q => (Pt[q] - Pm[q]) / (2 * e)), dZ = [0, 1, 2].map(q => (Pz[q] - Pn[q]) / (2 * e));
      const dA = [0, 1, 2].map(q => P0[q] - A[q]), dB = [0, 1, 2].map(q => P0[q] - B[q]);
      const dot = (u, v) => u[0] * v[0] + u[1] * v[1] + u[2] * v[2];
      const f1 = dot(dA, dA) - h * h, f2 = dot(dB, dB) - h * h;
      const a11 = 2 * dot(dA, dT), a12 = 2 * dot(dA, dZ), a21 = 2 * dot(dB, dT), a22 = 2 * dot(dB, dZ);
      const det = a11 * a22 - a12 * a21;
      if (Math.abs(det) < 1e-9) return null;
      const dt = (a22 * f1 - a12 * f2) / det, dz = (a11 * f2 - a21 * f1) / det;
      t -= dt; z -= dz;
      if (Math.abs(dt) + Math.abs(dz) < 1e-7) break;
    }
    out.push([t, z]);
  }
  return out;
}

function solveNet(body, a, h = 1.5) {
  const n = Math.round(a / h);
  const seed = Array.from({ length: n }, (_, i) => [i * 2 * Math.PI / n, 20]);
  const up = [seed], down = [seed];
  for (const [list, sign, stop] of [[up, 1, 46], [down, -1, -26]]) {
    let row = seed;
    for (let k = 0; k < 400; k++) {
      const nx = nextRow(body, row, h, sign);
      if (!nx) return null;
      list.push(nx);
      row = nx;
      const zs = nx.map(p => p[1]);
      if (sign > 0 ? Math.min(...zs) > stop : Math.max(...zs) < stop) break;
    }
  }
  return { up, down, h };
}

// ---------- 3D view
const scene = new THREE.Scene();
scene.background = null;
const canvas = $('net3d');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, preserveDrawingBuffer: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
const camera = new THREE.PerspectiveCamera(30, 1, 1, 2000);
camera.up.set(0, 0, 1);
camera.position.set(-40, 230, 25);
const controls = new OrbitControls(camera, canvas);
controls.target.set(0, 0, 14);
controls.enablePan = false;
controls.minDistance = 90;
controls.maxDistance = 400;
scene.add(new THREE.HemisphereLight(0xffffff, 0xb8bedd, 2.2));
const dl = new THREE.DirectionalLight(0xffffff, 1.5);
dl.position.set(-100, 200, 150);
scene.add(dl);
let formMesh = null, netLines = null;

function formGeometry(body) {
  const nt = 96, zs = [];
  for (let z = -24; z <= 52.01; z += 1.5) zs.push(z);
  const pos = [], idx = [];
  zs.forEach(z => { for (let i = 0; i < nt; i++) pos.push(...body.P(i * 2 * Math.PI / nt, z)); });
  for (let k = 0; k < zs.length - 1; k++) for (let i = 0; i < nt; i++) {
    const j = (i + 1) % nt, a = k * nt + i, b = k * nt + j, c = (k + 1) * nt + j, d = (k + 1) * nt + i;
    idx.push(a, b, c, a, c, d);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

function netGeometry(body, net) {
  const blue = [], coral = [];
  const out = (t, z) => { const r = body.R(t, z) + .25; return [r * Math.cos(t), r * Math.sin(t), z]; };
  const add = (rows, sign) => {
    for (let k = 0; k < rows.length - 1; k++) {
      const R0 = rows[k], R1 = rows[k + 1], n = R0.length;
      for (let i = 0; i < n; i++) {
        const q = R1[i];
        const a = R0[i], b = R0[(i + 1) % n];
        if (q[1] > 52 || q[1] < -24 || a[1] > 52 || a[1] < -24 || b[1] > 52 || b[1] < -24) continue;
        blue.push(...out(a[0], a[1]), ...out(q[0], q[1]));
        coral.push(...out(b[0], b[1]), ...out(q[0], q[1]));
      }
    }
  };
  add(net.up, 1); add(net.down, -1);
  const mk = (arr, col) => {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(arr, 3));
    return new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color: col }));
  };
  const group = new THREE.Group();
  group.add(mk(blue, 0x1b2f9e), mk(coral, 0xe8603c));
  return group;
}

function resize() {
  const w = canvas.clientWidth, h = canvas.clientHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
new ResizeObserver(resize).observe(canvas);
renderer.setAnimationLoop(() => { controls.update(); renderer.render(scene, camera); });

// ---------- state
const val = id => parseFloat($(id).value);
let netTimer = null;
function updateNet() {
  clearTimeout(netTimer);
  netTimer = setTimeout(() => {
    const body = new Body(val('bust'), val('waist'), val('hip'));
    if (formMesh) { scene.remove(formMesh); formMesh.geometry.dispose(); }
    formMesh = new THREE.Mesh(formGeometry(body), new THREE.MeshStandardMaterial({ color: 0xdfe2ee, roughness: .85, side: THREE.DoubleSide }));
    scene.add(formMesh);
    if (netLines) { scene.remove(netLines); netLines = null; }
    const net = solveNet(body, val('a'));
    if (net) { netLines = netGeometry(body, net); scene.add(netLines); }
    canvas.dataset.net = net ? 'ok' : 'none';
  }, 60);
}

function updateFit() {
  const bust = val('bust'), waist = val('waist'), hip = val('hip'), a = val('a'), lock = val('lock');
  $('aOut').textContent = `${a.toFixed(1)} cm`;
  $('lockOut').textContent = `${lock}°`;
  const top = Math.max(bust, hip), narrow = Math.min(waist, bust, hip);
  const w = g => threadAngle(g, a);
  const show = (id, v) => { $(id).textContent = v === null ? 'beyond the cloth' : `${v.toFixed(1)}°`; };
  show('wHip', w(hip)); show('wWaist', w(waist)); show('wBust', w(bust));
  const angles = [w(hip), w(waist), w(bust)];
  const v = $('verdict');
  if (angles.includes(null)) {
    $('shear').textContent = '\u2014';
    v.className = 'verdict no';
    v.textContent = `This cut is too narrow for a ${top} cm girth.`;
  } else {
    const opening = Math.max(0, ...angles.map(x => x - 90)), closing = Math.max(0, ...angles.map(x => 90 - x));
    $('shear').textContent = `opens ${opening.toFixed(1)}\u00b0, closes ${closing.toFixed(1)}\u00b0`;
    const openOK = opening <= lock / 2, closeOK = closing <= lock;
    if (openOK && closeOK) { v.className = 'verdict ok'; v.textContent = 'This cut fits this body.'; }
    else if (!openOK) { v.className = 'verdict no'; v.textContent = `Too tight over the widest girth: threads would open ${opening.toFixed(1)}\u00b0, beyond ${(lock / 2).toFixed(1)}\u00b0. Choose a wider cut.`; }
    else { v.className = 'verdict no'; v.textContent = `Too loose at the waist: threads would close ${closing.toFixed(1)}\u00b0, beyond ${lock}\u00b0. Choose a narrower cut.`; }
  }
  $('need').textContent = `${lockNeeded(top, narrow).toFixed(1)}°`;
  updateCut();
  updateNet();
}

// ---------- cut sheet
function cutPlan() {
  const a = val('a'), strips = 4, allowance = 1, hem = 1.5, length = 200, roll = 150;
  const finished = a / strips;
  const cutW = finished + 2 * allowance, cutL = length + 2 * hem;
  const across = Math.floor(roll / cutW);
  const band = Math.max(0, roll - across * cutW);
  return { a, strips, finished, cutW, cutL, across, allowance, roll, band, perGarmentM2: strips / across * roll * cutL / 1e4 };
}

function markerSVG(p, scale = 3) {
  const W = p.roll, H = p.cutL;
  const pad = 22, T = (x, y, txt, col = '#fff', extra = '') => `<text x="${x}" y="${y}" fill="${col}" font-size="14" font-family="Segoe UI,sans-serif" ${extra}>${txt}</text>`;
  const parts = [`<svg xmlns="http://www.w3.org/2000/svg" viewBox="${-pad} ${-pad} ${H * scale + 2 * pad} ${W * scale + 2 * pad}">`];
  let y = 0;
  for (let i = 0; i < p.across; i++) {
    const dress = Math.floor(i / p.strips) + 1, n = i % p.strips + 1;
    parts.push(`<rect x="0" y="${y}" width="${H * scale}" height="${p.cutW * scale}" fill="${dress === 1 ? '#3b55d9' : '#9fadee'}" stroke="#fff" stroke-width="1.5"/>`);
    parts.push(T(14, y + p.cutW * scale / 2 + 5, `Dress ${dress}, strip ${n}`));
    y += p.cutW * scale;
  }
  if (p.band > .5) {
    parts.push(`<rect x="0" y="${y}" width="${H * scale}" height="${p.band * scale}" fill="#e8603c" stroke="#fff" stroke-width="1.5"/>`);
    if (p.band * scale > 18) parts.push(T(14, y + p.band * scale / 2 + 5, 'Sash, ties and cord'));
  }
  parts.push(T(H * scale / 2, -7, `${H.toFixed(0)} cm along the roll`, '#5b628a', 'text-anchor="middle"'));
  parts.push(T(-8, W * scale / 2, `${W} cm roll`, '#5b628a', `text-anchor="middle" transform="rotate(-90 -8 ${W * scale / 2})"`));
  parts.push('</svg>');
  return parts.join('');
}

function updateCut() {
  const p = cutPlan();
  $('marker').outerHTML = markerSVG(p).replace('<svg ', '<svg id="marker" role="img" aria-label="Cut layout on a 150 cm roll" ');
  const rows = [
    ['Strips per dress', `${p.strips}, each ${p.cutW.toFixed(1)} \u00d7 ${p.cutL.toFixed(0)} cm`],
    ['Strips across a 150 cm roll', `${p.across}`],
    ['Finished strip width', `${p.finished.toFixed(1)} cm`],
    ['Each seam steps down by', `${p.finished.toFixed(1)} cm`],
    ['Band left for sash, ties, cord', `${p.band.toFixed(1)} cm`],
    ['Roll per dress', `${p.perGarmentM2.toFixed(2)} m\u00b2`],
    ['Curved cut lines', '0'],
    ['Allowance on each long edge', `${p.allowance} cm`],
  ];
  $('cutFacts').innerHTML = rows.map(([k, v]) => `<div><dt>${k}</dt><dd>${v}</dd></div>`).join('');
}

function printSheet() {
  const p = cutPlan();
  const b = val('bust'), w = val('waist'), h = val('hip');
  $('sheet').innerHTML = `<h1>Good Bias cut sheet</h1>
    <p>Body: bust ${b}, waist ${w}, hip ${h} cm. Total strip width a = ${p.a.toFixed(1)} cm. The roll shows every strip that fits across it; each dress takes four.</p>
    ${markerSVG(p)}
    <table><tr><th>Piece</th><th>Per dress</th><th>Size, cm</th></tr>
    <tr><td>Strip</td><td>${p.strips}</td><td>${p.cutW.toFixed(1)} \u00d7 ${p.cutL.toFixed(0)}</td></tr>
    <tr><td>Band for sash, ties and cord</td><td>shared</td><td>${p.band.toFixed(1)} \u00d7 ${p.cutL.toFixed(0)}, torn along a thread</td></tr></table>
    <ol><li>Tear all pieces along a thread.</li>
    <li>Join each long edge to the next, stepped down by ${p.finished.toFixed(1)} cm. Close the last seam to the first to make a tube.</li>
    <li>Fold the top points inside along one hoop. Stitch a casing and thread the cord.</li>
    <li>Fold the bottom points inside along one hoop. Stitch a level hem.</li>
    <li>Stitch the two neck ties to the front of the casing. Cut the sash from the band.</li></ol>`;
  window.print();
}

// ---------- size chart
function updateSizes() {
  const lock = val('lock2');
  $('lockOut2').textContent = `${lock}°`;
  const { iv, groups } = cover(lock);
  $('coverLine').textContent = groups
    ? `${groups.length} cut${groups.length > 1 ? 's' : ''} for all 11 sizes: ` + groups.map(g => `a = ${g.a.toFixed(1)} cm, sizes ${g.members[0].size}–${g.members[g.members.length - 1].size}`).join('; ')
    : `At ${lock}° some sizes do not fit a single tube.`;
  const lo = 45, hi = 120, pct = x => `${(100 * (Math.min(hi, Math.max(lo, x)) - lo) / (hi - lo)).toFixed(2)}%`;
  $('bars').innerHTML = [...iv].sort((p, q) => p.size - q.size).map(x => {
    const ok = x.win[0] <= x.win[1];
    const pins = (groups || []).map(g => `<span class="pin" style="left:${pct(g.a)}"></span>`).join('');
    const bar = ok ? `<span class="iv" style="left:${pct(x.win[0])};width:calc(${pct(x.win[1])} - ${pct(x.win[0])})"></span>`
      : `<span class="iv none" style="left:${pct(x.win[1])};width:calc(${pct(x.win[0])} - ${pct(x.win[1])})"></span>`;
    return `<div class="bar"><span>Size ${x.size}</span><span class="track">${bar}${pins}</span></div>`;
  }).join('');
}

// ---------- simulation results
async function loadPhysics() {
  try {
    const f = await (await fetch('assets/final2.json')).json();
    const hero = f.sizes['38'], ctrl = f.control;
    $('physLead').textContent = `Under the same sash, the bias threads close from 90° to ${hero.sash_w.toFixed(1)}° at the waist of size 38, where a perfect fit needs ${hero.law.toFixed(1)}°, leaving ${hero.excess_pct.toFixed(1)}% spare cloth. The straight-grain threads stay at ${ctrl.sash_w.toFixed(1)}°, with ${ctrl.excess_pct.toFixed(0)}% spare cloth that can only gather.`;
    const ids = Object.keys(f.sizes).sort((p, q) => +p - +q);
    const rows = ids.map(k => {
      const r = f.sizes[k];
      return `<tr><td>${k}</td><td>${r.a.toFixed(1)}</td><td>${r.sash_w.toFixed(1)}°</td><td>${r.law.toFixed(1)}°</td><td>${r.excess_pct.toFixed(1)}%</td><td>${r.strain_mean.toFixed(1)}%</td></tr>`;
    }).join('');
    $('physTable').innerHTML = `<tr><th>Size</th><th>a, cm</th><th>Waist angle, simulated</th><th>Waist angle for a perfect fit</th><th>Excess cloth at waist</th><th>Mean thread strain</th></tr>${rows}`;
    $('physNote').textContent = 'GPU simulation of woven cloth: stiff threads, soft shear up to a lock, bending, friction between threads, contact with a full human body mesh matched to bust, waist and hip, and cloth touching itself. Declared cloth: 180 g/m², shear rigidity 2.5 N/m per radian, 35° lock, thread friction 0.3. Dressing: neck tied, skirt smoothed down, sash tied, arms lowered. Angle under the sash, compared with the angle at which the cloth hoop would equal the girth under it.';
  } catch (e) { console.warn(e); }
}

// ---------- the grain law and the garment map
function updateGrain() {
  const phi = val('phi'), lock = val('lock3');
  $('phiOut').textContent = `${phi}\u00b0`;
  $('lockOut3').textContent = `${lock}\u00b0`;
  const q = Math.sin(lock * D2R) * Math.sin(2 * phi * D2R);
  const f = Math.sqrt((1 + q) / (1 - q));
  $('grainLine').textContent = phi === 0 ? 'On the straight grain, the line cannot change length at all: factor 1.00.' : `This line can change length by a factor of ${f.toFixed(2)}, without folding.`;
  $('grainLine').dataset.factor = f.toFixed(3);
}

async function loadBodies() {
  try {
    const b = await (await fetch('assets/bodies.json')).json();
    const [w0, w1] = b.waist;
    $('bodyLine').textContent = `On ${b.n_women.toLocaleString('en-GB')} women measured in ANSUR II, the US Army's 2012 survey, one cut serves ${(100 * w1.best1).toFixed(0)} to ${(100 * w0.best1).toFixed(0)}% and the three cuts serve ${(100 * w1.plan).toFixed(0)} to ${(100 * w0.plan).toFixed(0)}%, depending on where the waist is taken.`;
    const cell = c => c.cuts === null ? (c.feasible < .5 ? 'one uncut tube cannot' : 'over 6') : `${c.cuts}`;
    $('mapTable').innerHTML = `<tr><th>Tube</th><th>Girth ratio</th><th>Median lock needed</th><th>Cuts for 95% of bodies, lock 30\u00b0</th></tr>` + b.garments.map(g => `<tr><td>${g.name}</td><td>${g.ratio.toFixed(2)}</td><td>${g.p50.toFixed(0)}\u00b0</td><td>${cell(g.l30)}</td></tr>`).join('');
  } catch (e) { console.warn(e); }
}

for (const id of ['bust', 'waist', 'hip', 'a', 'lock']) $(id).addEventListener('input', updateFit);
for (const id of ['phi', 'lock3']) $(id).addEventListener('input', updateGrain);
$('bestA').addEventListener('click', () => {
  const top = Math.max(val('bust'), val('hip')), narrow = Math.min(val('waist'), val('bust'), val('hip'));
  $('a').value = (Math.round(balancedA(top, narrow, val('lock')) * 2) / 2).toString();
  updateFit();
});
$('lock2').addEventListener('input', updateSizes);
$('printBtn').addEventListener('click', printSheet);
resize();
updateFit();
updateSizes();
updateGrain();
loadPhysics();
loadBodies();
