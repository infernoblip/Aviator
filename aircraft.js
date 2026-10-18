/* aircraft.js — procedural low-poly aircraft, animated parts, and visual effects
 * (particles, vapour trails, speed lines, debris, camera shake).
 *
 * Model space matches the physics body frame: nose toward -Z, up +Y, right wing +X,
 * origin at the centre of gravity. Gear and wingtips are placed from the physics spec,
 * so wheels sit exactly where the simulated contact points are.
 */
window.AV = window.AV || {};
(function (AV) {
  'use strict';

  /** Paint schemes: primary / secondary / accent. Unlock rules live in campaign.js. */
  const PAINTS = {
    classic: { name: 'Classic', primary: 0xf3f0e8, secondary: 0xd2322d, accent: 0x1f3c6e },
    sunset: { name: 'Sunset', primary: 0xff8a3d, secondary: 0x7a2a8c, accent: 0xffd23f },
    arctic: { name: 'Arctic', primary: 0xe9f3ff, secondary: 0x3a8fd9, accent: 0x9ad7ff },
    racing: { name: 'Racing Green', primary: 0x1f5e3a, secondary: 0xf2d16b, accent: 0x111111 },
    stealth: { name: 'Stealth', primary: 0x2f3338, secondary: 0x16181b, accent: 0xd03030 },
    gold: { name: 'Gold Ace', primary: 0xd9a92b, secondary: 0x1b1b1b, accent: 0xfff1b0 },
  };

  /** Per-airframe shape parameters (visual only). */
  const SHAPES = {
    kestrel: { wing: 'high', fuseLen: 7.2, fuseR: 0.78, nose: 1.3, tailLen: 3.6, chord: 1.5, props: 1, blades: 2, canopy: 'cabin', struts: true },
    swift: { wing: 'low', fuseLen: 6.8, fuseR: 0.62, nose: 1.8, tailLen: 3.2, chord: 1.35, props: 1, blades: 3, canopy: 'bubble', struts: false },
    bulldog: { wing: 'bi', fuseLen: 6.6, fuseR: 0.72, nose: 1.2, tailLen: 3.3, chord: 1.3, props: 1, blades: 2, canopy: 'open', struts: true },
    titan: { wing: 'mid', fuseLen: 11, fuseR: 1.0, nose: 2.2, tailLen: 4.8, chord: 1.9, props: 2, blades: 3, canopy: 'glassnose', struts: false },
  };

  const v3 = (x, y, z) => new THREE.Vector3(x, y, z);

  // ---------------------------------------------------------------------------
  // Aircraft model
  // ---------------------------------------------------------------------------
  class AircraftVisual {
    constructor(spec, paintId) {
      this.spec = spec;
      this.shape = SHAPES[spec.id] || SHAPES.kestrel;
      this.group = new THREE.Group();
      this.group.name = 'aircraft';
      this.parts = { props: [], blurs: [], ailL: [], ailR: [], flaps: [], elevators: [], rudders: [], gear: [], wheels: [], navLights: [] };
      this.mats = {
        primary: new THREE.MeshStandardMaterial({ roughness: 0.45, metalness: 0.15, flatShading: true }),
        secondary: new THREE.MeshStandardMaterial({ roughness: 0.45, metalness: 0.15, flatShading: true }),
        accent: new THREE.MeshStandardMaterial({ roughness: 0.4, metalness: 0.3, flatShading: true }),
        metal: new THREE.MeshStandardMaterial({ color: 0x9aa0a8, roughness: 0.35, metalness: 0.7, flatShading: true }),
        dark: new THREE.MeshStandardMaterial({ color: 0x1c1c1e, roughness: 0.9, flatShading: true }),
        glass: new THREE.MeshStandardMaterial({ color: 0x8fc4e8, roughness: 0.05, metalness: 0.4, transparent: true, opacity: 0.55 }),
        blur: new THREE.MeshBasicMaterial({ color: 0xd8dde4, transparent: true, opacity: 0, depthWrite: false, side: THREE.DoubleSide }),
        red: new THREE.MeshBasicMaterial({ color: 0xff2020 }),
        green: new THREE.MeshBasicMaterial({ color: 0x20ff40 }),
        white: new THREE.MeshBasicMaterial({ color: 0xffffff }),
      };
      this.setPaint(paintId || 'classic');
      this.build();
      this.propAngle = 0;
      this.wheelAngle = 0;
      this.blink = 0;
      this.group.traverse((o) => { if (o.isMesh) { o.castShadow = true; } });
    }

    setPaint(id) {
      const p = PAINTS[id] || PAINTS.classic;
      this.paintId = id;
      this.mats.primary.color.set(p.primary);
      this.mats.secondary.color.set(p.secondary);
      this.mats.accent.color.set(p.accent);
    }

    mesh(geo, mat, x, y, z, parent) {
      const m = new THREE.Mesh(geo, mat);
      m.position.set(x || 0, y || 0, z || 0);
      (parent || this.group).add(m);
      return m;
    }

    /** A cylinder lying along Z (nose = -Z) from z0 to z1 with radii r0 → r1. */
    tube(r0, r1, z0, z1, mat, seg, parent, y) {
      const len = Math.abs(z1 - z0);
      const g = new THREE.CylinderGeometry(r1, r0, len, seg || 8);
      g.rotateX(-Math.PI / 2);   // +Y axis → -Z, so radius r0 sits at the front
      return this.mesh(g, mat, 0, y || 0, (z0 + z1) / 2, parent);
    }

    build() {
      const sh = this.shape, sp = this.spec, m = this.mats;
      const half = sp.span / 2;
      const front = -sh.fuseLen * 0.38, rear = sh.fuseLen * 0.62;
      // Fuselage: cowl, cabin, tail cone.
      const cowl = sh.canopy === 'glassnose' ? m.glass : m.accent;
      this.tube(sh.fuseR * 0.55, sh.fuseR, front - sh.nose * 0.6, front, cowl, 10);
      this.tube(sh.fuseR, sh.fuseR, front, front + sh.fuseLen * 0.38, m.primary, 10);
      this.tube(sh.fuseR, sh.fuseR * 0.22, front + sh.fuseLen * 0.38, rear + sh.tailLen * 0.3, m.primary, 10);
      // Stripe band.
      this.tube(sh.fuseR * 1.02, sh.fuseR * 0.9, front + sh.fuseLen * 0.4, front + sh.fuseLen * 0.48, m.secondary, 10);
      this.buildCanopy(front);
      // Wings.
      const wingY = { high: sh.fuseR * 0.95, low: -sh.fuseR * 0.6, mid: -sh.fuseR * 0.1, bi: sh.fuseR * 1.7 }[sh.wing];
      this.wingY = wingY;
      this.buildWing(half, wingY, sh.chord, -0.15, true);
      if (sh.wing === 'bi') {
        this.buildWing(half * 0.92, -sh.fuseR * 0.55, sh.chord * 0.95, 0.15, false);
        for (const s of [-1, 1]) for (const zz of [-0.35, 0.45]) {
          const strut = this.mesh(new THREE.CylinderGeometry(0.05, 0.05, wingY + sh.fuseR * 0.55, 4), m.metal, s * half * 0.72, (wingY - sh.fuseR * 0.55) / 2, zz - 0.1);
          strut.rotation.z = s * 0.05;
        }
        for (const s of [-1, 1]) this.mesh(new THREE.CylinderGeometry(0.05, 0.05, wingY, 4), m.metal, s * 0.6, wingY / 2, -0.4);
      }
      if (sh.struts && sh.wing === 'high') {
        for (const s of [-1, 1]) {
          const st = this.mesh(new THREE.CylinderGeometry(0.05, 0.05, half * 0.62, 4), m.metal, s * half * 0.3, wingY * 0.15, 0);
          st.rotation.z = s * (Math.PI / 2 - 0.42);
        }
      }
      // Tail: stabiliser + elevator, fin + rudder.
      const tailZ = rear + sh.tailLen * 0.15;
      const stabSpan = sp.span * 0.36;
      this.mesh(new THREE.BoxGeometry(stabSpan, 0.1, 0.75), m.primary, 0, 0.1, tailZ);
      const elev = new THREE.Group(); elev.position.set(0, 0.1, tailZ + 0.375); this.group.add(elev);
      this.mesh(new THREE.BoxGeometry(stabSpan * 0.95, 0.07, 0.45), m.secondary, 0, 0, 0.225, elev);
      this.parts.elevators.push(elev);
      const finH = sh.fuseR * 2.1;
      const fin = this.mesh(new THREE.BoxGeometry(0.1, finH, 1.0), m.secondary, 0, finH / 2 + sh.fuseR * 0.3, tailZ - 0.2);
      fin.rotation.x = -0.25;
      const rud = new THREE.Group(); rud.position.set(0, finH / 2 + sh.fuseR * 0.25, tailZ + 0.35); this.group.add(rud);
      this.mesh(new THREE.BoxGeometry(0.08, finH * 0.95, 0.55), m.accent, 0, 0, 0.27, rud);
      this.parts.rudders.push(rud);
      // Engines / propellers.
      if (sh.props === 1) this.buildProp(0, 0, front - sh.nose * 0.6, sh.fuseR);
      else for (const s of [-1, 1]) {
        const x = s * half * 0.36, z = -1.4;
        this.tube(0.45, 0.55, z - 0.6, z + 2.6, m.primary, 8, null, wingY + 0.05).position.x = x;
        this.tube(0.3, 0.45, z - 1.1, z - 0.6, m.accent, 8, null, wingY + 0.05).position.x = x;
        this.buildProp(x, wingY + 0.05, z - 1.1, 0.5);
      }
      this.exhaustPoints = sh.props === 1
        ? [v3(-sh.fuseR * 0.9, -0.2, front + 0.2), v3(sh.fuseR * 0.9, -0.2, front + 0.2)]
        : [v3(-half * 0.36, wingY - 0.2, 1.2), v3(half * 0.36, wingY - 0.2, 1.2)];
      this.buildGear();
      // Wingtip nav lights + vapour trail anchors.
      this.wingtips = [v3(-half, wingY, 0.2), v3(half, wingY, 0.2)];
      const nl = new THREE.SphereGeometry(0.11, 6, 4);
      this.parts.navLights.push(this.mesh(nl, m.red, -half - 0.05, wingY, -0.1), this.mesh(nl, m.green, half + 0.05, wingY, -0.1));
      this.strobe = this.mesh(nl, m.white, 0, finH + sh.fuseR * 0.3, tailZ);
      this.cockpitEye = v3(0, sh.fuseR * 0.75, front + sh.fuseLen * 0.16);
      if (sh.canopy === 'glassnose') this.cockpitEye.set(0, 0.25, front - 0.4);
    }

    buildCanopy(front) {
      const sh = this.shape, m = this.mats;
      const z = front + sh.fuseLen * 0.2;
      if (sh.canopy === 'bubble') {
        const g = new THREE.SphereGeometry(0.55, 10, 6, 0, Math.PI * 2, 0, Math.PI / 2);
        const c = this.mesh(g, m.glass, 0, sh.fuseR * 0.6, z); c.scale.set(1, 0.9, 2.2);
      } else if (sh.canopy === 'cabin') {
        const c = this.mesh(new THREE.BoxGeometry(sh.fuseR * 1.7, 0.75, 1.6), m.glass, 0, sh.fuseR * 0.55, z - 0.1);
        c.rotation.x = 0.08;
      } else if (sh.canopy === 'open') {
        this.mesh(new THREE.BoxGeometry(0.7, 0.3, 0.1), m.glass, 0, sh.fuseR * 0.95, z + 0.2).rotation.x = -0.5;
        this.mesh(new THREE.SphereGeometry(0.28, 8, 6), m.dark, 0, sh.fuseR * 1.05, z + 0.7);  // pilot's helmet
      } else {
        const c = this.mesh(new THREE.BoxGeometry(sh.fuseR * 1.5, 0.6, 1.8), m.glass, 0, sh.fuseR * 0.75, z - 0.6);
        c.rotation.x = 0.12;
      }
    }

    /** Wing with inboard flaps and outboard ailerons on hinge groups. */
    buildWing(half, y, chord, dihedral, primary) {
      const m = this.mats;
      const mainChord = chord * 0.72, ctrlChord = chord * 0.28;
      const hingeZ = -chord * 0.5 + mainChord;
      for (const s of [-1, 1]) {
        const wing = new THREE.Group();
        wing.position.set(0, y, 0);
        wing.rotation.z = s * dihedral * 0.25;
        this.group.add(wing);
        const panel = this.mesh(new THREE.BoxGeometry(half, 0.16, mainChord), m.primary, s * half / 2, 0, -chord * 0.5 + mainChord / 2, wing);
        panel.castShadow = true;
        this.mesh(new THREE.BoxGeometry(half * 0.18, 0.17, mainChord * 0.98), m.secondary, s * half * 0.88, 0, -chord * 0.5 + mainChord / 2, wing);
        // Flap (inboard 45 %) and aileron (outboard 40 %).
        const flap = new THREE.Group(); flap.position.set(s * half * 0.27, 0, hingeZ); wing.add(flap);
        this.mesh(new THREE.BoxGeometry(half * 0.4, 0.1, ctrlChord), m.primary, 0, 0, ctrlChord / 2, flap);
        const ail = new THREE.Group(); ail.position.set(s * half * 0.75, 0, hingeZ); wing.add(ail);
        this.mesh(new THREE.BoxGeometry(half * 0.42, 0.1, ctrlChord), m.accent, 0, 0, ctrlChord / 2, ail);
        if (primary || this.shape.wing === 'bi') {
          (s < 0 ? this.parts.ailL : this.parts.ailR).push(ail);
          if (primary) this.parts.flaps.push(flap);
        }
      }
    }

    buildProp(x, y, z, r) {
      const m = this.mats, sh = this.shape;
      const hub = new THREE.Group();
      hub.position.set(x, y, z);
      this.group.add(hub);
      const spinner = new THREE.ConeGeometry(r * 0.42, r * 0.9, 10);
      spinner.rotateX(-Math.PI / 2);
      this.mesh(spinner, m.accent, 0, 0, -r * 0.4, hub);
      const len = this.spec.id === 'titan' ? 1.5 : 1.0 + r * 0.25;
      for (let i = 0; i < sh.blades; i++) {
        const b = new THREE.Group(); b.rotation.z = (i / sh.blades) * Math.PI * 2; hub.add(b);
        const blade = this.mesh(new THREE.BoxGeometry(0.16, len, 0.04), m.dark, 0, len / 2 + 0.1, 0, b);
        blade.rotation.y = 0.35;
        this.mesh(new THREE.BoxGeometry(0.17, 0.14, 0.05), m.secondary, 0, len + 0.03, 0, b);
      }
      const disc = new THREE.Mesh(new THREE.CircleGeometry(len + 0.15, 24), m.blur);
      disc.position.set(x, y, z + 0.02);
      this.group.add(disc);
      this.parts.props.push(hub);
      this.parts.blurs.push(disc);
    }

    buildGear() {
      const sp = this.spec, m = this.mats;
      const wheelGeo = new THREE.CylinderGeometry(0.32, 0.32, 0.2, 10);
      wheelGeo.rotateZ(Math.PI / 2);
      for (const key of ['nose', 'mainL', 'mainR']) {
        const g = sp.gear[key];
        const attachY = key === 'nose' ? -this.shape.fuseR * 0.5 : Math.min(this.wingY || 0, -this.shape.fuseR * 0.4);
        const leg = new THREE.Group();
        leg.position.set(g[0], attachY, g[2]);
        this.group.add(leg);
        const len = attachY - (g[1] + 0.32);
        this.mesh(new THREE.CylinderGeometry(0.06, 0.07, len, 5), m.metal, 0, -len / 2, 0, leg);
        const wheel = this.mesh(wheelGeo, m.dark, 0, -len, 0, leg);
        if (!sp.retractableGear) this.mesh(new THREE.BoxGeometry(0.3, 0.25, 0.75), m.primary, 0, -len + 0.1, 0, leg); // wheel spat
        this.parts.gear.push({ leg, key, side: key === 'mainL' ? -1 : key === 'mainR' ? 1 : 0 });
        this.parts.wheels.push(wheel);
      }
    }

    /** Animate control surfaces, gear, propeller and lights from the physics state. */
    update(dt, state) {
      const p = this.parts;
      // Propeller: visible blades at low RPM, blurred disc at high RPM.
      const rpm = state.crashed ? 0 : state.rpm;
      this.propAngle += dt * (rpm * 55 + 2 * rpm);
      for (const hub of p.props) hub.rotation.z = this.propAngle;
      const blurT = THREE.MathUtils.smoothstep(rpm, 0.35, 0.7);
      for (const b of p.blurs) b.material.opacity = blurT * 0.16;
      for (const hub of p.props) for (let i = 1; i < hub.children.length; i++) hub.children[i].visible = blurT < 0.95 || (i % 2 === 0);
      // Control surfaces (see sign notes: +X rotation moves a trailing edge down).
      for (const e of p.elevators) e.rotation.x = -state.elevator * 0.4;
      for (const r of p.rudders) r.rotation.y = state.rudder * 0.4;
      for (const a of p.ailR) a.rotation.x = -state.aileron * 0.35;
      for (const a of p.ailL) a.rotation.x = state.aileron * 0.35;
      for (const f of p.flaps) f.rotation.x = state.flaps * 0.6;
      // Gear retraction: mains fold inward, nose folds forward.
      const retract = 1 - state.gearPos;
      for (const g of p.gear) {
        if (g.side === 0) g.leg.rotation.x = -retract * Math.PI / 2;
        else g.leg.rotation.z = -g.side * retract * Math.PI / 2;
        g.leg.visible = state.gearPos > 0.02;
      }
      // Wheels spin when rolling.
      if (state.onGround) this.wheelAngle -= (Math.hypot(state.vel.x, state.vel.z) / 0.32) * dt;
      for (const w of p.wheels) w.rotation.x = this.wheelAngle;
      // Lights
      this.blink += dt;
      this.strobe.visible = (this.blink % 1.2) < 0.08;
    }

    worldPoint(local, out) { return out.copy(local).applyMatrix4(this.group.matrixWorld); }

    dispose() {
      this.group.traverse((o) => { if (o.geometry) o.geometry.dispose(); });
      for (const k of Object.keys(this.mats)) this.mats[k].dispose();
    }
  }

  // ---------------------------------------------------------------------------
  // Custom aircraft from the Plane Builder (same interface as AircraftVisual)
  // ---------------------------------------------------------------------------
  class CustomAircraftVisual {
    /** spec: from Physics.buildSpecFromDesign; resolved: from Parts.resolveDesign. */
    constructor(spec, resolved) {
      this.spec = spec;
      this.material = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.5, metalness: 0.15, flatShading: true });
      // Explosion debris takes its colour from the main fuselage part.
      const root = resolved.root ? resolved.root.def.color : 0xdddddd;
      this.mats = { primary: new THREE.MeshBasicMaterial({ color: root }) };
      const { group, anims } = AV.Parts.buildFlightModel(resolved, spec.design.cg, this.material);
      this.group = group;
      this.group.name = 'custom-aircraft';
      this.anims = anims;
      const h = spec.hull;
      this.wingtips = [v3(h.wingL[0], h.wingL[1], h.wingL[2]), v3(h.wingR[0], h.wingR[1], h.wingR[2])];
      this.exhaustPoints = spec.engines.length ? spec.engines.map((e) => v3(e.rear[0], e.rear[1], e.rear[2])) : [v3(0, 0, h.tail[2])];
      const canopy = resolved.list.find((r) => r.def.id === 'canopy' && !r.floating);
      const cg = spec.design.cg;
      this.cockpitEye = canopy ? v3(canopy.center[0] - cg[0], canopy.aabb.max[1] - cg[1] - 0.1, canopy.center[2] - cg[2])
        : v3(0, h.top[1] + 0.3, h.nose[2] * 0.5);
      this.propAngle = 0;
    }
    setPaint() { /* custom designs keep their part colours */ }
    update(dt, state) {
      const rpm = state.crashed ? 0 : state.rpm;
      this.propAngle += dt * rpm * 55;
      const retract = 1 - state.gearPos;
      for (const a of this.anims) {
        const m = a.mesh, sign = a.mirrored ? -1 : 1;
        switch (a.kind) {
          case 'prop': m.rotation.z = this.propAngle; break;
          case 'aileron': m.rotation.x = -a.side * sign * state.aileron * 0.35; break;
          case 'elevon': m.rotation.x = (-a.side * sign * state.aileron * 0.3 - state.elevator * 0.35); break;
          case 'elevator': m.rotation.x = -state.elevator * 0.4; break;
          case 'ruddervator': m.rotation.x = -state.elevator * 0.35 + a.side * state.rudder * 0.3; break;
          case 'rudder': m.rotation.y = state.rudder * 0.4 * sign; break;
          case 'gear':
            if (a.axis === 'x') m.rotation.x = -retract * Math.PI / 2;
            else m.rotation.z = -a.side * sign * retract * Math.PI / 2;
            m.visible = state.gearPos > 0.02;
            break;
          default: break;
        }
      }
    }
    worldPoint(local, out) { return out.copy(local).applyMatrix4(this.group.matrixWorld); }
    dispose() {
      this.group.traverse((o) => { if (o.geometry) o.geometry.dispose(); });
      this.material.dispose();
      this.mats.primary.dispose();
    }
  }

  // ---------------------------------------------------------------------------
  // Particle system (CPU-simulated, GPU-drawn Points)
  // ---------------------------------------------------------------------------
  const PARTICLE_VS = `
    attribute float size;
    attribute float alpha;
    attribute vec3 tint;
    uniform float scale;
    varying float vAlpha;
    varying vec3 vTint;
    #include <fog_pars_vertex>
    void main() {
      vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
      gl_PointSize = min(size * scale / max(-mvPosition.z, 0.1), 512.0);
      vAlpha = alpha; vTint = tint;
      gl_Position = projectionMatrix * mvPosition;
      #include <fog_vertex>
    }`;
  const PARTICLE_FS = `
    uniform sampler2D map;
    varying float vAlpha;
    varying vec3 vTint;
    #include <fog_pars_fragment>
    void main() {
      vec4 t = texture2D(map, gl_PointCoord);
      gl_FragColor = vec4(vTint, t.a * vAlpha);
      if (gl_FragColor.a < 0.003) discard;
      #include <colorspace_fragment>
      #include <fog_fragment>
    }`;

  /** Emission presets: life (s), size start→end, colour start→end, drag, lift (buoyancy m/s²), spread. */
  const PRESETS = {
    exhaust: { life: [0.4, 0.8], size: [0.5, 2.2], c0: 0x9a9a9a, c1: 0xd0d0d0, a: 0.28, drag: 1.5, lift: 1, spread: 0.4 },
    dust: { life: [0.8, 1.6], size: [1.2, 6], c0: 0xb8a07a, c1: 0xd8c8a8, a: 0.4, drag: 2.2, lift: 0.6, spread: 2.5 },
    snowdust: { life: [0.8, 1.6], size: [1.2, 6], c0: 0xf4f8ff, c1: 0xffffff, a: 0.5, drag: 2.2, lift: 0.4, spread: 2.5 },
    smoke: { life: [1.6, 3], size: [1.2, 7], c0: 0x2a2a2a, c1: 0x6a6a6a, a: 0.5, drag: 0.8, lift: 2.5, spread: 0.6 },
    fire: { life: [0.25, 0.6], size: [2.2, 0.6], c0: 0xffd070, c1: 0xff4010, a: 0.95, drag: 1.2, lift: 3, spread: 2, additive: true },
    fireball: { life: [0.5, 1.1], size: [6, 16], c0: 0xffe0a0, c1: 0xff3000, a: 0.9, drag: 2.5, lift: 4, spread: 10, additive: true },
    blackSmoke: { life: [2.5, 4.5], size: [5, 22], c0: 0x1a1a1a, c1: 0x5a5a5a, a: 0.55, drag: 1.2, lift: 4, spread: 6 },
    spark: { life: [0.4, 0.9], size: [0.5, 0.2], c0: 0xffffc0, c1: 0xff8020, a: 1, drag: 0.4, lift: -9.8, spread: 18, additive: true },
    splash: { life: [0.8, 1.5], size: [2, 6], c0: 0xffffff, c1: 0xcfe8ff, a: 0.7, drag: 0.6, lift: -9.8, spread: 10 },
    sparkle: { life: [0.4, 0.8], size: [1.4, 0.2], c0: 0xfff6b0, c1: 0xffc020, a: 1, drag: 1, lift: 0, spread: 8, additive: true },
    ringBurst: { life: [0.5, 0.9], size: [2, 0.4], c0: 0xa0f0ff, c1: 0x40a0ff, a: 1, drag: 1, lift: 0, spread: 14, additive: true },
    mine: { life: [0.6, 1.2], size: [5, 14], c0: 0xff60ff, c1: 0x6020ff, a: 0.9, drag: 2, lift: 1, spread: 12, additive: true },
  };

  class ParticleSystem {
    constructor(scene, max, additive) {
      this.max = max;
      this.n = 0;
      this.p = new Float32Array(max * 3); this.v = new Float32Array(max * 3);
      this.life = new Float32Array(max); this.maxLife = new Float32Array(max);
      this.s0 = new Float32Array(max); this.s1 = new Float32Array(max);
      this.c0 = new Float32Array(max * 3); this.c1 = new Float32Array(max * 3);
      this.a0 = new Float32Array(max); this.drag = new Float32Array(max); this.lift = new Float32Array(max);
      const geo = new THREE.BufferGeometry();
      this.posAttr = new THREE.BufferAttribute(new Float32Array(max * 3), 3).setUsage(THREE.DynamicDrawUsage);
      this.sizeAttr = new THREE.BufferAttribute(new Float32Array(max), 1).setUsage(THREE.DynamicDrawUsage);
      this.alphaAttr = new THREE.BufferAttribute(new Float32Array(max), 1).setUsage(THREE.DynamicDrawUsage);
      this.tintAttr = new THREE.BufferAttribute(new Float32Array(max * 3), 3).setUsage(THREE.DynamicDrawUsage);
      geo.setAttribute('position', this.posAttr); geo.setAttribute('size', this.sizeAttr);
      geo.setAttribute('alpha', this.alphaAttr); geo.setAttribute('tint', this.tintAttr);
      this.uniforms = THREE.UniformsUtils.merge([THREE.UniformsLib.fog, { map: { value: null }, scale: { value: 500 } }]);
      this.uniforms.map.value = AV.Geo.softDot(64, 0.25, 0.6);
      this.points = new THREE.Points(geo, new THREE.ShaderMaterial({
        uniforms: this.uniforms, vertexShader: PARTICLE_VS, fragmentShader: PARTICLE_FS,
        transparent: true, depthWrite: false, fog: true, blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
      }));
      this.points.frustumCulled = false;
      this.points.renderOrder = 6;
      scene.add(this.points);
      this._c = new THREE.Color();
    }

    emit(preset, x, y, z, vx, vy, vz, count, sizeMul) {
      const P = preset, c = this._c;
      for (let k = 0; k < count; k++) {
        if (this.n >= this.max) return;
        const i = this.n++;
        const sp = P.spread;
        this.p[i * 3] = x; this.p[i * 3 + 1] = y; this.p[i * 3 + 2] = z;
        this.v[i * 3] = vx + (Math.random() - 0.5) * sp; this.v[i * 3 + 1] = vy + (Math.random() - 0.5) * sp; this.v[i * 3 + 2] = vz + (Math.random() - 0.5) * sp;
        this.maxLife[i] = this.life[i] = P.life[0] + Math.random() * (P.life[1] - P.life[0]);
        const sm = sizeMul || 1;
        this.s0[i] = P.size[0] * sm; this.s1[i] = P.size[1] * sm;
        c.set(P.c0); this.c0[i * 3] = c.r; this.c0[i * 3 + 1] = c.g; this.c0[i * 3 + 2] = c.b;
        c.set(P.c1); this.c1[i * 3] = c.r; this.c1[i * 3 + 1] = c.g; this.c1[i * 3 + 2] = c.b;
        this.a0[i] = P.a; this.drag[i] = P.drag; this.lift[i] = P.lift;
      }
    }

    update(dt, viewportHeight, fovDeg) {
      this.uniforms.scale.value = viewportHeight / (2 * Math.tan((fovDeg * Math.PI) / 360));
      const pa = this.posAttr.array, sa = this.sizeAttr.array, aa = this.alphaAttr.array, ta = this.tintAttr.array;
      let i = 0;
      while (i < this.n) {
        this.life[i] -= dt;
        if (this.life[i] <= 0) { this.kill(i); continue; }
        const t = 1 - this.life[i] / this.maxLife[i];
        const d = Math.max(0, 1 - this.drag[i] * dt);
        const i3 = i * 3;
        this.v[i3] *= d; this.v[i3 + 1] = this.v[i3 + 1] * d + this.lift[i] * dt; this.v[i3 + 2] *= d;
        this.p[i3] += this.v[i3] * dt; this.p[i3 + 1] += this.v[i3 + 1] * dt; this.p[i3 + 2] += this.v[i3 + 2] * dt;
        pa[i3] = this.p[i3]; pa[i3 + 1] = this.p[i3 + 1]; pa[i3 + 2] = this.p[i3 + 2];
        sa[i] = this.s0[i] + (this.s1[i] - this.s0[i]) * t;
        aa[i] = this.a0[i] * (1 - t) * Math.min(1, t * 8 + 0.2);
        ta[i3] = this.c0[i3] + (this.c1[i3] - this.c0[i3]) * t;
        ta[i3 + 1] = this.c0[i3 + 1] + (this.c1[i3 + 1] - this.c0[i3 + 1]) * t;
        ta[i3 + 2] = this.c0[i3 + 2] + (this.c1[i3 + 2] - this.c0[i3 + 2]) * t;
        i++;
      }
      const g = this.points.geometry;
      g.setDrawRange(0, this.n);
      this.posAttr.needsUpdate = this.sizeAttr.needsUpdate = this.alphaAttr.needsUpdate = this.tintAttr.needsUpdate = true;
    }

    /** Swap-remove particle i with the last live one. */
    kill(i) {
      const j = --this.n;
      if (i === j) return;
      const copy3 = (arr) => { arr[i * 3] = arr[j * 3]; arr[i * 3 + 1] = arr[j * 3 + 1]; arr[i * 3 + 2] = arr[j * 3 + 2]; };
      copy3(this.p); copy3(this.v); copy3(this.c0); copy3(this.c1);
      this.life[i] = this.life[j]; this.maxLife[i] = this.maxLife[j]; this.s0[i] = this.s0[j]; this.s1[i] = this.s1[j];
      this.a0[i] = this.a0[j]; this.drag[i] = this.drag[j]; this.lift[i] = this.lift[j];
    }

    clear() { this.n = 0; }
  }

  // ---------------------------------------------------------------------------
  // Ribbon trail (wingtip vapour)
  // ---------------------------------------------------------------------------
  class Trail {
    constructor(scene, length) {
      this.len = length;
      this.points = [];
      const geo = new THREE.BufferGeometry();
      this.pos = new THREE.BufferAttribute(new Float32Array(length * 2 * 3), 3).setUsage(THREE.DynamicDrawUsage);
      this.alpha = new THREE.BufferAttribute(new Float32Array(length * 2), 1).setUsage(THREE.DynamicDrawUsage);
      geo.setAttribute('position', this.pos);
      geo.setAttribute('alpha', this.alpha);
      const idx = [];
      for (let i = 0; i < length - 1; i++) { const a = i * 2; idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); }
      geo.setIndex(idx);
      this.mesh = new THREE.Mesh(geo, new THREE.ShaderMaterial({
        uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog]),
        vertexShader: `attribute float alpha; varying float vA;
          #include <fog_pars_vertex>
          void main(){ vA = alpha; vec4 mvPosition = modelViewMatrix * vec4(position,1.0); gl_Position = projectionMatrix * mvPosition;
          #include <fog_vertex>
          }`,
        fragmentShader: `varying float vA;
          #include <fog_pars_fragment>
          void main(){ gl_FragColor = vec4(1.0,1.0,1.0,vA);
          #include <fog_fragment>
          }`,
        transparent: true, depthWrite: false, side: THREE.DoubleSide, fog: true,
      }));
      this.mesh.frustumCulled = false;
      scene.add(this.mesh);
    }
    /** Push the newest tip position; intensity 0..1 controls opacity at the head. */
    push(p, up, intensity) {
      this.points.unshift({ x: p.x, y: p.y, z: p.z, ux: up.x, uy: up.y, uz: up.z, a: intensity });
      if (this.points.length > this.len) this.points.pop();
      const pa = this.pos.array, aa = this.alpha.array;
      for (let i = 0; i < this.len; i++) {
        const q = this.points[Math.min(i, this.points.length - 1)];
        const t = i / (this.len - 1);
        const w = 0.15 + t * 1.2;
        const a = i < this.points.length ? q.a * (1 - t) * 0.5 : 0;
        pa[i * 6] = q.x + q.ux * w; pa[i * 6 + 1] = q.y + q.uy * w; pa[i * 6 + 2] = q.z + q.uz * w;
        pa[i * 6 + 3] = q.x - q.ux * w; pa[i * 6 + 4] = q.y - q.uy * w; pa[i * 6 + 5] = q.z - q.uz * w;
        aa[i * 2] = a; aa[i * 2 + 1] = a;
      }
      this.pos.needsUpdate = true; this.alpha.needsUpdate = true;
    }
    reset() { this.points.length = 0; this.alpha.array.fill(0); this.alpha.needsUpdate = true; }
  }

  // ---------------------------------------------------------------------------
  // Effects manager
  // ---------------------------------------------------------------------------
  class Effects {
    constructor(scene, camera, maxParticles) {
      this.scene = scene;
      this.camera = camera;
      this.smokeSys = new ParticleSystem(scene, maxParticles || 2500, false);
      this.glowSys = new ParticleSystem(scene, Math.floor((maxParticles || 2500) * 0.6), true);
      this.trails = [new Trail(scene, 70), new Trail(scene, 70)];
      this.shakeAmount = 0;
      this.shakeOffset = new THREE.Vector3();
      this.flashLight = new THREE.PointLight(0xff8030, 0, 400, 1.5);
      scene.add(this.flashLight);
      this.initSpeedLines();
      this.initDebris();
      this._v = new THREE.Vector3(); this._v2 = new THREE.Vector3(); this._up = new THREE.Vector3();
      this.emitAcc = 0;
      this.reducedMotion = false;
    }

    emit(name, pos, vel, count, sizeMul) {
      const P = PRESETS[name];
      const sys = P.additive ? this.glowSys : this.smokeSys;
      sys.emit(P, pos.x, pos.y, pos.z, vel ? vel.x : 0, vel ? vel.y : 0, vel ? vel.z : 0, count, sizeMul);
    }

    initSpeedLines() {
      const n = 90;
      const pos = new Float32Array(n * 6);
      this.speedSeeds = [];
      for (let i = 0; i < n; i++) {
        const a = Math.random() * Math.PI * 2, r = 3 + Math.random() * 7;
        this.speedSeeds.push({ x: Math.cos(a) * r, y: Math.sin(a) * r, z: -Math.random() * 80, len: 3 + Math.random() * 6 });
      }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(pos, 3).setUsage(THREE.DynamicDrawUsage));
      this.speedLines = new THREE.LineSegments(geo, new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0, depthWrite: false, fog: false }));
      this.speedLines.frustumCulled = false;
      this.camera.add(this.speedLines);
    }

    updateSpeedLines(dt, speed, threshold) {
      const k = THREE.MathUtils.clamp((speed - threshold) / (threshold * 0.6), 0, 1);
      this.speedLines.material.opacity = k * 0.35;
      this.speedLines.visible = k > 0.01 && !this.reducedMotion;
      if (!this.speedLines.visible) return;
      const arr = this.speedLines.geometry.attributes.position.array;
      this.speedSeeds.forEach((s, i) => {
        s.z += speed * dt * 1.5;
        if (s.z > 2) s.z = -80;
        arr.set([s.x, s.y, s.z, s.x, s.y, s.z - s.len * (0.5 + k)], i * 6);
      });
      this.speedLines.geometry.attributes.position.needsUpdate = true;
    }

    initDebris() {
      this.debris = [];
      const geo = new THREE.BoxGeometry(0.8, 0.25, 1.2);
      const mat = new THREE.MeshStandardMaterial({ color: 0x444444, roughness: 0.8, flatShading: true });
      for (let i = 0; i < 14; i++) {
        const m = new THREE.Mesh(geo, mat);
        m.visible = false; m.castShadow = true;
        this.scene.add(m);
        this.debris.push({ mesh: m, v: new THREE.Vector3(), w: new THREE.Vector3(), life: 0 });
      }
    }

    /** Big boom: fireball, smoke column, sparks, flying debris, light flash, camera shake. */
    explode(pos, vel, groundY, color) {
      const v = this._v.copy(vel || this._v.set(0, 0, 0)).multiplyScalar(0.25);
      this.emit('fireball', pos, v, 40);
      this.emit('blackSmoke', pos, v, 40);
      this.emit('spark', pos, this._v2.set(v.x, v.y + 8, v.z), 70);
      this.emit('fire', pos, v, 40, 2);
      this.flashLight.position.copy(pos);
      this.flashLight.intensity = 6000;
      this.shake(1.6);
      for (const d of this.debris) {
        d.mesh.visible = true;
        d.mesh.position.copy(pos);
        d.mesh.material.color.set(color || 0x666666);
        d.v.set((Math.random() - 0.5) * 40, 8 + Math.random() * 25, (Math.random() - 0.5) * 40).addScaledVector(v, 1);
        d.w.set(Math.random() * 8, Math.random() * 8, Math.random() * 8);
        d.life = 5 + Math.random() * 2;
        d.groundY = groundY;
        d.mesh.scale.setScalar(0.6 + Math.random() * 1.2);
      }
      this.smokeColumn = { pos: pos.clone(), t: 7 };
    }

    shake(amount) { this.shakeAmount = Math.min(2.5, this.shakeAmount + amount * (this.reducedMotion ? 0.25 : 1)); }

    /**
     * Per-frame: plane-attached emitters + particle/debris integration.
     * ctx: { visual, state, telemetry, groundY(x,z), surface(x,z), speedThreshold, dt }
     */
    update(dt, ctx, viewportHeight) {
      const cam = this.camera;
      this.emitAcc += dt;
      const emitNow = this.emitAcc > 1 / 40;
      if (emitNow) this.emitAcc = 0;
      if (ctx && ctx.visual && ctx.state && !ctx.state.crashed && ctx.visual.group.visible) {
        const { visual, state } = ctx;
        visual.group.updateMatrixWorld();
        const vel = state.vel;
        if (emitNow) {
          // Exhaust puffs, thicker with throttle.
          for (const ep of visual.exhaustPoints) {
            const p = visual.worldPoint(ep, this._v);
            this.emit('exhaust', p, this._v2.copy(vel).multiplyScalar(0.6), state.throttle > 0.1 ? 1 : 0, 0.6 + state.throttle);
          }
          // Damage smoke and fire.
          if (state.damage > 0.35) {
            const p = visual.worldPoint(visual.exhaustPoints[0], this._v);
            this.emit('smoke', p, this._v2.copy(vel).multiplyScalar(0.5), state.damage > 0.65 ? 3 : 1, 0.6 + state.damage);
            if (state.damage > 0.7) this.emit('fire', p, this._v2.copy(vel).multiplyScalar(0.7), 2);
          }
          // Dust / snow kicked up near the ground at speed.
          const agl = state.pos.y - Math.max(0, ctx.groundY(state.pos.x, state.pos.z));
          const gs = Math.hypot(vel.x, vel.z);
          if (agl < 8 && gs > 12) {
            const surface = ctx.surface(state.pos.x, state.pos.z);
            if (surface !== 'water') {
              const preset = surface === 'snow' ? 'snowdust' : surface === 'runway' || surface === 'pad' ? null : 'dust';
              const p = this._v.set(state.pos.x, ctx.groundY(state.pos.x, state.pos.z) + 0.5, state.pos.z);
              this.emit(preset || 'exhaust', p, this._v2.set(vel.x * 0.2, 1, vel.z * 0.2), preset ? 3 : 1, preset ? 1 : 2.5);
            } else if (agl < 4) {
              this.emit('splash', this._v.set(state.pos.x, 0.3, state.pos.z), this._v2.set(vel.x * 0.3, 6, vel.z * 0.3), 3);
            }
          }
        }
        // Vapour trails at high speed or high G.
        const intensity = THREE.MathUtils.clamp(Math.max((state.airspeed - ctx.speedThreshold) / 20, (Math.abs(state.gLoad) - 3) / 2), 0, 1);
        this._up.set(0, 1, 0).applyQuaternion(visual.group.quaternion).multiplyScalar(0.25);
        visual.wingtips.forEach((tip, i) => this.trails[i].push(visual.worldPoint(tip, this._v), this._up, intensity));
      }
      // Lingering crash-site smoke column.
      if (this.smokeColumn && this.smokeColumn.t > 0) {
        this.smokeColumn.t -= dt;
        if (emitNow) this.emit('blackSmoke', this.smokeColumn.pos, this._v2.set(0, 4, 0), 1, 0.7);
      }
      this.smokeSys.update(dt, viewportHeight, cam.fov);
      this.glowSys.update(dt, viewportHeight, cam.fov);
      this.flashLight.intensity *= Math.max(0, 1 - dt * 5);
      for (const d of this.debris) {
        if (d.life <= 0) continue;
        d.life -= dt;
        d.v.y -= 9.81 * dt;
        d.mesh.position.addScaledVector(d.v, dt);
        const gy = d.groundY ? d.groundY(d.mesh.position.x, d.mesh.position.z) : 0;
        if (d.mesh.position.y < Math.max(gy, 0)) { d.mesh.position.y = Math.max(gy, 0); d.v.multiplyScalar(0.35); d.v.y = Math.abs(d.v.y) * 0.3; d.w.multiplyScalar(0.5); }
        d.mesh.rotation.x += d.w.x * dt; d.mesh.rotation.y += d.w.y * dt; d.mesh.rotation.z += d.w.z * dt;
        if (d.life <= 0) d.mesh.visible = false;
      }
      // Camera shake decays; offset applied by the camera rig.
      this.shakeAmount = Math.max(0, this.shakeAmount - dt * 1.8);
      const s = this.shakeAmount * this.shakeAmount;
      this.shakeOffset.set((Math.random() - 0.5) * s, (Math.random() - 0.5) * s, (Math.random() - 0.5) * s);
    }

    reset() {
      this.smokeSys.clear(); this.glowSys.clear();
      for (const t of this.trails) t.reset();
      for (const d of this.debris) { d.life = 0; d.mesh.visible = false; }
      this.smokeColumn = null;
      this.shakeAmount = 0;
      this.flashLight.intensity = 0;
    }
  }

  AV.Aircraft = { PAINTS, SHAPES, AircraftVisual, CustomAircraftVisual, Effects, ParticleSystem, PRESETS };
})(window.AV);
