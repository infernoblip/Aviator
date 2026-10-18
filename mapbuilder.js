/* mapbuilder.js — the Map Builder editor mode.
 *
 * Maps use the shared format in AV.MapFormat; the same MapView renders them here
 * and in free flight, and the same runtime drives validation and collisions.
 */
window.AV = window.AV || {};
(function (AV) {
  'use strict';
  const E = AV.EditorCore, F = AV.MapFormat;
  const DEG = Math.PI / 180;
  const Session = { map: null, history: null, savedId: null, dirty: false };
  const PALETTE_ORDER = ['cube', 'sphere', 'cylinder', 'cone', 'ramp', 'arch', 'torus', 'tunnelBox', 'tunnelRound', 'start', 'goal', 'checkpoint', 'coin'];
  const TOOLS = [['select', 'Select', 'Q'], ['move', 'Move', 'W'], ['rotate', 'Rotate', 'E'], ['scale', 'Scale', 'S'], ['place', 'Place', 'P'], ['tunnel', 'Tunnel', 'T']];

  const HELP = [
    ['Q / W / E / S', 'Select, Move, Rotate and Scale tools'], ['P', 'Place tool (uses the highlighted palette shape)'], ['T', 'Tunnel tool: click points, Enter to finish, Backspace removes the last point'],
    ['1 … 9', 'Pick palette shape'], ['Click', 'Select (Shift = add/remove, Alt = ignore groups)'], ['Drag empty space', 'Box select (Select tool)'],
    ['Drag selection', 'Move (Shift = vertical); Rotate / Scale tools drag to rotate or resize'],
    ['Arrows / PgUp / PgDn', 'Move selection by one grid step (Shift ×5)'], ['[ / ]', 'Rotate selection −/+ around Y (90°, or 15° with rotation snap off)'],
    ['{ / }', 'Rotate around X'], ['Alt+[ / Alt+]', 'Rotate around Z'], ['+ / −', 'Scale selection up / down'],
    ['Ctrl+D', 'Duplicate'], ['Ctrl+G / Ctrl+Shift+G', 'Group / ungroup'], ['Ctrl+A', 'Select all'], ['Delete', 'Delete selection (or tunnel point)'],
    ['H / C / M', 'Toggle hazard / collidable, cycle material'], ['N / J', 'Toggle grid snap / face snap'], ['Tab / Shift+Tab', 'Select next / previous shape'],
    ['Enter', 'Place at cursor (Place tool) / finish tunnel'], ['Ctrl+Z / Ctrl+Shift+Z', 'Undo / redo'], ['F', 'Frame selection'],
    ['Right-drag / Alt+Arrows', 'Orbit'], ['Middle-drag / Shift+right-drag', 'Pan'], ['Wheel', 'Zoom'], ['Ctrl+S', 'Save'], ['Ctrl+Enter', 'Test play'], ['Esc', 'Cancel / deselect / leave'], ['?', 'This help'],
  ];

  class MapBuilderMode extends AV.Modes.BaseMode {
    enter() {
      this.allowPause = false;
      this.canvas = this.game.renderer.domElement;
      if (!Session.map) this.loadMap(F.sampleMap(), null);
      if (this.params && this.params.map) this.loadMap(this.params.map, this.params.savedId || null);
      this.core = new E.EditorScene({ background: 0x87b5e0, far: 20000 });
      this.cam = new E.OrbitControls(this.core.camera, { dist: 600, minDist: 8, maxDist: 9000 });
      this.cam.yaw = 0.6; this.cam.pitch = 0.75;
      this.cam.target.set(0, 0, -400);
      this.selection = new Set();
      this.hover = null;
      this.tool = 'select';
      this.paletteType = 'cube';
      this.grid = 5; this.snapGrid = true; this.snapFace = true; this.snapRot = true;
      this.view = new F.MapView({ colorFor: (id, base) => this.colorFor(id, base) });
      this.core.add(this.view.group);
      this.raycaster = new THREE.Raycaster();
      this.ndc = new THREE.Vector2();
      this.handleMat = new THREE.MeshBasicMaterial({ color: 0xffd23f, depthTest: false });
      this.handleGeo = new THREE.SphereGeometry(1, 12, 8);
      this.handles = [];
      this.selBox = new THREE.Box3Helper(new THREE.Box3(), 0x35e0ff);
      this.selBox.visible = false;
      this.core.add(this.selBox);
      this.buildUI();
      this.bindEvents();
      this.rebuildEnvironment();
      this.refresh();
      AV.Audio.setMusicMood('menu');
      AV.Input.showTouch(false);
    }

    loadMap(map, savedId) {
      Session.map = F.serializeMap(map);
      Session.history = new E.History(60);
      Session.history.reset(JSON.stringify(Session.map));
      Session.savedId = savedId;
      Session.dirty = false;
    }
    get map() { return Session.map; }

    // ------------------------------------------------------------------ document
    shape(id) { return this.map.shapes.find((s) => s.id === id) || null; }
    tunnel(id) { return (this.map.tunnels || []).find((t) => t.id === id) || null; }
    item(id) { return this.shape(id) || this.tunnel(id); }

    commit() {
      if (Session.history.push(JSON.stringify(this.map))) Session.dirty = true;
      this.refresh();
    }
    undo() { const s = Session.history.undo(); if (s) this.restore(s); else E.sound('invalid'); }
    redo() { const s = Session.history.redo(); if (s) this.restore(s); else E.sound('invalid'); }
    restore(s) {
      Session.map = JSON.parse(s);
      Session.dirty = true;
      for (const id of [...this.selection]) if (!this.item(id)) this.selection.delete(id);
      this.rebuildEnvironment();
      this.refresh();
      E.sound('snap');
    }

    refresh() {
      for (const id of [...this.selection]) if (!this.item(id)) this.selection.delete(id);
      this.runtime = F.createRuntime(this.map);
      this.outside = new Set();
      this.warnings = F.validateMap(this.map, this.runtime);
      for (const w of this.warnings) if (w.id && /outside/.test(w.msg)) this.outside.add(w.id);
      this.view.sync(this.map);
      this.updateSelectionVisuals();
      this.renderPanels();
      this.scheduleReachability();
    }

    /** The voxel flood fill is heavier, so it runs after edits settle. */
    scheduleReachability() {
      clearTimeout(this.reachTimer);
      this.reach = { reachable: undefined };
      this.reachTimer = setTimeout(() => {
        if (AV.Game.mode !== this) return;
        this.reach = F.checkReachable(this.map, this.runtime);
        this.renderProblems();
      }, 700);
    }

    colorFor(id, base) {
      const c = new THREE.Color();
      if (this.selection.has(id)) return c.copy(base).lerp(new THREE.Color(0x35e0ff), 0.55);
      if (this.outside && this.outside.has(id)) return c.copy(base).lerp(new THREE.Color(0xff3030), 0.55);
      if (id === this.hover) return c.copy(base).lerp(new THREE.Color(0xffffff), 0.4);
      return null;
    }

    rebuildEnvironment() {
      const st = this.map.settings, sc = this.core;
      if (this.env) for (const o of this.env) { sc.scene.remove(o); o.traverse((x) => { if (x.geometry) x.geometry.dispose(); if (x.material) x.material.dispose(); }); }
      this.env = [];
      const B = st.bound;
      const ground = new THREE.Mesh(new THREE.PlaneGeometry(B * 2, B * 2), new THREE.MeshLambertMaterial({ color: st.groundColor }));
      ground.rotation.x = -Math.PI / 2; ground.position.y = -0.05;
      const div = Math.min(240, Math.round((B * 2) / Math.max(this.grid * 4, 10)));
      const grid = new THREE.GridHelper(B * 2, div, 0x2a3a2a, 0x47603f);
      grid.position.y = 0.02;
      grid.material.transparent = true; grid.material.opacity = 0.55;
      const boundBox = new THREE.Box3Helper(new THREE.Box3(new THREE.Vector3(-B, 0, -B), new THREE.Vector3(B, Math.min(B, 800), B)), 0xff8a3d);
      this.env.push(ground, grid, boundBox);
      if (st.waterEnabled) {
        const w = new THREE.Mesh(new THREE.PlaneGeometry(B * 2.2, B * 2.2), new THREE.MeshLambertMaterial({ color: 0x2d6f9a, transparent: true, opacity: 0.55, depthWrite: false }));
        w.rotation.x = -Math.PI / 2; w.position.y = st.waterLevel;
        this.env.push(w);
      }
      for (const o of this.env) sc.scene.add(o);
      sc.scene.background = new THREE.Color(st.skyColor || skyForHour(st.timeOfDay));
    }

    // ------------------------------------------------------------------ geometry helpers
    /** World AABB half-extents of a shape (from its rotation and scale). */
    halfExtents(s) {
      const R = F.rotationMatrix(s.rot);
      return [0, 1, 2].map((k) => Math.abs(R[k * 3]) * s.scale[0] / 2 + Math.abs(R[k * 3 + 1]) * s.scale[1] / 2 + Math.abs(R[k * 3 + 2]) * s.scale[2] / 2);
    }
    snap(v) { return this.snapGrid ? Math.round(v / this.grid) * this.grid : Math.round(v * 10) / 10; }

    pointerRay(e) {
      E.ndc(e, this.canvas, this.ndc);
      this.raycaster.setFromCamera(this.ndc, this.core.camera);
      return this.raycaster;
    }
    groundHit(e, y) {
      const hit = new THREE.Vector3();
      return this.pointerRay(e).ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 1, 0), -(y || 0)), hit) ? hit : null;
    }

    /** Where a new or moved shape should sit: flush on a face (snap-to-face) or on the ground grid. */
    placement(e, s, ignore) {
      const he = this.halfExtents(s);
      if (this.snapFace) {
        const hit = this.pickAt(e, ignore);
        if (hit && hit.normal) {
          const n = hit.normal.clone().normalize();
          const axis = Math.abs(n.x) > Math.abs(n.y) ? (Math.abs(n.x) > Math.abs(n.z) ? 0 : 2) : (Math.abs(n.y) > Math.abs(n.z) ? 1 : 2);
          const p = [hit.point.x, hit.point.y, hit.point.z];
          const sign = Math.sign([n.x, n.y, n.z][axis]) || 1;
          for (let k = 0; k < 3; k++) if (k !== axis) p[k] = this.snap(p[k]);
          // Join flush: put the shape's face exactly on the hit face.
          const other = this.item(hit.id);
          if (other && other.pos) {
            const ohe = this.halfExtents(other);
            p[axis] = other.pos[axis] + sign * (ohe[axis] + he[axis]);
          } else p[axis] += sign * he[axis];
          return { pos: p, face: true };
        }
      }
      const g = this.groundHit(e, 0);
      if (!g) return null;
      return { pos: [this.snap(g.x), he[1], this.snap(g.z)], face: false };
    }

    pickAt(e, ignore) {
      const ray = this.pointerRay(e);
      const hits = [];
      const objs = [];
      for (const b of this.view.batches.values()) objs.push(b.mesh);
      for (const t of this.view.tunnels.values()) objs.push(t.mesh);
      for (const h of ray.intersectObjects(objs, false)) {
        let id = null;
        if (h.object.isInstancedMesh) { const b = this.view.batches.get(h.object.userData.batch); id = b && b.ids[h.instanceId]; if (b && (b.type === 'arrow' || b.type === 'flag')) id = null; }
        else id = h.object.userData.tunnelId;
        if (!id || (ignore && ignore.has(id))) continue;
        let normal = null;
        if (h.face) {
          normal = h.face.normal.clone();
          if (h.object.isInstancedMesh) { const im = new THREE.Matrix4(); h.object.getMatrixAt(h.instanceId, im); normal.transformDirection(im); }
        }
        hits.push({ id, point: h.point, normal });
        break;
      }
      return hits[0] || null;
    }

    // ------------------------------------------------------------------ selection
    expandGroups(ids, alt) {
      if (alt) return ids;
      const out = new Set(ids);
      for (const id of ids) { const s = this.shape(id); if (s && s.group) for (const o of this.map.shapes) if (o.group === s.group) out.add(o.id); }
      return out;
    }
    setSelection(ids) {
      this.selection = new Set(ids);
      this.activeHandle = null;
      this.updateSelectionVisuals();
      this.view.refreshColors();
      this.renderProperties();
    }
    selectionCenter() {
      const box = this.selectionBox();
      return box.isEmpty() ? new THREE.Vector3() : box.getCenter(new THREE.Vector3());
    }
    selectionBox() {
      const box = new THREE.Box3();
      for (const id of this.selection) {
        const s = this.shape(id);
        if (s) { const he = this.halfExtents(s); box.expandByPoint(new THREE.Vector3(s.pos[0] - he[0], s.pos[1] - he[1], s.pos[2] - he[2])); box.expandByPoint(new THREE.Vector3(s.pos[0] + he[0], s.pos[1] + he[1], s.pos[2] + he[2])); }
        const t = this.tunnel(id);
        if (t) for (const p of t.points) box.expandByPoint(new THREE.Vector3(p[0] - t.width / 2, p[1] - t.height / 2, p[2] - t.width / 2)).expandByPoint(new THREE.Vector3(p[0] + t.width / 2, p[1] + t.height / 2, p[2] + t.width / 2));
      }
      return box;
    }
    updateSelectionVisuals() {
      const box = this.selectionBox();
      this.selBox.visible = !box.isEmpty();
      if (!box.isEmpty()) { this.selBox.box.copy(box).expandByScalar(0.6); }
      // Tunnel control-point handles for a single selected tunnel.
      for (const h of this.handles) this.core.scene.remove(h);
      this.handles = [];
      const only = this.selection.size === 1 ? this.tunnel([...this.selection][0]) : null;
      const tp = this.tunnelDraft;
      const pts = tp ? tp.points : only ? only.points : [];
      pts.forEach((p, i) => {
        const m = new THREE.Mesh(this.handleGeo, this.activeHandle === i && only ? new THREE.MeshBasicMaterial({ color: 0xff5050, depthTest: false }) : this.handleMat);
        m.scale.setScalar(Math.max(1.5, this.cam.dist * 0.006));
        m.position.set(p[0], p[1], p[2]);
        m.renderOrder = 20;
        m.userData.handle = i;
        this.core.scene.add(m);
        this.handles.push(m);
      });
    }

    // ------------------------------------------------------------------ actions
    placeAt(pos, type) {
      const s = F.makeShape(type || this.paletteType, pos);
      if (F.SHAPES[s.type].tag && s.type !== 'coin' && s.type !== 'checkpoint') s.pos[1] = 0.5;
      this.map.shapes.push(s);
      this.setSelection([s.id]);
      this.commit();
      E.sound('place');
      return s;
    }

    deleteSelection() {
      if (this.activeHandle !== null && this.activeHandle !== undefined && this.selection.size === 1) {
        const t = this.tunnel([...this.selection][0]);
        if (t && t.points.length > 2) { t.points.splice(this.activeHandle, 1); this.activeHandle = null; this.commit(); E.sound('delete'); return; }
      }
      if (!this.selection.size) { E.sound('invalid'); return; }
      const n = this.selection.size;
      this.map.shapes = this.map.shapes.filter((s) => !this.selection.has(s.id));
      this.map.tunnels = (this.map.tunnels || []).filter((t) => !this.selection.has(t.id));
      this.selection.clear();
      this.commit();   // MapView disposes meshes and geometry that are no longer used
      E.sound('delete');
      this.status(`Deleted ${n} item${n === 1 ? '' : 's'}.`);
    }

    duplicateSelection() {
      if (!this.selection.size) { E.sound('invalid'); return; }
      const box = this.selectionBox();
      const dx = this.snap(Math.max(this.grid * 2, box.max.x - box.min.x + this.grid));
      const groups = new Map();
      const ids = [];
      for (const id of this.selection) {
        const s = this.shape(id), t = this.tunnel(id);
        if (s) {
          const c = JSON.parse(JSON.stringify(s));
          c.id = F.newId('s'); c.pos[0] += dx;
          if (c.group) { if (!groups.has(c.group)) groups.set(c.group, F.newId('g')); c.group = groups.get(c.group); }
          this.map.shapes.push(c); ids.push(c.id);
        } else if (t) {
          const c = JSON.parse(JSON.stringify(t));
          c.id = F.newId('t'); c.points.forEach((p) => { p[0] += dx; });
          this.map.tunnels.push(c); ids.push(c.id);
        }
      }
      this.setSelection(ids);
      this.commit();
      E.sound('place');
    }

    groupSelection(ungroup) {
      const shapes = [...this.selection].map((id) => this.shape(id)).filter(Boolean);
      if (shapes.length < (ungroup ? 1 : 2)) { E.sound('invalid'); this.status(ungroup ? 'Select a group first.' : 'Select at least two shapes to group.', 'warn'); return; }
      const g = ungroup ? null : F.newId('g');
      for (const s of shapes) s.group = g;
      this.commit();
      this.status(ungroup ? 'Ungrouped.' : `Grouped ${shapes.length} shapes.`);
      E.sound('snap');
    }

    translateSelection(d) {
      if (this.activeHandle !== null && this.activeHandle !== undefined && this.selection.size === 1) {
        const t = this.tunnel([...this.selection][0]);
        if (t) { const p = t.points[this.activeHandle]; for (let k = 0; k < 3; k++) p[k] += d[k]; p[1] = Math.max(1, p[1]); this.commit(); return; }
      }
      if (!this.selection.size) { E.sound('invalid'); return; }
      for (const id of this.selection) {
        const s = this.shape(id), t = this.tunnel(id);
        if (s) for (let k = 0; k < 3; k++) s.pos[k] = Math.round((s.pos[k] + d[k]) * 100) / 100;
        if (t) for (const p of t.points) for (let k = 0; k < 3; k++) p[k] += d[k];
      }
      this.commit();
    }

    /** Rotate the selection about its centre. axis: 0 X, 1 Y, 2 Z (degrees). */
    rotateSelection(axis, deg, noCommit) {
      if (!this.selection.size) { E.sound('invalid'); return; }
      const c = this.selectionCenter();
      const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(axis === 0 ? 1 : 0, axis === 1 ? 1 : 0, axis === 2 ? 1 : 0), deg * DEG);
      const e = new THREE.Euler(), v = new THREE.Vector3();
      for (const id of this.selection) {
        const s = this.shape(id), t = this.tunnel(id);
        if (s) {
          v.set(s.pos[0], s.pos[1], s.pos[2]).sub(c).applyQuaternion(q).add(c);
          s.pos = [round2(v.x), round2(v.y), round2(v.z)];
          const sq = new THREE.Quaternion().setFromEuler(e.set(s.rot[0] * DEG, s.rot[1] * DEG, s.rot[2] * DEG, 'YXZ'));
          e.setFromQuaternion(sq.premultiply(q), 'YXZ');
          s.rot = [e.x, e.y, e.z].map((r) => cleanAngle(r / DEG));
        }
        if (t && axis === 1) for (const p of t.points) { v.set(p[0], p[1], p[2]).sub(c).applyQuaternion(q).add(c); p[0] = round2(v.x); p[2] = round2(v.z); }
      }
      if (!noCommit) { this.commit(); E.sound('snap'); }
    }

    /** Snapped sizes are grid multiples; key presses step one grid unit, drags round to the nearest. */
    snappedScale(v, f, stepwise) {
      if (!this.snapGrid || v < this.grid * 0.75) return round2(v * f);
      const g = this.grid;
      if (stepwise) return f > 1 ? (Math.floor(v / g + 1e-6) + 1) * g : Math.max(g, (Math.ceil(v / g - 1e-6) - 1) * g);
      return Math.max(g, Math.round((v * f) / g) * g);
    }

    scaleSelection(f, noCommit, stepwise) {
      if (!this.selection.size) { E.sound('invalid'); return; }
      for (const id of this.selection) {
        const s = this.shape(id), t = this.tunnel(id);
        if (s) s.scale = s.scale.map((v) => Math.max(0.5, Math.min(4000, this.snappedScale(v, f, stepwise))));
        if (t) { t.width = Math.max(4, Math.min(400, round2(t.width * f))); t.height = Math.max(4, Math.min(400, round2(t.height * f))); }
      }
      if (!noCommit) { this.commit(); E.sound('snap'); }
    }

    setProp(fn) {
      if (!this.selection.size) { E.sound('invalid'); return; }
      for (const id of this.selection) { const it = this.item(id); if (it) fn(it); }
      this.commit();
    }

    cycleSelection(dir) {
      const all = this.map.shapes.map((s) => s.id).concat((this.map.tunnels || []).map((t) => t.id));
      if (!all.length) return;
      const cur = [...this.selection][0];
      const i = all.indexOf(cur);
      this.setSelection([all[((i < 0 ? (dir > 0 ? -1 : 0) : i) + dir + all.length) % all.length]]);
      this.frameSelection(true);
    }

    frameSelection(keepDist) {
      const box = this.selectionBox();
      if (box.isEmpty()) { this.cam.focus(new THREE.Vector3(0, 0, 0), this.map.settings.bound * 1.2); return; }
      const size = box.getSize(new THREE.Vector3()).length();
      this.cam.focus(box.getCenter(new THREE.Vector3()), keepDist ? Math.max(this.cam.dist * 0.8, size * 2) : Math.max(40, size * 2));
    }

    // ------------------------------------------------------------------ tunnels
    tunnelClick(e) {
      const hit = this.pickAt(e) || null;
      let p;
      if (hit) p = [this.snap(hit.point.x), hit.point.y + 2, this.snap(hit.point.z)];
      else { const g = this.groundHit(e, 0); if (!g) return; p = [this.snap(g.x), 0, this.snap(g.z)]; }
      const h = this.tunnelSettings.height;
      p[1] = Math.max(p[1], 0) + h / 2 + 2;
      if (!this.tunnelDraft) this.tunnelDraft = { points: [] };
      this.tunnelDraft.points.push(p);
      E.sound('snap');
      this.updateSelectionVisuals();
      this.previewTunnel();
      this.status(`Tunnel: ${this.tunnelDraft.points.length} point(s). Click to add, Enter to finish, Backspace to undo a point, Esc to cancel.`);
    }
    previewTunnel() {
      if (this.draftMesh) { this.core.scene.remove(this.draftMesh); this.draftMesh.geometry.dispose(); this.draftMesh = null; }
      const d = this.tunnelDraft;
      if (!d || d.points.length < 2) return;
      const samples = F.sampleCurve(d.points, 3);
      const geo = new THREE.BufferGeometry().setFromPoints(samples.map((s) => new THREE.Vector3(...s.p)));
      if (!this.draftMat) this.draftMat = new THREE.LineBasicMaterial({ color: 0xffd23f, depthTest: false });
      this.draftMesh = new THREE.Line(geo, this.draftMat);
      this.draftMesh.renderOrder = 19;
      this.core.scene.add(this.draftMesh);
    }
    finishTunnel() {
      const d = this.tunnelDraft;
      this.cancelTunnel(true);
      if (!d || d.points.length < 2) { E.sound('invalid'); this.status('A tunnel needs at least two points.', 'warn'); return; }
      const t = Object.assign(F.makeTunnel(d.points), { width: this.tunnelSettings.width, height: this.tunnelSettings.height, profile: this.tunnelSettings.profile });
      this.map.tunnels.push(t);
      this.setSelection([t.id]);
      this.commit();
      this.setTool('select');
      E.sound('place');
      this.status('Tunnel created. Drag its yellow handles to reshape it; edit width and height in the panel.');
    }
    cancelTunnel(silent) {
      this.tunnelDraft = null;
      if (this.draftMesh) { this.core.scene.remove(this.draftMesh); this.draftMesh.geometry.dispose(); this.draftMesh = null; }
      this.updateSelectionVisuals();
      if (!silent) this.status('Tunnel cancelled.');
    }
    insertTunnelPoint() {
      const t = this.selection.size === 1 && this.tunnel([...this.selection][0]);
      if (!t) return;
      const i = this.activeHandle !== null && this.activeHandle !== undefined ? Math.min(this.activeHandle, t.points.length - 2) : t.points.length - 2;
      const a = t.points[i], b = t.points[i + 1];
      t.points.splice(i + 1, 0, a.map((v, k) => round2((v + b[k]) / 2)));
      this.activeHandle = i + 1;
      this.commit();
    }

    // ------------------------------------------------------------------ pointer
    bindEvents() {
      const c = this.canvas;
      this.handlers = {
        down: (e) => this.onPointerDown(e), move: (e) => this.onPointerMove(e), up: (e) => this.onPointerUp(e),
        wheel: (e) => { if (e.target === c) { this.cam.wheel(e); e.preventDefault(); } }, key: (e) => this.onKey(e),
        ctx: (e) => { if (e.target === c) e.preventDefault(); }, dbl: (e) => { if (this.tool === 'tunnel' && e.target === c) this.finishTunnel(); },
      };
      c.addEventListener('pointerdown', this.handlers.down);
      window.addEventListener('pointermove', this.handlers.move);
      window.addEventListener('pointerup', this.handlers.up);
      window.addEventListener('wheel', this.handlers.wheel, { passive: false });
      window.addEventListener('keydown', this.handlers.key);
      window.addEventListener('contextmenu', this.handlers.ctx);
      c.addEventListener('dblclick', this.handlers.dbl);
    }
    unbindEvents() {
      const c = this.canvas, h = this.handlers;
      c.removeEventListener('pointerdown', h.down);
      window.removeEventListener('pointermove', h.move);
      window.removeEventListener('pointerup', h.up);
      window.removeEventListener('wheel', h.wheel);
      window.removeEventListener('keydown', h.key);
      window.removeEventListener('contextmenu', h.ctx);
      c.removeEventListener('dblclick', h.dbl);
    }

    pickHandle(e) {
      if (!this.handles.length) return null;
      const hits = this.pointerRay(e).intersectObjects(this.handles, false);
      return hits.length ? hits[0].object.userData.handle : null;
    }

    onPointerDown(e) {
      AV.Audio.init();
      this.lastPointer = e;
      if (this.cam.pointerDown(e)) { e.preventDefault(); return; }
      if (e.button !== 0) return;
      if (this.tool === 'tunnel') { this.tunnelClick(e); return; }
      if (this.tool === 'place') {
        const pl = this.placement(e, F.makeShape(this.paletteType));
        if (pl) this.placeAt(pl.pos); else E.sound('invalid');
        return;
      }
      const handle = this.pickHandle(e);
      if (handle !== null) {
        this.activeHandle = handle;
        const t = this.tunnel([...this.selection][0]);
        this.drag = { kind: 'handle', t, index: handle, start: t.points[handle].slice(), y: t.points[handle][1], sx: e.clientX, sy: e.clientY };
        this.updateSelectionVisuals();
        return;
      }
      const hit = this.pickAt(e);
      if (hit) {
        if (e.shiftKey) {
          const ids = this.expandGroups([hit.id], e.altKey);
          const sel = new Set(this.selection);
          const has = sel.has(hit.id);
          for (const id of ids) has ? sel.delete(id) : sel.add(id);
          this.setSelection(sel);
        } else if (e.altKey || !this.selection.has(hit.id)) this.setSelection(this.expandGroups([hit.id], e.altKey));
        this.beginTransform(e, hit);
      } else if (this.tool === 'select' || !this.selection.size) {
        this.drag = { kind: 'box', sx: e.clientX, sy: e.clientY, add: e.shiftKey };
      } else this.beginTransform(e, null);
    }

    beginTransform(e, hit) {
      if (!this.selection.size) return;
      const kind = this.tool === 'rotate' ? 'rotate' : this.tool === 'scale' ? 'scale' : 'move';
      // Only the selected items are snapshotted, so dragging stays cheap with thousands of shapes.
      const orig = new Map();
      for (const id of this.selection) { const it = this.item(id); if (it) orig.set(id, JSON.stringify(it)); }
      const anchor = hit ? hit.point.clone() : this.selectionCenter();
      this.drag = { kind, orig, sx: e.clientX, sy: e.clientY, anchor, primary: hit ? hit.id : [...this.selection][0], moved: false };
    }

    onPointerMove(e) {
      this.lastPointer = e;
      if (this.cam.pointerMove(e)) return;
      const d = this.drag;
      if (!d) {
        if (this.tool === 'place' && e.target === this.canvas) this.updateGhost(e);
        this.hoverDirty = e.target === this.canvas;
        return;
      }
      const dx = e.clientX - d.sx, dy = e.clientY - d.sy;
      if (d.kind === 'box') { this.drawBox(d, e); return; }
      if (d.kind === 'handle') {
        const p = d.t.points[d.index];
        if (e.shiftKey) p[1] = Math.max(1, round2(d.y - dy * this.cam.dist * 0.002));
        else { const g = this.groundHit(e, d.y); if (g) { p[0] = this.snap(g.x); p[2] = this.snap(g.z); } }
        d.moved = true;
        this.view.syncTunnels(this.map.tunnels);
        this.updateSelectionVisuals();
        return;
      }
      if (Math.hypot(dx, dy) < 3 && !d.moved) return;
      d.moved = true;
      this.restoreOriginals(d);
      if (d.kind === 'move') this.dragMove(d, e);
      else if (d.kind === 'rotate') {
        let deg = dx * 0.5;
        if (this.snapRot) deg = Math.round(deg / 90) * 90;
        if (deg) this.rotateSelection(1, deg, true);
        this.status(`Rotate ${Math.round(deg)}°${this.snapRot ? ' (90° snap)' : ''}`);
      } else if (d.kind === 'scale') {
        this.scaleSelection(Math.exp(-dy * 0.006), true);
      }
      this.view.sync(this.map);
      this.updateSelectionVisuals();
    }

    restoreOriginals(d) {
      for (const [id, json] of d.orig) { const it = this.item(id); if (it) Object.assign(it, JSON.parse(json)); }
    }

    dragMove(d, e) {
      let delta = null;
      const prim = this.shape(d.primary);
      if (this.snapFace && prim && !e.shiftKey) {
        const ignore = new Set(this.selection);
        const pl = this.placement(e, prim, ignore);
        if (pl && pl.face) delta = pl.pos.map((v, k) => v - prim.pos[k]);
      }
      if (!delta) {
        if (e.shiftKey) {
          const dyPix = e.clientY - d.sy;
          delta = [0, -dyPix * this.cam.dist * 0.002, 0];
          if (this.snapGrid) delta[1] = Math.round(delta[1] / this.grid) * this.grid;
        } else {
          const g = this.groundHit(e, d.anchor.y);
          if (!g) return;
          delta = [this.snap(g.x - d.anchor.x), 0, this.snap(g.z - d.anchor.z)];
        }
      }
      for (const id of this.selection) {
        const s = this.shape(id), t = this.tunnel(id);
        if (s) for (let k = 0; k < 3; k++) s.pos[k] = round2(s.pos[k] + delta[k]);
        if (t) for (const p of t.points) for (let k = 0; k < 3; k++) p[k] = round2(p[k] + delta[k]);
      }
    }

    drawBox(d, e) {
      let el = document.getElementById('ed-boxsel');
      if (!el) { el = E.el('div', null, null, { id: 'ed-boxsel' }); document.body.appendChild(el); }
      const x0 = Math.min(d.sx, e.clientX), y0 = Math.min(d.sy, e.clientY);
      Object.assign(el.style, { display: 'block', left: x0 + 'px', top: y0 + 'px', width: Math.abs(e.clientX - d.sx) + 'px', height: Math.abs(e.clientY - d.sy) + 'px' });
      d.ex = e.clientX; d.ey = e.clientY;
    }

    onPointerUp(e) {
      if (this.cam.pointerUp()) return;
      const d = this.drag;
      this.drag = null;
      if (!d) return;
      if (d.kind === 'box') {
        const el = document.getElementById('ed-boxsel');
        if (el) el.style.display = 'none';
        if (d.ex === undefined || Math.hypot(d.ex - d.sx, d.ey - d.sy) < 4) { if (!d.add) this.setSelection([]); return; }
        const r = this.canvas.getBoundingClientRect();
        const x0 = Math.min(d.sx, d.ex) - r.left, x1 = Math.max(d.sx, d.ex) - r.left, y0 = Math.min(d.sy, d.ey) - r.top, y1 = Math.max(d.sy, d.ey) - r.top;
        const sel = d.add ? new Set(this.selection) : new Set();
        const v = new THREE.Vector3();
        const inside = (p) => { v.set(p[0], p[1], p[2]).project(this.core.camera); if (v.z > 1) return false; const sx = (v.x * 0.5 + 0.5) * r.width, sy = (-v.y * 0.5 + 0.5) * r.height; return sx >= x0 && sx <= x1 && sy >= y0 && sy <= y1; };
        for (const s of this.map.shapes) if (inside(s.pos)) sel.add(s.id);
        for (const t of this.map.tunnels || []) if (t.points.some(inside)) sel.add(t.id);
        this.setSelection(this.expandGroups([...sel]));
        this.status(`${this.selection.size} selected.`);
        return;
      }
      if (d.moved) { this.commit(); E.sound('snap'); }
    }

    updateGhost(e) {
      const s = F.makeShape(this.paletteType);
      const pl = this.placement(e, s);
      if (!this.ghost || this.ghost.userData.type !== this.paletteType) {
        if (this.ghost) { this.core.scene.remove(this.ghost); this.ghost.material.dispose(); this.ghost.geometry.dispose(); }
        const proto = new F.MapView({});
        proto.sync({ shapes: [s], tunnels: [] });
        const b = [...proto.batches.values()].find((x) => x.type !== 'arrow' && x.type !== 'flag');
        this.ghost = new THREE.Mesh(b.mesh.geometry.clone(), new THREE.MeshBasicMaterial({ color: 0x5dffc8, transparent: true, opacity: 0.45, depthWrite: false }));
        proto.dispose();
        this.ghost.userData.type = this.paletteType;
        this.core.scene.add(this.ghost);
      }
      this.ghost.visible = !!pl;
      if (pl) {
        const typeKey = F.SHAPES[s.type];
        const y = typeKey.tag && s.type !== 'coin' && s.type !== 'checkpoint' ? 0.5 : pl.pos[1];
        this.ghost.position.set(pl.pos[0], pl.face ? pl.pos[1] : y, pl.pos[2]);
        this.ghost.scale.set(s.scale[0], s.scale[1], s.scale[2]);
        this.ghostPos = [pl.pos[0], pl.face ? pl.pos[1] : y, pl.pos[2]];
        const key = this.ghostPos.join(',');
        if (key !== this.lastGhostKey && pl.face) E.sound('snap');
        this.lastGhostKey = key;
      }
    }

    // ------------------------------------------------------------------ keyboard
    onKey(e) {
      if (AV.Game.mode !== this) return;
      const k = e.key, lower = k.length === 1 ? k.toLowerCase() : k, ctrl = e.ctrlKey || e.metaKey;
      if (E.typingIn(e)) { if (k === 'Escape') e.target.blur(); return; }
      if (k === '?') { E.showHelp('Map Builder', HELP); e.preventDefault(); return; }
      if (E.helpOpen() || E.modalOpen()) { if (k === 'Escape') { E.closeHelp(); E.closeModal(); } return; }
      const step = this.grid * (e.shiftKey ? 5 : 1);
      const rstep = this.snapRot ? 90 : 15;
      let handled = true;
      if (ctrl && lower === 'z') { if (e.shiftKey) this.redo(); else this.undo(); }
      else if (ctrl && lower === 'y') this.redo();
      else if (ctrl && lower === 'd') this.duplicateSelection();
      else if (ctrl && lower === 'g') this.groupSelection(e.shiftKey);
      else if (ctrl && lower === 'a') this.setSelection(this.map.shapes.map((s) => s.id).concat(this.map.tunnels.map((t) => t.id)));
      else if (ctrl && lower === 's') this.saveMap(false);
      else if (ctrl && k === 'Enter') this.testPlay();
      else if (ctrl) handled = false;
      else if (k === 'Delete' || (k === 'Backspace' && this.tool !== 'tunnel')) this.deleteSelection();
      else if (k === 'Backspace' && this.tunnelDraft) { this.tunnelDraft.points.pop(); this.previewTunnel(); this.updateSelectionVisuals(); }
      else if (k === 'Enter') {
        if (this.tool === 'tunnel') this.finishTunnel();
        else if (this.tool === 'place') this.placeAt(this.ghostPos || [this.snap(this.cam.target.x), F.SHAPES[this.paletteType].scale[1] / 2, this.snap(this.cam.target.z)]);
        else handled = false;
      }
      else if (lower === 'q') this.setTool('select');
      else if (lower === 'w') this.setTool('move');
      else if (lower === 'e') this.setTool('rotate');
      else if (lower === 's') this.setTool('scale');
      else if (lower === 'p') this.setTool('place');
      else if (lower === 't') this.setTool('tunnel');
      else if (k >= '1' && k <= '9') this.setPalette(PALETTE_ORDER[Number(k) - 1]);
      else if (k === '[' && e.altKey) this.rotateSelection(2, -rstep);
      else if (k === ']' && e.altKey) this.rotateSelection(2, rstep);
      else if (k === '[') this.rotateSelection(1, -rstep);
      else if (k === ']') this.rotateSelection(1, rstep);
      else if (k === '{') this.rotateSelection(0, -rstep);
      else if (k === '}') this.rotateSelection(0, rstep);
      else if (k === '+' || k === '=') this.scaleSelection(1.15, false, true);
      else if (k === '-' || k === '_') this.scaleSelection(1 / 1.15, false, true);
      else if (k.startsWith('Arrow') && e.altKey) this.cam.orbit(k === 'ArrowLeft' ? 0.1 : k === 'ArrowRight' ? -0.1 : 0, k === 'ArrowUp' ? 0.06 : k === 'ArrowDown' ? -0.06 : 0);
      else if (k.startsWith('Arrow')) {
        // Arrow keys move along the ground relative to the view, snapped to the dominant world axis.
        const axis = (v) => (Math.abs(v[0]) > Math.abs(v[2]) ? [Math.sign(v[0]), 0, 0] : [0, 0, Math.sign(v[2])]);
        const fwd = axis([-Math.sin(this.cam.yaw), 0, -Math.cos(this.cam.yaw)]);
        const right = [-fwd[2], 0, fwd[0]];
        const v = k === 'ArrowUp' ? fwd : k === 'ArrowDown' ? fwd.map((x) => -x) : k === 'ArrowRight' ? right : right.map((x) => -x);
        this.translateSelection(v.map((x) => x * step));
      }
      else if (k === 'PageUp') this.translateSelection([0, step, 0]);
      else if (k === 'PageDown') this.translateSelection([0, -step, 0]);
      else if (k === 'Tab') this.cycleSelection(e.shiftKey ? -1 : 1);
      else if (lower === 'h') this.setProp((it) => { it.hazard = !it.hazard; });
      else if (lower === 'c') this.setProp((it) => { it.collide = it.collide === 'decorative' ? 'collidable' : 'decorative'; });
      else if (lower === 'm') this.setProp((it) => { it.material = F.MATERIALS[(F.MATERIALS.indexOf(it.material) + 1) % F.MATERIALS.length]; });
      else if (lower === 'n') { this.snapGrid = !this.snapGrid; this.renderSettings(); this.status(`Grid snap ${this.snapGrid ? 'on' : 'off'}.`); }
      else if (lower === 'j') { this.snapFace = !this.snapFace; this.renderSettings(); this.status(`Snap to face ${this.snapFace ? 'on' : 'off'}.`); }
      else if (lower === 'f') this.frameSelection(false);
      else if (k === 'Escape') {
        if (this.tunnelDraft) this.cancelTunnel();
        else if (this.drag) { if (this.drag.orig) { this.restoreOriginals(this.drag); this.refresh(); } this.drag = null; }
        else if (this.tool !== 'select') this.setTool('select');
        else if (this.selection.size) this.setSelection([]);
        else this.game.goto('menu');
      } else handled = false;
      if (handled) e.preventDefault();
    }

    setTool(t) {
      if (this.tunnelDraft && t !== 'tunnel') this.cancelTunnel(true);
      this.tool = t;
      if (this.ghost) this.ghost.visible = t === 'place';
      if (this.ui) this.ui.tools.forEach((b) => { const on = b.dataset.tool === t; b.classList.toggle('on', on); b.setAttribute('aria-pressed', String(on)); });
      const hints = { select: 'Select: click or drag a box. Shift adds. Drag a selected shape to move it.', move: 'Move: drag the selection (Shift = vertical). Snap to face joins shapes flush.',
        rotate: 'Rotate: drag left/right to spin around Y. Toggle rotation snap for free angles.', scale: 'Scale: drag up/down to resize.', place: `Place: click to drop a ${F.SHAPES[this.paletteType].name}. Enter places at the cursor.`,
        tunnel: 'Tunnel: click points along a path, then Enter or double-click to build it.' };
      this.status(hints[t]);
    }
    setPalette(type) {
      if (!type) return;
      this.paletteType = type;
      if (this.ui) this.ui.palette.querySelectorAll('[data-shape]').forEach((b) => b.classList.toggle('on', b.dataset.shape === type));
      this.setTool('place');
    }

    // ------------------------------------------------------------------ save / play
    thumbnail() {
      const c = this.cam, saved = { yaw: c.yaw, pitch: c.pitch, dist: c.dist, t: c.target.clone() };
      const box = new THREE.Box3();
      for (const s of this.map.shapes) box.expandByPoint(new THREE.Vector3(...s.pos));
      for (const t of this.map.tunnels) for (const p of t.points) box.expandByPoint(new THREE.Vector3(...p));
      if (!box.isEmpty()) { c.target.copy(box.getCenter(new THREE.Vector3())); c.dist = Math.max(80, box.getSize(new THREE.Vector3()).length() * 0.9); }
      c.yaw = 0.6; c.pitch = 0.8; c.update();
      const hv = [this.selBox.visible, ...this.handles.map((h) => h.visible)];
      this.selBox.visible = false; this.handles.forEach((h) => { h.visible = false; });
      const url = this.core.thumbnail(this.game.renderer, 192, 120);
      this.selBox.visible = hv[0]; this.handles.forEach((h, i) => { h.visible = hv[i + 1]; });
      Object.assign(c, { yaw: saved.yaw, pitch: saved.pitch, dist: saved.dist }); c.target.copy(saved.t);
      return url;
    }
    saveMap(asNew) {
      const r = AV.Creative.saveMap(this.map, this.thumbnail(), asNew ? null : Session.savedId);
      if (!r.ok) { E.sound('invalid'); AV.UI.toast(r.error, 'warn', 4); return false; }
      Session.savedId = r.id; Session.dirty = false;
      AV.UI.toast(`Saved “${this.map.name}” — it appears in Free Flight under Custom maps`, 'good', 3.5);
      E.sound('place');
      this.renderProblems();
      return true;
    }
    testPlay() {
      try { F.parseMap(this.map, { quiet: true }); } catch (err) { E.sound('invalid'); this.status(`Map data is malformed: ${err.message}`, 'bad'); return; }
      this.game.goto('freeflight', { map: F.serializeMap(this.map), returnTo: 'mapBuilder', label: this.map.name });
    }
    exportMap() { E.downloadJSON(this.map, `${(this.map.name || 'map').replace(/[^a-z0-9_-]+/gi, '_')}.aviator-map.json`); this.status('Exported map JSON.'); }
    importMap() {
      E.importDialog('Import map', (text) => {
        const { map, warnings } = F.parseMap(text);
        this.loadMap(map, null);
        this.selection.clear();
        this.rebuildEnvironment();
        this.refresh();
        this.renderSettings();
        this.frameSelection(false);
        return warnings.length ? `Imported with notes: ${warnings.join(' ')}` : `Imported “${map.name}” (${map.shapes.length} shapes).`;
      });
    }
    openMaps() {
      E.modal('Saved maps', (body, close) => {
        const C = AV.Creative, list = C.maps();
        body.innerHTML = `<p class="muted">${list.length} / ${C.MAX_MAPS} slots used. Saved maps can be flown from Free Flight → Custom maps.</p>`;
        const row = E.el('div', 'ed-row');
        row.append(E.button('Save current', 'Save the current map', () => { if (this.saveMap(false)) { close(); this.openMaps(); } }, 'btn-primary'),
          E.button('Save as new copy', 'Save as a new map', () => { if (this.saveMap(true)) { close(); this.openMaps(); } }),
          E.button('New empty map', 'Start an empty map', () => { close(); this.discardThen(() => this.replaceMap(F.emptyMap('New map'))); }),
          E.button('Sample map', 'Load the sample course', () => { close(); this.discardThen(() => this.replaceMap(F.sampleMap())); }));
        body.appendChild(row);
        const grid = E.el('div', 'design-grid');
        for (const m of list) {
          const card = E.el('div', 'design-card');
          card.innerHTML = `${m.thumb ? `<img src="${m.thumb}" alt="">` : '<div class="no-thumb">▦</div>'}<b>${E.esc(m.name)}</b><small>${new Date(m.updated).toLocaleString()} · ${m.data.shapes.length} shapes</small>`;
          const acts = E.el('div', 'ed-row');
          acts.append(
            E.button('Load', `Load ${m.name}`, () => { close(); this.discardThen(() => this.replaceMap(m.data, m.id)); }),
            E.button('Delete', `Delete ${m.name}`, (ev) => {
              if (ev.target.dataset.armed) { C.deleteMap(m.id); if (Session.savedId === m.id) Session.savedId = null; E.sound('delete'); close(); this.openMaps(); }
              else { ev.target.dataset.armed = '1'; ev.target.textContent = 'Confirm delete'; ev.target.classList.add('btn-danger'); }
            }));
          card.appendChild(acts);
          grid.appendChild(card);
        }
        if (!list.length) grid.innerHTML = '<p class="muted">No saved maps yet.</p>';
        body.appendChild(grid);
      });
    }
    discardThen(fn) { if (!Session.dirty) fn(); else AV.UI.confirm('Discard changes?', 'The current map has unsaved changes.', fn); }
    replaceMap(map, savedId) {
      this.loadMap(map, savedId || null);
      this.selection.clear();
      this.rebuildEnvironment();
      this.refresh();
      this.renderSettings();
      this.frameSelection(false);
    }

    // ------------------------------------------------------------------ UI
    buildUI() {
      const root = document.getElementById('editor-ui');
      root.innerHTML = '';
      root.className = 'ed-root';
      const B = E.button;
      const bar = E.el('div', 'ed-toolbar', null, { role: 'toolbar', 'aria-label': 'Map Builder tools' });
      const name = E.el('input', 'ed-name', null, { type: 'text', maxlength: '40', 'aria-label': 'Map name' });
      name.value = this.map.name;
      name.addEventListener('change', () => { this.map.name = name.value.trim() || 'My map'; this.commit(); });
      this.ui = { root, name, tools: [] };
      for (const [id, label, key] of TOOLS) {
        const b = B(label, `${label} tool (${key})`, () => this.setTool(id), 'toggle');
        b.dataset.tool = id;
        this.ui.tools.push(b);
      }
      this.ui.undo = B('↶', 'Undo (Ctrl+Z)', () => this.undo());
      this.ui.redo = B('↷', 'Redo (Ctrl+Shift+Z)', () => this.redo());
      const snd = B('♪', 'Editor sounds on/off', () => {
        const s = AV.Save.data.settings; s.editorSounds = !s.editorSounds; AV.Save.save();
        snd.classList.toggle('on', s.editorSounds); snd.setAttribute('aria-pressed', String(s.editorSounds)); this.status(`Editor sounds ${s.editorSounds ? 'on' : 'muted'}.`);
      }, 'toggle' + (AV.Save.data.settings.editorSounds ? ' on' : ''));
      bar.append(B('◀ Menu', 'Back to the main menu (work is kept for this session)', () => this.game.goto('menu')), E.el('span', 'ed-title', 'Map Builder'), name,
        ...this.ui.tools, this.ui.undo, this.ui.redo,
        B('⧉ Duplicate', 'Duplicate (Ctrl+D)', () => this.duplicateSelection()), B('⊞ Group', 'Group (Ctrl+G)', () => this.groupSelection(false)),
        B('🗑 Delete', 'Delete (Del)', () => this.deleteSelection()), snd, B('?', 'Keyboard shortcuts (?)', () => E.showHelp('Map Builder', HELP)),
        B('💾 Save', 'Save map (Ctrl+S)', () => this.saveMap(false)), B('Maps', 'Saved maps', () => this.openMaps()),
        B('Export', 'Export map JSON', () => this.exportMap()), B('Import', 'Import map JSON', () => this.importMap()),
        B('▶ Test play', 'Fly this map (Ctrl+Enter)', () => this.testPlay(), 'btn-primary'));
      const left = E.el('aside', 'ed-panel ed-left', null, { 'aria-label': 'Shapes and settings' });
      left.innerHTML = '<h3>Shapes</h3><div class="ed-palette"></div><h3>Map settings</h3><div class="ed-settings"></div>';
      const palette = left.querySelector('.ed-palette');
      PALETTE_ORDER.forEach((type, i) => {
        const def = F.SHAPES[type];
        const b = E.el('button', 'ed-shape', `<span class="k">${i < 9 ? i + 1 : ''}</span>${E.esc(def.name)}${def.tag ? ' <small>tag</small>' : ''}`, { type: 'button', 'data-shape': type, title: `Place ${def.name}` });
        b.addEventListener('click', () => this.setPalette(type));
        palette.appendChild(b);
      });
      const right = E.el('aside', 'ed-panel ed-right', null, { 'aria-label': 'Properties and problems' });
      right.innerHTML = '<h3>Problems</h3><ul class="ed-problems"></ul><h3>Selection</h3><div class="ed-props"></div>';
      const status = E.el('div', 'ed-status', '', { role: 'status' });
      root.append(bar, left, right, status);
      root.classList.remove('hidden');
      Object.assign(this.ui, { bar, left, right, status, palette, settings: left.querySelector('.ed-settings'), problems: right.querySelector('.ed-problems'), props: right.querySelector('.ed-props') });
      this.tunnelSettings = { width: 28, height: 20, profile: 'box' };
      this.setPalette('cube');
      this.setTool('select');
      this.renderSettings();
    }

    status(msg, kind) { if (this.ui) { this.ui.status.textContent = msg; this.ui.status.className = 'ed-status ' + (kind || ''); } }

    renderPanels() {
      if (!this.ui) return;
      this.ui.undo.disabled = !Session.history.canUndo;
      this.ui.redo.disabled = !Session.history.canRedo;
      this.renderProblems();
      this.renderProperties();
    }

    renderProblems() {
      const ul = this.ui.problems;
      ul.innerHTML = '';
      const r = this.reach || {};
      const items = this.warnings.slice();
      if (r.reachable === false) items.push({ msg: 'The goal looks unreachable from the start (blocked by solid shapes or hazards).', id: this.runtime.goals[0] && this.runtime.goals[0].id });
      for (const w of items) {
        const li = E.el('li', 'warn');
        const b = E.el('button', 'linkish', `⚠ ${E.esc(w.msg)}`, { type: 'button' });
        b.addEventListener('click', () => { if (w.id && this.item(w.id)) { this.setSelection([w.id]); this.frameSelection(false); } });
        li.appendChild(b);
        ul.appendChild(li);
      }
      if (!items.length) ul.innerHTML = `<li class="ok">✔ No problems${r.reachable === undefined ? ' (checking route…)' : ''}</li>`;
      const counts = E.el('li', 'muted small', `${this.map.shapes.length} shapes · ${this.map.tunnels.length} tunnels · ${this.runtime.checkpoints.length} checkpoints · ${this.runtime.coins.length} coins · ${Session.dirty ? 'unsaved' : Session.savedId ? 'saved' : 'not saved yet'}`);
      ul.appendChild(counts);
    }

    renderSettings() {
      const st = this.map.settings, box = this.ui.settings;
      box.innerHTML = '';
      const row = (label, input) => { const l = E.el('label', 'ed-field'); l.appendChild(E.el('span', '', label)); l.appendChild(input); box.appendChild(l); return input; };
      const num = (label, value, min, max, stepv, onChange) => { const i = E.el('input', null, null, { type: 'number', min, max, step: stepv }); i.value = value; i.addEventListener('change', () => onChange(Number(i.value))); return row(label, i); };
      const chk = (label, value, onChange) => { const i = E.el('input', null, null, { type: 'checkbox' }); i.checked = value; i.addEventListener('change', () => onChange(i.checked)); return row(label, i); };
      const apply = (fn, env) => { fn(); if (env) this.rebuildEnvironment(); this.commit(); };
      const tod = E.el('input', null, null, { type: 'range', min: 0, max: 24, step: 0.25 }); tod.value = st.timeOfDay;
      tod.addEventListener('change', () => apply(() => { st.timeOfDay = Number(tod.value); }, true));
      row('Time of day', tod);
      chk('Custom sky colour', !!st.skyColor, (v) => apply(() => { st.skyColor = v ? '#87b5e0' : null; this.renderSettings(); }, true));
      if (st.skyColor) { const c = E.el('input', null, null, { type: 'color' }); c.value = st.skyColor; c.addEventListener('change', () => apply(() => { st.skyColor = c.value; }, true)); row('Sky colour', c); }
      chk('Water', st.waterEnabled, (v) => apply(() => { st.waterEnabled = v; }, true));
      num('Water level (m)', st.waterLevel, -50, 500, 1, (v) => apply(() => { st.waterLevel = Math.max(-50, Math.min(500, v || 0)); }, true));
      num('Wind (m/s)', st.windSpeed, 0, 30, 1, (v) => apply(() => { st.windSpeed = Math.max(0, Math.min(30, v || 0)); }));
      num('Wind from (°)', st.windDir, 0, 360, 5, (v) => apply(() => { st.windDir = ((v || 0) % 360 + 360) % 360; }));
      num('Size bound (m)', st.bound, F.LIMITS.boundMin, F.LIMITS.boundMax, 50, (v) => apply(() => { st.bound = Math.max(F.LIMITS.boundMin, Math.min(F.LIMITS.boundMax, v || 1200)); }, true));
      const gc = E.el('input', null, null, { type: 'color' }); gc.value = st.groundColor; gc.addEventListener('change', () => apply(() => { st.groundColor = gc.value; }, true)); row('Ground colour', gc);
      box.appendChild(E.el('h4', null, 'Grid & snapping'));
      const gs = E.el('select');
      gs.innerHTML = [1, 2, 5, 10, 20, 50].map((g) => `<option value="${g}" ${g === this.grid ? 'selected' : ''}>${g} m</option>`).join('');
      gs.addEventListener('change', () => { this.grid = Number(gs.value); this.rebuildEnvironment(); });
      row('Grid size', gs);
      chk('Snap to grid (N)', this.snapGrid, (v) => { this.snapGrid = v; });
      chk('Snap to face (J)', this.snapFace, (v) => { this.snapFace = v; });
      chk('Rotation snap 90°', this.snapRot, (v) => { this.snapRot = v; });
      box.appendChild(E.el('h4', null, 'New tunnels'));
      num('Width (m)', this.tunnelSettings.width, 4, 400, 1, (v) => { this.tunnelSettings.width = v; });
      num('Height (m)', this.tunnelSettings.height, 4, 400, 1, (v) => { this.tunnelSettings.height = v; });
      const pf = E.el('select'); pf.innerHTML = '<option value="box">Box</option><option value="round">Round</option>'; pf.value = this.tunnelSettings.profile;
      pf.addEventListener('change', () => { this.tunnelSettings.profile = pf.value; }); row('Profile', pf);
      this.ui.name.value = this.map.name;
    }

    renderProperties() {
      const box = this.ui.props;
      box.innerHTML = '';
      const ids = [...this.selection];
      if (!ids.length) { box.innerHTML = '<p class="muted">Nothing selected. Click a shape, drag a box, or press Tab.</p>'; return; }
      const items = ids.map((id) => this.item(id)).filter(Boolean);
      if (!items.length) { box.innerHTML = '<p class="muted">Nothing selected.</p>'; return; }
      const first = items[0];
      const field = (label, input) => { const l = E.el('label', 'ed-field'); l.appendChild(E.el('span', '', label)); l.appendChild(input); box.appendChild(l); return input; };
      const vecRow = (label, arr, stepv, onSet) => {
        const wrap = E.el('div', 'ed-vec');
        arr.forEach((v, k) => {
          const i = E.el('input', null, null, { type: 'number', step: stepv, 'aria-label': `${label} ${'XYZ'[k]}` });
          i.value = round2(v);
          i.addEventListener('change', () => onSet(k, Number(i.value) || 0));
          wrap.appendChild(i);
        });
        field(label, wrap);
      };
      const isTunnel = !!first.points;
      box.appendChild(E.el('p', 'muted small', items.length > 1 ? `${items.length} items selected — edits apply to all.` : isTunnel ? `Tunnel · ${first.points.length} control points` : `${F.SHAPES[first.type].name}${first.group ? ' · grouped' : ''}`));
      if (items.length === 1 && !isTunnel) {
        vecRow('Position', first.pos, this.grid, (k, v) => { first.pos[k] = v; this.commit(); });
        vecRow('Rotation °', first.rot, this.snapRot ? 90 : 1, (k, v) => { first.rot[k] = cleanAngle(v); this.commit(); });
        vecRow('Scale (m)', first.scale, 1, (k, v) => { first.scale[k] = Math.max(0.2, Math.min(5000, v)); this.commit(); });
      }
      if (items.length === 1 && isTunnel) {
        const t = first;
        const n = (label, key, min, max) => { const i = E.el('input', null, null, { type: 'number', min, max, step: 1 }); i.value = t[key]; i.addEventListener('change', () => { t[key] = Math.max(min, Math.min(max, Number(i.value) || min)); this.commit(); }); field(label, i); };
        n('Width (m)', 'width', 4, 400); n('Height (m)', 'height', 4, 400);
        const pf = E.el('select'); pf.innerHTML = '<option value="box">Box</option><option value="round">Round</option>'; pf.value = t.profile;
        pf.addEventListener('change', () => { t.profile = pf.value; this.commit(); }); field('Profile', pf);
        const pl = E.el('ol', 'ed-points');
        t.points.forEach((p, i) => {
          const li = E.el('li', this.activeHandle === i ? 'on' : '');
          const b = E.el('button', 'linkish', `(${p.map((v) => Math.round(v)).join(', ')})`, { type: 'button', title: 'Select this control point (arrow keys move it, Delete removes it)' });
          b.addEventListener('click', () => { this.activeHandle = i; this.updateSelectionVisuals(); this.renderProperties(); });
          li.appendChild(b); pl.appendChild(li);
        });
        box.appendChild(pl);
        box.appendChild(E.button('Insert point after selected', 'Insert a control point', () => this.insertTunnelPoint()));
      }
      // Colour palette + custom picker.
      const sw = E.el('div', 'ed-swatches');
      for (const c of F.PALETTE) {
        const b = E.el('button', 'swatch' + (first.color === c ? ' on' : ''), '', { type: 'button', title: c, 'aria-label': `Colour ${c}` });
        b.style.background = c;
        b.addEventListener('click', () => this.setProp((it) => { it.color = c; }));
        sw.appendChild(b);
      }
      const custom = E.el('input', null, null, { type: 'color', 'aria-label': 'Custom colour' });
      custom.value = first.color;
      custom.addEventListener('change', () => this.setProp((it) => { it.color = custom.value; }));
      sw.appendChild(custom);
      field('Colour', sw);
      const mat = E.el('select');
      mat.innerHTML = F.MATERIALS.map((m) => `<option value="${m}">${m[0].toUpperCase() + m.slice(1)}</option>`).join('');
      mat.value = first.material;
      mat.addEventListener('change', () => this.setProp((it) => { it.material = mat.value; }));
      field('Material (M)', mat);
      const col = E.el('select');
      col.innerHTML = '<option value="collidable">Collidable</option><option value="decorative">Decorative (fly through)</option>';
      col.value = first.collide;
      col.addEventListener('change', () => this.setProp((it) => { it.collide = col.value; }));
      field('Collision (C)', col);
      const hz = E.el('input', null, null, { type: 'checkbox' });
      hz.checked = !!first.hazard;
      hz.addEventListener('change', () => this.setProp((it) => { it.hazard = hz.checked; }));
      field('Hazard — deadly (H)', hz);
      const row = E.el('div', 'ed-row');
      row.append(E.button('Duplicate', 'Duplicate', () => this.duplicateSelection()), E.button('Group', 'Group', () => this.groupSelection(false)), E.button('Ungroup', 'Ungroup', () => this.groupSelection(true)),
        E.button('Delete', 'Delete', () => this.deleteSelection(), 'btn-danger'));
      box.appendChild(row);
    }

    // ------------------------------------------------------------------ loop
    update() {
      this.cam.update();
      if (this.hoverDirty && this.lastPointer && !this.drag) {
        this.hoverDirty = false;
        const h = this.tool === 'place' || this.tool === 'tunnel' ? null : this.pickAt(this.lastPointer);
        const id = h ? h.id : null;
        if (id !== this.hover) { this.hover = id; this.view.refreshColors(); }
      }
      if (this.handles.length) { const s = Math.max(1.5, this.cam.dist * 0.006); for (const h of this.handles) h.scale.setScalar(s); }
    }
    render(renderer) { E.layoutPanels(this.ui.root); this.core.render(renderer); }

    exit() {
      this.unbindEvents();
      clearTimeout(this.reachTimer);
      this.view.dispose();
      this.cancelTunnel(true);
      if (this.ghost) { this.ghost.geometry.dispose(); this.ghost.material.dispose(); }
      for (const h of this.handles) this.core.scene.remove(h);
      this.handleGeo.dispose(); this.handleMat.dispose();
      if (this.draftMat) this.draftMat.dispose();
      if (this.env) for (const o of this.env) o.traverse((x) => { if (x.geometry) x.geometry.dispose(); if (x.material) x.material.dispose(); });
      this.selBox.geometry.dispose(); this.selBox.material.dispose();
      this.core.dispose();
      E.closeHelp(); E.closeModal();
      const el = document.getElementById('ed-boxsel'); if (el) el.remove();
      const root = document.getElementById('editor-ui');
      root.innerHTML = '';
      root.classList.add('hidden');
    }
  }

  const round2 = (v) => Math.round(v * 100) / 100;
  /** Keep angles in (-180, 180] and snap float noise (89.9999 → 90). */
  function cleanAngle(a) {
    let v = ((a % 360) + 540) % 360 - 180;
    const r = Math.round(v);
    if (Math.abs(v - r) < 1e-3) v = r;
    return v === -180 ? 180 : round2(v);
  }
  function skyForHour(h) {
    if (h < 5 || h > 20) return 0x1a2440;
    if (h < 7 || h > 18) return 0xe8a07a;
    return 0x87b5e0;
  }

  AV.Modes.MapBuilderMode = MapBuilderMode;
  AV.MapBuilder = { Session };
})(window.AV);
