/*
 * Bridger Reserve: the drive, on real terrain.
 * WebGL2 relief of the Gallatin Valley and Big Sky with the actual roads drawn in gold.
 * Scroll moves the camera from BZN to Moonlight Basin. The relief image stands in when
 * WebGL2 is missing, data saving is on, or the visitor prefers reduced motion.
 */

const EXAG = 1.6; // vertical exaggeration, so the range reads at this distance
const LIFT = 0.045; // world units above the mesh for routes, labels and the light
const FOG = [0.043, 0.078, 0.145];

// Camera keys, in world units: x east (km), y up (km x EXAG), z south (km).
export const KEYS = [
  { pos: [4.0, 13.0, -20.0], tgt: [-12.0, 4.4, 24.0], fov: 35 }, // 0  the valley to the peaks
  { pos: [-2.0, 9.0, -4.0], tgt: [14.0, 2.6, -20.0], fov: 38 }, // 1  BZN to Bozeman, the Bridgers behind
  { pos: [10.0, 14.0, -8.0], tgt: [-6.0, 3.6, 30.0], fov: 38 }, // 2  down the canyon to Big Sky
  { pos: [-2.0, 7.8, 20.0], tgt: [-15.0, 4.4, 31.0], fov: 38 }, // 3  Moonlight Basin under Lone Peak
  { pos: [-4.0, 44.0, 44.0], tgt: [-2.0, 2.4, -2.0], fov: 36 }, // 4  the whole road, back to BZN
  { pos: [-20.0, 15.0, 58.0], tgt: [-12.0, 3.6, 24.0], fov: 38 }, // 5  Yellowstone Club, Lone Peak, Big Sky
];

// Which place names show on which beat.
const LABELS = {
  bzn: [1, 2, 4],
  bozeman: [1],
  bigsky: [2, 3, 4, 5],
  moonlight: [3, 4],
  lonepeak: [2, 3, 5],
  yc: [5],
};

/* ---------------- small math ---------------- */
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a) => {
  const l = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const smooth = (e0, e1, x) => {
  const t = clamp((x - e0) / (e1 - e0), 0, 1);
  return t * t * (3 - 2 * t);
};
const SUN = norm([-0.86, 0.3, 0.41]); // low, west-southwest

function perspective(fovy, aspect, near, far, sx, sy) {
  const f = 1 / Math.tan(fovy / 2);
  const nf = 1 / (near - far);
  // sx, sy shift the image in NDC units (lens shift), so the scene can sit beside a card
  return [f / aspect, 0, 0, 0, 0, f, 0, 0, -sx, -sy, (far + near) * nf, -1, 0, 0, 2 * far * near * nf, 0];
}

function lookAt(eye, target) {
  const z = norm(sub(eye, target));
  const x = norm(cross([0, 1, 0], z));
  const y = cross(z, x);
  return {
    m: [x[0], y[0], z[0], 0, x[1], y[1], z[1], 0, x[2], y[2], z[2], 0, -dot(x, eye), -dot(y, eye), -dot(z, eye), 1],
    right: x,
    up: y,
    fwd: [-z[0], -z[1], -z[2]],
  };
}

function mul(a, b) {
  const o = new Array(16);
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      let s = 0;
      for (let k = 0; k < 4; k++) s += a[k * 4 + r] * b[c * 4 + k];
      o[c * 4 + r] = s;
    }
  }
  return o;
}

function catmull(p0, p1, p2, p3, t) {
  const t2 = t * t;
  const t3 = t2 * t;
  return 0.5 * (2 * p1 + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 + (-p0 + 3 * p1 - 3 * p2 + p3) * t3);
}

function cameraAt(p) {
  const n = KEYS.length - 1;
  const i = clamp(Math.floor(p), 0, n - 1);
  const t = clamp(p - i, 0, 1);
  const k = (j) => KEYS[clamp(j, 0, n)];
  const lerp3 = (field) => [0, 1, 2].map((c) => catmull(k(i - 1)[field][c], k(i)[field][c], k(i + 1)[field][c], k(i + 2)[field][c], t));
  return { pos: lerp3("pos"), tgt: lerp3("tgt"), fov: k(i).fov + (k(i + 1).fov - k(i).fov) * t };
}

