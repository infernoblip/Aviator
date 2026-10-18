/* input.js — keyboard (rebindable), mouse, touch and gamepad → one control state.
 *
 * Axes: pitch (+ nose up), roll (+ right), yaw (+ right) in −1..1; throttle 0..1 (absolute).
 * Buttons are edge-triggered actions read with Input.consume('gear') etc.
 */
window.AV = window.AV || {};
(function (AV) {
  'use strict';

  /** Action → [label, default key codes]. */
  const ACTIONS = {
    pitchDown: ['Nose down', ['KeyW', 'ArrowUp']],
    pitchUp: ['Nose up', ['KeyS', 'ArrowDown']],
    rollLeft: ['Roll left', ['KeyA', 'ArrowLeft']],
    rollRight: ['Roll right', ['KeyD', 'ArrowRight']],
    yawLeft: ['Rudder left', ['KeyQ', 'Comma']],
    yawRight: ['Rudder right', ['KeyE', 'Period']],
    throttleUp: ['Throttle up', ['ShiftLeft', 'KeyR']],
    throttleDown: ['Throttle down', ['ControlLeft', 'KeyF']],
    gear: ['Landing gear', ['KeyG']],
    flaps: ['Cycle flaps', ['KeyV']],
    brake: ['Wheel brakes (hold)', ['KeyB']],
    camera: ['Change camera', ['KeyC']],
    photo: ['Photo mode', ['KeyP']],
    map: ['Free-flight panel / map', ['KeyM']],
    hud: ['Toggle HUD', ['KeyH']],
    cashout1: ['Bet / cash out slot 1', ['Space']],
    cashout2: ['Bet / cash out slot 2', ['Enter']],
    pause: ['Pause', ['Escape']],
  };
  const AXIS_RATE = 7;          // how fast keyboard axes ramp toward ±1 (per second)
  const THROTTLE_RATE = 0.55;   // throttle change per second while a key is held
  const DEADZONE = 0.12;

  const Input = {
    ACTIONS,
    keys: new Set(),
    pressed: new Set(),
    axes: { pitch: 0, roll: 0, yaw: 0 },
    throttle: 0,
    brake: false,
    orbit: { dx: 0, dy: 0, zoom: 0 },
    mouse: { x: 0, y: 0, inside: false },
    touch: { active: false, stickX: 0, stickY: 0, throttleSet: null, brake: false },
    gamepad: { connected: false, prevButtons: [] },
    settings: { sensitivity: 1, invertPitch: false, mouseFlight: false },
    bindings: {},
    rebinding: null,
    enabled: true,

    init(canvas, settings) {
      this.canvas = canvas;
      this.applySettings(settings);
      window.addEventListener('keydown', (e) => this.onKey(e, true));
      window.addEventListener('keyup', (e) => this.onKey(e, false));
      window.addEventListener('blur', () => this.keys.clear());
      canvas.addEventListener('pointerdown', (e) => this.onPointerDown(e));
      window.addEventListener('pointermove', (e) => this.onPointerMove(e));
      window.addEventListener('pointerup', () => { this.dragging = false; });
      canvas.addEventListener('wheel', (e) => { this.orbit.zoom += Math.sign(e.deltaY); e.preventDefault(); }, { passive: false });
      canvas.addEventListener('contextmenu', (e) => e.preventDefault());
      window.addEventListener('gamepadconnected', () => { this.gamepad.connected = true; AV.UI && AV.UI.toast('Gamepad connected', 'info'); });
      window.addEventListener('gamepaddisconnected', () => { this.gamepad.connected = false; });
      this.isTouch = ('ontouchstart' in window) || (navigator.maxTouchPoints || 0) > 0;
      this.buildTouchControls();
    },

    applySettings(s) {
      if (!s) return;
      this.settings = s;
      this.bindings = {};
      for (const a of Object.keys(ACTIONS)) this.bindings[a] = (s.bindings && s.bindings[a]) ? s.bindings[a].slice() : ACTIONS[a][1].slice();
    },

    /** Capture the next key press for `action`; `done(code|null)` fires when finished. */
    startRebind(action, done) {
      this.rebinding = { action, done };
    },
    resetBindings() {
      this.settings.bindings = {};
      this.applySettings(this.settings);
    },
    keyName(code) {
      if (!code) return '—';
      return code.replace(/^Key/, '').replace(/^Digit/, '').replace(/^Arrow/, '↑').replace('↑Up', '↑').replace('↑Down', '↓').replace('↑Left', '←').replace('↑Right', '→')
        .replace('ShiftLeft', 'L-Shift').replace('ControlLeft', 'L-Ctrl').replace('ShiftRight', 'R-Shift').replace('ControlRight', 'R-Ctrl').replace('Space', 'Space');
    },

    onKey(e, down) {
      const tag = (e.target && e.target.tagName) || '';
      if (this.rebinding && down) {
        e.preventDefault();
        const { action, done } = this.rebinding;
        this.rebinding = null;
        if (e.code === 'Escape') { done(null); return; }
        const list = this.bindings[action];
        list[0] = e.code;
        // Remove the key from any other action so one key never drives two controls.
        for (const a of Object.keys(this.bindings)) if (a !== action) this.bindings[a] = this.bindings[a].filter((c) => c !== e.code);
        this.settings.bindings = JSON.parse(JSON.stringify(this.bindings));
        done(e.code);
        return;
      }
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') {
        if (down && e.code === 'Escape') e.target.blur();
        return;
      }
      if (down) {
        if (!this.keys.has(e.code)) {
          for (const a of Object.keys(this.bindings)) if (this.bindings[a].includes(e.code)) this.pressed.add(a);
        }
        this.keys.add(e.code);
        if (['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Enter'].includes(e.code) && tag !== 'BUTTON') e.preventDefault();
        if (tag === 'BUTTON' && (e.code === 'Space' || e.code === 'Enter')) {
          // A focused button already handles Space/Enter; don't double-fire bet actions.
          this.pressed.delete('cashout1');
          this.pressed.delete('cashout2');
        }
      } else {
        this.keys.delete(e.code);
      }
      if (AV.Audio && down) AV.Audio.init();
    },

    held(action) {
      const list = this.bindings[action];
      for (let i = 0; i < list.length; i++) if (this.keys.has(list[i])) return true;
      return false;
    },

    /** Edge-triggered: true once per press. */
    consume(action) {
      if (this.pressed.has(action)) { this.pressed.delete(action); return true; }
      return false;
    },
    trigger(action) { this.pressed.add(action); },

    onPointerDown(e) {
      this.dragging = true;
      this.lastX = e.clientX; this.lastY = e.clientY;
      if (AV.Audio) AV.Audio.init();
    },
    onPointerMove(e) {
      this.mouse.x = (e.clientX / window.innerWidth) * 2 - 1;
      this.mouse.y = (e.clientY / window.innerHeight) * 2 - 1;
      this.mouse.inside = true;
      if (this.dragging && e.pointerType !== 'touch') {
        this.orbit.dx += (e.clientX - this.lastX);
        this.orbit.dy += (e.clientY - this.lastY);
        this.lastX = e.clientX; this.lastY = e.clientY;
      }
    },
    takeOrbit() {
      const o = { dx: this.orbit.dx, dy: this.orbit.dy, zoom: this.orbit.zoom };
      this.orbit.dx = this.orbit.dy = this.orbit.zoom = 0;
      return o;
    },

    setThrottle(v) { this.throttle = Math.min(1, Math.max(0, v)); this.syncTouchThrottle(); },

    /** Poll once per frame. */
    update(dt) {
      const s = this.settings;
      const sens = s.sensitivity || 1;
      // Keyboard axes ramp smoothly toward their targets.
      const target = {
        pitch: (this.held('pitchUp') ? 1 : 0) - (this.held('pitchDown') ? 1 : 0),
        roll: (this.held('rollRight') ? 1 : 0) - (this.held('rollLeft') ? 1 : 0),
        yaw: (this.held('yawRight') ? 1 : 0) - (this.held('yawLeft') ? 1 : 0),
      };
      for (const k of ['pitch', 'roll', 'yaw']) {
        const a = this.axes[k], t = target[k];
        const rate = AXIS_RATE * (t === 0 ? 1.4 : 1);
        this.axes[k] = a + Math.max(-rate * dt, Math.min(rate * dt, t - a));
      }
      let pitch = this.axes.pitch, roll = this.axes.roll, yaw = this.axes.yaw;
      if (this.held('throttleUp')) this.setThrottle(this.throttle + THROTTLE_RATE * dt);
      if (this.held('throttleDown')) this.setThrottle(this.throttle - THROTTLE_RATE * dt);
      let brake = this.held('brake');

      // Mouse yoke: cursor offset from screen centre.
      if (s.mouseFlight && this.mouse.inside && !this.dragging) {
        const dz = (v) => (Math.abs(v) < 0.06 ? 0 : (v - Math.sign(v) * 0.06) / 0.94);
        roll += dz(this.mouse.x) * 1.4;
        pitch += dz(this.mouse.y) * 1.4;              // cursor below centre = pull back
      }
      // Touch stick + throttle slider.
      if (this.touch.active) {
        roll += this.touch.stickX;
        pitch += this.touch.stickY;
        brake = brake || this.touch.brake;
      }
      // Gamepad.
      const gp = this.pollGamepad(dt);
      if (gp) { pitch += gp.pitch; roll += gp.roll; yaw += gp.yaw; brake = brake || gp.brake; }

      if (s.invertPitch) pitch = -pitch;
      const shape = (v) => Math.max(-1, Math.min(1, v * sens));
      this.state = { pitch: shape(pitch), roll: shape(roll), yaw: shape(yaw), throttle: this.throttle, brake };
      return this.state;
    },

    pollGamepad(dt) {
      if (!navigator.getGamepads) return null;
      let pad = null;
      try { for (const p of navigator.getGamepads()) if (p && p.connected) { pad = p; break; } } catch (e) { return null; }
      if (!pad) return null;
      const ax = (i) => { const v = pad.axes[i] || 0; return Math.abs(v) < DEADZONE ? 0 : (v - Math.sign(v) * DEADZONE) / (1 - DEADZONE); };
      const btn = (i) => !!(pad.buttons[i] && pad.buttons[i].pressed);
      const val = (i) => (pad.buttons[i] ? pad.buttons[i].value : 0);
      const edges = { 0: 'gear', 1: 'flaps', 3: 'camera', 9: 'pause', 8: 'map', 4: 'cashout1', 5: 'cashout2', 12: 'photo' };
      for (const [i, action] of Object.entries(edges)) {
        const now = btn(+i);
        if (now && !this.gamepad.prevButtons[i]) this.pressed.add(action);
        this.gamepad.prevButtons[i] = now;
      }
      const thr = val(7) - val(6);
      if (Math.abs(thr) > 0.05) this.setThrottle(this.throttle + thr * THROTTLE_RATE * 1.5 * dt);
      return { roll: ax(0), pitch: ax(1), yaw: ax(2), brake: btn(2) };
    },

    // --- touch controls ------------------------------------------------------
    buildTouchControls() {
      const root = document.getElementById('touch-controls');
      if (!root) return;
      this.touchRoot = root;
      const stick = root.querySelector('.touch-stick');
      const knob = root.querySelector('.touch-knob');
      const slider = root.querySelector('.touch-throttle');
      const fill = root.querySelector('.touch-throttle-fill');
      this.touchFill = fill;
      let stickId = null, thrId = null;
      const stickMove = (t) => {
        const r = stick.getBoundingClientRect();
        let x = (t.clientX - (r.left + r.width / 2)) / (r.width / 2);
        let y = (t.clientY - (r.top + r.height / 2)) / (r.height / 2);
        const l = Math.hypot(x, y);
        if (l > 1) { x /= l; y /= l; }
        knob.style.transform = `translate(${x * 40}px, ${y * 40}px)`;
        this.touch.stickX = x; this.touch.stickY = y;   // pulling down = nose up
      };
      const thrMove = (t) => {
        const r = slider.getBoundingClientRect();
        this.setThrottle(1 - (t.clientY - r.top) / r.height);
      };
      stick.addEventListener('pointerdown', (e) => { stickId = e.pointerId; stick.setPointerCapture(e.pointerId); stickMove(e); this.touch.active = true; e.preventDefault(); });
      stick.addEventListener('pointermove', (e) => { if (e.pointerId === stickId) stickMove(e); });
      const stickEnd = (e) => { if (e.pointerId !== stickId) return; stickId = null; this.touch.stickX = this.touch.stickY = 0; knob.style.transform = ''; };
      stick.addEventListener('pointerup', stickEnd); stick.addEventListener('pointercancel', stickEnd);
      slider.addEventListener('pointerdown', (e) => { thrId = e.pointerId; slider.setPointerCapture(e.pointerId); thrMove(e); this.touch.active = true; e.preventDefault(); });
      slider.addEventListener('pointermove', (e) => { if (e.pointerId === thrId) thrMove(e); });
      slider.addEventListener('pointerup', () => { thrId = null; });
      root.querySelectorAll('[data-touch-action]').forEach((b) => {
        const action = b.dataset.touchAction;
        if (action === 'brake') {
          b.addEventListener('pointerdown', (e) => { this.touch.brake = true; e.preventDefault(); });
          b.addEventListener('pointerup', () => { this.touch.brake = false; });
          b.addEventListener('pointercancel', () => { this.touch.brake = false; });
        } else {
          b.addEventListener('pointerdown', (e) => { this.trigger(action); this.touch.active = true; e.preventDefault(); });
        }
      });
    },
    syncTouchThrottle() { if (this.touchFill) this.touchFill.style.height = `${Math.round(this.throttle * 100)}%`; },
    showTouch(show) { if (this.touchRoot) this.touchRoot.classList.toggle('visible', !!show && this.isTouch); },

    endFrame() { this.pressed.clear(); },
  };

  AV.Input = Input;
})(window.AV);
