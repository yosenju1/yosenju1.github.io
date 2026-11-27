import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { BokehPass } from 'three/addons/postprocessing/BokehPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';

const W = 1080, H = 1920;
const params = new URLSearchParams(location.search);
const SCALE = parseFloat(params.get('scale') || '1');

// ---------- helpers ----------
const clamp = (x, a = 0, b = 1) => Math.min(b, Math.max(a, x));
const lerp = (a, b, t) => a + (b - a) * t;
const seg = (T, a, b) => clamp((T - a) / (b - a));
const ease = t => t * t * t * (t * (t * 6 - 15) + 10);
const eseg = (T, a, b) => ease(seg(T, a, b));
const v3 = (x, y, z) => new THREE.Vector3(x, y, z);
const lerpV = (a, b, t) => a.clone().lerp(b, t);
function rng(seed) { return () => { seed |= 0; seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
const R = rng(1234);
const rr = (a, b) => a + (b - a) * R();
const pick = arr => arr[Math.floor(R() * arr.length)];

// ---------- renderer ----------
const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
renderer.setPixelRatio(1);
renderer.setSize(W * SCALE, H * SCALE);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.0;
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(40, W / H, 0.1, 400);
scene.fog = new THREE.FogExp2(0x5a625c, 0.03);
scene.background = new THREE.Color(0x5a625c);

// ---------- revive uniforms ----------
const U = {
  uR: { value: -5 },            // revive wave radius
  uC: { value: new THREE.Vector3(0, 0, 1) },
  uEdge: { value: 0 },
};

function envMaterial(opts = {}) {
  const m = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.42, metalness: 0.0, ...opts });
  m.onBeforeCompile = sh => {
    sh.uniforms.uR = U.uR; sh.uniforms.uC = U.uC; sh.uniforms.uEdge = U.uEdge;
    sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nvarying vec3 vWP;')
      .replace('#include <project_vertex>', `#include <project_vertex>
        vec4 wp4 = vec4(transformed,1.0);
        #ifdef USE_INSTANCING
          wp4 = instanceMatrix * wp4;
        #endif
        vWP = (modelMatrix * wp4).xyz;`);
    sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>\nvarying vec3 vWP;uniform float uR;uniform vec3 uC;uniform float uEdge;')
      .replace('#include <color_fragment>', `#include <color_fragment>
        float dR = distance(vWP.xz, uC.xz);
        float kR = 1.0 - smoothstep(uR - 2.5, uR, dR);
        float lum = dot(diffuseColor.rgb, vec3(0.299,0.587,0.114));
        vec3 wilt = mix(diffuseColor.rgb, vec3(lum)*vec3(0.95,0.97,0.80), 0.82) * 0.62;
        diffuseColor.rgb = mix(wilt, diffuseColor.rgb * 1.12, kR);`)
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
        float edgeR = smoothstep(uR - 3.5, uR - 0.6, dR) * (1.0 - smoothstep(uR - 0.6, uR + 0.4, dR));
        totalEmissiveRadiance += vec3(0.55, 1.0, 0.45) * edgeR * uEdge;`);
  };
  return m;
}
const ENV = envMaterial();

// ---------- geometry builders ----------
const PITCH = 0.8, PLATE = 0.32;
const studGeo = new THREE.CylinderGeometry(0.24, 0.24, 0.17, 12, 1, false);
const geoCache = new Map();
function brickGeo(w, d, plates, studs = true) {
  const key = `${w}_${d}_${plates}_${studs}`;
  if (geoCache.has(key)) return geoCache.get(key);
  const bw = w * PITCH - 0.03, bd = d * PITCH - 0.03, bh = plates * PLATE - 0.01;
  const parts = [];
  let box = new RoundedBoxGeometry(bw, bh, bd, 2, Math.min(0.05, bh * 0.3)); if (box.index) box = box.toNonIndexed();
  box.translate(0, bh / 2, 0); parts.push(box);
  if (studs) for (let i = 0; i < w; i++) for (let j = 0; j < d; j++) {
    const s = studGeo.index ? studGeo.toNonIndexed() : studGeo.clone();
    s.translate((i - (w - 1) / 2) * PITCH, bh + 0.085, (j - (d - 1) / 2) * PITCH); parts.push(s);
  }
  parts.forEach(p => p.deleteAttribute('uv'));
  const g = mergeGeometries(parts); geoCache.set(key, g); return g;
}
function prep(geo, color, matrix) {
  let g = geo.index ? geo.toNonIndexed() : geo.clone();
  if (g.attributes.uv) g.deleteAttribute('uv');
  if (matrix) g.applyMatrix4(matrix);
  const c = new THREE.Color(color); const n = g.attributes.position.count;
  const arr = new Float32Array(n * 3); for (let i = 0; i < n; i++) { arr[i * 3] = c.r; arr[i * 3 + 1] = c.g; arr[i * 3 + 2] = c.b; }
  g.setAttribute('color', new THREE.BufferAttribute(arr, 3)); return g;
}
const M4 = (x, y, z, ry = 0, rx = 0, rz = 0, s = 1) => new THREE.Matrix4().compose(v3(x, y, z), new THREE.Quaternion().setFromEuler(new THREE.Euler(rx, ry, rz, 'YXZ')), v3(s, s, s));
class Builder {
  constructor() { this.parts = []; }
  brick(w, d, plates, x, y, z, ry, color, studs = true) { this.parts.push(prep(brickGeo(w, d, plates, studs), color, M4(x, y, z, ry))); }
  geo(g, color, m) { this.parts.push(prep(g, color, m)); }
  mesh(mat = ENV, shadow = true) {
    const m = new THREE.Mesh(mergeGeometries(this.parts), mat);
    m.castShadow = shadow; m.receiveShadow = true; return m;
  }
}
// leaf geometry (points +z, lies in xz plane)
function leafGeo(L = 2.2, Wd = 0.55) {
  const s = new THREE.Shape(); s.moveTo(0, 0);
  s.bezierCurveTo(Wd, L * 0.2, Wd * 0.9, L * 0.7, 0, L);
  s.bezierCurveTo(-Wd * 0.9, L * 0.7, -Wd, L * 0.2, 0, 0);
  const g = new THREE.ExtrudeGeometry(s, { depth: 0.07, bevelEnabled: true, bevelThickness: 0.02, bevelSize: 0.02, bevelSegments: 1, curveSegments: 8 });
  g.rotateX(Math.PI / 2); g.deleteAttribute('uv'); return g.toNonIndexed();
}
const LEAF = leafGeo();
const GREENS = ['#2f8f3a', '#3fa63c', '#4cb848', '#237a34', '#5cc24a', '#1f6e3a', '#6fcf3f'];
function addLeaf(b, x, y, z, az, elev, scale, color) {
  const m = new THREE.Matrix4().compose(v3(x, y, z), new THREE.Quaternion().setFromEuler(new THREE.Euler(-elev, az, 0, 'YXZ')), v3(scale, scale, scale));
  b.geo(LEAF, color, m);
}
function addBush(b, x, z, size = 1, n = 12, filter = null) {
  for (let i = 0; i < n; i++) {
    const az = (i / n) * Math.PI * 2 + rr(-0.3, 0.3);
    if (filter && !filter(az)) continue;
    addLeaf(b, x, rr(0.0, 0.3), z, az, rr(0.35, 1.05), size * rr(0.75, 1.3), pick(GREENS));
  }
  b.brick(2, 2, 3, x, 0, z, 0, '#2a5a2a');
}

// ---------- ground ----------
function buildGround() {
  const g = new THREE.Group();
  const big = new THREE.Mesh(prep(new THREE.PlaneGeometry(600, 600).rotateX(-Math.PI / 2), '#3f7a2e'), ENV);
  big.receiveShadow = true; g.add(big);
  const T = 12; // tile size in studs
  for (let tx = -5; tx < 5; tx++) for (let tz = -5; tz < 5; tz++) {
    const cx = (tx + 0.5) * T * PITCH, cz = (tz + 0.5) * T * PITCH;
    if (Math.hypot(cx, cz) > 50) continue;
    const b = new Builder();
    b.brick(T, T, 1, cx, -0.32 + 0.005, cz, 0, '#3f7a2e', Math.hypot(cx, cz) < 40);
    const m = b.mesh(ENV, false); g.add(m);
  }
  // scattered plates, path tiles, dirt
  const b = new Builder();
  for (let z = -6; z < 34; z += 1.6) {
    for (let x = -1.6; x <= 1.6; x += 1.6) {
      if (R() < 0.75) b.brick(2, 2, 1, x + rr(-0.15, 0.15), 0.0, z + rr(-0.15, 0.15), Math.round(rr(0, 3)) * Math.PI / 2 + rr(-0.06, 0.06), pick(['#b8a272', '#a8925f', '#c2ad7c', '#9c8a5c']), false);
    }
  }
  for (let i = 0; i < 260; i++) {
    const x = rr(-34, 34), z = rr(-34, 40);
    if (Math.abs(x) < 2.8 && z > -6) continue;
    const s = pick([[1, 2], [2, 2], [2, 4], [1, 1], [1, 4]]);
    b.brick(s[0], s[1], 1, x, 0, z, Math.round(rr(0, 3)) * Math.PI / 2, pick(['#2f6a26', '#4b8a32', '#6b5a3a', '#567d2e', '#3a7330']), R() < 0.7);
  }
  g.add(b.mesh(ENV, false));
  return g;
}
scene.add(buildGround());

// ---------- trees ----------
function buildTree(x, z, h, seed) {
  const b = new Builder();
  const trunkCols = ['#5b3a24', '#6a4429', '#4e321f', '#73492c'];
  const n = Math.round(h / 0.96);
  for (let i = 0; i < n; i++) {
    b.brick(4, 4, 3, x + rr(-0.06, 0.06), i * 0.96, z + rr(-0.06, 0.06), (i % 2) * Math.PI / 2 + rr(-0.05, 0.05), pick(trunkCols), i === n - 1);
    if (R() < 0.35) { const a = Math.floor(rr(0, 4)) * Math.PI / 2; b.brick(1, 2, 3, x + Math.sin(a) * 1.75, i * 0.96, z + Math.cos(a) * 1.75, a, pick(trunkCols), false); }
  }
  // roots
  for (let k = 0; k < 6; k++) { const a = k * Math.PI / 3 + rr(-0.3, 0.3); b.brick(2, 3, 3, x + Math.sin(a) * 2.2, 0, z + Math.cos(a) * 2.2, a, pick(trunkCols), true); b.brick(1, 2, 2, x + Math.sin(a) * 3.3, 0, z + Math.cos(a) * 3.3, a, pick(trunkCols), true); }
  // branches
  for (let k = 0; k < 3; k++) {
    const a = rr(0, Math.PI * 2), y = h * rr(0.55, 0.85);
    for (let s = 0; s < 3; s++) b.brick(2, 2, 3, x + Math.sin(a) * (2.0 + s * 1.5), y + s * 0.6, z + Math.cos(a) * (2.0 + s * 1.5), a, pick(trunkCols), true);
  }
  // canopy
  const cy = h + 1.2, rx = rr(5.5, 7.5), ry = rr(2.2, 3.2);
  for (let k = 0; k < 70; k++) {
    let px, py, pz; do { px = rr(-1, 1); py = rr(-1, 1); pz = rr(-1, 1); } while (px * px + py * py + pz * pz > 1);
    const s = pick([[2, 4], [2, 2], [4, 4], [2, 6], [4, 6], [3, 3]]);
    b.brick(s[0], s[1], pick([1, 3, 3]), x + px * rx, cy + py * ry, z + pz * rx, Math.round(rr(0, 3)) * Math.PI / 2 + rr(-0.2, 0.2), pick(GREENS), true);
  }
  // hanging leaves
  for (let k = 0; k < 26; k++) {
    const a = rr(0, Math.PI * 2), r = rx * rr(0.5, 1.05);
    addLeaf(b, x + Math.sin(a) * r, cy - ry * rr(0.2, 0.9), z + Math.cos(a) * r, a, rr(-0.9, -0.2), rr(1.0, 1.7), pick(GREENS));
  }
  // vines
  for (let k = 0; k < 4; k++) {
    const a = rr(0, Math.PI * 2), r = rx * rr(0.4, 0.8), len = Math.floor(rr(4, 10));
    for (let s = 0; s < len; s++) b.brick(1, 1, 3, x + Math.sin(a) * r, cy - 1.5 - s * 0.96, z + Math.cos(a) * r, rr(0, 3), s % 3 === 2 ? '#5cc24a' : '#2f7a32', false);
  }
  return b.mesh();
}
const trees = [];
const treeSpots = [
  [-5.5, 24], [7.2, 19], [-6.2, 12], [6.5, 7], [-7.5, -1], [7.8, -6], [-4.5, 31], [8.5, 30],
  [-13, 20], [14, 14], [-14, 4], [13, -2], [-10, -12], [9, -14], [-9, -22], [12, -16], [-18, -6],
  [19, 6], [-20, 14], [20, 24], [-16, 32], [15, 36], [-4, 40], [24, -10], [-24, 0], [-7, -34], [26, 18], [-27, 24],
  [10, 44], [-12, 46], [30, 2], [-30, -14], [16, -28], [-14, -28], [32, 30], [-32, 36], [6, 52], [22, 42], [-22, 44],
];
treeSpots.forEach(([x, z], i) => { const t = buildTree(x, z, rr(15, 22), i); scene.add(t); trees.push(t); });

// ---------- bushes & ferns ----------
{
  const b = new Builder();
  const spots = [];
  for (let i = 0; i < 70; i++) {
    const x = rr(-30, 30), z = rr(-30, 44);
    if (Math.abs(x) < 3.0 && z > -5) continue;
    if (Math.hypot(x, z - 1) < 7.5) continue;
    if (Math.abs(x) < 4 && z < 0 && z > -30) continue;
    spots.push([x, z]);
  }
  // framing ferns along path and near camera
  spots.push([3.4, 26], [-3.6, 20], [3.6, 14], [-3.4, 9], [-3.0, 34], [3.8, 37], [-5, 6], [4.5, 10], [-6.5, 2.5], [6.8, 0.5], [-5.5, -5]);
  spots.forEach(([x, z]) => addBush(b, x, z, rr(0.9, 1.6), Math.floor(rr(9, 15))));
  scene.add(b.mesh());
}
// the bush in front of the fruit: two halves that part
const bushL = new THREE.Group(), bushR = new THREE.Group();
{
  const mk = (side) => {
    const b = new Builder();
    for (let i = 0; i < 16; i++) {
      const az = rr(-Math.PI, Math.PI);
      const sx = Math.sin(az);
      if ((side < 0) !== (sx < 0)) continue;
      addLeaf(b, 0, rr(0, 0.4), 0, az, rr(0.25, 0.95), rr(0.9, 1.35), pick(GREENS));
    }
    for (let i = 0; i < 6; i++) addLeaf(b, side * 0.3, 0.2, 0, side * rr(0.8, 2.2), rr(0.4, 0.8), rr(1.0, 1.4), pick(GREENS));
    return b.mesh();
  };
  bushL.add(mk(-1)); bushR.add(mk(1));
  bushL.position.set(-0.25, 0, 3.7); bushR.position.set(0.25, 0, 3.7);
  scene.add(bushL, bushR);
}

// ---------- flowers ----------
const flowers = [];
{
  const petal = new THREE.CylinderGeometry(0.3, 0.3, 0.12, 14);
  const stud = new THREE.CylinderGeometry(0.2, 0.2, 0.22, 12);
  for (let i = 0; i < 110; i++) {
    let x = rr(-24, 24), z = rr(-22, 30);
    if (Math.abs(x) < 2.4 && z > -4) x += Math.sign(x || 1) * 2.5;
    if (Math.hypot(x, z - 1) < 2.2) continue;
    const segD = (ax, az, bx, bz) => { const vx = bx - ax, vz = bz - az; const t = clamp(((x - ax) * vx + (z - az) * vz) / (vx * vx + vz * vz)); return Math.hypot(x - ax - vx * t, z - az - vz * t); };
    if (segD(1.2, -4.6, 7, -17) < 3.0 || segD(2.4, -4.8, 3.5, -28) < 2.5) continue;
    const col = pick(['#e0262b', '#f2c21b', '#e83a2a', '#ffd23a', '#ff6a1a']);
    const hgt = rr(0.6, 1.8);
    const grp = new THREE.Group(); grp.position.set(x, 0, z);
    const stemB = new Builder();
    stemB.geo(new THREE.CylinderGeometry(0.07, 0.09, hgt, 6), '#2f8a34', M4(0, hgt / 2, 0));
    addLeaf(stemB, 0, hgt * 0.3, 0, rr(0, 6), 0.5, 0.35, '#3fa63c');
    const stem = stemB.mesh(); grp.add(stem);
    const head = new THREE.Group(); head.position.y = hgt;
    const hb = new Builder();
    for (let k = 0; k < 5; k++) { const a = k * Math.PI * 2 / 5; hb.geo(petal, col, M4(Math.sin(a) * 0.34, 0, Math.cos(a) * 0.34, 0, 0.25 * Math.cos(a), -0.25 * Math.sin(a))); }
    hb.geo(stud, col === '#f2c21b' || col === '#ffd23a' ? '#e0262b' : '#ffd23a', M4(0, 0.08, 0));
    head.add(hb.mesh(new THREE.MeshPhysicalMaterial({ vertexColors: true, roughness: 0.3, clearcoat: 0.6 })));
    grp.add(head);
    grp.userData = { dist: Math.hypot(x - U.uC.value.x, z - U.uC.value.z), head, tilt: rr(-0.3, 0.3) };
    head.rotation.z = grp.userData.tilt;
    scene.add(grp); flowers.push(grp);
  }
}

// ---------- crystal plant & fruit ----------
const plant = new THREE.Group(); plant.position.set(0, 0, 0.6); scene.add(plant);
const plantMat = new THREE.MeshPhysicalMaterial({ vertexColors: true, roughness: 0.3, clearcoat: 0.8, clearcoatRoughness: 0.2 });
{
  const b = new Builder();
  b.brick(2, 2, 1, 0, 0, 0, 0, '#2c7a2c', true);
  b.geo(new THREE.CylinderGeometry(0.09, 0.12, 2.0, 8), '#3caa3a', M4(0, 1.15, 0));
  b.geo(new THREE.CylinderGeometry(0.07, 0.09, 0.5, 8), '#3caa3a', M4(0.12, 2.25, 0, 0, 0, -0.5));
  [[0.6, 0.3, 0.9], [1.0, 2.4, 0.7], [1.4, 4.2, 0.6], [0.8, 5.3, 0.8], [1.7, 1.2, 0.5]].forEach(([y, a, e]) => addLeaf(b, 0, y, 0, a, e, 0.65, '#46c23e'));
  plant.add(b.mesh(plantMat));
}
const fruit = new THREE.Group(); scene.add(fruit);
const fruitHome = v3(0.28, 2.05, 0.6);
const gemGeo = new THREE.IcosahedronGeometry(0.42, 0); gemGeo.scale(1, 1.3, 1);
const fruitMat = new THREE.MeshPhysicalMaterial({ color: 0xff8a1e, emissive: 0xff6a00, emissiveIntensity: 0.6, roughness: 0.08, metalness: 0.0, transparent: true, opacity: 0.72, flatShading: true, clearcoat: 1, ior: 1.6, specularIntensity: 1 });
const gem = new THREE.Mesh(gemGeo, fruitMat); fruit.add(gem);
const coreMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(3.0, 0.6, 1.6), toneMapped: false });
const core = new THREE.Mesh(new THREE.IcosahedronGeometry(0.11, 2), coreMat); fruit.add(core);
const leafCap = new THREE.Mesh(prep(new THREE.CylinderGeometry(0.06, 0.16, 0.14, 6), '#3caa3a', M4(0, 0.6, 0)), plantMat); fruit.add(leafCap);
function glowTex(inner = 'rgba(255,255,255,1)', mid = 'rgba(255,180,90,0.35)') {
  const c = document.createElement('canvas'); c.width = c.height = 256; const x = c.getContext('2d');
  const g = x.createRadialGradient(128, 128, 0, 128, 128, 128); g.addColorStop(0, inner); g.addColorStop(0.25, mid); g.addColorStop(1, 'rgba(0,0,0,0)');
  x.fillStyle = g; x.fillRect(0, 0, 256, 256); const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
}
const glowSprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTex('rgba(255,220,160,1)', 'rgba(255,120,40,0.4)'), color: 0xffffff, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, toneMapped: false }));
glowSprite.scale.set(3, 3, 3); fruit.add(glowSprite);
const fruitLight = new THREE.PointLight(0xff8a30, 6, 14, 1.6); fruit.add(fruitLight);
const pinkLight = new THREE.PointLight(0xff4fa8, 2, 6, 1.8); fruit.add(pinkLight);

// seed
const seed = new THREE.Group(); scene.add(seed);
seed.add(new THREE.Mesh(new THREE.SphereGeometry(0.1, 16, 12), new THREE.MeshBasicMaterial({ color: new THREE.Color(1.6, 2.2, 0.6), toneMapped: false })));
const seedGlow = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTex('rgba(240,255,200,1)', 'rgba(150,255,90,0.35)'), blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, toneMapped: false }));
seedGlow.scale.set(1.0, 1.0, 1); seed.add(seedGlow);
const seedLight = new THREE.PointLight(0xc8ff7a, 0, 5, 2); seed.add(seedLight);

// ---------- explorer figure ----------
function faceTexture(expr) {
  const c = document.createElement('canvas'); c.width = 2048; c.height = 600; const x = c.getContext('2d');
  x.fillStyle = '#e4b892'; x.fillRect(0, 0, 2048, 600);
  const cx = 1024;
  // stubble
  const r2 = rng(99);
  for (let i = 0; i < 2600; i++) {
    const a = r2() * Math.PI * 2, rx = 230 * Math.sqrt(r2()), ry = 150 * Math.sqrt(r2());
    const px = cx + Math.cos(a) * rx, py = 430 + Math.sin(a) * ry * 0.9;
    if (py < 330 && Math.abs(px - cx) < 150) continue;
    x.fillStyle = `rgba(92,62,40,${0.18 + r2() * 0.22})`; x.fillRect(px, py, 4, 4);
  }
  // cheeks
  x.fillStyle = 'rgba(210,120,100,0.18)'; x.beginPath(); x.ellipse(cx - 210, 330, 60, 34, 0, 0, 7); x.ellipse(cx + 210, 330, 60, 34, 0, 0, 7); x.fill();
  // eyebrows
  x.strokeStyle = '#4a2f1c'; x.lineWidth = 26; x.lineCap = 'round';
  const brow = { worried: [40, -22], curious: [-10, 14], amazed: [-36, -36], smile: [0, 0], laugh: [-14, -14], blink: [10, 10] }[expr] || [0, 0];
  x.beginPath(); x.moveTo(cx - 230, 170 + brow[1] * -0.3); x.quadraticCurveTo(cx - 160, 140 + brow[1], cx - 85, 165 - brow[0]); x.stroke();
  x.beginPath(); x.moveTo(cx + 230, 170 + brow[1] * -0.3 - (expr === 'curious' ? 22 : 0)); x.quadraticCurveTo(cx + 160, 140 + brow[1] - (expr === 'curious' ? 26 : 0), cx + 85, 165 - brow[0]); x.stroke();
  // eyes
  const eyeY = 245;
  if (expr === 'blink' || expr === 'laugh') {
    x.lineWidth = 16; x.strokeStyle = '#1b120c';
    [-1, 1].forEach(s => { x.beginPath(); x.moveTo(cx + s * 150 - 38, eyeY + 4); x.quadraticCurveTo(cx + s * 150, eyeY - (expr === 'laugh' ? 30 : -6), cx + s * 150 + 38, eyeY + 4); x.stroke(); });
  } else {
    const ew = expr === 'amazed' ? 40 : 30, eh = expr === 'amazed' ? 54 : 40;
    [-1, 1].forEach(s => {
      x.fillStyle = '#fff'; x.beginPath(); x.ellipse(cx + s * 150, eyeY, ew + 12, eh + 10, 0, 0, 7); x.fill();
      x.fillStyle = '#1b120c'; x.beginPath(); x.ellipse(cx + s * 150 + 4, eyeY + 4, ew, eh, 0, 0, 7); x.fill();
      x.fillStyle = '#fff'; x.beginPath(); x.ellipse(cx + s * 150 + 14, eyeY - 12, 10, 12, 0, 0, 7); x.fill();
    });
  }
  // mouth
  x.strokeStyle = '#4a2418'; x.lineWidth = 16; x.fillStyle = '#5a1f18';
  if (expr === 'worried') { x.beginPath(); x.moveTo(cx - 80, 420); x.quadraticCurveTo(cx, 395, cx + 80, 425); x.stroke(); }
  else if (expr === 'curious' || expr === 'blink') { x.beginPath(); x.moveTo(cx - 70, 412); x.quadraticCurveTo(cx + 10, 432, cx + 80, 404); x.stroke(); }
  else if (expr === 'amazed') { x.beginPath(); x.ellipse(cx, 425, 46, 58, 0, 0, 7); x.fill(); x.fillStyle = '#c24a4a'; x.beginPath(); x.ellipse(cx, 455, 28, 18, 0, 0, 7); x.fill(); }
  else if (expr === 'smile') { x.beginPath(); x.moveTo(cx - 150, 385); x.quadraticCurveTo(cx, 490, cx + 150, 385); x.closePath(); x.fill(); x.fillStyle = '#fff'; x.fillRect(cx - 105, 392, 210, 26); }
  else if (expr === 'laugh') { x.beginPath(); x.moveTo(cx - 165, 370); x.quadraticCurveTo(cx, 540, cx + 165, 370); x.closePath(); x.fill(); x.fillStyle = '#fff'; x.fillRect(cx - 120, 376, 240, 30); x.fillStyle = '#c24a4a'; x.beginPath(); x.ellipse(cx, 470, 60, 22, 0, 0, 7); x.fill(); }
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4; return t;
}
const faces = {}; ['worried', 'curious', 'amazed', 'smile', 'laugh', 'blink'].forEach(e => faces[e] = faceTexture(e));

const plastic = (c, o = {}) => new THREE.MeshPhysicalMaterial({ color: c, roughness: 0.32, clearcoat: 0.5, clearcoatRoughness: 0.25, ...o });
const mKhaki = plastic('#c9b27c'), mKhakiD = plastic('#b39b66'), mPants = plastic('#6e5d40'), mLeather = plastic('#6b3f22', { roughness: 0.5 }),
  mShoe = plastic('#3a281a'), mSkin = plastic('#e4b892'), mHair = plastic('#5a3820', { roughness: 0.5 }), mPack = plastic('#7a6a44'), mMetal = plastic('#c8b070', { metalness: 0.6, roughness: 0.3 });
const fig = new THREE.Group(); scene.add(fig);
const figInner = new THREE.Group(); fig.add(figInner);
function part(geo, mat, x, y, z, parent) { const m = new THREE.Mesh(geo, mat); m.position.set(x, y, z); m.castShadow = true; m.receiveShadow = true; parent.add(m); return m; }
// legs
const legL = new THREE.Group(), legR = new THREE.Group();
legL.position.set(0.4, 1.62, 0); legR.position.set(-0.4, 1.62, 0); figInner.add(legL, legR);
[legL, legR].forEach(l => {
  part(new RoundedBoxGeometry(0.74, 1.25, 0.8, 2, 0.06), mPants, 0, -0.62, 0, l);
  part(new RoundedBoxGeometry(0.76, 0.32, 0.92, 2, 0.06), mShoe, 0, -1.46, 0.04, l);
  part(new RoundedBoxGeometry(0.34, 0.3, 0.12, 1, 0.03), mPants, 0, -0.7, 0.44, l); // cargo pocket
});
const upper = new THREE.Group(); upper.position.set(0, 1.62, 0); figInner.add(upper);
part(new RoundedBoxGeometry(1.56, 0.36, 0.8, 2, 0.05), mPants, 0, 0.16, 0, upper);
// belt + pouches
part(new RoundedBoxGeometry(1.5, 0.16, 0.84, 1, 0.03), mLeather, 0, 0.38, 0, upper);
part(new RoundedBoxGeometry(0.32, 0.3, 0.2, 1, 0.04), mLeather, 0.5, 0.3, 0.46, upper);
part(new RoundedBoxGeometry(0.32, 0.3, 0.2, 1, 0.04), mLeather, -0.5, 0.3, 0.46, upper);
part(new RoundedBoxGeometry(0.16, 0.12, 0.05, 1, 0.02), mMetal, 0, 0.38, 0.43, upper);
// torso trapezoid
const torsoGeo = new RoundedBoxGeometry(1.6, 1.3, 0.8, 2, 0.06);
{ const p = torsoGeo.attributes.position; for (let i = 0; i < p.count; i++) { const y = p.getY(i); p.setX(i, p.getX(i) * lerp(1, 0.76, (y + 0.65) / 1.3)); } torsoGeo.computeVertexNormals(); }
part(torsoGeo, mKhaki, 0, 1.1, 0, upper);
// straps on chest
[-1, 1].forEach(s => {
  const st = part(new THREE.BoxGeometry(0.15, 1.3, 0.05), mLeather, s * 0.36, 1.1, 0.42, upper); st.rotation.z = s * 0.12;
  part(new THREE.BoxGeometry(0.3, 0.26, 0.06), mKhakiD, s * 0.33, 1.36, 0.43, upper); // pockets
});
part(new THREE.BoxGeometry(0.6, 0.12, 0.06), mLeather, 0, 1.05, 0.44, upper); // chest strap
part(new THREE.BoxGeometry(0.5, 0.16, 0.5), mKhakiD, 0, 1.78, 0.12, upper); // collar
// backpack
part(new RoundedBoxGeometry(1.05, 1.1, 0.48, 2, 0.1), mPack, 0, 1.05, -0.64, upper);
part(new RoundedBoxGeometry(1.0, 0.36, 0.52, 2, 0.08), mLeather, 0, 1.45, -0.66, upper);
const roll = part(new THREE.CylinderGeometry(0.2, 0.2, 1.2, 14), plastic('#4e5a3a'), 0, 1.75, -0.62, upper); roll.rotation.z = Math.PI / 2;
// arms
const armL = new THREE.Group(), armR = new THREE.Group();
armL.position.set(0.66, 1.62, 0); armR.position.set(-0.66, 1.62, 0); upper.add(armL, armR);
const handL = new THREE.Object3D(), handR = new THREE.Object3D();
[[armL, 1, handL], [armR, -1, handR]].forEach(([a, s, hnd]) => {
  const up = part(new THREE.CylinderGeometry(0.22, 0.25, 0.62, 14), mKhaki, s * 0.12, -0.28, 0, a); up.rotation.z = s * 0.18;
  part(new THREE.CylinderGeometry(0.26, 0.26, 0.14, 14), mKhakiD, s * 0.16, -0.56, 0, a); // rolled sleeve
  const fore = part(new THREE.CylinderGeometry(0.19, 0.21, 0.42, 14), mSkin, s * 0.2, -0.82, 0.05, a); fore.rotation.x = -0.2;
  const hand = part(new THREE.TorusGeometry(0.15, 0.08, 10, 16, Math.PI * 1.5), mSkin, s * 0.22, -1.08, 0.1, a); hand.rotation.y = Math.PI / 2;
  hnd.position.set(s * 0.18, -1.12, 0.22); a.add(hnd);
});
// head
const head = new THREE.Group(); head.position.set(0, 1.84, 0); upper.add(head);
part(new THREE.CylinderGeometry(0.2, 0.2, 0.16, 14), mSkin, 0, 0.06, 0, head);
const headMats = [new THREE.MeshPhysicalMaterial({ map: faces.worried, roughness: 0.38, clearcoat: 0.4 }), mSkin, mSkin];
const headGeo = new THREE.CylinderGeometry(0.44, 0.44, 0.78, 40, 1, false, Math.PI, Math.PI * 2);
const headMesh = part(headGeo, headMats, 0, 0.55, 0, head);
part(new THREE.CylinderGeometry(0.44, 0.44, 0.08, 40), mSkin, 0, 0.96, 0, head);
// hair: cap + back + swept quiff
const cap = part(new THREE.SphereGeometry(0.5, 32, 16, 0, Math.PI * 2, 0, Math.PI * 0.5), mHair, 0, 0.92, -0.02, head); cap.scale.set(1, 0.62, 1.02);
const back = part(new THREE.CylinderGeometry(0.49, 0.47, 0.55, 32, 1, true, Math.PI / 2 + 0.25, Math.PI - 0.5), mHair, 0, 0.72, -0.01, head);
back.material = mHair.clone(); back.material.side = THREE.DoubleSide;
[-0.32, -0.12, 0.08, 0.28].forEach((x0, i) => {
  const q = part(new THREE.CapsuleGeometry(0.12, 0.42, 4, 10), mHair, x0, 1.06 + (i % 2) * 0.03, 0.26, head);
  q.rotation.set(1.15, 0, -0.9 + i * 0.12);
});
[-1, 1].forEach(s => { const sb = part(new THREE.BoxGeometry(0.1, 0.32, 0.3), mHair, s * 0.45, 0.78, 0.05, head); }); // sideburns
fig.traverse(o => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });

// ---------- lights ----------
const hemi = new THREE.HemisphereLight(0xa8b4aa, 0x3a3a2c, 0.8); scene.add(hemi);
const sun = new THREE.DirectionalLight(0xc8d0d0, 1.4);
sun.castShadow = true; sun.shadow.mapSize.set(1536, 1536); sun.shadow.bias = -0.0004; sun.shadow.normalBias = 0.03;
scene.add(sun, sun.target);
const SUN_DIR = v3(-0.42, 1.0, -0.62).normalize();
const fill = new THREE.DirectionalLight(0x9fb8ff, 0.25); fill.position.set(10, 6, 20); scene.add(fill);

// light shafts
const beamMat = new THREE.ShaderMaterial({
  uniforms: { uOp: { value: 0.1 }, uCol: { value: new THREE.Color(1, 0.95, 0.85) } },
  vertexShader: `varying vec2 vUv; varying vec3 vN; varying vec3 vV; void main(){ vUv=uv; vec4 mv=modelViewMatrix*vec4(position,1.); vN=normalize(normalMatrix*normal); vV=normalize(-mv.xyz); gl_Position=projectionMatrix*mv; }`,
  fragmentShader: `uniform float uOp; uniform vec3 uCol; varying vec2 vUv; varying vec3 vN; varying vec3 vV; void main(){ float f=pow(abs(dot(vN,vV)),2.5); float a=uOp*f*smoothstep(0.,0.25,vUv.y)*smoothstep(1.,0.55,vUv.y); gl_FragColor=vec4(uCol,a); }`,
  transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, fog: false,
});
const beams = [];
[[-2.5, 18, 1.2], [2.2, 10, 0.8], [-1, 2, 1.6], [3.5, 26, 1.0], [-4, 6, 0.7], [1, -6, 1.3], [6, -2, 0.9]].forEach(([x, z, w]) => {
  const g = new THREE.CylinderGeometry(w * 0.5, w * 1.4, 44, 20, 1, true); g.translate(0, 22, 0);
  const m = new THREE.Mesh(g, beamMat); m.position.set(x, 0, z);
  m.quaternion.setFromUnitVectors(v3(0, 1, 0), SUN_DIR); scene.add(m); beams.push(m);
});

// ---------- particles ----------
class Particles {
  constructor(n, kind = 0) {
    this.n = n; const g = new THREE.BufferGeometry();
    this.pos = new Float32Array(n * 3); this.col = new Float32Array(n * 3); this.size = new Float32Array(n); this.alpha = new Float32Array(n);
    g.setAttribute('position', new THREE.BufferAttribute(this.pos, 3)); g.setAttribute('aColor', new THREE.BufferAttribute(this.col, 3));
    g.setAttribute('aSize', new THREE.BufferAttribute(this.size, 1)); g.setAttribute('aAlpha', new THREE.BufferAttribute(this.alpha, 1));
    this.mat = new THREE.ShaderMaterial({
      uniforms: { uScale: { value: 1000 }, uKind: { value: kind } },
      vertexShader: `attribute vec3 aColor; attribute float aSize; attribute float aAlpha; uniform float uScale; varying vec3 vC; varying float vA;
        void main(){ vC=aColor; vA=aAlpha; vec4 mv=modelViewMatrix*vec4(position,1.); gl_PointSize=clamp(aSize*uScale/-mv.z,0.,180.); gl_Position=projectionMatrix*mv; }`,
      fragmentShader: `uniform float uKind; varying vec3 vC; varying float vA; void main(){ vec2 p=gl_PointCoord-0.5; float d=length(p);
        float s=smoothstep(0.5,0.0,d); s*=s; if(uKind>0.5){ float cr=max(0.,1.-abs(p.x)*14.)*max(0.,1.-abs(p.y)*2.2)+max(0.,1.-abs(p.y)*14.)*max(0.,1.-abs(p.x)*2.2); s=s*1.4+cr*0.8; }
        gl_FragColor=vec4(vC, vA*s); }`,
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    });
    this.points = new THREE.Points(g, this.mat); this.points.frustumCulled = false; scene.add(this.points);
    this.seed = Array.from({ length: n }, () => [R(), R(), R(), R(), R(), R()]);
  }
  set(i, x, y, z, s, a, c) { this.pos[i * 3] = x; this.pos[i * 3 + 1] = y; this.pos[i * 3 + 2] = z; this.size[i] = s; this.alpha[i] = a; this.col[i * 3] = c[0]; this.col[i * 3 + 1] = c[1]; this.col[i * 3 + 2] = c[2]; }
  commit() { const a = this.points.geometry.attributes; for (const k in a) a[k].needsUpdate = true; }
}
const dust = new Particles(1400, 0);
const sparkle = new Particles(400, 1);
const rise = new Particles(220, 1);
const burst = new Particles(1800, 1);
const ring = new Particles(900, 1);
const pollen = new Particles(500, 1);

// shards
const shardGeo = new THREE.OctahedronGeometry(0.09, 0); shardGeo.scale(1, 2.2, 1);
const shardMat = new THREE.MeshPhysicalMaterial({ color: 0xff5fb0, emissive: 0xff3a9a, emissiveIntensity: 2.2, roughness: 0.1, transparent: true, opacity: 0.9, flatShading: true });
const NSH = 140; const shards = new THREE.InstancedMesh(shardGeo, shardMat, NSH); shards.frustumCulled = false; scene.add(shards);
const shardSeed = Array.from({ length: NSH }, () => [R(), R(), R(), R(), R()]);

// butterflies
const butterflies = [];
{
  const ws = new THREE.Shape(); ws.moveTo(0, 0); ws.bezierCurveTo(0.6, 0.5, 0.9, 0.1, 0.7, -0.25); ws.bezierCurveTo(0.5, -0.5, 0.2, -0.4, 0, 0);
  const wg = new THREE.ExtrudeGeometry(ws, { depth: 0.04, bevelEnabled: false }); wg.rotateX(Math.PI / 2);
  const cols = ['#ff8a1a', '#2a8cff', '#ffd21a', '#ff3a6a', '#9a4aff', '#1ad2c0', '#ff6a1a', '#ffe14a', '#3ac2ff', '#ff4a9a'];
  for (let i = 0; i < 10; i++) {
    const g = new THREE.Group(); const mat = plastic(cols[i], { emissive: cols[i], emissiveIntensity: 0.15 });
    const wl = new THREE.Mesh(wg, mat), wr = new THREE.Mesh(wg, mat); wr.scale.x = -1;
    const pl = new THREE.Group(), pr = new THREE.Group(); pl.add(wl); pr.add(wr);
    const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.06, 0.4, 4, 8), plastic('#2a1a10')); body.rotation.x = Math.PI / 2;
    g.add(pl, pr, body); g.userData = { pl, pr, s: [R(), R(), R(), R()] }; g.scale.setScalar(0.9);
    scene.add(g); butterflies.push(g);
  }
}

// ---------- post ----------
const composer = new EffectComposer(renderer);
composer.setPixelRatio(1); composer.setSize(W * SCALE, H * SCALE);
composer.addPass(new RenderPass(scene, camera));
const bokeh = new BokehPass(scene, camera, { focus: 10, aperture: 0.004, maxblur: 0.012 });
composer.addPass(bokeh);
const bloom = new UnrealBloomPass(new THREE.Vector2(W * SCALE / 2, H * SCALE / 2), 0.55, 0.6, 0.82);
composer.addPass(bloom);
const grade = new ShaderPass({
  uniforms: { tDiffuse: { value: null }, uTint: { value: new THREE.Vector3(1, 1, 1) }, uSat: { value: 1 }, uVig: { value: 0.35 }, uSeed: { value: 0 } },
  vertexShader: `varying vec2 vUv; void main(){ vUv=uv; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.); }`,
  fragmentShader: `uniform sampler2D tDiffuse; uniform vec3 uTint; uniform float uSat; uniform float uVig; uniform float uSeed; varying vec2 vUv;
    float h(vec2 p){ return fract(sin(dot(p, vec2(12.9898,78.233))+uSeed)*43758.5453); }
    void main(){ vec4 c=texture2D(tDiffuse,vUv); float l=dot(c.rgb,vec3(0.299,0.587,0.114)); c.rgb=mix(vec3(l),c.rgb,uSat)*uTint;
      vec2 q=vUv-0.5; q.x*=0.62; float v=1.-uVig*smoothstep(0.18,0.62,length(q)); c.rgb*=v; c.rgb+= (h(vUv*1000.)-0.5)*0.025; gl_FragColor=c; }`,
});
composer.addPass(grade);
composer.addPass(new OutputPass());

// ---------- timeline ----------
function walkZ(T) {
  if (T < 10) return 22 - 1.3 * T;
  if (T < 14) { const u = T - 10; return 9 - 1.3 * (u - Math.pow(u, 4) / (4 * 64)); }
  const z14 = 9 - 1.3 * (4 - 256 / 256);
  if (T < 22) return z14;
  if (T < 24.5) return lerp(z14, 3.0, eseg(T, 22, 24.5));
  if (T < 30.5) return 3.0;
  return lerp(3.0, 1.55, eseg(T, 30.5, 32.2));
}
function figPose(T) {
  const z = walkZ(T);
  const v = Math.abs(walkZ(T + 0.02) - walkZ(T - 0.02)) / 0.04;
  const amt = clamp(v / 1.1);
  const ph = (22 - z) * Math.PI / 1.05;
  const P = { x: 0, z, yaw: 0, y: 0, lean: 0, headYaw: 0, headPitch: 0, legL: Math.sin(ph) * 0.55 * amt, legR: -Math.sin(ph) * 0.55 * amt,
    aL: [-Math.sin(ph) * 0.45 * amt + 0.05, 0.06], aR: [Math.sin(ph) * 0.45 * amt + 0.05, -0.06], expr: 'worried' };
  P.y = Math.abs(Math.cos(ph)) * 0.06 * amt;
  // S1 looking around
  if (T < 10) { P.headYaw = 0.55 * Math.sin(T * 0.85 + 0.4) * eseg(T, 0.5, 2.5); P.headPitch = -0.12 * Math.sin(T * 0.6) - 0.05; P.yaw = 0.08 * Math.sin(T * 0.5); }
  // S2
  if (T >= 10 && T < 22) {
    P.headYaw = lerp(0.35 * Math.sin(T * 0.9), 0, eseg(T, 11, 12.5));
    if (T > 12) P.expr = 'curious';
    const lean = eseg(T, 14, 15.6) * (1 - eseg(T, 20, 22) * 0.85);
    P.lean = 0.42 * lean; P.headPitch = -0.25 * lean + 0.12 * eseg(T, 12, 13.5) * (1 - lean);
    P.y -= 0.15 * lean;
    const reach = eseg(T, 15.3, 16.6) * (1 - eseg(T, 19.5, 21.5));
    const spread = eseg(T, 16.6, 18.6) * (1 - eseg(T, 19.5, 21.5));
    P.aL = [lerp(P.aL[0], -1.35, reach), lerp(0.06, 0.95, spread) - 0.25 * reach * (1 - spread)];
    P.aR = [lerp(P.aR[0], -1.35, reach), -(lerp(0.06, 0.95, spread) - 0.25 * reach * (1 - spread))];
    P.headYaw += 0.12 * Math.sin(T * 1.3) * lean;
  }
  if (T >= 20 && T < 30) { if (T > 21.3) P.expr = 'amazed'; P.headPitch = lerp(P.headPitch, -0.34, eseg(T, 20.5, 23)); }
  // S4 reach & lift
  if (T >= 30 && T < 41.5) {
    P.expr = T < 34.5 ? 'amazed' : 'smile';
    const reach = eseg(T, 31.6, 33.4), lift = eseg(T, 34.0, 36.8);
    P.lean = 0.22 * reach * (1 - lift);
    const ax = lerp(lerp(0.05, -0.95, reach), -1.22, lift), az = 0.27 * reach;
    P.aL = [ax, -az]; P.aR = [ax, az];
    P.headPitch = lerp(lerp(-0.34, -0.4, reach), -0.04, lift);
    P.headYaw = 0.04 * Math.sin(T * 1.1) * lift;
  }
  // S5
  if (T >= 40) {
    const b = T - 41.5;
    if (T > 41.5) P.expr = 'amazed';
    if (T > 43.2) P.expr = 'laugh';
    const flinch = T > 41.5 ? Math.exp(-b * 2.2) * clamp(b * 8) : 0;
    const up = eseg(T, 42.6, 43.8) * (1 - eseg(T, 47.0, 48.6));
    const cup = eseg(T, 47.2, 48.8);
    const hold = 1 - eseg(T, 41.4, 42.2);
    const axHold = -1.22;
    let ax = lerp(axHold, 0.2, 1 - hold), azv = lerp(0.27, 0.1, 1 - hold);
    ax = lerp(ax, -2.75, up); azv = lerp(azv, -0.45, up);
    ax = lerp(ax, -1.15, cup); azv = lerp(azv, 0.32, cup);
    P.aL = [ax, -azv]; P.aR = [ax, azv];
    P.lean = -0.28 * flinch - 0.12 * up + 0.12 * cup;
    P.headPitch = lerp(-0.04, -0.3, up) + 0.35 * cup * (1 - eseg(T, 52.5, 54.5)) - 0.35 * eseg(T, 54.5, 56.5) * (1 - eseg(T, 58, 60) * 0.5);
    P.y += up * Math.abs(Math.sin((T - 43) * 7)) * 0.12;
    P.headYaw = up * 0.15 * Math.sin(T * 3.2);
    if (T > 48.2) P.expr = 'smile';
    if (T > 54.6 && T < 57.5) P.expr = 'amazed';
    if (T > 57.5) P.expr = 'smile';
    P.yaw = 0.2 * Math.sin((T - 50) * 0.45) * eseg(T, 52, 55);
  }
  // blinks
  const blinks = [2.2, 6.1, 8.7, 11.4, 13.6, 17.9, 26.5, 38.2, 49.4, 52.1, 58.6];
  if (P.expr !== 'laugh' && blinks.some(b => T > b && T < b + 0.13)) P.expr = 'blink';
  return P;
}
let curFace = 'worried';
function applyFig(P) {
  fig.position.set(P.x, P.y, P.z); fig.rotation.y = Math.PI + P.yaw;
  legL.rotation.x = P.legL; legR.rotation.x = P.legR;
  upper.rotation.x = P.lean;
  armL.rotation.set(P.aL[0], 0, P.aL[1]); armR.rotation.set(P.aR[0], 0, P.aR[1]);
  head.rotation.set(P.headPitch, P.headYaw, 0, 'YXZ');
  if (P.expr !== curFace) { headMats[0].map = faces[P.expr]; headMats[0].needsUpdate = true; curFace = P.expr; }
  fig.updateMatrixWorld(true);
}
const tmpA = v3(0, 0, 0), tmpB = v3(0, 0, 0);
function handsMid() { handL.getWorldPosition(tmpA); handR.getWorldPosition(tmpB); return tmpA.clone().add(tmpB).multiplyScalar(0.5); }
function faceWorld() { const p = v3(0, 0.55, 0.3); head.localToWorld(p); return p; }

// camera per scene
function cameraAt(T) {
  let pos, tgt, fov = 40, focus = null, ap = 0.0025;
  const fz = walkZ(T);
  if (T < 10) {
    const u = eseg(T, 0, 10);
    pos = v3(lerp(3.2, 1.9, u), lerp(9.5, 4.6, u), lerp(44, fz + 8.5, u));
    tgt = v3(0, lerp(2.0, 3.0, u), lerp(fz - 6, fz, u));
    fov = 40; ap = 0.0018;
  } else if (T < 20) {
    const u = eseg(T, 10, 15.5), w = eseg(T, 16.2, 19.8);
    const p1 = v3(1.7, 5.4, fz + 5.2), t1 = v3(-0.1, 2.2, 1.6);
    const p0 = v3(2.2, 4.8, fz + 7.0), t0 = v3(0, 2.8, fz - 2);
    const p2 = v3(2.6, 5.0, 0.4), t2 = v3(0, 3.6, fz - 0.6);
    pos = lerpV(p0, p1, u); tgt = lerpV(t0, t1, u);
    if (w > 0) { const ctl = v3(5.2, 5.4, fz - 0.5); const a1 = lerpV(pos, ctl, w), a2 = lerpV(ctl, p2, w); pos = lerpV(a1, a2, w); tgt = lerpV(tgt, t2, w); }
    fov = lerp(40, 36, w); ap = lerp(0.002, 0.004, w);
    focus = w > 0.4 ? faceWorld() : null;
  } else if (T < 30) {
    const u = eseg(T, 20, 30);
    const C = v3(fruitHome.x, fruitHome.y + 0.1, fruitHome.z);
    const a = lerp(1.0, 3.3, u), r = lerp(6.2, 5.2, u);
    pos = v3(C.x + Math.sin(a) * r, lerp(2.9, 4.6, u), C.z + Math.cos(a) * r);
    tgt = lerpV(C, v3(0, 4.1, 2.9), eseg(T, 22, 28) * 0.68);
    fov = 40; ap = 0.005; focus = C;
  } else if (T < 40) {
    const u = eseg(T, 30, 40);
    pos = v3(lerp(2.0, 1.4, u), lerp(3.6, 4.7, u), lerp(-4.4, -3.4, u));
    const fw = faceWorld(); tgt = lerpV(v3(0, 3.0, 1.2), fw.clone().add(v3(0, -0.35, 0)), eseg(T, 32, 37));
    fov = 34; ap = 0.007; focus = lerpV(fruit.position.clone(), fw, eseg(T, 34.5, 36.5));
  } else if (T < 50) {
    const u = eseg(T, 41.6, 49.5);
    pos = v3(lerp(1.2, 6.0, u), lerp(4.0, 1.4, u), lerp(-4.6, -15, u));
    tgt = v3(0, lerp(3.2, 2.6, u), 1.5);
    fov = lerp(40, 50, u); ap = lerp(0.005, 0.0015, u); focus = v3(0, 3, 1.5);
    // shake on burst
    const b = T - 41.5; if (b > 0 && b < 1.2) { const s = 0.06 * Math.exp(-b * 4); pos.x += Math.sin(T * 90) * s; pos.y += Math.cos(T * 77) * s; }
  } else {
    const u = eseg(T, 50, 60);
    pos = v3(lerp(2.4, 3.5, u), lerp(5.0, 15, u), lerp(-4.8, -27, u));
    tgt = v3(0, lerp(3.2, 2.2, u), lerp(1.4, 0, u));
    fov = lerp(40, 50, u); ap = lerp(0.004, 0.0004, u); focus = v3(0, 3, 1.5);
  }
  return { pos, tgt, fov, focus: focus || tgt, ap };
}

// ---------- frame update ----------
const col = (r, g, b) => [r, g, b];
function update(T) {
  // revive
  const revR = T < 42 ? -5 : lerp(0, 75, Math.pow(seg(T, 42, 49.5), 1.25));
  U.uR.value = revR; U.uEdge.value = T > 42 && T < 51 ? 1.6 : 0;
  const k = eseg(T, 42, 48.5), gold = eseg(T, 49, 58);

  applyFig(figPose(T));

  // lighting
  sun.color.set(0xb8c4c6).lerp(new THREE.Color(0xffe2b0), k).lerp(new THREE.Color(0xffb766), gold * 0.7);
  sun.intensity = lerp(1.9, 3.4, k) - gold * 0.3;
  hemi.color.set(0x98a49c).lerp(new THREE.Color(0xcfe6ff), k).lerp(new THREE.Color(0xffd8a8), gold * 0.5);
  hemi.groundColor.set(0x34342a).lerp(new THREE.Color(0x4a5a2a), k);
  hemi.intensity = lerp(1.05, 1.2, k);
  const fogC = new THREE.Color(0x58605a).lerp(new THREE.Color(0xa9c8a0), k).lerp(new THREE.Color(0xe8b880), gold * 0.75);
  scene.fog.color.copy(fogC); scene.background.copy(fogC);
  scene.fog.density = lerp(0.036, 0.018, k) - gold * 0.004;
  beamMat.uniforms.uOp.value = lerp(0.07, 0.16, k) + gold * 0.05;
  beamMat.uniforms.uCol.value.set(0xd8e0e0).lerp(new THREE.Color(0xffe0a0), k).lerp(new THREE.Color(0xffb060), gold);
  grade.uniforms.uSat.value = lerp(0.72, 1.12, k);
  grade.uniforms.uTint.value.set(lerp(0.96, 1.04, k) + gold * 0.04, lerp(1.0, 1.01, k), lerp(1.02, 0.95, k) - gold * 0.05);
  grade.uniforms.uSeed.value = (T * 24) % 1000;
  renderer.toneMappingExposure = lerp(1.15, 1.05, k);

  // camera
  const C = cameraAt(T);
  camera.position.copy(C.pos); camera.fov = C.fov; camera.updateProjectionMatrix(); camera.lookAt(C.tgt); camera.updateMatrixWorld();
  const fd = C.focus.clone().sub(camera.position).dot(camera.getWorldDirection(v3(0, 0, 0)));
  bokeh.uniforms.focus.value = fd; bokeh.uniforms.aperture.value = C.ap; bokeh.uniforms.maxblur.value = 0.014;
  // sun follows region of interest
  const focusPt = T >= 50 ? v3(0, 0, 0).lerp(v3(2, 0, -6), eseg(T, 50, 60)) : v3(0, 0, Math.max(walkZ(T), 0));
  sun.position.copy(focusPt).addScaledVector(SUN_DIR, 60); sun.target.position.copy(focusPt); sun.target.updateMatrixWorld();
  const sc = T >= 50 ? lerp(18, 45, eseg(T, 50, 58)) : (T < 10 ? 22 : 14);
  const sh = sun.shadow.camera; sh.left = -sc; sh.right = sc; sh.top = sc; sh.bottom = -sc; sh.near = 1; sh.far = 140; sh.updateProjectionMatrix();

  // bush parting
  const part = eseg(T, 16.6, 18.8);
  const wob = Math.sin(T * 9) * 0.04 * seg(T, 16.4, 17.4) * (1 - seg(T, 18.5, 20));
  bushL.rotation.set(0, 0, 0.5 * part + wob); bushL.position.x = -0.25 - 1.15 * part;
  bushR.rotation.set(0, 0, -0.5 * part - wob); bushR.position.x = 0.25 + 1.15 * part;

  // fruit
  const pick0 = eseg(T, 33.2, 34.0);
  let fp = fruitHome.clone();
  if (T > 33.2) { const hm = handsMid(); const hf = hm.add(v3(0, 0.12, 0)); fp = lerpV(fruitHome, hf, pick0); }
  fruit.position.copy(fp);
  fruit.rotation.y = T * 0.35; fruit.rotation.z = Math.sin(T * 0.8) * 0.05;
  let glow = 0.0;
  if (T < 10) glow = 0.0;
  else if (T < 20) glow = eseg(T, 10.5, 13) * (0.55 + 0.45 * Math.abs(Math.sin(T * 5.3) * Math.sin(T * 2.1 + 1)));
  else glow = 1.0;
  const pulse = 0.5 + 0.5 * Math.sin(T * 3.2);
  const charge = eseg(T, 40, 41.5);
  const burstT = T - 41.5;
  const visible = burstT < 0;
  fruit.visible = visible && T > 9.5;
  if (charge > 0 && visible) { fruit.position.x += Math.sin(T * 60) * 0.02 * charge; fruit.position.y += Math.cos(T * 53) * 0.02 * charge; }
  fruitMat.emissiveIntensity = 0.35 + 0.5 * glow + 0.6 * charge;
  coreMat.color.setRGB(2.0 + 1.6 * pulse + 2 * charge, 0.4 + 0.3 * pulse + 0.6 * charge, 1.1 + 0.9 * pulse + 1.2 * charge);
  core.scale.setScalar(0.85 + 0.25 * pulse + 0.6 * charge);
  fruitLight.intensity = (glow * (5 + 1.5 * pulse) + 8 * charge) * (visible ? 1 : 0);
  pinkLight.intensity = glow * 2.5 * pulse + 4 * charge;
  glowSprite.material.opacity = 0.25 + 0.5 * glow + 0.5 * charge; glowSprite.scale.setScalar(2.2 + 0.6 * pulse + 1.5 * charge);
  // burst flash light
  const flash = burstT > 0 ? Math.exp(-burstT * 2.5) : 0;
  pinkLight.position.set(0, 0, 0);
  if (!visible) { fruitLight.intensity = 0; }
  burstLight.position.copy(BURST_POS); burstLight.intensity = 60 * flash;
  bloom.strength = 0.5 + 0.6 * flash + 0.1 * charge;

  // seed
  const seedOn = eseg(T, 45.5, 47.0);
  seed.visible = T > 45.5;
  if (seed.visible) {
    const hm = handsMid().add(v3(0, 0.2, 0));
    const from = BURST_POS.clone().add(v3(0, 1.4, 0));
    const fall = eseg(T, 45.8, 48.6);
    seed.position.copy(lerpV(from, hm, fall)); seed.position.y += Math.sin(T * 2.2) * 0.04 * (1 - fall) + 0.03 * Math.sin(T * 2) * fall;
    seed.scale.setScalar(seedOn * (1 + 0.08 * Math.sin(T * 4)));
    seedLight.intensity = 3 * seedOn;
  }

  // flowers
  flowers.forEach(f => {
    const d = f.userData.dist; const s = clamp((revR - d) / 1.6);
    const pop = s <= 0 ? 0.001 : 1 + Math.sin(s * Math.PI * 2.2) * Math.exp(-s * 3) * 0.6;
    f.userData.head.scale.setScalar(Math.max(0.001, ease(s) * pop));
    f.rotation.z = (1 - s) * 0.35; f.rotation.x = (1 - s) * 0.2 + Math.sin(T * 1.3 + d) * 0.03;
  });

  // butterflies
  butterflies.forEach((b, i) => {
    const s = b.userData.s; const on = eseg(T, 47 + s[0] * 3, 49 + s[0] * 3);
    b.visible = on > 0.01; if (!b.visible) return;
    const a = T * (0.25 + s[1] * 0.3) + s[2] * 6.28, r = 3 + s[3] * 7;
    b.position.set(Math.sin(a) * r + Math.sin(T * 1.7 + i) * 0.5, 2.5 + s[1] * 4 + Math.sin(T * 1.3 + i) * 0.8, 1.5 + Math.cos(a) * r);
    b.rotation.y = a + Math.PI / 2; b.rotation.z = Math.sin(T * 2 + i) * 0.2;
    const fl = Math.sin(T * 16 + i * 2) * 0.9; b.userData.pl.rotation.z = fl; b.userData.pr.rotation.z = -fl;
    b.scale.setScalar(0.9 * on);
  });

  // particles: dust
  {
    const dc = [lerp(0.9, 1.6, k), lerp(0.92, 1.35, k), lerp(0.85, 0.7, k)];
    for (let i = 0; i < dust.n; i++) {
      const s = dust.seed[i];
      const x = (s[0] - 0.5) * 26 + Math.sin(T * 0.3 + s[3] * 9) * 0.6;
      const y = ((s[1] * 14 + T * (0.05 + s[4] * 0.1)) % 14);
      const z = s[2] * 52 - 16 + Math.cos(T * 0.25 + s[5] * 9) * 0.6;
      const a = (0.25 + 0.35 * s[5]) * (0.6 + 0.4 * Math.sin(T * 1.5 + s[3] * 20));
      dust.set(i, x, y, z, 0.035 + s[4] * 0.06, a * (1 - k * 0.4), dc);
    }
    dust.commit();
  }
  // sparkles around fruit (S3-S4)
  {
    const on = eseg(T, 19, 22) * (1 - eseg(T, 40.5, 41.6));
    const c0 = fruit.position;
    for (let i = 0; i < sparkle.n; i++) {
      const s = sparkle.seed[i];
      const a = s[0] * 6.28 + T * (0.15 + s[1] * 0.3), r = 0.6 + s[2] * 3.2;
      const y = c0.y - 1.4 + ((s[3] * 4 + T * (0.1 + s[4] * 0.2)) % 4);
      const tw = Math.pow(0.5 + 0.5 * Math.sin(T * (3 + s[5] * 5) + s[0] * 30), 3);
      const pinkish = s[5] > 0.5;
      sparkle.set(i, c0.x + Math.sin(a) * r, y, c0.z + Math.cos(a) * r, 0.05 + s[4] * 0.08, on * tw * 0.55, pinkish ? col(3, 0.9, 2) : col(3, 1.8, 0.6));
    }
    sparkle.commit();
  }
  // rising particles from hands (S4)
  {
    const on = eseg(T, 34.0, 35.5) * (1 - eseg(T, 40.8, 41.5));
    const c0 = fruit.position;
    for (let i = 0; i < rise.n; i++) {
      const s = rise.seed[i];
      const life = (s[0] * 3 + T * (0.5 + s[1] * 0.4)) % 3;
      const a = s[2] * 6.28 + life * 1.5, r = 0.25 + life * 0.35 * s[3];
      rise.set(i, c0.x + Math.sin(a) * r, c0.y - 0.3 + life * 0.9, c0.z + Math.cos(a) * r, 0.04 + s[4] * 0.05, on * (1 - life / 3) * 0.6, s[5] > 0.6 ? col(3, 1, 2.2) : col(3, 2, 0.7));
    }
    rise.commit();
  }
  // burst spiral (S5)
  {
    for (let i = 0; i < burst.n; i++) {
      const s = burst.seed[i];
      if (burstT <= 0) { burst.set(i, 0, -100, 0, 0, 0, col(0, 0, 0)); continue; }
      const age = burstT - s[5] * 0.6; if (age <= 0) { burst.set(i, 0, -100, 0, 0, 0, col(0, 0, 0)); continue; }
      const sp = 2.5 + s[0] * 6;
      const r = sp * (1 - Math.exp(-age * 0.9)) * 1.8;
      const ang = s[1] * 6.28 + 2.2 * Math.log(1 + age * 2) * (s[2] > 0.5 ? 1 : -1);
      const y = BURST_POS.y + (s[3] - 0.35) * 3 * (1 - Math.exp(-age)) + Math.sin(age * 2 + s[4] * 6) * 0.3 + age * 0.25;
      const fade = Math.exp(-age * 0.35) * clamp(1 - (age - 5) / 3);
      const c = s[4] > 0.45 ? col(3.2, 1.9, 0.5) : col(3.2, 0.8, 2.0);
      burst.set(i, BURST_POS.x + Math.sin(ang) * r, y, BURST_POS.z + Math.cos(ang) * r, 0.05 + s[2] * 0.08, fade * (0.6 + 0.4 * Math.sin(T * 9 + i)), c);
    }
    burst.commit();
  }
  // shards
  {
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler(), p = v3(0, 0, 0), sc = v3(1, 1, 1);
    for (let i = 0; i < NSH; i++) {
      const s = shardSeed[i];
      if (burstT <= 0 || burstT > 6) { m.makeScale(0, 0, 0); shards.setMatrixAt(i, m); continue; }
      const age = burstT;
      const r = (1.2 + s[0] * 3.2) * (1 - Math.exp(-age * 1.2));
      const ang = s[1] * 6.28 + 1.8 * Math.log(1 + age * 3) * (s[2] > 0.5 ? 1 : -1);
      p.set(BURST_POS.x + Math.sin(ang) * r, BURST_POS.y + (s[3] - 0.4) * 2.5 * (1 - Math.exp(-age)) - 0.2 * age * age * 0.2, BURST_POS.z + Math.cos(ang) * r);
      e.set(age * (3 + s[4] * 5), age * 4 + s[0] * 6, age * 2); q.setFromEuler(e);
      const z = (0.6 + s[4] * 1.1) * clamp(1 - (age - 3.5) / 2.5);
      sc.set(z, z, z); m.compose(p, q, sc); shards.setMatrixAt(i, m);
    }
    shards.instanceMatrix.needsUpdate = true;
    shardMat.emissiveIntensity = 1.5 + 3 * flash;
  }
  // ring at wave edge
  {
    const on = T > 42 && T < 50.5 ? 1 - seg(T, 49, 50.5) : 0;
    for (let i = 0; i < ring.n; i++) {
      const s = ring.seed[i];
      const a = s[0] * 6.28, rr0 = revR - s[1] * 2.0;
      const y = 0.15 + s[2] * 1.2 + Math.sin(T * 3 + s[3] * 10) * 0.1;
      ring.set(i, U.uC.value.x + Math.sin(a) * rr0, y, U.uC.value.z + Math.cos(a) * rr0, 0.08 + s[4] * 0.1, on * (0.4 + 0.6 * s[5]) * (1 - s[1] * 0.6), s[3] > 0.5 ? col(1.6, 3.0, 0.9) : col(3.0, 2.4, 0.7));
    }
    ring.commit();
  }
  // golden pollen (S6)
  {
    const on = eseg(T, 47.5, 51);
    for (let i = 0; i < pollen.n; i++) {
      const s = pollen.seed[i];
      const x = (s[0] - 0.5) * 30 + Math.sin(T * 0.4 + s[3] * 9) * 1.0;
      const y = 0.5 + ((s[1] * 12 + T * (0.15 + s[4] * 0.2)) % 12);
      const z = (s[2] - 0.5) * 30 + Math.cos(T * 0.35 + s[5] * 9) * 1.0;
      const tw = 0.4 + 0.6 * Math.pow(0.5 + 0.5 * Math.sin(T * 2.5 + s[3] * 40), 2);
      pollen.set(i, x, y, z, 0.06 + s[4] * 0.08, on * tw * 0.7, col(2.4, 1.9, 0.8));
    }
    pollen.commit();
  }
  const ps = (H * SCALE / 2) / Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
  [dust, sparkle, rise, burst, ring, pollen].forEach(p => p.mat.uniforms.uScale.value = ps);
}
const BURST_POS = v3(0, 3.45, 0.6);
const burstLight = new THREE.PointLight(0xff7ac0, 0, 30, 1.5); scene.add(burstLight);

// precompute burst position: fruit location at T=41.4
{ applyFig(figPose(41.4)); const hm = handsMid(); BURST_POS.copy(hm.add(v3(0, 0.12, 0))); }

window.renderAt = (T) => { update(T); composer.render(); return true; };
window.grab = (q = 0.92) => renderer.domElement.toDataURL('image/jpeg', q);
window.ready = true;
