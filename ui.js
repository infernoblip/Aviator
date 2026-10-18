/* ui.js — DOM side of the game: menus, cards, settings, HUD instruments,
 * minimap, objective markers, crash-round panel, free-flight panel, toasts.
 * Game logic stays in modes.js; this module only renders state and forwards clicks.
 */
window.AV = window.AV || {};
(function (AV) {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const el = (tag, cls, html) => { const e = document.createElement(tag); if (cls) e.className = cls; if (html !== undefined) e.innerHTML = html; return e; };
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmtMoney = (v) => Number(v).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const fmtMult = (m) => `${m.toFixed(2)}×`;
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const SCREENS = ['loading', 'menu', 'campaignSelect', 'hangar', 'settings', 'credits'];

  const UI = {
    current: null,

    init() {
      document.querySelectorAll('[data-goto]').forEach((b) => b.addEventListener('click', () => { AV.Audio.init(); AV.Audio.play('click'); AV.Game.goto(b.dataset.goto); }));
      document.querySelectorAll('[data-back]').forEach((b) => b.addEventListener('click', () => { AV.Audio.play('click'); AV.Game.back(); }));
      document.addEventListener('mouseover', (e) => { if (e.target.closest && e.target.closest('.btn') && AV.Audio.enabled && !e.target.closest('.btn').disabled) AV.Audio.play('hover'); });
      this.pause.init();
      this.crash.init();
      this.freeflight.init();
      this.hud.init();
      this.settings.init();
      $('photo-exit').addEventListener('click', () => AV.Input.trigger('photo'));
      $('photo-save').addEventListener('click', () => AV.Game.screenshot());
      $('confirm-no').addEventListener('click', () => $('confirm-modal').classList.add('hidden'));
    },

    /** Show one full-screen menu screen (or none). */
    showScreen(name) {
      this.current = name;
      for (const s of SCREENS) {
        const node = $('screen-' + s);
        if (node) node.classList.toggle('visible', s === name);
      }
      if (name === 'menu') this.renderMenu();
      if (name === 'campaignSelect') this.campaign.render();
      if (name === 'hangar') this.hangar.render();
      if (name === 'settings') this.settings.render();
    },

    setLoading(frac, text) {
      $('load-fill').style.width = `${Math.round(frac * 100)}%`;
      if (text) $('load-text').textContent = text;
    },

    renderMenu() {
      const C = AV.Campaign, d = AV.Save.data;
      $('menu-campaign-sub').textContent = `${C.totalStars()} / ${C.MISSIONS.length * 3} ★ earned`;
      $('menu-stats').innerHTML = `<span>Balance <b>${fmtMoney(d.wallet.balance)}</b></span><span>Coins <b>${d.campaign.coins}</b></span><span>Aircraft <b>${d.hangar.owned.length}/4</b></span>`;
      if (AV.Save.recovered) { this.toast('Your save file was damaged and has been reset.', 'warn', 6); AV.Save.recovered = false; }
      if (!AV.Save.storageOk) this.toast('Browser storage is unavailable — progress will not persist after closing.', 'warn', 6);
    },

    // --- toasts and banners -----------------------------------------------
    toast(msg, type, seconds) {
      const box = $('toasts');
      const t = el('div', `toast toast-${type || 'info'}`, esc(msg));
      box.appendChild(t);
      while (box.children.length > 4) box.firstChild.remove();
      setTimeout(() => { t.classList.add('out'); setTimeout(() => t.remove(), 400); }, (seconds || 2.4) * 1000);
    },
    banner(text, kind) {
      const b = $('banner');
      b.textContent = text;
      b.className = `show ${kind || ''}`;
      void b.offsetWidth;
      clearTimeout(this._bannerT);
      this._bannerT = setTimeout(() => { b.className = ''; }, 900);
    },
    fade(cb) {
      const f = $('fader');
      const reduced = AV.Save.data.settings.reducedMotion;
      f.classList.add('on');
      setTimeout(() => { cb(); requestAnimationFrame(() => f.classList.remove('on')); }, reduced ? 30 : 280);
    },
    confirm(title, text, onYes) {
      $('confirm-title').textContent = title; $('confirm-text').textContent = text;
      $('confirm-modal').classList.remove('hidden');
      $('confirm-yes').onclick = () => { $('confirm-modal').classList.add('hidden'); onYes(); };
    },

    hideCards() { $('card-briefing').classList.add('hidden'); $('card-result').classList.add('hidden'); },

    /** “Back to editor” button shown during Plane Builder test flights and Map Builder test play. */
    editorReturn(state, label) {
      const b = $('btn-back-editor');
      b.classList.toggle('hidden', !state);
      if (!state) return;
      b.textContent = `◀ Back to ${state === 'planeBuilder' ? 'Plane' : 'Map'} Builder${label ? ` — ${label}` : ''}`;
      b.onclick = () => { AV.Audio.play('click'); AV.Game.goto(state); };
    },

    photoMode(on) {
      $('photo-ui').classList.toggle('hidden', !on);
      this.hud.forceHidden = on;
      this.hud.show(this.hud.visible);
      $('ff-panel').classList.add('hidden');
      AV.Input.showTouch(!on);
    },

    // --- campaign select ---------------------------------------------------
    campaign: {
      chapter: 1,
      render() {
        const C = AV.Campaign;
        $('camp-stars').textContent = `★ ${C.totalStars()} / ${C.MISSIONS.length * 3}   ◉ ${AV.Save.data.campaign.coins} coins`;
        const tabs = $('chapter-tabs');
        tabs.innerHTML = '';
        for (const ch of C.CHAPTERS) {
          const unlocked = C.isChapterUnlocked(ch.id);
          const b = el('button', `tab ${this.chapter === ch.id ? 'active' : ''} ${unlocked ? '' : 'locked'}`,
            `<b>${ch.id}. ${esc(ch.name)}</b><small>${unlocked ? `${C.chapterStars(ch.id)} / ${C.missionsInChapter(ch.id).length * 3} ★` : `🔒 needs ${ch.requiredStars} ★ + previous chapter`}</small>`);
          b.setAttribute('role', 'tab');
          b.addEventListener('click', () => { this.chapter = ch.id; this.render(); AV.Audio.play('click'); });
          tabs.appendChild(b);
        }
        const chapter = C.CHAPTERS[this.chapter - 1];
        $('chapter-blurb').textContent = chapter.blurb;
        const grid = $('mission-grid');
        grid.innerHTML = '';
        C.missionsInChapter(this.chapter).forEach((m, i) => {
          const prog = C.progressOf(m.id), ok = C.isMissionUnlocked(m);
          const card = el('button', `mission-card ${ok ? '' : 'locked'} ${prog.completed ? 'done' : ''}`,
            `<div class="m-icon">${m.icon}</div><div class="m-num">${m.chapter}-${i + 1}</div><div class="m-name">${esc(m.name)}</div>
             <div class="m-type">${m.type}</div><div class="m-stars">${starsHtml(prog.stars)}</div>
             ${prog.bestTime ? `<div class="m-best">best ${C.fmtTime(prog.bestTime)}</div>` : ''}${ok ? '' : '<div class="m-lock">🔒</div>'}`);
          card.disabled = !ok;
          card.addEventListener('click', () => { AV.Audio.play('click'); AV.Game.goto('campaign', { mission: m }); });
          grid.appendChild(card);
        });
      },
    },

    showBriefing(m, onStart, onBack) {
      const C = AV.Campaign;
      $('brief-kicker').textContent = `Chapter ${m.chapter} · ${C.CHAPTERS[m.chapter - 1].name} · ${m.type.toUpperCase()}`;
      $('brief-title').textContent = m.name;
      $('brief-text').textContent = m.briefing;
      const st = C.starText(m);
      $('brief-stars').innerHTML = st.map((t, i) => `<div><span class="stars">${'★'.repeat(i + 1)}<span class="dim">${'★'.repeat(2 - i)}</span></span> ${esc(t)}</div>`).join('');
      const sel = $('brief-aircraft');
      sel.innerHTML = AV.Campaign.aircraftList().filter((a) => a.owned).map((a) => `<option value="${a.id}" ${a.id === AV.Save.data.hangar.selected ? 'selected' : ''}>${esc(a.name)}</option>`).join('');
      sel.onchange = () => { C.selectAircraft(sel.value); AV.Game.mode.restart(); };
      const prog = C.progressOf(m.id);
      $('brief-best').textContent = prog.completed ? `Best: ${starsText(prog.stars)}${prog.bestTime ? ' · ' + C.fmtTime(prog.bestTime) : ''}` : 'Not yet completed';
      $('card-briefing').classList.remove('hidden');
      this.hud.show(false);
      $('brief-start').onclick = () => { AV.Audio.init(); AV.Audio.play('click'); $('card-briefing').classList.add('hidden'); onStart(); };
      $('brief-back').onclick = () => { AV.Audio.play('click'); $('card-briefing').classList.add('hidden'); onBack(); };
      setTimeout(() => $('brief-start').focus(), 50);
    },

    showResult(m, r, rec, actions) {
      const C = AV.Campaign;
      $('result-kicker').textContent = `Chapter ${m.chapter} · ${m.name}`;
      $('result-title').textContent = r.success ? 'Mission complete' : 'Mission failed';
      $('result-title').className = r.success ? 'good' : 'bad';
      $('result-reason').textContent = r.success ? '' : (r.reason || '');
      const stars = $('result-stars');
      stars.innerHTML = [0, 1, 2].map((i) => `<span class="star ${i < rec.stars ? 'on' : ''}" style="animation-delay:${0.25 + i * 0.3}s">★</span>`).join('');
      for (let i = 0; i < rec.stars; i++) setTimeout(() => AV.Audio.play('star'), 300 + i * 300);
      const rows = [['Time', C.fmtTime(r.time) + (m.par ? `  (par ${C.fmtTime(m.par)})` : '')], ['Hull damage', `${Math.round(r.damage * 100)}%`]];
      if (m.type === 'coins') rows.push(['Coins collected', `${r.coins} / ${m.coins.count}`]);
      if (m.type === 'escort') rows.push(['Time in range', `${Math.round(r.inRange * 100)}%`]);
      if (m.type === 'landing' && r.landingError != null) rows.push(['Distance to target', `${r.landingError.toFixed(1)} m`], ['Sink rate', `${r.sink.toFixed(2)} m/s`]);
      if (r.success) rows.push(['Coins earned', `◉ ${rec.coins}`]);
      $('result-rows').innerHTML = rows.map(([a, b]) => `<div><span>${esc(a)}</span><b>${esc(b)}</b></div>`).join('');
      $('result-unlocks').innerHTML = (rec.unlocks || []).map((u) => `<div class="unlock">🔓 ${esc(u)}</div>`).join('');
      const list = C.MISSIONS, nx = list[list.indexOf(m) + 1];
      $('result-next').disabled = !(r.success && nx && C.isMissionUnlocked(nx));
      $('result-next').onclick = () => { $('card-result').classList.add('hidden'); actions.next(); };
      $('result-retry').onclick = () => { $('card-result').classList.add('hidden'); actions.retry(); };
      $('result-menu').onclick = () => { $('card-result').classList.add('hidden'); actions.menu(); };
      $('card-result').classList.remove('hidden');
      this.hud.show(false);
      setTimeout(() => (r.success && !$('result-next').disabled ? $('result-next') : $('result-retry')).focus(), 50);
    },

    // --- hangar ------------------------------------------------------------
    hangar: {
      viewId: null,
      render() {
        const C = AV.Campaign, d = AV.Save.data;
        if (!this.viewId) this.viewId = d.hangar.selected;
        $('hangar-coins').textContent = `◉ ${d.campaign.coins}`;
        const list = $('aircraft-list');
        list.innerHTML = '';
        for (const a of C.aircraftList()) {
          const sel = d.hangar.selected === a.id;
          const card = el('div', `aircraft-card ${this.viewId === a.id ? 'viewing' : ''} ${a.unlocked ? '' : 'locked'}`,
            `<div><b>${esc(a.name)}</b><small>${esc(a.role)}</small></div>`);
          const btn = el('button', 'btn btn-small');
          if (a.owned) { btn.textContent = sel ? (d.hangar.custom ? 'Campaign' : 'Selected') : 'Select'; if (sel && d.hangar.custom) btn.title = 'Used in the campaign; a custom design flies in crash mode and free flight'; btn.disabled = sel; btn.onclick = (e) => { e.stopPropagation(); C.selectAircraft(a.id); this.viewId = a.id; AV.Audio.play('click'); this.refresh(); }; }
          else if (a.unlocked) { btn.textContent = `Buy ◉ ${a.price}`; btn.disabled = d.campaign.coins < a.price; btn.onclick = (e) => { e.stopPropagation(); const r = C.buyAircraft(a.id); UI.toast(r.ok ? `${a.name} added to your hangar!` : r.error, r.ok ? 'good' : 'warn'); if (r.ok) { AV.Audio.play('cashout'); C.selectAircraft(a.id); this.viewId = a.id; } this.refresh(); }; }
          else { btn.textContent = '🔒'; btn.disabled = true; card.title = a.requirement; card.querySelector('small').textContent = `Locked — ${a.requirement}`; }
          card.appendChild(btn);
          card.addEventListener('click', () => { this.viewId = a.id; AV.Audio.play('click'); this.refresh(); });
          list.appendChild(card);
        }
        this.renderCustom(list);
        this.renderDetails();
      },
      /** Plane Builder designs: preview, fly in crash mode / free flight, edit. */
      renderCustom(list) {
        const C = AV.Creative, d = AV.Save.data;
        const head = el('div', 'custom-head', `<h4>Custom designs</h4><small class="muted">${C.designs().length}/${C.MAX_DESIGNS} · build them in the Plane Builder</small>`);
        list.appendChild(head);
        if (!C.designs().length) list.appendChild(el('p', 'muted small', 'No saved designs yet.'));
        for (const it of C.designs()) {
          const id = 'custom:' + it.id, flying = d.hangar.custom === it.id;
          const card = el('div', `aircraft-card ${this.viewId === id ? 'viewing' : ''}`,
            `${it.thumb ? `<img class="thumb" src="${it.thumb}" alt="">` : ''}<div><b>${esc(it.name)}</b><small>${flying ? '✈ Flying in crash & free flight' : `${it.data.parts.length} parts`}</small></div>`);
          const fly = el('button', 'btn btn-small', flying ? 'Selected' : 'Fly');
          fly.title = 'Use this design in crash mode and free flight';
          fly.onclick = (e) => { e.stopPropagation(); C.selectCustom(flying ? null : it.id); AV.Audio.play('click'); this.render(); };
          const edit = el('button', 'btn btn-small', 'Edit');
          edit.onclick = (e) => { e.stopPropagation(); AV.Game.goto('planeBuilder', { design: it.data, savedId: it.id }); };
          card.append(fly, edit);
          card.addEventListener('click', () => { this.viewId = id; AV.Audio.play('click'); this.refresh(); });
          list.appendChild(card);
        }
      },
      refresh() {
        // Preview the aircraft being viewed (only owned ones change the selection).
        if (AV.Game.mode && AV.Game.mode.preview) AV.Game.mode.preview(this.viewId);
        this.render();
      },
      renderDetails() {
        const C = AV.Campaign, d = AV.Save.data;
        const custom = this.viewId.startsWith('custom:') && AV.Creative.getDesign(this.viewId.slice(7));
        if (this.viewId.startsWith('custom:') && !custom) this.viewId = d.hangar.selected;
        const spec = custom ? AV.Physics.buildSpecFromDesign(AV.Parts.resolveDesign(custom.data), d.hangar.upgrades, custom.name) : AV.Physics.buildSpec(this.viewId, d.hangar.upgrades);
        $('hangar-name').textContent = custom ? custom.name : spec.name;
        $('hangar-role').textContent = custom ? 'Custom design from the Plane Builder' : spec.role;
        const top = AV.Physics.estimatePerformance(spec).maxSpeed || estimateTopSpeed(spec);
        const stats = [
          ['Top speed', `${Math.round(top * 3.6)} km/h`, top / 115],
          ['Stall speed', `${Math.round(spec.stallSpeed * 3.6)} km/h`, 1 - (spec.stallSpeed - 15) / 25],
          ['Roll rate', `${Math.round(rollRate(spec))}°/s`, rollRate(spec) / 200],
          ['Climb (thrust/weight)', `${(spec.thrustStatic / spec.weight).toFixed(2)}`, spec.thrustStatic / spec.weight / 0.65],
          ['Durability', `${spec.durability.toFixed(2)}×`, spec.durability / 2.6],
        ];
        $('hangar-stats').innerHTML = stats.map(([n, v, f]) => `<div class="stat"><span>${n}</span><div class="bar"><i style="width:${Math.round(clamp(f, 0.05, 1) * 100)}%"></i></div><b>${v}</b></div>`).join('') +
          `<div class="muted small">Gear: ${spec.retractableGear ? 'retractable' : 'fixed'} · Mass ${spec.mass} kg · Span ${spec.span} m</div>`;
        const paints = $('paint-list');
        paints.innerHTML = '';
        // Custom designs keep their part colours, so paint schemes only apply to stock aircraft.
        paints.classList.toggle('hidden', !!custom);
        paints.previousElementSibling.classList.toggle('hidden', !!custom);
        for (const p of C.paintList()) {
          const P = AV.Aircraft.PAINTS[p.id];
          const hex = (n) => '#' + n.toString(16).padStart(6, '0');
          const sw = el('button', `paint ${d.hangar.paint === p.id ? 'active' : ''} ${p.unlocked ? '' : 'locked'}`,
            `<i style="background:linear-gradient(135deg, ${hex(P.primary)} 0 50%, ${hex(P.secondary)} 50% 80%, ${hex(P.accent)} 80%)"></i><small>${esc(p.name)}${p.unlocked ? '' : ` · ${p.need}★`}</small>`);
          sw.disabled = !p.unlocked;
          sw.title = p.unlocked ? p.name : `Earn ${p.need} campaign stars`;
          sw.onclick = () => { C.selectPaint(p.id); AV.Audio.play('click'); this.refresh(); };
          paints.appendChild(sw);
        }
        const ups = $('upgrade-list');
        ups.innerHTML = '';
        for (const [k, info] of Object.entries(C.UPGRADE_INFO)) {
          const lvl = d.hangar.upgrades[k];
          const cost = C.UPGRADE_COSTS[lvl];
          const row = el('div', 'upgrade', `<div><b>${info.name}</b><small>${info.desc}</small></div><div class="pips">${[0, 1, 2].map((i) => `<i class="${i < lvl ? 'on' : ''}"></i>`).join('')}</div>`);
          const b = el('button', 'btn btn-small', cost ? `◉ ${cost}` : 'MAX');
          b.disabled = !cost || d.campaign.coins < cost;
          b.onclick = () => { const r = C.buyUpgrade(k); UI.toast(r.ok ? `${info.name} upgraded!` : r.error, r.ok ? 'good' : 'warn'); if (r.ok) AV.Audio.play('cashout'); this.refresh(); };
          row.appendChild(b);
          ups.appendChild(row);
        }
      },
    },

    // --- pause -------------------------------------------------------------
    pause: {
      init() {
        $('pause-resume').onclick = () => AV.Game.setPaused(false);
        $('pause-restart').onclick = () => { AV.Game.setPaused(false); AV.Game.mode.restart(); };
        $('pause-settings').onclick = () => { $('pause-menu').classList.add('hidden'); UI.settingsFromPause = true; UI.showScreen('settings'); };
        $('pause-quit').onclick = () => { const back = AV.Game.mode && AV.Game.mode.returnTo; AV.Game.setPaused(false); AV.Game.goto(back || 'menu'); };
      },
      /** Test flights quit back to the editor they came from. */
      label(returnTo) { $('pause-quit').textContent = returnTo ? 'Back to editor' : 'Quit to menu'; },
      show(on) {
        $('pause-menu').classList.toggle('hidden', !on);
        if (on) setTimeout(() => $('pause-resume').focus(), 30);
      },
    },

    // --- settings ----------------------------------------------------------
    settings: {
      tab: 'audio',
      SCHEMA: {
        audio: [
          { key: 'masterVolume', label: 'Master volume', type: 'range', min: 0, max: 1, step: 0.05 },
          { key: 'musicVolume', label: 'Music volume', type: 'range', min: 0, max: 1, step: 0.05 },
          { key: 'sfxVolume', label: 'Effects volume', type: 'range', min: 0, max: 1, step: 0.05 },
        ],
        controls: [
          { key: 'assist', label: 'Flight assist', type: 'select', options: [['off', 'Off — raw controls'], ['light', 'Light — auto-trim, coordination, stall guard'], ['heavy', 'Heavy — rate control, wing leveller, bank limit']] },
          { key: 'sensitivity', label: 'Control sensitivity', type: 'range', min: 0.3, max: 2.5, step: 0.05 },
          { key: 'invertPitch', label: 'Invert pitch', type: 'toggle' },
          { key: 'mouseFlight', label: 'Mouse yoke (cursor offset steers)', type: 'toggle' },
          { key: 'camera', label: 'Default camera', type: 'select', options: [['chase', 'Chase'], ['cockpit', 'Cockpit'], ['orbit', 'Orbit']] },
        ],
        graphics: [
          { key: 'quality', label: 'Graphics quality', type: 'select', options: [['low', 'Low — no shadows, short view'], ['medium', 'Medium'], ['high', 'High — shadows, long view, dense clouds']] },
          { key: 'showFps', label: 'Show FPS / frame time', type: 'toggle' },
        ],
        accessibility: [
          { key: 'uiScale', label: 'UI text scale', type: 'range', min: 0.8, max: 1.5, step: 0.05 },
          { key: 'reducedMotion', label: 'Reduced motion (no shake, speed lines or flashes)', type: 'toggle' },
          { key: 'highContrast', label: 'High-contrast HUD', type: 'toggle' },
        ],
      },
      init() {},
      render() {
        const tabs = $('settings-tabs');
        tabs.innerHTML = '';
        for (const t of ['audio', 'controls', 'keys', 'graphics', 'accessibility', 'data']) {
          const b = el('button', `tab ${t === this.tab ? 'active' : ''}`, `<b>${t[0].toUpperCase() + t.slice(1)}</b>`);
          b.onclick = () => { this.tab = t; this.render(); AV.Audio.play('click'); };
          tabs.appendChild(b);
        }
        const body = $('settings-body');
        body.innerHTML = '';
        if (this.SCHEMA[this.tab]) this.renderSchema(body, this.SCHEMA[this.tab]);
        else if (this.tab === 'keys') this.renderKeys(body);
        else this.renderData(body);
      },
      renderSchema(body, schema) {
        const s = AV.Save.data.settings;
        for (const f of schema) {
          const row = el('label', 'setting');
          row.appendChild(el('span', '', esc(f.label)));
          let input;
          if (f.type === 'range') {
            input = el('input'); input.type = 'range'; input.min = f.min; input.max = f.max; input.step = f.step; input.value = s[f.key];
            const out = el('output', '', Number(s[f.key]).toFixed(2));
            input.oninput = () => { s[f.key] = Number(input.value); out.textContent = Number(input.value).toFixed(2); AV.Game.applySettings(); };
            row.appendChild(input); row.appendChild(out);
          } else if (f.type === 'toggle') {
            input = el('input'); input.type = 'checkbox'; input.checked = !!s[f.key];
            input.onchange = () => { s[f.key] = input.checked; AV.Game.applySettings(); };
            row.appendChild(input);
          } else {
            input = el('select');
            input.innerHTML = f.options.map(([v, l]) => `<option value="${v}" ${s[f.key] === v ? 'selected' : ''}>${esc(l)}</option>`).join('');
            input.onchange = () => { s[f.key] = input.value; AV.Game.applySettings(); };
            row.appendChild(input);
          }
          body.appendChild(row);
        }
      },
      renderKeys(body) {
        const I = AV.Input;
        body.appendChild(el('p', 'muted', 'Click a binding, then press the new key (Esc cancels). Gamepad: left stick pitch/roll, right stick yaw, triggers throttle, A gear, B flaps, X brake, Y camera, LB/RB bet slots, Start pause.'));
        const grid = el('div', 'keys-grid');
        for (const [action, [label]] of Object.entries(I.ACTIONS)) {
          const row = el('div', 'key-row');
          row.appendChild(el('span', '', esc(label)));
          const b = el('button', 'btn btn-small key-btn', esc(I.keyName(I.bindings[action][0])));
          const alt = el('span', 'muted small', I.bindings[action][1] ? esc(I.keyName(I.bindings[action][1])) : '');
          b.onclick = () => {
            b.textContent = 'press a key…'; b.classList.add('listening');
            I.startRebind(action, (code) => { if (code) { AV.Game.applySettings(); UI.toast(`${label} → ${I.keyName(code)}`, 'good'); } this.render(); });
          };
          row.appendChild(b); row.appendChild(alt);
          grid.appendChild(row);
        }
        body.appendChild(grid);
        const reset = el('button', 'btn btn-small', 'Reset to defaults');
        reset.onclick = () => { I.resetBindings(); AV.Game.applySettings(); this.render(); };
        body.appendChild(reset);
      },
      renderData(body) {
        const S = AV.Save;
        body.appendChild(el('p', '', `Save format version <b>${S.VERSION}</b> · storage ${S.storageOk ? '<b class="good">available</b>' : '<b class="bad">unavailable (progress kept in memory only)</b>'}`));
        const test = el('button', 'btn btn-small', 'Run physics self-test');
        const out = el('pre', 'selftest');
        test.onclick = () => {
          const r = AV.Physics.selfTest();
          out.textContent = (r.passed ? 'ALL PASSED\n' : 'FAILURES\n') + r.results.map((x) => `${x.pass ? '✔' : '✘'} ${x.name}\n   ${x.detail}`).join('\n');
        };
        const reset = el('button', 'btn btn-small btn-danger', 'Reset all progress');
        reset.onclick = () => UI.confirm('Reset progress?', 'This erases campaign stars, coins, aircraft, upgrades and your play-money balance. Settings are kept.', () => {
          S.reset(); UI.toast('Progress reset', 'info'); this.render();
        });
        body.appendChild(test); body.appendChild(reset); body.appendChild(out);
      },
    },

    // --- HUD ---------------------------------------------------------------
    hud: {
      visible: false,
      forceHidden: false,
      userHidden: false,
      init() {
        this.root = $('hud');
        this.compass = $('hud-compass').getContext('2d');
        this.horizon = $('hud-horizon').getContext('2d');
        this.mapCanvas = $('hud-map');
        this.map = this.mapCanvas.getContext('2d');
        this.mapBuf = [document.createElement('canvas'), document.createElement('canvas')];
        for (const c of this.mapBuf) { c.width = c.height = 64; }
        this.mapState = { front: 0, row: 64, cx: 0, cz: 0, readyCx: 0, readyCz: 0, ready: false };
        this.mapRange = 2600;
        this.markerPool = [];
        this.els = { spd: $('hud-spd'), alt: $('hud-alt'), vs: $('hud-vs'), thr: $('hud-thr'), thrTxt: $('hud-thr-txt'), g: $('hud-g'), dmg: $('hud-dmg'),
          gear: $('flag-gear'), flaps: $('flag-flaps'), brake: $('flag-brake'), fuel: $('flag-fuel'), warn: $('hud-warn'), obj: $('hud-objectives'), title: $('hud-title'), markers: $('hud-markers') };
        this._v = new THREE.Vector3();
      },
      show(on) {
        this.visible = on;
        this.root.classList.toggle('hidden', !on || this.forceHidden || this.userHidden);
        // Touch flight controls only when the player is actually flying (not in the crash round).
        AV.Input.showTouch(on && !this.forceHidden && AV.Game.isPiloting());
      },
      setMode(mode) { this.root.dataset.mode = mode; },

      update(h, extra) {
        if (AV.Input.consume('hud')) { this.userHidden = !this.userHidden; this.show(this.visible); }
        if (!this.visible || this.forceHidden || this.userHidden) return;
        const e = this.els, x = extra || {};
        this.setMode(x.mode || 'free');
        e.spd.textContent = Math.round(h.airspeed * 3.6);
        e.alt.textContent = Math.round(h.altitude);
        e.vs.textContent = `VS ${h.vs >= 0 ? '+' : ''}${h.vs.toFixed(1)} · AGL ${Math.max(0, Math.round(h.agl))}`;
        e.thr.style.height = `${Math.round(h.throttle * 100)}%`;
        e.thrTxt.textContent = `${Math.round(h.throttle * 100)}%`;
        e.g.textContent = `${h.gLoad.toFixed(1)} G`;
        e.g.classList.toggle('warn', Math.abs(h.gLoad) > 4.5);
        e.dmg.style.width = `${Math.round(clamp(h.damage, 0, 1) * 100)}%`;
        e.gear.className = !h.retractable ? 'on fixed' : h.gearPos > 0.98 ? 'on' : h.gearPos > 0.02 ? 'moving' : '';
        e.gear.textContent = h.retractable ? 'GEAR' : 'FIXED';
        e.flaps.textContent = `FLAP ${Math.round(h.flaps * 100)}`;
        e.flaps.className = h.flaps > 0 ? 'on' : '';
        e.brake.className = h.brake ? 'on' : '';
        e.fuel.classList.toggle('hidden', h.fuel === null || h.fuel === undefined);
        if (h.fuel !== null && h.fuel !== undefined) { e.fuel.textContent = `FUEL ${Math.round(h.fuel * 100)}`; e.fuel.className = h.fuel <= 0 ? 'moving' : h.fuel < 0.15 ? 'moving' : 'on'; }
        let warn = '';
        if (!h.crashed && h.stall) warn = 'STALL';
        else if (h.fuel === 0 && !h.onGround && !h.crashed) warn = 'NO FUEL';
        else if (h.pullUp) warn = 'PULL UP';
        else if (h.damage > 0.6 && !h.crashed) warn = 'DAMAGE';
        if (e.warn.textContent !== warn) { e.warn.textContent = warn; e.warn.className = `hud-warn ${warn ? 'on' : ''}`; }
        e.title.textContent = x.title || '';
        if (x.objectives) e.obj.innerHTML = x.objectives.map((o) => `<div class="${o.done ? 'done' : ''} ${o.warn ? 'warn' : ''} ${o.dim ? 'dim' : ''}">${o.done ? '✔' : '•'} ${esc(o.text)}</div>`).join('');
        else e.obj.innerHTML = '';
        this.drawCompass(h.heading);
        this.drawHorizon(h.pitch, h.roll, h.airspeed > 10 ? h.aoa : null);
        this.drawMinimap(h, x.markers || []);
        this.drawMarkers(x.markers || [], h);
      },

      drawCompass(heading) {
        const c = this.compass, w = c.canvas.width, ht = c.canvas.height;
        c.clearRect(0, 0, w, ht);
        const deg = (heading * 180) / Math.PI;
        c.fillStyle = 'rgba(8,16,28,0.55)'; c.fillRect(0, 0, w, ht);
        c.strokeStyle = c.fillStyle = '#e8f4ff';
        c.font = 'bold 15px system-ui, sans-serif'; c.textAlign = 'center';
        const pxPerDeg = 3;
        for (let d = Math.floor(deg - 75); d <= deg + 75; d++) {
          if (d % 5) continue;
          const x = w / 2 + (d - deg) * pxPerDeg;
          const dd = ((d % 360) + 360) % 360;
          const major = dd % 30 === 0;
          c.globalAlpha = 1 - Math.abs(x - w / 2) / (w / 2) * 0.7;
          c.fillRect(x - 1, 0, 2, major ? 14 : 7);
          if (major) {
            const lbl = { 0: 'N', 90: 'E', 180: 'S', 270: 'W' }[dd] || String(dd / 10);
            c.fillStyle = 'NESW'.includes(lbl) ? '#ffd24a' : '#e8f4ff';
            c.fillText(lbl, x, 32);
            c.fillStyle = '#e8f4ff';
          }
        }
        c.globalAlpha = 1;
        c.fillStyle = '#35e0ff';
        c.beginPath(); c.moveTo(w / 2 - 7, ht); c.lineTo(w / 2 + 7, ht); c.lineTo(w / 2, ht - 9); c.fill();
        c.font = 'bold 12px system-ui'; c.fillText(String(Math.round(deg) % 360).padStart(3, '0'), w / 2, 42 - 30);
      },

      drawHorizon(pitch, roll, aoa) {
        const c = this.horizon, w = c.canvas.width, r = w / 2;
        c.save();
        c.clearRect(0, 0, w, w);
        c.beginPath(); c.arc(r, r, r - 2, 0, Math.PI * 2); c.clip();
        c.translate(r, r);
        c.rotate(-roll);
        const pxPerRad = r * 2.2;
        const off = pitch * pxPerRad;
        c.fillStyle = '#3d8bd8'; c.fillRect(-w, -w * 2 + off, w * 2, w * 2);
        c.fillStyle = '#8a5a2b'; c.fillRect(-w, off, w * 2, w * 2);
        c.strokeStyle = '#fff'; c.lineWidth = 2;
        c.beginPath(); c.moveTo(-w, off); c.lineTo(w, off); c.stroke();
        c.font = '11px system-ui'; c.fillStyle = '#fff'; c.textAlign = 'left';
        for (let d = -60; d <= 60; d += 10) {
          if (!d) continue;
          const y = off - (d * Math.PI / 180) * pxPerRad;
          if (Math.abs(y) > r) continue;
          const lw = d % 20 === 0 ? 34 : 18;
          c.beginPath(); c.moveTo(-lw, y); c.lineTo(lw, y); c.stroke();
          if (d % 20 === 0) c.fillText(String(d), lw + 4, y + 4);
        }
        c.restore();
        // Bank arc + pointer
        c.save(); c.translate(r, r);
        c.strokeStyle = '#fff'; c.lineWidth = 2;
        c.beginPath(); c.arc(0, 0, r - 12, -Math.PI * 5 / 6, -Math.PI / 6); c.stroke();
        for (const a of [-60, -45, -30, -20, -10, 0, 10, 20, 30, 45, 60]) {
          const ang = (a - 90) * Math.PI / 180, l = a % 30 === 0 ? 10 : 5;
          c.beginPath(); c.moveTo(Math.cos(ang) * (r - 12), Math.sin(ang) * (r - 12)); c.lineTo(Math.cos(ang) * (r - 12 - l), Math.sin(ang) * (r - 12 - l)); c.stroke();
        }
        c.rotate(-roll);
        c.fillStyle = '#ffd24a';
        c.beginPath(); c.moveTo(0, -(r - 14)); c.lineTo(-7, -(r - 26)); c.lineTo(7, -(r - 26)); c.fill();
        c.restore();
        // Fixed aircraft symbol
        c.strokeStyle = '#ffd24a'; c.lineWidth = 4;
        c.beginPath(); c.moveTo(r - 44, r); c.lineTo(r - 14, r); c.lineTo(r - 6, r + 8); c.moveTo(r + 44, r); c.lineTo(r + 14, r); c.lineTo(r + 6, r + 8); c.stroke();
        c.fillStyle = '#ffd24a'; c.fillRect(r - 3, r - 3, 6, 6);
        c.lineWidth = 3; c.strokeStyle = 'rgba(255,255,255,0.8)'; c.beginPath(); c.arc(r, r, r - 2, 0, Math.PI * 2); c.stroke();
        // AoA readout
        c.fillStyle = '#fff'; c.font = 'bold 11px system-ui'; c.textAlign = 'center';
        c.fillText(aoa === null ? 'AoA —' : `AoA ${(aoa * 180 / Math.PI).toFixed(0)}°`, r, w - 18);
      },

      /** Minimap terrain is rendered progressively (8 rows per frame) into a back buffer, then swapped. */
      drawMinimap(h, markers) {
        const ms = this.mapState, N = 64, range = this.mapRange;
        const world = AV.Game.world;
        if (ms.row >= N) {
          if (ms.started) { ms.front = 1 - ms.front; ms.readyCx = ms.cx; ms.readyCz = ms.cz; ms.ready = true; }
          if (!ms.ready || Math.hypot(h.x - ms.readyCx, h.z - ms.readyCz) > range * 0.12) {
            ms.cx = h.x; ms.cz = h.z; ms.row = 0; ms.started = true;
            ms.img = this.mapBuf[1 - ms.front].getContext('2d').createImageData(N, N);
          } else ms.started = false;
        }
        if (ms.row < N) {
          const img = ms.img;
          for (let k = 0; k < 8 && ms.row < N; k++, ms.row++) {
            const j = ms.row;
            for (let i = 0; i < N; i++) {
              const x = ms.cx + ((i + 0.5) / N - 0.5) * range * 2, z = ms.cz + ((j + 0.5) / N - 0.5) * range * 2;
              const col = world.mapColor(x, z);
              const o = (j * N + i) * 4;
              img.data[o] = col[0]; img.data[o + 1] = col[1]; img.data[o + 2] = col[2]; img.data[o + 3] = 255;
            }
          }
          if (ms.row >= N) this.mapBuf[1 - ms.front].getContext('2d').putImageData(img, 0, 0);
        }
        const c = this.map, W = this.mapCanvas.width;
        const scale = W / (range * 1.6);   // canvas shows 1.6 × range across
        c.save();
        c.clearRect(0, 0, W, W);
        c.beginPath(); c.arc(W / 2, W / 2, W / 2 - 2, 0, Math.PI * 2); c.clip();
        c.fillStyle = '#123'; c.fillRect(0, 0, W, W);
        if (ms.ready) {
          const sz = range * 2 * scale;
          c.imageSmoothingEnabled = true;
          c.drawImage(this.mapBuf[ms.front], W / 2 + (ms.readyCx - range - h.x) * scale, W / 2 + (ms.readyCz - range - h.z) * scale, sz, sz);
        }
        const toMap = (x, z) => [W / 2 + (x - h.x) * scale, W / 2 + (z - h.z) * scale];
        // Airfields
        for (const a of AV.Terrain.AIRFIELDS) {
          const [mx, my] = toMap(a.x, a.z);
          c.save(); c.translate(mx, my); c.rotate(a.heading * Math.PI / 180);
          c.fillStyle = '#ddd'; c.fillRect(-2, -a.length * scale / 2, 4, a.length * scale); c.restore();
        }
        const colors = { next: '#35e0ff', upcoming: '#ffb020', coin: '#ffd24a', drone: '#40ff90', boss: '#ff3060', mine: '#ff40ff' };
        for (const m of markers) {
          let [mx, my] = toMap(m.pos.x, m.pos.z);
          const dx = mx - W / 2, dy = my - W / 2, d = Math.hypot(dx, dy), lim = W / 2 - 8;
          if (d > lim) { mx = W / 2 + dx / d * lim; my = W / 2 + dy / d * lim; }
          c.fillStyle = colors[m.kind] || '#fff';
          c.beginPath(); c.arc(mx, my, m.kind === 'coin' || m.kind === 'mine' ? 2.5 : 4.5, 0, Math.PI * 2); c.fill();
        }
        // Player arrow (north-up map)
        c.translate(W / 2, W / 2); c.rotate(h.heading);
        c.fillStyle = '#fff'; c.strokeStyle = '#000'; c.lineWidth = 1.5;
        c.beginPath(); c.moveTo(0, -9); c.lineTo(6, 7); c.lineTo(0, 3); c.lineTo(-6, 7); c.closePath(); c.fill(); c.stroke();
        c.restore();
        c.strokeStyle = 'rgba(255,255,255,0.7)'; c.lineWidth = 2; c.beginPath(); c.arc(W / 2, W / 2, W / 2 - 2, 0, Math.PI * 2); c.stroke();
        c.fillStyle = '#ffd24a'; c.font = 'bold 12px system-ui'; c.textAlign = 'center'; c.fillText('N', W / 2, 14);
      },

      /** On-screen target markers with edge arrows when off-screen. */
      drawMarkers(markers, h) {
        const cam = AV.Game.camera, root = this.els.markers;
        const W = window.innerWidth, H = window.innerHeight;
        const list = markers.filter((m) => !m.mapOnly);
        while (this.markerPool.length < list.length) { const d = el('div', 'marker'); root.appendChild(d); this.markerPool.push(d); }
        this.markerPool.forEach((d, i) => {
          const m = list[i];
          if (!m) { d.style.display = 'none'; return; }
          d.style.display = '';
          const v = this._v.copy(m.pos).project(cam);
          const behind = v.z > 1;
          let x = (v.x * 0.5 + 0.5) * W, y = (-v.y * 0.5 + 0.5) * H;
          if (behind) { x = W - x; y = H - y; }
          const margin = 40;
          const off = behind || x < margin || x > W - margin || y < margin || y > H - margin;
          if (off) {
            const cx = W / 2, cy = H / 2, dx = x - cx, dy = y - cy;
            const s = Math.min((W / 2 - margin) / Math.abs(dx || 1), (H / 2 - margin) / Math.abs(dy || 1));
            x = cx + dx * s; y = cy + dy * s;
            d.style.setProperty('--rot', `${Math.atan2(dy, dx)}rad`);
          }
          const dist = Math.hypot(m.pos.x - h.x, m.pos.z - h.z);
          d.className = `marker m-${m.kind} ${off ? 'edge' : ''}`;
          d.style.transform = `translate(${x}px, ${y}px)`;
          const label = `${m.label || ''} <small>${dist > 1000 ? (dist / 1000).toFixed(1) + ' km' : Math.round(dist) + ' m'}</small>`;
          if (d._label !== label) { d.innerHTML = `<i></i><span>${label}</span>`; d._label = label; }
        });
      },
    },

    // --- crash round panel -------------------------------------------------
    crash: {
      init() {
        this.root = $('crash-ui');
        this.slots = [...document.querySelectorAll('.bet-slot')].map((node, i) => this.buildSlot(node, i));
        $('btn-verify').onclick = () => this.openVerify();
        $('verify-close').onclick = () => $('verify-modal').classList.add('hidden');
        $('btn-topup').onclick = () => { if (AV.Economy.Wallet.topUp()) { UI.toast('Added play money', 'good'); AV.Audio.play('coin'); } };
        $('verify-check').onclick = () => this.verifySeed($('verify-seed').value.trim());
        $('verify-client-save').onclick = () => { AV.Economy.Wallet.setClientSeed($('verify-client').value.trim()); UI.toast('Client seed saved — applies from the next round', 'info'); };
        $('verify-rotate').onclick = () => { AV.Economy.Wallet.rotateMasterSeed(); UI.toast('New master seed generated', 'info'); this.renderVerify(); };
        AV.Economy.Wallet.onChange(() => { if (!this.root.classList.contains('hidden')) this.refreshSlots(this.phaseName, this.mult || 1); });
      },
      buildSlot(node, i) {
        node.innerHTML = `
          <div class="slot-head">Bet ${i + 1}<span class="slot-state"></span></div>
          <div class="slot-amount">
            <button class="btn btn-tiny" data-a="half">½</button>
            <button class="btn btn-tiny" data-a="minus">−</button>
            <input type="number" min="1" step="1" inputmode="decimal" aria-label="Bet ${i + 1} amount">
            <button class="btn btn-tiny" data-a="plus">+</button>
            <button class="btn btn-tiny" data-a="double">2×</button>
          </div>
          <div class="slot-quick">${[10, 50, 100, 500].map((v) => `<button class="btn btn-tiny" data-q="${v}">${v}</button>`).join('')}</div>
          <label class="slot-auto"><input type="checkbox"> Auto cash-out at <input type="number" min="1.01" step="0.01" class="auto-target">×</label>
          <button class="btn btn-bet"></button>`;
        const W = AV.Economy.Wallet, slot = W.slots[i];
        const amount = node.querySelector('.slot-amount input');
        amount.value = slot.amount;
        const setAmt = (v) => { slot.amount = Math.max(1, Math.round(v * 100) / 100); amount.value = slot.amount; };
        node.querySelectorAll('[data-a]').forEach((b) => b.onclick = () => {
          const a = b.dataset.a, v = Number(amount.value) || 1;
          setAmt(a === 'half' ? v / 2 : a === 'double' ? v * 2 : a === 'plus' ? v + 5 : v - 5);
          AV.Audio.play('click');
        });
        node.querySelectorAll('[data-q]').forEach((b) => b.onclick = () => { setAmt(Number(b.dataset.q)); AV.Audio.play('click'); });
        amount.onchange = () => setAmt(Number(amount.value) || 1);
        const auto = node.querySelector('.slot-auto input[type=checkbox]');
        const target = node.querySelector('.auto-target');
        auto.checked = slot.autoEnabled; target.value = slot.autoTarget.toFixed(2);
        auto.onchange = () => { slot.autoEnabled = auto.checked; };
        target.onchange = () => { slot.autoTarget = Math.max(1.01, Math.round((Number(target.value) || 2) * 100) / 100); target.value = slot.autoTarget.toFixed(2); };
        const btn = node.querySelector('.btn-bet');
        btn.onclick = () => { AV.Audio.init(); if (AV.Game.mode && AV.Game.mode.handleSlot) AV.Game.mode.handleSlot(i); };
        return { node, amount, btn, state: node.querySelector('.slot-state'), auto, target };
      },
      slotAmount(i) { return Number(this.slots[i].amount.value) || 1; },
      show(on) {
        this.root.classList.toggle('hidden', !on);
        if (on) { this.renderHistory(); this.refreshSlots('betting', 1); }
      },
      phase(name, data) {
        this.phaseName = name;
        this.round = data.round;
        const status = $('crash-status'), mult = $('crash-mult');
        mult.classList.remove('crashed', 'flyaway', 'flying');
        if (name === 'betting') {
          mult.textContent = '1.00×';
          $('crash-hash').innerHTML = `Round #${data.round.nonce} · hash <code>${data.round.hash.slice(0, 16)}…</code>`;
          status.textContent = 'Place your bets';
        } else if (name === 'flying') {
          mult.classList.add('flying');
          status.textContent = 'Cash out before it flies away!';
        } else if (name === 'crashed') {
          mult.classList.add(data.outcome === 'flyaway' ? 'flyaway' : 'crashed');
          mult.textContent = fmtMult(data.round.crashPoint);
          status.textContent = data.outcome === 'flyaway' ? `FLEW AWAY @ ${fmtMult(data.round.crashPoint)}` : `CRASHED @ ${fmtMult(data.round.crashPoint)}`;
          $('crash-hash').innerHTML = `Round #${data.round.nonce} · seed <code title="${data.round.seed}">${data.round.seed.slice(0, 16)}…</code> · hash <code title="${data.round.hash}">${data.round.hash.slice(0, 10)}…</code>`;
          this.renderHistory();
          if (data.lost && data.lost.length) UI.toast(`Lost bet ${data.lost.map((i) => i + 1).join(' & ')}`, 'danger');
        }
        this.refreshSlots(name, 1);
      },
      update(phase, mult, timer, cfg) {
        this.mult = mult;
        const m = $('crash-mult');
        if (phase === 'flying') {
          m.textContent = fmtMult(mult);
          m.dataset.tier = AV.Economy.tierFor(mult);
          this.refreshSlots(phase, mult);
        }
        const fill = $('crash-timer-fill');
        if (phase === 'betting') { fill.style.width = `${(timer / cfg.bettingSeconds) * 100}%`; $('crash-status').textContent = `Place your bets — takeoff in ${timer.toFixed(1)} s`; }
        else if (phase === 'crashed') { fill.style.width = `${(timer / cfg.cooldownSeconds) * 100}%`; if (timer < cfg.cooldownSeconds - 1.2) $('crash-status').textContent = `Waiting for next round… ${timer.toFixed(1)} s`; }
        else fill.style.width = '0%';
        $('crash-balance').textContent = fmtMoney(AV.Economy.Wallet.balance);
        $('btn-topup').classList.toggle('hidden', AV.Economy.Wallet.balance >= AV.Economy.CRASH_DISTRIBUTION.minBet * 10);
      },
      refreshSlots(phase, mult) {
        const W = AV.Economy.Wallet;
        this.slots.forEach((u, i) => {
          const s = W.slots[i];
          let label, cls, state = '';
          if (s.queued) { label = 'Cancel (next round)'; cls = 'queued'; state = 'queued'; }
          else if (s.status === 'active' && phase === 'flying') { label = `CASH OUT ${fmtMoney(s.stake * mult)}`; cls = 'cashout'; state = `in play · ${fmtMoney(s.stake)}`; }
          else if (s.status === 'active') { label = `Cancel ${fmtMoney(s.stake)}`; cls = 'cancel'; state = 'placed'; }
          else {
            label = `BET ${fmtMoney(Number(u.amount.value) || 0)}`; cls = 'bet';
            if (s.status === 'cashed') state = `won ${fmtMoney(s.payout)} @ ${fmtMult(s.cashedAt)}`;
            else if (s.status === 'lost') state = `lost ${fmtMoney(s.stake)}`;
            if (phase !== 'betting') label = `BET ${fmtMoney(Number(u.amount.value) || 0)} (next round)`;
          }
          if (u.btn.textContent !== label) u.btn.textContent = label;
          u.btn.className = `btn btn-bet ${cls}`;
          u.state.textContent = state;
          u.state.className = `slot-state ${s.status}`;
          const locked = s.status === 'active' || s.queued;
          u.amount.disabled = locked;
        });
      },
      cashedOut(r) {
        UI.toast(`Cashed out ${fmtMoney(r.payout)} @ ${fmtMult(r.multiplier)}`, 'good');
        const m = $('crash-mult');
        m.classList.remove('pop'); void m.offsetWidth; m.classList.add('pop');
        this.refreshSlots('flying', r.multiplier);
      },
      renderHistory() {
        const h = $('crash-history');
        const list = AV.Economy.Wallet.roundHistory.length ? AV.Economy.Wallet.roundHistory.map((r) => r.crashPoint) : AV.Save.data.wallet.recent;
        h.innerHTML = list.slice(0, 18).map((cp) => `<span class="chip ${AV.Economy.tierFor(cp)}">${cp.toFixed(2)}×</span>`).join('');
      },
      openVerify() {
        AV.Audio.play('click');
        $('verify-client').value = AV.Save.data.wallet.clientSeed;
        $('verify-out').textContent = '';
        this.renderVerify();
        $('verify-modal').classList.remove('hidden');
      },
      renderVerify() {
        const W = AV.Economy.Wallet;
        const cur = this.round && this.phaseName !== 'crashed' ? `<div class="v-current">Current round #${this.round.nonce} hash (commitment): <code>${this.round.hash}</code></div>` : '';
        $('verify-table').innerHTML = cur + (W.roundHistory.length ? `<table><thead><tr><th>#</th><th>Crash</th><th>Seed (revealed)</th><th>Hash</th><th></th></tr></thead><tbody>` +
          W.roundHistory.slice(0, 12).map((r, i) => `<tr><td>${r.nonce}</td><td class="${AV.Economy.tierFor(r.crashPoint)}">${r.crashPoint.toFixed(2)}×</td><td><code>${r.seed.slice(0, 20)}…</code></td><td><code>${r.hash.slice(0, 12)}…</code></td><td><button class="btn btn-tiny" data-v="${i}">Verify</button></td></tr>`).join('') +
          '</tbody></table>' : '<p class="muted">No finished rounds yet this session.</p>');
        $('verify-table').querySelectorAll('[data-v]').forEach((b) => b.onclick = () => {
          const r = W.roundHistory[Number(b.dataset.v)];
          $('verify-seed').value = r.seed;
          this.verifySeed(r.seed, r);
        });
      },
      verifySeed(seed, expected) {
        if (!seed) return;
        const W = AV.Economy.Wallet;
        const known = expected || W.roundHistory.find((r) => r.seed === seed);
        const client = known ? known.clientSeed : AV.Save.data.wallet.clientSeed;
        const v = AV.Economy.verifyRound(seed, client);
        const ok = known ? v.hash === known.hash && v.crashPoint === known.crashPoint : null;
        $('verify-out').innerHTML = `SHA-256(seed) = <code>${v.hash}</code><br>Crash point with client seed “${esc(client)}” = <b>${v.crashPoint.toFixed(2)}×</b>` +
          (ok === null ? '' : ok ? ' <b class="good">✔ matches the recorded round</b>' : ' <b class="bad">✘ mismatch</b>');
      },
    },

    // --- free-flight panel -------------------------------------------------
    freeflight: {
      init() {
        const w = () => AV.Game.world;
        $('ff-close').onclick = () => this.toggle(false);
        $('ff-weather').onchange = (e) => { w().setWeather(e.target.value); };
        $('ff-time').oninput = (e) => { w().setTimeOfDay(Number(e.target.value)); this.sync(); };
        $('ff-timespeed').onchange = (e) => { w().timeSpeed = Number(e.target.value); };
        $('ff-wind').oninput = (e) => { w().setWind(Number(e.target.value), w().windDir); this.sync(); };
        $('ff-winddir').oninput = (e) => { w().setWind(w().windSpeed, Number(e.target.value)); this.sync(); };
        $('ff-runway').onclick = () => { if (this.mode) this.mode.restart(); this.toggle(false); };
        $('ff-photo').onclick = () => { this.toggle(false); AV.Input.trigger('photo'); };
        $('ff-map').addEventListener('click', (e) => this.mapClick(e));
      },
      show(on, mode) {
        this.mode = on ? mode : null;
        if (!on) $('ff-panel').classList.add('hidden');
      },
      toggle(force) {
        const p = $('ff-panel');
        const open = force === undefined ? p.classList.contains('hidden') : force;
        p.classList.toggle('hidden', !open);
        if (open) { this.sync(); this.renderMap(); this.renderLandmarks(); this.renderCustomMaps(); }
      },
      /** Saved Map Builder maps can be flown from here; “Main world” returns to the terrain. */
      renderCustomMaps() {
        const box = $('ff-maps');
        box.innerHTML = '';
        const inMap = !!(this.mode && this.mode.map);
        $('ff-map').classList.toggle('hidden', inMap);
        $('ff-landmarks').classList.toggle('hidden', inMap);
        $('ff-map-title').textContent = inMap ? `Flying custom map “${this.mode.map.name}”` : 'Map — click a landmark to fly there';
        if (inMap) {
          const b = el('button', 'btn btn-tiny', '⟵ Main world');
          b.onclick = () => AV.Game.goto('freeflight', {});
          box.appendChild(b);
        }
        const maps = AV.Creative.maps();
        if (!maps.length) box.appendChild(el('span', 'muted small', 'No custom maps yet — build one in the Map Builder.'));
        for (const m of maps) {
          const b = el('button', 'btn btn-tiny', esc(m.name));
          b.title = `${m.data.shapes.length} shapes`;
          b.onclick = () => AV.Game.goto('freeflight', { map: m.data, label: m.name });
          box.appendChild(b);
        }
      },
      sync() {
        const w = AV.Game.world;
        $('ff-weather').value = w.weatherName;
        $('ff-time').value = w.hour.toFixed(1);
        $('ff-time-out').textContent = `${String(Math.floor(w.hour)).padStart(2, '0')}:${String(Math.floor((w.hour % 1) * 60)).padStart(2, '0')}`;
        $('ff-wind').value = w.windSpeed; $('ff-wind-out').textContent = `${w.windSpeed} m/s`;
        $('ff-winddir').value = w.windDir; $('ff-winddir-out').textContent = `${w.windDir}°`;
        const opts = [...$('ff-timespeed').options].map((o) => Number(o.value));
        let best = opts[0];
        for (const o of opts) if (Math.abs(o - w.timeSpeed) < Math.abs(best - w.timeSpeed)) best = o;
        $('ff-timespeed').value = String(best);
      },
      MAP_RANGE: 8500,
      renderMap() {
        const c = $('ff-map'), ctx = c.getContext('2d'), N = 96, R = this.MAP_RANGE;
        if (!this.mapImage) {
          const img = ctx.createImageData(N, N);
          for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
            const col = AV.Game.world.mapColor(((i + 0.5) / N - 0.5) * 2 * R, ((j + 0.5) / N - 0.5) * 2 * R);
            const o = (j * N + i) * 4; img.data[o] = col[0]; img.data[o + 1] = col[1]; img.data[o + 2] = col[2]; img.data[o + 3] = 255;
          }
          const buf = document.createElement('canvas'); buf.width = buf.height = N; buf.getContext('2d').putImageData(img, 0, 0);
          this.mapImage = buf;
        }
        ctx.imageSmoothingEnabled = true;
        ctx.drawImage(this.mapImage, 0, 0, c.width, c.height);
        const toMap = (x, z) => [(x / R / 2 + 0.5) * c.width, (z / R / 2 + 0.5) * c.height];
        ctx.font = 'bold 11px system-ui'; ctx.textAlign = 'center';
        for (const L of AV.Terrain.LANDMARKS) {
          const [x, y] = toMap(L.x, L.z);
          ctx.fillStyle = L.kind === 'airfield' ? '#fff' : '#ffd24a';
          ctx.beginPath(); ctx.arc(x, y, 5, 0, Math.PI * 2); ctx.fill();
          ctx.strokeStyle = '#000'; ctx.stroke();
          ctx.fillStyle = '#fff'; ctx.strokeStyle = 'rgba(0,0,0,0.7)'; ctx.lineWidth = 3;
          ctx.strokeText(L.name, x, y - 9); ctx.fillText(L.name, x, y - 9); ctx.lineWidth = 1;
        }
        const s = this.mode && this.mode.session;
        if (s) {
          const [x, y] = toMap(s.state.pos.x, s.state.pos.z);
          ctx.save(); ctx.translate(x, y); ctx.rotate(s.tel.heading || 0);
          ctx.fillStyle = '#35e0ff'; ctx.beginPath(); ctx.moveTo(0, -8); ctx.lineTo(6, 6); ctx.lineTo(-6, 6); ctx.fill(); ctx.restore();
        }
      },
      renderLandmarks() {
        const box = $('ff-landmarks');
        box.innerHTML = '';
        for (const L of AV.Terrain.LANDMARKS) {
          const b = el('button', 'btn btn-tiny', esc(L.name));
          b.onclick = () => { if (this.mode) this.mode.teleport(L); this.toggle(false); };
          box.appendChild(b);
        }
      },
      mapClick(e) {
        const c = $('ff-map'), r = c.getBoundingClientRect(), R = this.MAP_RANGE;
        const x = ((e.clientX - r.left) / r.width - 0.5) * 2 * R, z = ((e.clientY - r.top) / r.height - 0.5) * 2 * R;
        let best = null, bd = Infinity;
        for (const L of AV.Terrain.LANDMARKS) { const d = Math.hypot(L.x - x, L.z - z); if (d < bd) { bd = d; best = L; } }
        if (best && bd < R * 0.12 && this.mode) { this.mode.teleport(best); this.toggle(false); }
      },
    },
  };

  function starsHtml(n) { return `<span class="stars">${'★'.repeat(n)}<span class="dim">${'★'.repeat(3 - n)}</span></span>`; }
  function starsText(n) { return '★'.repeat(n) + '☆'.repeat(3 - n); }

  /** Top speed estimate (thrust = drag) for the hangar stat bars. */
  function estimateTopSpeed(spec) {
    let best = spec.stallSpeed;
    for (let v = spec.stallSpeed; v < 200; v += 1) {
      const q = 0.5 * 1.225 * v * v, CL = spec.weight / (q * spec.wingArea);
      const D = q * spec.wingArea * (spec.CD0 + spec.gearCD * (spec.retractableGear ? 0 : 1) + spec.inducedK * CL * CL);
      const Tq = spec.thrustStatic * Math.max(0, 1 - v / spec.propSpeed);
      if (Tq >= D) best = v; else break;
    }
    return best;
  }
  /** Steady roll rate p = (2V/b)·Clδa/|Clp| at cruise, in deg/s. */
  function rollRate(spec) { return (2 * spec.cruiseSpeed / spec.span) * (spec.Clda / Math.abs(spec.Clp)) * 57.3; }

  AV.UI = UI;
})(window.AV);
