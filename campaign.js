/* campaign.js — save data (versioned, corruption-safe), mission definitions,
 * star rules, progression, and hangar unlocks (aircraft, paints, upgrades).
 *
 * Mission geometry uses world coordinates (-Z north, +X east). Points are
 * [x, z, agl] — heights are resolved at runtime above the terrain, and ring
 * courses are automatically lifted so the line between rings clears the ground.
 */
window.AV = window.AV || {};
(function (AV) {
  'use strict';

  // ===========================================================================
  // Save data
  // ===========================================================================
  const SAVE_KEY = 'aviator.save';
  const SAVE_VERSION = 4;
  const MAX_DESIGNS = 10, MAX_MAPS = 12, MAX_THUMB = 80000;

  function defaultSettings() {
    let reduced = false;
    try { reduced = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches); } catch (e) { /* ignore */ }
    return {
      masterVolume: 0.8, musicVolume: 0.45, sfxVolume: 0.85,
      sensitivity: 1, invertPitch: false, mouseFlight: false,
      assist: 'light', camera: 'chase', quality: 'medium',
      uiScale: 1, reducedMotion: reduced, highContrast: false, showFps: false, editorSounds: true,
      bindings: {},
    };
  }

  function defaults() {
    return {
      version: SAVE_VERSION,
      wallet: {
        balance: 1000, nonce: 0, masterSeed: AV.Economy ? AV.Economy.randomHex(16) : 'seed',
        clientSeed: 'aviator-' + Math.floor(Math.random() * 1e6), recent: [],
        stats: { rounds: 0, wagered: 0, won: 0, bestCashout: 0 },
      },
      campaign: { missions: {}, coins: 0 },
      hangar: { selected: 'kestrel', owned: ['kestrel'], paint: 'classic', upgrades: { engine: 0, handling: 0, durability: 0 }, custom: null },
      creative: { designs: [], maps: [] },
      settings: defaultSettings(),
    };
  }

  /** Recursively fill missing keys of `target` from `base` (arrays and primitives replace). */
  function deepMerge(base, target) {
    if (typeof target !== 'object' || target === null || Array.isArray(target)) return target === undefined ? base : target;
    const out = Array.isArray(base) ? [] : Object.assign({}, base);
    for (const k of Object.keys(target)) {
      const b = base ? base[k] : undefined;
      out[k] = b && typeof b === 'object' && !Array.isArray(b) ? deepMerge(b, target[k]) : target[k];
    }
    return out;
  }

  /** Upgrade older save layouts in place. */
  function migrate(d) {
    const v = Number(d.version) || 1;
    if (v < 2) {
      // v1 stored a flat { coins, balance, stars: { missionId: n } }
      const old = d;
      d = { campaign: { coins: old.coins || 0, missions: {} }, wallet: { balance: old.balance }, hangar: {}, settings: {} };
      for (const [id, n] of Object.entries(old.stars || {})) d.campaign.missions[id] = { stars: n, completed: n > 0 };
    }
    if (v < 3 && d.wallet) {
      // v3 added the provably-fair client seed and stats block.
      d.wallet.stats = d.wallet.stats || {};
    }
    if (v < 4) {
      // v4 added Plane Builder designs and Map Builder maps; nothing existing changes.
      d.creative = d.creative || { designs: [], maps: [] };
    }
    d.version = SAVE_VERSION;
    return d;
  }

  const finite = (v, def, lo, hi) => {
    const n = Number(v);
    if (!Number.isFinite(n)) return def;
    return Math.min(hi === undefined ? Infinity : hi, Math.max(lo === undefined ? -Infinity : lo, n));
  };

  /** Clamp and type-check everything so a hand-edited or half-written save can never crash the game. */
  function sanitize(d) {
    const def = defaults();
    const w = d.wallet;
    w.balance = finite(w.balance, def.wallet.balance, 0, 1e9);
    w.nonce = Math.floor(finite(w.nonce, 0, 0));
    if (typeof w.masterSeed !== 'string' || !w.masterSeed) w.masterSeed = def.wallet.masterSeed;
    if (typeof w.clientSeed !== 'string' || !w.clientSeed) w.clientSeed = def.wallet.clientSeed;
    if (!Array.isArray(w.recent)) w.recent = [];
    w.recent = w.recent.map(Number).filter(Number.isFinite).slice(0, 20);
    for (const k of Object.keys(def.wallet.stats)) w.stats[k] = finite(w.stats[k], 0, 0);
    const c = d.campaign;
    c.coins = Math.floor(finite(c.coins, 0, 0, 1e8));
    if (typeof c.missions !== 'object' || !c.missions || Array.isArray(c.missions)) c.missions = {};
    for (const id of Object.keys(c.missions)) {
      const m = c.missions[id];
      if (!m || typeof m !== 'object') { delete c.missions[id]; continue; }
      m.stars = Math.floor(finite(m.stars, 0, 0, 3));
      m.bestTime = m.bestTime == null ? null : finite(m.bestTime, null, 0);
      m.completed = !!m.completed || m.stars > 0;
    }
    const h = d.hangar;
    const ids = Object.keys(AV.Physics.CONFIG.aircraft);
    if (!Array.isArray(h.owned)) h.owned = ['kestrel'];
    h.owned = h.owned.filter((id) => ids.includes(id));
    if (!h.owned.includes('kestrel')) h.owned.unshift('kestrel');
    if (!h.owned.includes(h.selected)) h.selected = 'kestrel';
    if (!AV.Aircraft || !AV.Aircraft.PAINTS) { /* aircraft.js not loaded in tests */ } else if (!AV.Aircraft.PAINTS[h.paint]) h.paint = 'classic';
    for (const k of ['engine', 'handling', 'durability']) h.upgrades[k] = Math.floor(finite(h.upgrades[k], 0, 0, 3));
    const s = d.settings;
    for (const k of ['masterVolume', 'musicVolume', 'sfxVolume']) s[k] = finite(s[k], def.settings[k], 0, 1);
    s.sensitivity = finite(s.sensitivity, 1, 0.3, 2.5);
    s.uiScale = finite(s.uiScale, 1, 0.8, 1.5);
    if (!['off', 'light', 'heavy'].includes(s.assist)) s.assist = 'light';
    if (!['chase', 'cockpit', 'orbit'].includes(s.camera)) s.camera = 'chase';
    if (!['low', 'medium', 'high'].includes(s.quality)) s.quality = 'medium';
    if (typeof s.bindings !== 'object' || !s.bindings || Array.isArray(s.bindings)) s.bindings = {};
    for (const k of ['invertPitch', 'mouseFlight', 'reducedMotion', 'highContrast', 'showFps', 'editorSounds']) s[k] = !!s[k];
    sanitizeCreative(d);
    d.version = SAVE_VERSION;
    return d;
  }

  /** Designs and maps go through the same validators used for JSON import. */
  function sanitizeCreative(d) {
    const c = d.creative && typeof d.creative === 'object' ? d.creative : {};
    const thumb = (t) => (typeof t === 'string' && t.startsWith('data:image/') && t.length <= MAX_THUMB ? t : null);
    const entries = (arr, max, parse) => (Array.isArray(arr) ? arr : []).slice(0, max).map((e) => {
      if (!e || typeof e !== 'object' || typeof e.id !== 'string') return null;
      try {
        return { id: e.id.slice(0, 40), name: String(e.name || 'Untitled').slice(0, 40), updated: Number(e.updated) || 0, thumb: thumb(e.thumb), data: parse(e.data) };
      } catch (err) { console.warn('[Aviator] Dropped an unreadable saved item:', err.message); return null; }
    }).filter(Boolean);
    d.creative = {
      designs: entries(c.designs, MAX_DESIGNS, (x) => AV.Parts.importDesign(x).design),
      maps: entries(c.maps, MAX_MAPS, (x) => AV.MapFormat.parseMap(x, { quiet: true }).map),
    };
    const h = d.hangar;
    if (h.custom && !d.creative.designs.some((x) => x.id === h.custom)) h.custom = null;
    if (typeof h.custom !== 'string') h.custom = null;
  }

  const Save = {
    VERSION: SAVE_VERSION,
    KEY: SAVE_KEY,
    data: null,
    storageOk: true,
    recovered: false,
    _memory: null,

    load() {
      let raw = null;
      try { raw = window.localStorage.getItem(SAVE_KEY); } catch (e) { this.storageOk = false; raw = this._memory; }
      if (!raw) { this.data = defaults(); return this.data; }
      try {
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('save is not an object');
        this.data = sanitize(deepMerge(defaults(), migrate(parsed)));
      } catch (e) {
        // Corrupted save: keep a copy for inspection and start fresh.
        console.warn('[Aviator] Save data was corrupted and has been reset.', e && e.message);
        try { window.localStorage.setItem(SAVE_KEY + '.corrupt', String(raw).slice(0, 100000)); } catch (e2) { /* ignore */ }
        this.recovered = true;
        this.data = defaults();
        this.save();
      }
      return this.data;
    },

    /** Returns true when the data reached persistent storage. */
    save() {
      if (!this.data) return false;
      const json = JSON.stringify(this.data);
      try { window.localStorage.setItem(SAVE_KEY, json); this.storageOk = true; return true; } catch (e) { this.storageOk = false; this._memory = json; this.lastError = e; return false; }
    },

    reset() {
      const keepSettings = this.data ? this.data.settings : null;
      this.data = defaults();
      if (keepSettings) this.data.settings = keepSettings;
      this.save();
    },
  };
  AV.Save = Save;

  // ===========================================================================
  // Missions
  // ===========================================================================
  const CHAPTERS = [
    { id: 1, name: 'First Wings', blurb: 'Learn the ropes over the Meadowlands. Generous rings, gentle winds.', requiredStars: 0, reward: 150 },
    { id: 2, name: 'Open Skies', blurb: 'Coast, desert and a drone that needs a friend. Tighter courses, real crosswinds.', requiredStars: 7, reward: 250 },
    { id: 3, name: 'Storm Front', blurb: 'Lightning, thin mountain air and an iron giant. Precise flying required.', requiredStars: 20, reward: 400 },
  ];

  const MISSIONS = [
    // ------------------------------------------------------------- Chapter 1
    {
      id: 'c1m1', chapter: 1, name: 'Circuit Training', type: 'rings', icon: '◎',
      briefing: 'Take off from Meadow Field and fly the training circuit. Pass every ring in order — missed rings stay lit until you go back for them.',
      spawn: { airfield: 'meadow' }, time: 10, weather: 'clear', wind: [2, 220],
      rings: [[0, -1000, 70], [550, -1700, 120], [1350, -1600, 150], [1750, -800, 150], [1450, 150, 120], [700, 750, 90], [0, 1250, 70]],
      ringRadius: 34, par: 125, starRule: { kind: 'time', two: 1.4 },
    },
    {
      id: 'c1m2', chapter: 1, name: 'Meadow Coins', type: 'coins', icon: '◉',
      briefing: 'A careless courier dropped a sack of coins over Millbrook. Swoop low and collect at least 15 before the clock runs out.',
      spawn: { air: [-200, -500, 120, 290], speedFactor: 1 }, time: 9, weather: 'clear', wind: [3, 250],
      coins: { center: [-1300, -900], radius: 650, count: 22, agl: [25, 90], seed: 11 }, need: 15, timeLimit: 210,
      par: 110, starRule: { kind: 'coins', two: 19 },
    },
    {
      id: 'c1m3', chapter: 1, name: 'Back to Earth', type: 'landing', icon: '⊥',
      briefing: 'You are on final approach to Meadow Field, runway 36. Touch down gently on the yellow target and roll to a stop on the runway. Gear is down, flaps are set.',
      spawn: { approach: 'meadow', distance: 2400, height: 140, flaps: 0.5 }, time: 17.5, weather: 'clear', wind: [2, 0],
      target: { airfield: 'meadow', along: -380 },
      starRule: { kind: 'landing', three: [25, 2.0], two: [70, 3.2] },
    },
    {
      id: 'c1m4', chapter: 1, name: 'Wind Farm Slalom', type: 'rings', icon: '✣',
      briefing: 'Thread the gap between the turbine rows at Breezy Ridge, then loop back over the top. Mind the blades!',
      spawn: { air: [500, 700, 80, 90], speedFactor: 1 }, time: 12, weather: 'clear', wind: [6, 270],
      rings: [[1290, 690, 45], [1445, 715, 40], [1585, 685, 45], [1725, 715, 40], [1865, 690, 45], [2250, 820, 80], [2100, 1050, 120], [1650, 1050, 140], [1200, 950, 120]],
      ringRadius: 24, par: 80, starRule: { kind: 'time', two: 1.35 },
    },
    // ------------------------------------------------------------- Chapter 2
    {
      id: 'c2m1', chapter: 2, name: 'Canyon Run', type: 'tunnel', icon: '▭',
      briefing: 'Engineers built a test tunnel over the hills west of Meadow Field. Fly the whole length without leaving it. Scrapes cost hull points.',
      spawn: { air: [-300, 600, 60, 300], speedFactor: 1 }, time: 14, weather: 'clear', wind: [3, 200],
      tunnel: { path: [[-700, 400, 35], [-1300, 100, 40], [-1800, -350, 45], [-2100, -1000, 45], [-1900, -1600, 40], [-1400, -1900, 40]], width: 38, height: 28, spacing: 30 },
      par: 75, starRule: { kind: 'tunnel', two: 1.3, maxDamage3: 0.15 },
    },
    {
      id: 'c2m2', chapter: 2, name: 'Coastal Sprint', type: 'rings', icon: '≈',
      briefing: 'Race down the coastline from Harbor Field past Gull Point. Rings hug the beach — stay low and fast.',
      spawn: { air: [2400, -2600, 80, 150], speedFactor: 1.1 }, time: 15, weather: 'clear', wind: [7, 90],
      rings: [{ z: -2000, shore: 40, agl: 40 }, { z: -1400, shore: 20, agl: 30 }, { z: -800, shore: -30, agl: 35 }, { z: -200, shore: 30, agl: 40 },
        { z: 300, shore: 80, agl: 55 }, { z: 900, shore: 0, agl: 30 }, { z: 1500, shore: -40, agl: 30 }, { z: 2100, shore: 30, agl: 45 }],
      ringRadius: 22, par: 95, starRule: { kind: 'time', two: 1.3 },
    },
    {
      id: 'c2m3', chapter: 2, name: 'Courier Escort', type: 'escort', icon: '⟡',
      briefing: 'A courier drone is carrying medicine to Harbor Field. Stay within 200 m of it the whole way. Drift out of range too long and it will abort.',
      spawn: { air: [0, -480, 95, 0], speedFactor: 1 }, time: 11, weather: 'cloudy', wind: [6, 300],
      drone: { path: [[0, -700, 100], [700, -1300, 140], [1500, -2000, 170], [2300, -2300, 150], [2900, -2000, 100], [3000, -1500, 60]], speed: 38, range: 200, maxOut: 12 },
      need: 0.7, starRule: { kind: 'escort', three: 0.95, two: 0.85 },
    },
    {
      id: 'c2m4', chapter: 2, name: 'Desert Treasure', type: 'coins', icon: '◈',
      briefing: 'Coins glitter over the Sunscar Desert — some on top of Red Mesa itself. Collect 18 in time.',
      spawn: { air: [600, 3200, 120, 180], speedFactor: 1 }, time: 13, weather: 'clear', wind: [5, 140],
      coins: { center: [900, 4600], radius: 900, count: 26, agl: [20, 110], seed: 23 }, need: 18, timeLimit: 210,
      par: 140, starRule: { kind: 'coins', two: 22 },
    },
    {
      id: 'c2m5', chapter: 2, name: 'Dune Strip Landing', type: 'landing', icon: '⊥',
      briefing: 'Land on the Dune Strip runway 09 with a crosswind from the south. Crab into the wind, then kick straight before touchdown.',
      spawn: { approach: 'dune', distance: 2600, height: 150, flaps: 0.5 }, time: 16, weather: 'clear', wind: [8, 180],
      target: { airfield: 'dune', along: -260 },
      starRule: { kind: 'landing', three: [20, 1.8], two: [55, 3.0] },
    },
    // ------------------------------------------------------------- Chapter 3
    {
      id: 'c3m1', chapter: 3, name: 'Eye of the Storm', type: 'storm', icon: 'ϟ',
      briefing: 'A storm cell is parked over the Meadowlands. Reach all six beacons. Lightning hunts aircraft flying inside the clouds — stay below the base if you can.',
      spawn: { air: [0, -300, 160, 0], speedFactor: 1 }, time: 15.5, weather: 'storm', wind: [13, 260],
      rings: [[-500, -1200, 180], [400, -2000, 220], [1300, -1400, 200], [1100, -300, 160], [200, 400, 150], [-800, -200, 170]],
      ringRadius: 40, par: 150, lightning: { interval: [2.5, 5], damage: 0.18, radius: 70 },
      starRule: { kind: 'survive', three: 0.1, two: 0.4 },
    },
    {
      id: 'c3m2', chapter: 3, name: 'Peak Pursuit', type: 'rings', icon: '▲',
      briefing: 'A rings course through the Frost Peaks. The air is thinner up here — your engine and wings have less to work with.',
      spawn: { air: [0, -3300, 160, 345], speedFactor: 1.05 }, time: 11, weather: 'clear', wind: [8, 330],
      rings: [[-350, -4100, 60], [-1000, -4700, 70], [-1600, -5150, 60], [-1300, -5900, 80], [-500, -6400, 70], [300, -6700, 80], [700, -6200, 50], [1300, -5500, 70], [1100, -4600, 60]],
      ringRadius: 17, par: 120, starRule: { kind: 'time', two: 1.2 },
    },
    {
      id: 'c3m3', chapter: 3, name: 'Summit Landing', type: 'landing', icon: '⊥',
      briefing: 'Summit Pad is short, high and gusty. Land on the target and stop before the end — 320 metres is all you get.',
      spawn: { approach: 'summit', distance: 2200, height: 170, flaps: 0.6 }, time: 9.5, weather: 'cloudy', wind: [7, 320],
      target: { airfield: 'summit', along: -110 },
      starRule: { kind: 'landing', three: [15, 1.8], two: [40, 2.8] },
    },
    {
      id: 'c3m4', chapter: 3, name: 'Ice Tunnel', type: 'tunnel', icon: '▭',
      briefing: 'A narrower tunnel winds between the peaks. Tight turns, no second chances on the gates.',
      spawn: { air: [-2600, -3000, 120, 350], speedFactor: 1 }, time: 13, weather: 'cloudy', wind: [6, 0],
      tunnel: { path: [[-2700, -3600, 45], [-2850, -4200, 50], [-2600, -4800, 55], [-2100, -5100, 55], [-1700, -5600, 50], [-1900, -6200, 55], [-2400, -6500, 55]], width: 26, height: 20, spacing: 26 },
      par: 70, starRule: { kind: 'tunnel', two: 1.25, maxDamage3: 0.1 },
    },
    {
      id: 'c3m5', chapter: 3, name: 'The Iron Zeppelin', type: 'boss', icon: '☠',
      briefing: 'The Iron Zeppelin is circling Meadow Field dropping plasma mines. Fly through its four glowing weak points, then cross under its belly through the gold core ring to bring it down.',
      spawn: { air: [-500, 400, 260, 0], speedFactor: 1 }, time: 18.5, weather: 'cloudy', wind: [5, 250],
      boss: { center: [-400, -1600], radius: 1000, agl: 330, speed: 22, weakPoints: 4, mineInterval: 3.2, mineDamage: 0.22 },
      timeLimit: 330, par: 170, starRule: { kind: 'boss', two: 1.4, maxDamage3: 0.3 },
    },
  ];

  const missionById = (id) => MISSIONS.find((m) => m.id === id);
  const missionsInChapter = (ch) => MISSIONS.filter((m) => m.chapter === ch);
  const progressOf = (id) => (Save.data.campaign.missions[id] || { stars: 0, completed: false, bestTime: null });

  function totalStars() {
    return MISSIONS.reduce((s, m) => s + progressOf(m.id).stars, 0);
  }
  function chapterStars(ch) {
    return missionsInChapter(ch).reduce((s, m) => s + progressOf(m.id).stars, 0);
  }
  function chapterComplete(ch) { return missionsInChapter(ch).every((m) => progressOf(m.id).completed); }

  function isChapterUnlocked(ch) {
    const c = CHAPTERS.find((x) => x.id === ch);
    if (!c) return false;
    if (ch === 1) return true;
    return chapterComplete(ch - 1) && totalStars() >= c.requiredStars;
  }

  function isMissionUnlocked(m) {
    if (!isChapterUnlocked(m.chapter)) return false;
    const list = missionsInChapter(m.chapter);
    const i = list.indexOf(m);
    return i === 0 || progressOf(list[i - 1].id).completed;
  }

  // ---------------------------------------------------------------------------
  // Stars
  // ---------------------------------------------------------------------------
  /**
   * result: { success, time, damage, coins, inRange, landingError, sink }
   * Returns 0 (failed) .. 3.
   */
  function starsFor(m, r) {
    if (!r || !r.success) return 0;
    const rule = m.starRule;
    switch (rule.kind) {
      case 'time':
        return r.time <= m.par ? 3 : r.time <= m.par * rule.two ? 2 : 1;
      case 'coins':
        if (r.coins >= m.coins.count && r.time <= m.par) return 3;
        return r.coins >= rule.two ? 2 : 1;
      case 'landing': {
        const [d3, s3] = rule.three, [d2, s2] = rule.two;
        if (r.landingError <= d3 && r.sink <= s3) return 3;
        if (r.landingError <= d2 && r.sink <= s2) return 2;
        return 1;
      }
      case 'escort':
        return r.inRange >= rule.three ? 3 : r.inRange >= rule.two ? 2 : 1;
      case 'survive':
        return r.damage <= rule.three ? 3 : r.damage <= rule.two ? 2 : 1;
      case 'tunnel':
      case 'boss':
        if (r.time <= m.par && r.damage <= rule.maxDamage3) return 3;
        return r.time <= m.par * rule.two ? 2 : 1;
      default:
        return 1;
    }
  }

  const fmtTime = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

  /** Human-readable star requirements for briefing cards: [1★, 2★, 3★]. */
  function starText(m) {
    const rule = m.starRule;
    switch (rule.kind) {
      case 'time': return ['Finish the course', `Under ${fmtTime(m.par * rule.two)}`, `Under ${fmtTime(m.par)}`];
      case 'coins': return [`Collect ${m.need} coins`, `Collect ${rule.two} coins`, `All ${m.coins.count} under ${fmtTime(m.par)}`];
      case 'landing': return ['Land and stop on the runway', `Within ${rule.two[0]} m, sink < ${rule.two[1]} m/s`, `Within ${rule.three[0]} m, sink < ${rule.three[1]} m/s`];
      case 'escort': return [`Stay in range ${Math.round(m.need * 100)}% of the time`, `${Math.round(rule.two * 100)}% in range`, `${Math.round(rule.three * 100)}% in range`];
      case 'survive': return ['Reach every beacon', `Hull damage under ${rule.two * 100}%`, `Hull damage under ${rule.three * 100}%`];
      case 'tunnel': return ['Fly the full tunnel', `Under ${fmtTime(m.par * rule.two)}`, `Under ${fmtTime(m.par)} with < ${rule.maxDamage3 * 100}% damage`];
      case 'boss': return ['Destroy the Zeppelin', `Under ${fmtTime(m.par * rule.two)}`, `Under ${fmtTime(m.par)} with < ${rule.maxDamage3 * 100}% damage`];
      default: return ['Complete', 'Complete', 'Complete'];
    }
  }

  /** Persist a mission result; returns what changed for the result card. */
  function recordResult(m, r) {
    const stars = starsFor(m, r);
    const before = { total: totalStars(), chapters: CHAPTERS.map((c) => isChapterUnlocked(c.id)), aircraft: aircraftList().filter((a) => a.unlocked).map((a) => a.id), paints: paintList().filter((p) => p.unlocked).map((p) => p.id) };
    const prog = Object.assign({ stars: 0, completed: false, bestTime: null }, Save.data.campaign.missions[m.id]);
    const base = CHAPTERS[m.chapter - 1].reward;
    let coins = 0;
    if (stars > 0) {
      const mult = [0, 1, 1.5, 2];
      // Pay the difference for improved stars, plus a small replay bonus.
      coins = Math.round(base * Math.max(0, mult[stars] - mult[prog.stars]) + base * 0.15);
      coins += r.coinsCollected ? r.coinsCollected * 5 : 0;
      prog.completed = true;
      prog.stars = Math.max(prog.stars, stars);
      if (r.time != null && (prog.bestTime == null || r.time < prog.bestTime)) prog.bestTime = r.time;
    }
    Save.data.campaign.missions[m.id] = prog;
    Save.data.campaign.coins += coins;
    Save.save();
    const unlocks = [];
    CHAPTERS.forEach((c, i) => { if (!before.chapters[i] && isChapterUnlocked(c.id)) unlocks.push(`Chapter ${c.id}: ${c.name}`); });
    aircraftList().forEach((a) => { if (a.unlocked && !before.aircraft.includes(a.id)) unlocks.push(`Aircraft available: ${a.name}`); });
    paintList().forEach((p) => { if (p.unlocked && !before.paints.includes(p.id)) unlocks.push(`Paint scheme: ${p.name}`); });
    return { stars, coins, best: prog, unlocks };
  }

  // ===========================================================================
  // Hangar: aircraft, paints, upgrades
  // ===========================================================================
  const AIRCRAFT_UNLOCKS = {
    kestrel: { requires: null, text: 'Starter aircraft' },
    bulldog: { requires: () => progressOf('c1m2').completed, text: 'Complete “Meadow Coins”' },
    swift: { requires: () => chapterComplete(1), text: 'Complete Chapter 1' },
    titan: { requires: () => chapterComplete(2), text: 'Complete Chapter 2' },
  };
  const PAINT_UNLOCKS = { classic: 0, sunset: 4, arctic: 10, racing: 16, stealth: 26, gold: 38 };
  const UPGRADE_COSTS = [300, 700, 1300];
  const UPGRADE_INFO = {
    engine: { name: 'Engine power', desc: '+8% thrust per level' },
    handling: { name: 'Handling', desc: '+8% control authority per level' },
    durability: { name: 'Durability', desc: '+20% airframe strength per level' },
  };

  function aircraftList() {
    const cfg = AV.Physics.CONFIG.aircraft;
    return Object.keys(cfg).map((id) => {
      const u = AIRCRAFT_UNLOCKS[id] || { requires: null, text: '' };
      const owned = Save.data.hangar.owned.includes(id);
      return { id, name: cfg[id].name, role: cfg[id].role, price: cfg[id].price, owned, unlocked: owned || !u.requires || u.requires(), requirement: u.text };
    });
  }

  function buyAircraft(id) {
    const a = aircraftList().find((x) => x.id === id);
    if (!a || a.owned) return { ok: false, error: 'Already owned' };
    if (!a.unlocked) return { ok: false, error: a.requirement };
    if (Save.data.campaign.coins < a.price) return { ok: false, error: 'Not enough coins' };
    Save.data.campaign.coins -= a.price;
    Save.data.hangar.owned.push(id);
    Save.save();
    return { ok: true };
  }

  function paintList() {
    const stars = totalStars();
    return Object.keys(AV.Aircraft.PAINTS).map((id) => ({ id, name: AV.Aircraft.PAINTS[id].name, need: PAINT_UNLOCKS[id] || 0, unlocked: stars >= (PAINT_UNLOCKS[id] || 0) }));
  }

  function buyUpgrade(kind) {
    const lvl = Save.data.hangar.upgrades[kind];
    if (lvl === undefined) return { ok: false, error: 'Unknown upgrade' };
    if (lvl >= UPGRADE_COSTS.length) return { ok: false, error: 'Maxed out' };
    const cost = UPGRADE_COSTS[lvl];
    if (Save.data.campaign.coins < cost) return { ok: false, error: 'Not enough coins' };
    Save.data.campaign.coins -= cost;
    Save.data.hangar.upgrades[kind] = lvl + 1;
    Save.save();
    return { ok: true };
  }

  function selectAircraft(id) {
    if (!Save.data.hangar.owned.includes(id)) return false;
    Save.data.hangar.selected = id; Save.save(); return true;
  }
  function selectPaint(id) {
    const p = paintList().find((x) => x.id === id);
    if (!p || !p.unlocked) return false;
    Save.data.hangar.paint = id; Save.save(); return true;
  }

  // ===========================================================================
  // Creative: saved Plane Builder designs and Map Builder maps
  // ===========================================================================
  /** Store an item (design or map) in a capped list; returns { ok, id, error }. */
  function storeItem(list, max, item) {
    const idx = list.findIndex((x) => x.id === item.id);
    const before = list.slice();
    if (idx >= 0) list[idx] = item;
    else {
      if (list.length >= max) return { ok: false, error: `You can keep up to ${max}. Delete one first.` };
      list.push(item);
    }
    if (!Save.save() && Save.lastError && /quota/i.test(String(Save.lastError.name || Save.lastError.message))) {
      list.length = 0; list.push(...before); Save.save();
      return { ok: false, error: 'Browser storage is full — delete some saved designs or maps.' };
    }
    return { ok: true, id: item.id };
  }
  const newItemId = (p) => p + Date.now().toString(36) + Math.floor(Math.random() * 1e4).toString(36);

  const Creative = {
    MAX_DESIGNS, MAX_MAPS,
    designs: () => Save.data.creative.designs,
    maps: () => Save.data.creative.maps,
    getDesign: (id) => Save.data.creative.designs.find((x) => x.id === id) || null,
    getMap: (id) => Save.data.creative.maps.find((x) => x.id === id) || null,
    saveDesign(design, thumb, id) {
      const item = { id: id || newItemId('d'), name: (design.name || 'My plane').slice(0, 40), updated: Date.now(), thumb: thumb && thumb.length <= MAX_THUMB ? thumb : null, data: JSON.parse(JSON.stringify(design)) };
      return storeItem(Save.data.creative.designs, MAX_DESIGNS, item);
    },
    deleteDesign(id) {
      Save.data.creative.designs = Save.data.creative.designs.filter((x) => x.id !== id);
      if (Save.data.hangar.custom === id) Save.data.hangar.custom = null;
      Save.save();
    },
    saveMap(map, thumb, id) {
      const item = { id: id || newItemId('m'), name: (map.name || 'My map').slice(0, 40), updated: Date.now(), thumb: thumb && thumb.length <= MAX_THUMB ? thumb : null, data: AV.MapFormat.serializeMap(map) };
      return storeItem(Save.data.creative.maps, MAX_MAPS, item);
    },
    deleteMap(id) { Save.data.creative.maps = Save.data.creative.maps.filter((x) => x.id !== id); Save.save(); },
    /** Use a saved design for crash mode and free flight (null = stock aircraft). */
    selectCustom(id) { Save.data.hangar.custom = id && Creative.getDesign(id) ? id : null; Save.save(); },
    /** Aircraft choice for crash mode / free flight: a custom design if one is selected. */
    flightAircraft() {
      const c = Save.data.hangar.custom && Creative.getDesign(Save.data.hangar.custom);
      return c ? { design: c.data, designId: c.id } : { aircraftId: Save.data.hangar.selected };
    },
  };
  AV.Creative = Creative;

  AV.Campaign = {
    CHAPTERS, MISSIONS, UPGRADE_COSTS, UPGRADE_INFO, PAINT_UNLOCKS,
    missionById, missionsInChapter, progressOf, totalStars, chapterStars, chapterComplete,
    isChapterUnlocked, isMissionUnlocked, starsFor, starText, recordResult, fmtTime,
    aircraftList, buyAircraft, paintList, buyUpgrade, selectAircraft, selectPaint,
  };
})(window.AV);