/* ---------------- shaders ---------------- */
const VS_SKY = `#version 300 es
in vec2 a_p;
out vec2 v_p;
void main() { v_p = a_p; gl_Position = vec4(a_p, 0.0, 1.0); }`;

const SKY_FN = `
vec3 skyColor(vec3 dir, vec3 sun, vec3 fog) {
  float e = dir.y;
  vec3 c = mix(fog, vec3(0.010, 0.016, 0.034), smoothstep(-0.02, 0.45, e));
  float s = max(dot(normalize(dir.xz + 1e-5), normalize(sun.xz)), 0.0);
  return c + vec3(0.62, 0.45, 0.24) * pow(s, 9.0) * exp(-max(e, 0.0) * 11.0) * 0.20;
}`;

const FS_SKY = `#version 300 es
precision highp float;
in vec2 v_p;
uniform vec3 u_fwd, u_right, u_up, u_sun, u_fog;
uniform vec2 u_tan, u_shift;
out vec4 o;
${SKY_FN}
float hash(vec2 p) { p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
void main() {
  vec2 q = (v_p - u_shift) * u_tan;
  vec3 dir = normalize(u_fwd + q.x * u_right + q.y * u_up);
  float e = dir.y;
  vec3 c = skyColor(dir, u_sun, u_fog);
  vec2 g = vec2(atan(dir.z, dir.x), asin(clamp(e, -1.0, 1.0))) * 95.0;
  vec2 id = floor(g);
  vec2 f = fract(g);
  float px = max(fwidth(g.y), 1e-4);
  float d = length(f - vec2(hash(id + 3.1), hash(id + 7.7))) / px;
  float star = step(0.987, hash(id)) * (1.0 - smoothstep(0.35, 1.25, d)) * smoothstep(0.05, 0.24, e);
  c += vec3(0.95, 0.9, 0.8) * star * (0.25 + 0.5 * hash(id + 11.3));
  o = vec4(c, 1.0);
}`;

const VS_TERRAIN = `#version 300 es
in vec3 a_pos;
uniform mat4 u_vp;
uniform float u_exag;
uniform vec4 u_map;   // x_min, z_min, 1/(x range), 1/(z range)
uniform vec4 u_tex;   // texel-centre scale and offset for u, v
out vec3 v_world;
out vec2 v_uv;
out vec2 v_n;
void main() {
  vec3 p = vec3(a_pos.x, a_pos.y * u_exag, a_pos.z);
  v_world = p;
  v_n = vec2((a_pos.x - u_map.x) * u_map.z, (a_pos.z - u_map.y) * u_map.w);
  v_uv = v_n * u_tex.xy + u_tex.zw;
  gl_Position = u_vp * vec4(p, 1.0);
}`;

