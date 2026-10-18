/* parts.js — the shared aircraft part catalog used by the Plane Builder, the Hangar
 * and the flight physics, plus design resolution, validation and part geometry.
 *
 * The first half (catalog + resolveDesign + validateDesign) is pure maths and
 * runs without three.js. The second half builds cached part geometry and the
 * flyable model for custom aircraft.
 *
 * Frames match physics.js: +X right, +Y up, -Z forward (nose). Metres, kilograms.
 *
 * Attachment model
 *   Every part has one or more `sockets` (how it plugs in) and a list of `attach`
 *   points (where other parts can plug into it). A socket fits an attach point when
 *   the attach point `accepts` the socket type. Child transform:
 *     child = parent · T(attach.pos) · R_align · Mirror(side) · R_user · T(-socket.pos)
 *   where R_align turns the socket's outward direction onto the attach direction and
 *   Mirror(side = -1) flips left-side parts, so one right-handed definition serves both sides.
 */
window.AV = window.AV || {};
(function (AV) {
  'use strict';

  const DESIGN_FORMAT = 'aviator-plane';
  const DESIGN_VERSION = 1;
  const MAX_PARTS = 400;
  const R = 0.75; // fuselage radius shared by all fuselage sections, tails and nose parts

  const CATEGORIES = [
    { id: 'fuselage', name: 'Fuselage' }, { id: 'engine', name: 'Engines' }, { id: 'tank', name: 'Fuel tanks' },
    { id: 'wing', name: 'Wings' }, { id: 'tail', name: 'Tails' }, { id: 'gear', name: 'Landing gear' },
    { id: 'cosmetic', name: 'Cosmetic' },
  ];

  // ---------------------------------------------------------------------------
  // Catalog constructors
  // ---------------------------------------------------------------------------
  function fuselage(id, name, l, mass, fuel) {
    const a = [
      { id: 'nose', pos: [0, 0, -l / 2], dir: [0, 0, -1], accepts: ['nose'] },
      { id: 'tail', pos: [0, 0, l / 2], dir: [0, 0, 1], accepts: ['tail', 'fuselage'] },
      { id: 'top_f', pos: [0, R, -l * 0.2], dir: [0, 1, 0], accepts: ['top'] },
      { id: 'top_r', pos: [0, R, l * 0.25], dir: [0, 1, 0], accepts: ['top'] },
      { id: 'bottom_f', pos: [0, -R, -l * 0.12], dir: [0, -1, 0], accepts: ['gear', 'pod'] },
      { id: 'bottom_r', pos: [0, -R, l * 0.28], dir: [0, -1, 0], accepts: ['pod'] },
      { id: 'decalR', pos: [R * 0.92, R * 0.39, l * 0.1], dir: [0.92, 0.39, 0], accepts: ['decal'], side: 1, mirror: 'decalL' },
      { id: 'decalL', pos: [-R * 0.92, R * 0.39, l * 0.1], dir: [-0.92, 0.39, 0], accepts: ['decal'], side: -1, mirror: 'decalR' },
    ];
    // Wing roots every 0.5 m so the wing can be slid fore/aft to balance the aircraft.
    const reach = Math.floor((l * 0.35) / 0.5) * 0.5;
    for (let z = -reach; z <= reach + 1e-6; z += 0.5) {
      const k = String(Math.round(z * 10));
      a.push({ id: 'wingR_' + k, pos: [R, 0, z], dir: [1, 0, 0], accepts: ['wing'], side: 1, mirror: 'wingL_' + k });
      a.push({ id: 'wingL_' + k, pos: [-R, 0, z], dir: [-1, 0, 0], accepts: ['wing'], side: -1, mirror: 'wingR_' + k });
    }
    return {
      id, category: 'fuselage', name, color: 0xf1efe8, dims: { w: 2 * R, h: 2 * R, l },
      bounds: { min: [-R, -R, -l / 2], max: [R, R, l / 2] },
      sockets: { fuselage: { pos: [0, 0, -l / 2], dir: [0, 0, 1] } },
      attach: a,
      stats: { mass, drag: 0.1 + 0.012 * l, fuel },
      geo: { kind: 'fuselage', l, r: R },
      desc: `Body section, ${l} m. Holds ${fuel} kg of fuel. Chain sections nose-to-tail.`,
    };
  }

  /** Engine. sockets: nose and/or pod. thrust in N (static), propSpeed in m/s where thrust fades to 0. */
  function engine(id, name, opts) {
    return Object.assign({
      id, category: 'engine', name, color: opts.color || 0x30343a,
      stats: { mass: opts.mass, drag: opts.drag, thrust: opts.thrust, propSpeed: opts.propSpeed, burn: opts.burn, kind: opts.kind },
      attach: [],
    }, opts.def);
  }

  function tank(id, name, len, r, fuel, mass) {
    return {
      id, category: 'tank', name, color: 0xd6dbe2, dims: { w: 2 * r, h: 2 * r + 0.2, l: len },
      bounds: { min: [-r, -r, -len / 2], max: [r, r + 0.2, len / 2] },
      sockets: { pod: { pos: [0, r + 0.2, 0], dir: [0, -1, 0] } },
      attach: [],
      stats: { mass, drag: 0.02 + r * 0.06, fuel },
      geo: { kind: 'tank', len, r },
      desc: `External tank, ${fuel} kg of fuel.`,
    };
  }

  /** Wing half (right side; left is mirrored). semi = semi-span, cr/ct = root/tip chord. */
  function wing(id, name, semi, cr, ct, sweepDeg, mass, aero) {
    const sw = (sweepDeg * Math.PI) / 180;
    const zleTip = -cr / 2 + semi * Math.tan(sw);
    const area = (semi * (cr + ct)) / 2;
    const zMid = (frac) => { const zl = -cr / 2 + (zleTip + cr / 2) * frac; const c = cr + (ct - cr) * frac; return zl + c / 2; };
    const zMin = Math.min(-cr / 2, zleTip), zMax = Math.max(cr / 2, zleTip + ct);
    return {
      id, category: 'wing', name, color: 0xf3f0e8, dims: { w: semi, h: 0.2, l: zMax - zMin },
      bounds: { min: [0, -0.1, zMin], max: [semi, 0.1, zMax] },
      // Two boxes follow the sweep better than one.
      boxes: [{ min: [0, -0.1, -cr / 2], max: [semi / 2, 0.1, Math.max(cr / 2, zMid(0.5) + (cr + ct) / 4)] },
        { min: [semi / 2, -0.1, Math.min(zleTip, -cr / 2 + semi * 0.5 * Math.tan(sw))], max: [semi, 0.1, zMax] }],
      sockets: { wing: { pos: [0, 0, 0], dir: [1, 0, 0] } },
      attach: [
        { id: 'tip', pos: [semi, 0, zMid(1)], dir: [1, 0, 0], accepts: ['tip'] },
        { id: 'pod_in', pos: [semi * 0.38, -0.1, zMid(0.38)], dir: [0, -1, 0], accepts: ['pod'] },
        { id: 'pod_out', pos: [semi * 0.7, -0.1, zMid(0.7)], dir: [0, -1, 0], accepts: ['pod'] },
        { id: 'decal', pos: [semi * 0.55, 0.1, zMid(0.55)], dir: [0, 1, 0], accepts: ['decal'] },
      ],
      surfaces: [{ area, center: [semi * 0.45, 0, zMid(0.45) - 0.25 * (cr + ct) / 2 + (cr + ct) / 8], normal: [0, 1, 0], chord: [0, 0, 1],
        span: semi, control: aero.elevon ? 'elevon' : 'aileron', ctrlFrac: 0.25, kind: 'wing' }],
      stats: { mass, drag: 0.008 * area, lift: area },
      aero: Object.assign({ sweep: sw, CL0: 0.22, alphaStall: 0.27, oswald: 0.8, flapCL: 0.42 }, aero),
      geo: { kind: 'wing', semi, cr, ct, zleTip },
      desc: `${area.toFixed(1)} m² per side, ${semi} m semi-span${sweepDeg ? `, ${sweepDeg}° sweep` : ''}.`,
    };
  }

  function tail(id, name, kind, mass) {
    const surf = [];
    let bounds;
    if (kind === 'conventional') {
      surf.push({ area: 3.0, center: [0, 0.1, 2.2], normal: [0, 1, 0], chord: [0, 0, 1], control: 'elevator', ctrlFrac: 0.35, kind: 'tail' });
      surf.push({ area: 1.5, center: [0, 1.0, 2.0], normal: [1, 0, 0], chord: [0, 0, 1], control: 'rudder', ctrlFrac: 0.4, kind: 'tail' });
      bounds = { min: [-1.8, -R, 0], max: [1.8, 2.0, 2.75] };
    } else if (kind === 't') {
      surf.push({ area: 2.8, center: [0, 1.9, 2.5], normal: [0, 1, 0], chord: [0, 0, 1], control: 'elevator', ctrlFrac: 0.35, kind: 'tail' });
      surf.push({ area: 1.8, center: [0, 1.0, 2.0], normal: [1, 0, 0], chord: [0, 0, 1], control: 'rudder', ctrlFrac: 0.4, kind: 'tail' });
      bounds = { min: [-1.7, -R, 0], max: [1.7, 2.05, 2.95] };
    } else {
      const a = (35 * Math.PI) / 180;
      for (const s of [1, -1]) surf.push({ area: 1.9, center: [s * 0.8, 0.6, 2.2], normal: [-s * Math.sin(a), Math.cos(a), 0], chord: [0, 0, 1], control: 'ruddervator', ctrlFrac: 0.35, kind: 'tail' });
      bounds = { min: [-1.7, -R, 0], max: [1.7, 1.25, 2.75] };
    }
    return {
      id, category: 'tail', name, color: 0xd2322d, dims: { w: bounds.max[0] * 2, h: bounds.max[1] - bounds.min[1], l: bounds.max[2] },
      bounds, sockets: { tail: { pos: [0, 0, 0], dir: [0, 0, 1] } },
      boxes: [{ min: [-R, -R, 0], max: [R, R, 2.6] }, { min: [bounds.min[0], -0.2, 1.7], max: [bounds.max[0], bounds.max[1], bounds.max[2]] }],
      attach: [],
      surfaces: surf,
      stats: { mass, drag: 0.06 },
      geo: { kind: 'tail', tail: kind },
      desc: { conventional: 'Low stabiliser and fin. Balanced, predictable.', t: 'Stabiliser on top of the fin, out of the propwash.', v: 'Two angled surfaces that act as elevator and rudder.' }[kind],
    };
  }

  function gear(id, name, type, mass, drag) {
    const floats = type === 'floats';
    const h = floats ? -1.25 : -1.02;
    return {
      id, category: 'gear', name, color: floats ? 0xe9e2c8 : 0x9aa0a8, dims: { w: floats ? 3.6 : 3, h: -h, l: floats ? 4.4 : 3 },
      bounds: floats ? { min: [-1.85, h, -2.8], max: [1.85, 0, 2.0] } : { min: [-1.6, h, -1.65], max: [1.6, 0, 1.3] },
      // Overlap checks use these boxes (the pontoons / legs), not the whole bounding box.
      boxes: floats
        ? [{ min: [-1.9, h, -2.8], max: [-1.2, h + 0.65, 1.5] }, { min: [1.2, h, -2.8], max: [1.9, h + 0.65, 1.5] }]
        : [{ min: [-0.2, h, -1.65], max: [0.2, 0, -1.25] }, { min: [-1.6, h, 0.85], max: [-1.2, -0.2, 1.25] }, { min: [1.2, h, 0.85], max: [1.6, -0.2, 1.25] }],
      sockets: { gear: { pos: [0, 0, 0], dir: [0, -1, 0] } },
      attach: [],
      contacts: floats
        ? { nose: [0, h, -2.0], mainL: [-1.55, h, 1.1], mainR: [1.55, h, 1.1] }
        : { nose: [0, h, -1.45], mainL: [-1.4, h, 1.05], mainR: [1.4, h, 1.05] },
      stats: { mass, drag, gearType: type, retractable: type === 'wheels' },
      geo: { kind: 'gear', type },
      desc: { wheels: 'Retractable tricycle gear for runways.', skis: 'Fixed skis: slick on snow, draggy on tarmac.', floats: 'Floats: land on water, but heavy and draggy.' }[type],
    };
  }

  function cosmetic(id, name, socket, opts) {
    return Object.assign({ id, category: 'cosmetic', name, attach: [], stats: { mass: opts.mass, drag: opts.drag || 0 } }, opts.def,
      { sockets: { [socket]: opts.socket } });
  }

  const PARTS = [
    fuselage('fuse_short', 'Fuselage — short', 4, 220, 25),
    fuselage('fuse_medium', 'Fuselage — medium', 6, 320, 40),
    fuselage('fuse_long', 'Fuselage — long', 8, 430, 60),

    engine('eng_small', 'Small prop', { mass: 110, drag: 0.05, thrust: 2600, propSpeed: 105, burn: 0.008, kind: 'prop', def: {
      dims: { w: 1.8, h: 1.8, l: 1.1 }, bounds: { min: [-0.72, -0.72, -1.1], max: [0.72, 0.72, 0] },
      sockets: { nose: { pos: [0, 0, 0], dir: [0, 0, -1] } }, geo: { kind: 'prop', len: 0.9, blades: 2, radius: 0.85 },
      desc: 'Light, frugal. Strong low-speed thrust.' } }),
    engine('eng_medium', 'Medium prop', { mass: 170, drag: 0.06, thrust: 3900, propSpeed: 122, burn: 0.012, kind: 'prop', def: {
      dims: { w: 2.2, h: 2.2, l: 1.3 }, bounds: { min: [-0.75, -0.75, -1.3], max: [0.75, 0.75, 0] },
      sockets: { nose: { pos: [0, 0, 0], dir: [0, 0, -1] } }, geo: { kind: 'prop', len: 1.1, blades: 3, radius: 1.05 },
      desc: 'The all-rounder. Three blades, solid climb.' } }),
    engine('eng_jet', 'Jet', { mass: 260, drag: 0.07, thrust: 5000, propSpeed: 330, burn: 0.045, kind: 'jet', color: 0x5a616b, def: {
      dims: { w: 1.1, h: 1.1, l: 1.6 }, bounds: { min: [-0.55, -0.55, -0.8], max: [0.55, 0.55, 0.8] },
      sockets: { nose: { pos: [0, 0, 0.8], dir: [0, 0, -1] }, pod: { pos: [0, 0.55, 0], dir: [0, -1, 0] } },
      geo: { kind: 'jet', len: 1.6, r: 0.55 },
      desc: 'Weak at take-off, keeps pulling at high speed. Thirsty. Nose or under-wing mount.' } }),
    engine('eng_twin', 'Twin-prop nacelle', { mass: 120, drag: 0.05, thrust: 2200, propSpeed: 115, burn: 0.009, kind: 'prop', def: {
      dims: { w: 1.6, h: 1.6, l: 2.4 }, bounds: { min: [-0.8, -0.42, -1.45], max: [0.8, 0.42, 1.0] },
      sockets: { pod: { pos: [0, 0.42, 0], dir: [0, -1, 0] } }, geo: { kind: 'nacelle', len: 2.2, r: 0.42, radius: 0.8 },
      desc: 'Under-wing engine pod. Use symmetry to mount a matching pair.' } }),

    tank('tank_s', 'Fuel tank — small', 1.6, 0.3, 40, 10),
    tank('tank_m', 'Fuel tank — medium', 2.2, 0.38, 90, 16),
    tank('tank_l', 'Fuel tank — large', 3.0, 0.45, 160, 24),
    tank('tank_xl', 'Fuel tank — huge', 3.6, 0.55, 260, 34),

    wing('wing_short', 'Wing — short', 3.2, 1.6, 1.2, 0, 60, { CL0: 0.2, alphaStall: 0.25, oswald: 0.78 }),
    wing('wing_long', 'Wing — long', 5.5, 1.7, 1.1, 0, 105, { CL0: 0.24, alphaStall: 0.27, oswald: 0.84 }),
    wing('wing_swept', 'Wing — swept', 4.4, 1.9, 0.9, 30, 90, { CL0: 0.16, alphaStall: 0.29, oswald: 0.74 }),
    wing('wing_delta', 'Wing — delta', 3.8, 4.4, 0.4, 52, 120, { CL0: 0.06, alphaStall: 0.42, oswald: 0.7, elevon: true, flapCL: 0.15 }),

    tail('tail_conv', 'Tail — conventional', 'conventional', 55),
    tail('tail_t', 'Tail — T-tail', 't', 60),
    tail('tail_v', 'Tail — V-tail', 'v', 50),

    gear('gear_wheels', 'Gear — wheels', 'wheels', 70, 0.13),
    gear('gear_skis', 'Gear — skis', 'skis', 55, 0.1),
    gear('gear_floats', 'Gear — floats', 'floats', 120, 0.24),

    cosmetic('canopy', 'Canopy', 'top', { mass: 15, drag: 0.03, socket: { pos: [0, 0, 0], dir: [0, 1, 0] }, def: {
      color: 0x8fc4e8, dims: { w: 1.1, h: 0.7, l: 1.8 }, bounds: { min: [-0.55, 0, -0.9], max: [0.55, 0.7, 0.9] }, geo: { kind: 'canopy' },
      desc: 'Bubble canopy. Sets the cockpit camera position.' } }),
    cosmetic('nosecone', 'Nose cone', 'nose', { mass: 8, drag: -0.05, socket: { pos: [0, 0, 0], dir: [0, 0, -1] }, def: {
      color: 0x1f3c6e, dims: { w: 1.5, h: 1.5, l: 1.2 }, bounds: { min: [-R, -R, -1.2], max: [R, R, 0] }, geo: { kind: 'cone' },
      desc: 'Streamlined nose for jets or gliders. Slightly reduces drag.' } }),
    cosmetic('winglet', 'Winglet', 'tip', { mass: 5, drag: 0.004, socket: { pos: [0, 0, 0], dir: [1, 0, 0] }, def: {
      color: 0x1f3c6e, dims: { w: 0.2, h: 0.9, l: 0.9 }, bounds: { min: [0, -0.05, -0.45], max: [0.2, 0.9, 0.45] }, geo: { kind: 'winglet' },
      oswaldBonus: 0.025, desc: 'Wingtip fence. Small cut in induced drag.' } }),
    cosmetic('decal_roundel', 'Decal — roundel', 'decal', { mass: 0.3, socket: { pos: [0, 0, 0], dir: [1, 0, 0] }, def: {
      color: 0xd2322d, dims: { w: 0.02, h: 0.6, l: 0.6 }, bounds: { min: [0, -0.3, -0.3], max: [0.03, 0.3, 0.3] }, geo: { kind: 'roundel' },
      desc: 'Red, white and blue roundel.' } }),
    cosmetic('decal_stripe', 'Decal — racing stripe', 'decal', { mass: 0.3, socket: { pos: [0, 0, 0], dir: [1, 0, 0] }, def: {
      color: 0xffd23f, dims: { w: 0.02, h: 0.25, l: 1.4 }, bounds: { min: [0, -0.12, -0.7], max: [0.03, 0.12, 0.7] }, geo: { kind: 'stripe' },
      desc: 'Bold yellow stripe.' } }),
  ];

  const CATALOG = {};
  for (const p of PARTS) {
    p.fits = Object.keys(p.sockets);
    if (!p.dims) p.dims = { w: p.bounds.max[0] - p.bounds.min[0], h: p.bounds.max[1] - p.bounds.min[1], l: p.bounds.max[2] - p.bounds.min[2] };
    CATALOG[p.id] = p;
  }

  /** Human-readable stat contributions for palettes and property panels. */
  function statSummary(def) {
    const s = def.stats, out = [`${s.mass} kg`];
    if (s.thrust) out.push(`${(s.thrust / 1000).toFixed(1)} kN thrust`);
    if (s.fuel) out.push(`${s.fuel} kg fuel`);
    if (s.lift) out.push(`${s.lift.toFixed(1)} m² lift`);
    if (def.surfaces && def.category === 'tail') out.push('pitch & yaw control');
    if (s.drag) out.push(`${s.drag > 0 ? '+' : ''}${s.drag.toFixed(2)} m² drag`);
    if (def.oswaldBonus) out.push('less induced drag');
    return out.join(' · ');
  }

  // ---------------------------------------------------------------------------
  // Small column-major 4×4 matrix helpers (same layout as THREE.Matrix4.elements)
  // ---------------------------------------------------------------------------
  const M4 = {
    identity: () => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
    mul(a, b) {
      const o = new Array(16);
      for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) {
        o[c * 4 + r] = a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
      }
      return o;
    },
    translate: (x, y, z) => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1],
    scale: (x, y, z) => [x, 0, 0, 0, 0, y, 0, 0, 0, 0, z, 0, 0, 0, 0, 1],
    /** Quarter-turn rotations stay exact (no floating drift for 90° steps). */
    rotQuarter(axis, q) {
      const n = ((q % 4) + 4) % 4;
      const c = [1, 0, -1, 0][n], s = [0, 1, 0, -1][n];
      if (axis === 0) return [1, 0, 0, 0, 0, c, s, 0, 0, -s, c, 0, 0, 0, 0, 1];
      if (axis === 1) return [c, 0, -s, 0, 0, 1, 0, 0, s, 0, c, 0, 0, 0, 0, 1];
      return [c, s, 0, 0, -s, c, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
    },
    /** Rotation taking unit vector a onto unit vector b. */
    align(a, b) {
      const d = a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
      if (d > 0.99999) return M4.identity();
      let x, y, z, w;
      if (d < -0.99999) { x = 0; y = 1; z = 0; w = 0; if (Math.abs(a[1]) > 0.9) { x = 1; y = 0; } }
      else {
        x = a[1] * b[2] - a[2] * b[1]; y = a[2] * b[0] - a[0] * b[2]; z = a[0] * b[1] - a[1] * b[0]; w = 1 + d;
        const l = Math.hypot(x, y, z, w); x /= l; y /= l; z /= l; w /= l;
      }
      return [1 - 2 * (y * y + z * z), 2 * (x * y + z * w), 2 * (x * z - y * w), 0,
        2 * (x * y - z * w), 1 - 2 * (x * x + z * z), 2 * (y * z + x * w), 0,
        2 * (x * z + y * w), 2 * (y * z - x * w), 1 - 2 * (x * x + y * y), 0, 0, 0, 0, 1];
    },
    point: (m, p) => [m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12], m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13], m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14]],
    dir(m, v) {
      const x = m[0] * v[0] + m[4] * v[1] + m[8] * v[2], y = m[1] * v[0] + m[5] * v[1] + m[9] * v[2], z = m[2] * v[0] + m[6] * v[1] + m[10] * v[2];
      const l = Math.hypot(x, y, z) || 1;
      return [x / l, y / l, z / l];
    },
    det(m) {
      return m[0] * (m[5] * m[10] - m[9] * m[6]) - m[4] * (m[1] * m[10] - m[9] * m[2]) + m[8] * (m[1] * m[6] - m[5] * m[2]);
    },
  };
  const norm = (v) => { const l = Math.hypot(v[0], v[1], v[2]) || 1; return [v[0] / l, v[1] / l, v[2] / l]; };

  function userRotation(rot) {
    const r = rot || [0, 0, 0];
    return M4.mul(M4.rotQuarter(1, r[1] || 0), M4.mul(M4.rotQuarter(0, r[0] || 0), M4.rotQuarter(2, r[2] || 0)));
  }

  /** Matrix of a child mated to `attach` (parent-local) through `socket`. */
  function childMatrix(parentM, attach, socket, rot) {
    const side = attach.side === -1 ? -1 : 1;
    const sdir = norm([socket.dir[0] * side, socket.dir[1], socket.dir[2]]);
    let m = M4.mul(parentM, M4.translate(attach.pos[0], attach.pos[1], attach.pos[2]));
    m = M4.mul(m, M4.align(sdir, norm(attach.dir)));
    m = M4.mul(m, M4.scale(side, 1, 1));
    m = M4.mul(m, userRotation(rot));
    return M4.mul(m, M4.translate(-socket.pos[0], -socket.pos[1], -socket.pos[2]));
  }

  function freeMatrix(p) {
    const pos = p.pos || [0, 0, 0];
    let m = M4.translate(pos[0], pos[1], pos[2]);
    if (p.mirror) m = M4.mul(m, M4.scale(-1, 1, 1));
    return M4.mul(m, userRotation(p.rot));
  }

  function transformBounds(m, b) {
    const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < 8; i++) {
      const c = M4.point(m, [i & 1 ? b.max[0] : b.min[0], i & 2 ? b.max[1] : b.min[1], i & 4 ? b.max[2] : b.min[2]]);
      for (let k = 0; k < 3; k++) { if (c[k] < min[k]) min[k] = c[k]; if (c[k] > max[k]) max[k] = c[k]; }
    }
    return { min, max };
  }

  // ---------------------------------------------------------------------------
  // Design resolution: parts tree → world transforms and physical data
  // ---------------------------------------------------------------------------
  /**
   * design: { format, version, name, parts: [{ uid, part, parent, attach, pos, rot, mirror, pair }] }
   * Returns { list, byUid, occupied } where each record carries matrix, AABB, centre,
   * mass, surfaces, engines and gear contacts in design (body) coordinates.
   */
  function resolveDesign(design) {
    const src = new Map();
    for (const p of design.parts || []) if (CATALOG[p.part]) src.set(p.uid, p);
    const byUid = new Map(), list = [], occupied = new Map();
    const visiting = new Set();
    // The root is the first parentless fuselage (or the first parentless part); other free parts float.
    const parentless = [...src.values()].filter((p) => !p.parent || !src.has(p.parent));
    const rootSrc = parentless.find((p) => CATALOG[p.part].category === 'fuselage') || parentless[0] || null;
    let root = null;
    const resolve = (p) => {
      if (byUid.has(p.uid)) return byUid.get(p.uid);
      const def = CATALOG[p.part];
      let matrix = null, attach = null, socketType = null, parentRec = null;
      if (p.parent && src.has(p.parent) && !visiting.has(p.uid)) {
        visiting.add(p.uid);
        parentRec = resolve(src.get(p.parent));
        visiting.delete(p.uid);
        attach = parentRec.def.attach.find((a) => a.id === p.attach) || null;
        socketType = attach ? attach.accepts.find((t) => def.sockets[t]) : null;
        if (attach && socketType) matrix = childMatrix(parentRec.matrix, attach, def.sockets[socketType], p.rot);
      }
      const free = !matrix;
      if (free) matrix = freeMatrix(p);
      const rec = { uid: p.uid, part: p, def, matrix, parent: free ? null : p.parent, attachId: free ? null : p.attach, socketType,
        free, floating: false, mirrored: M4.det(matrix) < 0 };
      if (!free) {
        const key = p.parent + ':' + p.attach;
        if (occupied.has(key)) rec.doubleBooked = occupied.get(key);
        else occupied.set(key, p.uid);
        rec.floating = parentRec.floating;
      } else if (p === rootSrc) root = rec;
      else rec.floating = true;
      byUid.set(p.uid, rec);
      list.push(rec);
      return rec;
    };
    for (const p of src.values()) resolve(p);
    for (const rec of list) fillPhysical(rec);
    return { list, byUid, occupied, root };
  }

  /** World-space physical data for one resolved part. */
  function fillPhysical(rec) {
    const { def, matrix: m } = rec;
    rec.aabb = transformBounds(m, def.bounds);
    rec.boxes = (def.boxes || [def.bounds]).map((b) => transformBounds(m, b));
    rec.center = [0, 1, 2].map((k) => (rec.aabb.min[k] + rec.aabb.max[k]) / 2);
    rec.size = [0, 1, 2].map((k) => rec.aabb.max[k] - rec.aabb.min[k]);
    rec.fuel = def.stats.fuel || 0;
    rec.mass = def.stats.mass + rec.fuel;
    rec.drag = def.stats.drag || 0;
    rec.surfaces = (def.surfaces || []).map((s) => ({
      area: s.area, center: M4.point(m, s.center), normal: M4.dir(m, s.normal), chord: M4.dir(m, s.chord),
      tip: M4.point(m, [s.span || 0, s.center[1], s.center[2]]), control: s.control, ctrlFrac: s.ctrlFrac, kind: s.kind, aero: def.aero,
    }));
    rec.engines = def.stats.thrust ? [{ thrust: def.stats.thrust, propSpeed: def.stats.propSpeed, burn: def.stats.burn, kind: def.stats.kind,
      pos: M4.point(m, [0, 0, def.bounds.min[2]]), rear: M4.point(m, [0, 0, def.bounds.max[2]]), fwd: M4.dir(m, [0, 0, -1]) }] : [];
    if (def.contacts) {
      rec.contacts = { type: def.stats.gearType, retractable: def.stats.retractable, drag: def.stats.drag };
      for (const k of Object.keys(def.contacts)) rec.contacts[k] = M4.point(m, def.contacts[k]);
      rec.drag = 0; // gear drag is applied only while the gear is down (gearCD)
    }
  }

  /** World position and direction of an attach point on a resolved part. */
  function attachWorld(rec, a) { return { pos: M4.point(rec.matrix, a.pos), dir: M4.dir(rec.matrix, a.dir) }; }

  /** The attach point that mirrors (parentUid, attachId) across the centreline, if any. */
  function mirrorTarget(design, resolved, parentUid, attachId) {
    const prec = resolved.byUid.get(parentUid);
    if (!prec) return null;
    const a = prec.def.attach.find((x) => x.id === attachId);
    if (a && a.mirror) return { parent: parentUid, attach: a.mirror };
    const p = prec.part;
    if (p.pair && resolved.byUid.has(p.pair)) return { parent: p.pair, attach: attachId };
    return null;
  }

  // ---------------------------------------------------------------------------
  // Validation: errors block flight/saving, warnings only inform.
  // ---------------------------------------------------------------------------
  function validateDesign(design, resolved, spec) {
    const errors = [], warnings = [];
    const list = resolved.list;
    if (!list.length) errors.push({ msg: 'The design is empty. Drag a fuselage onto the grid.', uid: null });
    if (list.length > MAX_PARTS) errors.push({ msg: `Too many parts (${list.length} / ${MAX_PARTS}).`, uid: null });
    for (const r of list) {
      if (r.floating) errors.push({ msg: `${r.def.name} is floating — attach it to the aircraft.`, uid: r.uid });
      if (r.doubleBooked) errors.push({ msg: `${r.def.name} shares an attach point with another part.`, uid: r.uid });
    }
    // Overlaps: AABB intersection between parts that are not directly joined (decals sit on surfaces).
    const solid = list.filter((r) => r.def.geo.kind !== 'roundel' && r.def.geo.kind !== 'stripe');
    const shrink = 0.06;
    for (let i = 0; i < solid.length; i++) for (let j = i + 1; j < solid.length; j++) {
      const a = solid[i], b = solid[j];
      if (a.parent === b.uid || b.parent === a.uid) continue;
      const boxHit = (p, q) => { for (let k = 0; k < 3; k++) if (!(p.min[k] + shrink < q.max[k] - shrink && q.min[k] + shrink < p.max[k] - shrink)) return false; return true; };
      const hit = boxHit(a.aabb, b.aabb) && a.boxes.some((p) => b.boxes.some((q) => boxHit(p, q)));
      if (hit) errors.push({ msg: `${a.def.name} overlaps ${b.def.name}.`, uid: a.uid, other: b.uid });
    }
    const has = (cat) => list.some((r) => r.def.category === cat && !r.floating);
    const firstOf = (cat) => (list.find((r) => r.def.category === cat) || resolved.root || {}).uid || null;
    if (list.length) {
      const rootUid = resolved.root ? resolved.root.uid : null;
      if (!has('wing')) warnings.push({ msg: 'No wings — it will not generate much lift.', uid: rootUid });
      if (!list.some((r) => r.engines.length && !r.floating)) warnings.push({ msg: 'No engine — it can only glide.', uid: rootUid });
      if (!has('gear')) warnings.push({ msg: 'No landing gear — test flights start in the air.', uid: rootUid });
      if (!has('tail')) {
        const elevons = list.some((r) => r.surfaces.some((s) => s.control === 'elevon'));
        warnings.push({ msg: elevons ? 'No tail — elevons give pitch control, but without a fin yaw stability is weak.' : 'No tail — pitch and yaw will be hard to control.', uid: rootUid });
      }
      if (spec && spec.design) {
        const d = spec.design;
        if (has('wing') && d.staticMargin < 0.02) warnings.push({ msg: `Centre of mass is behind the neutral point (margin ${(d.staticMargin * 100).toFixed(0)}% of chord) — unstable in pitch. Move wings back or weight forward.`, uid: d.aftMostHeavy || firstOf('wing') });
        else if (has('wing') && d.staticMargin > 0.55) warnings.push({ msg: `Very nose-heavy (margin ${(d.staticMargin * 100).toFixed(0)}% of chord) — it will need lots of elevator. Move wings forward.`, uid: d.foreMostHeavy || firstOf('wing') });
        if (Math.abs(d.cg[0]) > 0.12) warnings.push({ msg: `Unbalanced left/right — centre of mass is ${Math.abs(d.cg[0]).toFixed(2)} m to the ${d.cg[0] > 0 ? 'right' : 'left'}.`, uid: d.lateralHeavy });
        if (spec.gear && spec.gear.mainL[2] < 0.05) warnings.push({ msg: 'Centre of mass is behind the main wheels — it will sit on its tail.', uid: firstOf('gear') });
        if (spec.thrustStatic > 0 && spec.thrustStatic / spec.weight < 0.22) warnings.push({ msg: `Underpowered (thrust/weight ${(spec.thrustStatic / spec.weight).toFixed(2)}) — it may not take off.`, uid: firstOf('engine') });
        if (spec.thrustStatic > 0 && spec.fuelCapacity < 30) warnings.push({ msg: 'Very little fuel — add a tank.', uid: firstOf('tank') });
      }
    }
    return { errors, warnings, ok: errors.length === 0 };
  }

  // ---------------------------------------------------------------------------
  // Design documents: create, validate on import, starter template
  // ---------------------------------------------------------------------------
  function emptyDesign(name) { return { format: DESIGN_FORMAT, version: DESIGN_VERSION, name: name || 'My plane', parts: [] }; }

  function starterDesign() {
    const d = emptyDesign('Starter trainer');
    const P = (uid, part, parent, attach, pair) => d.parts.push({ uid, part, parent, attach, pos: [0, 0, 0], rot: [0, 0, 0], pair: pair || null });
    P('p1', 'fuse_medium', null, null);
    P('p2', 'eng_medium', 'p1', 'nose');
    P('p3', 'wing_long', 'p1', 'wingR_-5', 'p4');
    P('p4', 'wing_long', 'p1', 'wingL_-5', 'p3');
    P('p5', 'tail_conv', 'p1', 'tail');
    P('p6', 'gear_wheels', 'p1', 'bottom_f');
    P('p7', 'canopy', 'p1', 'top_f');
    P('p8', 'tank_m', 'p1', 'bottom_r');
    return d;
  }

  /** Validate and normalise an imported design. Returns { design, warnings } or throws with a readable message. */
  function importDesign(raw) {
    let obj = raw;
    if (typeof raw === 'string') { try { obj = JSON.parse(raw); } catch (e) { throw new Error('Not valid JSON.'); } }
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) throw new Error('A design must be a JSON object.');
    if (obj.format !== DESIGN_FORMAT) throw new Error(`Not an aircraft design (format should be "${DESIGN_FORMAT}").`);
    const v = Number(obj.version);
    if (!Number.isFinite(v) || v < 1) throw new Error('Missing or invalid version field.');
    const warnings = [];
    if (v > DESIGN_VERSION) warnings.push(`Design version ${v} is newer than this game (${DESIGN_VERSION}); some features may be lost.`);
    if (!Array.isArray(obj.parts)) throw new Error('The design has no parts list.');
    if (obj.parts.length > MAX_PARTS) throw new Error(`Too many parts (${obj.parts.length}; maximum ${MAX_PARTS}).`);
    const out = emptyDesign(typeof obj.name === 'string' ? obj.name.slice(0, 40) : 'Imported plane');
    const uids = new Set();
    for (const p of obj.parts) {
      if (!p || typeof p !== 'object') { warnings.push('Skipped a malformed part entry.'); continue; }
      if (!CATALOG[p.part]) { warnings.push(`Unknown part "${String(p.part).slice(0, 30)}" was skipped.`); continue; }
      const uid = typeof p.uid === 'string' && p.uid && !uids.has(p.uid) ? p.uid.slice(0, 24) : 'i' + uids.size;
      uids.add(uid);
      const num3 = (a) => (Array.isArray(a) && a.length === 3 && a.every(Number.isFinite) ? a.map((x) => Math.max(-500, Math.min(500, x))) : [0, 0, 0]);
      out.parts.push({ uid, part: p.part, parent: typeof p.parent === 'string' ? p.parent : null, attach: typeof p.attach === 'string' ? p.attach : null,
        pos: num3(p.pos), rot: num3(p.rot).map((x) => Math.round(x) % 4), mirror: !!p.mirror, pair: typeof p.pair === 'string' ? p.pair : null });
    }
    for (const p of out.parts) {
      if (p.parent && !uids.has(p.parent)) { warnings.push('A part referenced a missing parent and is now floating.'); p.parent = null; }
      if (p.pair && !uids.has(p.pair)) p.pair = null;
    }
    return { design: out, warnings };
  }

  // ===========================================================================
  // Rendering half (three.js): cached part geometry + flyable model
  // ===========================================================================
  const geoCache = new Map(); // partId → { geo, refs }
  const PALETTE = { dark: 0x1c1c1e, metal: 0x9aa0a8, glass: 0x8fc4e8, white: 0xf7f7f2 };

  function slab(x0, x1, zle0, zte0, zle1, zte1, t) {
    // Trapezoidal plate from root (x0) to tip (x1); 8 corners → 12 triangles.
    const v = [[x0, -t, zle0], [x0, -t, zte0], [x1, -t, zte1], [x1, -t, zle1], [x0, t, zle0], [x0, t, zte0], [x1, t, zte1], [x1, t, zle1]];
    const f = [[0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4], [1, 2, 6], [1, 6, 5], [2, 3, 7], [2, 7, 6], [3, 0, 4], [3, 4, 7]];
    const pos = [];
    for (const tri of f) for (const i of tri) pos.push(...v[i]);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.computeVertexNormals();
    return g;
  }

  /** Build { base: [geometries], anim: [{ kind, geo, pivot, axis }] } for a part (part-local space). */
  function buildPartPieces(def) {
    const G = AV.Geo, C = (g, color, m) => G.colored(g, color, m), M = G.mat;
    const col = def.color, base = [], anim = [];
    const g = def.geo;
    const darker = new THREE.Color(col).multiplyScalar(0.7).getHex();
    switch (g.kind) {
      case 'fuselage': {
        const cyl = new THREE.CylinderGeometry(g.r, g.r, g.l, 12, 1, true); cyl.rotateX(Math.PI / 2);
        base.push(C(cyl, col));
        const band = new THREE.CylinderGeometry(g.r * 1.015, g.r * 1.015, 0.35, 12, 1, true); band.rotateX(Math.PI / 2);
        base.push(C(band, 0xd2322d, M(0, 0, g.l * 0.1)));
        for (const s of [-1, 1]) { const cap = new THREE.CircleGeometry(g.r, 12); base.push(C(cap, darker, M(0, 0, s * g.l / 2, 0, s > 0 ? 0 : Math.PI, 0))); }
        break;
      }
      case 'prop': {
        const cowl = new THREE.CylinderGeometry(0.45, R * 0.97, g.len, 12); cowl.rotateX(-Math.PI / 2);
        base.push(C(cowl, col, M(0, 0, -g.len / 2)));
        const spin = new THREE.ConeGeometry(0.3, 0.45, 10); spin.rotateX(-Math.PI / 2);
        base.push(C(spin, 0xd2322d, M(0, 0, -g.len - 0.2)));
        const blades = [];
        for (let i = 0; i < g.blades; i++) blades.push(C(new THREE.BoxGeometry(0.16, g.radius, 0.05), PALETTE.dark, M(0, g.radius / 2, 0, 0, 0.3, 0).premultiply(new THREE.Matrix4().makeRotationZ((i / g.blades) * Math.PI * 2))));
        anim.push({ kind: 'prop', geo: G.merge(blades), pivot: [0, 0, -g.len - 0.05], axis: 'z' });
        break;
      }
      case 'jet': {
        const n = new THREE.CylinderGeometry(g.r, g.r * 0.85, g.len, 14); n.rotateX(Math.PI / 2);
        base.push(C(n, col));
        const intake = new THREE.CircleGeometry(g.r * 0.85, 14); base.push(C(intake, PALETTE.dark, M(0, 0, -g.len / 2 - 0.01, 0, Math.PI, 0)));
        const ex = new THREE.CylinderGeometry(g.r * 0.6, g.r * 0.5, 0.3, 12, 1, true); ex.rotateX(Math.PI / 2);
        base.push(C(ex, 0x2a2a2a, M(0, 0, g.len / 2 + 0.15)));
        const fan = [];
        for (let i = 0; i < 8; i++) fan.push(C(new THREE.BoxGeometry(0.1, g.r * 0.8, 0.03), PALETTE.metal, M(0, g.r * 0.4, 0, 0, 0.5, 0).premultiply(new THREE.Matrix4().makeRotationZ(i * Math.PI / 4))));
        anim.push({ kind: 'prop', geo: G.merge(fan), pivot: [0, 0, -g.len / 2 + 0.05], axis: 'z' });
        break;
      }
      case 'nacelle': {
        const n = new THREE.CylinderGeometry(g.r * 0.7, g.r, g.len, 10); n.rotateX(-Math.PI / 2);
        base.push(C(n, col, M(0, 0, -0.1)));
        const spin = new THREE.ConeGeometry(0.22, 0.35, 8); spin.rotateX(-Math.PI / 2);
        base.push(C(spin, 0xd2322d, M(0, 0, -g.len / 2 - 0.3)));
        const blades = [];
        for (let i = 0; i < 3; i++) blades.push(C(new THREE.BoxGeometry(0.14, g.radius, 0.04), PALETTE.dark, M(0, g.radius / 2, 0, 0, 0.3, 0).premultiply(new THREE.Matrix4().makeRotationZ((i / 3) * Math.PI * 2))));
        anim.push({ kind: 'prop', geo: G.merge(blades), pivot: [0, 0, -g.len / 2 - 0.25], axis: 'z' });
        break;
      }
      case 'tank': {
        const body = new THREE.CylinderGeometry(g.r, g.r, g.len - 2 * g.r, 10); body.rotateX(Math.PI / 2);
        base.push(C(body, col));
        for (const s of [-1, 1]) { const cap = new THREE.ConeGeometry(g.r, g.r * 1.2, 10); cap.rotateX(s * Math.PI / 2); base.push(C(cap, col, M(0, 0, s * (g.len / 2 - g.r * 0.4)))); }
        base.push(C(new THREE.BoxGeometry(0.12, 0.25, 0.6), PALETTE.metal, M(0, g.r + 0.08, 0)));
        break;
      }
      case 'wing': {
        const { semi, cr, ct, zleTip } = g;
        const at = (f) => { const zl = -cr / 2 + (zleTip + cr / 2) * f; const c = cr + (ct - cr) * f; return [zl, zl + c]; };
        const [l0, t0] = at(0), [l55, t55] = at(0.55), [l1, t1] = at(1);
        const th = 0.09;
        base.push(C(slab(0, semi * 0.55, l0, t0, l55, t55, th), col));
        const split = (zl, zt) => zl + (zt - zl) * 0.75;
        base.push(C(slab(semi * 0.55, semi, l55, split(l55, t55), l1, split(l1, t1), th), col));
        base.push(C(slab(semi * 0.92, semi, l1 - 0.01, split(l1, t1) + 0.01, l1 - 0.01, split(l1, t1) + 0.01, th + 0.005), 0xd2322d));
        // Aileron / elevon: rotates about its leading-edge hinge (local X).
        const hz = (split(l55, t55) + split(l1, t1)) / 2;
        const ail = slab(semi * 0.55, semi, split(l55, t55) - hz, t55 - hz, split(l1, t1) - hz, t1 - hz, th * 0.7);
        anim.push({ kind: def.surfaces[0].control, geo: C(ail, 0x1f3c6e), pivot: [0, 0, hz], axis: 'x' });
        break;
      }
      case 'tail': {
        const cone = new THREE.CylinderGeometry(R, 0.2, 2.6, 12, 1, true); cone.rotateX(Math.PI / 2);
        base.push(C(cone, 0xf1efe8, M(0, 0, 1.3)));
        const stab = (span, y, z0, dihedral, control) => {
          const st = slab(-span, span, z0, z0 + 0.55, z0 + 0.15, z0 + 0.6, 0.05);
          base.push(C(st, col, M(0, y, 0, 0, 0, dihedral)));
          const el = slab(-span, span, 0, 0.32, 0, 0.27, 0.035);
          anim.push({ kind: control, geo: C(el, 0x1f3c6e), pivot: [0, y, z0 + 0.58], axis: 'x', roll: dihedral });
        };
        const fin = (h, z0) => {
          const f = slab(0, h, z0, z0 + 0.8, z0 + 0.5, z0 + 0.95, 0.05);
          base.push(C(f, col, M(0, 0.2, 0, 0, 0, Math.PI / 2)));
          const rud = slab(0, h, 0, 0.35, 0, 0.3, 0.035);
          anim.push({ kind: 'rudder', geo: C(rud, 0x1f3c6e, M(0, 0, 0, 0, 0, Math.PI / 2)), pivot: [0, 0.2, z0 + 0.85], axis: 'y' });
        };
        if (g.tail === 'conventional') { stab(1.8, 0.15, 1.85, 0, 'elevator'); fin(1.8, 1.6); }
        else if (g.tail === 't') { fin(1.85, 1.6); stab(1.7, 2.0, 2.05, 0, 'elevator'); }
        else { for (const s of [-1, 1]) stab(0.85, 0.25, 1.85, s * 0.61, 'ruddervator'); }
        break;
      }
      case 'gear': {
        const c = def.contacts;
        if (g.type === 'floats') {
          for (const s of [-1, 1]) {
            const pont = new THREE.CylinderGeometry(0.32, 0.32, 3.6, 10); pont.rotateX(Math.PI / 2);
            base.push(C(pont, col, M(s * 1.55, c.mainL[1] + 0.32, -0.3)));
            const tip = new THREE.ConeGeometry(0.32, 0.7, 10); tip.rotateX(-Math.PI / 2);
            base.push(C(tip, col, M(s * 1.55, c.mainL[1] + 0.32, -2.45)));
            for (const z of [-1.2, 0.8]) base.push(C(new THREE.CylinderGeometry(0.05, 0.05, 1.2, 4), PALETTE.metal, M(s * 0.8, -0.45, z, 0, 0, s * 0.95)));
          }
          break;
        }
        const wheelGeo = new THREE.CylinderGeometry(0.32, 0.32, 0.22, 10); wheelGeo.rotateZ(Math.PI / 2);
        for (const k of ['nose', 'mainL', 'mainR']) {
          const p = c[k];
          const leg = [C(new THREE.CylinderGeometry(0.06, 0.07, -p[1] - 0.3, 5), PALETTE.metal, M(0, (p[1] + 0.3) / 2, 0))];
          if (g.type === 'skis') leg.push(C(new THREE.BoxGeometry(0.32, 0.08, 1.4), 0xe8e8e8, M(0, p[1] + 0.04, 0, -0.05, 0, 0)));
          else leg.push(C(wheelGeo, PALETTE.dark, M(0, p[1] + 0.32, 0)));
          const piece = G.merge(leg);
          if (g.type === 'wheels') anim.push({ kind: 'gear', geo: piece, pivot: [p[0], 0, p[2]], axis: k === 'nose' ? 'x' : 'z', side: k === 'mainL' ? -1 : k === 'mainR' ? 1 : 0 });
          else { piece.applyMatrix4(M(p[0], 0, p[2])); base.push(piece); }
        }
        break;
      }
      case 'canopy': {
        const s = new THREE.SphereGeometry(0.55, 12, 6, 0, Math.PI * 2, 0, Math.PI / 2);
        base.push(C(s, col, M(0, 0, 0, 0, 0, 0, 1, 1.25, 1.65)));
        break;
      }
      case 'cone': {
        const cone = new THREE.ConeGeometry(R, 1.2, 12); cone.rotateX(-Math.PI / 2);
        base.push(C(cone, col, M(0, 0, -0.6)));
        break;
      }
      case 'winglet': base.push(C(slab(0, 0.9, -0.45, 0.35, -0.2, 0.4, 0.04), col, M(0.08, 0, 0, 0, 0, Math.PI / 2))); break;
      case 'roundel': {
        const ring = (r, color, x) => { const c = new THREE.CircleGeometry(r, 20); c.rotateY(Math.PI / 2); base.push(C(c, color, M(x, 0, 0))); };
        ring(0.3, 0x1f3c6e, 0.012); ring(0.2, 0xffffff, 0.018); ring(0.1, 0xd2322d, 0.024);
        break;
      }
      case 'stripe': base.push(C(new THREE.BoxGeometry(0.02, 0.24, 1.4), col, M(0.012, 0, 0))); break;
      default: base.push(C(new THREE.BoxGeometry(1, 1, 1), col));
    }
    return { base, anim };
  }

  /** Shared, reference-counted editor geometry (static + animated pieces merged). */
  function acquireGeometry(partId) {
    let e = geoCache.get(partId);
    if (!e) {
      const { base, anim } = buildPartPieces(CATALOG[partId]);
      const all = base.concat(anim.map((a) => { const g = a.geo.clone(); g.applyMatrix4(new THREE.Matrix4().makeTranslation(a.pivot[0], a.pivot[1], a.pivot[2])); a.geo.dispose(); return g; }));
      e = { geo: AV.Geo.merge(all), refs: 0 };
      e.geo.computeBoundingSphere();
      geoCache.set(partId, e);
    }
    e.refs++;
    return e.geo;
  }
  function releaseGeometry(partId) {
    const e = geoCache.get(partId);
    if (!e) return;
    if (--e.refs <= 0) { e.geo.dispose(); geoCache.delete(partId); }
  }
  function cachedGeometryCount() { return geoCache.size; }

  /** Mirrored parts flip triangle winding when baked into one geometry. */
  function bake(geo, m4) {
    const g = geo.clone();
    g.applyMatrix4(m4);
    if (m4.determinant() < 0) {
      const p = g.attributes.position.array, n = g.attributes.normal.array, c = g.attributes.color.array;
      for (let i = 0; i < p.length; i += 9) for (const arr of [p, n, c]) for (let k = 0; k < 3; k++) { const t = arr[i + 3 + k]; arr[i + 3 + k] = arr[i + 6 + k]; arr[i + 6 + k] = t; }
    }
    return g;
  }

  /**
   * Flyable model for a resolved design: one merged static mesh plus animated
   * pivots (props, control surfaces, retracting gear). `offset` shifts the design
   * so the centre of mass sits at the model origin, matching the physics body.
   */
  function buildFlightModel(resolved, offset, material) {
    const group = new THREE.Group();
    const statics = [], anims = [];
    const shift = new THREE.Matrix4().makeTranslation(-offset[0], -offset[1], -offset[2]);
    for (const rec of resolved.list) {
      if (rec.floating) continue;
      const m = new THREE.Matrix4().fromArray(rec.matrix).premultiply(shift);
      const { base, anim } = buildPartPieces(rec.def);
      for (const g of base) { statics.push(bake(g, m)); g.dispose(); }
      for (const a of anim) {
        const pivot = new THREE.Group();
        pivot.matrixAutoUpdate = false;
        pivot.matrix.copy(m).multiply(new THREE.Matrix4().makeTranslation(a.pivot[0], a.pivot[1], a.pivot[2]));
        if (a.roll) pivot.matrix.multiply(new THREE.Matrix4().makeRotationZ(a.roll));
        const mesh = new THREE.Mesh(a.geo, material);
        mesh.castShadow = true;
        pivot.add(mesh);
        group.add(pivot);
        // Which side of the aircraft the surface sits on decides its deflection sign.
        const wp = new THREE.Vector3().setFromMatrixPosition(pivot.matrix);
        anims.push({ kind: a.kind, mesh, axis: a.axis, side: a.side !== undefined ? a.side : Math.sign(wp.x) || 0, mirrored: pivot.matrix.determinant() < 0 });
      }
    }
    if (statics.length) {
      const mesh = new THREE.Mesh(AV.Geo.merge(statics), material);
      mesh.castShadow = true;
      group.add(mesh);
    }
    return { group, anims };
  }

  AV.Parts = {
    DESIGN_FORMAT, DESIGN_VERSION, MAX_PARTS, CATEGORIES, CATALOG, PARTS, M4,
    statSummary, resolveDesign, attachWorld, mirrorTarget, validateDesign, childMatrix,
    emptyDesign, starterDesign, importDesign,
    acquireGeometry, releaseGeometry, cachedGeometryCount, buildFlightModel,
  };
})(window.AV);
