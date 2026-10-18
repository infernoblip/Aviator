/* economy.js — play-money wallet, crash-round maths, bets, cash-out, history.
 *
 * Provably-fair scheme (all play money):
 *   roundSeed  = sha256(masterSeed + ':' + nonce)          — seeded, reproducible chain
 *   commitment = sha256(roundSeed)                          — shown BEFORE the round
 *   r          = first 52 bits of sha256(roundSeed + ':' + clientSeed) / 2^52
 *   crash      = floor(100 · (1 − houseEdge) / (1 − r)) / 100, clamped to [1, max]
 * After the round the seed is revealed; anyone can recompute commitment and crash.
 * With this curve P(crash ≥ x) = (1 − houseEdge) / x.
 */
window.AV = window.AV || {};
(function (AV) {
  'use strict';

  /** Single place to tune the crash distribution and round pacing. */
  const CRASH_DISTRIBUTION = {
    houseEdge: 0.03,       // fraction of expected value kept by the "house"
    maxMultiplier: 1000,   // hard cap
    growthRate: 0.075,     // multiplier(t) = e^(growthRate · t) — accelerating curve
    bettingSeconds: 7,     // bet timer before takeoff
    cooldownSeconds: 3.5,  // "waiting for next round" after a crash
    minBet: 1, maxBet: 5000,
    startingBalance: 1000, topUpAmount: 1000,
  };

  // ---------------------------------------------------------------------------
  // SHA-256 (synchronous, pure JS — works from file:// and in Node)
  // ---------------------------------------------------------------------------
  const K = new Uint32Array([
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
  ]);

  function utf8Bytes(str) {
    if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(str);
    const out = [];
    for (const ch of unescape(encodeURIComponent(str))) out.push(ch.charCodeAt(0));
    return Uint8Array.from(out);
  }

  function sha256(message) {
    const bytes = utf8Bytes(String(message));
    const bitLen = bytes.length * 8;
    const padded = new Uint8Array(((bytes.length + 9 + 63) >> 6) << 6);
    padded.set(bytes);
    padded[bytes.length] = 0x80;
    const view = new DataView(padded.buffer);
    view.setUint32(padded.length - 4, bitLen >>> 0);
    view.setUint32(padded.length - 8, Math.floor(bitLen / 4294967296));
    const H = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
    const W = new Uint32Array(64);
    const rotr = (x, n) => (x >>> n) | (x << (32 - n));
    for (let off = 0; off < padded.length; off += 64) {
      for (let i = 0; i < 16; i++) W[i] = view.getUint32(off + i * 4);
      for (let i = 16; i < 64; i++) {
        const s0 = rotr(W[i - 15], 7) ^ rotr(W[i - 15], 18) ^ (W[i - 15] >>> 3);
        const s1 = rotr(W[i - 2], 17) ^ rotr(W[i - 2], 19) ^ (W[i - 2] >>> 10);
        W[i] = (W[i - 16] + s0 + W[i - 7] + s1) >>> 0;
      }
      let [a, b, c, d, e, f, g, h] = H;
      for (let i = 0; i < 64; i++) {
        const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
        const ch = (e & f) ^ (~e & g);
        const t1 = (h + S1 + ch + K[i] + W[i]) >>> 0;
        const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
        const maj = (a & b) ^ (a & c) ^ (b & c);
        const t2 = (S0 + maj) >>> 0;
        h = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0;
      }
      H[0] += a; H[1] += b; H[2] += c; H[3] += d; H[4] += e; H[5] += f; H[6] += g; H[7] += h;
    }
    return Array.from(H, (x) => x.toString(16).padStart(8, '0')).join('');
  }

  // ---------------------------------------------------------------------------
  // Crash maths
  // ---------------------------------------------------------------------------
  function crashPointFromSeed(roundSeed, clientSeed, cfg) {
    const c = cfg || CRASH_DISTRIBUTION;
    const h = sha256(roundSeed + ':' + clientSeed);
    const r = parseInt(h.slice(0, 13), 16) / Math.pow(2, 52);   // uniform in [0, 1)
    const raw = (1 - c.houseEdge) / (1 - r);
    return Math.min(c.maxMultiplier, Math.max(1, Math.floor(raw * 100) / 100));
  }

  const multiplierAt = (t) => Math.exp(CRASH_DISTRIBUTION.growthRate * Math.max(0, t));

  /** Deterministic round derived from the master seed + nonce. */
  function makeRound(masterSeed, clientSeed, nonce) {
    const seed = sha256(masterSeed + ':' + nonce);
    return { nonce, seed, hash: sha256(seed), clientSeed, crashPoint: crashPointFromSeed(seed, clientSeed) };
  }

  function verifyRound(seed, clientSeed) {
    return { hash: sha256(seed), crashPoint: crashPointFromSeed(seed, clientSeed) };
  }

  function randomHex(bytes) {
    const arr = new Uint8Array(bytes);
    if (typeof crypto !== 'undefined' && crypto.getRandomValues) crypto.getRandomValues(arr);
    else for (let i = 0; i < bytes; i++) arr[i] = Math.floor(Math.random() * 256);
    return Array.from(arr, (b) => b.toString(16).padStart(2, '0')).join('');
  }

  /** Colour class for a crash value, shared by the history strip and result banners. */
  function tierFor(m) {
    if (m < 1.2) return 'tier-bust';
    if (m < 2) return 'tier-low';
    if (m < 10) return 'tier-mid';
    if (m < 50) return 'tier-high';
    return 'tier-epic';
  }

  const round2 = (v) => Math.floor(v * 100 + 1e-6) / 100;

  // ---------------------------------------------------------------------------
  // Wallet + bet slots
  // ---------------------------------------------------------------------------
  function makeSlot(index) {
    return { index, amount: 10, autoEnabled: false, autoTarget: 2.0, status: 'idle', stake: 0, payout: 0, cashedAt: 0, queued: false };
  }

  const Wallet = {
    slots: [makeSlot(0), makeSlot(1)],
    roundHistory: [],      // { crashPoint, seed, hash, nonce }
    betHistory: [],        // { nonce, slot, stake, cashedAt, payout, crashPoint }
    listeners: [],

    get data() { return AV.Save.data.wallet; },
    get balance() { return this.data.balance; },

    onChange(fn) { this.listeners.push(fn); },
    emit() { for (const fn of this.listeners) fn(this); },

    persist() { AV.Save.save(); this.emit(); },

    nextRound() {
      const w = this.data;
      w.nonce += 1;
      return makeRound(w.masterSeed, w.clientSeed, w.nonce);
    },

    setClientSeed(s) { this.data.clientSeed = String(s).slice(0, 64) || 'aviator'; this.persist(); },
    rotateMasterSeed() { this.data.masterSeed = randomHex(16); this.data.nonce = 0; this.persist(); },

    /** Place (or queue) a bet. phase: 'betting' places now, anything else queues for next round. */
    placeBet(i, amount, phase) {
      const slot = this.slots[i], c = CRASH_DISTRIBUTION;
      const a = round2(Number(amount));
      if (!(a >= c.minBet)) return { ok: false, error: `Minimum bet is ${c.minBet}` };
      if (a > c.maxBet) return { ok: false, error: `Maximum bet is ${c.maxBet}` };
      if (slot.status === 'active' || slot.queued) return { ok: false, error: 'Bet already placed' };
      if (a > this.balance) return { ok: false, error: 'Insufficient balance' };
      slot.amount = a;
      if (phase === 'betting') {
        this.data.balance = round2(this.balance - a);
        slot.stake = a; slot.status = 'active'; slot.payout = 0; slot.cashedAt = 0;
      } else {
        slot.queued = true;
      }
      this.persist();
      return { ok: true };
    },

    cancelBet(i, phase) {
      const slot = this.slots[i];
      if (slot.queued) { slot.queued = false; this.emit(); return { ok: true }; }
      if (slot.status === 'active' && phase === 'betting') {
        this.data.balance = round2(this.balance + slot.stake);
        slot.status = 'idle'; slot.stake = 0;
        this.persist();
        return { ok: true };
      }
      return { ok: false, error: 'Bet is already in flight' };
    },

    /** Called when betting opens: queued bets become live if affordable. */
    activateQueued() {
      for (const slot of this.slots) {
        if (slot.status !== 'active') slot.status = 'idle';
        if (slot.queued) {
          slot.queued = false;
          this.placeBet(slot.index, slot.amount, 'betting');
        }
      }
      this.emit();
    },

    cashOut(i, rawMultiplier) {
      const slot = this.slots[i];
      if (slot.status !== 'active') return null;
      const multiplier = round2(rawMultiplier);   // pay exactly what the player saw on screen
      const payout = round2(slot.stake * multiplier);
      slot.status = 'cashed'; slot.cashedAt = multiplier; slot.payout = payout;
      this.data.balance = round2(this.balance + payout);
      const st = this.data.stats;
      st.won += payout; st.bestCashout = Math.max(st.bestCashout, multiplier);
      this.persist();
      return { slot: i, payout, multiplier };
    },

    /** Auto cash-out exactly at each slot's target once the live multiplier reaches it. */
    checkAuto(multiplier) {
      const out = [];
      for (const slot of this.slots) {
        if (slot.status === 'active' && slot.autoEnabled && multiplier >= slot.autoTarget) {
          const r = this.cashOut(slot.index, slot.autoTarget);
          if (r) out.push(r);
        }
      }
      return out;
    },

    /** Round over: active bets are lost, everything is logged. */
    settle(round) {
      const lost = [];
      const st = this.data.stats;
      for (const slot of this.slots) {
        if (slot.status === 'active') { slot.status = 'lost'; lost.push(slot.index); }
        if (slot.status === 'lost' || slot.status === 'cashed') {
          st.rounds += 1; st.wagered += slot.stake;
          this.betHistory.unshift({ nonce: round.nonce, slot: slot.index + 1, stake: slot.stake, cashedAt: slot.cashedAt, payout: slot.payout, crashPoint: round.crashPoint });
        }
      }
      this.betHistory.length = Math.min(this.betHistory.length, 50);
      this.roundHistory.unshift({ crashPoint: round.crashPoint, seed: round.seed, hash: round.hash, nonce: round.nonce, clientSeed: round.clientSeed });
      this.roundHistory.length = Math.min(this.roundHistory.length, 40);
      this.data.recent = this.roundHistory.slice(0, 20).map((r) => r.crashPoint);
      this.persist();
      return { lost };
    },

    topUp() {
      if (this.balance >= CRASH_DISTRIBUTION.minBet * 10) return false;
      this.data.balance = round2(this.balance + CRASH_DISTRIBUTION.topUpAmount);
      this.persist();
      return true;
    },
  };

  /** Empirical check of the distribution (console helper). */
  function simulateDistribution(n) {
    let rtp = 0; const target = 2; let hits = 0;
    for (let i = 0; i < n; i++) {
      const cp = crashPointFromSeed(String(i), 'sim');
      if (cp >= target) { hits++; rtp += target; }
    }
    return { pAtLeast2: hits / n, expectedP: (1 - CRASH_DISTRIBUTION.houseEdge) / target, returnToPlayer: rtp / n };
  }

  AV.Economy = {
    CRASH_DISTRIBUTION, sha256, crashPointFromSeed, multiplierAt,
    makeRound, verifyRound, randomHex, tierFor, round2, Wallet, simulateDistribution,
  };
})(window.AV);