const FS_TERRAIN = `#version 300 es
precision highp float;
in vec3 v_world;
in vec2 v_uv;
in vec2 v_n;
uniform sampler2D u_height;
uniform vec2 u_texel, u_cell;
uniform float u_exag, u_fogK, u_lines, u_lo, u_span;
uniform vec3 u_cam, u_sun, u_fog;
out vec4 o;
${SKY_FN}
float H(vec2 uv) { return u_lo + u_span * texture(u_height, uv).r; }
void main() {
  vec2 tx = vec2(u_texel.x, 0.0);
  vec2 ty = vec2(0.0, u_texel.y);
  float h = H(v_uv);
  float tl = H(v_uv - tx - ty), tc = H(v_uv - ty), tr = H(v_uv + tx - ty);
  float ml = H(v_uv - tx), mr = H(v_uv + tx);
  float bl = H(v_uv - tx + ty), bc = H(v_uv + ty), br = H(v_uv + tx + ty);
  float dx = ((tr + 2.0 * mr + br) - (tl + 2.0 * ml + bl)) / (8.0 * u_cell.x);
  float dz = ((bl + 2.0 * bc + br) - (tl + 2.0 * tc + tr)) / (8.0 * u_cell.y);
  vec3 n = normalize(vec3(-dx * u_exag, 1.0, -dz * u_exag));
  vec3 v = normalize(u_cam - v_world);
  float lam = max(dot(n, u_sun), 0.0);
  float t = clamp((h - 1.25) / 2.1, 0.0, 1.0);
  float sky = 0.5 + 0.5 * n.y;
  vec3 col = mix(vec3(0.026, 0.044, 0.088), vec3(0.072, 0.114, 0.196), sky);
  float key = pow(clamp((lam - 0.1) / 0.9, 0.0, 1.0), 1.4);
  col += vec3(0.80, 0.60, 0.34) * key * (0.46 + 0.42 * t);
  col += vec3(0.10, 0.16, 0.28) * pow(lam, 0.7) * 0.4;
  float snow = smoothstep(2.55, 3.1, h) * smoothstep(0.45, 0.8, n.y);
  col = mix(col, vec3(0.92, 0.86, 0.74) * (0.3 + 0.7 * lam), snow * 0.55);
  col += vec3(0.93, 0.83, 0.64) * pow(1.0 - max(dot(n, v), 0.0), 4.0) * 0.07;
  float m = h * 1000.0;
  float fw = max(fwidth(m), 1e-3);
  float d1 = abs(fract(m / 100.0 + 0.5) - 0.5) * 100.0;
  float d5 = abs(fract(m / 500.0 + 0.5) - 0.5) * 500.0;
  float l1 = (1.0 - smoothstep(0.35 * fw, 1.1 * fw, d1)) * clamp(1.6 - fw / 22.0, 0.0, 1.0);
  float l5 = (1.0 - smoothstep(0.5 * fw, 1.6 * fw, d5)) * clamp(1.6 - fw / 110.0, 0.0, 1.0);
  col = mix(col, vec3(0.925, 0.827, 0.635), (l1 * 0.15 + l5 * 0.36) * u_lines);
  float dist = length(v_world - u_cam);
  float fog = 1.0 - exp(-pow(dist * u_fogK, 1.5));
  vec2 e = min(v_n, 1.0 - v_n);
  float edge = smoothstep(0.0, 0.16, min(e.x, e.y));
  vec3 bg = skyColor(-v, u_sun, u_fog);
  o = vec4(mix(bg, col, (1.0 - fog) * edge), 1.0);
}`;

const VS_ROUTE = `#version 300 es
in vec3 a_pos;
in vec3 a_prev;
in vec3 a_next;
in float a_side;
in float a_t;
uniform mat4 u_vp;
uniform vec2 u_res;
uniform float u_width, u_exag, u_lift;
out float v_side;
out float v_t;
vec4 P(vec3 p) { return u_vp * vec4(p.x, p.y * u_exag + u_lift, p.z, 1.0); }
void main() {
  vec4 c = P(a_pos);
  vec4 pr = P(a_prev);
  vec4 nx = P(a_next);
  float w = max(c.w, 1e-3);
  vec2 sc = c.xy / w;
  vec2 d = (nx.xy / max(nx.w, 1e-3) - pr.xy / max(pr.w, 1e-3)) * u_res;
  d = length(d) > 1e-5 ? normalize(d) : vec2(1.0, 0.0);
  vec2 off = vec2(-d.y, d.x) * a_side * u_width * 2.0 / u_res;
  v_side = a_side;
  v_t = a_t;
  gl_Position = c.w < 1e-3 ? vec4(2.0, 2.0, 2.0, 1.0) : vec4((sc + off) * w, c.z, w);
}`;

