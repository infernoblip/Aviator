/* physics.js — arcade-realistic rigid-body flight model.
 *
 * Pure math module: no DOM access and no three.js. Everything the simulation
 * needs from the outside world (terrain height, surface type, wind, obstacles,
 * random numbers) is injected through an `env` object, so the model can be
 * exercised headless (see AV.Physics.selfTest()).
 *
 * Conventions
 *   World:  +Y up, -Z north, +X east. Units: metres, seconds, kilograms, radians.
 *   Body:   +X right wing, +Y up, -Z forward (nose).
 *   Body angular velocity w: w.x > 0 pitches nose up, w.y > 0 yaws nose left,
 *   w.z > 0 rolls left (rotation about the backward axis).
 *   Pilot controls: elevator > 0 nose up, aileron > 0 roll right, rudder > 0 yaw right.
 */
window.AV = window.AV || {};
(function (AV) {
  'use strict';

  // ---------------------------------------------------------------------------
  // CONFIG — every tuning number lives here.
  // ---------------------------------------------------------------------------
  const CONFIG = {
    dt: 1 / 120,               // fixed physics timestep (s)
    maxStepsPerFrame: 15,      // spiral-of-death guard
    gravity: 9.81,             // m/s²
    seaLevelDensity: 1.225,    // kg/m³
    densityScaleHeight: 8500,  // m, ρ = ρ0·exp(-h/H)
    waterLevel: 0,

    actuatorRate: { elevator: 6, aileron: 7, rudder: 5 }, // full-scale deflections per second
    throttleRate: 0.9,         // throttle lever travel per second (spool)
    flapRate: 0.5,
    gearRate: 0.45,

    stallWidth: 0.12,          // rad over which lift collapses past the critical AoA
    stallWarnMargin: 0.055,    // rad before critical AoA where the horn sounds
    stallPitchBreak: 0.12,     // nose-down Cm increment when fully stalled
    stallAutorotation: 1.5,    // roll damping sign flips when stalled -> spin
    autorotationHelixLimit: 0.3, // autorotation fades once roll helix angle p·b/2V exceeds this
    maxAngularRate: 9,         // rad/s numerical safety clamp
    stallYawDampingLoss: 0.7,
    stallYawRollCoupling: 0.45,
    aileronStallLoss: 0.55,
    flatPlateLift: 0.9,        // CL = k·sin(2α) when fully stalled
    flatPlateDrag: 1.25,       // CD = k·sin²α when fully stalled
    angularDampingBase: 0.25,  // 1/s structural damping so rates settle at zero airspeed
    sideslipLimit: 0.35,       // rad; dihedral, weathervane and side-force terms saturate beyond this
    groundEffectStrength: 0.45,

    turbulence: { timeConstant: 1.2, maxGust: 7 }, // Ornstein–Uhlenbeck gust model

    ground: {
      springPerKg: 60,          // N/m per kg of aircraft mass per wheel
      damperPerKg: 6,           // N·s/m per kg per wheel
      rollFriction: { runway: 0.02, grass: 0.06, sand: 0.13, snow: 0.05, rock: 0.1, pad: 0.03 },
      brakeFriction: 0.55,
      lateralGrip: 25,          // 1/s — how quickly tyres kill sideways slip
      lateralMu: 0.55,          // aircraft tyres skid sideways long before they could roll the airframe
      steerAngle: 0.38,         // rad of nose-wheel steering at full rudder
      steerFadeSpeed: 35,       // m/s at which steering authority halves
      hullFriction: 0.45,
      maxPenetration: 1.6,
    },

    landing: {
      hardVS: 3.0,              // m/s sink rate at touchdown that causes damage
      crashVS: 6.5,             // m/s sink rate that destroys the gear/airframe
      maxRoll: 0.42,            // rad of bank at touchdown before a wing digs in
      scrapeDamagePerSec: 0.35,
      waterCrashSpeed: 3,
      hullCrashSpeed: 9,        // m/s total contact speed for a fatal hull strike
    },

    damage: {
      hardLanding: 0.22,
      thrustLoss: 0.45,         // fraction of thrust lost at 100 % damage
      overGPerSec: 0.08,        // damage rate per G above the limit
    },

    // Built aircraft (Plane Builder): how part geometry turns into derivatives.
    builder: {
      gearFriction: {
        wheels: null,              // use ground.rollFriction
        skis: { runway: 0.22, pad: 0.22, grass: 0.1, sand: 0.18, snow: 0.02, rock: 0.25, water: 0.6 },
        floats: { runway: 0.5, pad: 0.5, grass: 0.4, sand: 0.45, snow: 0.3, rock: 0.55, water: 0.09 },
      },
      tailDownwash: 0.55,          // efficiency of tail surfaces in the neutral-point sum
      elevatorGain: 1.75,          // Cmδe = gain · elevator volume
      elevonGain: 1.2,
      rudderGain: 2.5,             // Cnδr = gain · rudder volume
      aileronGain: 0.55,           // Clδa = gain · Σ(S·frac·|x|) / (S·b/2)
      cnbBase: 0.015, cnbVolume: 2.0, cnrBase: 0.04, cnrVolume: 2.2,
      cmqBase: 5, cmqVolume: 18,
      skinDrag: 0.004,             // extra CD0 for interference and skin friction
      minWingArea: 0.8,
      cmaLimits: [-3, 0.8],
      internalFuelBurnFloor: 0.15, // fraction of full-throttle burn at idle
    },

    upgrades: {                 // multipliers per purchased level (0..3)
      enginePerLevel: 0.08,
      handlingPerLevel: 0.08,
      durabilityPerLevel: 0.2,
    },

    assist: {
      light: { coordination: 2.2, autoTrim: 0.75, stallGuard: 0.5, stallGuardMargin: 0.04, groundYawDamp: 1.6, groundWingLevel: 3 },
      heavy: { coordination: 3.0, autoTrim: 1.0, stallGuard: 1.0, stallGuardMargin: 0.07,
               pitchRateCmd: 0.75, pitchRateGain: 1.6, wingLevelGain: 1.6, rollRateDamp: 0.35,
               bankLimit: 1.15, wingLevelDeadzone: 0.06, groundYawDamp: 2.4, groundWingLevel: 4 },
    },

    // Distinct airframes. Aerodynamic derivatives are per-radian, dimensionless.
    aircraft: {
      kestrel: {
        name: 'Kestrel T-1', role: 'Trainer — forgiving, slow stall',
        mass: 900, wingArea: 16, span: 10.5, chord: 1.5,
        inertia: { pitch: 1350, yaw: 2000, roll: 1100 },
        CL0: 0.25, CLa: 5.0, alphaStall: 0.27, CD0: 0.030, oswald: 0.8,
        CYb: -0.6, Cma: -1.2, Cmq: -12, Cmde: 0.42,
        Clda: 0.07, Clp: -0.45, Clb: -0.09, Clr: 0.1,
        Cnb: 0.10, Cnr: -0.13, Cndr: 0.045, Cnda: -0.008, Cnp: -0.03,
        thrustStatic: 3600, propSpeed: 112, propWash: 18,
        flapCL: 0.45, flapCD: 0.035, flapStallShift: -0.03, gearCD: 0.008,
        cruiseSpeed: 50, maxG: 6, durability: 1.2, wingDrop: 0.012,
        retractableGear: true, maxRPM: 2700,
        gear: { nose: [0, -1.35, -1.7], mainL: [-1.5, -1.35, 0.75], mainR: [1.5, -1.35, 0.75] },
        hull: { nose: [0, 0, -2.6], tail: [0, 0.2, 4.6], wingL: [-5.2, 0.6, 0.1], wingR: [5.2, 0.6, 0.1],
                top: [0, 1.5, 0], belly: [0, -0.75, 0] },
        price: 0,
      },
      swift: {
        name: 'Swift R-7', role: 'Racer — fast and twitchy',
        mass: 760, wingArea: 10, span: 7.6, chord: 1.35,
        inertia: { pitch: 950, yaw: 1500, roll: 700 },
        CL0: 0.15, CLa: 5.2, alphaStall: 0.24, CD0: 0.022, oswald: 0.8,
        CYb: -0.55, Cma: -1.0, Cmq: -10, Cmde: 0.45,
        Clda: 0.055, Clp: -0.4, Clb: -0.06, Clr: 0.08,
        Cnb: 0.09, Cnr: -0.11, Cndr: 0.04, Cnda: -0.006, Cnp: -0.02,
        thrustStatic: 4700, propSpeed: 165, propWash: 20,
        flapCL: 0.35, flapCD: 0.03, flapStallShift: -0.02, gearCD: 0.01,
        cruiseSpeed: 80, maxG: 8, durability: 0.85, wingDrop: 0.02,
        retractableGear: true, maxRPM: 3100,
        gear: { nose: [0, -1.2, -1.6], mainL: [-1.35, -1.2, 0.7], mainR: [1.35, -1.2, 0.7] },
        hull: { nose: [0, 0, -2.7], tail: [0, 0.2, 4.0], wingL: [-3.8, 0.0, 0.2], wingR: [3.8, 0.0, 0.2],
                top: [0, 1.2, 0], belly: [0, -0.65, 0] },
        price: 1400,
      },
      bulldog: {
        name: 'Bulldog B-2', role: 'Biplane — agile, low and slow',
        mass: 800, wingArea: 22, span: 8.2, chord: 1.4,
        inertia: { pitch: 1100, yaw: 1600, roll: 800 },
        CL0: 0.3, CLa: 4.2, alphaStall: 0.29, CD0: 0.05, oswald: 0.75,
        CYb: -0.7, Cma: -1.3, Cmq: -14, Cmde: 0.5,
        Clda: 0.075, Clp: -0.38, Clb: -0.1, Clr: 0.1,
        Cnb: 0.11, Cnr: -0.14, Cndr: 0.055, Cnda: -0.01, Cnp: -0.03,
        thrustStatic: 3900, propSpeed: 92, propWash: 18,
        flapCL: 0.3, flapCD: 0.03, flapStallShift: -0.02, gearCD: 0.0,
        cruiseSpeed: 40, maxG: 7, durability: 1.0, wingDrop: 0.01,
        retractableGear: false, maxRPM: 2400,
        gear: { nose: [0, -1.45, -1.5], mainL: [-1.6, -1.45, 0.7], mainR: [1.6, -1.45, 0.7] },
        hull: { nose: [0, 0, -2.4], tail: [0, 0.2, 4.2], wingL: [-4.1, 1.5, 0], wingR: [4.1, 1.5, 0],
                top: [0, 2.2, 0], belly: [0, -0.7, 0] },
        price: 600,
      },
      titan: {
        name: 'Titan H-4', role: 'Heavy twin — tough, stable, powerful',
        mass: 2200, wingArea: 28, span: 15, chord: 1.9,
        inertia: { pitch: 9000, yaw: 14000, roll: 8000 },
        CL0: 0.25, CLa: 5.3, alphaStall: 0.25, CD0: 0.028, oswald: 0.82,
        CYb: -0.6, Cma: -1.1, Cmq: -14, Cmde: 0.38,
        Clda: 0.045, Clp: -0.5, Clb: -0.1, Clr: 0.1,
        Cnb: 0.11, Cnr: -0.15, Cndr: 0.04, Cnda: -0.006, Cnp: -0.03,
        thrustStatic: 9800, propSpeed: 150, propWash: 16,
        flapCL: 0.5, flapCD: 0.04, flapStallShift: -0.03, gearCD: 0.008,
        cruiseSpeed: 75, maxG: 4.5, durability: 2.0, wingDrop: 0.008,
        retractableGear: true, maxRPM: 2200,
        gear: { nose: [0, -1.6, -3.0], mainL: [-2.4, -1.6, 1.0], mainR: [2.4, -1.6, 1.0] },
        hull: { nose: [0, 0, -4.4], tail: [0, 0.4, 6.2], wingL: [-7.4, 0.2, 0.3], wingR: [7.4, 0.2, 0.3],
                top: [0, 1.9, 0], belly: [0, -0.9, 0] },
        price: 2600,
      },
    },
  };

  // ---------------------------------------------------------------------------
  // Small vector / quaternion helpers on plain objects (allocation-light).
  // ---------------------------------------------------------------------------
  const V = {
    make: (x = 0, y = 0, z = 0) => ({ x, y, z }),
    set(o, x, y, z) { o.x = x; o.y = y; o.z = z; return o; },
    copy(o, a) { o.x = a.x; o.y = a.y; o.z = a.z; return o; },
    fromArray: (a) => ({ x: a[0], y: a[1], z: a[2] }),
    add(o, a, b) { o.x = a.x + b.x; o.y = a.y + b.y; o.z = a.z + b.z; return o; },
    sub(o, a, b) { o.x = a.x - b.x; o.y = a.y - b.y; o.z = a.z - b.z; return o; },
    scale(o, a, s) { o.x = a.x * s; o.y = a.y * s; o.z = a.z * s; return o; },
    addScaled(o, a, b, s) { o.x = a.x + b.x * s; o.y = a.y + b.y * s; o.z = a.z + b.z * s; return o; },
    dot: (a, b) => a.x * b.x + a.y * b.y + a.z * b.z,
    cross(o, a, b) {
      const x = a.y * b.z - a.z * b.y, y = a.z * b.x - a.x * b.z, z = a.x * b.y - a.y * b.x;
      o.x = x; o.y = y; o.z = z; return o;
    },
    len: (a) => Math.sqrt(a.x * a.x + a.y * a.y + a.z * a.z),
    normalize(o, a) { const l = V.len(a) || 1; return V.scale(o, a, 1 / l); },
    lerp(o, a, b, t) { o.x = a.x + (b.x - a.x) * t; o.y = a.y + (b.y - a.y) * t; o.z = a.z + (b.z - a.z) * t; return o; },
  };

  const Q = {
    make: (x = 0, y = 0, z = 0, w = 1) => ({ x, y, z, w }),
    copy(o, a) { o.x = a.x; o.y = a.y; o.z = a.z; o.w = a.w; return o; },
    mul(o, a, b) {
      const x = a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y;
      const y = a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x;
      const z = a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w;
      const w = a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z;
      o.x = x; o.y = y; o.z = z; o.w = w; return o;
    },
    normalize(o) {
      const l = Math.sqrt(o.x * o.x + o.y * o.y + o.z * o.z + o.w * o.w) || 1;
      o.x /= l; o.y /= l; o.z /= l; o.w /= l; return o;
    },
    axisAngle(axis, a) { const s = Math.sin(a / 2); return { x: axis.x * s, y: axis.y * s, z: axis.z * s, w: Math.cos(a / 2) }; },
    /** v' = q·v·q*  using  t = 2·(q.xyz × v);  v' = v + w·t + q.xyz × t */
    rotate(o, q, v) {
      const tx = 2 * (q.y * v.z - q.z * v.y), ty = 2 * (q.z * v.x - q.x * v.z), tz = 2 * (q.x * v.y - q.y * v.x);
      const x = v.x + q.w * tx + (q.y * tz - q.z * ty);
      const y = v.y + q.w * ty + (q.z * tx - q.x * tz);
      const z = v.z + q.w * tz + (q.x * ty - q.y * tx);
      o.x = x; o.y = y; o.z = z; return o;
    },
    rotateInv(o, q, v) { return Q.rotate(o, { x: -q.x, y: -q.y, z: -q.z, w: q.w }, v); },
    /** Heading clockwise from north, pitch nose-up, roll right-wing-down. */
    fromHPR(heading, pitch, roll) {
      const qy = Q.axisAngle({ x: 0, y: 1, z: 0 }, -heading);
      const qx = Q.axisAngle({ x: 1, y: 0, z: 0 }, pitch);
      const qz = Q.axisAngle({ x: 0, y: 0, z: 1 }, -roll);
      return Q.mul(Q.make(), Q.mul(Q.make(), qy, qx), qz);
    },
    slerp(o, a, b, t) {
      let bx = b.x, by = b.y, bz = b.z, bw = b.w;
      let cos = a.x * bx + a.y * by + a.z * bz + a.w * bw;
      if (cos < 0) { cos = -cos; bx = -bx; by = -by; bz = -bz; bw = -bw; }
      let k0 = 1 - t, k1 = t;
      if (cos < 0.9995) {
        const ang = Math.acos(cos), s = Math.sin(ang);
        k0 = Math.sin((1 - t) * ang) / s; k1 = Math.sin(t * ang) / s;
      }
      o.x = a.x * k0 + bx * k1; o.y = a.y * k0 + by * k1; o.z = a.z * k0 + bz * k1; o.w = a.w * k0 + bw * k1;
      return Q.normalize(o);
    },
  };

  const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
  const approach = (cur, target, maxDelta) => cur + clamp(target - cur, -maxDelta, maxDelta);
  const smoothstep = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };

  const AXIS_X = V.make(1, 0, 0), AXIS_Y = V.make(0, 1, 0), AXIS_FWD = V.make(0, 0, -1);
  const WORLD_UP = V.make(0, 1, 0);

  // ---------------------------------------------------------------------------
  // Spec building: merge an airframe with upgrades into one flat parameter set.
  // ---------------------------------------------------------------------------
  function buildSpec(aircraftId, upgrades) {
    const base = CONFIG.aircraft[aircraftId] || CONFIG.aircraft.kestrel;
    const u = upgrades;
    const spec = JSON.parse(JSON.stringify(base));
    spec.id = aircraftId;
    applyUpgrades(spec, u);
    deriveSpec(spec);
    return spec;
  }

  /** Hangar upgrades scale thrust, control authority and strength (stock and custom aircraft alike). */
  function applyUpgrades(spec, upgrades) {
    const u = Object.assign({ engine: 0, handling: 0, durability: 0 }, upgrades || {});
    const engineMul = 1 + CONFIG.upgrades.enginePerLevel * u.engine;
    const handleMul = 1 + CONFIG.upgrades.handlingPerLevel * u.handling;
    spec.thrustStatic *= engineMul;
    spec.propSpeed *= 1 + 0.5 * CONFIG.upgrades.enginePerLevel * u.engine;
    spec.Cmde *= handleMul; spec.Clda *= handleMul; spec.Cndr *= handleMul;
    spec.durability *= 1 + CONFIG.upgrades.durabilityPerLevel * u.durability;
  }

  /** Derived constants: induced drag factor, stall CL, and a Cm0 that trims for cruise. */
  function deriveSpec(spec) {
    const AR = (spec.span * spec.span) / spec.wingArea;
    spec.aspectRatio = AR;
    spec.inducedK = 1 / (Math.PI * spec.oswald * AR);           // CDi = k·CL²
    spec.CLmax = spec.CL0 + spec.CLa * spec.alphaStall;
    spec.weight = spec.mass * CONFIG.gravity;
    // Cm0 chosen so that stick-free equilibrium AoA matches level flight at cruise speed.
    const qCruise = 0.5 * CONFIG.seaLevelDensity * spec.cruiseSpeed * spec.cruiseSpeed;
    const alphaCruise = (spec.weight / (qCruise * spec.wingArea) - spec.CL0) / spec.CLa;
    spec.Cm0 = -spec.Cma * Math.sin(alphaCruise);
    spec.stallSpeed = Math.sqrt((2 * spec.weight) / (CONFIG.seaLevelDensity * spec.wingArea * spec.CLmax));
    spec.gearPoints = spec.gear ? ['nose', 'mainL', 'mainR'].map((k) => ({ name: k, p: V.fromArray(spec.gear[k]), main: k !== 'nose' })) : [];
    spec.hullPoints = Object.keys(spec.hull).map((k) => ({
      name: k, p: V.fromArray(spec.hull[k]), soft: k === 'tail' || k === 'belly',
    }));
    spec.gearHeight = spec.gear ? -spec.gear.mainL[1] : -spec.hull.belly[1];
    return spec;
  }

  // ---------------------------------------------------------------------------
  // Aerodynamic coefficients (shared by step() and computeTrim()).
  // ---------------------------------------------------------------------------
  /** Lift/drag/pitch coefficients for angle of attack `alpha` (rad, full ±π range). */
  function aeroCoefficients(spec, alpha, flaps, gear, out) {
    const alphaStall = spec.alphaStall + spec.flapStallShift * flaps;
    const negStall = spec.alphaStall * 0.85;
    // Stall factor: 0 = attached flow, 1 = fully separated.
    const stall = alpha >= 0
      ? smoothstep(alphaStall, alphaStall + CONFIG.stallWidth, alpha)
      : smoothstep(negStall, negStall + CONFIG.stallWidth, -alpha);
    const clLinear = spec.CL0 + spec.flapCL * flaps + spec.CLa * alpha;   // thin-airfoil linear lift
    const clFlat = CONFIG.flatPlateLift * Math.sin(2 * alpha);           // flat plate post-stall
    const CL = (1 - stall) * clLinear + stall * clFlat;
    const sinA = Math.sin(alpha);
    // Drag polar: CD = CD0 + k·CL² (induced) + separated-flow pressure drag.
    const CD = spec.CD0 + spec.flapCD * flaps + spec.gearCD * gear +
      spec.inducedK * CL * CL * (1 - stall) + stall * CONFIG.flatPlateDrag * sinA * sinA;
    // Static pitch stability uses sin(α) so the nose always weather-vanes into the airflow
    // (this is what makes a tail-slide flip the aircraft back over).
    const Cm = spec.Cm0 + spec.Cma * sinA - CONFIG.stallPitchBreak * stall;
    out.CL = CL; out.CD = CD; out.Cm = Cm; out.stall = stall; out.alphaStall = alphaStall;
    return out;
  }

  const airDensity = (altitude) => CONFIG.seaLevelDensity * Math.exp(-Math.max(0, altitude) / CONFIG.densityScaleHeight);

  /** Propeller thrust falls linearly with forward speed until propSpeed. */
  function thrustAt(spec, throttle, forwardSpeed, rho, boost, damage) {
    const b = boost || 1;
    const vProp = spec.propSpeed * Math.sqrt(b);
    const eff = clamp(1 - Math.max(0, forwardSpeed) / vProp, 0, 1);
    const dmg = 1 - CONFIG.damage.thrustLoss * clamp(damage || 0, 0, 1);
    return throttle * spec.thrustStatic * b * eff * (rho / CONFIG.seaLevelDensity) * dmg;
  }

  // ---------------------------------------------------------------------------
  // State
  // ---------------------------------------------------------------------------
  function createState(spec, opts) {
    const o = Object.assign({ x: 0, y: 1000, z: 0, heading: 0, pitch: 0, roll: 0, speed: 0, onGround: false, throttle: 0 }, opts || {});
    const q = Q.fromHPR(o.heading, o.pitch, o.roll);
    const fwd = Q.rotate(V.make(), q, AXIS_FWD);
    const state = {
      pos: V.make(o.x, o.y, o.z),
      vel: V.scale(V.make(), fwd, o.speed),
      q,
      w: V.make(),                  // body angular velocity
      prevPos: V.make(o.x, o.y, o.z),
      prevQ: Q.copy(Q.make(), q),
      throttle: o.throttle,
      elevator: 0, aileron: 0, rudder: 0,
      flaps: o.flaps || 0,
      gearPos: o.gearDown === false && spec.retractableGear ? 0 : 1, // 1 = down & locked
      brake: 0,
      gust: V.make(),
      wingDropSign: 0,
      // derived each step
      alpha: 0, beta: 0, airspeed: o.speed, stall: 0, stallWarning: false, stalled: false,
      gLoad: 1, accel: V.make(), onGround: o.onGround, wheelContacts: 0,
      damage: 0, crashed: false, crashReason: '', time: 0, fuel: spec.fuelCapacity || 0,
      dragPower: 0, rpm: 0, lastSink: 0, scraping: false,
    };
    if (o.onGround) state.pos.y = o.y;
    return state;
  }

  // Scratch vectors reused by step() to avoid garbage.
  const S = {
    vAir: V.make(), vb: V.make(), d: V.make(), liftDir: V.make(), Fb: V.make(), Fw: V.make(),
    force: V.make(), torqueB: V.make(), r: V.make(), P: V.make(), wWorld: V.make(), vp: V.make(),
    tmp: V.make(), tmp2: V.make(), fwd: V.make(), right: V.make(), up: V.make(), gF: V.make(),
    lat: V.make(), contactF: V.make(), Iw: V.make(), wxIw: V.make(), coeffs: {}, wind: V.make(),
  };

  /**
   * Advance the aircraft by one fixed timestep.
   * controls: { elevator, aileron, rudder (−1..1), throttle (0..1), flaps (0..1), gearDown, brake, boost }
   * env:      { groundY(x,z), surface(x,z), wind {x,y,z}, turbulence 0..1, rng(), collide?(x,y,z) }
   * Returns an array of events: {type:'touchdown'|'hardLanding'|'crash'|'liftoff'|'stall', ...}.
   */
  function step(state, spec, controls, env, dt) {
    const events = [];
    if (state.crashed) return events;
    const cfg = CONFIG, s = state;
    s.time += dt;
    V.copy(s.prevPos, s.pos); Q.copy(s.prevQ, s.q);

    // --- 1. Actuators slew toward commanded positions -------------------------
    s.elevator = approach(s.elevator, clamp(controls.elevator, -1, 1), cfg.actuatorRate.elevator * dt);
    s.aileron = approach(s.aileron, clamp(controls.aileron, -1, 1), cfg.actuatorRate.aileron * dt);
    s.rudder = approach(s.rudder, clamp(controls.rudder, -1, 1), cfg.actuatorRate.rudder * dt);
    s.throttle = approach(s.throttle, clamp(controls.throttle, 0, 1), cfg.throttleRate * dt);
    s.flaps = approach(s.flaps, clamp(controls.flaps || 0, 0, 1), cfg.flapRate * dt);
    const wantGear = !spec.retractableGear || controls.gearDown !== false || s.onGround;
    s.gearPos = approach(s.gearPos, wantGear ? 1 : 0, cfg.gearRate * dt);
    s.brake = controls.brake ? 1 : 0;

    // --- 2. Atmosphere and wind (with OU turbulence) ---------------------------
    const rho = airDensity(s.pos.y);
    const turb = clamp(env.turbulence || 0, 0, 1);
    if (turb > 0 && env.rng) {
      const tau = cfg.turbulence.timeConstant, sigma = turb * cfg.turbulence.maxGust;
      const k = sigma * Math.sqrt((2 * dt) / tau);
      s.gust.x += (-s.gust.x / tau) * dt + k * gaussian(env.rng);
      s.gust.y += (-s.gust.y / tau) * dt + 0.6 * k * gaussian(env.rng);
      s.gust.z += (-s.gust.z / tau) * dt + k * gaussian(env.rng);
    } else {
      V.scale(s.gust, s.gust, Math.max(0, 1 - dt));
    }
    const wind = S.wind;
    V.add(wind, env.wind || V.make(), s.gust);

    // --- 3. Airflow in body frame ---------------------------------------------
    V.sub(S.vAir, s.vel, wind);
    Q.rotateInv(S.vb, s.q, S.vAir);
    const vb = S.vb;
    const V2 = V.dot(vb, vb), Vair = Math.sqrt(V2);
    const u = -vb.z;                                   // forward airspeed component
    const alpha = Vair > 0.5 ? Math.atan2(-vb.y, u) : 0; // angle of attack
    const beta = Vair > 0.5 ? Math.asin(clamp(vb.x / Vair, -1, 1)) : 0; // sideslip, + = air from the right
    const qbar = 0.5 * rho * V2;                       // dynamic pressure ½ρV²
    // Lift, wing drag and pitching moment only see the airflow in the plane of symmetry.
    const qSym = 0.5 * rho * (vb.y * vb.y + vb.z * vb.z);
    // Sideslip derivatives are linear only for small β; saturate them for crosswinds on the ground.
    const betaEff = clamp(beta, -CONFIG.sideslipLimit, CONFIG.sideslipLimit);
    const washV = spec.propWash * s.throttle;
    const qCtrl = qbar + 0.5 * rho * washV * washV;    // propwash keeps tail surfaces alive at low speed
    const c = aeroCoefficients(spec, alpha, s.flaps, s.gearPos, S.coeffs);
    s.alpha = alpha; s.beta = beta; s.airspeed = Vair; s.stall = c.stall;
    const airborneish = !s.onGround || Vair > 15;
    const warn = airborneish && Math.abs(alpha) > c.alphaStall - cfg.stallWarnMargin && Vair > 3;
    if (c.stall > 0.35 && !s.stalled && !s.onGround) events.push({ type: 'stall' });
    s.stalled = c.stall > 0.35 && !s.onGround;
    s.stallWarning = warn || s.stalled;

    // Ground effect: induced drag shrinks when within a wingspan of the surface.
    const waterLevel = env.waterLevel !== undefined ? env.waterLevel : cfg.waterLevel;
    const agl = s.pos.y - Math.max(env.groundY(s.pos.x, s.pos.z, s.pos.y), waterLevel);
    const groundEffect = 1 - cfg.groundEffectStrength * Math.exp(-Math.max(0, agl) / (spec.span * 0.6));
    const CDi = spec.inducedK * c.CL * c.CL * (1 - c.stall);
    const CD = c.CD - CDi * (1 - groundEffect);

    // --- 4. Aerodynamic + thrust forces in body frame --------------------------
    V.set(S.Fb, 0, 0, 0);
    if (Vair > 0.05) {
      V.scale(S.d, vb, 1 / Vair);
      // Lift ⟂ airflow, in the aircraft's plane of symmetry: L̂ = x̂ × d̂.
      V.set(S.liftDir, 0, -S.d.z, S.d.y);
      const ll = Math.hypot(S.liftDir.y, S.liftDir.z);
      if (ll > 1e-4) V.addScaled(S.Fb, S.Fb, S.liftDir, (qSym * spec.wingArea * c.CL) / ll); // L = q̄·S·CL
      V.addScaled(S.Fb, S.Fb, S.d, -qbar * spec.wingArea * CD);                             // D = q̄·S·CD
      S.Fb.x += qbar * spec.wingArea * spec.CYb * betaEff;                                    // side force Y = q̄·S·CYβ·β
      s.dragPower = qbar * spec.wingArea * CD * Vair;
    } else {
      s.dragPower = 0;
    }
    // Custom aircraft carry fuel; stock aircraft (fuelCapacity undefined) never run dry.
    if (spec.fuelCapacity > 0 && !controls.infiniteFuel) s.fuel = Math.max(0, s.fuel - spec.fuelBurn * (0.15 + 0.85 * s.throttle) * dt);
    const outOfFuel = spec.fuelCapacity > 0 && s.fuel <= 0 && !controls.infiniteFuel;
    const thrust = outOfFuel ? 0 : thrustAt(spec, s.throttle, u, rho, controls.boost, s.damage);
    S.Fb.z -= thrust;

    V.set(S.force, 0, 0, 0);
    Q.rotate(S.Fw, s.q, S.Fb);
    V.add(S.force, S.force, S.Fw);
    S.force.y -= spec.mass * cfg.gravity;

    // --- 5. Aerodynamic moments (body frame) ----------------------------------
    const b = spec.span, ch = spec.chord, Sw = spec.wingArea;
    const pitchRate = s.w.x, yawRateR = -s.w.y, rollRateR = -s.w.z;
    const dampQ = 0.25 * rho * Vair * Sw;              // ½ρV·S·(l/2) — rate-damping prefactor
    const st = c.stall;
    // Pitch: M = q̄·S·c·Cm(α) + q̄c·S·c·Cmδe·δe + ¼ρV·S·c²·Cmq·q
    const pitchM = qSym * Sw * ch * c.Cm + qCtrl * Sw * ch * spec.Cmde * s.elevator + dampQ * ch * ch * spec.Cmq * pitchRate;
    // Roll (+right): aileron, dihedral effect Clβ, roll damping (reverses when stalled → autorotation), yaw coupling.
    // Autorotation only exists with forward flow and saturates at large helix angles.
    const helix = Vair > 1 ? Math.abs(rollRateR) * b / (2 * Vair) : 0;
    const autorot = cfg.stallAutorotation * st * Math.max(0, Math.cos(alpha)) * Math.max(0, 1 - helix / cfg.autorotationHelixLimit);
    const Clp = spec.Clp * (1 - autorot);
    const Clr = spec.Clr + cfg.stallYawRollCoupling * st;
    if (st > 0.5 && s.wingDropSign === 0 && !s.onGround && env.rng) s.wingDropSign = env.rng() < 0.5 ? -1 : 1;
    if (st < 0.2) s.wingDropSign = 0;
    const rollM = qCtrl * Sw * b * spec.Clda * s.aileron * (1 - cfg.aileronStallLoss * st) +
      qbar * Sw * b * (spec.Clb * betaEff + s.wingDropSign * spec.wingDrop * st) +
      dampQ * b * b * (Clp * rollRateR + Clr * yawRateR);
    // Yaw (+right): rudder, weathervane Cnβ, adverse aileron yaw, damping.
    const Cnr = spec.Cnr * (1 - cfg.stallYawDampingLoss * st);
    const yawM = qCtrl * Sw * b * spec.Cndr * s.rudder +
      qbar * Sw * b * (spec.Cnb * betaEff + spec.Cnda * s.aileron) +
      dampQ * b * b * (Cnr * yawRateR + spec.Cnp * rollRateR);
    V.set(S.torqueB, pitchM, -yawM, -rollM);

    // --- 6. Ground / hull contacts --------------------------------------------
    const contactEvents = resolveContacts(s, spec, env, controls, S.force, S.torqueB);
    for (const e of contactEvents) events.push(e);
    // env.collide may return a reason string (e.g. 'hazard') or just true.
    const hit = env.collide && !s.crashed ? env.collide(s.pos.x, s.pos.y, s.pos.z) : false;
    if (hit) crash(s, typeof hit === 'string' ? hit : 'obstacle', events);
    if (s.crashed) return events;

    // --- 7. Integrate (semi-implicit Euler) -----------------------------------
    const I = spec.inertia;
    // Euler's rigid-body equation: I·ω̇ = τ − ω × (I·ω)
    V.set(S.Iw, I.pitch * s.w.x, I.yaw * s.w.y, I.roll * s.w.z);
    V.cross(S.wxIw, s.w, S.Iw);
    const baseD = cfg.angularDampingBase;
    s.w.x += ((S.torqueB.x - S.wxIw.x) / I.pitch - baseD * s.w.x) * dt;
    s.w.y += ((S.torqueB.y - S.wxIw.y) / I.yaw - baseD * s.w.y) * dt;
    s.w.z += ((S.torqueB.z - S.wxIw.z) / I.roll - baseD * s.w.z) * dt;
    const wMag = V.len(s.w);
    if (wMag > cfg.maxAngularRate) V.scale(s.w, s.w, cfg.maxAngularRate / wMag);
    // Quaternion kinematics with body rates: q̇ = ½·q ⊗ (ω, 0)
    const qw = { x: s.w.x, y: s.w.y, z: s.w.z, w: 0 };
    const dq = Q.mul(Q.make(), s.q, qw);
    s.q.x += 0.5 * dq.x * dt; s.q.y += 0.5 * dq.y * dt; s.q.z += 0.5 * dq.z * dt; s.q.w += 0.5 * dq.w * dt;
    Q.normalize(s.q);

    V.scale(s.accel, S.force, 1 / spec.mass);
    V.addScaled(s.vel, s.vel, s.accel, dt);
    V.addScaled(s.pos, s.pos, s.vel, dt);

    // Load factor: specific force (a − g) projected on body up.
    Q.rotate(S.up, s.q, AXIS_Y);
    V.set(S.gF, s.accel.x, s.accel.y + cfg.gravity, s.accel.z);
    s.gLoad = V.dot(S.gF, S.up) / cfg.gravity;
    const gLimit = spec.maxG * spec.durability;
    if (Math.abs(s.gLoad) > gLimit && !s.onGround) s.damage += (Math.abs(s.gLoad) - gLimit) * cfg.damage.overGPerSec * dt;
    if (s.damage >= 1) crash(s, 'structural', events);

    s.rpm = clamp(0.22 + 0.78 * s.throttle + 0.15 * clamp(u / spec.propSpeed, 0, 1), 0, 1.1);
    return events;
  }

  function crash(s, reason, events, point) {
    if (s.crashed) return;
    s.crashed = true; s.crashReason = reason;
    events.push({ type: 'crash', reason, point: point || null, speed: V.len(s.vel) });
  }

  /** Spring-damper wheels plus hull strike points. Adds into force (world) / torque (body). */
  function resolveContacts(s, spec, env, controls, force, torqueB) {
    const cfg = CONFIG, g = cfg.ground, events = [];
    const kSpring = g.springPerKg * spec.mass, cDamp = g.damperPerKg * spec.mass;
    Q.rotate(S.wWorld, s.q, s.w);
    Q.rotate(S.fwd, s.q, AXIS_FWD);
    const wasOnGround = s.onGround;
    let wheelContacts = 0, maxSink = 0;
    s.scraping = false;

    const gearActive = s.gearPos > 0.6 && spec.gearPoints.length > 0;
    const waterLevel = env.waterLevel !== undefined ? env.waterLevel : cfg.waterLevel;
    const floats = spec.gearType === 'floats';
    const roll = Math.atan2(-Q.rotate(S.tmp, s.q, AXIS_X).y, Q.rotate(S.tmp2, s.q, AXIS_Y).y);

    const contact = (pBody, isWheel, isMain, isNose, soft, name) => {
      Q.rotate(S.r, s.q, pBody);
      V.add(S.P, s.pos, S.r);
      const terrainY = env.groundY(S.P.x, S.P.z, S.P.y);
      const water = terrainY < waterLevel;
      const surfY = water ? waterLevel : terrainY;
      const pen = surfY - S.P.y;
      if (pen <= 0) return false;
      V.cross(S.vp, S.wWorld, S.r);
      V.add(S.vp, S.vp, s.vel);                         // velocity of the contact point
      const contactSpeed = V.len(S.vp);
      // Floats turn water into a landing surface; anything else ditches.
      if (water && !(floats && isWheel) && contactSpeed > cfg.landing.waterCrashSpeed) { crash(s, 'water', events, name); return true; }
      if (pen > g.maxPenetration && contactSpeed > 4) { crash(s, isWheel ? 'impact' : 'terrain', events, name); return true; }
      if (!isWheel && !soft && contactSpeed > cfg.landing.hullCrashSpeed * 0.5) { crash(s, 'terrain', events, name); return true; }
      if (soft && (-S.vp.y > cfg.landing.crashVS || contactSpeed > 70)) { crash(s, 'belly', events, name); return true; }

      const surface = water ? 'water' : (env.surface ? env.surface(S.P.x, S.P.z) : 'runway');
      const N = Math.max(0, kSpring * pen - cDamp * S.vp.y);   // normal force (spring-damper)
      // Rolling direction: forward projected onto the ground plane; nose wheel steers with rudder.
      V.set(S.tmp, S.fwd.x, 0, S.fwd.z);
      V.normalize(S.tmp, S.tmp);
      if (isNose) {
        const fade = 1 / (1 + Math.pow(s.airspeed / g.steerFadeSpeed, 2));
        const a = -s.rudder * g.steerAngle * fade;     // rudder right → steer right
        const cs = Math.cos(a), sn = Math.sin(a);
        V.set(S.tmp, S.tmp.x * cs + S.tmp.z * sn, 0, -S.tmp.x * sn + S.tmp.z * cs);
      }
      V.set(S.lat, -S.tmp.z, 0, S.tmp.x);
      const vLong = V.dot(S.vp, S.tmp), vLat = V.dot(S.vp, S.lat);
      let mu, latMu;
      if (isWheel) {
        const table = spec.gearFriction || g.rollFriction;
        mu = (table[surface] !== undefined ? table[surface] : (g.rollFriction[surface] || 0.08)) + (isMain ? s.brake * g.brakeFriction : 0);
        latMu = g.lateralMu;
      } else {
        mu = g.hullFriction; latMu = g.hullFriction;
        s.scraping = true;
        s.damage += cfg.landing.scrapeDamagePerSec * Math.min(1, contactSpeed / 20) * CONFIG.dt / spec.durability;
      }
      const fLong = -mu * N * Math.tanh(vLong / 0.4);
      const fLat = clamp(-vLat * g.lateralGrip * (spec.mass / 3), -latMu * N, latMu * N);
      V.set(S.contactF, S.tmp.x * fLong + S.lat.x * fLat, N, S.tmp.z * fLong + S.lat.z * fLat);
      V.add(force, force, S.contactF);
      // τ = r × F (world) → body
      V.cross(S.tmp2, S.r, S.contactF);
      Q.rotateInv(S.tmp2, s.q, S.tmp2);
      V.add(torqueB, torqueB, S.tmp2);
      if (isWheel) { wheelContacts++; maxSink = Math.max(maxSink, -S.vp.y); }
      return true;
    };

    if (gearActive) {
      for (const gp of spec.gearPoints) {
        contact(gp.p, true, gp.main, gp.name === 'nose', false, gp.name);
        if (s.crashed) return events;
      }
    }
    for (const hp of spec.hullPoints) {
      if (hp.name === 'belly' && gearActive) continue;
      contact(hp.p, false, false, false, hp.soft, hp.name);
      if (s.crashed) return events;
    }

    s.wheelContacts = wheelContacts;
    s.onGround = wheelContacts > 0;
    if (s.onGround && !wasOnGround) {
      const durability = spec.durability;
      s.lastSink = maxSink;
      if (maxSink > cfg.landing.crashVS * durability) crash(s, 'hardLanding', events);
      else if (Math.abs(roll) > cfg.landing.maxRoll) crash(s, 'wingStrike', events);
      else {
        let quality = 'smooth';
        if (maxSink > cfg.landing.hardVS * durability) {
          s.damage += cfg.damage.hardLanding / durability;
          quality = 'hard';
          events.push({ type: 'hardLanding', sink: maxSink });
        }
        events.push({ type: 'touchdown', sink: maxSink, quality, speed: s.airspeed });
      }
    } else if (!s.onGround && wasOnGround) {
      events.push({ type: 'liftoff', speed: s.airspeed });
    }
    return events;
  }

  /** Approximate standard normal from a uniform rng (Irwin–Hall, 4 samples). */
  function gaussian(rng) { return (rng() + rng() + rng() + rng() - 2) * 1.732; }

  // ---------------------------------------------------------------------------
  // Telemetry & trim
  // ---------------------------------------------------------------------------
  function getTelemetry(state, out) {
    const t = out || {};
    const f = Q.rotate(V.make(), state.q, AXIS_FWD);
    const r = Q.rotate(V.make(), state.q, AXIS_X);
    const up = Q.rotate(V.make(), state.q, AXIS_Y);
    t.pitch = Math.asin(clamp(f.y, -1, 1));
    t.roll = Math.atan2(-r.y, up.y);
    let hdg = Math.atan2(f.x, -f.z);                  // 0 = north, + = clockwise
    if (hdg < 0) hdg += Math.PI * 2;
    t.heading = hdg;
    t.airspeed = state.airspeed;
    t.groundSpeed = Math.hypot(state.vel.x, state.vel.z);
    t.altitude = state.pos.y;
    t.verticalSpeed = state.vel.y;
    t.alpha = state.alpha;
    t.gLoad = state.gLoad;
    t.throttle = state.throttle;
    t.forward = f; t.right = r; t.up = up;
    return t;
  }

  /**
   * Solve for steady level flight at `speed`: returns { alpha, elevator, throttle }.
   * Vertical: L + T·sinα = W.  Horizontal: T·cosα = D.  Moment: Cm(α) + Cmδe·δe·(q̄c/q̄) = 0.
   */
  function computeTrim(spec, speed, altitude) {
    const rho = airDensity(altitude || 0);
    const qbar = 0.5 * rho * speed * speed;
    const c = {};
    let alpha = 0.05, throttle = 0.5, thrust = 0;
    for (let i = 0; i < 60; i++) {
      const CLreq = (spec.weight - thrust * Math.sin(alpha)) / (qbar * spec.wingArea);
      alpha = (CLreq - spec.CL0) / spec.CLa;
      aeroCoefficients(spec, alpha, 0, 1, c);
      const drag = qbar * spec.wingArea * c.CD;
      thrust = drag / Math.cos(alpha);
      const unit = thrustAt(spec, 1, speed * Math.cos(alpha), rho, 1, 0);
      throttle = unit > 0 ? thrust / unit : 1;
    }
    const washV = spec.propWash * throttle;
    const qCtrl = qbar + 0.5 * rho * washV * washV;
    const elevator = -(qbar * c.Cm) / (qCtrl * spec.Cmde);
    return { alpha, elevator, throttle, stalled: c.stall > 0.01, feasible: throttle <= 1 && c.stall < 0.01 };
  }

  // ---------------------------------------------------------------------------
  // Built aircraft: aggregate resolved parts (AV.Parts.resolveDesign) into a spec
  // with the same fields as CONFIG.aircraft, then run it through deriveSpec().
  // ---------------------------------------------------------------------------
  function buildSpecFromDesign(resolved, upgrades, name) {
    const B = CONFIG.builder;
    const recs = resolved.list.filter((r) => !r.floating);
    // Mass and centre of gravity (body origin = CG, like the stock aircraft).
    let M = 0;
    const cg = [0, 0, 0];
    for (const r of recs) { M += r.mass; for (let k = 0; k < 3; k++) cg[k] += r.mass * r.center[k]; }
    if (M < 1) M = 1;
    for (let k = 0; k < 3; k++) cg[k] /= M;
    const rel = (p) => [p[0] - cg[0], p[1] - cg[1], p[2] - cg[2]];
    // Inertia: point masses at part centres plus each part's own box inertia.
    let Ip = 0, Iy = 0, Ir = 0;
    for (const r of recs) {
      const d = rel(r.center), e = r.size, m = r.mass;
      Ip += m * (d[1] * d[1] + d[2] * d[2]) + m * (e[1] * e[1] + e[2] * e[2]) / 12;
      Iy += m * (d[0] * d[0] + d[2] * d[2]) + m * (e[0] * e[0] + e[2] * e[2]) / 12;
      Ir += m * (d[0] * d[0] + d[1] * d[1]) + m * (e[0] * e[0] + e[1] * e[1]) / 12;
    }
    // Lifting and control surfaces. h = how horizontal (lift), v = how vertical (fin),
    // both scaled by how well the chord lines up with the airflow.
    let S = 0, npNum = 0, npDen = 0, xMin = 0, xMax = 0, sweepW = 0, cl0W = 0, stallW = 0, oswW = 0, flapW = 0;
    let VhNum = 0, elevNum = 0, elevonNum = 0, ailNum = 0, VvNum = 0, rudNum = 0, Sv = 0;
    for (const r of recs) for (const sf of r.surfaces) {
      const align = Math.abs(sf.chord[2]);
      const h = Math.abs(sf.normal[1]) * align, v = Math.abs(sf.normal[0]) * align;
      const d = rel(sf.center);
      if (sf.kind === 'wing') {
        const a = sf.area * h;
        S += a; npNum += a * d[2]; npDen += a;
        if (a > 0.1) { xMin = Math.min(xMin, sf.tip[0] - cg[0]); xMax = Math.max(xMax, sf.tip[0] - cg[0]); }
        sweepW += a * sf.aero.sweep; cl0W += a * sf.aero.CL0; stallW += a * sf.aero.alphaStall; oswW += a * sf.aero.oswald; flapW += a * sf.aero.flapCL;
        ailNum += a * sf.ctrlFrac * Math.abs(d[0]);
        if (sf.control === 'elevon') elevonNum += a * sf.ctrlFrac;
        Sv += sf.area * v; VvNum += sf.area * v * d[2];
      } else {
        const a = sf.area * h;
        npNum += a * B.tailDownwash * d[2]; npDen += a * B.tailDownwash;
        VhNum += a * d[2];
        if (sf.control === 'elevator' || sf.control === 'ruddervator') elevNum += a * sf.ctrlFrac * d[2];
        const av = sf.area * v;
        Sv += av; VvNum += av * d[2];
        if (sf.control === 'rudder' || sf.control === 'ruddervator') rudNum += av * sf.ctrlFrac * d[2];
      }
    }
    const wingArea = Math.max(B.minWingArea, S);
    const span = Math.max(1.5, xMax - xMin);
    const AR = (span * span) / wingArea;
    const wsum = Math.max(1e-6, S);
    const sweep = S > 0 ? sweepW / wsum : 0;
    const cbar = wingArea / span;
    // Helmbold lift-curve slope for a finite (swept) wing.
    const CLa = (2 * Math.PI * AR) / (2 + Math.sqrt(4 + AR * AR * (1 + Math.tan(sweep) ** 2)));
    // Static margin: distance from CG to neutral point in mean chords (+ = stable).
    const zNp = npDen > 0 ? npNum / npDen : 0;
    const staticMargin = zNp / cbar;
    const Vh = VhNum / (wingArea * cbar);
    const Vv = VvNum / (wingArea * span);
    // Propulsion: only thrust along the flight direction counts.
    let thrust = 0, propSpeedW = 0, washW = 0, burn = 0;
    const engines = [];
    for (const r of recs) for (const e of r.engines) {
      const t = e.thrust * Math.max(0, -e.fwd[2]);
      thrust += t; propSpeedW += t * e.propSpeed; washW += t * (e.kind === 'prop' ? 18 : 4); burn += e.burn;
      engines.push({ pos: rel(e.pos), rear: rel(e.rear), kind: e.kind });
    }
    let dragArea = 0, oswaldBonus = 0, fuel = 0;
    for (const r of recs) { dragArea += r.drag; oswaldBonus += r.def.oswaldBonus || 0; fuel += r.fuel; }
    // Landing gear contact points (first gear part wins).
    const gearRec = recs.find((r) => r.contacts);
    const gear = gearRec ? { nose: rel(gearRec.contacts.nose), mainL: rel(gearRec.contacts.mainL), mainR: rel(gearRec.contacts.mainR) } : null;
    // Hull strike points from the overall bounding box.
    const box = { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] };
    let bellyY = Infinity;
    for (const r of recs) {
      for (let k = 0; k < 3; k++) { box.min[k] = Math.min(box.min[k], r.aabb.min[k]); box.max[k] = Math.max(box.max[k], r.aabb.max[k]); }
      if (r.def.category === 'fuselage') bellyY = Math.min(bellyY, r.aabb.min[1]);
    }
    if (!recs.length) { box.min = [-1, -1, -1]; box.max = [1, 1, 1]; }
    if (!Number.isFinite(bellyY)) bellyY = box.min[1];
    const c = (p) => rel(p);
    const hull = {
      nose: c([cg[0], cg[1], box.min[2]]), tail: c([cg[0], cg[1] + 0.2, box.max[2]]),
      wingL: c([box.min[0], cg[1], cg[2]]), wingR: c([box.max[0], cg[1], cg[2]]),
      top: c([cg[0], box.max[1], cg[2]]), belly: c([cg[0], bellyY, cg[2]]),
    };
    const gearType = gearRec ? gearRec.contacts.type : 'none';
    const spec = {
      id: 'custom', name: name || 'Custom aircraft', role: 'Built in the Plane Builder', custom: true,
      mass: M, wingArea, span, chord: cbar,
      inertia: { pitch: Math.max(200, Ip), yaw: Math.max(300, Iy), roll: Math.max(150, Ir) },
      CL0: S > 0 ? cl0W / wsum : 0.1, CLa, alphaStall: S > 0 ? stallW / wsum : 0.25,
      CD0: Math.max(0.012, dragArea / wingArea + B.skinDrag), oswald: Math.min(0.95, (S > 0 ? oswW / wsum : 0.7) + oswaldBonus),
      CYb: -(0.35 + 2.5 * Sv / wingArea),
      Cma: clamp(-CLa * staticMargin, B.cmaLimits[0], B.cmaLimits[1]),
      Cmq: Math.min(-3, -(B.cmqBase + B.cmqVolume * Math.max(0, Vh))),
      Cmde: Math.max(0.05, B.elevatorGain * Math.max(0, elevNum) / (wingArea * cbar) + B.elevonGain * elevonNum * (cbar * 0.6) / (wingArea * cbar)),
      Clda: Math.max(0.01, B.aileronGain * ailNum / (wingArea * span / 2)),
      Clp: -(0.3 + 0.02 * Math.min(AR, 12)), Clb: -(0.05 + 0.12 * Math.sin(sweep)), Clr: 0.1,
      Cnb: clamp(B.cnbBase + B.cnbVolume * Vv, -0.05, 0.3), Cnr: -(B.cnrBase + B.cnrVolume * Math.max(0, Vv)),
      Cndr: Math.max(0.005, B.rudderGain * Math.max(0, rudNum) / (wingArea * span)), Cnda: -0.008, Cnp: -0.03,
      thrustStatic: thrust, propSpeed: thrust > 0 ? propSpeedW / thrust : 100, propWash: thrust > 0 ? washW / thrust : 0,
      flapCL: S > 0 ? flapW / wsum : 0, flapCD: 0.03, flapStallShift: -0.03,
      gearCD: gearRec ? gearRec.contacts.drag / wingArea : 0,
      maxG: clamp(8.5 - 0.3 * AR, 4, 9), durability: 1, wingDrop: 0.012,
      retractableGear: !!(gearRec && gearRec.contacts.retractable), gearType, gearFriction: B.gearFriction[gearType] || null,
      maxRPM: 2600, gear, hull, cruiseSpeed: 40,
      fuelCapacity: fuel, fuelBurn: burn, engines,
      design: {
        cg, staticMargin, neutralPoint: zNp + cg[2], tailVolume: Vh, finVolume: Vv, aspectRatio: AR, parts: recs.length,
        foreMostHeavy: heaviestBy(recs, (r) => -r.center[2]), aftMostHeavy: heaviestBy(recs, (r) => r.center[2]),
        lateralHeavy: heaviestBy(recs, (r) => Math.sign(cg[0]) * r.center[0]),
      },
    };
    applyUpgrades(spec, upgrades);
    // Cruise depends on the airframe: 1.6 × stall speed, but below 85 % of top speed.
    spec.cruiseSpeed = 40;
    deriveSpec(spec);
    const vmax = maxLevelSpeed(spec);
    spec.cruiseSpeed = clamp(Math.min(spec.stallSpeed * 1.6, vmax > 0 ? vmax * 0.85 : spec.stallSpeed * 1.6), spec.stallSpeed * 1.2, 250);
    deriveSpec(spec);
    return spec;
  }

  function heaviestBy(recs, score) {
    let best = null, bs = -Infinity;
    for (const r of recs) { const v = score(r) * r.mass; if (v > bs) { bs = v; best = r.uid; } }
    return best;
  }

  /** Highest speed where full-throttle thrust still beats level-flight drag (0 if it cannot fly level). */
  function maxLevelSpeed(spec) {
    const rho = CONFIG.seaLevelDensity, c = {};
    const gearDown = spec.retractableGear ? 0 : 1;
    let vmax = 0;
    for (let v = spec.stallSpeed * 1.05; v < 400; v += 1) {
      const q = 0.5 * rho * v * v;
      const CL = spec.weight / (q * spec.wingArea);
      aeroCoefficients(spec, (CL - spec.CL0) / spec.CLa, 0, gearDown, c);
      if (c.stall > 0.01) continue;
      if (thrustAt(spec, 1, v, rho, 1, 0) >= q * spec.wingArea * c.CD) vmax = v;
      else if (vmax > 0) break;
    }
    return vmax;
  }

  /** Builder stats computed with the same flight model: speeds m/s, range m, turn rate deg/s. */
  function estimatePerformance(spec) {
    const vmax = maxLevelSpeed(spec);
    const trim = vmax > 0 ? computeTrim(spec, spec.cruiseSpeed, 500) : null;
    const burn = spec.fuelBurn * (CONFIG.builder.internalFuelBurnFloor + (1 - CONFIG.builder.internalFuelBurnFloor) * clamp(trim ? trim.throttle : 1, 0, 1));
    const endurance = burn > 0 ? (spec.fuelCapacity || 0) / burn : 0;
    // Instantaneous turn at cruise, limited by usable lift and structural G.
    const q = 0.5 * CONFIG.seaLevelDensity * spec.cruiseSpeed * spec.cruiseSpeed;
    const n = Math.min(spec.maxG, (q * spec.wingArea * spec.CLmax * 0.9) / spec.weight);
    const turnRate = n > 1 ? (CONFIG.gravity * Math.sqrt(n * n - 1) / spec.cruiseSpeed) * 57.2958 : 0;
    return {
      mass: spec.mass, thrustToWeight: spec.thrustStatic / spec.weight, stallSpeed: spec.stallSpeed,
      maxSpeed: vmax, cruiseSpeed: spec.cruiseSpeed, range: vmax > 0 ? endurance * spec.cruiseSpeed : 0,
      endurance, turnRate, canFly: vmax > 0, fuel: spec.fuelCapacity || 0,
    };
  }

  // ---------------------------------------------------------------------------
  // Pilot assists (pure): turn raw stick input into surface commands.
  // ---------------------------------------------------------------------------
  const _tel = {};
  function applyAssist(state, spec, input, level) {
    const out = { elevator: input.pitch || 0, aileron: input.roll || 0, rudder: input.yaw || 0 };
    const a = CONFIG.assist[level];
    if (level === 'off' || !a) return out;
    if (state.onGround) {
      // On the ground the assist does what a pilot would in a crosswind: nose-wheel steering
      // damps yaw (no weathervaning) and aileron is held into the wind to keep the wings level.
      // No auto-trim here, so the wings unload onto the wheels during the rollout.
      getTelemetry(state, _tel);
      out.rudder = clamp(out.rudder + state.w.y * a.groundYawDamp, -1, 1);
      out.aileron = clamp(out.aileron - _tel.roll * a.groundWingLevel + state.w.z * 0.4, -1, 1);
      return out;
    }
    getTelemetry(state, _tel);
    const V = Math.max(state.airspeed, spec.stallSpeed * 0.9);
    // Auto-trim: blend in the elevator that would hold level flight at this speed.
    const trim = computeTrimElevatorFast(spec, V, state.pos.y);
    if (level === 'heavy') {
      // Stick commands pitch rate instead of raw deflection.
      const want = (input.pitch || 0) * a.pitchRateCmd;
      out.elevator = trim * a.autoTrim * Math.cos(_tel.roll) + (want - state.w.x) * a.pitchRateGain;
      // Wing leveller and bank limit.
      if (Math.abs(input.roll || 0) < a.wingLevelDeadzone) out.aileron = -_tel.roll * a.wingLevelGain + state.w.z * a.rollRateDamp;
      else if (Math.abs(_tel.roll) > a.bankLimit && Math.sign(input.roll) === Math.sign(_tel.roll)) out.aileron = -Math.sign(_tel.roll) * 0.3;
    } else {
      out.elevator += trim * a.autoTrim * (1 - Math.abs(input.pitch || 0));
    }
    // Turn coordination: rudder kills sideslip (β > 0 means slipping right → right rudder).
    if (!state.onGround) out.rudder += state.beta * a.coordination;
    // Stall guard: wash out nose-up elevator as AoA approaches critical.
    const crit = spec.alphaStall + spec.flapStallShift * state.flaps - a.stallGuardMargin;
    if (!state.onGround && state.alpha > crit - 0.06 && out.elevator > 0) {
      const over = clamp((state.alpha - (crit - 0.06)) / 0.06, 0, 1);
      out.elevator = out.elevator * (1 - a.stallGuard * over) - a.stallGuard * over * 0.25;
    }
    out.elevator = clamp(out.elevator, -1, 1); out.aileron = clamp(out.aileron, -1, 1); out.rudder = clamp(out.rudder, -1, 1);
    return out;
  }

  /** Cheap level-flight elevator (moment balance only) used every step by the assists. */
  function computeTrimElevatorFast(spec, speed, altitude) {
    const rho = airDensity(altitude);
    const qbar = 0.5 * rho * speed * speed;
    const CL = clamp(spec.weight / (qbar * spec.wingArea), -spec.CLmax, spec.CLmax);
    const alpha = (CL - spec.CL0) / spec.CLa;
    const Cm = spec.Cm0 + spec.Cma * Math.sin(alpha);
    return clamp(-Cm / spec.Cmde, -1, 1);
  }

  // ---------------------------------------------------------------------------
  // Fixed-timestep simulator with accumulator and render interpolation.
  // ---------------------------------------------------------------------------
  class Simulator {
    constructor(spec, state) {
      this.spec = spec;
      this.state = state;
      this.accumulator = 0;
      this.alpha = 0;
      this.paused = false;
    }
    /** Run as many fixed steps as fit into frameDt. `controlsFn(state)` is called per step. */
    advance(frameDt, controlsFn, env) {
      const events = [];
      if (this.paused) return events;
      const dt = CONFIG.dt;
      this.accumulator += Math.min(frameDt, 0.25);
      let n = 0;
      while (this.accumulator >= dt && n < CONFIG.maxStepsPerFrame) {
        const ev = step(this.state, this.spec, controlsFn(this.state, dt), env, dt);
        for (let i = 0; i < ev.length; i++) events.push(ev[i]);
        this.accumulator -= dt;
        n++;
      }
      if (n === CONFIG.maxStepsPerFrame) this.accumulator = 0;
      this.alpha = this.accumulator / dt;
      return events;
    }
    /** Interpolated pose between the last two physics states. */
    pose(outPos, outQ) {
      const s = this.state;
      if (s.crashed) { V.copy(outPos, s.pos); Q.copy(outQ, s.q); return; }
      V.lerp(outPos, s.prevPos, s.pos, this.alpha);
      Q.slerp(outQ, s.prevQ, s.q, this.alpha);
    }
  }

  // ---------------------------------------------------------------------------
  // Self-checks — run AV.Physics.selfTest() in the console.
  // ---------------------------------------------------------------------------
  function flatEnv(groundY) {
    let seed = 12345;
    return {
      groundY: () => groundY,
      surface: () => 'runway',
      wind: V.make(), turbulence: 0,
      rng: () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; },
    };
  }
  const fixedControls = (c) => () => c;

  function runFor(sim, seconds, controlsFn, env, perStep) {
    const n = Math.round(seconds / CONFIG.dt);
    for (let i = 0; i < n; i++) {
      step(sim.state, sim.spec, controlsFn(sim.state), env, CONFIG.dt);
      if (perStep) perStep(sim.state);
      if (sim.state.crashed) break;
    }
  }

  function testLevelFlight(id) {
    const spec = buildSpec(id);
    const V0 = spec.cruiseSpeed, h0 = 800;
    const trim = computeTrim(spec, V0, h0);
    const st = createState(spec, { y: h0, pitch: trim.alpha, speed: 0 });
    V.set(st.vel, 0, 0, -(V0 + 1.5));           // small disturbance: must stay near trimmed altitude
    st.elevator = trim.elevator; st.throttle = trim.throttle;
    const sim = { spec, state: st };
    runFor(sim, 20, fixedControls({ elevator: trim.elevator, aileron: 0, rudder: 0, throttle: trim.throttle }), flatEnv(-1000));
    const dh = st.pos.y - h0, dv = st.airspeed - V0;
    return { name: `level flight holds altitude (${id})`, pass: Math.abs(dh) < 20 && Math.abs(dv) < 4 && !st.crashed,
      detail: `cruise ${V0} m/s (+1.5 m/s disturbance), throttle ${(trim.throttle * 100).toFixed(0)}%, Δalt ${dh.toFixed(2)} m, Δspeed ${dv.toFixed(2)} m/s after 20 s` };
  }

  function testStall(id) {
    const spec = buildSpec(id);
    const c = {};
    const clAtCrit = aeroCoefficients(spec, spec.alphaStall, 0, 1, c).CL;
    const clPast = aeroCoefficients(spec, spec.alphaStall + 0.2, 0, 1, c).CL;
    // Slow aircraft, idle, full back stick: must stall.
    const slow = createState(spec, { y: 1500, pitch: 0.12, speed: spec.stallSpeed * 0.8 });
    const simA = { spec, state: slow };
    let stalledSlow = false, maxAlpha = 0;
    runFor(simA, 4, fixedControls({ elevator: 1, aileron: 0, rudder: 0, throttle: 0 }), flatEnv(-1000), (s) => {
      if (s.stalled) stalledSlow = true; maxAlpha = Math.max(maxAlpha, s.alpha);
    });
    // Comfortably above stall speed and trimmed: must not stall.
    const Vfast = spec.stallSpeed * 1.5;
    const trim = computeTrim(spec, Vfast, 1500);
    const fast = createState(spec, { y: 1500, pitch: trim.alpha, speed: 0 });
    V.set(fast.vel, 0, 0, -Vfast); fast.elevator = trim.elevator; fast.throttle = trim.throttle;
    let stalledFast = false;
    runFor({ spec, state: fast }, 6, fixedControls({ elevator: trim.elevator, aileron: 0, rudder: 0, throttle: trim.throttle }), flatEnv(-1000), (s) => {
      if (s.stalled) stalledFast = true;
    });
    return { name: `stall below critical speed (${id})`, pass: stalledSlow && !stalledFast && clPast < clAtCrit * 0.75,
      detail: `Vs=${spec.stallSpeed.toFixed(1)} m/s; at 0.8·Vs stalled=${stalledSlow} (max α ${(maxAlpha * 57.3).toFixed(1)}°); at 1.5·Vs stalled=${stalledFast}; CL ${clAtCrit.toFixed(2)} → ${clPast.toFixed(2)} past critical` };
  }

  function testGlideEnergy(id) {
    const spec = buildSpec(id);
    const energy = (s) => 0.5 * spec.mass * V.dot(s.vel, s.vel) + spec.mass * CONFIG.gravity * s.pos.y;
    // (a) Drag-free airframe: lift is ⟂ to velocity, so mechanical energy must be conserved.
    const ideal = buildSpec(id);
    ideal.CD0 = 0; ideal.inducedK = 0; ideal.flapCD = 0; ideal.gearCD = 0; ideal.CYb = 0;
    const s1 = createState(ideal, { y: 1500, pitch: -0.05, speed: ideal.cruiseSpeed });
    const e1 = energy(s1);
    runFor({ spec: ideal, state: s1 }, 15, fixedControls({ elevator: 0, aileron: 0, rudder: 0, throttle: 0 }), flatEnv(-5000));
    const drift = Math.abs(energy(s1) - e1) / e1;
    // (b) Real glide: energy lost must match the integrated drag work ∫D·V dt.
    const trim = computeTrim(spec, spec.cruiseSpeed, 1500);
    const s2 = createState(spec, { y: 1500, pitch: trim.alpha - 0.08, speed: spec.cruiseSpeed });
    const e2 = energy(s2);
    let dragWork = 0;
    runFor({ spec, state: s2 }, 15, fixedControls({ elevator: trim.elevator, aileron: 0, rudder: 0, throttle: 0 }), flatEnv(-5000),
      (s) => { dragWork += s.dragPower * CONFIG.dt; });
    const lost = e2 - energy(s2);
    const mismatch = Math.abs(lost - dragWork) / Math.max(1, dragWork);
    return { name: `energy conserved in glide (${id})`, pass: drift < 0.01 && mismatch < 0.03,
      detail: `drag-free drift ${(drift * 100).toFixed(3)}%; real glide energy loss vs ∫D·V dt mismatch ${(mismatch * 100).toFixed(2)}%` };
  }

  function testTakeoff(id) {
    const spec = buildSpec(id);
    const st = createState(spec, { y: spec.gearHeight, onGround: true, speed: 0 });
    let liftoffAt = -1, dist = 0;
    const sim = { spec, state: st };
    runFor(sim, 40, (s) => ({ elevator: s.airspeed > spec.stallSpeed * 1.1 ? 0.5 : 0, aileron: 0, rudder: 0, throttle: 1 }), flatEnv(0), (s) => {
      if (liftoffAt < 0 && !s.onGround && s.pos.y > spec.gearHeight + 3) { liftoffAt = s.time; dist = -s.pos.z; }
    });
    return { name: `takeoff run (${id})`, pass: liftoffAt > 0 && dist < 900 && !st.crashed,
      detail: liftoffAt > 0 ? `airborne after ${liftoffAt.toFixed(1)} s / ${dist.toFixed(0)} m` : `never left the ground (crashed=${st.crashed} ${st.crashReason})` };
  }

  function selfTest(opts) {
    const quiet = opts && opts.quiet;
    const results = [];
    for (const id of Object.keys(CONFIG.aircraft)) {
      results.push(testLevelFlight(id), testStall(id), testGlideEnergy(id), testTakeoff(id));
    }
    const passed = results.every((r) => r.pass);
    if (!quiet && typeof console !== 'undefined') {
      console.log(`%cAV.Physics.selfTest: ${passed ? 'ALL PASSED' : 'FAILURES'}`, `font-weight:bold;color:${passed ? '#2a2' : '#c22'}`);
      for (const r of results) console.log(`${r.pass ? '✔' : '✘'} ${r.name} — ${r.detail}`);
    }
    return { passed, results };
  }

  AV.Physics = {
    CONFIG, V, Q, clamp, smoothstep,
    buildSpec, createState, step, applyAssist, computeTrim, getTelemetry, aeroCoefficients, airDensity,
    buildSpecFromDesign, estimatePerformance, Simulator, selfTest,
  };
})(window.AV);
