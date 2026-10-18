/* audio.js — fully procedural sound via the Web Audio API (no audio files).
 * The AudioContext is created lazily on the first user gesture (browser autoplay rules).
 *
 * Graph:  sources → {engineBus, sfxBus, musicBus} → master → compressor → destination
 */
window.AV = window.AV || {};
(function (AV) {
  'use strict';

  const Audio = {
    ctx: null,
    enabled: false,
    volumes: { master: 0.8, music: 0.45, sfx: 0.85 },
    musicOn: true,
    musicMood: 'menu',

    /** Call from a click/keydown handler. Safe to call repeatedly. */
    init() {
      if (this.ctx) { if (this.ctx.state === 'suspended') this.ctx.resume(); return; }
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      try { this.ctx = new AC(); } catch (e) { return; }
      const c = this.ctx;
      this.comp = c.createDynamicsCompressor();
      this.comp.threshold.value = -14; this.comp.ratio.value = 4;
      this.master = c.createGain();
      this.master.connect(this.comp); this.comp.connect(c.destination);
      this.sfxBus = c.createGain(); this.sfxBus.connect(this.master);
      this.musicBus = c.createGain(); this.musicBus.connect(this.master);
      this.engineBus = c.createGain(); this.engineBus.connect(this.sfxBus);
      this.noiseBuffer = this.makeNoise(2);
      this.buildEngine();
      this.buildWind();
      this.buildStallHorn();
      this.applyVolumes();
      this.enabled = true;
      this.startMusic();
    },

    makeNoise(seconds) {
      const c = this.ctx, len = Math.floor(c.sampleRate * seconds);
      const buf = c.createBuffer(1, len, c.sampleRate);
      const d = buf.getChannelData(0);
      let last = 0;
      for (let i = 0; i < len; i++) { const w = Math.random() * 2 - 1; last = (last + 0.02 * w) / 1.02; d[i] = w * 0.6 + last * 3; }
      return buf;
    },

    noiseSource() {
      const s = this.ctx.createBufferSource();
      s.buffer = this.noiseBuffer; s.loop = true;
      return s;
    },

    setVolumes(v) {
      Object.assign(this.volumes, v);
      this.applyVolumes();
    },
    applyVolumes() {
      if (!this.ctx) return;
      const t = this.ctx.currentTime;
      this.master.gain.setTargetAtTime(this.volumes.master, t, 0.05);
      this.sfxBus.gain.setTargetAtTime(this.volumes.sfx, t, 0.05);
      this.musicBus.gain.setTargetAtTime(this.volumes.music * 0.5, t, 0.05);
    },

    // --- continuous engine ---------------------------------------------------
    buildEngine() {
      const c = this.ctx;
      this.engine = {};
      const e = this.engine;
      e.osc1 = c.createOscillator(); e.osc1.type = 'sawtooth';
      e.osc2 = c.createOscillator(); e.osc2.type = 'square';
      e.lfo = c.createOscillator(); e.lfo.type = 'sine';         // propeller blade-pass throb
      e.lfoGain = c.createGain(); e.lfoGain.gain.value = 0.25;
      e.filter = c.createBiquadFilter(); e.filter.type = 'lowpass'; e.filter.Q.value = 2;
      e.amp = c.createGain(); e.amp.gain.value = 0;
      e.throb = c.createGain(); e.throb.gain.value = 0.75;
      e.noise = this.noiseSource();
      e.noiseFilter = c.createBiquadFilter(); e.noiseFilter.type = 'bandpass'; e.noiseFilter.Q.value = 1.2;
      e.noiseGain = c.createGain(); e.noiseGain.gain.value = 0;
      e.osc1.connect(e.filter); e.osc2.connect(e.filter);
      e.filter.connect(e.throb); e.throb.connect(e.amp);
      e.lfo.connect(e.lfoGain); e.lfoGain.connect(e.throb.gain);
      e.noise.connect(e.noiseFilter); e.noiseFilter.connect(e.noiseGain); e.noiseGain.connect(e.amp);
      e.amp.connect(this.engineBus);
      e.osc1.start(); e.osc2.start(); e.lfo.start(); e.noise.start();
    },

    /** rpm 0..1, throttle 0..1, running=false fades the engine out. */
    setEngine(rpm, throttle, running) {
      if (!this.enabled) return;
      const e = this.engine, t = this.ctx.currentTime;
      const f = 38 + rpm * 85;
      e.osc1.frequency.setTargetAtTime(f, t, 0.08);
      e.osc2.frequency.setTargetAtTime(f * 0.502, t, 0.08);
      e.lfo.frequency.setTargetAtTime(f * 0.5, t, 0.08);
      e.filter.frequency.setTargetAtTime(240 + throttle * 1500 + rpm * 400, t, 0.1);
      e.noiseFilter.frequency.setTargetAtTime(f * 6, t, 0.1);
      const vol = running ? 0.09 + throttle * 0.12 : 0;
      e.amp.gain.setTargetAtTime(vol, t, 0.15);
      e.noiseGain.gain.setTargetAtTime(running ? 0.15 + throttle * 0.3 : 0, t, 0.15);
    },

    // --- wind ------------------------------------------------------------------
    buildWind() {
      const c = this.ctx;
      this.wind = { src: this.noiseSource(), filter: c.createBiquadFilter(), hiss: c.createBiquadFilter(), gain: c.createGain(), hissGain: c.createGain() };
      const w = this.wind;
      w.filter.type = 'bandpass'; w.filter.Q.value = 0.7;
      w.hiss.type = 'highpass'; w.hiss.frequency.value = 3000;
      w.gain.gain.value = 0; w.hissGain.gain.value = 0;
      w.src.connect(w.filter); w.filter.connect(w.gain); w.gain.connect(this.sfxBus);
      w.src.connect(w.hiss); w.hiss.connect(w.hissGain); w.hissGain.connect(this.sfxBus);
      w.src.start();
    },
    /** speed m/s; storm adds rumble. */
    setWind(speed, storm) {
      if (!this.enabled) return;
      const w = this.wind, t = this.ctx.currentTime;
      const k = Math.min(1, speed / 110);
      w.filter.frequency.setTargetAtTime(250 + k * 1400, t, 0.2);
      w.gain.gain.setTargetAtTime(k * k * 0.5 + (storm || 0) * 0.15, t, 0.2);
      w.hissGain.gain.setTargetAtTime(k * k * k * 0.12, t, 0.2);
    },

    // --- stall horn --------------------------------------------------------------
    buildStallHorn() {
      const c = this.ctx;
      const o = c.createOscillator(); o.type = 'square'; o.frequency.value = 420;
      const o2 = c.createOscillator(); o2.type = 'square'; o2.frequency.value = 630;
      const f = c.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = 1800;
      const g = c.createGain(); g.gain.value = 0;
      o.connect(f); o2.connect(f); f.connect(g); g.connect(this.sfxBus);
      o.start(); o2.start();
      this.horn = g;
    },
    setStallHorn(on) {
      if (!this.enabled) return;
      this.horn.gain.setTargetAtTime(on ? 0.07 : 0, this.ctx.currentTime, 0.03);
    },

    /** Silence continuous sounds (pause, menus). */
    quiet() { this.setEngine(0, 0, false); this.setWind(0, 0); this.setStallHorn(false); },

    // --- one-shot effects --------------------------------------------------------
    tone(freq, dur, type, vol, when, glideTo, dest) {
      const c = this.ctx, t = (when || c.currentTime);
      const o = c.createOscillator(), g = c.createGain();
      o.type = type || 'sine';
      o.frequency.setValueAtTime(freq, t);
      if (glideTo) o.frequency.exponentialRampToValueAtTime(glideTo, t + dur);
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(vol || 0.2, t + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      o.connect(g); g.connect(dest || this.sfxBus);
      o.start(t); o.stop(t + dur + 0.05);
    },
    noiseBurst(dur, freq, type, vol, when, sweepTo) {
      const c = this.ctx, t = when || c.currentTime;
      const s = this.noiseSource(), f = c.createBiquadFilter(), g = c.createGain();
      f.type = type || 'lowpass'; f.frequency.setValueAtTime(freq, t);
      if (sweepTo) f.frequency.exponentialRampToValueAtTime(sweepTo, t + dur);
      g.gain.setValueAtTime(vol || 0.4, t);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      s.connect(f); f.connect(g); g.connect(this.sfxBus);
      s.start(t, Math.random()); s.stop(t + dur + 0.05);
    },

    play(name) {
      if (!this.enabled) return;
      const t = this.ctx.currentTime;
      switch (name) {
        case 'boom':
          this.noiseBurst(2.2, 1800, 'lowpass', 1.0, t, 60);
          this.tone(90, 1.6, 'sine', 0.8, t, 28);
          this.noiseBurst(0.25, 4000, 'highpass', 0.4, t);
          break;
        case 'coin':
          this.tone(988, 0.12, 'square', 0.08, t); this.tone(1319, 0.3, 'square', 0.08, t + 0.08);
          break;
        case 'ring':
          [659, 831, 988].forEach((f, i) => this.tone(f, 0.35, 'triangle', 0.15, t + i * 0.05));
          break;
        case 'checkpointMiss':
          this.tone(300, 0.3, 'sawtooth', 0.12, t, 180);
          break;
        case 'cashout':
          [523, 659, 784, 1047].forEach((f, i) => this.tone(f, 0.4, 'triangle', 0.18, t + i * 0.07));
          this.noiseBurst(0.4, 6000, 'highpass', 0.1, t + 0.2);
          break;
        case 'bet': this.tone(660, 0.08, 'square', 0.1, t); this.tone(880, 0.1, 'square', 0.08, t + 0.06); break;
        case 'cancel': this.tone(440, 0.12, 'square', 0.08, t, 300); break;
        case 'tick': this.tone(1200, 0.04, 'square', 0.06, t); break;
        case 'go': this.tone(523, 0.15, 'triangle', 0.2, t); this.tone(1047, 0.35, 'triangle', 0.2, t + 0.12); break;
        case 'click': this.tone(900, 0.03, 'square', 0.05, t); break;
        case 'hover': this.tone(1400, 0.02, 'sine', 0.025, t); break;
        case 'gear': this.noiseBurst(0.9, 500, 'bandpass', 0.15, t, 900); this.tone(160, 0.2, 'square', 0.05, t + 0.85); break;
        case 'flaps': this.noiseBurst(0.5, 700, 'bandpass', 0.1, t, 400); break;
        case 'touchdown': this.noiseBurst(0.35, 900, 'lowpass', 0.35, t, 200); this.tone(70, 0.2, 'sine', 0.3, t); break;
        case 'scrape': this.noiseBurst(0.5, 2500, 'bandpass', 0.35, t, 800); break;
        case 'thunder':
          this.noiseBurst(0.12, 6000, 'highpass', 0.6, t);
          this.noiseBurst(3.5, 400, 'lowpass', 0.9, t + 0.05, 50);
          break;
        case 'hit': this.noiseBurst(0.4, 1400, 'lowpass', 0.6, t, 200); this.tone(120, 0.3, 'sawtooth', 0.2, t, 50); break;
        case 'win': [523, 659, 784, 1047, 1319].forEach((f, i) => this.tone(f, 0.5, 'triangle', 0.16, t + i * 0.1)); break;
        case 'fail': [392, 330, 262].forEach((f, i) => this.tone(f, 0.45, 'sawtooth', 0.09, t + i * 0.18)); break;
        case 'star': this.tone(1568, 0.3, 'triangle', 0.15, t); this.tone(2093, 0.4, 'sine', 0.1, t + 0.05); break;
        case 'flyaway': this.tone(300, 1.4, 'sawtooth', 0.12, t, 1400); this.noiseBurst(1.2, 800, 'bandpass', 0.3, t, 4000); break;
        case 'warning': this.tone(880, 0.12, 'square', 0.08, t); this.tone(880, 0.12, 'square', 0.08, t + 0.2); break;
        // Editor sounds: soft snap click, delete tone, invalid buzz, place pop.
        case 'snap': this.tone(1800, 0.025, 'sine', 0.05, t); break;
        case 'place': this.tone(520, 0.06, 'triangle', 0.08, t); this.tone(780, 0.08, 'triangle', 0.06, t + 0.04); break;
        case 'delete': this.tone(330, 0.16, 'triangle', 0.09, t, 160); break;
        case 'invalid': this.tone(150, 0.18, 'square', 0.06, t); this.tone(140, 0.18, 'square', 0.05, t + 0.09); break;
        default: break;
      }
    },

    // --- music: a small step sequencer built from oscillators ----------------
    startMusic() {
      if (this.musicTimer) return;
      this.step = 0;
      this.nextTime = this.ctx.currentTime + 0.1;
      this.musicTimer = setInterval(() => this.scheduleMusic(), 50);
    },
    setMusicMood(mood) { this.musicMood = mood; },

    scheduleMusic() {
      if (!this.ctx || this.ctx.state !== 'running') return;
      const moods = {
        menu: { bpm: 92, arp: true, drums: false, gain: 1 },
        crash: { bpm: 112, arp: true, drums: true, gain: 0.9 },
        flight: { bpm: 100, arp: false, drums: true, gain: 0.55 },
        tense: { bpm: 126, arp: true, drums: true, gain: 0.8 },
      };
      const mood = moods[this.musicMood] || moods.menu;
      const stepDur = 60 / mood.bpm / 4;  // 16th notes
      // Am – F – C – G progression, one bar each.
      const chords = [[57, 60, 64], [53, 57, 60], [48, 52, 55], [55, 59, 62]];
      const midi = (n) => 440 * Math.pow(2, (n - 69) / 12);
      while (this.nextTime < this.ctx.currentTime + 0.25) {
        const t = this.nextTime, s = this.step % 64, bar = Math.floor(s / 16), beat = s % 16;
        const chord = chords[bar];
        const g = mood.gain;
        if (beat === 0) {
          for (const n of chord) this.pad(midi(n), stepDur * 16, 0.035 * g, t);
        }
        if (beat % 4 === 0) this.tone(midi(chord[0] - 24), stepDur * 3, 'triangle', 0.12 * g, t, null, this.musicBus);
        if (mood.arp && beat % 2 === 0) {
          const pattern = [0, 1, 2, 1, 2, 0, 1, 2];
          const n = chord[pattern[(beat / 2) % 8]] + 12;
          this.tone(midi(n), stepDur * 1.6, 'triangle', 0.045 * g, t, null, this.musicBus);
        }
        if (mood.drums) {
          if (beat % 8 === 0) this.kick(t, 0.25 * g);
          if (beat % 2 === 1) this.hat(t, 0.03 * g);
          if (beat === 4 || beat === 12) this.hat(t, 0.08 * g, 1200);
        }
        this.nextTime += stepDur;
        this.step++;
      }
    },
    pad(freq, dur, vol, t) {
      const c = this.ctx;
      const f = c.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = 900;
      const g = c.createGain();
      g.gain.setValueAtTime(0.0001, t);
      g.gain.linearRampToValueAtTime(vol, t + dur * 0.3);
      g.gain.linearRampToValueAtTime(0.0001, t + dur);
      for (const det of [-7, 7]) {
        const o = c.createOscillator(); o.type = 'sawtooth'; o.frequency.value = freq; o.detune.value = det;
        o.connect(f); o.start(t); o.stop(t + dur + 0.05);
      }
      f.connect(g); g.connect(this.musicBus);
    },
    kick(t, vol) { this.tone(140, 0.25, 'sine', vol, t, 45, this.musicBus); },
    hat(t, vol, freq) {
      const c = this.ctx;
      const s = this.noiseSource(), f = c.createBiquadFilter(), g = c.createGain();
      f.type = freq ? 'bandpass' : 'highpass'; f.frequency.value = freq || 7000;
      g.gain.setValueAtTime(vol, t); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.06);
      s.connect(f); f.connect(g); g.connect(this.musicBus);
      s.start(t, Math.random()); s.stop(t + 0.08);
    },
  };

  AV.Audio = Audio;
})(window.AV);