const FS_ROUTE = `#version 300 es
precision highp float;
in float v_side;
in float v_t;
uniform float u_from, u_to, u_alpha, u_core;
uniform vec3 u_color;
out vec4 o;
void main() {
  if (v_t < u_from || v_t > u_to) discard;
  float d = abs(v_side);
  float core = 1.0 - smoothstep(u_core * 0.55, u_core, d);
  float glow = exp(-d * d * 5.0) * 0.26;
  float head = smoothstep(u_to - 0.015, u_to, v_t) * step(u_to, 0.999) * exp(-d * d * 3.0) * 0.7;
  float a = (core + glow + head) * u_alpha;
  o = vec4(u_color * a, a);
}`;

function compile(gl, vs, fs) {
  const make = (type, src) => {
    const s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) || "shader");
    return s;
  };
  const p = gl.createProgram();
  gl.attachShader(p, make(gl.VERTEX_SHADER, vs));
  gl.attachShader(p, make(gl.FRAGMENT_SHADER, fs));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p) || "link");
  const u = {};
  const count = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
  for (let i = 0; i < count; i++) {
    const info = gl.getActiveUniform(p, i);
    u[info.name] = gl.getUniformLocation(p, info.name);
  }
  return { p, u };
}

/* ---------------- data ---------------- */
async function decodeHeights(url) {
  const blob = await (await fetch(url)).blob();
  let img;
  try {
    img = await createImageBitmap(blob, { colorSpaceConversion: "none", premultiplyAlpha: "none" });
  } catch {
    img = await new Promise((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = reject;
      el.src = URL.createObjectURL(blob);
    });
  }
  const c = document.createElement("canvas");
  c.width = img.width;
  c.height = img.height;
  const ctx = c.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(img, 0, 0);
  return { w: img.width, h: img.height, px: ctx.getImageData(0, 0, img.width, img.height).data };
}

function buildTerrain(meta, img, step) {
  const { w: W, h: H, px } = img;
  const g = meta.grid;
  const lo = meta.elev.min / 1000;
  const span = (meta.elev.max - meta.elev.min) / 1000;
  const shift = 16 - (g.bits || 16);
  const levels = 2 ** (g.bits || 16) - 1;
  const heights = new Float32Array(W * H);
  for (let i = 0; i < W * H; i++) {
    const v = ((px[i * 4] << 8) | px[i * 4 + 1]) >> shift;
    heights[i] = lo + (v / levels) * span;
  }
  const dx = (g.x_max - g.x_min) / (W - 1);
  const dz = (g.z_max - g.z_min) / (H - 1);
  const gw = Math.floor((W - 1) / step) + 1;
  const gh = Math.floor((H - 1) / step) + 1;
  const pos = new Float32Array(gw * gh * 3);
  const mesh = new Float32Array(gw * gh);
  for (let j = 0; j < gh; j++) {
    for (let i = 0; i < gw; i++) {
      const k = j * gw + i;
      const y = heights[j * step * W + i * step];
      mesh[k] = y;
      pos[k * 3] = g.x_min + i * step * dx;
      pos[k * 3 + 1] = y;
      pos[k * 3 + 2] = g.z_min + j * step * dz;
    }
  }
  const idx = new Uint32Array((gw - 1) * (gh - 1) * 6);
  let n = 0;
  for (let j = 0; j < gh - 1; j++) {
    for (let i = 0; i < gw - 1; i++) {
      const a = j * gw + i;
      const b = a + 1;
      const c = a + gw;
      const d = c + 1;
      idx[n++] = a;
      idx[n++] = b;
      idx[n++] = c;
      idx[n++] = b;
      idx[n++] = d;
      idx[n++] = c;
    }
  }
  // Height of the drawn mesh itself (same triangle split), so routes sit on it, not under it.
  const cx = dx * step;
  const cz = dz * step;
  const meshHeight = (x, z) => {
    const fx0 = clamp((x - g.x_min) / cx, 0, gw - 1.0001);
    const fz0 = clamp((z - g.z_min) / cz, 0, gh - 1.0001);
    const i = Math.floor(fx0);
    const j = Math.floor(fz0);
    const fx = fx0 - i;
    const fz = fz0 - j;
    const a = mesh[j * gw + i];
    const b = mesh[j * gw + i + 1];
    const c = mesh[(j + 1) * gw + i];
    const d = mesh[(j + 1) * gw + i + 1];
    return fx + fz <= 1 ? a + (b - a) * fx + (c - a) * fz : d + (c - d) * (1 - fx) + (b - d) * (1 - fz);
  };
  return { W, H, heights, pos, idx, meshHeight, dx, dz };
}

