/* mapformat.js — the shared custom-map format, loader, collision runtime and
 * scene view. Used by the Map Builder (editing) and the game (free flight).
 *
 * Map JSON (version 1):
 *   { format: 'aviator-map', version: 1, name,
 *     settings: { timeOfDay, skyColor|null, waterEnabled, waterLevel, windSpeed, windDir, bound, groundColor },
 *     shapes:  [{ id, type, pos[3], rot[3] (degrees [x, y, z], applied yaw-first: Euler order 'YXZ'), scale[3], color '#rrggbb',
 *                 material 'solid'|'transparent'|'emissive', hazard, collide 'collidable'|'decorative', group }],
 *     tunnels: [{ id, points[[x,y,z]…], width, height, profile 'box'|'round', color, material, hazard }] }
 * Unknown fields are ignored with a console warning; only structurally broken data is rejected.
 *
 * The first half is pure maths (no three.js); the MapView class at the end renders a map.
 */
window.AV = window.AV || {};
(function (AV) {
  'use strict';

  const MAP_FORMAT = 'aviator-map';
  const MAP_VERSION = 1;
  const LIMITS = { shapes: 2500, tunnels: 64, tunnelPoints: 64, boundMin: 200, boundMax: 6000, coord: 20000 };

  /** Shape catalogue: unit geometry is scaled by `scale` (metres). */
  const SHAPES = {
    cube: { name: 'Cube', scale: [10, 10, 10], landable: true },
    sphere: { name: 'Sphere', scale: [10, 10, 10] },
    cylinder: { name: 'Cylinder', scale: [8, 12, 8], landable: true },
    cone: { name: 'Cone', scale: [10, 14, 10] },
    ramp: { name: 'Ramp', scale: [14, 6, 24], landable: true },
    arch: { name: 'Arch', scale: [30, 20, 8] },
    torus: { name: 'Ring', scale: [30, 30, 30] },
    tunnelBox: { name: 'Tunnel (box)', scale: [26, 20, 40] },
    tunnelRound: { name: 'Tunnel (round)', scale: [26, 22, 40] },
    start: { name: 'Start pad', scale: [26, 1, 70], tag: true, landable: true, color: '#2ecc71' },
    goal: { name: 'Goal pad', scale: [34, 1, 34], tag: true, landable: true, color: '#f1c40f' },
    checkpoint: { name: 'Checkpoint ring', scale: [34, 34, 34], tag: true, decorative: true, color: '#35e0ff' },
    coin: { name: 'Coin', scale: [6, 6, 6], tag: true, decorative: true, color: '#ffc928' },
  };
  const MATERIALS = ['solid', 'transparent', 'emissive'];
  const PALETTE = ['#e74c3c', '#e67e22', '#f1c40f', '#2ecc71', '#1abc9c', '#3498db', '#2c3e8f', '#9b59b6', '#ecf0f1', '#95a5a6', '#34495e', '#8d6e63'];
  const DEFAULT_SETTINGS = { timeOfDay: 12, skyColor: null, waterEnabled: false, waterLevel: 0, windSpeed: 3, windDir: 240, bound: 1200, groundColor: '#5c8a3a' };

  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  const isHex = (c) => typeof c === 'string' && /^#[0-9a-fA-F]{6}$/.test(c);
  const num = (v, def, lo, hi) => (Number.isFinite(Number(v)) ? clamp(Number(v), lo, hi) : def);
  const vec3 = (v, def, lo, hi) => (Array.isArray(v) && v.length === 3 ? v.map((x, i) => num(x, def[i], lo, hi)) : def.slice());

  let idCounter = 0;
  const newId = (prefix) => `${prefix}${Date.now().toString(36)}${(idCounter++).toString(36)}`;

  function emptyMap(name) {
    return { format: MAP_FORMAT, version: MAP_VERSION, name: name || 'My map', settings: Object.assign({}, DEFAULT_SETTINGS), shapes: [], tunnels: [] };
  }

  function makeShape(type, pos) {
    const def = SHAPES[type];
    return { id: newId('s'), type, pos: (pos || [0, 0, 0]).slice(), rot: [0, 0, 0], scale: def.scale.slice(), color: def.color || PALETTE[5],
      material: type === 'checkpoint' || type === 'coin' ? 'emissive' : 'solid', hazard: false,
      collide: def.decorative ? 'decorative' : 'collidable', group: null };
  }

  function makeTunnel(points) {
    return { id: newId('t'), points: points.map((p) => p.slice()), width: 28, height: 20, profile: 'box', color: '#3498db', material: 'transparent', hazard: false, collide: 'collidable' };
  }

  /** A small sample map used when the editor opens for the first time. */
  function sampleMap() {
    const m = emptyMap('Sample course');
    const add = (type, pos, extra) => { const s = Object.assign(makeShape(type, pos), extra || {}); m.shapes.push(s); return s; };
    add('start', [0, 0.5, 0]);
    add('checkpoint', [0, 40, -220]);
    add('cube', [-60, 15, -330], { scale: [30, 30, 30], color: '#e67e22' });
    add('checkpoint', [60, 55, -420], { rot: [0, 30, 0] });
    add('arch', [0, 10, -560], { color: '#9b59b6' });
    add('coin', [0, 8, -560]);
    add('cylinder', [80, 40, -650], { scale: [14, 80, 14], color: '#e74c3c', hazard: true, material: 'emissive' });
    add('goal', [0, 0.5, -900]);
    m.tunnels.push(Object.assign(makeTunnel([[0, 25, -640], [-40, 30, -720], [0, 25, -800]]), { width: 32, height: 24 }));
    return m;
  }

  // ---------------------------------------------------------------------------
  // Loader: tolerant of unknown fields, strict about structure
  // ---------------------------------------------------------------------------
  const KNOWN_TOP = new Set(['format', 'version', 'name', 'settings', 'shapes', 'tunnels']);
  const KNOWN_SHAPE = new Set(['id', 'type', 'pos', 'rot', 'scale', 'color', 'material', 'hazard', 'collide', 'group']);
  const KNOWN_TUNNEL = new Set(['id', 'points', 'width', 'height', 'profile', 'color', 'material', 'hazard', 'collide']);

  /**
   * Parse and normalise map data. Returns { map, warnings }.
   * Throws Error('…') only when the data is malformed (not an object, wrong format, no shape list).
   */
  function parseMap(raw, opts) {
    const quiet = opts && opts.quiet;
    let obj = raw;
    if (typeof raw === 'string') { try { obj = JSON.parse(raw); } catch (e) { throw new Error('Not valid JSON.'); } }
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) throw new Error('Map data must be a JSON object.');
    if (obj.format !== MAP_FORMAT) throw new Error(`Not a map (format should be "${MAP_FORMAT}").`);
    const version = Number(obj.version);
    if (!Number.isFinite(version) || version < 1) throw new Error('Missing or invalid version field.');
    if (!Array.isArray(obj.shapes)) throw new Error('The map has no "shapes" list.');
    if (obj.tunnels !== undefined && !Array.isArray(obj.tunnels)) throw new Error('"tunnels" must be a list.');
    const warnings = [];
    const unknown = new Set();
    if (version > MAP_VERSION) warnings.push(`Map version ${version} is newer than this game (${MAP_VERSION}); unknown features are ignored.`);
    for (const k of Object.keys(obj)) if (!KNOWN_TOP.has(k)) unknown.add(k);
    const map = emptyMap(typeof obj.name === 'string' ? obj.name.slice(0, 40) : 'Imported map');
    const st = obj.settings && typeof obj.settings === 'object' ? obj.settings : {};
    for (const k of Object.keys(st)) if (!(k in DEFAULT_SETTINGS)) unknown.add('settings.' + k);
    map.settings = {
      timeOfDay: num(st.timeOfDay, 12, 0, 24), skyColor: isHex(st.skyColor) ? st.skyColor : null,
      waterEnabled: !!st.waterEnabled, waterLevel: num(st.waterLevel, 0, -50, 500),
      windSpeed: num(st.windSpeed, 3, 0, 30), windDir: num(st.windDir, 240, 0, 360),
      bound: num(st.bound, DEFAULT_SETTINGS.bound, LIMITS.boundMin, LIMITS.boundMax), groundColor: isHex(st.groundColor) ? st.groundColor : DEFAULT_SETTINGS.groundColor,
    };
    const ids = new Set();
    const uniqueId = (id, prefix) => { let v = typeof id === 'string' && id ? id.slice(0, 32) : newId(prefix); while (ids.has(v)) v = newId(prefix); ids.add(v); return v; };
    let skipped = 0;
    for (const s of obj.shapes.slice(0, LIMITS.shapes)) {
      if (!s || typeof s !== 'object' || !SHAPES[s.type]) { skipped++; continue; }
      for (const k of Object.keys(s)) if (!KNOWN_SHAPE.has(k)) unknown.add('shape.' + k);
      const def = SHAPES[s.type];
      map.shapes.push({
        id: uniqueId(s.id, 's'), type: s.type,
        pos: vec3(s.pos, [0, 0, 0], -LIMITS.coord, LIMITS.coord), rot: vec3(s.rot, [0, 0, 0], -360, 360),
        scale: vec3(s.scale, def.scale, 0.2, 5000), color: isHex(s.color) ? s.color : def.color || PALETTE[5],
        material: MATERIALS.includes(s.material) ? s.material : 'solid', hazard: !!s.hazard,
        collide: s.collide === 'decorative' || (def.decorative && s.collide !== 'collidable') ? 'decorative' : 'collidable',
        group: typeof s.group === 'string' ? s.group.slice(0, 32) : null,
      });
    }
    if (obj.shapes.length > LIMITS.shapes) warnings.push(`Only the first ${LIMITS.shapes} shapes were loaded.`);
    for (const t of (obj.tunnels || []).slice(0, LIMITS.tunnels)) {
      if (!t || typeof t !== 'object' || !Array.isArray(t.points)) { skipped++; continue; }
      for (const k of Object.keys(t)) if (!KNOWN_TUNNEL.has(k)) unknown.add('tunnel.' + k);
      const pts = t.points.filter((p) => Array.isArray(p) && p.length === 3 && p.every((x) => Number.isFinite(Number(x)))).slice(0, LIMITS.tunnelPoints)
        .map((p) => p.map((x) => clamp(Number(x), -LIMITS.coord, LIMITS.coord)));
      if (pts.length < 2) { skipped++; continue; }
      map.tunnels.push({ id: uniqueId(t.id, 't'), points: pts, width: num(t.width, 28, 4, 400), height: num(t.height, 20, 4, 400),
        profile: t.profile === 'round' ? 'round' : 'box', color: isHex(t.color) ? t.color : '#3498db',
        material: MATERIALS.includes(t.material) ? t.material : 'transparent', hazard: !!t.hazard, collide: t.collide === 'decorative' ? 'decorative' : 'collidable' });
    }
    if (skipped) warnings.push(`${skipped} malformed or unknown entr${skipped === 1 ? 'y was' : 'ies were'} skipped.`);
    if (unknown.size) {
      const msg = `Ignored unknown fields: ${[...unknown].slice(0, 8).join(', ')}${unknown.size > 8 ? '…' : ''}`;
      warnings.push(msg);
      if (!quiet) console.warn('[Aviator map loader]', msg);
    }
    return { map, warnings };
  }

  /** Deep copy suitable for saving/exporting. */
  function serializeMap(map) { return JSON.parse(JSON.stringify(map)); }

  // ---------------------------------------------------------------------------
  // Geometry maths
  // ---------------------------------------------------------------------------
  const DEG = Math.PI / 180;
  /** 3×3 rotation (row-major) R = Ry·Rx·Rz for rot = [x, y, z] degrees — same as THREE.Euler(x, y, z, 'YXZ'). */
  function rotationMatrix(rot) {
    const [a, b, c] = rot.map((d) => d * DEG);
    const ca = Math.cos(a), sa = Math.sin(a), cb = Math.cos(b), sb = Math.sin(b), cc = Math.cos(c), sc = Math.sin(c);
    return [cb * cc + sb * sa * sc, -cb * sc + sb * sa * cc, sb * ca,
      ca * sc, ca * cc, -sa,
      -sb * cc + cb * sa * sc, sb * sc + cb * sa * cc, cb * ca];
  }
  const mulT = (R, v) => [R[0] * v[0] + R[3] * v[1] + R[6] * v[2], R[1] * v[0] + R[4] * v[1] + R[7] * v[2], R[2] * v[0] + R[5] * v[1] + R[8] * v[2]];
  const mulR = (R, v) => [R[0] * v[0] + R[1] * v[1] + R[2] * v[2], R[3] * v[0] + R[4] * v[1] + R[5] * v[2], R[6] * v[0] + R[7] * v[1] + R[8] * v[2]];
  const len2 = (x, y) => Math.sqrt(x * x + y * y);
  const len3 = (x, y, z) => Math.sqrt(x * x + y * y + z * z);
  function sdBox(px, py, pz, hx, hy, hz) {
    const qx = Math.abs(px) - hx, qy = Math.abs(py) - hy, qz = Math.abs(pz) - hz;
    return len3(Math.max(qx, 0), Math.max(qy, 0), Math.max(qz, 0)) + Math.min(Math.max(qx, qy, qz), 0);
  }
  function sdBox2(px, py, hx, hy) {
    const qx = Math.abs(px) - hx, qy = Math.abs(py) - hy;
    return len2(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0);
  }
  function sdEllipse2(px, py, rx, ry) { return (len2(px / rx, py / ry) - 1) * Math.min(rx, ry); }
  const wallThickness = (a, b) => Math.max(0.8, 0.07 * Math.min(a, b));

  /** Signed distance (metres, approx.) from a local point to a shape of scale s. Negative = inside. */
  function shapeSD(type, l, s) {
    const [x, y, z] = l, hx = s[0] / 2, hy = s[1] / 2, hz = s[2] / 2;
    switch (type) {
      case 'cube': case 'start': case 'goal': return sdBox(x, y, z, hx, hy, hz);
      case 'sphere': { const k0 = len3(x / hx, y / hy, z / hz), k1 = len3(x / (hx * hx), y / (hy * hy), z / (hz * hz)); return k1 > 0 ? (k0 * (k0 - 1)) / k1 : -Math.min(hx, hy, hz); }
      case 'cylinder': return Math.max(sdEllipse2(x, z, hx, hz), Math.abs(y) - hy);
      case 'cone': { const t = clamp((hy - y) / (2 * hy), 0, 1); return Math.max(sdEllipse2(x, z, Math.max(0.01, hx * t), Math.max(0.01, hz * t)) * 0.7, Math.abs(y) - hy); }
      case 'ramp': return Math.max(sdBox(x, y, z, hx, hy, hz), (y * s[2] - z * s[1]) / len2(s[1], s[2]));
      case 'arch': return Math.max(sdBox(x, y, z, hx, hy, hz), -sdEllipse2(x, y + hy, hx * 0.62, hy * 1.25));
      case 'torus': case 'checkpoint': { const Rm = 0.45 * s[0], rt = Math.max(0.6, 0.05 * s[0]); return len2(len2(x, y) - Rm, z) - rt; }
      case 'coin': return len3(x, y, z) - hx;
      case 'tunnelBox': { const t = wallThickness(s[0], s[1]); return Math.max(Math.max(sdBox2(x, y, hx, hy), -sdBox2(x, y, hx - t, hy - t)), Math.abs(z) - hz); }
      case 'tunnelRound': { const t = wallThickness(s[0], s[1]); return Math.max(Math.max(sdEllipse2(x, y, hx, hy), -sdEllipse2(x, y, hx - t, hy - t)), Math.abs(z) - hz); }
      default: return sdBox(x, y, z, hx, hy, hz);
    }
  }

  /** Centripetal Catmull–Rom sampling. Returns samples [{ p, t, s, u, d }] roughly `step` metres apart. */
  function sampleCurve(points, step) {
    const pts = points.map((p) => p.slice());
    if (pts.length < 2) return [];
    const ext = [pts[0].map((v, k) => 2 * v - pts[1][k]), ...pts, pts[pts.length - 1].map((v, k) => 2 * v - pts[pts.length - 2][k])];
    const raw = [];
    for (let i = 1; i < ext.length - 2; i++) {
      const p0 = ext[i - 1], p1 = ext[i], p2 = ext[i + 1], p3 = ext[i + 2];
      const dist = (a, b) => Math.max(1e-4, Math.sqrt(len3(a[0] - b[0], a[1] - b[1], a[2] - b[2])));
      const t0 = 0, t1 = t0 + dist(p0, p1), t2 = t1 + dist(p1, p2), t3 = t2 + dist(p2, p3);
      const segLen = len3(p2[0] - p1[0], p2[1] - p1[1], p2[2] - p1[2]);
      const n = Math.max(2, Math.ceil(segLen / step));
      for (let j = 0; j < n; j++) {
        const t = t1 + ((t2 - t1) * j) / n;
        const lerp = (a, b, ta, tb) => a.map((v, k) => ((tb - t) / (tb - ta)) * v + ((t - ta) / (tb - ta)) * b[k]);
        const A1 = lerp(p0, p1, t0, t1), A2 = lerp(p1, p2, t1, t2), A3 = lerp(p2, p3, t2, t3);
        const B1 = lerp(A1, A2, t0, t2), B2 = lerp(A2, A3, t1, t3);
        raw.push(lerp(B1, B2, t1, t2));
      }
    }
    raw.push(pts[pts.length - 1].slice());
    const out = [];
    let d = 0;
    for (let i = 0; i < raw.length; i++) {
      const a = raw[Math.max(0, i - 1)], b = raw[Math.min(raw.length - 1, i + 1)];
      let t = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
      const tl = len3(t[0], t[1], t[2]) || 1; t = t.map((v) => v / tl);
      // Right-handed frame: side = up × t, up' = t × side (side × up' = t).
      let sd = [t[2], 0, -t[0]];
      const sl = len2(sd[0], sd[2]);
      sd = sl > 1e-3 ? [sd[0] / sl, 0, sd[2] / sl] : [1, 0, 0];
      const u = [t[1] * sd[2] - t[2] * sd[1], t[2] * sd[0] - t[0] * sd[2], t[0] * sd[1] - t[1] * sd[0]];
      if (i > 0) d += len3(raw[i][0] - raw[i - 1][0], raw[i][1] - raw[i - 1][1], raw[i][2] - raw[i - 1][2]);
      out.push({ p: raw[i], t, s: sd, u, d });
    }
    return out;
  }

  // ---------------------------------------------------------------------------
  // Runtime: spatial index + collision/ground queries for physics and validation
  // ---------------------------------------------------------------------------
  const CELL = 48;

  function prepareShape(s) {
    const R = rotationMatrix(s.rot);
    const he = [0, 1, 2].map((k) => Math.abs(R[k * 3]) * s.scale[0] / 2 + Math.abs(R[k * 3 + 1]) * s.scale[1] / 2 + Math.abs(R[k * 3 + 2]) * s.scale[2] / 2);
    const yawOnly = Math.abs(s.rot[0] % 360) < 1e-3 && Math.abs(s.rot[2] % 360) < 1e-3;
    const def = SHAPES[s.type];
    return {
      kind: 'shape', src: s, R, yaw: s.rot[1] * DEG, yawOnly,
      aabb: { min: s.pos.map((v, k) => v - he[k]), max: s.pos.map((v, k) => v + he[k]) },
      solid: s.collide !== 'decorative', hazard: !!s.hazard, landable: !!def.landable && yawOnly && !s.hazard && s.collide !== 'decorative',
      local(p) { return mulT(R, [p[0] - s.pos[0], p[1] - s.pos[1], p[2] - s.pos[2]]); },
      sd(p) { return shapeSD(s.type, this.local(p), s.scale); },
    };
  }

  function prepareTunnel(t) {
    const samples = sampleCurve(t.points, 3);
    const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
    const pad = Math.max(t.width, t.height);
    for (const sm of samples) for (let k = 0; k < 3; k++) { min[k] = Math.min(min[k], sm.p[k] - pad); max[k] = Math.max(max[k], sm.p[k] + pad); }
    const th = wallThickness(t.width, t.height);
    return {
      kind: 'tunnel', src: t, samples, aabb: { min, max }, solid: t.collide !== 'decorative', hazard: !!t.hazard, landable: false,
      /** Shell distance in the frame of the nearest centreline sample; ends are open. */
      sd(p) {
        let best = 0, bd = Infinity;
        for (let i = 0; i < samples.length; i++) {
          const q = samples[i].p, d = (p[0] - q[0]) ** 2 + (p[1] - q[1]) ** 2 + (p[2] - q[2]) ** 2;
          if (d < bd) { bd = d; best = i; }
        }
        const f = samples[best], dx = p[0] - f.p[0], dy = p[1] - f.p[1], dz = p[2] - f.p[2];
        const lx = dx * f.s[0] + dy * f.s[1] + dz * f.s[2], ly = dx * f.u[0] + dy * f.u[1] + dz * f.u[2], lz = dx * f.t[0] + dy * f.t[1] + dz * f.t[2];
        const hw = t.width / 2, hh = t.height / 2;
        const shell = t.profile === 'round' ? Math.max(sdEllipse2(lx, ly, hw, hh), -sdEllipse2(lx, ly, hw - th, hh - th))
          : Math.max(sdBox2(lx, ly, hw, hh), -sdBox2(lx, ly, hw - th, hh - th));
        const endGap = (best === 0 && lz < 0) || (best === samples.length - 1 && lz > 0) ? Math.abs(lz) : -Infinity;
        return Math.max(shell, endGap);
      },
    };
  }

  function createRuntime(map) {
    const items = [];
    for (const s of map.shapes) items.push(prepareShape(s));
    for (const t of map.tunnels || []) if (t.points.length >= 2) items.push(prepareTunnel(t));
    const grid = new Map();
    const key = (i, j) => i * 73856093 ^ j * 19349663;
    for (const it of items) {
      const i0 = Math.floor(it.aabb.min[0] / CELL), i1 = Math.floor(it.aabb.max[0] / CELL);
      const j0 = Math.floor(it.aabb.min[2] / CELL), j1 = Math.floor(it.aabb.max[2] / CELL);
      if ((i1 - i0 + 1) * (j1 - j0 + 1) > 4000) { it.huge = true; continue; }
      for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) {
        const k = key(i, j);
        if (!grid.has(k)) grid.set(k, []);
        grid.get(k).push(it);
      }
    }
    const huge = items.filter((it) => it.huge);
    const st = map.settings;
    const near = (x, z) => { const cell = grid.get(key(Math.floor(x / CELL), Math.floor(z / CELL))); return huge.length ? (cell || []).concat(huge) : cell || []; };
    const shapesOf = (type) => map.shapes.filter((s) => s.type === type);
    const groundColor = hexToRgb(st.groundColor);
    return {
      map, items, settings: st,
      waterLevel: st.waterEnabled ? st.waterLevel : -1e9,
      starts: shapesOf('start'), goals: shapesOf('goal'), checkpoints: shapesOf('checkpoint'), coins: shapesOf('coin'),
      near,
      /** Highest landable surface under (x,z) that is not far above y (flat ground at 0 otherwise). */
      groundY(x, z, y) {
        const limit = y === undefined ? Infinity : y + 2.5;
        let best = 0;
        for (const it of near(x, z)) {
          if (!it.landable || x < it.aabb.min[0] || x > it.aabb.max[0] || z < it.aabb.min[2] || z > it.aabb.max[2]) continue;
          const top = surfaceTop(it, x, z);
          if (top !== null && top <= limit && top > best) best = top;
        }
        return best;
      },
      surfaceAt(x, z) {
        if (st.waterEnabled && st.waterLevel > 0.05 && this.groundY(x, z) < st.waterLevel) return 'water';
        for (const it of near(x, z)) {
          if (!it.landable || x < it.aabb.min[0] || x > it.aabb.max[0] || z < it.aabb.min[2] || z > it.aabb.max[2]) continue;
          if (surfaceTop(it, x, z) !== null) return it.src.type === 'start' || it.src.type === 'goal' ? 'pad' : 'runway';
        }
        return 'grass';
      },
      /** false, 'hazard' or 'obstacle' for a point (the aircraft's centre of mass). */
      collide(x, y, z) {
        const p = [x, y, z];
        for (const it of near(x, z)) {
          if (!it.solid && !it.hazard) continue;
          if (y < it.aabb.min[1] - 3 || y > it.aabb.max[1] + 3) continue;
          const d = it.sd(p);
          if (it.hazard && d < 1.5) return 'hazard';
          if (it.solid && d < 0) return 'obstacle';
        }
        return false;
      },
      /** Minimum distance to any solid or hazardous item (used by the reachability check). */
      solidDistance(x, y, z) {
        let best = Infinity;
        const p = [x, y, z];
        for (const it of near(x, z)) {
          if (!it.solid && !it.hazard) continue;
          const d = it.sd(p);
          if (d < best) best = d;
        }
        return best;
      },
      mapColor(x, z) {
        let top = -Infinity, color = null;
        for (const it of near(x, z)) {
          if (it.kind !== 'shape' || x < it.aabb.min[0] || x > it.aabb.max[0] || z < it.aabb.min[2] || z > it.aabb.max[2]) continue;
          if (it.aabb.max[1] > top) { top = it.aabb.max[1]; color = it.src.hazard ? [230, 60, 60] : hexToRgb(it.src.color); }
        }
        if (color) return color;
        if (st.waterEnabled && st.waterLevel > 0.05) return [40, 90, 140];
        return groundColor;
      },
      /** Ring crossing test for checkpoints (segment prev→cur through the ring disc). */
      crossesCheckpoint(cp, prev, cur) {
        const R = rotationMatrix(cp.rot);
        const a = mulT(R, [prev[0] - cp.pos[0], prev[1] - cp.pos[1], prev[2] - cp.pos[2]]);
        const b = mulT(R, [cur[0] - cp.pos[0], cur[1] - cp.pos[1], cur[2] - cp.pos[2]]);
        if ((a[2] > 0) === (b[2] > 0) || a[2] === b[2]) return false;
        const t = a[2] / (a[2] - b[2]);
        return len2(a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t) <= 0.47 * cp.scale[0];
      },
      /** True if (x,z) is over the footprint of pad shape s. */
      overPad(s, x, z) {
        const R = rotationMatrix(s.rot);
        const l = mulT(R, [x - s.pos[0], 0, z - s.pos[2]]);
        return Math.abs(l[0]) <= s.scale[0] / 2 && Math.abs(l[2]) <= s.scale[2] / 2;
      },
      /** Spawn on the first start pad, nose along the pad's -Z (heading from its yaw). */
      spawn() {
        const s = this.starts[0];
        if (!s) return { x: 0, y: 120, z: 0, heading: 0, onGround: false };
        const R = rotationMatrix(s.rot);
        const back = mulR(R, [0, 0, s.scale[2] * 0.38]);
        const fwd = mulR(R, [0, 0, -1]);
        return { x: s.pos[0] + back[0], y: s.pos[1] + s.scale[1] / 2, z: s.pos[2] + back[2], heading: Math.atan2(fwd[0], -fwd[2]), onGround: true };
      },
    };
  }

  function surfaceTop(it, x, z) {
    const s = it.src, c = Math.cos(it.yaw), sn = Math.sin(it.yaw);
    const dx = x - s.pos[0], dz = z - s.pos[2];
    // Inverse yaw (Euler Y) into the shape's frame.
    const lx = c * dx - sn * dz, lz = sn * dx + c * dz;
    const hx = s.scale[0] / 2, hz = s.scale[2] / 2, hy = s.scale[1] / 2;
    if (s.type === 'cylinder') return (lx / hx) ** 2 + (lz / hz) ** 2 <= 1 ? s.pos[1] + hy : null;
    if (Math.abs(lx) > hx || Math.abs(lz) > hz) return null;
    if (s.type === 'ramp') return s.pos[1] - hy + s.scale[1] * (lz / s.scale[2] + 0.5);
    return s.pos[1] + hy;
  }

  function hexToRgb(h) { const n = parseInt(h.slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; }

  // ---------------------------------------------------------------------------
  // Validation (warnings only; malformed data is rejected by parseMap)
  // ---------------------------------------------------------------------------
  function validateMap(map, runtime) {
    const warnings = [];
    const rt = runtime || createRuntime(map);
    const B = map.settings.bound;
    if (!rt.starts.length) warnings.push({ msg: 'No start pad — the aircraft will start in the air at the centre.', id: null });
    if (rt.starts.length > 1) warnings.push({ msg: 'More than one start pad — only the first is used.', id: rt.starts[1].id });
    if (!rt.goals.length) warnings.push({ msg: 'No goal pad — there is no finish to reach.', id: null });
    for (const it of rt.items) {
      const a = it.aabb;
      if (a.min[0] < -B || a.max[0] > B || a.min[2] < -B || a.max[2] > B || a.max[1] > B) {
        warnings.push({ msg: `${it.kind === 'tunnel' ? 'Tunnel' : SHAPES[it.src.type].name} is outside the ${B} m size bound.`, id: it.src.id });
      }
    }
    for (const g of rt.goals) {
      const above = rt.solidDistance(g.pos[0], g.pos[1] + g.scale[1] / 2 + 6, g.pos[2]);
      if (above < 0) warnings.push({ msg: 'The goal pad is buried inside a solid shape.', id: g.id });
    }
    return warnings;
  }

  /**
   * Coarse voxel flood fill through open air from the start to the goal.
   * Returns { reachable: bool|null, cells }. null = nothing to check.
   */
  function checkReachable(map, runtime) {
    const rt = runtime || createRuntime(map);
    if (!rt.starts.length || !rt.goals.length) return { reachable: null };
    // Flood-fill only the region around the content (plus margin), clipped to the size bound.
    const B = map.settings.bound;
    const lo = [Infinity, 0, Infinity], hi = [-Infinity, 0, -Infinity];
    let top = 0;
    for (const it of rt.items) {
      lo[0] = Math.min(lo[0], it.aabb.min[0]); lo[2] = Math.min(lo[2], it.aabb.min[2]);
      hi[0] = Math.max(hi[0], it.aabb.max[0]); hi[2] = Math.max(hi[2], it.aabb.max[2]);
      top = Math.max(top, it.aabb.max[1]);
    }
    for (const k of [0, 2]) { lo[k] = Math.max(-B, lo[k] - 150); hi[k] = Math.min(B, hi[k] + 150); }
    const ymax = Math.min(2000, top + 150);
    const extent = Math.max(hi[0] - lo[0], hi[2] - lo[2], ymax);
    const cs = Math.max(4, extent / 200);
    const nx = Math.ceil((hi[0] - lo[0]) / cs), ny = Math.max(2, Math.ceil(ymax / cs)), nz = Math.ceil((hi[2] - lo[2]) / cs);
    if (nx * ny * nz > 4e6) return { reachable: null };
    const blocked = new Uint8Array(nx * ny * nz), seen = new Uint8Array(nx * ny * nz);
    const idx = (i, j, k) => (j * nz + k) * nx + i;
    const center = (i, j, k) => [lo[0] + (i + 0.5) * cs, (j + 0.5) * cs, lo[2] + (k + 0.5) * cs];
    const water = map.settings.waterEnabled ? map.settings.waterLevel : -Infinity;
    // A cell is blocked when solid lies within half a cell of its centre, so even thin walls cannot leak.
    for (let j = 0; j < ny; j++) for (let k = 0; k < nz; k++) for (let i = 0; i < nx; i++) {
      const c = center(i, j, k);
      if (c[1] < water || rt.solidDistance(c[0], c[1], c[2]) < cs * 0.5) blocked[idx(i, j, k)] = 1;
    }
    const cellOf = (p) => [clamp(Math.floor((p[0] - lo[0]) / cs), 0, nx - 1), clamp(Math.floor(p[1] / cs), 0, ny - 1), clamp(Math.floor((p[2] - lo[2]) / cs), 0, nz - 1)];
    // Look a few cells up from the pad for open air; a pad buried deeper than that is unreachable.
    const freeAbove = (p) => { const c = cellOf(p); for (let j = c[1]; j < Math.min(ny, c[1] + 4); j++) if (!blocked[idx(c[0], j, c[2])]) return [c[0], j, c[2]]; return null; };
    const s = rt.starts[0], g = rt.goals[0];
    const a = freeAbove([s.pos[0], s.pos[1] + s.scale[1] / 2 + cs, s.pos[2]]), b = freeAbove([g.pos[0], g.pos[1] + s.scale[1] / 2 + cs * 0.6, g.pos[2]]);
    if (!a || !b) return { reachable: false };
    const queue = new Int32Array(nx * ny * nz);
    let head = 0, tail = 0;
    queue[tail++] = idx(a[0], a[1], a[2]); seen[queue[0]] = 1;
    const target = idx(b[0], b[1], b[2]);
    while (head < tail) {
      const cur = queue[head++];
      if (cur === target) return { reachable: true };
      const i = cur % nx, k = Math.floor(cur / nx) % nz, j = Math.floor(cur / (nx * nz));
      const nb = [[i + 1, j, k], [i - 1, j, k], [i, j + 1, k], [i, j - 1, k], [i, j, k + 1], [i, j, k - 1]];
      for (const [ii, jj, kk] of nb) {
        if (ii < 0 || jj < 0 || kk < 0 || ii >= nx || jj >= ny || kk >= nz) continue;
        const n = idx(ii, jj, kk);
        if (seen[n] || blocked[n]) continue;
        seen[n] = 1; queue[tail++] = n;
      }
    }
    return { reachable: false };
  }

  // ===========================================================================
  // Rendering half (three.js): instanced map view shared by editor and game
  // ===========================================================================
  const unitGeo = new Map(); // geometry key → { geo, refs }

  function buildUnitGeometry(type) {
    switch (type) {
      case 'cube': case 'pad': return new THREE.BoxGeometry(1, 1, 1);
      case 'sphere': return new THREE.SphereGeometry(0.5, 18, 12);
      case 'cylinder': return new THREE.CylinderGeometry(0.5, 0.5, 1, 18);
      case 'cone': return new THREE.ConeGeometry(0.5, 1, 18);
      case 'ramp': {
        const sh = new THREE.Shape();
        sh.moveTo(-0.5, -0.5); sh.lineTo(0.5, -0.5); sh.lineTo(0.5, 0.5); sh.lineTo(-0.5, -0.5);
        const g = new THREE.ExtrudeGeometry(sh, { depth: 1, bevelEnabled: false });
        g.translate(0, 0, -0.5); g.rotateY(-Math.PI / 2);   // shape x → world z, rises toward +Z
        return g;
      }
      case 'arch': {
        // Outline of a block with an elliptical opening cut up from the base.
        const sh2 = new THREE.Shape();
        sh2.moveTo(-0.5, -0.5); sh2.lineTo(-0.31, -0.5);
        sh2.absellipse(0, -0.5, 0.31, 0.625, Math.PI, 0, true);
        sh2.lineTo(0.5, -0.5); sh2.lineTo(0.5, 0.5); sh2.lineTo(-0.5, 0.5); sh2.lineTo(-0.5, -0.5);
        const g = new THREE.ExtrudeGeometry(sh2, { depth: 1, bevelEnabled: false, curveSegments: 16 });
        g.translate(0, 0, -0.5);
        return g;
      }
      case 'torus': return new THREE.TorusGeometry(0.45, 0.05, 10, 36);
      case 'coin': { const g = new THREE.CylinderGeometry(0.5, 0.5, 0.14, 20); g.rotateX(Math.PI / 2); return g; }
      case 'tunnelBox': return tubeGeometry(boxProfile(0.5, 0.5, 0.5 - 0.07, 0.5 - 0.07), [[0, 0, -0.5], [0, 0, 0.5]], true);
      case 'tunnelRound': return tubeGeometry(roundProfile(0.5, 0.5, 0.43, 0.43, 24), [[0, 0, -0.5], [0, 0, 0.5]], true);
      case 'arrow': { const g = new THREE.ConeGeometry(0.5, 1, 3); g.rotateX(-Math.PI / 2); return g; }
      case 'flag': {
        const pole = new THREE.CylinderGeometry(0.02, 0.02, 1, 5); pole.translate(0, 0.5, 0);
        const cloth = new THREE.BoxGeometry(0.35, 0.22, 0.01); cloth.translate(0.18, 0.88, 0);
        return mergeSimple([pole, cloth]);
      }
      default: return new THREE.BoxGeometry(1, 1, 1);
    }
  }

  function mergeSimple(list) {
    const parts = list.map((g) => (g.index ? g.toNonIndexed() : g));
    let n = 0;
    for (const g of parts) n += g.attributes.position.count;
    const pos = new Float32Array(n * 3), nor = new Float32Array(n * 3);
    let o = 0;
    for (const g of parts) { if (!g.attributes.normal) g.computeVertexNormals(); pos.set(g.attributes.position.array, o * 3); nor.set(g.attributes.normal.array, o * 3); o += g.attributes.position.count; g.dispose(); }
    const out = new THREE.BufferGeometry();
    out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    out.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
    return out;
  }

  function boxProfile(hw, hh, iw, ih) {
    return { outer: [[hw, hh], [-hw, hh], [-hw, -hh], [hw, -hh]], inner: [[iw, ih], [-iw, ih], [-iw, -ih], [iw, -ih]] };
  }
  function roundProfile(rx, ry, ix, iy, n) {
    const outer = [], inner = [];
    for (let i = 0; i < n; i++) { const a = (i / n) * Math.PI * 2; outer.push([Math.cos(a) * rx, Math.sin(a) * ry]); inner.push([Math.cos(a) * ix, Math.sin(a) * iy]); }
    return { outer, inner };
  }

  /** Sweep a hollow profile along a polyline (or tunnel samples) into a closed-wall tube. */
  function tubeGeometry(profile, path, straight) {
    const frames = straight
      ? path.map((p) => ({ p, s: [1, 0, 0], u: [0, 1, 0] }))
      : path;
    const n = profile.outer.length;
    const pos = [], idx = [];
    const ring = (f, pts) => { const base = pos.length / 3; for (const [x, y] of pts) pos.push(f.p[0] + f.s[0] * x + f.u[0] * y, f.p[1] + f.s[1] * x + f.u[1] * y, f.p[2] + f.s[2] * x + f.u[2] * y); return base; };
    const outerRings = frames.map((f) => ring(f, profile.outer));
    const innerRings = frames.map((f) => ring(f, profile.inner));
    for (let r = 0; r < frames.length - 1; r++) for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      const a = outerRings[r] + i, b = outerRings[r] + j, c = outerRings[r + 1] + j, d = outerRings[r + 1] + i;
      idx.push(a, b, c, a, c, d);
      const e = innerRings[r] + i, f2 = innerRings[r] + j, g = innerRings[r + 1] + j, h = innerRings[r + 1] + i;
      idx.push(e, g, f2, e, h, g);
    }
    for (const [r, flip] of [[0, true], [frames.length - 1, false]]) for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      const a = outerRings[r] + i, b = outerRings[r] + j, c = innerRings[r] + j, d = innerRings[r] + i;
      if (flip) idx.push(a, c, b, a, d, c); else idx.push(a, b, c, a, c, d);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setIndex(idx);
    g.computeVertexNormals();
    return g;
  }

  function acquireUnit(type) {
    let e = unitGeo.get(type);
    if (!e) { e = { geo: buildUnitGeometry(type), refs: 0 }; unitGeo.set(type, e); }
    e.refs++;
    return e.geo;
  }
  function releaseUnit(type) {
    const e = unitGeo.get(type);
    if (e && --e.refs <= 0) { e.geo.dispose(); unitGeo.delete(type); }
  }

  const RENDER_TYPE = { start: 'pad', goal: 'pad', checkpoint: 'torus' };

  function makeMaterial(kind) {
    if (kind === 'transparent') return new THREE.MeshLambertMaterial({ color: 0xffffff, transparent: true, opacity: 0.42, depthWrite: false, side: THREE.DoubleSide });
    if (kind === 'emissive') return new THREE.MeshBasicMaterial({ color: 0xffffff });
    return new THREE.MeshLambertMaterial({ color: 0xffffff });
  }

  /**
   * Renders a map with one InstancedMesh per (shape type × material), plus a mesh per tunnel.
   * opts.colorFor(shapeId, baseColor) → THREE.Color override (editor highlighting).
   */
  class MapView {
    constructor(opts) {
      this.group = new THREE.Group();
      this.group.name = 'custom-map';
      this.opts = opts || {};
      this.batches = new Map();     // key → { mesh, ids, capacity, type, material }
      this.tunnels = new Map();     // id → { mesh, hash, material }
      this.hidden = new Set();
      this.markers = new Map();     // extra decoration batches (start arrows, goal flags)
      this._m = new THREE.Matrix4(); this._q = new THREE.Quaternion(); this._e = new THREE.Euler(); this._c = new THREE.Color();
      this.spin = 0;
    }

    /** Rebuild instance buffers from the map (cheap even for thousands of shapes). */
    sync(map) {
      this.map = map;
      const want = new Map();
      for (const s of map.shapes) {
        const key = (RENDER_TYPE[s.type] || s.type) + '|' + s.material;
        if (!want.has(key)) want.set(key, []);
        want.get(key).push(s);
      }
      // Decorations for gameplay tags.
      const deco = new Map([['arrow|emissive', map.shapes.filter((s) => s.type === 'start')], ['flag|emissive', map.shapes.filter((s) => s.type === 'goal')]]);
      for (const [key, list] of deco) if (list.length) want.set(key, list.map((s) => Object.assign({}, s, { _deco: true })));
      for (const [key, b] of this.batches) {
        if (!want.has(key)) { this.group.remove(b.mesh); b.mesh.material.dispose(); b.mesh.dispose(); releaseUnit(b.type); this.batches.delete(key); }
      }
      for (const [key, list] of want) {
        let b = this.batches.get(key);
        if (b && list.length > b.capacity) { this.group.remove(b.mesh); b.mesh.material.dispose(); b.mesh.dispose(); releaseUnit(b.type); this.batches.delete(key); b = null; }
        if (!b) {
          const [type, material] = key.split('|');
          const capacity = Math.max(8, 1 << Math.ceil(Math.log2(list.length + 1)));
          const mesh = new THREE.InstancedMesh(acquireUnit(type), makeMaterial(material), capacity);
          mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
          mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 3), 3);
          mesh.frustumCulled = false;
          mesh.castShadow = material === 'solid';
          mesh.receiveShadow = material === 'solid';
          mesh.userData.batch = key;
          this.group.add(mesh);
          b = { mesh, ids: [], capacity, type, material, list: [] };
          this.batches.set(key, b);
        }
        b.list = list;
        b.ids = list.map((s) => s.id);
        b.mesh.count = list.length;
        this.writeBatch(b);
      }
      this.syncTunnels(map.tunnels || []);
    }

    writeBatch(b) {
      const m = this._m, q = this._q, e = this._e;
      const pos = new THREE.Vector3(), sc = new THREE.Vector3();
      b.list.forEach((s, i) => {
        e.set(s.rot[0] * DEG, s.rot[1] * DEG, s.rot[2] * DEG, 'YXZ');
        q.setFromEuler(e);
        if (b.type === 'arrow') {
          pos.set(0, s.scale[1] / 2 + 0.6, -s.scale[2] * 0.15).applyQuaternion(q).add(sc.set(s.pos[0], s.pos[1], s.pos[2]));
          m.compose(pos, q, sc.set(s.scale[0] * 0.35, 0.4, s.scale[0] * 0.5));
        } else if (b.type === 'flag') {
          pos.set(s.scale[0] * 0.42, s.scale[1] / 2, s.scale[2] * 0.42).applyQuaternion(q).add(sc.set(s.pos[0], s.pos[1], s.pos[2]));
          m.compose(pos, q, sc.set(14, 14, 14));
        } else {
          const hide = this.hidden.has(s.id);
          if (s.type === 'coin') q.multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), this.spin));
          m.compose(pos.set(s.pos[0], s.pos[1], s.pos[2]), q, hide ? sc.set(0, 0, 0) : sc.set(s.scale[0], s.scale[1], s.scale[2]));
        }
        b.mesh.setMatrixAt(i, m);
      });
      b.mesh.instanceMatrix.needsUpdate = true;
      this.writeColors(b);
    }

    writeColors(b) {
      const c = this._c, f = this.opts.colorFor;
      b.list.forEach((s, i) => {
        c.set(b.type === 'arrow' ? '#ffffff' : b.type === 'flag' ? '#e74c3c' : s.hazard ? '#ff3b30' : s.color);
        if (s.hazard && b.type !== 'arrow' && b.type !== 'flag') c.lerp(new THREE.Color(s.color), 0.35);
        if (f && !s._deco) { const o = f(s.id, c); if (o) c.copy(o); }
        b.mesh.setColorAt(i, c);
      });
      if (b.mesh.instanceColor) b.mesh.instanceColor.needsUpdate = true;
    }

    refreshColors() {
      for (const b of this.batches.values()) this.writeColors(b);
      for (const t of this.tunnels.values()) this.colorTunnel(t);
    }

    syncTunnels(list) {
      const seen = new Set();
      for (const t of list) {
        seen.add(t.id);
        const hash = JSON.stringify([t.points, t.width, t.height, t.profile, t.material]);
        let e = this.tunnels.get(t.id);
        if (e && e.hash !== hash) { this.disposeTunnel(e); e = null; }
        if (!e) {
          const samples = sampleCurve(t.points, 3);
          if (samples.length < 2) continue;
          const th = wallThickness(t.width, t.height);
          const prof = t.profile === 'round' ? roundProfile(t.width / 2, t.height / 2, t.width / 2 - th, t.height / 2 - th, 20)
            : boxProfile(t.width / 2, t.height / 2, t.width / 2 - th, t.height / 2 - th);
          const mesh = new THREE.Mesh(tubeGeometry(prof, samples, false), makeMaterial(t.material));
          mesh.userData.tunnelId = t.id;
          mesh.castShadow = t.material === 'solid';
          this.group.add(mesh);
          e = { mesh, hash, src: t };
          this.tunnels.set(t.id, e);
        }
        e.src = t;
        this.colorTunnel(e);
      }
      for (const [id, e] of this.tunnels) if (!seen.has(id)) { this.disposeTunnel(e); this.tunnels.delete(id); }
    }

    colorTunnel(e) {
      const c = this._c.set(e.src.hazard ? '#ff3b30' : e.src.color);
      const f = this.opts.colorFor;
      if (f) { const o = f(e.src.id, c); if (o) c.copy(o); }
      e.mesh.material.color.copy(c);
    }

    disposeTunnel(e) { this.group.remove(e.mesh); e.mesh.geometry.dispose(); e.mesh.material.dispose(); }

    /** Hide/show one instance (collected coins). */
    setHidden(id, hidden) {
      if (hidden) this.hidden.add(id); else this.hidden.delete(id);
      for (const b of this.batches.values()) if (b.ids.includes(id)) this.writeBatch(b);
    }

    /** Spin coins (gameplay only). */
    animate(dt) {
      this.spin += dt * 2.5;
      for (const b of this.batches.values()) if (b.type === 'coin') this.writeBatch(b);
    }

    /** Raycast against shapes and tunnels: { id, point, normal } or null. */
    pick(raycaster) {
      const objs = [];
      for (const b of this.batches.values()) if (b.type !== 'arrow' && b.type !== 'flag') objs.push(b.mesh);
      for (const e of this.tunnels.values()) objs.push(e.mesh);
      const hits = raycaster.intersectObjects(objs, false);
      for (const h of hits) {
        let id = null;
        if (h.object.isInstancedMesh) {
          const b = this.batches.get(h.object.userData.batch);
          id = b && h.instanceId !== undefined ? b.ids[h.instanceId] : null;
        } else id = h.object.userData.tunnelId;
        if (!id) continue;
        let normal = null;
        if (h.face) {
          normal = h.face.normal.clone();
          if (h.object.isInstancedMesh) {
            const im = new THREE.Matrix4(); h.object.getMatrixAt(h.instanceId, im);
            normal.transformDirection(im);
          }
        }
        return { id, point: h.point.clone(), normal };
      }
      return null;
    }

    dispose() {
      for (const b of this.batches.values()) { this.group.remove(b.mesh); b.mesh.material.dispose(); b.mesh.dispose(); releaseUnit(b.type); }
      this.batches.clear();
      for (const e of this.tunnels.values()) this.disposeTunnel(e);
      this.tunnels.clear();
    }
  }

  AV.MapFormat = {
    MAP_FORMAT, MAP_VERSION, LIMITS, SHAPES, MATERIALS, PALETTE, DEFAULT_SETTINGS,
    emptyMap, sampleMap, makeShape, makeTunnel, newId, parseMap, serializeMap,
    rotationMatrix, shapeSD, sampleCurve, createRuntime, validateMap, checkReachable, hexToRgb,
    MapView, unitGeometryCount: () => unitGeo.size,
  };
})(window.AV);
