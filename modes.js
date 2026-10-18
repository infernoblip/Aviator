/* modes.js — camera rig, shared flight session, and the game modes:
 *   MenuMode (background flight), HangarMode, CrashMode (Aviator rounds),
 *   CampaignMode (mission objectives), FreeFlightMode (sandbox + photo mode).
 *
 * Every mode implements: enter(), exit(), update(dt), and optionally restart(),
 * onPause(paused). Modes never touch the DOM directly; they call AV.UI.
 */
window.AV = window.AV || {};
(function (AV) {
  'use strict';
  const P = AV.Physics, T = AV.Terrain;
  const DEG = Math.PI / 180;
  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  const wrapPi = (a) => { while (a > Math.PI) a -= 2 * Math.PI; while (a < -Math.PI) a += 2 * Math.PI; return a; };
  const groundAt = (x, z) => Math.max(T.heightAt(x, z), 0);
  /** Ground under the camera/aircraft in whatever world is loaded (terrain or a custom map). */
  const viewGround = (x, z) => {
    const w = AV.Game && AV.Game.world;
    return w ? Math.max(w.heightAt(x, z), w.waterLevel) : groundAt(x, z);
  };
  const tmpV = new THREE.Vector3(), tmpV2 = new THREE.Vector3(), tmpQ = new THREE.Quaternion();
  const toV3 = (p, out) => (out || new THREE.Vector3()).set(p.x, p.y, p.z);

  // ===========================================================================
  // Camera rig: chase / cockpit / orbit / detached
  // ===========================================================================
  class CameraRig {
    constructor(camera) {
      this.camera = camera;
      this.mode = 'chase';
      this.pos = new THREE.Vector3();
      this.look = new THREE.Vector3();
      this.up = new THREE.Vector3(0, 1, 0);
      this.orbitYaw = 2.4; this.orbitPitch = 0.22; this.orbitDist = 22;
      this.autoOrbit = 0;
      this.ready = false;
      this.reducedMotion = false;
      this.baseFov = 65;
      this.sideOffset = 0;
      this.distanceScale = 1;
    }
    setMode(m) { this.mode = m; this.ready = false; }
    cycle() {
      const order = ['chase', 'cockpit', 'orbit'];
      this.setMode(order[(order.indexOf(this.mode) + 1) % order.length]);
      return this.mode;
    }
    reset() { this.ready = false; }

    /** target: { pos: Vector3, quat: Quaternion, vel: {x,y,z}, visual, span } */
    update(dt, target, shake, mode) {
      const cam = this.camera, m = mode || this.mode;
      const k = this.ready ? 1 - Math.exp(-dt * 5) : 1;
      const speed = Math.hypot(target.vel.x, target.vel.y, target.vel.z);
      // The model is hidden from inside the cockpit, and stays hidden once it has been destroyed.
      if (target.visual) target.visual.group.visible = m !== 'cockpit' && !target.destroyed;
      const fwd = tmpV.set(0, 0, -1).applyQuaternion(target.quat);
      const planeUp = tmpV2.set(0, 1, 0).applyQuaternion(target.quat);
      if (m === 'chase') {
        const span = target.span || 10;
        const dist = (span * 1.25 + 6 + speed * 0.05) * this.distanceScale;
        // Blend plane heading with velocity so the camera swings smoothly into turns.
        const vdir = new THREE.Vector3(target.vel.x, target.vel.y, target.vel.z);
        if (speed > 5) fwd.lerp(vdir.normalize(), 0.35).normalize();
        const desired = new THREE.Vector3().copy(target.pos).addScaledVector(fwd, -dist).addScaledVector(new THREE.Vector3(0, 1, 0), span * 0.3 + 2);
        if (this.sideOffset) desired.addScaledVector(new THREE.Vector3().crossVectors(fwd, new THREE.Vector3(0, 1, 0)).normalize(), this.sideOffset);
        this.pos.lerp(desired, k);
        const gy = viewGround(this.pos.x, this.pos.z) + 1.5;
        if (this.pos.y < gy) this.pos.y = gy;
        this.look.lerp(new THREE.Vector3().copy(target.pos).addScaledVector(fwd, 12), this.ready ? 1 - Math.exp(-dt * 10) : 1);
        // Banking cue: the horizon tilts by ~30 % of the aircraft's bank.
        this.up.lerp(new THREE.Vector3(0, 1, 0).lerp(planeUp, this.reducedMotion ? 0.1 : 0.3), k).normalize();
        cam.position.copy(this.pos);
        cam.up.copy(this.up);
        cam.lookAt(this.look);
      } else if (m === 'cockpit') {
        const eye = target.visual ? target.visual.worldPoint(target.visual.cockpitEye, new THREE.Vector3()) : target.pos;
        cam.position.copy(eye);
        cam.quaternion.copy(target.quat);
        this.pos.copy(eye);
      } else if (m === 'orbit' || m === 'photo') {
        const o = AV.Input.takeOrbit();
        this.orbitYaw -= o.dx * 0.006; this.orbitPitch = clamp(this.orbitPitch + o.dy * 0.004, -0.4, 1.45);
        this.orbitDist = clamp(this.orbitDist * (1 + o.zoom * 0.1), 6, 160);
        this.orbitYaw += this.autoOrbit * dt;
        const r = this.orbitDist;
        const desired = new THREE.Vector3(Math.sin(this.orbitYaw) * Math.cos(this.orbitPitch) * r, Math.sin(this.orbitPitch) * r, Math.cos(this.orbitYaw) * Math.cos(this.orbitPitch) * r).add(target.pos);
        const gy = viewGround(desired.x, desired.z) + 1.2;
        if (desired.y < gy) desired.y = gy;
        this.pos.lerp(desired, this.ready ? 1 - Math.exp(-dt * 12) : 1);
        cam.position.copy(this.pos);
        cam.up.set(0, 1, 0);
        cam.lookAt(target.pos);
      } else if (m === 'detached') {
        cam.position.copy(this.pos);
        cam.up.set(0, 1, 0);
        this.look.lerp(target.pos, 1 - Math.exp(-dt * 4));
        cam.lookAt(this.look);
      }
      if (shake && !this.reducedMotion) cam.position.add(shake);
      // Subtle FOV kick with speed.
      const fov = (m === 'cockpit' ? 75 : this.baseFov) + (this.reducedMotion ? 0 : clamp((speed - 40) * 0.08, 0, 10));
      if (Math.abs(cam.fov - fov) > 0.05) { cam.fov += (fov - cam.fov) * Math.min(1, dt * 3); cam.updateProjectionMatrix(); }
      this.ready = true;
    }
  }

  // ===========================================================================
  // Spawning
  // ===========================================================================
  const airfield = (id) => T.AIRFIELDS.find((a) => a.id === id);

  /** Turn a spawn definition into position/heading/speed/config. */
  function resolveSpawn(def, spec) {
    // Built aircraft without wheels: floats start on the sea, gear-less designs start airborne.
    if (def.airfield && spec.gearType === 'floats') {
      const z = 400, x = T.findShore(1800, z) + 350;
      return { x, y: spec.gearHeight + 0.05, z, heading: 0, speed: 0, onGround: true, gearDown: true, flaps: 0, throttle: 0 };
    }
    if (def.airfield && !spec.gearPoints.length) {
      const a = airfield(def.airfield);
      return { x: a.x, y: T.heightAt(a.x, a.z) + 160, z: a.z + 300, heading: a.heading * DEG, speed: spec.cruiseSpeed, onGround: false, gearDown: false, flaps: 0 };
    }
    if (def.mapStart) {
      const sp = AV.Game.world.custom.runtime.spawn();
      if (!sp.onGround || !spec.gearPoints.length) return { x: sp.x, y: sp.y + 80, z: sp.z, heading: sp.heading, speed: spec.cruiseSpeed, onGround: false, gearDown: false, flaps: 0 };
      return { x: sp.x, y: sp.y + spec.gearHeight + 0.05, z: sp.z, heading: sp.heading, speed: 0, onGround: true, gearDown: true, flaps: 0, throttle: 0 };
    }
    if (def.airfield) {
      const a = airfield(def.airfield);
      const along = -(a.length / 2 - 45);
      const x = a.x + a.dir.x * along, z = a.z + a.dir.z * along;
      return { x, y: T.heightAt(x, z) + spec.gearHeight + 0.02, z, heading: a.heading * DEG, speed: 0, onGround: true, gearDown: true, flaps: 0, throttle: 0 };
    }
    if (def.approach) {
      const a = airfield(def.approach);
      const along = -a.length / 2 - def.distance;
      const x = a.x + a.dir.x * along, z = a.z + a.dir.z * along;
      const elev = T.heightAt(a.x, a.z);
      return { x, y: Math.max(elev + def.height, groundAt(x, z) + 70), z, heading: a.heading * DEG, speed: spec.stallSpeed * 1.4, glide: -0.045,
        onGround: false, gearDown: true, flaps: def.flaps || 0, throttleScale: 0.65 };
    }
    if (def.air) {
      const [x, z, agl, hdg] = def.air;
      return { x, y: groundAt(x, z) + agl, z, heading: hdg * DEG, speed: spec.cruiseSpeed * (def.speedFactor || 1), onGround: false, gearDown: false, flaps: 0 };
    }
    if (def.point) {
      const { x, y, z, heading, speed } = def.point;
      return { x, y, z, heading, speed: speed || spec.cruiseSpeed, onGround: false, gearDown: false, flaps: 0 };
    }
    return resolveSpawn({ airfield: 'meadow' }, spec);
  }

  function spawnState(spec, sp) {
    const trim = sp.onGround ? null : P.computeTrim(spec, sp.speed, sp.y);
    const glide = sp.glide || 0;
    const st = P.createState(spec, {
      x: sp.x, y: sp.y, z: sp.z, heading: sp.heading, pitch: trim ? trim.alpha + glide : 0, speed: 0,
      onGround: sp.onGround, gearDown: sp.gearDown, flaps: sp.flaps,
    });
    st.vel.x = Math.sin(sp.heading) * Math.cos(glide) * sp.speed;
    st.vel.y = Math.sin(glide) * sp.speed;
    st.vel.z = -Math.cos(sp.heading) * Math.cos(glide) * sp.speed;
    st.airspeed = sp.speed;
    if (trim) { st.throttle = clamp(trim.throttle * (sp.throttleScale || 1), 0, 1); st.elevator = trim.elevator; }
    st.onGround = sp.onGround;
    return st;
  }

  // ===========================================================================
  // Autopilot (shared by crash mode, menu flight and the escort drone logic)
  // ===========================================================================
  /** Returns raw stick input that flies toward the requested heading/pitch/bank. */
  function autopilot(state, tel, target) {
    const out = { pitch: 0, roll: 0, yaw: 0 };
    let bankCmd = target.bank;
    if (bankCmd === undefined && target.heading !== undefined) bankCmd = clamp(wrapPi(target.heading - tel.heading) * 1.4, -(target.maxBank || 0.5), target.maxBank || 0.5);
    if (bankCmd === undefined) bankCmd = 0;
    out.roll = clamp((bankCmd - tel.roll) * 2.4 + state.w.z * 0.5, -1, 1);
    let pitchCmd = target.pitch;
    if (pitchCmd === undefined && target.altitude !== undefined) pitchCmd = clamp((target.altitude - state.pos.y) * 0.006, -0.18, 0.25);
    if (pitchCmd === undefined) pitchCmd = 0;
    out.pitch = clamp((pitchCmd - tel.pitch) * 3.2 - state.w.x * 0.9 + Math.abs(Math.sin(tel.roll)) * 0.25, -1, 1);
    return out;
  }

  // ===========================================================================
  // Flight session: physics + visuals + effects + audio for one aircraft
  // ===========================================================================
  class FlightSession {
    constructor(game, opts) {
      this.game = game;
      const save = AV.Save.data;
      if (opts.design) {
        // Plane Builder design: same physics pipeline, spec derived from its parts.
        this.resolved = AV.Parts.resolveDesign(opts.design);
        this.aircraftId = 'custom';
        this.spec = P.buildSpecFromDesign(this.resolved, opts.upgrades || save.hangar.upgrades, opts.design.name);
        this.visual = new AV.Aircraft.CustomAircraftVisual(this.spec, this.resolved);
      } else {
        this.aircraftId = opts.aircraftId || save.hangar.selected;
        this.spec = P.buildSpec(this.aircraftId, opts.upgrades || save.hangar.upgrades);
        this.visual = new AV.Aircraft.AircraftVisual(this.spec, opts.paint || save.hangar.paint);
      }
      this.infiniteFuel = !!opts.infiniteFuel;
      game.scene.add(this.visual.group);
      this.rng = T.mulberry32(opts.seed || 99);
      this.boost = 1;
      this.autopilotFn = null;
      this.frozen = false;
      this.extraCollide = null;
      this.tel = {};
      this.renderPos = new THREE.Vector3();
      this.renderQuat = new THREE.Quaternion();
      this._pos = P.V.make(); this._q = P.Q.make();
      const world = game.world;
      this.env = {
        groundY: (x, z, y) => world.groundY(x, z, y),
        surface: (x, z) => world.surfaceAt(x, z),
        waterLevel: world.waterLevel,
        wind: game.world.wind,
        turbulence: 0,
        rng: this.rng,
        collide: (x, y, z) => game.world.collide(x, y, z) || (this.extraCollide ? this.extraCollide(x, y, z) : false),
      };
      this.spawn(opts.spawn || { airfield: 'meadow' });
    }

    spawn(def) {
      this.spawnDef = def;
      const sp = resolveSpawn(def, this.spec);
      this.state = spawnState(this.spec, sp);
      this.sim = new P.Simulator(this.spec, this.state);
      this.flaps = sp.flaps || 0;
      this.gearDown = sp.gearDown !== false;
      this.crashed = false;
      this.crashTime = 0;
      AV.Input.setThrottle(this.state.throttle);
      this.visual.group.visible = true;
      this.game.effects.reset();
      this.game.rig.reset();
      this.syncVisual(0);
    }

    get assist() { return AV.Save.data.settings.assist; }

    controls(state) {
      const inp = this.autopilotFn ? this.autopilotFn(state) : this.input;
      const c = P.applyAssist(state, this.spec, inp, this.autopilotFn ? 'light' : this.assist);
      c.throttle = inp.throttle;
      c.flaps = this.flaps;
      c.gearDown = this.gearDown;
      c.brake = inp.brake;
      c.boost = this.boost;
      c.infiniteFuel = this.infiniteFuel;
      return c;
    }

    toggleGear() {
      if (!this.spec.retractableGear) { AV.UI.toast('This aircraft has fixed landing gear', 'info'); return; }
      if (this.state.onGround && this.gearDown) { AV.UI.toast('Cannot retract gear on the ground', 'warn'); return; }
      this.gearDown = !this.gearDown;
      AV.Audio.play('gear');
      AV.UI.toast(this.gearDown ? 'Gear down' : 'Gear up', 'info');
    }
    cycleFlaps() {
      this.flaps = this.flaps >= 1 ? 0 : this.flaps >= 0.5 ? 1 : 0.5;
      AV.Audio.play('flaps');
      AV.UI.toast(`Flaps ${Math.round(this.flaps * 100)}%`, 'info');
    }

    /** Handle shared flight buttons (gear, flaps, camera). */
    handleButtons() {
      const I = AV.Input;
      if (I.consume('gear')) this.toggleGear();
      if (I.consume('flaps')) this.cycleFlaps();
      if (I.consume('camera')) { const m = this.game.rig.cycle(); AV.Save.data.settings.camera = m; AV.UI.toast(`Camera: ${m}`, 'info'); }
    }

    /** Step physics, process events, update visuals/effects/audio. Returns physics events. */
    update(dt, input) {
      this.input = input;
      this.env.turbulence = this.game.world.turbulence;
      this.env.waterLevel = this.game.world.waterLevel;
      let events = [];
      if (!this.frozen && !this.crashed) {
        events = this.sim.advance(dt, (s) => this.controls(s), this.env);
        for (const e of events) this.onEvent(e);
      }
      if (this.crashed) this.crashTime += dt;
      this.syncVisual(dt);
      P.getTelemetry(this.state, this.tel);
      this.updateAudio();
      return events;
    }

    onEvent(e) {
      const fx = this.game.effects, s = this.state;
      if (e.type === 'touchdown') {
        AV.Audio.play('touchdown');
        fx.emit('dust', toV3(s.pos, tmpV).setY(viewGround(s.pos.x, s.pos.z) + 0.5), null, 10);
        if (e.quality === 'hard') { fx.shake(0.6); AV.UI.toast(`Hard landing! (${e.sink.toFixed(1)} m/s)`, 'warn'); }
      } else if (e.type === 'crash') {
        this.crash(e.reason);
      }
    }

    crash(reason) {
      if (this.crashed) return;
      this.crashed = true;
      this.state.crashed = true;
      this.crashReason = reason;
      const p = toV3(this.state.pos, new THREE.Vector3());
      const world = this.game.world;
      this.game.effects.explode(p, this.state.vel, (x, z) => world.heightAt(x, z), this.visual.mats.primary.color.getHex());
      this.visual.group.visible = false;
      AV.Audio.play('boom');
      AV.Audio.setStallHorn(false);
    }

    syncVisual(dt) {
      this.sim.pose(this._pos, this._q);
      this.renderPos.set(this._pos.x, this._pos.y, this._pos.z);
      this.renderQuat.set(this._q.x, this._q.y, this._q.z, this._q.w);
      this.visual.group.position.copy(this.renderPos);
      this.visual.group.quaternion.copy(this.renderQuat);
      this.visual.update(dt, this.state);
    }

    updateAudio() {
      const s = this.state;
      AV.Audio.setEngine(s.rpm, s.throttle, !this.crashed);
      AV.Audio.setWind(s.airspeed, this.game.world.weather.storm);
      AV.Audio.setStallHorn(!this.crashed && s.stallWarning && !s.onGround);
    }

    /** Camera + particles. `mode` overrides the rig mode (e.g. 'detached', 'photo'). */
    updateCameraAndEffects(dt, mode) {
      const g = this.game;
      const target = { pos: this.renderPos, quat: this.renderQuat, vel: this.state.vel, visual: this.visual, span: this.spec.span, destroyed: this.crashed };
      g.rig.update(dt, target, g.effects.shakeOffset, mode);
      g.effects.update(dt, {
        visual: this.visual, state: this.state, speedThreshold: this.spec.cruiseSpeed * 1.25,
        groundY: (x, z) => g.world.heightAt(x, z), surface: (x, z) => g.world.surfaceAt(x, z),
      }, g.viewportHeight);
      const camMode = mode || g.rig.mode;
      const lineSpeed = this.crashed || camMode === 'detached' || camMode === 'photo' ? 0 : this.state.airspeed;
      g.effects.updateSpeedLines(dt, lineSpeed, this.spec.cruiseSpeed * (camMode === 'cockpit' ? 1.1 : 1.3));
    }

    /** Data for the HUD. */
    hud() {
      const s = this.state, t = this.tel;
      return {
        airspeed: s.airspeed, altitude: s.pos.y, agl: s.pos.y - viewGround(s.pos.x, s.pos.z), vs: s.vel.y,
        fuel: this.spec.fuelCapacity > 0 && !this.infiniteFuel ? s.fuel / this.spec.fuelCapacity : null,
        heading: t.heading, pitch: t.pitch, roll: t.roll, throttle: s.throttle, gLoad: s.gLoad,
        flaps: this.flaps, gearDown: this.gearDown, gearPos: s.gearPos, retractable: this.spec.retractableGear, brake: !!(this.input && this.input.brake),
        stall: s.stallWarning && !s.onGround, damage: s.damage, onGround: s.onGround, crashed: this.crashed,
        x: s.pos.x, z: s.pos.z, aoa: s.alpha, cruise: this.spec.cruiseSpeed,
        pullUp: !s.onGround && !this.crashed && s.vel.y < -8 && (s.pos.y - viewGround(s.pos.x + s.vel.x * 4, s.pos.z + s.vel.z * 4)) < -s.vel.y * 5,
      };
    }

    dispose() {
      this.game.scene.remove(this.visual.group);
      this.visual.dispose();
      AV.Audio.quiet();
    }
  }

  // ===========================================================================
  // Mission objects
  // ===========================================================================
  /** True if the segment prev→cur crosses the ring's local z=0 plane inside radius. */
  function crossesRing(obj, prev, cur, radius) {
    const inv = obj.userData.inv || (obj.userData.inv = new THREE.Matrix4());
    obj.updateMatrixWorld();
    inv.copy(obj.matrixWorld).invert();
    const a = tmpV.copy(prev).applyMatrix4(inv), b = tmpV2.copy(cur).applyMatrix4(inv);
    if ((a.z > 0) === (b.z > 0) || a.z === b.z) return false;
    const t = a.z / (a.z - b.z);
    const x = a.x + (b.x - a.x) * t, y = a.y + (b.y - a.y) * t;
    return x * x + y * y <= radius * radius;
  }

  /** Lift points so the straight line between consecutive points clears terrain by `clearance`. */
  function liftCourse(points, clearance, start) {
    for (let pass = 0; pass < 3; pass++) {
      for (let i = 0; i < points.length; i++) {
        const a = i === 0 ? (start || points[0]) : points[i - 1], b = points[i];
        let worst = 0, worstT = 1;
        for (let k = 1; k <= 16; k++) {
          const t = k / 16;
          const x = a.x + (b.x - a.x) * t, z = a.z + (b.z - a.z) * t, y = a.y + (b.y - a.y) * t;
          const deficit = groundAt(x, z) + clearance - y;
          if (deficit > worst) { worst = deficit; worstT = t; }
        }
        if (worst > 0) b.y += worst / Math.max(worstT, 0.35);
      }
    }
    return points;
  }

  function ringMesh(radius, color) {
    const g = new THREE.Group();
    const torus = new THREE.Mesh(new THREE.TorusGeometry(radius, Math.max(0.8, radius * 0.05), 8, 40), new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.9 }));
    const disc = new THREE.Mesh(new THREE.CircleGeometry(radius, 32), new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.08, side: THREE.DoubleSide, depthWrite: false }));
    g.add(torus, disc);
    g.userData = { torus, disc, radius };
    return g;
  }
  function setRingStyle(r, state) {
    const colors = { next: 0x35e0ff, upcoming: 0xffb020, done: 0x40ff80, boss: 0xff3060, core: 0xffe040 };
    const c = colors[state] || colors.upcoming;
    r.userData.torus.material.color.setHex(c);
    r.userData.disc.material.color.setHex(c);
    r.userData.disc.material.opacity = state === 'next' ? 0.12 : 0.04;
    r.userData.torus.material.opacity = state === 'upcoming' ? 0.55 : 0.95;
    r.visible = state !== 'done';
  }

  /** Ordered ring course (also used for storm beacons). */
  class RingCourse {
    constructor(scene, defs, radius, start) {
      this.scene = scene;
      this.radius = radius;
      const pts = defs.map((d) => {
        if (Array.isArray(d)) return new THREE.Vector3(d[0], groundAt(d[0], d[1]) + d[2], d[1]);
        const x = T.findShore(1800, d.z) - (d.shore || 0);
        return new THREE.Vector3(x, groundAt(x, d.z) + d.agl, d.z);
      });
      liftCourse(pts, 28, start);
      this.points = pts;
      this.rings = pts.map((p, i) => {
        const r = ringMesh(radius, 0xffb020);
        r.position.copy(p);
        const next = pts[i + 1] || p.clone().add(p.clone().sub(pts[i - 1] || start || p).normalize());
        const prev = pts[i - 1] || start || p;
        const dir = next.clone().sub(prev).setY(0).normalize();
        if (dir.lengthSq() < 0.1) dir.set(0, 0, -1);
        r.lookAt(p.clone().add(dir));
        scene.add(r);
        return r;
      });
      this.index = 0;
      this.refresh();
    }
    refresh() { this.rings.forEach((r, i) => setRingStyle(r, i < this.index ? 'done' : i === this.index ? 'next' : 'upcoming')); }
    /** Returns true when the active ring was passed this frame. */
    check(prev, cur) {
      if (this.done) return false;
      const ring = this.rings[this.index];
      if (crossesRing(ring, prev, cur, this.radius * 1.05)) {
        this.index++;
        this.refresh();
        return true;
      }
      return false;
    }
    get done() { return this.index >= this.rings.length; }
    get next() { return this.points[this.index]; }
    dispose() { for (const r of this.rings) { this.scene.remove(r); r.traverse((o) => { if (o.geometry) o.geometry.dispose(); }); } }
  }

  class CoinField {
    constructor(scene, def) {
      this.scene = scene;
      const rng = T.mulberry32(def.seed || 1);
      const pts = [];
      // Coins come in short trails of 3–5 so they read as lines to follow.
      while (pts.length < def.count) {
        const a = rng() * Math.PI * 2, r = Math.sqrt(rng()) * def.radius;
        let x = def.center[0] + Math.cos(a) * r, z = def.center[1] + Math.sin(a) * r;
        const dir = rng() * Math.PI * 2;
        let agl = def.agl[0] + rng() * (def.agl[1] - def.agl[0]);
        const n = Math.min(3 + Math.floor(rng() * 3), def.count - pts.length);
        for (let i = 0; i < n; i++) {
          pts.push(new THREE.Vector3(x, groundAt(x, z) + agl, z));
          x += Math.cos(dir) * 55; z += Math.sin(dir) * 55; agl = clamp(agl + (rng() - 0.5) * 20, def.agl[0], def.agl[1]);
        }
      }
      this.points = pts;
      this.taken = pts.map(() => false);
      const geo = new THREE.CylinderGeometry(3, 3, 0.7, 20);
      geo.rotateX(Math.PI / 2);
      this.mesh = new THREE.InstancedMesh(geo, new THREE.MeshStandardMaterial({ color: 0xffc928, emissive: 0x6a4a00, metalness: 0.8, roughness: 0.25 }), pts.length);
      this.mesh.frustumCulled = false;
      scene.add(this.mesh);
      this.angle = 0;
      this.collected = 0;
      this.update(0);
    }
    update(dt) {
      this.angle += dt * 2.5;
      const m = new THREE.Matrix4(), q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), this.angle);
      const zero = new THREE.Vector3(0, 0, 0), one = new THREE.Vector3(1, 1, 1);
      this.points.forEach((p, i) => {
        m.compose(p, q, this.taken[i] ? zero : one);
        this.mesh.setMatrixAt(i, m);
      });
      this.mesh.instanceMatrix.needsUpdate = true;
    }
    /** Returns the indices collected this frame. */
    check(pos, radius) {
      const got = [];
      this.points.forEach((p, i) => {
        if (!this.taken[i] && p.distanceToSquared(pos) < radius * radius) { this.taken[i] = true; this.collected++; got.push(i); }
      });
      return got;
    }
    remaining() { return this.points.filter((p, i) => !this.taken[i]); }
    dispose() { this.scene.remove(this.mesh); this.mesh.geometry.dispose(); this.mesh.material.dispose(); }
  }

  /** A rectangular tunnel built along a Catmull–Rom path, with gates and solid walls. */
  class Tunnel {
    constructor(scene, def, start) {
      this.scene = scene;
      this.w = def.width; this.h = def.height;
      const pts = def.path.map(([x, z, agl]) => new THREE.Vector3(x, groundAt(x, z) + agl, z));
      liftCourse(pts, def.height / 2 + 8, start);
      const curve = new THREE.CatmullRomCurve3(pts, false, 'centripetal');
      // Raise control points until the tunnel floor clears the terrain everywhere.
      for (let pass = 0; pass < 4; pass++) {
        let changed = false;
        for (let k = 0; k <= 200; k++) {
          const p = curve.getPointAt(k / 200);
          const deficit = groundAt(p.x, p.z) + 6 - (p.y - this.h / 2);
          if (deficit > 0) { pts[Math.round((k / 200) * (pts.length - 1))].y += deficit + 2; changed = true; }
        }
        if (!changed) break;
      }
      this.curve = curve;
      this.length = curve.getLength();
      const n = Math.max(4, Math.round(this.length / def.spacing));
      const up = new THREE.Vector3(0, 1, 0);
      this.gates = [];
      for (let i = 0; i <= n; i++) {
        const t = i / n;
        const p = curve.getPointAt(t), tan = curve.getTangentAt(t);
        const side = new THREE.Vector3().crossVectors(tan, up).normalize();
        const u = new THREE.Vector3().crossVectors(side, tan).normalize();
        this.gates.push({ p, t: tan, s: side, u });
      }
      // Walls: four slabs per segment (instanced), frames at every gate (instanced, glowing).
      const segs = this.gates.length - 1;
      const wallGeo = new THREE.BoxGeometry(1, 1, 1);
      this.walls = new THREE.InstancedMesh(wallGeo, new THREE.MeshLambertMaterial({ color: 0x5ad1ff, transparent: true, opacity: 0.22, depthWrite: false, side: THREE.DoubleSide }), segs * 4);
      this.frames = new THREE.InstancedMesh(wallGeo, new THREE.MeshBasicMaterial({ color: 0x9ff3ff }), (segs + 1) * 4);
      const m = new THREE.Matrix4(), basis = new THREE.Matrix4(), q = new THREE.Quaternion(), sc = new THREE.Vector3(), c = new THREE.Vector3();
      let wi = 0, fi = 0;
      const place = (mesh, idx, center, g, sx, sy, sz) => {
        basis.makeBasis(g.s, g.u, g.t);
        q.setFromRotationMatrix(basis);
        m.compose(center, q, sc.set(sx, sy, sz));
        mesh.setMatrixAt(idx, m);
      };
      for (let i = 0; i < segs; i++) {
        const a = this.gates[i], b = this.gates[i + 1];
        const len = a.p.distanceTo(b.p) + 0.5;
        const mid = new THREE.Vector3().addVectors(a.p, b.p).multiplyScalar(0.5);
        const g = { s: a.s.clone().add(b.s).normalize(), u: a.u.clone().add(b.u).normalize(), t: b.p.clone().sub(a.p).normalize() };
        place(this.walls, wi++, c.copy(mid).addScaledVector(g.s, this.w / 2), g, 0.4, this.h, len);
        place(this.walls, wi++, c.copy(mid).addScaledVector(g.s, -this.w / 2), g, 0.4, this.h, len);
        place(this.walls, wi++, c.copy(mid).addScaledVector(g.u, this.h / 2), g, this.w, 0.4, len);
        place(this.walls, wi++, c.copy(mid).addScaledVector(g.u, -this.h / 2), g, this.w, 0.4, len);
      }
      for (const g of this.gates) {
        place(this.frames, fi++, c.copy(g.p).addScaledVector(g.s, this.w / 2), g, 1.2, this.h + 1.2, 1.2);
        place(this.frames, fi++, c.copy(g.p).addScaledVector(g.s, -this.w / 2), g, 1.2, this.h + 1.2, 1.2);
        place(this.frames, fi++, c.copy(g.p).addScaledVector(g.u, this.h / 2), g, this.w + 1.2, 1.2, 1.2);
        place(this.frames, fi++, c.copy(g.p).addScaledVector(g.u, -this.h / 2), g, this.w + 1.2, 1.2, 1.2);
      }
      this.walls.frustumCulled = this.frames.frustumCulled = false;
      this.walls.renderOrder = 4;
      scene.add(this.walls, this.frames);
      this.next = 0;
      this.hitCooldown = 0;
    }
    local(i, pos) {
      const g = this.gates[i];
      const d = tmpV.copy(pos).sub(g.p);
      return { x: d.dot(g.s), y: d.dot(g.u), z: d.dot(g.t) };
    }
    /**
     * Gate progress + wall collision. Mutates the physics state on wall contact.
     * Returns { passed, missed, hit, finished }.
     */
    update(dt, prev, cur, state) {
      const out = { passed: false, missed: false, hit: false, finished: false };
      this.hitCooldown -= dt;
      if (this.next < this.gates.length) {
        const g = this.gates[this.next];
        const a = tmpV2.copy(prev).sub(g.p).dot(g.t), b = tmpV2.copy(cur).sub(g.p).dot(g.t);
        if (a < 0 && b >= 0) {
          const l = this.local(this.next, cur);
          if (Math.abs(l.x) < this.w / 2 + 2 && Math.abs(l.y) < this.h / 2 + 2) {
            this.next++; out.passed = true;
            if (this.next >= this.gates.length) out.finished = true;
          } else if (this.next > 0) out.missed = true;
        }
      }
      // Walls only matter once inside (between the first and last gate).
      if (this.next > 0 && this.next < this.gates.length) {
        let best = Math.max(0, this.next - 1);
        const l = this.local(best, cur);
        const mx = this.w / 2 - 2.2, my = this.h / 2 - 1.6;
        const ox = Math.abs(l.x) - mx, oy = Math.abs(l.y) - my;
        if ((ox > 0 || oy > 0) && Math.abs(l.x) < this.w / 2 + 12 && Math.abs(l.y) < this.h / 2 + 12) {
          const g = this.gates[best];
          const n = new THREE.Vector3();
          if (ox > 0) n.addScaledVector(g.s, Math.sign(l.x) * ox);
          if (oy > 0) n.addScaledVector(g.u, Math.sign(l.y) * oy);
          // Push back inside and reflect the outward velocity (inelastic bounce).
          state.pos.x -= n.x; state.pos.y -= n.y; state.pos.z -= n.z;
          const nn = n.clone().normalize();
          const vOut = state.vel.x * nn.x + state.vel.y * nn.y + state.vel.z * nn.z;
          if (vOut > 0) { state.vel.x -= 1.5 * vOut * nn.x; state.vel.y -= 1.5 * vOut * nn.y; state.vel.z -= 1.5 * vOut * nn.z; }
          if (this.hitCooldown <= 0) { out.hit = true; this.hitCooldown = 0.5; }
        }
      }
      return out;
    }
    get nextPoint() { return this.gates[Math.min(this.next, this.gates.length - 1)].p; }
    dispose() { this.scene.remove(this.walls, this.frames); this.walls.geometry.dispose(); this.walls.material.dispose(); this.frames.material.dispose(); }
  }

  /** Escort drone following a spline at constant speed. */
  class Drone {
    constructor(scene, def, start) {
      this.scene = scene;
      const pts = def.path.map(([x, z, agl]) => new THREE.Vector3(x, groundAt(x, z) + agl, z));
      liftCourse(pts, 45, start);
      this.curve = new THREE.CatmullRomCurve3(pts, false, 'centripetal');
      this.length = this.curve.getLength();
      this.speed = def.speed;
      this.u = 0;
      const g = new THREE.Group();
      const body = new THREE.MeshStandardMaterial({ color: 0xe8eef5, metalness: 0.3, roughness: 0.4, flatShading: true });
      const accent = new THREE.MeshStandardMaterial({ color: 0x18c08a, flatShading: true });
      const fus = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.3, 4, 8), body); fus.rotation.x = Math.PI / 2; g.add(fus);
      const wing = new THREE.Mesh(new THREE.BoxGeometry(7, 0.15, 1.1), body); g.add(wing);
      const tail = new THREE.Mesh(new THREE.BoxGeometry(2.4, 0.12, 0.6), accent); tail.position.z = -1.8; g.add(tail);
      const cross = new THREE.Mesh(new THREE.BoxGeometry(0.6, 0.6, 0.6), accent); cross.position.set(0, 0.45, 0.4); g.add(cross);
      this.light = new THREE.Mesh(new THREE.SphereGeometry(0.35, 8, 6), new THREE.MeshBasicMaterial({ color: 0x40ff90 }));
      this.light.position.set(0, 0.8, 0); g.add(this.light);
      g.scale.setScalar(1.6);
      this.group = g;
      scene.add(g);
      this.pos = new THREE.Vector3();
      this.update(0);
      this.blink = 0;
    }
    update(dt) {
      this.u = Math.min(1, this.u + (this.speed * dt) / this.length);
      this.curve.getPointAt(this.u, this.pos);
      const tan = this.curve.getTangentAt(this.u);
      this.group.position.copy(this.pos);
      this.group.lookAt(tmpV.copy(this.pos).add(tan));
      this.blink += dt;
      this.light.visible = (this.blink % 1) < 0.5;
    }
    get done() { return this.u >= 1; }
    dispose() { this.scene.remove(this.group); this.group.traverse((o) => { if (o.geometry) o.geometry.dispose(); }); }
  }

  /** The Iron Zeppelin boss: circling airship with weak-point rings and homing mines. */
  class Zeppelin {
    constructor(scene, def, effects) {
      this.scene = scene; this.def = def; this.effects = effects;
      this.center = new THREE.Vector3(def.center[0], 0, def.center[1]);
      this.angle = 0;
      this.altitude = groundAt(def.center[0], def.center[1]) + def.agl;
      const g = new THREE.Group();
      const iron = new THREE.MeshStandardMaterial({ color: 0x4a4e57, metalness: 0.6, roughness: 0.5, flatShading: true });
      const red = new THREE.MeshStandardMaterial({ color: 0x8a1d22, metalness: 0.3, roughness: 0.6, flatShading: true });
      const hull = new THREE.Mesh(new THREE.SphereGeometry(1, 24, 14), iron);
      hull.scale.set(18, 18, 70); g.add(hull);
      for (const z of [-30, 0, 30]) { const band = new THREE.Mesh(new THREE.CylinderGeometry(18.4, 18.4, 3, 24, 1, true), red); band.rotation.x = Math.PI / 2; band.position.z = z; band.scale.setScalar(1 - Math.abs(z) / 140); g.add(band); }
      for (let i = 0; i < 4; i++) {
        const fin = new THREE.Mesh(new THREE.BoxGeometry(1.2, 22, 16), red);
        fin.position.set(0, 0, -60); fin.rotation.z = i * Math.PI / 2; fin.translateY(14); g.add(fin);
      }
      const gondola = new THREE.Mesh(new THREE.BoxGeometry(8, 6, 28), iron); gondola.position.set(0, -20, 10); g.add(gondola);
      this.hull = g;
      scene.add(g);
      this.weakPoints = [];
      const offsets = [[-36, -4, 22], [36, -4, 22], [-36, -4, -26], [36, -4, -26]].slice(0, def.weakPoints);
      for (const o of offsets) {
        const r = ringMesh(13, 0xff3060);
        r.position.set(o[0], o[1], o[2]);
        setRingStyle(r, 'boss');
        g.add(r);
        this.weakPoints.push({ ring: r, alive: true });
      }
      // The core hangs below the hull, facing sideways: a crossing pass under the belly.
      this.core = ringMesh(17, 0xffe040);
      this.core.position.set(0, -44, -12);
      this.core.rotation.y = Math.PI / 2;
      setRingStyle(this.core, 'core');
      this.core.visible = false;
      g.add(this.core);
      this.mines = [];
      const mineGeo = new THREE.IcosahedronGeometry(3, 1), mineMat = new THREE.MeshBasicMaterial({ color: 0xff40ff });
      for (let i = 0; i < 10; i++) { const m = new THREE.Mesh(mineGeo, mineMat); m.visible = false; scene.add(m); this.mines.push({ mesh: m, vel: new THREE.Vector3(), life: 0 }); }
      this.mineTimer = def.mineInterval;
      this.dying = 0;
      this.update(0);
    }
    get alive() { return this.weakPoints.filter((w) => w.alive).length; }
    update(dt) {
      if (this.dying > 0) {
        this.dying += dt;
        this.hull.position.y -= dt * (8 + this.dying * 6);
        this.hull.rotation.z += dt * 0.15;
        if (Math.random() < dt * 8) {
          const p = tmpV.set((Math.random() - 0.5) * 30, (Math.random() - 0.5) * 30, (Math.random() - 0.5) * 120).applyMatrix4(this.hull.matrixWorld);
          this.effects.emit('fireball', p, null, 6); this.effects.emit('blackSmoke', p, null, 4);
        }
        return;
      }
      const R = this.def.radius;
      this.angle += (this.def.speed / R) * dt;
      const pos = tmpV.set(this.center.x + Math.cos(this.angle) * R, this.altitude, this.center.z + Math.sin(this.angle) * R);
      const tan = tmpV2.set(-Math.sin(this.angle), 0, Math.cos(this.angle));
      this.hull.position.copy(pos);
      this.hull.lookAt(pos.clone().add(tan));
      this.hull.updateMatrixWorld();
    }
    /** Mines home toward the player; returns damage dealt this frame. */
    updateMines(dt, playerPos) {
      let damage = 0;
      if (this.dying) { for (const m of this.mines) m.mesh.visible = false; return 0; }
      this.mineTimer -= dt;
      if (this.mineTimer <= 0) {
        this.mineTimer = this.def.mineInterval * (0.6 + 0.4 * (this.alive / this.def.weakPoints));
        const m = this.mines.find((x) => x.life <= 0);
        if (m) {
          m.life = 9;
          m.mesh.visible = true;
          m.mesh.position.set(0, -24, 10).applyMatrix4(this.hull.matrixWorld);
          m.vel.set(0, -4, 0);
        }
      }
      for (const m of this.mines) {
        if (m.life <= 0) continue;
        m.life -= dt;
        const to = tmpV.copy(playerPos).sub(m.mesh.position);
        const dist = to.length();
        m.vel.lerp(to.normalize().multiplyScalar(31), Math.min(1, dt * 0.9));
        m.mesh.position.addScaledVector(m.vel, dt);
        m.mesh.rotation.y += dt * 3;
        if (Math.random() < dt * 20) this.effects.emit('mine', m.mesh.position, null, 1, 0.4);
        if (dist < 20) { damage += this.def.mineDamage; this.effects.emit('mine', m.mesh.position, null, 30); m.life = 0; }
        if (m.life <= 0) { m.mesh.visible = false; if (dist >= 20) this.effects.emit('mine', m.mesh.position, null, 12, 0.6); }
      }
      return damage;
    }
    collides(x, y, z) {
      if (this.dying) return false;
      const p = tmpV.set(x, y, z);
      const inv = new THREE.Matrix4().copy(this.hull.matrixWorld).invert();
      p.applyMatrix4(inv);
      return (p.x / 18) ** 2 + (p.y / 18) ** 2 + (p.z / 70) ** 2 < 1 || (Math.abs(p.x) < 4 && Math.abs(p.y + 20) < 3 && Math.abs(p.z - 10) < 14);
    }
    dispose() {
      this.scene.remove(this.hull);
      for (const m of this.mines) this.scene.remove(m.mesh);
      this.hull.traverse((o) => { if (o.geometry) o.geometry.dispose(); });
    }
  }

  /** Landing target decal on a runway. */
  function landingTarget(scene, def) {
    const a = airfield(def.airfield);
    const x = a.x + a.dir.x * def.along, z = a.z + a.dir.z * def.along;
    const tex = AV.Geo.canvasTexture(128, 256, (ctx, w, h) => {
      ctx.clearRect(0, 0, w, h);
      ctx.fillStyle = 'rgba(255,210,40,0.95)';
      ctx.fillRect(8, h / 2 - 6, w - 16, 12);
      ctx.strokeStyle = 'rgba(255,210,40,0.95)'; ctx.lineWidth = 8;
      ctx.beginPath(); ctx.arc(w / 2, h / 2, w * 0.35, 0, Math.PI * 2); ctx.stroke();
      for (let i = 0; i < 3; i++) { ctx.beginPath(); ctx.moveTo(20, 30 + i * 22); ctx.lineTo(w / 2, 50 + i * 22); ctx.lineTo(w - 20, 30 + i * 22); ctx.stroke(); }
    });
    const geo = new THREE.PlaneGeometry(a.width * 0.8, a.width * 1.6);
    geo.rotateX(-Math.PI / 2);
    const m = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -8 }));
    m.position.set(x, T.heightAt(x, z) + 0.2, z);
    m.rotation.y = -a.heading * DEG + Math.PI;
    scene.add(m);
    return { mesh: m, x, z, airfield: a };
  }

  // ===========================================================================
  // Modes
  // ===========================================================================
  class BaseMode {
    constructor(game, params) { this.game = game; this.params = params || {}; this.allowPause = true; }
    enter() {}
    exit() {}
    update() {}
    restart() {}
    onPause() {}
    disposeSession() { if (this.session) { this.session.dispose(); this.session = null; } }
  }

  /** Attract-mode flight behind the main menu. */
  class MenuMode extends BaseMode {
    enter() {
      const w = this.game.world;
      w.setWeather('clear'); w.setWind(3, 240);
      this.session = new FlightSession(this.game, { spawn: { air: [-500, 300, 300, 30], speedFactor: 1 } });
      const s = this.session;
      s.autopilotFn = (state) => {
        P.getTelemetry(state, s.tel);
        const out = autopilot(state, s.tel, { bank: 0.42, altitude: 360 });
        out.throttle = 0.7;
        return out;
      };
      AV.Input.setThrottle(0.7);
      this.game.rig.setMode('orbit');
      this.game.rig.autoOrbit = 0.08; this.game.rig.orbitDist = 34; this.game.rig.orbitPitch = 0.15;
      AV.Audio.setMusicMood('menu');
      this.allowPause = false;
    }
    update(dt) {
      const s = this.session;
      s.update(dt, { pitch: 0, roll: 0, yaw: 0, throttle: 0.7 });
      if (s.crashed && s.crashTime > 2) s.spawn({ air: [-500, 300, 300, 30], speedFactor: 1 });
      s.updateCameraAndEffects(dt, 'orbit');
      AV.Audio.setEngine(s.state.rpm * 0.6, 0.3, true);
    }
    exit() { this.game.rig.autoOrbit = 0; this.disposeSession(); }
  }

  /** Hangar: parked aircraft preview with orbit camera. */
  class HangarMode extends BaseMode {
    enter() {
      this.allowPause = false;
      this.build();
      this.game.rig.setMode('orbit');
      this.game.rig.autoOrbit = 0.15; this.game.rig.orbitDist = 20; this.game.rig.orbitPitch = 0.12;
      AV.Audio.setMusicMood('menu');
    }
    build() {
      this.disposeSession();
      const a = airfield('meadow');
      // Open apron beside the runway, clear of the hangars and tower.
      const x = a.x + a.side.x * (a.width / 2 + 50) + a.dir.x * 260, z = a.z + a.side.z * (a.width / 2 + 50) + a.dir.z * 260;
      // previewId: a stock aircraft id or 'custom:<designId>' chosen in the hangar list.
      const pid = this.previewId || AV.Save.data.hangar.selected;
      const custom = pid.startsWith('custom:') && AV.Creative.getDesign(pid.slice(7));
      const choice = custom ? { design: custom.data } : { aircraftId: pid.startsWith('custom:') ? AV.Save.data.hangar.selected : pid };
      this.session = new FlightSession(this.game, Object.assign({ spawn: { point: { x, y: T.heightAt(x, z) + 1, z, heading: (a.heading + 90) * DEG, speed: 0 } } }, choice));
      const st = this.session.state;
      st.pos.y = T.heightAt(x, z) + this.session.spec.gearHeight;
      st.vel.x = st.vel.y = st.vel.z = 0;
      st.gearPos = 1; st.onGround = true;
      this.session.frozen = true;
      this.session.syncVisual(0);
      this.idle = 0;
    }
    refresh() { this.game.rig.ready = true; this.build(); }
    preview(id) { this.previewId = id; this.refresh(); }
    update(dt) {
      const s = this.session;
      this.idle += dt;
      s.state.rpm = 0.25; s.state.throttle = 0.05;
      s.state.elevator = Math.sin(this.idle * 0.8) * 0.6; s.state.aileron = Math.sin(this.idle * 0.6) * 0.6; s.state.rudder = Math.sin(this.idle * 0.5) * 0.5;
      s.state.flaps = 0.5 + Math.sin(this.idle * 0.3) * 0.5;
      s.update(dt, { pitch: 0, roll: 0, yaw: 0, throttle: 0 });
      s.updateCameraAndEffects(dt, 'orbit');
      AV.Audio.setEngine(0.2, 0.05, true);
    }
    exit() { this.game.rig.autoOrbit = 0; this.disposeSession(); }
  }

  // ---------------------------------------------------------------------------
  // Crash round (Aviator) mode
  // ---------------------------------------------------------------------------
  class CrashMode extends BaseMode {
    enter() {
      const w = this.game.world;
      w.setWeather('clear'); w.setWind(2, 200);
      this.W = AV.Economy.Wallet;
      this.cfg = AV.Economy.CRASH_DISTRIBUTION;
      // Custom designs fly crash rounds too; fuel never decides a round.
      this.session = new FlightSession(this.game, Object.assign({ spawn: { airfield: 'meadow' }, infiniteFuel: true }, AV.Creative.flightAircraft()));
      this.game.rig.setMode('chase');
      this.game.rig.distanceScale = 1.35;
      this.game.rig.sideOffset = 7;
      AV.UI.crash.show(true);
      AV.Audio.setMusicMood('crash');
      this.startBetting();
    }
    startBetting() {
      this.phase = 'betting';
      this.timer = this.cfg.bettingSeconds;
      this.multiplier = 1;
      this.round = this.W.nextRound();
      this.session.spawn({ airfield: 'meadow' });
      this.session.boost = 1;
      this.session.autopilotFn = () => ({ pitch: 0, roll: 0, yaw: 0, throttle: 0, brake: true });
      this.game.rig.setMode('chase');
      this.W.activateQueued();
      AV.UI.crash.phase('betting', { round: this.round, timer: this.timer });
      this.lastTick = Math.ceil(this.timer);
    }
    startFlight() {
      this.phase = 'flying';
      this.flightTime = 0;
      this.outcome = this.round.crashPoint < 1.3 || parseInt(this.round.hash[1], 16) % 2 === 0 ? 'explode' : 'flyaway';
      const s = this.session;
      const turnHeading = 70 * DEG;
      s.autopilotFn = (state) => {
        P.getTelemetry(state, s.tel);
        const agl = state.pos.y - groundAt(state.pos.x, state.pos.z);
        let target;
        if (state.onGround) target = { pitch: state.airspeed > s.spec.stallSpeed * 1.15 ? 0.2 : 0, bank: 0 };
        else {
          // Climb harder as the multiplier grows; swing gently toward the sea once clear of the ground.
          const climb = clamp(0.16 + Math.log(this.multiplier) * 0.05, 0.16, 0.42);
          target = { pitch: agl < 40 ? 0.14 : climb, heading: agl > 120 ? turnHeading + Math.sin(this.flightTime * 0.15) * 0.25 : 0, maxBank: 0.35 };
        }
        const out = autopilot(state, s.tel, target);
        if (state.onGround && state.airspeed > s.spec.stallSpeed * 1.05) out.pitch = 1;  // rotate briskly
        out.throttle = 1;
        return out;
      };
      AV.UI.crash.phase('flying', { round: this.round });
      AV.Audio.play('go');
    }
    crashRound() {
      this.phase = 'crashed';
      this.timer = this.cfg.cooldownSeconds;
      const s = this.session;
      if (this.outcome === 'flyaway' && !s.state.onGround) {
        // The plane bolts for the horizon; camera stays behind.
        s.boost = 12;
        s.autopilotFn = (state) => { P.getTelemetry(state, s.tel); const o = autopilot(state, s.tel, { pitch: 0.55, bank: 0 }); o.throttle = 1; return o; };
        this.game.rig.pos.copy(this.game.camera.position);
        AV.Audio.play('flyaway');
      } else {
        s.crash('engine');
      }
      const res = this.W.settle(this.round);
      AV.UI.crash.phase('crashed', { round: this.round, outcome: s.crashed ? 'explode' : 'flyaway', lost: res.lost });
      if (res.lost.length) AV.Audio.play('fail');
    }
    handleSlot(i) {
      const slot = this.W.slots[i];
      if (this.phase === 'flying' && slot.status === 'active') this.cashOut(i);
      else if (slot.queued || (slot.status === 'active' && this.phase === 'betting')) { this.W.cancelBet(i, this.phase); AV.Audio.play('cancel'); }
      else {
        const r = this.W.placeBet(i, AV.UI.crash.slotAmount(i), this.phase);
        if (r.ok) { AV.Audio.play('bet'); if (this.phase !== 'betting') AV.UI.toast(`Bet queued for next round`, 'info'); }
        else AV.UI.toast(r.error, 'warn');
      }
      AV.UI.crash.refreshSlots(this.phase, this.multiplier);
    }
    cashOut(i) {
      const r = this.W.cashOut(i, this.multiplier);
      if (r) { AV.Audio.play('cashout'); AV.UI.crash.cashedOut(r); }
    }
    update(dt) {
      const I = AV.Input, s = this.session;
      if (I.consume('cashout1')) this.handleSlot(0);
      if (I.consume('cashout2')) this.handleSlot(1);
      if (I.consume('camera')) { const m = this.game.rig.cycle(); AV.UI.toast(`Camera: ${m}`, 'info'); }
      if (this.phase === 'betting') {
        this.timer -= dt;
        if (Math.ceil(this.timer) !== this.lastTick && this.timer > 0) { this.lastTick = Math.ceil(this.timer); if (this.lastTick <= 3) AV.Audio.play('tick'); }
        if (this.timer <= 0) this.startFlight();
      } else if (this.phase === 'flying') {
        this.flightTime += dt;
        const m = AV.Economy.multiplierAt(this.flightTime);
        this.multiplier = Math.min(m, this.round.crashPoint);
        // Extra thrust: a short, punchy takeoff roll, then the climb accelerates with the multiplier.
        s.boost = (s.state.onGround ? 2.2 : 1.3) + 0.65 * Math.log(this.multiplier);
        for (const r of this.W.checkAuto(this.multiplier)) { AV.Audio.play('cashout'); AV.UI.crash.cashedOut(r); }
        if (m >= this.round.crashPoint) this.crashRound();
        // The seeded crash point alone decides the round: if the aircraft wrecks itself
        // (e.g. a badly balanced custom design), a replacement keeps flying.
        else if (s.crashed && s.crashTime > 1.2) {
          const st = s.state;
          s.spawn({ point: { x: st.pos.x, y: Math.max(st.pos.y, this.game.world.heightAt(st.pos.x, st.pos.z) + 150), z: st.pos.z, heading: s.tel.heading || 0 } });
          AV.UI.toast('Aircraft lost — a replacement is airborne. The round continues.', 'warn');
        }
      } else if (this.phase === 'crashed') {
        this.timer -= dt;
        if (this.timer <= 0) this.startBetting();
      }
      s.update(dt, { pitch: 0, roll: 0, yaw: 0, throttle: 0 });
      const detached = this.phase === 'crashed' && !s.crashed;
      s.updateCameraAndEffects(dt, detached ? 'detached' : undefined);
      AV.UI.crash.update(this.phase, this.multiplier, Math.max(0, this.timer), this.cfg);
      AV.UI.hud.update(s.hud(), { mode: 'crash' });
    }
    restart() { this.startBetting(); }
    exit() {
      // Leaving mid-round forfeits active bets, exactly like a crash.
      if (this.phase === 'flying') this.W.settle(this.round);
      else if (this.phase === 'betting') for (const sl of this.W.slots) if (sl.status === 'active') this.W.cancelBet(sl.index, 'betting');
      for (const sl of this.W.slots) sl.queued = false;
      this.game.rig.distanceScale = 1; this.game.rig.sideOffset = 0;
      AV.UI.crash.show(false);
      this.disposeSession();
    }
  }

  // ---------------------------------------------------------------------------
  // Campaign mission mode
  // ---------------------------------------------------------------------------
  class CampaignMode extends BaseMode {
    enter() {
      this.mission = this.params.mission;
      this.setup();
    }
    setup() {
      const m = this.mission, g = this.game, w = g.world;
      this.cleanupObjects();
      w.setWeather(m.weather || 'clear');
      w.setWind(m.wind ? m.wind[0] : 3, m.wind ? m.wind[1] : 240);
      w.setTimeOfDay(m.time || 12);
      this.disposeSession();
      this.session = new FlightSession(g, { spawn: m.spawn, seed: m.id.length * 31 });
      const s = this.session;
      const start = toV3(s.state.pos, new THREE.Vector3());
      w.prime(start);
      this.objects = {};
      if (m.rings) this.objects.course = new RingCourse(g.scene, m.rings, m.ringRadius || 30, start);
      if (m.coins) this.objects.coins = new CoinField(g.scene, m.coins);
      if (m.tunnel) this.objects.tunnel = new Tunnel(g.scene, m.tunnel, start);
      if (m.drone) this.objects.drone = new Drone(g.scene, m.drone, start);
      if (m.target) this.objects.target = landingTarget(g.scene, m.target);
      if (m.boss) { this.objects.boss = new Zeppelin(g.scene, m.boss, g.effects); s.extraCollide = (x, y, z) => this.objects.boss.collides(x, y, z); }
      this.time = 0;
      this.phase = 'briefing';
      this.countdown = 0;
      this.coinsTaken = 0;
      this.inRangeTime = 0; this.trackedTime = 0; this.outOfRange = 0; this.escortStarted = false;
      this.touchdown = null;
      this.lightningTimer = m.lightning ? m.lightning.interval[1] : 0;
      this.finished = false;
      this.prevPos = start.clone();
      s.frozen = true;
      g.rig.setMode(AV.Save.data.settings.camera === 'orbit' ? 'chase' : AV.Save.data.settings.camera);
      AV.Audio.setMusicMood('flight');
      AV.UI.showBriefing(m, () => this.begin(), () => this.game.goto('campaignSelect'));
    }
    begin() {
      this.phase = 'countdown';
      this.countdown = this.session.state.onGround ? 0.01 : 3;
      AV.UI.hud.show(true);
    }
    restart() { this.setup(); }
    cleanupObjects() {
      if (!this.objects) return;
      for (const o of Object.values(this.objects)) {
        if (o && o.dispose) o.dispose();
        else if (o && o.mesh) this.game.scene.remove(o.mesh);
      }
      this.objects = null;
    }

    objectives() {
      const m = this.mission, o = this.objects, out = [];
      const fmt = AV.Campaign.fmtTime;
      if (o.course) out.push({ text: `${m.type === 'storm' ? 'Beacons' : 'Rings'} ${o.course.index} / ${o.course.rings.length}`, done: o.course.done });
      if (o.coins) out.push({ text: `Coins ${o.coins.collected} / ${m.need} (of ${m.coins.count})`, done: o.coins.collected >= m.need });
      if (o.tunnel) out.push({ text: `Tunnel gates ${o.tunnel.next} / ${o.tunnel.gates.length}`, done: o.tunnel.next >= o.tunnel.gates.length });
      if (o.drone) {
        const pct = this.trackedTime > 0 ? this.inRangeTime / this.trackedTime : 1;
        out.push({ text: `Drone in range ${Math.round(pct * 100)}% (need ${Math.round(m.need * 100)}%)`, done: pct >= m.need, warn: pct < m.need });
        out.push({ text: `Route ${Math.round(o.drone.u * 100)}%`, done: o.drone.done });
      }
      if (o.target) out.push({ text: this.touchdown ? `Touchdown ${this.touchdown.error.toFixed(0)} m from target · ${this.touchdown.sink.toFixed(1)} m/s` : 'Land on the yellow target', done: !!this.touchdown });
      if (o.boss) out.push({ text: o.boss.alive > 0 ? `Weak points ${m.boss.weakPoints - o.boss.alive} / ${m.boss.weakPoints}` : 'Fly through the gold CORE ring under the belly!', done: false });
      if (m.timeLimit) out.push({ text: `Time left ${fmt(Math.max(0, m.timeLimit - this.time))}`, warn: m.timeLimit - this.time < 20 });
      if (m.par) out.push({ text: `Time ${fmt(this.time)} · par ${fmt(m.par)}`, dim: true });
      return out;
    }

    /** Points of interest for screen markers and the minimap. */
    markers() {
      const o = this.objects, list = [];
      if (o.course && !o.course.done) {
        list.push({ pos: o.course.next, kind: 'next', label: o.course.index + 1 });
        const after = o.course.points[o.course.index + 1];
        if (after) list.push({ pos: after, kind: 'upcoming', mapOnly: true });
      }
      if (o.coins) for (const p of o.coins.remaining()) list.push({ pos: p, kind: 'coin', mapOnly: true });
      if (o.coins) {
        const rem = o.coins.remaining();
        const me = this.session.renderPos;
        let best = null, bd = Infinity;
        for (const p of rem) { const d = p.distanceToSquared(me); if (d < bd) { bd = d; best = p; } }
        if (best) list.push({ pos: best, kind: 'coin', label: '◉' });
      }
      if (o.tunnel && o.tunnel.next < o.tunnel.gates.length) list.push({ pos: o.tunnel.nextPoint, kind: 'next', label: '▭' });
      if (o.drone) list.push({ pos: o.drone.pos, kind: 'drone', label: 'DRONE' });
      if (o.target) list.push({ pos: new THREE.Vector3(o.target.x, T.heightAt(o.target.x, o.target.z) + 2, o.target.z), kind: 'next', label: 'TARGET' });
      if (o.boss && !o.boss.dying) {
        list.push({ pos: o.boss.hull.position, kind: 'boss', label: 'ZEPPELIN' });
        if (o.boss.core.visible) list.push({ pos: o.boss.core.getWorldPosition(new THREE.Vector3()), kind: 'next', label: 'CORE' });
        for (const mn of o.boss.mines) if (mn.life > 0) list.push({ pos: mn.mesh.position, kind: 'mine', mapOnly: true });
      }
      return list;
    }

    update(dt) {
      const s = this.session, g = this.game, m = this.mission, o = this.objects;
      if (this.phase === 'countdown') {
        const before = Math.ceil(this.countdown);
        this.countdown -= dt;
        if (Math.ceil(this.countdown) !== before && this.countdown > 0) { AV.Audio.play('tick'); AV.UI.banner(String(Math.ceil(this.countdown)), 'count'); }
        if (this.countdown <= 0) { this.phase = 'flying'; s.frozen = false; AV.Audio.play('go'); AV.UI.banner('GO!', 'go'); }
      }
      const input = AV.Input.state || { pitch: 0, roll: 0, yaw: 0, throttle: 0 };
      if (this.phase === 'flying') s.handleButtons();
      const prev = toV3(s.state.pos, this.prevPos);   // position before this frame's physics
      s.update(dt, this.phase === 'flying' ? input : Object.assign({}, input, { throttle: s.state.throttle }));
      const cur = toV3(s.state.pos, new THREE.Vector3());
      if (this.phase === 'flying') {
        this.time += dt;
        this.updateObjectives(dt, prev, cur);
        if (s.crashed && !this.finished) this.finish(false, crashText(s.crashReason));
        if (m.timeLimit && this.time > m.timeLimit && !this.finished) {
          if (o.coins && o.coins.collected >= m.need) this.finish(true);
          else this.finish(false, 'Out of time');
        }
      }
      if (o.coins) o.coins.update(dt);
      if (o.drone && this.phase === 'flying') o.drone.update(dt);
      if (o.boss) o.boss.update(dt);
      s.updateCameraAndEffects(dt);
      AV.UI.hud.update(s.hud(), { mode: 'campaign', objectives: this.objectives(), markers: this.markers(), title: m.name });
    }

    updateObjectives(dt, prev, cur) {
      const m = this.mission, o = this.objects, s = this.session, fx = this.game.effects;
      if (this.finished) return;
      if (o.course && o.course.check(prev, cur)) {
        AV.Audio.play('ring'); fx.emit('ringBurst', cur, null, 30);
        if (o.course.done && m.type !== 'storm') return this.finish(true);
        if (o.course.done && m.type === 'storm') return this.finish(true);
      }
      if (o.coins) {
        const got = o.coins.check(cur, 10);
        for (const i of got) { AV.Audio.play('coin'); fx.emit('sparkle', o.coins.points[i], null, 20); }
        if (o.coins.collected >= o.coins.points.length) return this.finish(true);
      }
      if (o.tunnel) {
        const r = o.tunnel.update(dt, prev, cur, s.state);
        if (r.passed) AV.Audio.play('tick');
        if (r.hit) { s.state.damage += 0.12 / s.spec.durability; AV.Audio.play('scrape'); fx.shake(0.5); fx.emit('spark', cur, null, 25); if (s.state.damage >= 1) s.crash('structural'); }
        if (r.missed) return this.finish(false, 'You left the tunnel');
        if (r.finished) return this.finish(true);
      }
      if (o.drone) {
        const d = o.drone.pos.distanceTo(cur);
        const inRange = d <= m.drone.range;
        if (inRange) this.escortStarted = true;
        if (this.escortStarted || this.time > 8) {
          this.trackedTime += dt;
          if (inRange) { this.inRangeTime += dt; this.outOfRange = 0; } else this.outOfRange += dt;
        }
        if (this.outOfRange > m.drone.maxOut) return this.finish(false, 'The drone aborted — you were out of range too long');
        if (!inRange && this.outOfRange > 0 && Math.floor(this.outOfRange * 2) !== Math.floor((this.outOfRange - dt) * 2)) AV.Audio.play('warning');
        if (o.drone.done) {
          const frac = this.inRangeTime / Math.max(1, this.trackedTime);
          return frac >= m.need ? this.finish(true, null, { inRange: frac }) : this.finish(false, 'Not enough time near the drone');
        }
      }
      if (o.target) {
        const st = s.state;
        if (!this.touchdown && st.onGround) {
          const onField = T.airfieldAt(st.pos.x, st.pos.z);
          if (onField !== o.target.airfield) return this.finish(false, 'Touched down off the runway');
          const l = T.runwayLocal(onField, st.pos.x, st.pos.z);
          this.touchdown = { error: Math.abs(l.along - m.target.along), sink: st.lastSink };
          AV.UI.toast(`Touchdown: ${this.touchdown.error.toFixed(0)} m from target`, 'info');
        }
        const groundSpeed = Math.hypot(st.vel.x, st.vel.z);
        if (this.touchdown && st.onGround && groundSpeed < 1.5) {
          if (T.airfieldAt(st.pos.x, st.pos.z) !== o.target.airfield) return this.finish(false, 'Rolled off the runway');
          return this.finish(true, null, { landingError: this.touchdown.error, sink: this.touchdown.sink });
        }
        if (this.touchdown && st.onGround && !T.airfieldAt(st.pos.x, st.pos.z) && groundSpeed > 3) return this.finish(false, 'Ran off the runway');
        if (this.time > 240) return this.finish(false, 'Out of time');
      }
      if (m.lightning) {
        this.lightningTimer -= dt;
        if (this.lightningTimer <= 0) {
          const L = m.lightning;
          this.lightningTimer = L.interval[0] + Math.random() * (L.interval[1] - L.interval[0]);
          const inCloud = cur.y > this.game.world.weather.cloudBase - 30;
          const aim = inCloud ? (Math.random() < 0.55 ? 15 : 200) : (Math.random() < 0.12 ? 40 : 250);
          const a = Math.random() * Math.PI * 2, r = aim * (0.3 + Math.random());
          const strike = this.game.world.lightning(cur.x + Math.cos(a) * r, cur.z + Math.sin(a) * r, AV.Save.data.settings.reducedMotion);
          AV.Audio.play('thunder');
          const horiz = Math.hypot(strike.x - cur.x, strike.z - cur.z);
          if (horiz < L.radius && cur.y < this.game.world.weather.cloudBase + 80) {
            s.state.damage += L.damage / s.spec.durability;
            fx.shake(1.0); fx.emit('spark', cur, null, 40); AV.Audio.play('hit');
            AV.UI.toast('Lightning strike!', 'danger');
            if (s.state.damage >= 1) s.crash('lightning');
          }
        }
      }
      if (o.boss) {
        const b = o.boss;
        for (const wp of b.weakPoints) {
          if (wp.alive && crossesRing(wp.ring, prev, cur, wp.ring.userData.radius)) {
            wp.alive = false; wp.ring.visible = false;
            const p = wp.ring.getWorldPosition(new THREE.Vector3());
            fx.emit('fireball', p, null, 25); fx.emit('blackSmoke', p, null, 20); fx.shake(0.8);
            AV.Audio.play('hit'); AV.Audio.play('ring');
            AV.UI.toast(b.alive ? `Weak point destroyed! ${b.alive} left` : 'Core exposed — cross under the belly through the gold ring!', 'good');
            if (!b.alive) b.core.visible = true;
          }
        }
        if (!b.alive && b.core.visible && crossesRing(b.core, prev, cur, b.core.userData.radius)) {
          b.core.visible = false; b.dying = 0.01;
          const p = b.hull.position.clone();
          fx.explode(p, { x: 0, y: 0, z: 0 }, (x, z) => T.heightAt(x, z), 0x4a4e57);
          AV.Audio.play('boom');
          this.bossKill = 3;
        }
        if (this.bossKill !== undefined) { this.bossKill -= dt; if (this.bossKill <= 0) return this.finish(true); }
        const dmg = b.updateMines(dt, cur);
        if (dmg > 0) {
          s.state.damage += dmg / s.spec.durability; fx.shake(0.9); AV.Audio.play('hit'); AV.UI.toast('Mine hit!', 'danger');
          if (s.state.damage >= 1) s.crash('mine');
        }
      }
    }

    finish(success, reason, extra) {
      if (this.finished) return;
      this.finished = true;
      this.phase = 'result';
      const s = this.session, m = this.mission;
      const result = Object.assign({
        success, reason, time: this.time, damage: s.state.damage,
        coins: this.objects.coins ? this.objects.coins.collected : 0,
        coinsCollected: this.objects.coins ? this.objects.coins.collected : 0,
        inRange: this.trackedTime > 0 ? this.inRangeTime / this.trackedTime : 0,
      }, extra || {});
      const record = success ? AV.Campaign.recordResult(m, result) : { stars: 0, coins: 0, unlocks: [] };
      AV.Audio.play(success ? 'win' : 'fail');
      const delay = success ? 1.2 : 2.2;
      setTimeout(() => {
        if (this.game.mode !== this) return;
        s.frozen = true;
        AV.UI.showResult(m, result, record, {
          retry: () => this.setup(),
          next: () => {
            const list = AV.Campaign.MISSIONS;
            const nx = list[list.indexOf(m) + 1];
            if (nx && AV.Campaign.isMissionUnlocked(nx)) this.game.goto('campaign', { mission: nx });
            else this.game.goto('campaignSelect');
          },
          menu: () => this.game.goto('campaignSelect'),
        });
      }, delay * 1000);
    }
    exit() { this.cleanupObjects(); this.disposeSession(); AV.UI.hideCards(); }
  }

  function crashText(reason) {
    return {
      water: 'Ditched in the water', terrain: 'Flew into the terrain', impact: 'Impact with the ground', belly: 'Belly landing — the gear was up',
      hardLanding: 'Landing was too hard', wingStrike: 'Wingtip struck the ground', obstacle: 'Collided with an obstacle',
      structural: 'Airframe overstressed', lightning: 'Destroyed by lightning', mine: 'Destroyed by a mine', engine: 'Engine failure',
      hazard: 'Touched a hazard',
    }[reason] || 'Crashed';
  }

  // ---------------------------------------------------------------------------
  // Free flight sandbox
  // ---------------------------------------------------------------------------
  class FreeFlightMode extends BaseMode {
    enter() {
      const p = this.params || {}, w = this.game.world;
      this.returnTo = p.returnTo || null;
      this.map = p.map || null;
      if (this.map) w.setCustomMap(this.map);
      const aircraft = p.design ? { design: p.design } : AV.Creative.flightAircraft();
      this.spawnDef = this.map ? { mapStart: true } : { airfield: 'meadow' };
      this.session = new FlightSession(this.game, Object.assign({ spawn: this.spawnDef }, aircraft));
      if (this.map) w.prime(toV3(this.session.state.pos, new THREE.Vector3()));
      this.game.rig.setMode(AV.Save.data.settings.camera);
      this.photo = false;
      AV.Audio.setMusicMood('flight');
      AV.UI.freeflight.show(true, this);
      AV.UI.editorReturn(this.returnTo, p.label);
      const what = this.returnTo === 'planeBuilder' ? `Test flight: ${p.label || 'custom design'}` : this.map ? `Custom map: ${this.map.name}` : 'Free flight';
      AV.UI.toast(`${what} — press M for the panel, P for photo mode${this.returnTo ? ', Esc to pause (Back to editor)' : ''}.`, 'info', 5);
      this.respawnTimer = 0;
      this.resetMapPlay();
    }
    /** Gameplay tags of a custom map: ordered checkpoints, coins and a goal pad. */
    resetMapPlay() {
      if (!this.map) { this.play = null; return; }
      const rt = this.game.world.custom.runtime;
      const view = this.game.world.custom.view;
      for (const c of rt.coins) view.setHidden(c.id, false);
      this.play = { rt, view, next: 0, coins: new Set(), time: 0, done: false, prev: toV3(this.session.state.pos, new THREE.Vector3()) };
    }
    respawnAt(def) {
      this.session.spawn(def);
      this.game.world.prime(toV3(this.session.state.pos, new THREE.Vector3()));
      this.respawnTimer = 0;
      if (this.play) this.play.prev.copy(toV3(this.session.state.pos, tmpV));
    }
    teleport(landmark) {
      if (this.map) return;
      const ang = Math.random() * Math.PI * 2;
      const x = landmark.x + Math.cos(ang) * 900, z = landmark.z + Math.sin(ang) * 900;
      const heading = Math.atan2(landmark.x - x, -(landmark.z - z));
      this.respawnAt({ air: [x, z, 220, heading / DEG], speedFactor: 1 });
      AV.UI.toast(`Approaching ${landmark.name}`, 'info');
    }
    togglePhoto() {
      this.photo = !this.photo;
      this.session.frozen = this.photo;
      AV.UI.photoMode(this.photo);
      if (this.photo) { this.prevCam = this.game.rig.mode; this.game.rig.setMode('orbit'); this.game.rig.orbitDist = 18; }
      else this.game.rig.setMode(this.prevCam || 'chase');
    }
    updateMapPlay(dt) {
      const pl = this.play, s = this.session;
      if (!pl || s.crashed) return;
      const cur = toV3(s.state.pos, new THREE.Vector3());
      const p3 = (v) => [v.x, v.y, v.z];
      if (!pl.done) pl.time += dt;
      const cps = pl.rt.checkpoints;
      if (pl.next < cps.length && pl.rt.crossesCheckpoint(cps[pl.next], p3(pl.prev), p3(cur))) {
        pl.next++; AV.Audio.play('ring'); this.game.effects.emit('ringBurst', cur, null, 30);
        if (pl.next === cps.length && pl.rt.goals.length) AV.UI.toast('All checkpoints passed — land on the goal pad!', 'good');
      }
      for (const c of pl.rt.coins) {
        if (pl.coins.has(c.id)) continue;
        const r = Math.max(8, c.scale[0]);
        if ((c.pos[0] - cur.x) ** 2 + (c.pos[1] - cur.y) ** 2 + (c.pos[2] - cur.z) ** 2 < r * r) {
          pl.coins.add(c.id); pl.view.setHidden(c.id, true); AV.Audio.play('coin'); this.game.effects.emit('sparkle', cur, null, 20);
        }
      }
      const g = pl.rt.goals[0];
      if (g && !pl.done && s.state.onGround && pl.rt.overPad(g, cur.x, cur.z) && Math.hypot(s.state.vel.x, s.state.vel.z) < 6) {
        if (pl.next < cps.length) { if (!pl.warned) { AV.UI.toast(`Pass all checkpoints first (${pl.next}/${cps.length})`, 'warn'); pl.warned = true; } }
        else {
          pl.done = true;
          AV.Audio.play('win');
          AV.UI.banner('GOAL!', 'go');
          AV.UI.toast(`Goal reached in ${AV.Campaign.fmtTime(pl.time)} · coins ${pl.coins.size}/${pl.rt.coins.length}`, 'good', 6);
        }
      }
      pl.prev.copy(cur);
    }
    mapObjectives() {
      const pl = this.play;
      if (!pl) return { objectives: null, markers: [] };
      const cps = pl.rt.checkpoints, out = [], markers = [];
      if (cps.length) out.push({ text: `Checkpoints ${pl.next} / ${cps.length}`, done: pl.next >= cps.length });
      if (pl.rt.coins.length) out.push({ text: `Coins ${pl.coins.size} / ${pl.rt.coins.length}`, done: pl.coins.size === pl.rt.coins.length });
      if (pl.rt.goals.length) out.push({ text: pl.done ? 'Goal reached!' : 'Land on the goal pad', done: pl.done });
      out.push({ text: `Time ${AV.Campaign.fmtTime(pl.time)}`, dim: true });
      const v = (a) => new THREE.Vector3(a[0], a[1], a[2]);
      if (pl.next < cps.length) markers.push({ pos: v(cps[pl.next].pos), kind: 'next', label: pl.next + 1 });
      else if (pl.rt.goals.length && !pl.done) markers.push({ pos: v(pl.rt.goals[0].pos), kind: 'next', label: 'GOAL' });
      for (const c of pl.rt.coins) if (!pl.coins.has(c.id)) markers.push({ pos: v(c.pos), kind: 'coin', mapOnly: true });
      return { objectives: out, markers };
    }
    update(dt) {
      const s = this.session, I = AV.Input;
      if (I.consume('photo')) this.togglePhoto();
      if (I.consume('map')) AV.UI.freeflight.toggle();
      if (!this.photo) s.handleButtons();
      s.update(dt, I.state || { pitch: 0, roll: 0, yaw: 0, throttle: 0 });
      if (s.crashed) {
        this.respawnTimer += dt;
        if (this.respawnTimer > 3.5) {
          const st = s.state;
          AV.UI.toast(`${crashText(s.crashReason)}. Respawning…`, 'warn');
          if (this.map) { this.respawnAt(this.spawnDef); this.resetMapPlay(); }
          else this.respawnAt({ air: [st.pos.x, st.pos.z, 250, s.tel.heading / DEG], speedFactor: 1 });
        }
      }
      if (this.play) { this.updateMapPlay(dt); this.game.world.custom.view.animate(dt); }
      s.updateCameraAndEffects(dt, this.photo ? 'photo' : undefined);
      const mo = this.mapObjectives();
      AV.UI.hud.update(s.hud(), { mode: 'free', markers: mo.markers, objectives: mo.objectives, title: this.map ? this.map.name : this.game.world.biomeAt(s.state.pos.x, s.state.pos.z) });
    }
    restart() { this.respawnAt(this.spawnDef); this.resetMapPlay(); }
    onPause(p) { if (p && this.photo) this.togglePhoto(); }
    exit() {
      if (this.photo) this.togglePhoto();
      AV.UI.freeflight.show(false);
      AV.UI.editorReturn(null);
      this.disposeSession();
      if (this.map) this.game.world.setCustomMap(null);
    }
  }

  AV.Modes = { BaseMode, CameraRig, FlightSession, MenuMode, HangarMode, CrashMode, CampaignMode, FreeFlightMode, autopilot, resolveSpawn, liftCourse, crossesRing };
})(window.AV);
