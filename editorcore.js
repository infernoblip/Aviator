/* editorcore.js — building blocks shared by the Plane Builder and the Map Builder:
 * snapshot undo/redo, an orbit camera, the editor scene, thumbnails, a shortcut
 * overlay, JSON file import/export, small DOM helpers and editor sounds.
 */
window.AV = window.AV || {};
(function (AV) {
  'use strict';

  /** Snapshot history: every action pushes the serialised document. */
  class History {
    constructor(limit) { this.limit = limit || 80; this.stack = []; this.index = -1; }
    reset(snapshot) { this.stack = [snapshot]; this.index = 0; }
    push(snapshot) {
      if (this.stack[this.index] === snapshot) return false;
      this.stack.length = this.index + 1;
      this.stack.push(snapshot);
      if (this.stack.length > this.limit) this.stack.shift();
      this.index = this.stack.length - 1;
      return true;
    }
    undo() { if (!this.canUndo) return null; this.index--; return this.stack[this.index]; }
    redo() { if (!this.canRedo) return null; this.index++; return this.stack[this.index]; }
    get canUndo() { return this.index > 0; }
    get canRedo() { return this.index < this.stack.length - 1; }
  }

  /** Orbit camera: right-drag orbits, middle-drag (or Shift+right-drag) pans, wheel zooms. */
  class OrbitControls {
    constructor(camera, opts) {
      this.camera = camera;
      this.target = new THREE.Vector3();
      this.yaw = 0.8; this.pitch = 0.45; this.dist = opts.dist || 25;
      this.minDist = opts.minDist || 3; this.maxDist = opts.maxDist || 400;
      this.drag = null;
    }
    pointerDown(e) {
      if (e.button === 2 || e.button === 1) { this.drag = { x: e.clientX, y: e.clientY, pan: e.button === 1 || e.shiftKey }; return true; }
      return false;
    }
    pointerMove(e) {
      if (!this.drag) return false;
      const dx = e.clientX - this.drag.x, dy = e.clientY - this.drag.y;
      this.drag.x = e.clientX; this.drag.y = e.clientY;
      if (this.drag.pan) this.pan(-dx, dy);
      else { this.yaw -= dx * 0.006; this.pitch = Math.max(-1.45, Math.min(1.45, this.pitch + dy * 0.005)); }
      return true;
    }
    pointerUp() { const was = !!this.drag; this.drag = null; return was; }
    wheel(e) { this.zoom(e.deltaY > 0 ? 1.12 : 1 / 1.12); }
    zoom(f) { this.dist = Math.max(this.minDist, Math.min(this.maxDist, this.dist * f)); }
    orbit(dyaw, dpitch) { this.yaw += dyaw; this.pitch = Math.max(-1.45, Math.min(1.45, this.pitch + dpitch)); }
    /** Move the target in the camera's screen plane. */
    pan(dx, dy) {
      const k = this.dist * 0.0016, m = this.camera.matrixWorld.elements;
      this.target.x += m[0] * dx * k + m[4] * dy * k;
      this.target.y += m[1] * dx * k + m[5] * dy * k;
      this.target.z += m[2] * dx * k + m[6] * dy * k;
    }
    focus(point, dist) { this.target.copy(point); if (dist) this.dist = Math.max(this.minDist, Math.min(this.maxDist, dist)); }
    update() {
      const c = this.camera, d = this.dist;
      c.position.set(this.target.x + Math.sin(this.yaw) * Math.cos(this.pitch) * d, this.target.y + Math.sin(this.pitch) * d, this.target.z + Math.cos(this.yaw) * Math.cos(this.pitch) * d);
      c.up.set(0, 1, 0);
      c.lookAt(this.target);
    }
  }

  /** An isolated scene for an editor (the flight world is not rendered while editing). */
  class EditorScene {
    constructor(opts) {
      this.scene = new THREE.Scene();
      this.scene.background = new THREE.Color(opts.background || 0x18222f);
      this.camera = new THREE.PerspectiveCamera(55, window.innerWidth / window.innerHeight, 0.1, opts.far || 5000);
      const hemi = new THREE.HemisphereLight(0xdfeaff, 0x3a3f46, 1.3);
      const sun = new THREE.DirectionalLight(0xffffff, 2.0);
      sun.position.set(30, 60, 20);
      this.sun = sun;
      this.scene.add(hemi, sun, this.camera);
      this.disposables = [];
    }
    add(obj, disposable) { this.scene.add(obj); if (disposable) this.disposables.push(obj); return obj; }
    resize(renderer) {
      const w = window.innerWidth, h = window.innerHeight;
      if (this.camera.aspect !== w / h) { this.camera.aspect = w / h; this.camera.updateProjectionMatrix(); }
    }
    render(renderer) { this.resize(renderer); renderer.render(this.scene, this.camera); }
    /** Render one frame and copy it into a small JPEG data URL. */
    thumbnail(renderer, w, h) {
      this.render(renderer);
      const src = renderer.domElement;
      const c = document.createElement('canvas');
      c.width = w || 192; c.height = h || 120;
      const ctx = c.getContext('2d');
      const ar = c.width / c.height, sw = Math.min(src.width, src.height * ar), sh = sw / ar;
      try {
        ctx.drawImage(src, (src.width - sw) / 2, (src.height - sh) / 2, sw, sh, 0, 0, c.width, c.height);
        return c.toDataURL('image/jpeg', 0.78);
      } catch (e) { return null; }
    }
    dispose() {
      for (const o of this.disposables) o.traverse((x) => { if (x.geometry) x.geometry.dispose(); if (x.material) [].concat(x.material).forEach((m) => m.dispose()); });
      this.scene.clear();
    }
  }

  // --- DOM helpers ----------------------------------------------------------
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  function el(tag, cls, html, attrs) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (html !== undefined && html !== null) e.innerHTML = html;
    if (attrs) for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
    return e;
  }
  function button(label, title, onClick, cls) {
    const b = el('button', 'btn btn-small ' + (cls || ''), label, { type: 'button', title: title || '' });
    if (title) b.setAttribute('aria-label', title);
    b.addEventListener('click', (e) => { AV.Audio.init(); onClick(e); });
    return b;
  }

  /** Is the keyboard event aimed at a text field (so editor shortcuts should stay out of the way)? */
  function typingIn(e) {
    const t = e.target, tag = t && t.tagName;
    return tag === 'INPUT' && !['checkbox', 'radio', 'range', 'button', 'color'].includes(t.type) || tag === 'TEXTAREA' || tag === 'SELECT' || (t && t.isContentEditable);
  }

  // --- shortcut overlay -----------------------------------------------------
  function showHelp(title, rows) {
    let m = document.getElementById('editor-help');
    if (!m) {
      m = el('div', 'modal hidden', null, { id: 'editor-help', role: 'dialog', 'aria-modal': 'true' });
      document.body.appendChild(m);
      m.addEventListener('click', (e) => { if (e.target === m) m.classList.add('hidden'); });
    }
    m.innerHTML = `<div class="card wide-card"><h2>${esc(title)} — shortcuts</h2><div class="help-grid">${rows.map(([k, d]) => `<kbd>${esc(k)}</kbd><span>${esc(d)}</span>`).join('')}</div>
      <div class="card-actions"><button class="btn btn-primary" id="editor-help-close">Close (Esc or ?)</button></div></div>`;
    m.classList.toggle('hidden');
    const close = m.querySelector('#editor-help-close');
    close.onclick = () => m.classList.add('hidden');
    if (!m.classList.contains('hidden')) setTimeout(() => close.focus(), 20);
    return !m.classList.contains('hidden');
  }
  function helpOpen() { const m = document.getElementById('editor-help'); return !!(m && !m.classList.contains('hidden')); }
  function closeHelp() { const m = document.getElementById('editor-help'); if (m) m.classList.add('hidden'); }

  /** Generic modal used for load / import dialogs. Returns the content element. */
  function modal(title, build) {
    let m = document.getElementById('editor-modal');
    if (!m) {
      m = el('div', 'modal hidden', null, { id: 'editor-modal', role: 'dialog', 'aria-modal': 'true' });
      document.body.appendChild(m);
      m.addEventListener('click', (e) => { if (e.target === m) m.classList.add('hidden'); });
    }
    m.innerHTML = `<div class="card wide-card"><h2>${esc(title)}</h2><div class="modal-body"></div><div class="card-actions"><button class="btn" data-close>Close</button></div></div>`;
    m.querySelector('[data-close]').onclick = () => m.classList.add('hidden');
    build(m.querySelector('.modal-body'), () => m.classList.add('hidden'));
    m.classList.remove('hidden');
    return m;
  }
  function modalOpen() { const m = document.getElementById('editor-modal'); return !!(m && !m.classList.contains('hidden')); }
  function closeModal() { const m = document.getElementById('editor-modal'); if (m) m.classList.add('hidden'); }

  // --- files ----------------------------------------------------------------
  function downloadJSON(obj, filename) {
    const blob = new Blob([JSON.stringify(obj, null, 1)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = el('a', null, null, { href: url, download: filename });
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }
  /** Import dialog: pick a .json file or paste text; `apply(text)` throws on invalid data. */
  function importDialog(title, apply) {
    modal(title, (body, close) => {
      body.innerHTML = `<p class="muted">Choose a .json file or paste its contents below.</p>
        <input type="file" accept=".json,application/json" class="import-file">
        <textarea class="import-text" rows="8" placeholder="Paste JSON here" aria-label="JSON to import"></textarea>
        <div class="import-out" role="alert"></div>`;
      const out = body.querySelector('.import-out');
      const run = (text) => {
        try { const msg = apply(text); out.className = 'import-out good'; out.textContent = msg || 'Imported.'; setTimeout(close, 900); }
        catch (e) { out.className = 'import-out bad'; out.textContent = e.message; sound('invalid'); }
      };
      body.querySelector('.import-file').addEventListener('change', (e) => {
        const f = e.target.files[0];
        if (!f) return;
        if (f.size > 4e6) { out.className = 'import-out bad'; out.textContent = 'File is too large.'; return; }
        const r = new FileReader();
        r.onload = () => run(String(r.result));
        r.readAsText(f);
      });
      const go = button('Import pasted JSON', 'Import pasted JSON', () => run(body.querySelector('.import-text').value), 'btn-primary');
      body.appendChild(go);
    });
  }

  /** Editor sound effects (soft snap click, delete tone, invalid buzz) — respects the editor mute toggle. */
  function sound(name) {
    if (!AV.Save.data.settings.editorSounds) return;
    AV.Audio.play(name);
  }

  /** Keep side panels just below the (possibly wrapped) toolbar. */
  function layoutPanels(root) {
    const bar = root.querySelector('.ed-toolbar');
    if (!bar) return;
    const h = bar.offsetHeight + 12;
    if (root._edTop !== h) { root._edTop = h; root.style.setProperty('--ed-top', h + 'px'); }
  }

  /** Normalised device coordinates for a pointer event on the canvas. */
  function ndc(e, canvas, out) {
    const r = canvas.getBoundingClientRect();
    return out.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
  }

  AV.EditorCore = { layoutPanels, History, OrbitControls, EditorScene, el, esc, button, typingIn, showHelp, helpOpen, closeHelp, modal, modalOpen, closeModal, downloadJSON, importDialog, sound, ndc };
})(window.AV);
