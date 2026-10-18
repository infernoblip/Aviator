/* planebuilder.js — the Plane Builder editor mode.
 *
 * Parts come from AV.Parts (the shared catalog); stats come from AV.Physics using
 * the same flight model the game flies. The working design survives leaving the
 * editor (e.g. for a test flight) for the rest of the session.
 */
window.AV = window.AV || {};
(function (AV) {
  'use strict';
  const E = AV.EditorCore, Pa = AV.Parts, P = AV.Physics;
  const SNAP_PX = 70;
  const GRID_Y = -2.6;

  /** Survives mode switches: the document and its undo history. */
  const Session = { doc: null, history: null, savedId: null, dirty: false };

  const HELP = [
    ['Drag from palette', 'Add a part; it snaps to the nearest compatible mount'],
    ['Click palette item / Enter', 'Add a part at the best free mount (keyboard friendly)'],
    ['Click part', 'Select'], ['Drag part', 'Move it to another mount'],
    ['N / Shift+N', 'Move selected part to the next / previous free mount'],
    ['R / Shift+R', 'Rotate 90° around the roll axis'], ['E / Shift+E', 'Rotate 90° around the pitch axis'], ['Q / Shift+Q', 'Rotate 90° around the yaw axis'],
    ['Ctrl+D', 'Duplicate part (with attached parts)'], ['M', 'Mirror across the centreline'], ['X', 'Toggle symmetry mode'],
    ['Delete / Backspace', 'Delete part (and attached parts)'], ['Ctrl+Z / Ctrl+Shift+Z (Ctrl+Y)', 'Undo / redo'],
    ['[ / ]', 'Select previous / next part'], ['Arrows, PgUp/PgDn', 'Nudge a free (unattached) part on the grid'],
    ['Right-drag / Alt+Arrows', 'Orbit camera'], ['Middle-drag or Shift+right-drag', 'Pan'], ['Wheel / + / −', 'Zoom'], ['F', 'Frame selection or whole aircraft'],
    ['1 … 7', 'Jump to a palette category'], ['Ctrl+S', 'Save design'], ['Ctrl+Enter', 'Test flight'], ['Esc', 'Cancel drag / deselect / leave editor'], ['?', 'This help'],
  ];

  const fmt = {
    speed: (v) => `${Math.round(v * 3.6)} km/h`,
    range: (m) => (m > 0 ? (m >= 10000 ? `${Math.round(m / 1000)} km` : `${(m / 1000).toFixed(1)} km`) : '—'),
  };

  class PlaneBuilderMode extends AV.Modes.BaseMode {
    enter() {
      this.allowPause = false;
      this.canvas = this.game.renderer.domElement;
      this.core = new E.EditorScene({ background: 0x18222f, far: 3000 });
      this.cam = new E.OrbitControls(this.core.camera, { dist: 26, minDist: 4, maxDist: 180 });
      this.cam.yaw = 2.35; this.cam.pitch = 0.42;
      const grid = new THREE.GridHelper(60, 120, 0x56789a, 0x2b3b4c);
      grid.position.y = GRID_Y;
      this.core.add(grid, true);
      const floor = new THREE.Mesh(new THREE.CircleGeometry(40, 48), new THREE.MeshLambertMaterial({ color: 0x1e2a38 }));
      floor.rotation.x = -Math.PI / 2; floor.position.y = GRID_Y - 0.02;
      this.core.add(floor, true);
      this.mats = {
        normal: new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.5, metalness: 0.15, flatShading: true }),
        selected: new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.5, flatShading: true, emissive: 0x1f8fff, emissiveIntensity: 0.65 }),
        pair: new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.5, flatShading: true, emissive: 0x1f5f9f, emissiveIntensity: 0.4 }),
        hover: new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.5, flatShading: true, emissive: 0x777777, emissiveIntensity: 0.5 }),
        invalid: new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.5, flatShading: true, emissive: 0xff1a1a, emissiveIntensity: 0.7 }),
        ghostOk: new THREE.MeshBasicMaterial({ color: 0x5dffc8, transparent: true, opacity: 0.45, depthWrite: false }),
        ghostBad: new THREE.MeshBasicMaterial({ color: 0xff5050, transparent: true, opacity: 0.45, depthWrite: false }),
      };
      this.meshes = new Map();
      this.markers = new THREE.InstancedMesh(new THREE.SphereGeometry(0.17, 10, 6), new THREE.MeshBasicMaterial({ color: 0xffffff, depthTest: false, transparent: true }), 800);
      this.markers.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(800 * 3), 3);
      this.markers.count = 0; this.markers.renderOrder = 10; this.markers.frustumCulled = false;
      this.core.add(this.markers, true);
      const dot = (color) => { const m = new THREE.Mesh(new THREE.SphereGeometry(0.28, 14, 10), new THREE.MeshBasicMaterial({ color, depthTest: false })); m.renderOrder = 11; return this.core.add(m, true); };
      this.cgMarker = dot(0xffd23f); this.npMarker = dot(0x35e0ff);
      this.raycaster = new THREE.Raycaster();
      this.ndc = new THREE.Vector2();
      if (!Session.doc) this.loadDoc(Pa.starterDesign(), null);
      if (this.params && this.params.design) this.loadDoc(this.params.design, this.params.savedId || null);
      this.symmetry = true;
      this.selected = null; this.hover = null; this.drag = null;
      this.buildUI();
      this.bindEvents();
      this.refresh();
      this.frame(true);
      AV.Audio.setMusicMood('menu');
      AV.Input.showTouch(false);
    }

    loadDoc(design, savedId) {
      Session.doc = JSON.parse(JSON.stringify(design));
      Session.history = new E.History(150);
      Session.history.reset(JSON.stringify(Session.doc));
      Session.savedId = savedId;
      Session.dirty = false;
    }
    get doc() { return Session.doc; }

    // ------------------------------------------------------------------ model
    part(uid) { return this.doc.parts.find((p) => p.uid === uid) || null; }
    subtree(uid) {
      const out = [uid];
      for (let i = 0; i < out.length; i++) for (const p of this.doc.parts) if (p.parent === out[i] && !out.includes(p.uid)) out.push(p.uid);
      return out;
    }
    nextUid() {
      let n = 1;
      for (const p of this.doc.parts) { const m = /^p(\d+)$/.exec(p.uid); if (m) n = Math.max(n, Number(m[1]) + 1); }
      return 'p' + n;
    }

    /** Push an undo snapshot and re-derive everything. */
    commit() {
      if (Session.history.push(JSON.stringify(this.doc))) Session.dirty = true;
      this.refresh();
    }
    undo() { const s = Session.history.undo(); if (s) { Session.doc = JSON.parse(s); this.afterHistory(); } else E.sound('invalid'); }
    redo() { const s = Session.history.redo(); if (s) { Session.doc = JSON.parse(s); this.afterHistory(); } else E.sound('invalid'); }
    afterHistory() {
      if (this.selected && !this.part(this.selected)) this.selected = null;
      Session.dirty = true;
      this.refresh();
      this.ui.name.value = this.doc.name;
      E.sound('snap');
    }

    refresh() {
      this.resolved = Pa.resolveDesign(this.doc);
      const ok = this.resolved.list.length > 0;
      this.spec = ok ? P.buildSpecFromDesign(this.resolved, AV.Save.data.hangar.upgrades, this.doc.name) : null;
      this.perf = this.spec ? P.estimatePerformance(this.spec) : null;
      this.validation = Pa.validateDesign(this.doc, this.resolved, this.spec);
      this.bad = new Set();
      for (const e of this.validation.errors) { if (e.uid) this.bad.add(e.uid); if (e.other) this.bad.add(e.other); }
      this.syncMeshes();
      this.renderPanels();
    }

    syncMeshes() {
      const live = new Set();
      for (const rec of this.resolved.list) {
        live.add(rec.uid);
        let e = this.meshes.get(rec.uid);
        if (e && e.partId !== rec.def.id) { this.removeMesh(rec.uid); e = null; }
        if (!e) {
          const mesh = new THREE.Mesh(Pa.acquireGeometry(rec.def.id), this.mats.normal);
          mesh.matrixAutoUpdate = false;
          mesh.userData.uid = rec.uid;
          this.core.scene.add(mesh);
          e = { mesh, partId: rec.def.id };
          this.meshes.set(rec.uid, e);
        }
        e.mesh.matrix.fromArray(rec.matrix);
        e.mesh.matrixWorldNeedsUpdate = true;
      }
      for (const uid of [...this.meshes.keys()]) if (!live.has(uid)) this.removeMesh(uid);
      this.applyMaterials();
      if (this.spec) {
        const cg = this.spec.design.cg;
        this.cgMarker.position.set(cg[0], cg[1], cg[2]);
        this.npMarker.position.set(cg[0], cg[1], this.spec.design.neutralPoint);
      }
      this.cgMarker.visible = this.npMarker.visible = !!this.spec && this.resolved.list.some((r) => r.def.category === 'wing');
    }
    removeMesh(uid) {
      const e = this.meshes.get(uid);
      if (!e) return;
      this.core.scene.remove(e.mesh);
      Pa.releaseGeometry(e.partId);   // geometry is disposed when no part of this type remains
      this.meshes.delete(uid);
    }
    applyMaterials() {
      const sel = this.selected ? this.part(this.selected) : null;
      for (const [uid, e] of this.meshes) {
        let m = this.mats.normal;
        if (this.bad.has(uid)) m = this.mats.invalid;
        if (uid === this.hover) m = this.mats.hover;
        if (sel && sel.pair === uid) m = this.mats.pair;
        if (uid === this.selected) m = this.mats.selected;
        e.mesh.material = m;
        e.mesh.visible = !(this.drag && this.drag.mode === 'move' && this.drag.moving.has(uid));
      }
    }

    // ------------------------------------------------------------------ mounts
    /** Free attach points that accept `partId`, excluding parts in `exclude` (the moving subtree). */
    mounts(partId, exclude) {
      const def = Pa.CATALOG[partId], out = [];
      for (const rec of this.resolved.list) {
        if (exclude && exclude.has(rec.uid)) continue;
        for (const a of rec.def.attach) {
          const socketType = a.accepts.find((t) => def.sockets[t]);
          if (!socketType) continue;
          const occ = this.resolved.occupied.get(rec.uid + ':' + a.id);
          if (occ && !(exclude && exclude.has(occ))) continue;
          const w = Pa.attachWorld(rec, a);
          out.push({ parent: rec.uid, attach: a.id, rec, a, socket: def.sockets[socketType], pos: w.pos });
        }
      }
      return out;
    }
    mountMatrix(m, partId, rot) { return Pa.childMatrix(m.rec.matrix, m.a, m.socket, rot || [0, 0, 0]); }

    /** Mirror counterpart of a mount if it is free (or occupied by something in `exclude`). */
    freeMirror(parent, attach, exclude) {
      const mt = Pa.mirrorTarget(this.doc, this.resolved, parent, attach);
      if (!mt || (mt.parent === parent && mt.attach === attach)) return null;
      const occ = this.resolved.occupied.get(mt.parent + ':' + mt.attach);
      return !occ || (exclude && exclude.has(occ)) ? mt : null;
    }

    // ------------------------------------------------------------------ actions
    addPart(partId, target) {
      const uid = this.nextUid();
      const p = { uid, part: partId, parent: target.parent || null, attach: target.attach || null, pos: target.pos || [0, 0, 0], rot: [0, 0, 0], mirror: false, pair: null };
      let twin = null;
      if (this.symmetry && target.parent) {
        const mt = this.freeMirror(target.parent, target.attach);
        if (mt) twin = { uid: 'p' + (Number(uid.slice(1)) + 1), part: partId, parent: mt.parent, attach: mt.attach, pos: [0, 0, 0], rot: [0, 0, 0], mirror: false, pair: uid };
      }
      this.doc.parts.push(p);
      if (twin) { p.pair = twin.uid; this.doc.parts.push(twin); }
      this.selected = uid;
      this.commit();
      const rec = this.resolved.byUid.get(uid);
      E.sound(rec && rec.floating ? 'invalid' : 'place');
      if (rec && rec.floating) this.status(`${Pa.CATALOG[partId].name} is floating — drag it onto a mount (or press N).`, 'warn');
      return uid;
    }

    /** Palette click / Enter: attach at the best free mount without a mouse. */
    quickAdd(partId) {
      const def = Pa.CATALOG[partId];
      if (!this.doc.parts.length) {
        if (def.category !== 'fuselage') { E.sound('invalid'); this.status('Start with a fuselage — every other part attaches to it.', 'warn'); return; }
        this.addPart(partId, { pos: [0, 0, 0] });
        return;
      }
      const all = this.mounts(partId);
      const prefer = this.selected ? all.filter((m) => m.parent === this.selected) : [];
      const m = prefer[0] || all[0];
      if (!m) { E.sound('invalid'); this.status(`No free mount accepts ${def.name}.`, 'warn'); return; }
      this.addPart(partId, { parent: m.parent, attach: m.attach });
    }

    moveTo(uid, target) {
      const p = this.part(uid);
      if (!p) return;
      const moving = new Set(this.subtree(uid));
      const pair = this.symmetry && p.pair ? this.part(p.pair) : null;
      if (pair) for (const u of this.subtree(pair.uid)) moving.add(u);
      const mt = pair && target.parent ? this.freeMirror(target.parent, target.attach, moving) : null;
      p.parent = target.parent || null; p.attach = target.attach || null;
      if (target.pos) p.pos = target.pos;
      if (pair) {
        if (target.parent && mt) { pair.parent = mt.parent; pair.attach = mt.attach; }
        else if (!target.parent) { pair.parent = null; pair.attach = null; pair.pos = [-p.pos[0], p.pos[1], p.pos[2]]; pair.mirror = !p.mirror; }
        else { pair.pair = null; p.pair = null; }
      }
      this.commit();
      const rec = this.resolved.byUid.get(uid);
      E.sound(rec && rec.floating ? 'invalid' : 'snap');
    }

    deleteSelected() {
      const p = this.selected && this.part(this.selected);
      if (!p) { E.sound('invalid'); return; }
      const kill = new Set(this.subtree(p.uid));
      if (this.symmetry && p.pair && this.part(p.pair)) for (const u of this.subtree(p.pair)) kill.add(u);
      this.doc.parts = this.doc.parts.filter((x) => !kill.has(x.uid));
      for (const x of this.doc.parts) if (x.pair && kill.has(x.pair)) x.pair = null;
      this.selected = null;
      this.commit();
      E.sound('delete');
      this.status(`Deleted ${kill.size} part${kill.size === 1 ? '' : 's'}.`);
    }

    /** Copy a subtree; `attachFn(rootClone)` decides where the copy goes. Returns the clone uid map. */
    cloneSubtree(uid, place) {
      const uids = this.subtree(uid);
      const map = new Map();
      let n = Number(this.nextUid().slice(1));
      for (const u of uids) map.set(u, 'p' + n++);
      const clones = uids.map((u) => {
        const src = this.part(u);
        const c = JSON.parse(JSON.stringify(src));
        c.uid = map.get(u);
        if (u !== uid) c.parent = map.get(src.parent);
        c.pair = src.pair && map.has(src.pair) ? map.get(src.pair) : null;
        return c;
      });
      place(clones[0]);
      this.doc.parts.push(...clones);
      return map;
    }

    duplicateSelected() {
      const p = this.selected && this.part(this.selected);
      if (!p) { E.sound('invalid'); return; }
      const free = this.mounts(p.part).filter((m) => !(m.parent === p.parent && m.attach === p.attach));
      const here = this.resolved.byUid.get(p.uid).center;
      free.sort((a, b) => dist2(a.pos, here) - dist2(b.pos, here));
      const map = this.cloneSubtree(p.uid, (c) => {
        c.pair = null;
        if (free[0]) { c.parent = free[0].parent; c.attach = free[0].attach; }
        else { c.parent = null; c.attach = null; c.pos = [here[0], here[1], here[2] + 3]; }
      });
      this.selected = map.get(p.uid);
      this.commit();
      const rec = this.resolved.byUid.get(this.selected);
      E.sound(rec && rec.floating ? 'invalid' : 'place');
    }

    mirrorSelected() {
      const p = this.selected && this.part(this.selected);
      if (!p) { E.sound('invalid'); return; }
      if (p.pair && this.part(p.pair)) { this.status('This part already has a mirrored twin.', 'warn'); E.sound('invalid'); return; }
      let place;
      if (p.parent) {
        const mt = this.freeMirror(p.parent, p.attach);
        if (!mt) { this.status('No free mirrored mount on the other side (centreline parts are already symmetric).', 'warn'); E.sound('invalid'); return; }
        place = (c) => { c.parent = mt.parent; c.attach = mt.attach; };
      } else {
        place = (c) => { c.pos = [-p.pos[0], p.pos[1], p.pos[2]]; c.mirror = !p.mirror; };
      }
      const map = this.cloneSubtree(p.uid, place);
      for (const [orig, copy] of map) { this.part(orig).pair = copy; this.part(copy).pair = orig; }
      this.commit();
      E.sound('place');
    }

    rotateSelected(axis, dir) {
      const p = this.selected && this.part(this.selected);
      if (!p) { E.sound('invalid'); return; }
      const spin = (x) => { x.rot = x.rot || [0, 0, 0]; x.rot[axis] = (((x.rot[axis] || 0) + dir) % 4 + 4) % 4; };
      spin(p);
      if (this.symmetry && p.pair && this.part(p.pair)) spin(this.part(p.pair)); // mirroring makes the same local rotation symmetric
      this.commit();
      E.sound('snap');
    }

    /** Keyboard move: hop to the next free compatible mount (fore → aft, staying on the same side). */
    cycleMount(dir) {
      const p = this.selected && this.part(this.selected);
      if (!p) { E.sound('invalid'); return; }
      const moving = new Set(this.subtree(p.uid));
      let list = this.mounts(p.part, moving);
      const curA = p.parent && this.resolved.byUid.get(p.parent) ? this.resolved.byUid.get(p.parent).def.attach.find((a) => a.id === p.attach) : null;
      if (p.parent && !list.some((m) => m.parent === p.parent && m.attach === p.attach)) list.push({ parent: p.parent, attach: p.attach, a: curA || { pos: [0, 0, 0] } });
      // A mirrored pair keeps its side: the twin follows on the opposite mount.
      if (this.symmetry && p.pair && curA && curA.side) list = list.filter((m) => !m.a.side || m.a.side === curA.side);
      const order = new Map(this.resolved.list.map((r, i) => [r.uid, i]));
      list.sort((a, b) => (order.get(a.parent) - order.get(b.parent)) || (a.a.pos[2] - b.a.pos[2]) || (a.a.pos[0] - b.a.pos[0]) || (a.attach < b.attach ? -1 : 1));
      if (!list.length) { E.sound('invalid'); return; }
      const i = list.findIndex((m) => m.parent === p.parent && m.attach === p.attach);
      const m = list[((i < 0 ? -1 : i) + dir + list.length) % list.length];
      if (m.parent === p.parent && m.attach === p.attach) { E.sound('invalid'); this.status('No other free mount for this part.', 'warn'); return; }
      this.moveTo(p.uid, { parent: m.parent, attach: m.attach });
    }

    nudgeFree(dx, dy, dz) {
      const p = this.selected && this.part(this.selected);
      if (!p || p.parent) { E.sound('invalid'); this.status('Only unattached parts move on the grid — use N to hop between mounts.', 'warn'); return; }
      p.pos = [p.pos[0] + dx, p.pos[1] + dy, p.pos[2] + dz];
      if (this.symmetry && p.pair && this.part(p.pair) && !this.part(p.pair).parent) this.part(p.pair).pos = [-p.pos[0], p.pos[1], p.pos[2]];
      this.commit();
    }

    select(uid) {
      this.selected = uid;
      this.applyMaterials();
      this.renderProperties();
    }

    cycleSelection(dir) {
      const list = this.resolved.list;
      if (!list.length) return;
      const i = list.findIndex((r) => r.uid === this.selected);
      this.select(list[((i < 0 ? (dir > 0 ? -1 : 0) : i) + dir + list.length) % list.length].uid);
    }

    frame(all) {
      const recs = !all && this.selected ? [this.resolved.byUid.get(this.selected)].filter(Boolean) : this.resolved.list;
      if (!recs.length) { this.cam.focus(new THREE.Vector3(0, 0, 0), 26); return; }
      const box = new THREE.Box3();
      for (const r of recs) { box.expandByPoint(new THREE.Vector3(...r.aabb.min)); box.expandByPoint(new THREE.Vector3(...r.aabb.max)); }
      const size = box.getSize(new THREE.Vector3()).length();
      this.cam.focus(box.getCenter(new THREE.Vector3()), Math.max(6, size * 1.25));
    }

    // ------------------------------------------------------------------ dragging
    pick(e) {
      E.ndc(e, this.canvas, this.ndc);
      this.raycaster.setFromCamera(this.ndc, this.core.camera);
      const hits = this.raycaster.intersectObjects([...this.meshes.values()].map((x) => x.mesh), false);
      return hits.length ? hits[0].object.userData.uid : null;
    }

    startDrag(mode, partId, uid) {
      const moving = new Set(uid ? this.subtree(uid) : []);
      this.drag = { mode, partId, uid, moving, target: null, mounts: this.mounts(partId, moving) };
      if (this.ghost) { this.core.scene.remove(this.ghost); Pa.releaseGeometry(this.ghost.userData.partId); }
      this.ghost = new THREE.Mesh(Pa.acquireGeometry(partId), this.mats.ghostOk);
      this.ghost.matrixAutoUpdate = false;
      this.ghost.userData.partId = partId;
      this.core.scene.add(this.ghost);
      this.applyMaterials();
    }

    updateDrag(e) {
      const d = this.drag;
      const r = this.canvas.getBoundingClientRect();
      const mx = e.clientX - r.left, my = e.clientY - r.top;
      const v = new THREE.Vector3();
      let best = null, bd = SNAP_PX * SNAP_PX;
      for (const m of d.mounts) {
        v.set(m.pos[0], m.pos[1], m.pos[2]).project(this.core.camera);
        if (v.z > 1) continue;
        const sx = (v.x * 0.5 + 0.5) * r.width, sy = (-v.y * 0.5 + 0.5) * r.height;
        const dd = (sx - mx) ** 2 + (sy - my) ** 2;
        if (dd < bd) { bd = dd; best = m; }
      }
      const rot = d.uid ? (this.part(d.uid).rot || [0, 0, 0]) : [0, 0, 0];
      let matrix, valid = true;
      if (best) {
        matrix = this.mountMatrix(best, d.partId, rot);
        d.target = { parent: best.parent, attach: best.attach };
      } else {
        E.ndc(e, this.canvas, this.ndc);
        this.raycaster.setFromCamera(this.ndc, this.core.camera);
        const hit = new THREE.Vector3();
        if (!this.raycaster.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 1, 0), 0), hit)) hit.set(0, 0, 0);
        const pos = [Math.round(hit.x * 2) / 2, 0, Math.round(hit.z * 2) / 2];
        matrix = Pa.M4.translate(pos[0], pos[1], pos[2]);
        d.target = { pos };
        // Only a first fuselage (or moving the root itself) may sit free on the grid.
        const isRoot = d.uid && this.resolved.root && this.resolved.root.uid === d.uid;
        valid = (!this.doc.parts.length && Pa.CATALOG[d.partId].category === 'fuselage') || isRoot;
      }
      const key = best ? best.parent + ':' + best.attach : 'free';
      if (key !== d.lastKey) { if (best) E.sound('snap'); d.lastKey = key; }
      this.ghost.matrix.fromArray(matrix);
      this.ghost.matrixWorldNeedsUpdate = true;
      this.ghost.material = valid ? this.mats.ghostOk : this.mats.ghostBad;
      d.valid = valid;
      this.canvas.style.cursor = valid ? 'copy' : 'not-allowed';
      this.writeMarkers(d.mounts, best);
    }

    writeMarkers(list, best) {
      const m4 = new THREE.Matrix4(), c = new THREE.Color();
      let n = 0;
      for (const m of list) {
        if (n >= 800) break;
        const big = m === best;
        m4.makeScale(big ? 2 : 1, big ? 2 : 1, big ? 2 : 1).setPosition(m.pos[0], m.pos[1], m.pos[2]);
        this.markers.setMatrixAt(n, m4);
        this.markers.setColorAt(n, c.set(big ? 0xffd23f : 0x35e0ff));
        n++;
      }
      this.markers.count = n;
      this.markers.instanceMatrix.needsUpdate = true;
      if (this.markers.instanceColor) this.markers.instanceColor.needsUpdate = true;
    }

    finishDrag(e, cancel) {
      const d = this.drag;
      this.drag = null;
      this.markers.count = 0;
      this.canvas.style.cursor = '';
      if (this.ghost) { this.core.scene.remove(this.ghost); Pa.releaseGeometry(this.ghost.userData.partId); this.ghost = null; }
      const overCanvas = e && document.elementFromPoint(e.clientX, e.clientY) === this.canvas;
      if (cancel || !d || !d.target || !overCanvas) { this.applyMaterials(); return; }
      if (!d.valid) E.sound('invalid');
      if (d.mode === 'add') this.addPart(d.partId, d.target);
      else this.moveTo(d.uid, d.target);
    }

    // ------------------------------------------------------------------ events
    bindEvents() {
      const c = this.canvas;
      this.handlers = {
        down: (e) => this.onPointerDown(e), move: (e) => this.onPointerMove(e), up: (e) => this.onPointerUp(e),
        wheel: (e) => { if (e.target === c) { this.cam.wheel(e); e.preventDefault(); } }, key: (e) => this.onKey(e),
        ctx: (e) => { if (e.target === c) e.preventDefault(); },
      };
      c.addEventListener('pointerdown', this.handlers.down);
      window.addEventListener('pointermove', this.handlers.move);
      window.addEventListener('pointerup', this.handlers.up);
      window.addEventListener('wheel', this.handlers.wheel, { passive: false });
      window.addEventListener('keydown', this.handlers.key);
      window.addEventListener('contextmenu', this.handlers.ctx);
    }
    unbindEvents() {
      const c = this.canvas, h = this.handlers;
      c.removeEventListener('pointerdown', h.down);
      window.removeEventListener('pointermove', h.move);
      window.removeEventListener('pointerup', h.up);
      window.removeEventListener('wheel', h.wheel);
      window.removeEventListener('keydown', h.key);
      window.removeEventListener('contextmenu', h.ctx);
    }

    onPointerDown(e) {
      AV.Audio.init();
      if (this.cam.pointerDown(e)) { e.preventDefault(); return; }
      if (e.button !== 0) return;
      const uid = this.pick(e);
      this.select(uid);
      this.pending = uid ? { uid, x: e.clientX, y: e.clientY } : null;
    }
    onPointerMove(e) {
      if (this.cam.pointerMove(e)) return;
      if (this.paletteDown && !this.drag && Math.hypot(e.clientX - this.paletteDown.x, e.clientY - this.paletteDown.y) > 6) {
        this.startDrag('add', this.paletteDown.partId);
      }
      if (this.pending && !this.drag && Math.hypot(e.clientX - this.pending.x, e.clientY - this.pending.y) > 6) {
        const p = this.part(this.pending.uid);
        if (p) this.startDrag('move', p.part, p.uid);
        this.pending = null;
      }
      if (this.drag) { this.updateDrag(e); return; }
      if (e.target === this.canvas) {
        const h = this.pick(e);
        if (h !== this.hover) { this.hover = h; this.applyMaterials(); }
      }
    }
    onPointerUp(e) {
      if (this.cam.pointerUp()) return;
      if (this.drag) this.finishDrag(e);
      else if (this.paletteDown && e.target.closest && e.target.closest('[data-part]')) this.quickAdd(this.paletteDown.partId);
      this.paletteDown = null;
      this.pending = null;
    }

    onKey(e) {
      if (AV.Game.mode !== this) return;
      const k = e.key, lower = k.length === 1 ? k.toLowerCase() : k, ctrl = e.ctrlKey || e.metaKey;
      if (E.typingIn(e)) { if (k === 'Escape') e.target.blur(); return; }
      if (k === '?') { E.showHelp('Plane Builder', HELP); e.preventDefault(); return; }
      if (E.helpOpen() || E.modalOpen()) { if (k === 'Escape') { E.closeHelp(); E.closeModal(); } return; }
      let handled = true;
      if (ctrl && lower === 'z') { if (e.shiftKey) this.redo(); else this.undo(); }
      else if (ctrl && lower === 'y') this.redo();
      else if (ctrl && lower === 'd') this.duplicateSelected();
      else if (ctrl && lower === 's') this.saveDesign(false);
      else if (ctrl && k === 'Enter') this.testFlight();
      else if (ctrl) handled = false;
      else if (k === 'Delete' || k === 'Backspace') this.deleteSelected();
      else if (lower === 'm') this.mirrorSelected();
      else if (lower === 'x') this.toggleSymmetry();
      else if (lower === 'r') this.rotateSelected(2, e.shiftKey ? -1 : 1);
      else if (lower === 'e') this.rotateSelected(0, e.shiftKey ? -1 : 1);
      else if (lower === 'q') this.rotateSelected(1, e.shiftKey ? -1 : 1);
      else if (lower === 'n') this.cycleMount(e.shiftKey ? -1 : 1);
      else if (k === '[') this.cycleSelection(-1);
      else if (k === ']') this.cycleSelection(1);
      else if (lower === 'f') this.frame(!this.selected);
      else if (k === '=' || k === '+') this.cam.zoom(1 / 1.15);
      else if (k === '-' || k === '_') this.cam.zoom(1.15);
      else if (k.startsWith('Arrow') && e.altKey) this.cam.orbit(k === 'ArrowLeft' ? 0.12 : k === 'ArrowRight' ? -0.12 : 0, k === 'ArrowUp' ? 0.08 : k === 'ArrowDown' ? -0.08 : 0);
      else if (k.startsWith('Arrow')) this.nudgeFree(k === 'ArrowLeft' ? -0.5 : k === 'ArrowRight' ? 0.5 : 0, 0, k === 'ArrowUp' ? -0.5 : k === 'ArrowDown' ? 0.5 : 0);
      else if (k === 'PageUp' || k === 'PageDown') this.nudgeFree(0, k === 'PageUp' ? 0.5 : -0.5, 0);
      else if (k >= '1' && k <= '7') { const b = this.ui.left.querySelectorAll('.ed-cat')[Number(k) - 1]; if (b) { b.querySelector('[data-part]').focus(); } }
      else if (k === 'Escape') {
        if (this.drag) this.finishDrag(null, true);
        else if (this.selected) this.select(null);
        else this.leave();
      } else handled = false;
      if (handled) e.preventDefault();
    }

    toggleSymmetry() {
      this.symmetry = !this.symmetry;
      this.ui.sym.setAttribute('aria-pressed', String(this.symmetry));
      this.ui.sym.classList.toggle('on', this.symmetry);
      this.status(`Symmetry ${this.symmetry ? 'on — wings, engines and other side parts are mirrored automatically' : 'off'}.`);
      E.sound('snap');
    }

    leave() { this.game.goto('menu'); }

    // ------------------------------------------------------------------ saving / flying
    thumbnail() {
      const c = this.cam, saved = { yaw: c.yaw, pitch: c.pitch, dist: c.dist, t: c.target.clone() };
      this.frame(true);
      c.yaw = 2.35; c.pitch = 0.38;
      c.update();
      this.markers.visible = false;
      const url = this.core.thumbnail(this.game.renderer, 192, 120);
      this.markers.visible = true;
      Object.assign(c, { yaw: saved.yaw, pitch: saved.pitch, dist: saved.dist }); c.target.copy(saved.t);
      return url;
    }

    saveDesign(asNew) {
      if (!this.validation.ok) { E.sound('invalid'); this.status(`Fix ${this.validation.errors.length} problem(s) before saving.`, 'bad'); return false; }
      const r = AV.Creative.saveDesign(this.doc, this.thumbnail(), asNew ? null : Session.savedId);
      if (!r.ok) { E.sound('invalid'); AV.UI.toast(r.error, 'warn', 4); return false; }
      Session.savedId = r.id; Session.dirty = false;
      AV.UI.toast(`Saved “${this.doc.name}”`, 'good');
      E.sound('place');
      this.renderPanels();
      return true;
    }

    testFlight() {
      if (!this.validation.ok) { E.sound('invalid'); this.status('Fix the problems in red before a test flight.', 'bad'); return; }
      this.game.goto('freeflight', { design: JSON.parse(JSON.stringify(this.doc)), returnTo: 'planeBuilder', label: this.doc.name });
    }

    exportDesign() {
      E.downloadJSON(this.doc, `${(this.doc.name || 'plane').replace(/[^a-z0-9_-]+/gi, '_')}.aviator-plane.json`);
      this.status('Exported design JSON.');
    }

    importDesign() {
      E.importDialog('Import aircraft design', (text) => {
        const { design, warnings } = Pa.importDesign(text);
        this.loadDoc(design, null);
        this.selected = null;
        this.refresh();
        this.ui.name.value = this.doc.name;
        this.frame(true);
        return warnings.length ? `Imported with notes: ${warnings.join(' ')}` : `Imported “${design.name}” (${design.parts.length} parts).`;
      });
    }

    openDesigns() {
      E.modal('Saved designs', (body, close) => {
        const C = AV.Creative, list = C.designs();
        body.innerHTML = `<p class="muted">${list.length} / ${C.MAX_DESIGNS} slots used. Designs marked ✈ fly in crash mode and free flight.</p>`;
        const row = E.el('div', 'ed-row');
        row.append(E.button('Save current', 'Save the current design', () => { if (this.saveDesign(false)) { close(); this.openDesigns(); } }, 'btn-primary'),
          E.button('Save as new copy', 'Save as a new design', () => { if (this.saveDesign(true)) { close(); this.openDesigns(); } }));
        body.appendChild(row);
        const grid = E.el('div', 'design-grid');
        for (const d of list) {
          const card = E.el('div', 'design-card' + (AV.Save.data.hangar.custom === d.id ? ' flying' : ''));
          card.innerHTML = `${d.thumb ? `<img src="${d.thumb}" alt="">` : '<div class="no-thumb">✈</div>'}<b>${E.esc(d.name)}</b><small>${new Date(d.updated).toLocaleString()} · ${d.data.parts.length} parts</small>`;
          const acts = E.el('div', 'ed-row');
          acts.append(
            E.button('Load', `Load ${d.name}`, () => { close(); this.discardThen(() => { this.loadDoc(d.data, d.id); this.selected = null; this.refresh(); this.ui.name.value = this.doc.name; this.frame(true); }); }),
            E.button(AV.Save.data.hangar.custom === d.id ? '✈ Flying' : 'Fly this', 'Use in crash mode and free flight', () => { C.selectCustom(AV.Save.data.hangar.custom === d.id ? null : d.id); close(); this.openDesigns(); }),
            E.button('Delete', `Delete ${d.name}`, (ev) => {
              if (ev.target.dataset.armed) { C.deleteDesign(d.id); if (Session.savedId === d.id) Session.savedId = null; E.sound('delete'); close(); this.openDesigns(); }
              else { ev.target.dataset.armed = '1'; ev.target.textContent = 'Confirm delete'; ev.target.classList.add('btn-danger'); }
            }));
          card.appendChild(acts);
          grid.appendChild(card);
        }
        if (!list.length) grid.innerHTML = '<p class="muted">No saved designs yet.</p>';
        body.appendChild(grid);
      });
    }

    /** Run `fn` now, or after the player confirms throwing away unsaved work. */
    discardThen(fn) {
      if (!Session.dirty) { fn(); return; }
      AV.UI.confirm('Discard changes?', 'The current design has unsaved changes.', fn);
    }

    newDesign(starter) {
      this.discardThen(() => {
        this.loadDoc(starter ? Pa.starterDesign() : Pa.emptyDesign('New plane'), null);
        this.selected = null;
        this.refresh();
        this.ui.name.value = this.doc.name;
        this.frame(true);
      });
    }

    // ------------------------------------------------------------------ UI
    buildUI() {
      const root = document.getElementById('editor-ui');
      root.innerHTML = '';
      root.className = 'ed-root';
      root.classList.remove('hidden');
      const B = E.button;
      const bar = E.el('div', 'ed-toolbar', null, { role: 'toolbar', 'aria-label': 'Plane Builder tools' });
      const name = E.el('input', 'ed-name', null, { type: 'text', maxlength: '40', 'aria-label': 'Design name' });
      name.value = this.doc.name;
      name.addEventListener('change', () => { this.doc.name = name.value.trim() || 'My plane'; this.commit(); });
      const sym = B('⇋ Symmetry', 'Toggle symmetry (X)', () => this.toggleSymmetry(), 'toggle on');
      sym.setAttribute('aria-pressed', 'true');
      const snd = B('♪', 'Editor sounds on/off', () => {
        const s = AV.Save.data.settings; s.editorSounds = !s.editorSounds; AV.Save.save();
        snd.classList.toggle('on', s.editorSounds); snd.setAttribute('aria-pressed', String(s.editorSounds)); this.status(`Editor sounds ${s.editorSounds ? 'on' : 'muted'}.`);
      }, 'toggle' + (AV.Save.data.settings.editorSounds ? ' on' : ''));
      snd.setAttribute('aria-pressed', String(AV.Save.data.settings.editorSounds));
      this.ui = { root, name, sym };
      this.ui.undo = B('↶', 'Undo (Ctrl+Z)', () => this.undo());
      this.ui.redo = B('↷', 'Redo (Ctrl+Shift+Z)', () => this.redo());
      bar.append(
        B('◀ Menu', 'Back to the main menu (work is kept for this session)', () => this.leave()),
        E.el('span', 'ed-title', 'Plane Builder'), name,
        B('New', 'New blank design', () => this.newDesign(false)), B('Starter', 'Load the starter trainer', () => this.newDesign(true)),
        this.ui.undo, this.ui.redo, sym,
        B('⟲ Rotate', 'Rotate selected part (R)', () => this.rotateSelected(2, 1)), B('⇆ Mirror', 'Mirror selected part (M)', () => this.mirrorSelected()),
        B('⧉ Duplicate', 'Duplicate (Ctrl+D)', () => this.duplicateSelected()), B('🗑 Delete', 'Delete (Del)', () => this.deleteSelected()),
        snd, B('?', 'Keyboard shortcuts (?)', () => E.showHelp('Plane Builder', HELP)),
        B('💾 Save', 'Save design (Ctrl+S)', () => this.saveDesign(false)), B('Designs', 'Saved designs', () => this.openDesigns()),
        B('Export', 'Export design as JSON', () => this.exportDesign()), B('Import', 'Import design JSON', () => this.importDesign()),
        B('✈ Test flight', 'Fly this design (Ctrl+Enter)', () => this.testFlight(), 'btn-primary'));
      const left = E.el('aside', 'ed-panel ed-left', null, { 'aria-label': 'Part palette' });
      left.innerHTML = '<h3>Parts</h3><p class="muted small">Drag onto a glowing mount, or click / press Enter to auto-attach.</p>';
      Pa.CATEGORIES.forEach((cat, ci) => {
        const sec = E.el('div', 'ed-cat');
        sec.innerHTML = `<h4>${ci + 1}. ${cat.name}</h4>`;
        for (const def of Pa.PARTS.filter((p) => p.category === cat.id)) {
          const b = E.el('button', 'ed-part', `<i style="background:#${def.color.toString(16).padStart(6, '0')}"></i><span><b>${E.esc(def.name)}</b><small>${E.esc(Pa.statSummary(def))}</small></span>`,
            { type: 'button', 'data-part': def.id, title: def.desc || def.name });
          b.addEventListener('pointerdown', (e) => { if (e.button === 0) { this.paletteDown = { partId: def.id, x: e.clientX, y: e.clientY }; e.preventDefault(); } });
          b.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { this.quickAdd(def.id); e.preventDefault(); e.stopPropagation(); } });
          sec.appendChild(b);
        }
        left.appendChild(sec);
      });
      const right = E.el('aside', 'ed-panel ed-right', null, { 'aria-label': 'Stats and properties' });
      right.innerHTML = `<h3>Performance</h3><div class="ed-stats" aria-live="polite"></div>
        <h3>Problems</h3><ul class="ed-problems"></ul><h3>Selected part</h3><div class="ed-props"></div>`;
      const status = E.el('div', 'ed-status', '', { role: 'status' });
      root.append(bar, left, right, status);
      Object.assign(this.ui, { bar, left, right, status, stats: right.querySelector('.ed-stats'), problems: right.querySelector('.ed-problems'), props: right.querySelector('.ed-props') });
      this.status('Tip: right-drag to orbit, press ? for all shortcuts.');
    }

    status(msg, kind) {
      if (!this.ui) return;
      this.ui.status.textContent = msg;
      this.ui.status.className = 'ed-status ' + (kind || '');
    }

    renderPanels() {
      if (!this.ui) return;
      this.ui.undo.disabled = !Session.history.canUndo;
      this.ui.redo.disabled = !Session.history.canRedo;
      const s = this.spec, p = this.perf;
      const rows = !s ? [['Parts', '0']] : [
        ['Total mass', `${Math.round(p.mass)} kg`], ['Thrust / weight', p.thrustToWeight.toFixed(2)],
        ['Stall speed', fmt.speed(p.stallSpeed)], ['Max speed', p.canFly ? fmt.speed(p.maxSpeed) : 'cannot hold level flight'],
        ['Range', fmt.range(p.range)], ['Turn rate', `${p.turnRate.toFixed(0)}°/s at ${fmt.speed(p.cruiseSpeed)}`],
        ['Fuel', `${Math.round(p.fuel)} kg`], ['Static margin', `${(s.design.staticMargin * 100).toFixed(0)}% chord`],
        ['Parts', `${this.resolved.list.length} · ${Pa.cachedGeometryCount()} cached meshes`],
      ];
      this.ui.stats.innerHTML = rows.map(([a, b]) => `<div><span>${a}</span><b>${b}</b></div>`).join('') +
        (s ? '<div class="legend"><i class="cg"></i> centre of mass <i class="np"></i> neutral point</div>' : '') +
        `<div class="legend">${Session.dirty ? 'Unsaved changes' : Session.savedId ? 'Saved' : 'Not saved yet'}</div>`;
      const v = this.validation;
      this.ui.problems.innerHTML = '';
      const items = v.errors.map((x) => ['error', x]).concat(v.warnings.map((x) => ['warn', x]));
      if (!items.length) this.ui.problems.innerHTML = '<li class="ok">✔ Ready to fly</li>';
      for (const [kind, x] of items) {
        const li = E.el('li', kind);
        const b = E.el('button', 'linkish', `${kind === 'error' ? '⛔' : '⚠'} ${E.esc(x.msg)}`, { type: 'button' });
        b.title = x.uid ? 'Select the part' : '';
        b.addEventListener('click', () => { if (x.uid && this.part(x.uid)) { this.select(x.uid); this.frame(false); } });
        li.appendChild(b);
        this.ui.problems.appendChild(li);
      }
      this.renderProperties();
    }

    renderProperties() {
      if (!this.ui) return;
      const box = this.ui.props;
      const p = this.selected && this.part(this.selected);
      if (!p) { box.innerHTML = '<p class="muted">Nothing selected. Click a part or press ] to cycle.</p>'; return; }
      const def = Pa.CATALOG[p.part], rec = this.resolved.byUid.get(p.uid);
      const parent = p.parent && this.part(p.parent);
      const where = parent ? `${Pa.CATALOG[parent.part].name} → ${p.attach.replace(/_/g, ' ')}` : rec && rec.floating ? '<span class="bad">floating (not attached)</span>' : 'root (on the grid)';
      box.innerHTML = `<b>${E.esc(def.name)}</b><p class="muted small">${E.esc(def.desc || '')}</p>
        <div class="kv"><span>Adds</span><b>${E.esc(Pa.statSummary(def))}</b></div>
        <div class="kv"><span>Attached to</span><b>${where}</b></div>
        <div class="kv"><span>Rotation</span><b>${(p.rot || [0, 0, 0]).map((q) => q * 90 + '°').join(' / ')}</b></div>
        <div class="kv"><span>Mirror twin</span><b>${p.pair && this.part(p.pair) ? 'yes (moves with symmetry)' : 'none'}</b></div>`;
      const row = E.el('div', 'ed-row');
      row.append(E.button('Next mount (N)', 'Move to next free mount', () => this.cycleMount(1)), E.button('Rotate (R)', 'Rotate', () => this.rotateSelected(2, 1)),
        E.button('Mirror (M)', 'Mirror', () => this.mirrorSelected()), E.button('Delete', 'Delete', () => this.deleteSelected(), 'btn-danger'));
      box.appendChild(row);
    }

    // ------------------------------------------------------------------ loop
    update() { this.cam.update(); }
    render(renderer) { E.layoutPanels(this.ui.root); this.core.render(renderer); }

    exit() {
      this.unbindEvents();
      if (this.drag) this.finishDrag(null, true);
      for (const uid of [...this.meshes.keys()]) this.removeMesh(uid);
      for (const m of Object.values(this.mats)) m.dispose();
      this.core.dispose();
      E.closeHelp(); E.closeModal();
      const root = document.getElementById('editor-ui');
      root.innerHTML = '';
      root.classList.add('hidden');
      this.canvas.style.cursor = '';
    }
  }

  function dist2(a, b) { return (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2; }

  AV.Modes.PlaneBuilderMode = PlaneBuilderMode;
  AV.PlaneBuilder = { Session };
})(window.AV);