function routeTail(full, shared) {
  // The Moonlight route shares the road to Big Sky; draw only the part after it turns off.
  const near = (p) => shared.some((q) => Math.hypot(p[0] - q[0], p[1] - q[1]) < 0.09);
  let i = 0;
  while (i < full.length && near(full[i])) i++;
  return full.slice(Math.max(0, i - 2));
}

function buildRoute(points, meshHeight) {
  const pts = points.map((p) => [p[0], meshHeight(p[0], p[1]), p[1]]);
  const cum = [0];
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][2] - pts[i - 1][2]));
  const total = cum[cum.length - 1] || 1;
  const data = new Float32Array(pts.length * 2 * 11);
  let o = 0;
  for (let i = 0; i < pts.length; i++) {
    const prev = pts[Math.max(0, i - 1)];
    const next = pts[Math.min(pts.length - 1, i + 1)];
    for (const side of [-1, 1]) {
      data.set(pts[i], o);
      data.set(prev, o + 3);
      data.set(next, o + 6);
      data[o + 9] = side;
      data[o + 10] = cum[i] / total;
      o += 11;
    }
  }
  const at = (t) => {
    const d = clamp(t, 0, 1) * total;
    let i = 1;
    while (i < cum.length - 1 && cum[i] < d) i++;
    const f = (d - cum[i - 1]) / (cum[i] - cum[i - 1] || 1);
    const a = pts[i - 1];
    const b = pts[i];
    return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f];
  };
  return { data, count: pts.length * 2, at };
}

