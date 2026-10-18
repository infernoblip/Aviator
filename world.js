/* world.js — procedural terrain, biomes, sky, sun, clouds, water, props and chunk streaming.
 *
 * The first section (AV.Terrain) is pure maths with no three.js dependency so it can be
 * sampled anywhere (physics ground queries, minimap, mission placement, Node tests).
 * The second section (AV.World) builds and streams the three.js scene.
 *
 * Geography (designed core, blending into pure noise beyond ~15 km):
 *   centre  — Meadowlands: rolling grassland, forests, villages, the home airfield
 *   east    — Coast: beaches, lighthouse, open sea
 *   south   — Sunscar Desert: dunes, mesas, cacti
 *   north   — Frost Peaks: ridged mountains with snow caps
 */
window.AV = window.AV || {};
(function (AV) {
  'use strict';

  const WORLD_SEED = 1337;

  // ---------------------------------------------------------------------------
  // Seeded PRNG + 2D simplex noise
  // ---------------------------------------------------------------------------
  function mulberry32(a) {
    return function () {
      a |= 0; a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  /** Integer hash of two coordinates + salt → [0,1). Used for per-chunk decisions. */
  function hash2(x, z, salt) {
    let h = (x * 374761393 + z * 668265263 + (salt || 0) * 982451653 + WORLD_SEED * 2654435761) | 0;
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
  }

  function makeSimplex(seed) {
    const rand = mulberry32(seed);
    const perm = new Uint8Array(512);
    const p = new Uint8Array(256);
    for (let i = 0; i < 256; i++) p[i] = i;
    for (let i = 255; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); const t = p[i]; p[i] = p[j]; p[j] = t; }
    for (let i = 0; i < 512; i++) perm[i] = p[i & 255];
    const grad = [[1, 1], [-1, 1], [1, -1], [-1, -1], [1, 0], [-1, 0], [0, 1], [0, -1]];
    const F2 = 0.5 * (Math.sqrt(3) - 1), G2 = (3 - Math.sqrt(3)) / 6;
    return function noise2(xin, yin) {
      const s = (xin + yin) * F2;
      const i = Math.floor(xin + s), j = Math.floor(yin + s);
      const t = (i + j) * G2;
      const x0 = xin - (i - t), y0 = yin - (j - t);
      const i1 = x0 > y0 ? 1 : 0, j1 = x0 > y0 ? 0 : 1;
      const x1 = x0 - i1 + G2, y1 = y0 - j1 + G2, x2 = x0 - 1 + 2 * G2, y2 = y0 - 1 + 2 * G2;
      const ii = i & 255, jj = j & 255;
      let n = 0;
      let t0 = 0.5 - x0 * x0 - y0 * y0;
      if (t0 > 0) { const g = grad[perm[ii + perm[jj]] & 7]; t0 *= t0; n += t0 * t0 * (g[0] * x0 + g[1] * y0); }
      let t1 = 0.5 - x1 * x1 - y1 * y1;
      if (t1 > 0) { const g = grad[perm[ii + i1 + perm[jj + j1]] & 7]; t1 *= t1; n += t1 * t1 * (g[0] * x1 + g[1] * y1); }
      let t2 = 0.5 - x2 * x2 - y2 * y2;
      if (t2 > 0) { const g = grad[perm[ii + 1 + perm[jj + 1]] & 7]; t2 *= t2; n += t2 * t2 * (g[0] * x2 + g[1] * y2); }
      return 70 * n; // ≈ [-1, 1]
    };
  }

  const noise = makeSimplex(WORLD_SEED);
  const noiseB = makeSimplex(WORLD_SEED + 101);
  const fbm = (x, z, oct, n) => {
    let a = 0.5, f = 1, s = 0, norm = 0;
    for (let i = 0; i < oct; i++) { s += a * (n || noise)(x * f, z * f); norm += a; a *= 0.5; f *= 2.03; }
    return s / norm;
  };
  const ridged = (x, z, oct) => {
    let a = 0.5, f = 1, s = 0, norm = 0, w = 1;
    for (let i = 0; i < oct; i++) {
      let v = 1 - Math.abs(noiseB(x * f, z * f)); v *= v * w; w = Math.min(1, v * 2);
      s += a * v; norm += a; a *= 0.5; f *= 2.1;
    }
    return s / norm;
  };
  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  const smoothstep = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
  const lerp = (a, b, t) => a + (b - a) * t;

  // ---------------------------------------------------------------------------
  // Airfields, pads and landmarks (world coordinates; -Z is north)
  // ---------------------------------------------------------------------------
  /** heading: runway direction in degrees (0 = north). length/width in metres. */
  const AIRFIELDS = [
    { id: 'meadow', name: 'Meadow Field', x: 0, z: 0, heading: 0, length: 1000, width: 32, elev: null, lights: true },
    { id: 'dune', name: 'Dune Strip', x: -1400, z: 5600, heading: 90, length: 800, width: 26, elev: null },
    { id: 'harbor', name: 'Harbor Field', x: 3000, z: -1700, heading: 20, length: 700, width: 26, elev: null },
    { id: 'summit', name: 'Summit Pad', x: 700, z: -6200, heading: 340, length: 320, width: 40, elev: null, pad: true },
  ];

  const LANDMARKS = [
    { id: 'meadow', name: 'Meadow Field', x: 0, z: 0, kind: 'airfield' },
    { id: 'windfarm', name: 'Breezy Ridge Wind Farm', x: 1650, z: 700, kind: 'windfarm' },
    { id: 'millbrook', name: 'Millbrook Village', x: -1300, z: -900, kind: 'village' },
    { id: 'lighthouse', name: 'Gull Point Lighthouse', x: 2500, z: 400, kind: 'lighthouse', shore: 25 },
    { id: 'harbor', name: 'Harbor Field', x: 3000, z: -1700, kind: 'airfield' },
    { id: 'dune', name: 'Dune Strip', x: -1400, z: 5600, kind: 'airfield' },
    { id: 'mesa', name: 'Red Mesa', x: 900, z: 4600, kind: 'mesa' },
    { id: 'summit', name: 'Summit Pad', x: 700, z: -6200, kind: 'airfield' },
    { id: 'tower', name: 'Frostwatch Radio Mast', x: -1600, z: -5400, kind: 'tower' },
  ];

  /** Walk east from (x0, z) to find the last dry point before the sea (used to place coastal props). */
  function findShore(x0, z) {
    let last = x0;
    for (let x = x0; x < x0 + 6000; x += 20) {
      if (rawHeight(x, z) < 1) return last;
      last = x;
    }
    return last;
  }

  // Pre-compute each runway's local frame.
  for (const a of AIRFIELDS) {
    const h = (a.heading * Math.PI) / 180;
    a.dir = { x: Math.sin(h), z: -Math.cos(h) };      // along runway
    a.side = { x: Math.cos(h), z: Math.sin(h) };      // across runway
  }

  /** Coordinates of (x,z) in a runway frame: along (+ toward heading), across. */
  function runwayLocal(a, x, z) {
    const dx = x - a.x, dz = z - a.z;
    return { along: dx * a.dir.x + dz * a.dir.z, across: dx * a.side.x + dz * a.side.z };
  }

  // ---------------------------------------------------------------------------
  // Terrain field
  // ---------------------------------------------------------------------------
  /** Region masks: how strongly each designed biome applies at (x,z). */
  function regionMasks(x, z) {
    const r = Math.hypot(x, z);
    const design = 1 - smoothstep(13000, 19000, r);
    const warp = noise(x * 0.0006, z * 0.0006);
    const sea = design * smoothstep(3500, 4700, x + 650 * warp) +
      (1 - design) * smoothstep(0.05, 0.4, -fbm(x * 0.00008 + 40, z * 0.00008, 3));
    const mountain = design * smoothstep(3000, 6000, -z + 700 * warp) +
      (1 - design) * smoothstep(0.05, 0.45, fbm(x * 0.0001 - 70, z * 0.0001, 3));
    const desert = design * smoothstep(2600, 4300, z + 600 * noise(x * 0.0005 + 9, z * 0.0005)) +
      (1 - design) * smoothstep(0.1, 0.4, fbm(x * 0.00009 + 300, z * 0.00009 - 200, 3));
    return { sea, mountain: mountain * (1 - sea), desert: desert * (1 - sea) * (1 - mountain * 0.8), design };
  }

  /** Raw (unflattened) terrain height. */
  function rawHeight(x, z, masks) {
    const m = masks || regionMasks(x, z);
    const low = 58 + 38 * fbm(x * 0.00045, z * 0.00045, 4);
    const hills = 24 * fbm(x * 0.0019 + 11, z * 0.0019, 3);
    const mountains = m.mountain * (120 + 820 * ridged(x * 0.00055, z * 0.00055, 5));
    let h = low + hills + mountains;
    // Desert: dunes and flat-topped mesas.
    if (m.desert > 0.01) {
      const dunes = 9 * Math.abs(Math.sin(x * 0.012 + 3 * noise(x * 0.002, z * 0.002))) * (0.6 + 0.4 * noise(z * 0.004, x * 0.004));
      const mesaN = noise(x * 0.0009 + 50, z * 0.0009);
      const mesa = 140 * smoothstep(0.45, 0.52, mesaN);
      h = lerp(h, 25 + dunes + mesa + 10 * fbm(x * 0.003, z * 0.003, 2), m.desert);
    }
    // Sea: drop below water level with a sandy shelf.
    if (m.sea > 0.001) h = lerp(h, -45 + 15 * noise(x * 0.002, z * 0.002), m.sea);
    return h;
  }

  /** Flatten the terrain around runways and pads. */
  function airfieldBlend(x, z, h) {
    for (let i = 0; i < AIRFIELDS.length; i++) {
      const a = AIRFIELDS[i];
      const dx = x - a.x, dz = z - a.z;
      if (dx * dx + dz * dz > 1100 * 1100) continue;
      if (a.elev === null) a.elev = Math.max(4, rawHeight(a.x, a.z) + (a.pad ? 0 : 2));
      const l = runwayLocal(a, x, z);
      const da = Math.max(0, Math.abs(l.along) - a.length / 2 - 60);
      const dc = Math.max(0, Math.abs(l.across) - a.width / 2 - 70);
      const d = Math.hypot(da, dc);
      const w = 1 - smoothstep(0, a.pad ? 160 : 260, d);
      if (w > 0) h = lerp(h, a.elev, w);
    }
    return h;
  }

  function heightAt(x, z) {
    return airfieldBlend(x, z, rawHeight(x, z));
  }

  /** Ground height for collisions: the water surface counts as ground (physics reports it as water). */
  const SNOW_LINE = 430;

  /** Returns the airfield whose paved surface contains (x,z), or null. */
  function airfieldAt(x, z) {
    for (const a of AIRFIELDS) {
      const l = runwayLocal(a, x, z);
      if (Math.abs(l.along) <= a.length / 2 && Math.abs(l.across) <= a.width / 2) return a;
    }
    return null;
  }

  /** Surface type used by the physics friction model and the minimap. */
  function surfaceAt(x, z) {
    const a = airfieldAt(x, z);
    if (a) return a.pad ? 'pad' : 'runway';
    const h = heightAt(x, z);
    if (h < 0) return 'water';
    return biomeFromHeight(x, z, h, regionMasks(x, z));
  }

  function biomeFromHeight(x, z, h, m) {
    if (h < 0) return 'water';
    if (h < 5 && m.sea > 0.15) return 'sand';
    if (h > SNOW_LINE + 50 * noise(x * 0.004, z * 0.004)) return 'snow';
    if (m.mountain > 0.5 && h > 230) return 'rock';
    if (m.desert > 0.5) return 'sand';
    return 'grass';
  }

  /** Biome label for gameplay/UI (richer than surface type). */
  function biomeAt(x, z) {
    const m = regionMasks(x, z), h = heightAt(x, z);
    const s = biomeFromHeight(x, z, h, m);
    if (s === 'water') return 'Sea';
    if (s === 'snow') return 'Snowy peaks';
    if (s === 'rock') return 'Mountains';
    if (s === 'sand') return m.desert > 0.5 ? 'Desert' : 'Coast';
    return m.sea > 0.05 ? 'Coast' : 'Grassland';
  }

  /** Base terrain colour for a vertex (r,g,b in 0..1) written into `out`. */
  function terrainColor(x, z, h, slope, m, out) {
    const v = 0.06 * noise(x * 0.02, z * 0.02) + 0.04 * noise(x * 0.11, z * 0.11);
    let r, g, b;
    const forest = fbm(x * 0.0012 + 77, z * 0.0012, 2);
    if (h < 0.5) { r = 0.76; g = 0.7; b = 0.5; }                        // seabed / wet sand
    else if (h < 5 && m.sea > 0.15) { r = 0.86; g = 0.8; b = 0.6; }     // beach
    else {
      // grassland base, darker in forests
      r = 0.33 - forest * 0.06; g = 0.52 - forest * 0.06; b = 0.22;
      if (m.desert > 0) {                                               // desert sand → red mesa rock
        const sand = h > 120 ? [0.72, 0.42, 0.28] : [0.87, 0.72, 0.47];
        r = lerp(r, sand[0], m.desert); g = lerp(g, sand[1], m.desert); b = lerp(b, sand[2], m.desert);
      }
      const rockT = clamp((slope - 0.45) * 2.5, 0, 1) * (0.5 + 0.5 * m.mountain) + m.mountain * smoothstep(180, 330, h);
      if (rockT > 0) { r = lerp(r, 0.45, rockT); g = lerp(g, 0.43, rockT); b = lerp(b, 0.42, rockT); }
      const snowT = smoothstep(SNOW_LINE - 40, SNOW_LINE + 40, h + 50 * noise(x * 0.004, z * 0.004)) * (1 - clamp((slope - 0.7) * 3, 0, 0.7));
      if (snowT > 0) { r = lerp(r, 0.95, snowT); g = lerp(g, 0.96, snowT); b = lerp(b, 0.99, snowT); }
    }
    out[0] = clamp(r + v, 0, 1); out[1] = clamp(g + v, 0, 1); out[2] = clamp(b + v * 0.8, 0, 1);
    return out;
  }

  // Snap coastal landmarks onto the real shoreline.
  for (const L of LANDMARKS) if (L.shore) L.x = findShore(L.x, L.z) - L.shore;

  AV.Terrain = {
    WORLD_SEED, AIRFIELDS, LANDMARKS, SNOW_LINE,
    mulberry32, hash2, noise, fbm, smoothstep, clamp, lerp,
    regionMasks, rawHeight, findShore, heightAt, surfaceAt, biomeAt, biomeFromHeight, terrainColor, airfieldAt, runwayLocal,
  };
})(window.AV);

// =============================================================================
// Rendering half: geometry helpers + AV.World (requires three.js)
// =============================================================================
(function (AV) {
  'use strict';
  const T = AV.Terrain;

  // ---------------------------------------------------------------------------
  // Geometry helpers shared with aircraft.js
  // ---------------------------------------------------------------------------
  const Geo = {
    /** Non-indexed copy of `geo` with a constant vertex colour and optional transform. */
    colored(geo, color, matrix) {
      const g = geo.index ? geo.toNonIndexed() : geo.clone();
      if (matrix) g.applyMatrix4(matrix);
      const c = new THREE.Color(color);
      const n = g.attributes.position.count;
      const arr = new Float32Array(n * 3);
      for (let i = 0; i < n; i++) { arr[i * 3] = c.r; arr[i * 3 + 1] = c.g; arr[i * 3 + 2] = c.b; }
      g.setAttribute('color', new THREE.BufferAttribute(arr, 3));
      g.deleteAttribute('uv');
      return g;
    },
    /** Merge non-indexed geometries that share position/normal/color attributes. */
    merge(list) {
      let total = 0;
      for (const g of list) total += g.attributes.position.count;
      const pos = new Float32Array(total * 3), nor = new Float32Array(total * 3), col = new Float32Array(total * 3);
      let o = 0;
      for (const g of list) {
        if (!g.attributes.normal) g.computeVertexNormals();
        pos.set(g.attributes.position.array, o * 3);
        nor.set(g.attributes.normal.array, o * 3);
        col.set(g.attributes.color.array, o * 3);
        o += g.attributes.position.count;
        g.dispose();
      }
      const out = new THREE.BufferGeometry();
      out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      out.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
      out.setAttribute('color', new THREE.BufferAttribute(col, 3));
      out.computeBoundingSphere();
      return out;
    },
    /** Build a transform matrix from position / euler / scale shorthands. */
    mat(x, y, z, rx, ry, rz, sx, sy, sz) {
      const m = new THREE.Matrix4();
      m.compose(new THREE.Vector3(x || 0, y || 0, z || 0),
        new THREE.Quaternion().setFromEuler(new THREE.Euler(rx || 0, ry || 0, rz || 0)),
        new THREE.Vector3(sx || 1, sy === undefined ? sx || 1 : sy, sz === undefined ? sx || 1 : sz));
      return m;
    },
    canvasTexture(w, h, draw) {
      const c = document.createElement('canvas');
      c.width = w; c.height = h;
      draw(c.getContext('2d'), w, h);
      const t = new THREE.CanvasTexture(c);
      t.colorSpace = THREE.SRGBColorSpace;
      return t;
    },
    /** Soft round sprite used for clouds, particles and the sun glow. */
    softDot(size, inner, outerAlpha) {
      return Geo.canvasTexture(size, size, (ctx, w) => {
        const g = ctx.createRadialGradient(w / 2, w / 2, 0, w / 2, w / 2, w / 2);
        g.addColorStop(0, `rgba(255,255,255,1)`);
        g.addColorStop(inner || 0.4, `rgba(255,255,255,${outerAlpha === undefined ? 0.6 : outerAlpha})`);
        g.addColorStop(1, 'rgba(255,255,255,0)');
        ctx.fillStyle = g; ctx.fillRect(0, 0, w, w);
      });
    },
  };
  AV.Geo = Geo;

  const srgbToLinear = (c) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));

  // ---------------------------------------------------------------------------
  // Quality presets
  // ---------------------------------------------------------------------------
  const QUALITY = {
    low: { viewRadius: 2, segments: 24, propSpacing: 38, shadowMap: 0, cloudClusters: 28, pixelRatio: 1, rain: 600, fogScale: 0.8 },
    medium: { viewRadius: 3, segments: 28, propSpacing: 28, shadowMap: 1024, cloudClusters: 48, pixelRatio: 1.25, rain: 1200, fogScale: 1 },
    high: { viewRadius: 4, segments: 32, propSpacing: 25, shadowMap: 2048, cloudClusters: 70, pixelRatio: 2, rain: 2000, fogScale: 1.15 },
  };
  const CHUNK = 500;

  // ---------------------------------------------------------------------------
  // Prop geometry library (merged, vertex-coloured, one InstancedMesh per type)
  // ---------------------------------------------------------------------------
  function buildPropGeometries() {
    const C = (g, color, m) => Geo.colored(g, color, m);
    const M = Geo.mat;
    const P = {};
    P.pine = Geo.merge([
      C(new THREE.CylinderGeometry(0.35, 0.5, 3, 5), 0x5b3a22, M(0, 1.5, 0)),
      C(new THREE.ConeGeometry(3.2, 6, 7), 0x2f5d34, M(0, 5, 0)),
      C(new THREE.ConeGeometry(2.4, 5, 7), 0x356b3a, M(0, 8, 0)),
      C(new THREE.ConeGeometry(1.5, 3.5, 7), 0x3d7742, M(0, 10.8, 0)),
    ]);
    const crown = new THREE.IcosahedronGeometry(3.4, 0);
    P.broadleaf = Geo.merge([
      C(new THREE.CylinderGeometry(0.4, 0.6, 4, 5), 0x6b4428, M(0, 2, 0)),
      C(crown, 0x4f8a3a, M(0, 6.2, 0, 0.3, 0.2, 0, 1, 0.85, 1)),
      C(crown, 0x5c9a42, M(1.4, 7.4, 0.6, 0, 0.8, 0, 0.6)),
    ]);
    const frond = new THREE.ConeGeometry(0.7, 5, 3);
    const palm = [C(new THREE.CylinderGeometry(0.25, 0.4, 8, 5), 0x8a6a40, M(0, 4, 0, 0, 0, 0.12))];
    for (let i = 0; i < 6; i++) palm.push(C(frond, 0x3f8f3a, M(Math.cos(i) * 1.8 + 0.5, 8, Math.sin(i) * 1.8, Math.sin(i) * 1.3, 0, Math.cos(i) * 1.3 + Math.PI / 2 * 0)));
    P.palm = Geo.merge(palm);
    P.cactus = Geo.merge([
      C(new THREE.CylinderGeometry(0.5, 0.55, 5, 6), 0x4b7d3a, M(0, 2.5, 0)),
      C(new THREE.CylinderGeometry(0.32, 0.32, 2, 6), 0x4b7d3a, M(1.0, 3, 0, 0, 0, 0)),
      C(new THREE.CylinderGeometry(0.32, 0.32, 1.2, 6), 0x4b7d3a, M(0.6, 2.2, 0, 0, 0, Math.PI / 2)),
      C(new THREE.CylinderGeometry(0.3, 0.3, 1.6, 6), 0x4b7d3a, M(-0.9, 3.6, 0)),
      C(new THREE.CylinderGeometry(0.3, 0.3, 1.0, 6), 0x4b7d3a, M(-0.55, 3.0, 0, 0, 0, Math.PI / 2)),
    ]);
    const rock = new THREE.DodecahedronGeometry(1, 0);
    const rp = rock.attributes.position;
    const rr = T.mulberry32(9);
    for (let i = 0; i < rp.count; i++) rp.setXYZ(i, rp.getX(i) * (0.8 + rr() * 0.4), rp.getY(i) * (0.6 + rr() * 0.3), rp.getZ(i) * (0.8 + rr() * 0.4));
    rock.computeVertexNormals();
    P.rock = Geo.merge([C(rock, 0x8a8580, M(0, 0.3, 0))]);
    const roof = new THREE.CylinderGeometry(1, 1, 1, 3, 1);
    P.house = Geo.merge([
      C(new THREE.BoxGeometry(8, 5, 6), 0xf2ead8, M(0, 2.5, 0)),
      C(roof, 0xb5523b, M(0, 6.2, 0, 0, 0, Math.PI / 2, 2.3, 8.6, 4.2)),
      C(new THREE.BoxGeometry(1.4, 2.4, 0.2), 0x5a3a24, M(0, 1.2, 3.05)),
      C(new THREE.BoxGeometry(1.2, 1.2, 0.2), 0x9fc6e0, M(2.4, 3, 3.05)),
      C(new THREE.BoxGeometry(1.2, 1.2, 0.2), 0x9fc6e0, M(-2.4, 3, 3.05)),
    ]);
    P.church = Geo.merge([
      C(new THREE.BoxGeometry(9, 7, 16), 0xe8e0d0, M(0, 3.5, 0)),
      C(roof, 0x6b5e5a, M(0, 8.3, 0, 0, 0, Math.PI / 2, 2.6, 16.5, 5.2)),
      C(new THREE.BoxGeometry(4.5, 16, 4.5), 0xe8e0d0, M(0, 8, -9.5)),
      C(new THREE.ConeGeometry(3.4, 8, 4), 0x6b5e5a, M(0, 20, -9.5, 0, Math.PI / 4, 0)),
    ]);
    P.turbineBase = Geo.merge([
      C(new THREE.CylinderGeometry(1.0, 2.0, 60, 8), 0xf4f4f4, M(0, 30, 0)),
      C(new THREE.BoxGeometry(2.6, 2.6, 7), 0xf0f0f0, M(0, 61, 0.8)),
    ]);
    const blade = new THREE.BoxGeometry(1.6, 24, 0.4);
    P.turbineRotor = Geo.merge([
      C(new THREE.ConeGeometry(1.3, 2.6, 8), 0xffffff, M(0, 0, -1.3, -Math.PI / 2)),
      C(blade, 0xf8f8f8, M(0, 12.5, 0)),
      C(blade, 0xf8f8f8, M(Math.cos(Math.PI / 6) * 12.5, -6.25, 0, 0, 0, -2 * Math.PI / 3)),
      C(blade, 0xf8f8f8, M(-Math.cos(Math.PI / 6) * 12.5, -6.25, 0, 0, 0, 2 * Math.PI / 3)),
    ]);
    const mast = [];
    for (let i = 0; i < 8; i++) {
      const r0 = 2.2 - i * 0.24;
      mast.push(C(new THREE.CylinderGeometry(r0 - 0.24, r0, 12, 4), i % 2 ? 0xffffff : 0xd8332a, M(0, 6 + i * 12, 0)));
    }
    mast.push(C(new THREE.SphereGeometry(0.9, 6, 4), 0xff3020, M(0, 97, 0)));
    P.mast = Geo.merge(mast);
    const lh = [];
    for (let i = 0; i < 5; i++) lh.push(C(new THREE.CylinderGeometry(3.4 - i * 0.35 - 0.35, 3.4 - i * 0.35, 5, 12), i % 2 ? 0xd8332a : 0xffffff, M(0, 2.5 + i * 5, 0)));
    lh.push(C(new THREE.CylinderGeometry(2.0, 2.0, 3, 10), 0xfff2a0, M(0, 26.5, 0)));
    lh.push(C(new THREE.ConeGeometry(2.4, 2.5, 10), 0x333333, M(0, 29.2, 0)));
    lh.push(C(new THREE.CylinderGeometry(4.8, 5.2, 2, 10), 0x777777, M(0, 0.5, 0)));
    P.lighthouse = Geo.merge(lh);
    const shell = new THREE.CylinderGeometry(14, 14, 36, 14, 1, false, 0, Math.PI);
    P.hangar = Geo.merge([
      C(shell, 0x9aa3ad, M(0, 0, 0, Math.PI / 2, 0, Math.PI / 2)),
      C(new THREE.BoxGeometry(24, 12, 0.5), 0x4a5560, M(0, 6, 18)),
      C(new THREE.BoxGeometry(28, 0.6, 37), 0x707a84, M(0, 0.3, 0)),
    ]);
    P.ctower = Geo.merge([
      C(new THREE.CylinderGeometry(2.4, 3, 16, 8), 0xe0e0e0, M(0, 8, 0)),
      C(new THREE.CylinderGeometry(4.4, 3.4, 4, 8), 0x406080, M(0, 18, 0)),
      C(new THREE.CylinderGeometry(4.8, 4.8, 0.6, 8), 0xdddddd, M(0, 20.3, 0)),
    ]);
    P.windsock = Geo.merge([
      C(new THREE.CylinderGeometry(0.12, 0.12, 7, 4), 0xcccccc, M(0, 3.5, 0)),
      C(new THREE.CylinderGeometry(0.5, 0.25, 3, 6, 1, true), 0xff6a1a, M(0, 6.8, 1.6, Math.PI / 2, 0, 0)),
    ]);
    P.runwayLight = Geo.merge([C(new THREE.BoxGeometry(0.6, 0.5, 0.6), 0xffe9a0, M(0, 0.25, 0))]);
    return P;
  }

  /** Per-type rendering flags and collision footprints (radius, height; 0 = not solid). */
  const PROP_TYPES = {
    pine: { cap: 140, shadow: true, solid: [2.5, 12] },
    broadleaf: { cap: 140, shadow: true, solid: [3, 9] },
    palm: { cap: 30, shadow: true, solid: [1.5, 9] },
    cactus: { cap: 40, shadow: true, solid: [1, 5] },
    rock: { cap: 50, shadow: true, solid: [0, 0] },
    house: { cap: 26, shadow: true, solid: [6, 8], color: true },
    church: { cap: 3, shadow: true, solid: [10, 26] },
    turbineBase: { cap: 10, shadow: true, solid: [3, 62] },
    turbineRotor: { cap: 10, shadow: false, solid: [0, 0], dynamic: true },
    mast: { cap: 2, shadow: true, solid: [3, 98] },
    lighthouse: { cap: 1, shadow: true, solid: [5, 30] },
    hangar: { cap: 3, shadow: true, solid: [16, 15] },
    ctower: { cap: 1, shadow: true, solid: [5, 21] },
    windsock: { cap: 1, shadow: false, solid: [0, 0] },
    runwayLight: { cap: 40, shadow: false, solid: [0, 0], unlit: true },
  };

  // ---------------------------------------------------------------------------
  // Designed (non-random) structures at landmarks and airfields
  // ---------------------------------------------------------------------------
  function designedProps() {
    const list = [];
    const push = (type, x, z, rotY, scale, color) => list.push({ type, x, z, rotY: rotY || 0, scale: scale || 1, color });
    const wf = T.LANDMARKS.find((l) => l.id === 'windfarm');
    for (let row = 0; row < 2; row++) for (let i = 0; i < 5; i++) {
      const x = wf.x - 280 + i * 140 + row * 70, z = wf.z - 90 + row * 180;
      push('turbineBase', x, z, 0.4); push('turbineRotor', x, z, 0.4);
    }
    const lh = T.LANDMARKS.find((l) => l.id === 'lighthouse');
    push('lighthouse', lh.x, lh.z);
    const tw = T.LANDMARKS.find((l) => l.id === 'tower');
    push('mast', tw.x, tw.z);
    const mb = T.LANDMARKS.find((l) => l.id === 'millbrook');
    const rng = T.mulberry32(77);
    push('church', mb.x, mb.z, 0.3);
    for (let i = 0; i < 18; i++) {
      const a = rng() * Math.PI * 2, r = 30 + rng() * 150;
      push('house', mb.x + Math.cos(a) * r, mb.z + Math.sin(a) * r, rng() * Math.PI, 0.9 + rng() * 0.3, houseColor(rng));
    }
    for (const a of T.AIRFIELDS) {
      if (a.pad) continue;
      const off = (s, al) => ({ x: a.x + a.side.x * s + a.dir.x * al, z: a.z + a.side.z * s + a.dir.z * al });
      const rot = -a.heading * Math.PI / 180;
      for (let i = 0; i < (a.id === 'meadow' ? 3 : 1); i++) { const p = off(a.width / 2 + 75, -150 + i * 45); push('hangar', p.x, p.z, rot - Math.PI / 2); }
      const t = off(a.width / 2 + 70, 60); push('ctower', t.x, t.z, rot);
      const w = off(-a.width / 2 - 25, -a.length / 2 + 120); push('windsock', w.x, w.z, rot);
      for (let s = -1; s <= 1; s += 2) for (let al = -a.length / 2; al <= a.length / 2 + 1; al += a.length / 16) {
        const p = off(s * (a.width / 2 + 1.5), al); push('runwayLight', p.x, p.z, 0);
      }
    }
    return list;
  }
  function houseColor(rng) {
    const pal = [0xffffff, 0xfff1d6, 0xe8f1ff, 0xffe4e0, 0xf1ffe8];
    return pal[Math.floor(rng() * pal.length)];
  }

  // ---------------------------------------------------------------------------
  // Shaders
  // ---------------------------------------------------------------------------
  const SKY_VS = `
    varying vec3 vDir;
    void main() {
      vDir = normalize((modelMatrix * vec4(position, 1.0)).xyz - cameraPosition);
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      gl_Position.z = gl_Position.w; // keep the dome at the far plane
    }`;
  const SKY_FS = `
    uniform vec3 topColor, horizonColor, groundColor, sunColor, sunDir;
    uniform float sunSize, glow, night, space, flash;
    varying vec3 vDir;
    float hash(vec3 p){ p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
    void main() {
      vec3 d = normalize(vDir);
      float h = d.y;
      vec3 top = mix(topColor, vec3(0.005, 0.01, 0.03), space);
      vec3 col = h > 0.0 ? mix(horizonColor, top, pow(min(h * 1.4, 1.0), 0.55)) : mix(horizonColor, groundColor, min(-h * 6.0, 1.0));
      float sd = max(dot(d, sunDir), 0.0);
      col += sunColor * (pow(sd, 8.0) * 0.25 * glow + pow(sd, 90.0) * 0.5 * glow);
      col += sunColor * smoothstep(1.0 - sunSize, 1.0 - sunSize * 0.6, sd) * 4.0 * glow;
      // stars at night / high altitude
      vec3 sp = floor(d * 420.0);
      float star = step(0.9965, hash(sp)) * max(night, space) * smoothstep(0.0, 0.15, h);
      col += vec3(star);
      col = mix(col, vec3(0.85, 0.88, 1.0), flash);
      gl_FragColor = vec4(col, 1.0);
      #include <tonemapping_fragment>
      #include <colorspace_fragment>
    }`;

  const WATER_VS = `
    uniform float time;
    varying vec3 vWorld;
    #include <fog_pars_vertex>
    void main() {
      vec4 wp = modelMatrix * vec4(position, 1.0);
      wp.y += 0.35 * sin(wp.x * 0.05 + time * 1.1) * cos(wp.z * 0.04 + time * 0.8);
      vWorld = wp.xyz;
      vec4 mvPosition = viewMatrix * wp;
      gl_Position = projectionMatrix * mvPosition;
      #include <fog_vertex>
    }`;
  const WATER_FS = `
    uniform float time, choppy;
    uniform vec3 deepColor, shallowColor, skyColor, sunColor, sunDir;
    varying vec3 vWorld;
    #include <fog_pars_fragment>
    // Analytic normal from a sum of directional sine waves (animated normals).
    vec2 waveGrad(vec2 p, vec2 dir, float freq, float amp, float speed) {
      float ph = dot(p, dir) * freq + time * speed;
      return dir * cos(ph) * freq * amp;
    }
    void main() {
      vec2 p = vWorld.xz;
      vec2 g = waveGrad(p, normalize(vec2(1.0, 0.3)), 0.06, 0.9, 1.3)
             + waveGrad(p, normalize(vec2(-0.4, 1.0)), 0.11, 0.5, 1.9)
             + waveGrad(p, normalize(vec2(0.7, -0.8)), 0.23, 0.25, 2.7)
             + waveGrad(p, normalize(vec2(-0.9, -0.2)), 0.47, 0.12, 3.9);
      g *= choppy;
      vec3 n = normalize(vec3(-g.x, 1.0, -g.y));
      vec3 v = normalize(cameraPosition - vWorld);
      float fres = 0.04 + 0.96 * pow(1.0 - max(dot(n, v), 0.0), 5.0);
      vec3 base = mix(shallowColor, deepColor, clamp(length(cameraPosition - vWorld) / 1800.0, 0.0, 1.0));
      vec3 col = mix(base, skyColor, fres * 0.85);
      vec3 hv = normalize(sunDir + v);
      col += sunColor * pow(max(dot(n, hv), 0.0), 180.0) * 2.5 * step(0.0, sunDir.y);
      gl_FragColor = vec4(col, 1.0);
      #include <tonemapping_fragment>
      #include <colorspace_fragment>
      #include <fog_fragment>
    }`;

  const CLOUD_VS = `
    varying vec2 vUv;
    varying float vFade;
    varying float vSun;
    uniform vec3 sunDir;
    #include <fog_pars_vertex>
    void main() {
      vec3 center = (instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
      float scale = length(instanceMatrix[0].xyz);
      vec4 mvPosition = viewMatrix * vec4(center, 1.0);
      mvPosition.xy += position.xy * scale;           // camera-facing billboard
      vUv = uv;
      float dist = -mvPosition.z;
      vFade = smoothstep(scale * 0.2, scale * 1.4, dist);
      vSun = max(dot(normalize(center - cameraPosition), sunDir), 0.0);
      gl_Position = projectionMatrix * mvPosition;
      #include <fog_vertex>
    }`;
  const CLOUD_FS = `
    uniform sampler2D map;
    uniform vec3 litColor, shadeColor, sunColor;
    uniform float opacity;
    varying vec2 vUv;
    varying float vFade;
    varying float vSun;
    #include <fog_pars_fragment>
    void main() {
      vec4 t = texture2D(map, vUv);
      float a = t.a * opacity * vFade;
      if (a < 0.01) discard;
      vec3 col = mix(shadeColor, litColor, smoothstep(0.1, 0.9, vUv.y));
      col += sunColor * pow(vSun, 12.0) * 0.35 * (1.0 - t.a);   // silver lining
      gl_FragColor = vec4(col, a);
      #include <tonemapping_fragment>
      #include <colorspace_fragment>
      #include <fog_fragment>
    }`;

  const RAIN_VS = `
    uniform vec3 camPos;
    uniform float time, size;
    uniform vec2 slant;
    attribute float tip;
    #include <fog_pars_vertex>
    void main() {
      vec3 p = position;
      p.y = fract(p.y - time * 1.6);
      vec3 rel = (fract((p * size - camPos) / size) - 0.5) * size;
      vec3 wp = camPos + rel;
      wp.y = camPos.y + (p.y - 0.5) * size;
      wp.xz += (slant * tip);
      wp.y -= tip * 2.4;
      vec4 mvPosition = viewMatrix * vec4(wp, 1.0);
      gl_Position = projectionMatrix * mvPosition;
      #include <fog_vertex>
    }`;
  const RAIN_FS = `
    uniform float opacity;
    #include <fog_pars_fragment>
    void main() {
      gl_FragColor = vec4(0.75, 0.8, 0.9, opacity);
      #include <fog_fragment>
    }`;

  // ---------------------------------------------------------------------------
  // Time-of-day palettes (sRGB hex; converted to linear by THREE.Color)
  // ---------------------------------------------------------------------------
  const PALETTE = {
    night: { top: 0x070c1e, horizon: 0x1c2744, ground: 0x0b1020, sun: 0x8090c0, hemiSky: 0x4a5c88, hemiGround: 0x1a1e2a, water: 0x08101e },
    dusk: { top: 0x2b4a86, horizon: 0xf09a64, ground: 0x4a3a40, sun: 0xffa060, hemiSky: 0x9a8aa8, hemiGround: 0x3a3028, water: 0x1a2a40 },
    day: { top: 0x2d6fd0, horizon: 0xbcd8f0, ground: 0x8aa0b0, sun: 0xfff2dc, hemiSky: 0xbfd8ff, hemiGround: 0x6b6a4a, water: 0x1a4a6e },
    storm: { top: 0x3a4250, horizon: 0x6a7480, ground: 0x404850, sun: 0xa0a8b0, hemiSky: 0x8090a0, hemiGround: 0x3a3a3a, water: 0x1e2a32 },
  };
  const WEATHER = {
    clear: { cover: 0.35, storm: 0, turbulence: 0.04, fog: 1.0, rain: 0, cloudBase: 750, cloudTop: 1150 },
    cloudy: { cover: 0.8, storm: 0.25, turbulence: 0.15, fog: 0.85, rain: 0, cloudBase: 600, cloudTop: 1000 },
    storm: { cover: 1.0, storm: 1, turbulence: 0.55, fog: 0.45, rain: 1, cloudBase: 380, cloudTop: 820 },
  };

  // ---------------------------------------------------------------------------
  // World
  // ---------------------------------------------------------------------------
  class World {
    constructor(scene, renderer, qualityName) {
      this.scene = scene;
      this.renderer = renderer;
      this.quality = QUALITY[qualityName] || QUALITY.medium;
      this.qualityName = qualityName;
      this.time = 0;
      this.hour = 10.5;
      this.timeSpeed = 1 / 90;        // game hours per real second
      this.weatherName = 'clear';
      this.weather = Object.assign({}, WEATHER.clear);
      this.windSpeed = 3; this.windDir = 240; this.wind = { x: 0, y: 0, z: 0 };
      this.flash = 0;
      this.altitudeSpace = 0;
      this.chunks = new Map();
      this.instancesDirty = false;
      this.sunDir = new THREE.Vector3(0.4, 0.8, 0.3).normalize();
      this.fog = new THREE.Fog(0xbcd8f0, 400, 2400);
      scene.fog = this.fog;
      this.landmarks = T.LANDMARKS;
      this.airfields = T.AIRFIELDS;
      this.designed = designedProps();
      this._colors = {};
      for (const k of Object.keys(PALETTE)) {
        this._colors[k] = {};
        for (const c of Object.keys(PALETTE[k])) this._colors[k][c] = new THREE.Color(PALETTE[k][c]);
      }
      this._tmpColor = new THREE.Color();
      this.initLights();
      this.initSky();
      this.initWater();
      this.initProps();
      this.initRunways();
      this.initClouds();
      this.initRain();
      this.initFlare();
      this.initLightningBolt();
      this.setWind(this.windSpeed, this.windDir);
      this.applyShadowQuality();
    }

    // --- terrain queries (procedural terrain, or the loaded custom map) ----
    heightAt(x, z) { return this.custom ? this.custom.runtime.groundY(x, z) : T.heightAt(x, z); }
    groundY(x, z, y) { return this.custom ? this.custom.runtime.groundY(x, z, y) : T.heightAt(x, z); }
    surfaceAt(x, z) { return this.custom ? this.custom.runtime.surfaceAt(x, z) : T.surfaceAt(x, z); }
    biomeAt(x, z) { return this.custom ? 'Custom map' : T.biomeAt(x, z); }
    get waterLevel() { return this.custom ? this.custom.runtime.waterLevel : 0; }

    /**
     * Swap the procedural world for a Map Builder map (or back, with null).
     * Terrain chunks, props and runways are hidden, not destroyed, so returning is instant.
     */
    setCustomMap(map) {
      if (this.custom) {
        this.scene.remove(this.custom.view.group, this.custom.ground);
        this.custom.view.dispose();
        this.custom.ground.geometry.dispose(); this.custom.ground.material.dispose();
        this.custom = null;
      }
      const show = !map;
      for (const ch of this.chunks.values()) ch.mesh.visible = show;
      for (const p of Object.values(this.props)) p.mesh.visible = show;
      for (const r of this.runwayMeshes) r.visible = show;
      this.water.visible = true;
      if (!map) { this.setWeather('clear'); return; }
      const st = map.settings;
      const view = new AV.MapFormat.MapView({});
      view.sync(map);
      const ground = new THREE.Mesh(new THREE.PlaneGeometry(40000, 40000), new THREE.MeshLambertMaterial({ color: st.groundColor }));
      ground.rotation.x = -Math.PI / 2;
      ground.receiveShadow = true;
      this.scene.add(view.group, ground);
      this.custom = { map, runtime: AV.MapFormat.createRuntime(map), view, ground, sky: st.skyColor ? new THREE.Color(st.skyColor) : null };
      this.water.visible = !!st.waterEnabled;
      this.setWeather('clear');
      this.setTimeOfDay(st.timeOfDay);
      this.setWind(st.windSpeed, st.windDir);
    }

    // --- lights ------------------------------------------------------------
    initLights() {
      this.sun = new THREE.DirectionalLight(0xffffff, 2.4);
      this.sun.shadow.camera.left = -180; this.sun.shadow.camera.right = 180;
      this.sun.shadow.camera.top = 180; this.sun.shadow.camera.bottom = -180;
      this.sun.shadow.camera.near = 10; this.sun.shadow.camera.far = 2200;
      this.sun.shadow.bias = -0.0006;
      this.sun.shadow.normalBias = 0.6;
      this.scene.add(this.sun, this.sun.target);
      this.hemi = new THREE.HemisphereLight(0xbfd8ff, 0x6b6a4a, 1.0);
      this.scene.add(this.hemi);
    }

    applyShadowQuality() {
      const size = this.quality.shadowMap;
      const r = this.renderer;
      const enabled = size > 0;
      if (r.shadowMap.enabled !== enabled) {
        r.shadowMap.enabled = enabled;
        this.scene.traverse((o) => { if (o.material) [].concat(o.material).forEach((m) => { m.needsUpdate = true; }); });
      }
      r.shadowMap.type = THREE.PCFSoftShadowMap;
      this.sun.castShadow = enabled;
      if (enabled && this.sun.shadow.mapSize.x !== size) {
        this.sun.shadow.mapSize.set(size, size);
        if (this.sun.shadow.map) { this.sun.shadow.map.dispose(); this.sun.shadow.map = null; }
      }
    }

    setQuality(name) {
      if (!QUALITY[name] || name === this.qualityName) return;
      this.qualityName = name;
      this.quality = QUALITY[name];
      this.applyShadowQuality();
      for (const ch of this.chunks.values()) this.disposeChunk(ch);
      this.chunks.clear();
      this.instancesDirty = true;
      this.buildCloudField();
      this.rain.geometry.setDrawRange(0, this.quality.rain * 2);
    }

    // --- sky dome + sun ----------------------------------------------------
    initSky() {
      this.skyUniforms = {
        topColor: { value: new THREE.Color() }, horizonColor: { value: new THREE.Color() },
        groundColor: { value: new THREE.Color() }, sunColor: { value: new THREE.Color() },
        sunDir: { value: this.sunDir }, sunSize: { value: 0.0009 }, glow: { value: 1 },
        night: { value: 0 }, space: { value: 0 }, flash: { value: 0 },
      };
      const sky = new THREE.Mesh(new THREE.SphereGeometry(9000, 32, 16), new THREE.ShaderMaterial({
        uniforms: this.skyUniforms, vertexShader: SKY_VS, fragmentShader: SKY_FS,
        side: THREE.BackSide, depthWrite: false, fog: false,
      }));
      sky.renderOrder = -10;
      sky.frustumCulled = false;
      this.sky = sky;
      this.scene.add(sky);
    }

    // --- water -------------------------------------------------------------
    initWater() {
      this.waterUniforms = THREE.UniformsUtils.merge([THREE.UniformsLib.fog, {
        time: { value: 0 }, choppy: { value: 1 },
        deepColor: { value: new THREE.Color(0x0d3550) }, shallowColor: { value: new THREE.Color(0x1d6a80) },
        skyColor: { value: new THREE.Color() }, sunColor: { value: new THREE.Color() }, sunDir: { value: this.sunDir },
      }]);
      this.waterUniforms.sunDir.value = this.sunDir;
      const geo = new THREE.PlaneGeometry(14000, 14000, 80, 80);
      geo.rotateX(-Math.PI / 2);
      const water = new THREE.Mesh(geo, new THREE.ShaderMaterial({
        uniforms: this.waterUniforms, vertexShader: WATER_VS, fragmentShader: WATER_FS, fog: true,
      }));
      water.frustumCulled = false;
      water.position.y = 0;
      this.water = water;
      this.scene.add(water);
    }

    // --- instanced props ---------------------------------------------------
    initProps() {
      const geos = buildPropGeometries();
      this.props = {};
      const litMat = new THREE.MeshLambertMaterial({ vertexColors: true });
      const unlitMat = new THREE.MeshBasicMaterial({ vertexColors: true });
      this.propMaterials = [litMat, unlitMat];
      const maxChunks = Math.pow(QUALITY.high.viewRadius * 2 + 3, 2);
      for (const type of Object.keys(PROP_TYPES)) {
        const info = PROP_TYPES[type];
        const designedCount = this.designed.filter((d) => d.type === type).length;
        const capacity = info.cap * maxChunks + designedCount;
        const mesh = new THREE.InstancedMesh(geos[type], info.unlit ? unlitMat : litMat, capacity);
        mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
        if (info.color) mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 3).fill(1), 3);
        mesh.count = 0;
        mesh.castShadow = info.shadow;
        mesh.frustumCulled = false;
        this.scene.add(mesh);
        this.props[type] = { mesh, capacity };
      }
      this.rotorAngle = 0;
    }

    // --- runways -----------------------------------------------------------
    initRunways() {
      this.runwayMeshes = [];
      for (const a of T.AIRFIELDS) {
        const tex = a.pad ? padTexture() : runwayTexture(a);
        tex.anisotropy = 8;
        const geo = new THREE.PlaneGeometry(a.width, a.length);
        geo.rotateX(-Math.PI / 2);
        const mat = new THREE.MeshLambertMaterial({ map: tex, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4 });
        const m = new THREE.Mesh(geo, mat);
        m.position.set(a.x, T.heightAt(a.x, a.z) + 0.12, a.z);
        m.rotation.y = -a.heading * Math.PI / 180;
        m.receiveShadow = true;
        this.scene.add(m);
        this.runwayMeshes.push(m);
      }
    }

    // --- clouds ------------------------------------------------------------
    initClouds() {
      const tex = Geo.canvasTexture(128, 128, (ctx, w) => {
        const rng = T.mulberry32(5);
        for (let i = 0; i < 14; i++) {
          const x = w * (0.3 + rng() * 0.4), y = w * (0.35 + rng() * 0.35), r = w * (0.14 + rng() * 0.2);
          const g = ctx.createRadialGradient(x, y, 0, x, y, r);
          g.addColorStop(0, 'rgba(255,255,255,0.55)'); g.addColorStop(1, 'rgba(255,255,255,0)');
          ctx.fillStyle = g; ctx.fillRect(0, 0, w, w);
        }
      });
      this.cloudUniforms = THREE.UniformsUtils.merge([THREE.UniformsLib.fog, {
        map: { value: null }, litColor: { value: new THREE.Color(1, 1, 1) }, shadeColor: { value: new THREE.Color(0.6, 0.65, 0.75) },
        sunColor: { value: new THREE.Color(1, 1, 1) }, sunDir: { value: this.sunDir }, opacity: { value: 0.9 },
      }]);
      this.cloudUniforms.map.value = tex;
      this.cloudUniforms.sunDir.value = this.sunDir;
      const mat = new THREE.ShaderMaterial({
        uniforms: this.cloudUniforms, vertexShader: CLOUD_VS, fragmentShader: CLOUD_FS,
        transparent: true, depthWrite: false, fog: true,
      });
      this.cloudMaxPuffs = QUALITY.high.cloudClusters * 14;
      const geo = new THREE.PlaneGeometry(1, 1);
      this.clouds = new THREE.InstancedMesh(geo, mat, this.cloudMaxPuffs);
      this.clouds.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      this.clouds.frustumCulled = false;
      this.clouds.renderOrder = 5;
      this.scene.add(this.clouds);
      this.cloudDrift = { x: 0, z: 0 };
      this.cloudDomain = 9000;
      this.buildCloudField();
    }

    buildCloudField() {
      const rng = T.mulberry32(4242);
      const n = this.quality.cloudClusters;
      this.cloudClusters = [];
      for (let i = 0; i < n; i++) {
        const puffs = [];
        const count = 8 + Math.floor(rng() * 7);
        const spread = 120 + rng() * 160;
        for (let j = 0; j < count; j++) {
          puffs.push({ dx: (rng() - 0.5) * spread * 2, dy: (rng() - 0.3) * spread * 0.35, dz: (rng() - 0.5) * spread, s: 90 + rng() * 120 });
        }
        this.cloudClusters.push({ x: rng() * this.cloudDomain, z: rng() * this.cloudDomain, h: rng(), threshold: rng(), puffs });
      }
    }

    updateClouds(cam) {
      const D = this.cloudDomain, half = D / 2;
      const arr = this.clouds.instanceMatrix.array;
      const w = this.weather;
      let k = 0;
      for (const c of this.cloudClusters) {
        if (c.threshold > w.cover) continue;
        let cx = c.x + this.cloudDrift.x - cam.x, cz = c.z + this.cloudDrift.z - cam.z;
        cx = ((cx % D) + D) % D - half + cam.x;
        cz = ((cz % D) + D) % D - half + cam.z;
        const cy = w.cloudBase + c.h * (w.cloudTop - w.cloudBase);
        for (const p of c.puffs) {
          if (k >= this.cloudMaxPuffs) break;
          const s = p.s * (w.storm > 0.5 ? 1.35 : 1);
          const o = k * 16;
          arr[o] = s; arr[o + 1] = 0; arr[o + 2] = 0; arr[o + 3] = 0;
          arr[o + 4] = 0; arr[o + 5] = s; arr[o + 6] = 0; arr[o + 7] = 0;
          arr[o + 8] = 0; arr[o + 9] = 0; arr[o + 10] = s; arr[o + 11] = 0;
          arr[o + 12] = cx + p.dx; arr[o + 13] = cy + p.dy; arr[o + 14] = cz + p.dz; arr[o + 15] = 1;
          k++;
        }
      }
      this.clouds.count = k;
      this.clouds.instanceMatrix.needsUpdate = true;
    }

    // --- rain + lightning --------------------------------------------------
    initRain() {
      const max = QUALITY.high.rain;
      const pos = new Float32Array(max * 6), tip = new Float32Array(max * 2);
      const rng = T.mulberry32(31);
      for (let i = 0; i < max; i++) {
        const x = rng(), y = rng(), z = rng();
        pos.set([x, y, z, x, y, z], i * 6);
        tip[i * 2] = 0; tip[i * 2 + 1] = 1;
      }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      geo.setAttribute('tip', new THREE.BufferAttribute(tip, 1));
      geo.setDrawRange(0, this.quality.rain * 2);
      this.rainUniforms = THREE.UniformsUtils.merge([THREE.UniformsLib.fog, {
        camPos: { value: new THREE.Vector3() }, time: { value: 0 }, size: { value: 120 }, slant: { value: new THREE.Vector2() }, opacity: { value: 0.0 },
      }]);
      this.rain = new THREE.LineSegments(geo, new THREE.ShaderMaterial({
        uniforms: this.rainUniforms, vertexShader: RAIN_VS, fragmentShader: RAIN_FS, transparent: true, depthWrite: false, fog: true,
      }));
      this.rain.frustumCulled = false;
      this.rain.visible = false;
      this.scene.add(this.rain);
    }

    initLightningBolt() {
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(24 * 3), 3));
      this.bolt = new THREE.Line(geo, new THREE.LineBasicMaterial({ color: 0xeef4ff, transparent: true, opacity: 1, fog: false }));
      this.bolt.frustumCulled = false;
      this.bolt.visible = false;
      this.boltTimer = 0;
      this.scene.add(this.bolt);
    }

    /** Strike lightning at (x,z). Returns the strike point. */
    lightning(x, z, reducedMotion) {
      const top = this.weather.cloudBase + 50, ground = Math.max(0, T.heightAt(x, z));
      const p = this.bolt.geometry.attributes.position;
      const rng = Math.random;
      let cx = x, cz = z;
      for (let i = 0; i < 24; i++) {
        const t = i / 23;
        p.setXYZ(i, cx, top + (ground - top) * t, cz);
        cx += (rng() - 0.5) * 30; cz += (rng() - 0.5) * 30;
      }
      p.needsUpdate = true;
      this.bolt.visible = true;
      this.boltTimer = 0.18;
      this.flash = reducedMotion ? 0.25 : 0.8;
      return { x, y: ground, z };
    }

    // --- lens flare (screen-space sprites in an overlay scene) -------------
    initFlare() {
      this.flareScene = new THREE.Scene();
      this.flareCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 10);
      const dot = Geo.softDot(128, 0.2, 0.35);
      const ring = Geo.canvasTexture(128, 128, (ctx, w) => {
        const g = ctx.createRadialGradient(w / 2, w / 2, w * 0.3, w / 2, w / 2, w / 2);
        g.addColorStop(0, 'rgba(255,255,255,0)'); g.addColorStop(0.7, 'rgba(255,255,255,0.35)'); g.addColorStop(1, 'rgba(255,255,255,0)');
        ctx.fillStyle = g; ctx.fillRect(0, 0, w, w);
      });
      // [position along sun→centre line, size, colour, texture]
      const spec = [[0, 0.3, 0xfff4d0, dot], [0.35, 0.06, 0xffc080, dot], [0.6, 0.1, 0x80c0ff, ring], [0.9, 0.04, 0xffffff, dot],
        [1.25, 0.16, 0xa0ffb0, ring], [1.5, 0.07, 0xff9060, dot], [1.9, 0.22, 0x8090ff, ring]];
      this.flares = spec.map(([t, s, color, map]) => {
        const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map, color, transparent: true, blending: THREE.AdditiveBlending, depthTest: false, depthWrite: false, opacity: 0 }));
        sp.userData = { t, s };
        this.flareScene.add(sp);
        return sp;
      });
      this._sunNdc = new THREE.Vector3();
    }

    updateFlare(camera, dt) {
      const sunPos = this._sunNdc.copy(this.sunDir).multiplyScalar(5000).add(camera.position);
      sunPos.project(camera);
      const inFront = sunPos.z < 1 && sunPos.z > -1;
      const onScreen = Math.abs(sunPos.x) < 1.2 && Math.abs(sunPos.y) < 1.2;
      let vis = inFront && onScreen && this.sunDir.y > -0.02 ? 1 : 0;
      if (vis) vis *= this.sunOcclusion(camera.position);
      vis *= (1 - this.weather.storm * 0.9) * this.skyUniforms.glow.value;
      this.flareVis = (this.flareVis || 0) + (vis - (this.flareVis || 0)) * Math.min(1, dt * 6);
      const aspect = camera.aspect || 1;
      for (const f of this.flares) {
        const { t, s } = f.userData;
        f.position.set(sunPos.x * (1 - t), sunPos.y * (1 - t), 0);
        f.scale.set(s / aspect * 2, s * 2, 1);
        f.material.opacity = this.flareVis * (t === 0 ? 0.45 : 0.4);
      }
      this.flareScene.visible = this.flareVis > 0.01;
    }

    /** 1 if nothing blocks the sun, 0 if terrain is in the way (ray-marched). */
    sunOcclusion(from) {
      const d = this.sunDir;
      for (let i = 1; i <= 10; i++) {
        const dist = i * i * 30;
        const x = from.x + d.x * dist, y = from.y + d.y * dist, z = from.z + d.z * dist;
        if (this.heightAt(x, z) > y) return 0;
      }
      return 1;
    }

    // --- weather / time / wind --------------------------------------------
    setWeather(name) {
      if (!WEATHER[name]) return;
      this.weatherName = name;
      Object.assign(this.weather, WEATHER[name]);
      this.rain.visible = this.weather.rain > 0;
    }
    setTimeOfDay(h) { this.hour = ((h % 24) + 24) % 24; }
    setWind(speed, dirDeg) {
      this.windSpeed = speed; this.windDir = dirDeg;
      // dirDeg is where the wind blows FROM (meteorological convention).
      const a = dirDeg * Math.PI / 180;
      this.wind.x = -Math.sin(a) * speed; this.wind.z = Math.cos(a) * speed; this.wind.y = 0;
    }
    get turbulence() { return this.weather.turbulence + Math.min(0.3, this.windSpeed * 0.012); }

    /** Sun direction from the hour: rises in the east (+X), peaks in the south (+Z). */
    computeSun() {
      const theta = ((this.hour - 6) / 24) * Math.PI * 2;
      this.sunDir.set(Math.cos(theta), Math.sin(theta) * 0.92, 0.38).normalize();
    }

    updateAtmosphere() {
      const P = this._colors, c = this._tmpColor;
      const e = this.sunDir.y;
      const dayT = T.smoothstep(0.02, 0.35, e);
      const duskT = T.smoothstep(-0.12, 0.05, e) * (1 - dayT);
      const nightT = 1 - T.smoothstep(-0.18, 0.0, e);
      const storm = this.weather.storm;
      const mix = (key, out) => {
        out.copy(P.night[key]);
        out.lerp(P.dusk[key], 1 - nightT);
        out.lerp(P.day[key], dayT);
        out.lerp(P.storm[key], storm * 0.85);
        return out;
      };
      const su = this.skyUniforms;
      mix('top', su.topColor.value); mix('horizon', su.horizonColor.value); mix('ground', su.groundColor.value);
      mix('sun', su.sunColor.value);
      su.night.value = nightT * (1 - storm);
      su.glow.value = (1 - nightT) * (1 - storm * 0.9);
      // At high altitude the sky darkens toward space and haze thins.
      this.altitudeSpace = T.smoothstep(1500, 6000, this.cameraY || 0);
      su.space.value = this.altitudeSpace * 0.7;
      su.flash.value = this.flash;
      if (this.custom && this.custom.sky) {
        su.topColor.value.lerp(this.custom.sky, 0.85);
        su.horizonColor.value.lerp(c.copy(this.custom.sky).lerp(new THREE.Color(1, 1, 1), 0.35), 0.8);
      }
      this.fog.color.copy(su.horizonColor.value);
      if (this.flash > 0) this.fog.color.lerp(c.setRGB(0.8, 0.82, 0.9), this.flash * 0.5);
      const far = CHUNK * (this.quality.viewRadius + 0.3) * this.weather.fog * this.quality.fogScale;
      const thin = 1 + this.altitudeSpace * 0.8;
      this.fog.near = far * 0.18 * thin; this.fog.far = far * thin;
      // Lights
      mix('sun', this.sun.color);
      this.sun.intensity = (0.15 + 2.5 * dayT + 1.2 * duskT) * (1 - storm * 0.65) + this.flash * 2;
      mix('hemiSky', this.hemi.color); mix('hemiGround', this.hemi.groundColor);
      this.hemi.intensity = 0.6 + 0.5 * (1 - nightT) + this.flash * 1.5;
      // Water
      const wu = this.waterUniforms;
      wu.skyColor.value.copy(su.horizonColor.value).lerp(su.topColor.value, 0.3);
      wu.sunColor.value.copy(su.sunColor.value).multiplyScalar(su.glow.value);
      mix('water', wu.deepColor.value);
      wu.shallowColor.value.copy(wu.deepColor.value).multiplyScalar(1.8);
      wu.choppy.value = 1 + storm * 1.5 + this.windSpeed * 0.04;
      // Clouds
      const cu = this.cloudUniforms;
      cu.litColor.value.setRGB(1, 1, 1).lerp(su.sunColor.value, 0.35).multiplyScalar(0.25 + 0.75 * (1 - nightT)).lerp(c.setRGB(0.5, 0.52, 0.56), storm * 0.7);
      cu.shadeColor.value.copy(su.horizonColor.value).multiplyScalar(0.75).lerp(c.setRGB(0.18, 0.2, 0.24), storm * 0.8);
      cu.sunColor.value.copy(su.sunColor.value).multiplyScalar(su.glow.value);
      cu.opacity.value = 0.85 + storm * 0.15;
    }

    windAt() { return this.wind; }

    // --- chunk streaming ---------------------------------------------------
    chunkKey(cx, cz) { return cx + ',' + cz; }

    updateChunks(focus, forceAll) {
      const r = this.quality.viewRadius;
      const fcx = Math.floor(focus.x / CHUNK), fcz = Math.floor(focus.z / CHUNK);
      const wanted = new Set();
      const missing = [];
      for (let dz = -r; dz <= r; dz++) for (let dx = -r; dx <= r; dx++) {
        if (dx * dx + dz * dz > (r + 0.5) * (r + 0.5)) continue;
        const key = this.chunkKey(fcx + dx, fcz + dz);
        wanted.add(key);
        if (!this.chunks.has(key)) missing.push({ cx: fcx + dx, cz: fcz + dz, d: dx * dx + dz * dz, key });
      }
      for (const [key, ch] of this.chunks) {
        const dx = ch.cx - fcx, dz = ch.cz - fcz;
        if (!wanted.has(key) && dx * dx + dz * dz > (r + 1.5) * (r + 1.5)) {
          this.disposeChunk(ch); this.chunks.delete(key); this.instancesDirty = true;
        }
      }
      missing.sort((a, b) => a.d - b.d);
      const budget = forceAll ? missing.length : 2;
      for (let i = 0; i < Math.min(budget, missing.length); i++) {
        const m = missing[i];
        this.chunks.set(m.key, this.buildChunk(m.cx, m.cz));
        this.instancesDirty = true;
      }
      if (this.instancesDirty) this.rebuildInstances();
      return missing.length - Math.min(budget, missing.length);
    }

    buildChunk(cx, cz) {
      const seg = this.quality.segments;
      const step = CHUNK / seg;
      const x0 = cx * CHUNK, z0 = cz * CHUNK;
      const n = seg + 3; // one-cell border on each side for seamless normals
      const H = new Float32Array(n * n);
      for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) H[j * n + i] = T.heightAt(x0 + (i - 1) * step, z0 + (j - 1) * step);
      const vn = seg + 1;
      const pos = new Float32Array(vn * vn * 3), nor = new Float32Array(vn * vn * 3), col = new Float32Array(vn * vn * 3);
      const rgb = [0, 0, 0];
      for (let j = 0; j < vn; j++) for (let i = 0; i < vn; i++) {
        const gi = (j + 1) * n + (i + 1);
        const h = H[gi];
        const x = i * step, z = j * step;
        const o = (j * vn + i) * 3;
        pos[o] = x; pos[o + 1] = h; pos[o + 2] = z;
        // Normal from central differences: n = (-dh/dx, 2·step, -dh/dz)
        const nx = H[gi - 1] - H[gi + 1], nz = H[gi - n] - H[gi + n], ny = 2 * step;
        const l = Math.hypot(nx, ny, nz);
        nor[o] = nx / l; nor[o + 1] = ny / l; nor[o + 2] = nz / l;
        const wx = x0 + x, wz = z0 + z;
        T.terrainColor(wx, wz, h, 1 - ny / l, T.regionMasks(wx, wz), rgb);
        col[o] = srgbToLinear(rgb[0]); col[o + 1] = srgbToLinear(rgb[1]); col[o + 2] = srgbToLinear(rgb[2]);
      }
      const idx = new (vn * vn > 65535 ? Uint32Array : Uint16Array)(seg * seg * 6);
      let k = 0;
      for (let j = 0; j < seg; j++) for (let i = 0; i < seg; i++) {
        const a = j * vn + i, b = a + 1, c = a + vn, d = c + 1;
        idx[k++] = a; idx[k++] = c; idx[k++] = b; idx[k++] = b; idx[k++] = c; idx[k++] = d;
      }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      geo.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
      geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
      geo.setIndex(new THREE.BufferAttribute(idx, 1));
      geo.computeBoundingSphere();
      if (!this.terrainMat) this.terrainMat = new THREE.MeshLambertMaterial({ vertexColors: true });
      const mesh = new THREE.Mesh(geo, this.terrainMat);
      mesh.position.set(x0, 0, z0);
      mesh.receiveShadow = true;
      mesh.matrixAutoUpdate = false;
      mesh.updateMatrix();
      this.scene.add(mesh);
      const props = this.scatterProps(cx, cz);
      return { cx, cz, mesh, props: props.byType, obstacles: props.obstacles, maxTop: props.maxTop };
    }

    /** Deterministic prop placement for one chunk → matrices per type + collision list. */
    scatterProps(cx, cz) {
      const rng = T.mulberry32((cx * 73856093) ^ (cz * 19349663) ^ T.WORLD_SEED);
      const items = {};
      for (const t of Object.keys(PROP_TYPES)) items[t] = [];
      const x0 = cx * CHUNK, z0 = cz * CHUNK;
      const sp = this.quality.propSpacing;
      const nearAirfield = (x, z) => T.AIRFIELDS.some((a) => {
        const l = T.runwayLocal(a, x, z);
        return Math.abs(l.along) < a.length / 2 + 140 && Math.abs(l.across) < a.width / 2 + 130;
      });
      const add = (type, x, z, rotY, scale, color) => {
        if (items[type].length >= PROP_TYPES[type].cap) return;
        items[type].push({ x, y: T.heightAt(x, z), z, rotY, scale, color });
      };
      for (let gz = 0; gz < CHUNK; gz += sp) for (let gx = 0; gx < CHUNK; gx += sp) {
        const x = x0 + gx + rng() * sp, z = z0 + gz + rng() * sp;
        const roll = rng(), rot = rng() * 6.283, sc = 0.7 + rng() * 0.6;
        const h = T.heightAt(x, z);
        if (h < 1.5) continue;
        const slope = Math.abs(T.heightAt(x + 4, z) - h) + Math.abs(T.heightAt(x, z + 4) - h);
        if (nearAirfield(x, z)) continue;
        const m = T.regionMasks(x, z);
        const b = T.biomeFromHeight(x, z, h, m);
        const forest = T.fbm(x * 0.0012 + 77, z * 0.0012, 2);
        if (b === 'grass') {
          const p = forest > 0.12 ? 0.55 : 0.05;
          if (roll < p && slope < 5) add(h > 160 || forest > 0.35 ? 'pine' : 'broadleaf', x, z, rot, sc);
          else if (roll > 0.995) add('rock', x, z, rot, 1.5 + sc * 2);
        } else if (b === 'rock') {
          if (roll < 0.12 && h < 380 && slope < 6) add('pine', x, z, rot, sc);
          else if (roll > 0.96) add('rock', x, z, rot, 2 + sc * 4);
        } else if (b === 'snow') {
          if (roll < 0.03 && h < T.SNOW_LINE + 60) add('pine', x, z, rot, sc * 0.9);
          else if (roll > 0.985) add('rock', x, z, rot, 2 + sc * 3);
        } else if (b === 'sand') {
          if (m.desert > 0.5) {
            if (roll < 0.035) add('cactus', x, z, rot, sc * 1.2);
            else if (roll > 0.975) add('rock', x, z, rot, 1.5 + sc * 3);
          } else if (roll < 0.08) add('palm', x, z, rot, sc);
        }
      }
      // Procedural village or wind turbines on some grassland chunks.
      const ccx = x0 + CHUNK / 2, ccz = z0 + CHUNK / 2;
      const chH = T.heightAt(ccx, ccz), chM = T.regionMasks(ccx, ccz);
      const chB = T.biomeFromHeight(ccx, ccz, chH, chM);
      const decide = T.hash2(cx, cz, 3);
      if (chB === 'grass' && !nearAirfield(ccx, ccz) && Math.hypot(ccx, ccz) > 900) {
        if (decide < 0.09) {
          const count = 6 + Math.floor(rng() * 10);
          if (rng() < 0.5) add('church', ccx, ccz, rng() * 6.28, 1);
          for (let i = 0; i < count; i++) {
            const a = rng() * 6.283, r = 25 + rng() * 120;
            add('house', ccx + Math.cos(a) * r, ccz + Math.sin(a) * r, rng() * 6.28, 0.85 + rng() * 0.35, houseColor(rng));
          }
        } else if (decide < 0.13 && chH > 60) {
          const rot = rng() * 3.14;
          for (let i = 0; i < 3; i++) {
            const x = ccx + Math.cos(rot) * (i - 1) * 140, z = ccz + Math.sin(rot) * (i - 1) * 140;
            add('turbineBase', x, z, 0.4); add('turbineRotor', x, z, 0.4);
          }
        }
      }
      if (chB === 'rock' && decide > 0.95) add('mast', ccx, ccz, 0, 1);
      // Designed structures falling inside this chunk.
      for (const d of this.designed) {
        if (d.x >= x0 && d.x < x0 + CHUNK && d.z >= z0 && d.z < z0 + CHUNK) {
          items[d.type].push({ x: d.x, y: T.heightAt(d.x, d.z), z: d.z, rotY: d.rotY, scale: d.scale, color: d.color });
        }
      }
      // Bake matrices + collision footprints.
      const byType = {}, obstacles = [];
      const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), v = new THREE.Vector3(), s = new THREE.Vector3(), up = new THREE.Vector3(0, 1, 0);
      let maxTop = -Infinity;
      for (const type of Object.keys(items)) {
        const list = items[type];
        if (!list.length) continue;
        const mats = new Float32Array(list.length * 16);
        const cols = PROP_TYPES[type].color ? new Float32Array(list.length * 3) : null;
        const c = new THREE.Color();
        list.forEach((it, i) => {
          const y = type === 'turbineRotor' ? it.y + 61 : it.y - 0.3;
          q.setFromAxisAngle(up, it.rotY);
          m4.compose(v.set(it.x, y, it.z), q, s.set(it.scale, it.scale, it.scale));
          m4.toArray(mats, i * 16);
          if (cols) { c.set(it.color || 0xffffff); cols[i * 3] = c.r; cols[i * 3 + 1] = c.g; cols[i * 3 + 2] = c.b; }
          const solid = PROP_TYPES[type].solid;
          if (solid[0] > 0) {
            const top = it.y + solid[1] * it.scale;
            obstacles.push({ x: it.x, z: it.z, r: solid[0] * it.scale, bottom: it.y - 5, top });
            maxTop = Math.max(maxTop, top);
          }
          if (type === 'turbineRotor') {
            obstacles.push({ x: it.x, z: it.z, r: 13, bottom: it.y + 61 - 25, top: it.y + 61 + 25 });
            maxTop = Math.max(maxTop, it.y + 86);
          }
        });
        byType[type] = { mats, cols, list: type === 'turbineRotor' ? list : null };
      }
      return { byType, obstacles, maxTop };
    }

    disposeChunk(ch) {
      this.scene.remove(ch.mesh);
      ch.mesh.geometry.dispose();
    }

    rebuildInstances() {
      this.instancesDirty = false;
      this.rotors = [];
      for (const type of Object.keys(this.props)) {
        const p = this.props[type];
        const arr = p.mesh.instanceMatrix.array;
        const colArr = p.mesh.instanceColor ? p.mesh.instanceColor.array : null;
        let count = 0;
        for (const ch of this.chunks.values()) {
          const data = ch.props[type];
          if (!data) continue;
          const n = data.mats.length / 16;
          if (count + n > p.capacity) continue;
          arr.set(data.mats, count * 16);
          if (colArr && data.cols) colArr.set(data.cols, count * 3);
          if (data.list) for (let i = 0; i < n; i++) this.rotors.push({ index: count + i, x: data.list[i].x, y: data.list[i].y + 61, z: data.list[i].z, rot: data.list[i].rotY });
          count += n;
        }
        p.mesh.count = count;
        p.mesh.instanceMatrix.needsUpdate = true;
        if (colArr) p.mesh.instanceColor.needsUpdate = true;
      }
    }

    updateRotors(dt) {
      this.rotorAngle += dt * (0.8 + this.windSpeed * 0.08);
      const mesh = this.props.turbineRotor.mesh;
      const m4 = this._m4 || (this._m4 = new THREE.Matrix4());
      const e = this._e || (this._e = new THREE.Euler());
      const q = this._q || (this._q = new THREE.Quaternion());
      const v = this._v || (this._v = new THREE.Vector3());
      const one = this._one || (this._one = new THREE.Vector3(1, 1, 1));
      for (const r of this.rotors) {
        e.set(0, r.rot, this.rotorAngle + r.index, 'YXZ');
        q.setFromEuler(e);
        m4.compose(v.set(r.x, r.y, r.z), q, one);
        m4.toArray(mesh.instanceMatrix.array, r.index * 16);
      }
      if (this.rotors.length) mesh.instanceMatrix.needsUpdate = true;
    }

    /** True if (x,y,z) is inside a solid prop. Checks the chunk and its neighbours. */
    collide(x, y, z) {
      if (this.custom) return this.custom.runtime.collide(x, y, z);
      const cx = Math.floor(x / CHUNK), cz = Math.floor(z / CHUNK);
      for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) {
        const ch = this.chunks.get(this.chunkKey(cx + dx, cz + dz));
        if (!ch || y > ch.maxTop) continue;
        for (const o of ch.obstacles) {
          if (y < o.bottom || y > o.top) continue;
          const ddx = x - o.x, ddz = z - o.z;
          if (ddx * ddx + ddz * ddz < o.r * o.r) return true;
        }
      }
      return false;
    }

    /** Synchronously generate every chunk around a point (used behind loading screens). */
    prime(focus) {
      this.cameraY = focus.y;
      if (!this.custom) this.updateChunks(focus, true);
    }

    // --- per-frame update --------------------------------------------------
    update(dt, camera, focus, opts) {
      this.time += dt;
      if (!(opts && opts.freezeTime)) this.hour = (this.hour + dt * this.timeSpeed) % 24;
      this.cameraY = camera.position.y;
      this.computeSun();
      this.flash = Math.max(0, this.flash - dt * 4);
      if (this.boltTimer > 0) { this.boltTimer -= dt; this.bolt.material.opacity = Math.max(0, this.boltTimer / 0.18); if (this.boltTimer <= 0) this.bolt.visible = false; }
      this.updateAtmosphere();
      if (!this.custom) this.updateChunks(focus || camera.position, false);
      this.updateRotors(dt);
      // Sky, water and sun shadows follow the camera / focus point.
      this.sky.position.copy(camera.position);
      const snap = 40;
      this.water.position.set(Math.round(camera.position.x / snap) * snap, this.custom ? this.custom.runtime.waterLevel : 0, Math.round(camera.position.z / snap) * snap);
      this.waterUniforms.time.value = this.time;
      const f = focus || camera.position;
      this.sun.target.position.set(f.x, f.y, f.z);
      this.sun.position.set(f.x + this.sunDir.x * 900, f.y + this.sunDir.y * 900, f.z + this.sunDir.z * 900);
      this.sun.target.updateMatrixWorld();
      this.sun.visible = this.sunDir.y > -0.1 || this.flash > 0;
      // Clouds drift with the wind.
      this.cloudDrift.x += this.wind.x * dt * 0.6 + dt * 2;
      this.cloudDrift.z += this.wind.z * dt * 0.6;
      this.updateClouds(camera.position);
      // Rain
      if (this.rain.visible) {
        const ru = this.rainUniforms;
        ru.camPos.value.copy(camera.position);
        ru.time.value = this.time;
        ru.slant.value.set(this.wind.x * 0.08, this.wind.z * 0.08);
        ru.opacity.value = 0.35 * this.weather.rain * (camera.position.y < this.weather.cloudTop ? 1 : 0.1);
      }
      this.updateFlare(camera, dt);
    }

    /** Render the main scene and the lens-flare overlay. */
    render(renderer, camera) {
      renderer.render(this.scene, camera);
      if (this.flareScene.visible) {
        renderer.autoClear = false;
        renderer.clearDepth();
        renderer.render(this.flareScene, this.flareCam);
        renderer.autoClear = true;
      }
    }

    /** Minimap colour (sRGB 0..255) for a world position. */
    mapColor(x, z) {
      if (this.custom) return this.custom.runtime.mapColor(x, z);
      const h = T.heightAt(x, z);
      if (h < 0) return [40, 90, 140];
      if (T.airfieldAt(x, z)) return [70, 70, 75];
      const rgb = T.terrainColor(x, z, h, 0, T.regionMasks(x, z), [0, 0, 0]);
      const shade = 0.75 + Math.min(0.35, h / 1500);
      return [rgb[0] * 255 * shade, rgb[1] * 255 * shade, rgb[2] * 255 * shade];
    }
  }

  function runwayTexture(a) {
    return Geo.canvasTexture(256, 2048, (ctx, w, h) => {
      ctx.fillStyle = '#3b3d42'; ctx.fillRect(0, 0, w, h);
      const rng = T.mulberry32(3);
      for (let i = 0; i < 4000; i++) { const g = 50 + rng() * 25; ctx.fillStyle = `rgba(${g},${g},${g + 4},0.5)`; ctx.fillRect(rng() * w, rng() * h, 2, 2); }
      ctx.fillStyle = '#e8e8e8';
      ctx.fillRect(6, 0, 5, h); ctx.fillRect(w - 11, 0, 5, h);           // edge lines
      for (let y = 220; y < h - 220; y += 90) ctx.fillRect(w / 2 - 3, y, 6, 50); // centreline
      for (const end of [0, 1]) {
        for (let i = 0; i < 8; i++) {                                     // piano keys
          const x = 20 + i * 28 + (i >= 4 ? 8 : 0);
          ctx.fillRect(x, end ? h - 70 : 20, 14, 50);
        }
        ctx.save();
        ctx.translate(w / 2, end ? h - 140 : 140);
        if (!end) ctx.rotate(Math.PI);
        const num = Math.round(((a.heading + (end ? 0 : 180)) % 360) / 10) || 36;
        ctx.font = 'bold 64px sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillText(String(num).padStart(2, '0'), 0, 0);
        ctx.restore();
        ctx.fillRect(40, end ? h - 330 : 290, 30, 60); ctx.fillRect(w - 70, end ? h - 330 : 290, 30, 60); // aiming points
      }
    });
  }
  function padTexture() {
    return Geo.canvasTexture(256, 1024, (ctx, w, h) => {
      ctx.fillStyle = '#4a4c52'; ctx.fillRect(0, 0, w, h);
      ctx.strokeStyle = '#f2c230'; ctx.lineWidth = 8; ctx.strokeRect(8, 8, w - 16, h - 16);
      ctx.fillStyle = '#e8e8e8';
      for (let y = 60; y < h - 60; y += 80) ctx.fillRect(w / 2 - 3, y, 6, 40);
      ctx.font = 'bold 90px sans-serif'; ctx.textAlign = 'center'; ctx.fillText('SUMMIT', w / 2, h / 2 + 30);
    });
  }

  AV.World = World;
  AV.World.QUALITY = QUALITY;
  AV.World.WEATHER = WEATHER;
  AV.World.CHUNK = CHUNK;
})(window.AV);
