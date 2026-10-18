/* main.js — bootstrap, render loop and the top-level state machine.
 *
 *   BOOT ──▶ MENU ──┬──▶ CRASH        (Aviator rounds)
 *                   ├──▶ CAMPAIGN     (briefing → countdown → flying → result)
 *                   ├──▶ FREEFLIGHT   (sandbox, photo mode)
 *                   ├──▶ HANGAR       (3D preview)
 *                   ├──▶ PLANE BUILDER ──(test flight)──▶ FREEFLIGHT ──(back to editor)──┐
 *                   ├──▶ MAP BUILDER   ──(test play)───▶ FREEFLIGHT ──(back to editor)──┤
 *                   │        ▲─────────────────────────────────────────────────────────┘
 *                   └──▶ campaignSelect / settings / credits (menu sub-screens)
 *   PAUSED is an overlay on any flight state (Esc). Editors render their own scene.
 */
window.AV = window.AV || {};
(function (AV) {
  'use strict';
  const $ = (id) => document.getElementById(id);

  /** Which mode class and UI screen each state uses. */
  const STATES = {
    menu: { mode: 'MenuMode', screen: 'menu', hud: false },
    campaignSelect: { mode: 'MenuMode', screen: 'campaignSelect', hud: false },
    settings: { mode: null, screen: 'settings', hud: false },
    credits: { mode: 'MenuMode', screen: 'credits', hud: false },
    hangar: { mode: 'HangarMode', screen: 'hangar', hud: false },
    crash: { mode: 'CrashMode', screen: null, hud: true, flight: true },
    campaign: { mode: 'CampaignMode', screen: null, hud: false, flight: true, pilot: true },
    freeflight: { mode: 'FreeFlightMode', screen: null, hud: true, flight: true, pilot: true },
    planeBuilder: { mode: 'PlaneBuilderMode', screen: null, hud: false, editor: true },
    mapBuilder: { mode: 'MapBuilderMode', screen: null, hud: false, editor: true },
  };

  const Game = {
    state: 'boot',
    mode: null,
    paused: false,
    contextLost: false,
    last: 0,
    frameTimes: [],

    init() {
      if (!window.THREE) return this.fatal('Could not load three.js from the CDN. Check your internet connection and reload.');
      AV.Save.load();
      const s = AV.Save.data.settings;
      try {
        this.renderer = new THREE.WebGLRenderer({ antialias: s.quality !== 'low', powerPreference: 'high-performance' });
      } catch (e) {
        return this.fatal('WebGL is not available in this browser, so the 3D scene cannot be shown.');
      }
      const r = this.renderer;
      r.setSize(window.innerWidth, window.innerHeight);
      r.outputColorSpace = THREE.SRGBColorSpace;
      r.info.autoReset = false;   // count draw calls across the main + overlay passes
      $('stage').appendChild(r.domElement);
      r.domElement.id = 'game';
      r.domElement.addEventListener('webglcontextlost', (e) => { e.preventDefault(); this.contextLost = true; $('context-lost').classList.remove('hidden'); AV.Audio.quiet(); });
      r.domElement.addEventListener('webglcontextrestored', () => { this.contextLost = false; $('context-lost').classList.add('hidden'); });

      this.scene = new THREE.Scene();
      this.camera = new THREE.PerspectiveCamera(65, window.innerWidth / window.innerHeight, 0.5, 16000);
      this.scene.add(this.camera);
      this.world = new AV.World(this.scene, r, s.quality);
      this.effects = new AV.Aircraft.Effects(this.scene, this.camera, s.quality === 'low' ? 1200 : 2500);
      this.rig = new AV.Modes.CameraRig(this.camera);
      this.camera.position.set(-300, 400, 600);
      this.camera.lookAt(0, 60, 0);

      AV.Input.init(r.domElement, s);
      AV.UI.init();
      this.applySettings();
      window.addEventListener('resize', () => this.resize());
      document.addEventListener('visibilitychange', () => { if (document.hidden && this.isFlight() && !this.paused) this.setPaused(true); });
      window.addEventListener('pointerdown', () => AV.Audio.init(), { once: true });
      this.resize();
      this.boot();
      requestAnimationFrame((t) => this.loop(t));
    },

    fatal(msg) {
      AV.UI && AV.UI.setLoading ? AV.UI.setLoading(1, msg) : null;
      const t = $('load-text'); if (t) { t.textContent = msg; t.classList.add('bad'); }
      console.error('[Aviator]', msg);
    },

    /** Stream in the starting terrain behind the loading bar, then open the menu. */
    boot() {
      const focus = new THREE.Vector3(0, 300, 0);
      let total = 0;
      const stepLoad = () => {
        const left = this.world.updateChunks(focus, false);
        if (!total) total = left + 2;
        AV.UI.setLoading(1 - left / total, `Generating terrain… ${Math.round((1 - left / total) * 100)}%`);
        if (left > 0) { setTimeout(stepLoad, 0); return; }
        AV.UI.setLoading(1, 'Ready');
        this.goto('menu');
        window.__aviatorReady = true;
      };
      setTimeout(stepLoad, 30);
    },

    isFlight() { return !!(STATES[this.state] && STATES[this.state].flight); },
    /** True when the player has the controls (shows touch flight controls). */
    isPiloting() { return !!(STATES[this.state] && STATES[this.state].pilot); },

    /** Switch state, swapping the mode instance only when it actually changes. */
    goto(name, params) {
      const def = STATES[name];
      if (!def) return;
      AV.UI.settingsFromPause = false;
      if (this.paused) this.setPaused(false, true);
      // Parameters (a mission, a test-flight design, a custom map) always mean a fresh mode.
      const needNewMode = def.mode && (!this.mode || this.mode.constructor.name !== def.mode || !!params);
      const apply = () => {
        if (needNewMode) {
          if (this.mode) this.mode.exit();
          this.mode = new AV.Modes[def.mode](this, params);
          this.mode.enter();
        }
        this.prevState = this.state;
        this.state = name;
        document.body.dataset.state = name;
        AV.UI.showScreen(def.screen);
        AV.UI.hud.show(def.hud);
        if (def.hud) AV.UI.hud.forceHidden = false;
      };
      if (needNewMode && this.state !== 'boot') AV.UI.fade(apply); else apply();
    },

    back() {
      if (AV.UI.settingsFromPause) {
        // Settings were opened over a paused flight: return to the pause menu.
        AV.UI.settingsFromPause = false;
        AV.UI.showScreen(null);
        AV.UI.pause.show(true);
        return;
      }
      this.goto('menu');
    },

    setPaused(p, silent) {
      if (p && (!this.mode || !this.mode.allowPause || !this.isFlight())) return;
      this.paused = p;
      if (p) AV.UI.pause.label(this.mode && this.mode.returnTo);
      if (!silent) AV.UI.pause.show(p);
      else AV.UI.pause.show(false);
      if (p) AV.Audio.quiet();
      if (this.mode && this.mode.onPause) this.mode.onPause(p);
      if (this.mode && this.mode.session) this.mode.session.sim.accumulator = 0;
    },

    applySettings() {
      const s = AV.Save.data.settings;
      AV.Audio.setVolumes({ master: s.masterVolume, music: s.musicVolume, sfx: s.sfxVolume });
      AV.Input.applySettings(s);
      this.world.setQuality(s.quality);
      const q = AV.World.QUALITY[s.quality];
      this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, q.pixelRatio));
      document.documentElement.style.setProperty('--ui-scale', s.uiScale);
      document.body.classList.toggle('reduced-motion', s.reducedMotion);
      document.body.classList.toggle('high-contrast', s.highContrast);
      this.effects.reducedMotion = s.reducedMotion;
      this.rig.reducedMotion = s.reducedMotion;
      $('fps').classList.toggle('hidden', !s.showFps);
      if (this.isFlight() && this.state !== 'crash' && this.rig.mode !== s.camera && !this.paused) this.rig.setMode(s.camera);
      AV.Save.save();
    },

    resize() {
      const w = window.innerWidth, h = window.innerHeight;
      this.renderer.setSize(w, h);
      this.camera.aspect = w / h;
      this.camera.updateProjectionMatrix();
      this.viewportHeight = h * this.renderer.getPixelRatio();
      document.body.classList.toggle('compact', w < 760 || h < 520);
    },

    screenshot() {
      this.world.render(this.renderer, this.camera);
      try {
        const url = this.renderer.domElement.toDataURL('image/png');
        const a = document.createElement('a');
        a.href = url; a.download = `aviator-${Date.now()}.png`;
        document.body.appendChild(a); a.click(); a.remove();
        AV.UI.toast('Photo saved', 'good');
      } catch (e) {
        AV.UI.toast('Could not capture the image in this browser', 'warn');
      }
    },

    loop(now) {
      requestAnimationFrame((t) => this.loop(t));
      if (this.contextLost) return;
      const dt = Math.min(0.1, Math.max(0, (now - (this.last || now)) / 1000));
      this.last = now;
      const t0 = performance.now();
      AV.Input.update(dt);
      if (AV.Input.consume('pause')) {
        if (AV.UI.settingsFromPause) this.back();
        else if (this.paused) this.setPaused(false);
        else if (this.isFlight() && this.mode.allowPause && !this.cardOpen()) this.setPaused(true);
        else if (['campaignSelect', 'credits', 'hangar'].includes(this.state) || (this.state === 'settings')) this.back();
      }
      this.renderer.info.reset();
      try {
        if (!this.paused && this.mode) this.mode.update(dt);
        if (this.mode && this.mode.render) {
          // Editors draw their own isolated scene; the flight world sleeps meanwhile.
          this.mode.render(this.renderer);
        } else {
          const focus = this.mode && this.mode.session ? this.mode.session.renderPos : this.camera.position;
          this.world.update(dt, this.camera, focus, { freezeTime: this.paused });
          this.world.render(this.renderer, this.camera);
        }
      } catch (e) {
        // Never let one bad frame kill the loop; surface it once.
        if (!this._errShown) { console.error(e); AV.UI.toast(`Error: ${e.message}`, 'danger', 6); this._errShown = true; }
      }
      AV.Input.endFrame();
      this.trackFps(performance.now() - t0, dt);
    },

    cardOpen() { return !$('card-briefing').classList.contains('hidden') || !$('card-result').classList.contains('hidden'); },

    trackFps(cpuMs, dt) {
      this.frameTimes.push(dt);
      if (this.frameTimes.length > 60) this.frameTimes.shift();
      if (!AV.Save.data.settings.showFps) return;
      this._fpsT = (this._fpsT || 0) + dt;
      if (this._fpsT < 0.5) return;
      this._fpsT = 0;
      const avg = this.frameTimes.reduce((a, b) => a + b, 0) / this.frameTimes.length;
      const info = this.renderer.info.render;
      $('fps').textContent = `${Math.round(1 / avg)} fps · frame ${(avg * 1000).toFixed(1)} ms · cpu ${cpuMs.toFixed(1)} ms · ${info.calls} draws · ${(info.triangles / 1000).toFixed(0)}k tris`;
    },
  };

  AV.Game = Game;
  window.addEventListener('DOMContentLoaded', () => Game.init());
})(window.AV);