/* ---------------- main ---------------- */
export async function startFlight({ stage, canvas, beats, debug = false }) {
  const gl = canvas.getContext("webgl2", { antialias: true, alpha: false, depth: true, powerPreference: "high-performance" });
  if (!gl) throw new Error("webgl2");

  const small = Math.min(window.innerWidth, window.innerHeight) < 600;
  const weak = (navigator.hardwareConcurrency || 4) <= 2 || (navigator.deviceMemory || 4) <= 2;
  const step = weak ? 4 : small ? 3 : 2;

  const [meta, img] = await Promise.all([
    fetch("assets/terrain.json").then((r) => r.json()),
    decodeHeights("assets/terrain.webp"),
  ]);
  const T = buildTerrain(meta, img, step);
  const g = meta.grid;

  const sky = compile(gl, VS_SKY, FS_SKY);
  const ter = compile(gl, VS_TERRAIN, FS_TERRAIN);
  const rte = compile(gl, VS_ROUTE, FS_ROUTE);

  // sky: one big triangle
  const skyVao = gl.createVertexArray();
  gl.bindVertexArray(skyVao);
  gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  const skyLoc = gl.getAttribLocation(sky.p, "a_p");
  gl.enableVertexAttribArray(skyLoc);
  gl.vertexAttribPointer(skyLoc, 2, gl.FLOAT, false, 0, 0);

  // terrain
  const terVao = gl.createVertexArray();
  gl.bindVertexArray(terVao);
  gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
  gl.bufferData(gl.ARRAY_BUFFER, T.pos, gl.STATIC_DRAW);
  const terLoc = gl.getAttribLocation(ter.p, "a_pos");
  gl.enableVertexAttribArray(terLoc);
  gl.vertexAttribPointer(terLoc, 3, gl.FLOAT, false, 0, 0);
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, gl.createBuffer());
  gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, T.idx, gl.STATIC_DRAW);
  const terCount = T.idx.length;

  const lo = meta.elev.min / 1000;
  const span = (meta.elev.max - meta.elev.min) / 1000;
  const unit = new Float32Array(T.heights.length);
  for (let i = 0; i < unit.length; i++) unit[i] = (T.heights[i] - lo) / span;
  const linearFloat = Boolean(gl.getExtension("OES_texture_float_linear"));
  const tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
  gl.texImage2D(gl.TEXTURE_2D, 0, linearFloat ? gl.R32F : gl.R16F, T.W, T.H, 0, gl.RED, gl.FLOAT, unit);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

  // routes
  const R = meta.routes;
  const routes = {
    town: buildRoute(R.downtown.points, T.meshHeight),
    sky: buildRoute(R.mtnvillage.points, T.meshHeight),
    moon: buildRoute(routeTail(R.oneonly.points, R.mtnvillage.points), T.meshHeight),
    full: buildRoute(R.oneonly.points, T.meshHeight),
  };
  const routeAttr = ["a_pos", "a_prev", "a_next", "a_side", "a_t"].map((n) => gl.getAttribLocation(rte.p, n));
  for (const r of Object.values(routes)) {
    r.vao = gl.createVertexArray();
    gl.bindVertexArray(r.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
    gl.bufferData(gl.ARRAY_BUFFER, r.data, gl.STATIC_DRAW);
    const sizes = [3, 3, 3, 1, 1];
    let off = 0;
    routeAttr.forEach((loc, i) => {
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, sizes[i], gl.FLOAT, false, 44, off * 4);
      off += sizes[i];
    });
  }
  gl.bindVertexArray(null);

  // labels and the travelling light
  const labels = [...stage.querySelectorAll("[data-place]")]
    .map((el) => {
      const p = meta.places[el.dataset.place];
      return p ? { el, key: el.dataset.place, x: p.x, z: p.z, y: T.meshHeight(p.x, p.z) } : null;
    })
    .filter(Boolean);
  const light = stage.querySelector(".flight-light");

  let width = 0;
  let height = 0;
  let dpr = 1;
  let wide = false;
  function resize() {
    dpr = Math.min(window.devicePixelRatio || 1, small ? 1.75 : 2);
    width = canvas.clientWidth;
    height = canvas.clientHeight;
    canvas.width = Math.max(1, Math.round(width * dpr));
    canvas.height = Math.max(1, Math.round(height * dpr));
    wide = width >= 900;
  }

  let vp = null;
  function project(x, y, z) {
    const c = [0, 1, 2, 3].map((r) => vp[r] * x + vp[4 + r] * y + vp[8 + r] * z + vp[12 + r]);
    if (c[3] <= 0.01) return null;
    return [((c[0] / c[3] + 1) / 2) * width, ((1 - c[1] / c[3]) / 2) * height];
  }

  function hidden(from, x, y, z) {
    // march the ray from the camera to the point over the mesh
    for (let s = 1; s < 44; s++) {
      const f = s / 44;
      if (f > 0.97) break;
      const px = from[0] + (x - from[0]) * f;
      const py = from[1] + (y - from[1]) * f;
      const pz = from[2] + (z - from[2]) * f;
      if (T.meshHeight(px, pz) * EXAG > py + 0.02) return true;
    }
    return false;
  }

  function draw(p) {
    const cam = cameraAt(p);
    const shiftX = wide ? 0.26 : 0;
    const shiftY = wide ? 0 : 0.24;
    const view = lookAt(cam.pos, cam.tgt);
    const fovy = (cam.fov * Math.PI) / 180;
    const aspect = width / height;
    const proj = perspective(fovy, aspect, 0.08, 260, shiftX, shiftY);
    vp = mul(proj, view.m);

    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.BLEND);
    gl.depthMask(true);
    gl.clearColor(FOG[0], FOG[1], FOG[2], 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

    // sky
    gl.useProgram(sky.p);
    const tanY = Math.tan(fovy / 2);
    gl.uniform3fv(sky.u.u_fwd, view.fwd);
    gl.uniform3fv(sky.u.u_right, view.right);
    gl.uniform3fv(sky.u.u_up, view.up);
    gl.uniform3fv(sky.u.u_sun, SUN);
    gl.uniform3fv(sky.u.u_fog, FOG);
    gl.uniform2f(sky.u.u_tan, tanY * aspect, tanY);
    gl.uniform2f(sky.u.u_shift, shiftX, shiftY);
    gl.bindVertexArray(skyVao);
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    // terrain
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);
    gl.useProgram(ter.p);
    gl.uniformMatrix4fv(ter.u.u_vp, false, vp);
    gl.uniform1f(ter.u.u_exag, EXAG);
    gl.uniform4f(ter.u.u_map, g.x_min, g.z_min, 1 / (g.x_max - g.x_min), 1 / (g.z_max - g.z_min));
    gl.uniform4f(ter.u.u_tex, (T.W - 1) / T.W, (T.H - 1) / T.H, 0.5 / T.W, 0.5 / T.H);
    gl.uniform2f(ter.u.u_texel, 1 / T.W, 1 / T.H);
    gl.uniform2f(ter.u.u_cell, T.dx, T.dz);
    gl.uniform3fv(ter.u.u_cam, cam.pos);
    gl.uniform3fv(ter.u.u_sun, SUN);
    gl.uniform3fv(ter.u.u_fog, FOG);
    gl.uniform1f(ter.u.u_fogK, 1 / 150);
    gl.uniform1f(ter.u.u_lines, 1);
    gl.uniform1f(ter.u.u_lo, lo);
    gl.uniform1f(ter.u.u_span, span);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.uniform1i(ter.u.u_height, 0);
    gl.bindVertexArray(terVao);
    gl.drawElements(gl.TRIANGLES, terCount, gl.UNSIGNED_INT, 0);

    // routes
    const town = smooth(0.25, 1.0, p);
    const toSky = smooth(1.15, 2.0, p);
    const toMoon = smooth(2.15, 3.0, p);
    const back = smooth(3.15, 4.0, p);
    const dim = 1 - 0.55 * smooth(4.2, 5.0, p);
    gl.useProgram(rte.p);
    gl.uniformMatrix4fv(rte.u.u_vp, false, vp);
    gl.uniform2f(rte.u.u_res, canvas.width, canvas.height);
    gl.uniform1f(rte.u.u_exag, EXAG);
    gl.uniform1f(rte.u.u_lift, LIFT);
    gl.uniform1f(rte.u.u_width, 7 * dpr);
    gl.uniform1f(rte.u.u_core, 0.2);
    gl.uniform3f(rte.u.u_color, 0.96, 0.86, 0.66);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE);
    gl.depthMask(false);
    const line = (r, to, alpha) => {
      if (to <= 0.001) return;
      gl.uniform1f(rte.u.u_from, 0);
      gl.uniform1f(rte.u.u_to, to);
      gl.uniform1f(rte.u.u_alpha, alpha);
      gl.bindVertexArray(r.vao);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, r.count);
    };
    const ghost = 0.16 * (1 - 0.5 * smooth(4.2, 5.0, p));
    line(routes.town, 1, ghost);
    line(routes.sky, 1, ghost);
    line(routes.moon, 1, ghost);
    line(routes.town, town, 0.9 * dim * (1 - 0.45 * smooth(1.2, 2.0, p)));
    line(routes.sky, toSky, 0.95 * dim);
    line(routes.moon, toMoon, 0.95 * dim);
    gl.depthMask(true);
    gl.bindVertexArray(null);

    // the travelling light rides the head of whichever road is being drawn
    let head = null;
    if (p < 1.05) head = town > 0.02 && town < 0.995 ? routes.town.at(town) : null;
    else if (p < 2.05) head = toSky > 0.005 && toSky < 0.995 ? routes.sky.at(toSky) : null;
    else if (p < 3.05) head = toMoon > 0.005 && toMoon < 0.995 ? routes.moon.at(toMoon) : null;
    else if (p < 4.1) head = back > 0.005 && back < 0.995 ? routes.full.at(1 - back) : null;
    if (light) {
      const s = head && project(head[0], head[1] * EXAG + LIFT, head[2]);
      const show = s && !hidden(cam.pos, head[0], head[1] * EXAG + LIFT + 0.03, head[2]);
      light.classList.toggle("is-on", Boolean(show));
      if (show) light.style.transform = `translate3d(${s[0].toFixed(1)}px, ${s[1].toFixed(1)}px, 0)`;
    }

    // place names
    const beat = Math.round(p);
    for (const l of labels) {
      const y = l.y * EXAG + LIFT;
      const s = project(l.x, y, l.z);
      const inView = s && s[0] > 24 && s[0] < width - 24 && s[1] > 56 && s[1] < height - 24;
      const show = inView && LABELS[l.key].includes(beat) && !hidden(cam.pos, l.x, y + 0.05, l.z);
      l.el.classList.toggle("is-on", Boolean(show));
      if (s) l.el.style.transform = `translate3d(${s[0].toFixed(1)}px, ${s[1].toFixed(1)}px, 0)`;
    }
  }

  // scroll to progress
  let tops = [];
  function measure() {
    tops = beats.map((b) => b.getBoundingClientRect().top + window.scrollY);
  }
  function progress() {
    const y = window.scrollY;
    if (!tops.length || y <= tops[0]) return 0;
    for (let i = 0; i < tops.length - 1; i++) {
      if (y < tops[i + 1]) {
        const f = (y - tops[i]) / (tops[i + 1] - tops[i]);
        return i + smooth(0.12, 0.88, f);
      }
    }
    return tops.length - 1;
  }

  let target = 0;
  let current = 0;
  let raf = 0;
  let last = 0;
  let live = true;
  function tick(now) {
    raf = 0;
    const dt = last ? Math.min(0.05, (now - last) / 1000) : 0.016;
    last = now;
    current += (target - current) * (1 - Math.exp(-dt * 6.5));
    if (Math.abs(target - current) < 0.0004) current = target;
    draw(current);
    if (current !== target) raf = requestAnimationFrame(tick);
    else last = 0;
  }
  const kick = () => {
    if (live && !raf) raf = requestAnimationFrame(tick);
  };
  const onScroll = () => {
    target = progress();
    kick();
  };

  resize();
  measure();
  target = current = progress();
  draw(current);
  stage.dataset.state = "live";

  window.addEventListener("scroll", onScroll, { passive: true });
  let rz = 0;
  window.addEventListener("resize", () => {
    cancelAnimationFrame(rz);
    rz = requestAnimationFrame(() => {
      resize();
      measure();
      target = progress();
      draw(current);
    });
  });
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => { measure(); onScroll(); });
  new IntersectionObserver((entries) => {
    live = entries[0].isIntersecting;
    if (live) onScroll();
  }).observe(stage.parentElement);

  canvas.addEventListener("webglcontextlost", (event) => {
    event.preventDefault();
    live = false;
    stage.dataset.state = "static";
  });

  const api = {
    draw: (p) => {
      current = target = p;
      draw(p);
    },
    keys: KEYS,
    meshHeight: T.meshHeight,
    sample(place) {
      const pl = meta.places[place];
      if (!pl) return null;
      const g2 = meta.grid;
      const i = Math.round(((pl.x - g2.x_min) / (g2.x_max - g2.x_min)) * (T.W - 1));
      const j = Math.round(((pl.z - g2.z_min) / (g2.z_max - g2.z_min)) * (T.H - 1));
      return { decodedMetres: Math.round(T.heights[j * T.W + i] * 1000), expectedMetres: pl.h };
    },
    info: () => ({ step, width, height, dpr, triangles: terCount / 3, progress: current, linearFloat }),
  };
  if (debug) window.__flight = api;
  return api;
}
