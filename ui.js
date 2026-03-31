// ─── UI Module ────────────────────────────────────────────────────────────────

const UI = {
  isAdmin:      false,
  currentUser:  '',
  userMode:     'hanger',   // 'hanger' or 'doorknock' — set at login for non-admins
  turfFilter:   null,
  resultFilter: null,
  modeFilter:   null,       // null = all, 'hanger', 'doorknock'
  sessionId:    localStorage.getItem('ck_sess') || ('s_' + Math.random().toString(36).slice(2) + Date.now().toString(36)),
  _expandedTurfs: new Set(),

  init() {
    localStorage.setItem('ck_sess', this.sessionId);
    this._buildShell();

    // Login persistence — skip modal if already logged in
    const saved = this._loadSavedLogin();
    if (saved) {
      this.currentUser = saved.name;
      this.isAdmin     = saved.isAdmin;
      this.userMode    = saved.userMode || 'hanger';
      this._postLogin();
    } else {
      this._showLoginModal();
    }
  },

  // ── Login persistence ─────────────────────────────────────────────────────
  _saveLogin(name, isAdmin, userMode) {
    localStorage.setItem('ck_user', JSON.stringify({ name, isAdmin, userMode: userMode || 'hanger' }));
  },
  _loadSavedLogin() {
    try { return JSON.parse(localStorage.getItem('ck_user') || 'null'); } catch(e) { return null; }
  },
  _clearLogin() {
    localStorage.removeItem('ck_user');
    location.reload();
  },

  _buildShell() {
    document.getElementById('header').innerHTML = `
      <div class="header-row1">
        <div class="header-left">
          <div class="header-logo">🚂</div>
          <div>
            <div class="header-title">${CONFIG.APP_NAME}</div>
            <div class="header-sub">${CONFIG.CANDIDATE} · ${CONFIG.RACE} · <span class="header-credit">by Brent Billington · v4.6</span></div>
          </div>
        </div>
        <div class="header-right" id="header-controls">
          <div id="presence-bar" class="presence-bar"></div>
          <button class="hdr-btn" id="chat-btn" onclick="UI.toggleChat()" title="Team Chat">💬 <span id="chat-unread" class="chat-unread" style="display:none"></span></button>
          <button class="hdr-btn" id="map-toggle-btn" onclick="UI.toggleMap()" title="Show/hide map">🗺 Map</button>
          <button class="hdr-btn" id="loc-btn" onclick="MapModule.toggleMyLocation()" title="My Location"><span class="crosshair-icon"></span></button>
          <button class="hdr-btn" id="lock-btn" onclick="UI.promptAdminUnlock()" title="Admin login" style="display:none">🔒</button>
        </div>
      </div>
      <div class="header-row2" id="header-row2">
        <div id="stats-bar" class="stats-bar"></div>
        <div id="sync-indicator" class="sync-indicator"></div>
      </div>`;

    document.getElementById('offline-banner').textContent = '⚠ Offline — results will sync when reconnected';

    document.getElementById('sidebar').innerHTML = `
      <div id="sidebar-header">
        <div class="sb-filter-row">
          <select id="turf-filter-sel" onchange="UI.setTurfFilter(this.value)">
            <option value="">All Zones</option>
          </select>
          <select id="result-filter-sel" onchange="UI.setResultFilter(this.value)">
            <option value="">All Results</option>
            <option value="none">Not visited</option>
            ${CONFIG.RESULTS.map(r => `<option value="${r.key}">${r.icon} ${r.label}</option>`).join('')}
          </select>
        </div>
        <div class="sb-filter-row">
          <select id="mode-filter-sel" onchange="UI.setModeFilter(this.value)" style="flex:1">
            <option value="">All Modes</option>
            <option value="hanger">🗂 Hangers Only</option>
            <option value="doorknock">🚪 Knocking Only</option>
          </select>
          <label class="hide-done-toggle" title="Hide completed houses">
            <input type="checkbox" id="hide-done-chk" onchange="UI.setHideDone(this.checked)"/> Hide done
          </label>
        </div>
        <div id="admin-tools" class="admin-tools" style="display:none"></div>
      </div>
      <div id="turf-list"></div>`;
  },

  // ── Login modal ─────────────────────────────────────────────────────────────
  _showLoginModal() {
    const overlay = document.createElement('div');
    overlay.id    = 'login-overlay';
    overlay.innerHTML = `
      <div class="login-card">
        <div class="login-logo">🏡</div>
        <div class="login-title">${CONFIG.APP_NAME}</div>
        <div class="login-sub">${CONFIG.CANDIDATE} · ${CONFIG.RACE}</div>
        <div class="login-form">
          <label class="login-label">Your name</label>
          <input id="login-name" class="login-input" type="text" placeholder="First name or nickname" autocomplete="off"/>
          <label class="login-label" id="pw-label" style="display:none">Admin password</label>
          <input id="login-pw" class="login-input" type="password" placeholder="Password" style="display:none" autocomplete="off"/>
          <button class="login-admin-toggle" id="admin-toggle" onclick="UI._toggleAdminLogin()">🔒 Admin login</button>
          <div id="login-mode-row" class="login-mode-row">
            <div class="login-mode-label">I'm here to:</div>
            <div class="mode-toggle-row">
              <label class="mode-opt selected" id="lmode-hanger" onclick="UI._setLoginMode('hanger')">
                🗂 Drop Hangers
              </label>
              <label class="mode-opt" id="lmode-doorknock" onclick="UI._setLoginMode('doorknock')">
                🚪 Door Knock
              </label>
            </div>
          </div>
          <button class="login-btn" onclick="UI._submitLogin()">Enter</button>
          <div id="login-error" class="login-error"></div>
        </div>
      </div>`;
    document.body.appendChild(overlay);
    setTimeout(() => document.getElementById('login-name')?.focus(), 200);
    document.getElementById('login-name')?.addEventListener('keydown', e => { if (e.key === 'Enter') this._submitLogin(); });
    document.getElementById('login-pw')?.addEventListener('keydown',   e => { if (e.key === 'Enter') this._submitLogin(); });
  },

  _setLoginMode(mode) {
    this._pendingMode = mode;
    document.getElementById('lmode-hanger')?.classList.toggle('selected', mode === 'hanger');
    document.getElementById('lmode-doorknock')?.classList.toggle('selected', mode === 'doorknock');
  },

  _pendingMode: 'hanger',

  _toggleAdminLogin() {
    const pwLabel  = document.getElementById('pw-label');
    const pwInput  = document.getElementById('login-pw');
    const toggle   = document.getElementById('admin-toggle');
    const modeRow  = document.getElementById('login-mode-row');
    const show     = pwInput.style.display === 'none';
    pwLabel.style.display  = show ? 'block' : 'none';
    pwInput.style.display  = show ? 'block' : 'none';
    if (modeRow) modeRow.style.display = show ? 'none' : 'flex';
    toggle.textContent     = show ? '← Back to field login' : '🔒 Admin login';
    if (show) setTimeout(() => pwInput.focus(), 50);
  },

  _submitLogin() {
    const name = (document.getElementById('login-name')?.value || '').trim();
    const pw   = (document.getElementById('login-pw')?.value  || '').trim();
    if (!name) { document.getElementById('login-error').textContent = 'Please enter your name.'; return; }
    if (pw) {
      if (pw !== CONFIG.ADMIN_PASSWORD) { document.getElementById('login-error').textContent = 'Incorrect password.'; return; }
      this.isAdmin = true;
    }
    this.currentUser = name;
    this.userMode    = this.isAdmin ? 'all' : (this._pendingMode || 'hanger');
    this._saveLogin(name, this.isAdmin, this.userMode);
    document.getElementById('login-overlay')?.remove();
    // Log login to sheet
    try { SheetsAPI.logLogin(name, this.sessionId, this.userMode); } catch(e) {}
    this._postLogin();
  },

  _postLogin() {
    const adminTools = document.getElementById('admin-tools');
    if (this.isAdmin && adminTools) {
      adminTools.style.display = 'flex';
      adminTools.innerHTML = `
        <div class="admin-label">Admin</div>
        <button class="admin-btn" id="draw-mode-btn" onclick="UI.toggleDrawMode()">✏️ Draw Zone</button>
        <button class="admin-btn" onclick="UI.showAddHouseModal()">＋ House</button>
        <button class="admin-btn" onclick="UI.showImportModal()">⬆ Import</button>
        <button class="admin-btn" onclick="UI.showLeaderboard()">🏆 Board</button>
        <button class="admin-btn" onclick="UI.exportCSV()">⬇ CSV</button>`;
    }
    if (this.isAdmin) {
      const badge = document.createElement('div');
      badge.className = 'admin-badge';
      badge.innerHTML = `<span>🛡 Admin</span><button class="logout-btn" onclick="UI._clearLogin()">Log out</button>`;
      document.getElementById('header-controls')?.prepend(badge);
    } else {
      // Show lock button for non-admins to unlock admin
      const lockBtn = document.getElementById('lock-btn');
      if (lockBtn) lockBtn.style.display = '';
      // Non-admin: report missing house button in sidebar
      const adminTools = document.getElementById('admin-tools');
      if (adminTools) {
        adminTools.style.display = 'flex';
        adminTools.innerHTML = `<button class="admin-btn" onclick="UI.startMissingHouseReport()">＋ Report Missing House</button>`;
      }
      // Non-admin logout
      const logoutBtn = document.createElement('button');
      logoutBtn.className = 'hdr-btn logout-small';
      logoutBtn.textContent = 'Log out';
      logoutBtn.onclick = () => UI._clearLogin();
      document.getElementById('header-controls')?.appendChild(logoutBtn);
    }
    App.init();
  },

  // ── Admin unlock post-login ────────────────────────────────────────────────
  promptAdminUnlock() {
    this._modal('Admin Login', `
      <label class="f-label">Admin password</label>
      <input id="unlock-pw" class="f-input" type="password" placeholder="Password" autocomplete="off"/>
      <div id="unlock-error" class="login-error"></div>
    `, () => {
      const pw = (document.getElementById('unlock-pw')?.value || '').trim();
      if (pw !== CONFIG.ADMIN_PASSWORD) {
        document.getElementById('unlock-error').textContent = 'Incorrect password.';
        return false;
      }
      this.isAdmin = true;
      this._saveLogin(this.currentUser, true, this.userMode);
      location.reload();
      return true;
    }, 'Unlock');
  },

  // ── Map toggle ────────────────────────────────────────────────────────────
  toggleMap() {
    const wrap = document.getElementById('map-wrap');
    const btn  = document.getElementById('map-toggle-btn');
    const hidden = wrap.classList.toggle('map-hidden');
    if (btn) btn.textContent = hidden ? '🗺 Show' : '🗺 Map';
    if (!hidden) setTimeout(() => MapModule.map.invalidateSize({ pan: false }), 350);
  },

  // ── Hide done toggle ──────────────────────────────────────────────────────
  hideDone: false,
  setHideDone(val) { this.hideDone = val; App.render(); },

  // ── Sync indicator ────────────────────────────────────────────────────────
  setSyncStatus(status) {
    const el = document.getElementById('sync-indicator');
    if (!el) return;
    el.className = 'sync-indicator ' + status;
    if (status === 'syncing') el.textContent = '↻ Saving…';
    else if (status === 'ok') {
      el.textContent = '✓ Saved';
      setTimeout(() => { if (el.textContent === '✓ Saved') { el.textContent = ''; el.className = 'sync-indicator'; } }, 2500);
    } else if (status === 'error') el.textContent = '⚠ Save failed';
    else el.textContent = '';
  },

  // ── Next Door ─────────────────────────────────────────────────────────────
  _nextDoorId: null,
  updateNextDoor() {
    const loc = MapModule.getCurrentLatLon();
    if (!loc) return;
    let best = null, bestDist = Infinity;
    for (const zone of App.state.turfs) {
      if (!this.isAdmin && (turf.mode || 'hanger') !== this.userMode) continue;
      for (const h of turf.houses) {
        if (h.result) continue;
        const d = Math.pow(h.lat - loc.lat, 2) + Math.pow((h.lon - loc.lon) * Math.cos(loc.lat * Math.PI / 180), 2);
        if (d < bestDist) { bestDist = d; best = h; }
      }
    }
    if (best?.id !== this._nextDoorId) {
      this._nextDoorId = best?.id || null;
      MapModule.highlightNextDoor(best);
      // Highlight in sidebar
      document.querySelectorAll('.house-card.next-door').forEach(el => el.classList.remove('next-door'));
      if (best) document.getElementById('hcard-' + best.id)?.classList.add('next-door');
    }
  },

  // ── Leaderboard ───────────────────────────────────────────────────────────
  showLeaderboard() {
    const allHouses = App.state.turfs.flatMap(t => t.houses);
    const today = new Date().toLocaleDateString('en-US', { timeZone: 'America/Chicago' });

    const tally = (houses) => {
      const map = {};
      houses.filter(h => h.result && h.result_by).forEach(h => {
        if (!map[h.result_by]) map[h.result_by] = { hangers: 0, knocked: 0, total: 0, last: '' };
        map[h.result_by].total++;
        if (h.result === 'hanger')  map[h.result_by].hangers++;
        if (h.result === 'knocked') map[h.result_by].knocked++;
        if (!map[h.result_by].last || h.result_date > map[h.result_by].last) map[h.result_by].last = h.result_date;
      });
      return Object.entries(map).sort((a, b) => b[1].total - a[1].total);
    };

    const todayHouses = allHouses.filter(h => {
      if (!h.result_date) return false;
      return new Date(h.result_date).toLocaleDateString('en-US', { timeZone: 'America/Chicago' }) === today;
    });

    const tableHtml = (entries) => {
      if (!entries.length) return '<div class="lb-empty">No activity yet</div>';
      return `<table class="lb-table">
        <thead><tr><th>#</th><th>Name</th><th>📬</th><th>✊</th><th>Total</th><th>Last</th></tr></thead>
        <tbody>${entries.map(([name, s], i) => `
          <tr class="${i === 0 ? 'lb-gold' : i === 1 ? 'lb-silver' : i === 2 ? 'lb-bronze' : ''}">
            <td>${i + 1}</td><td>${_esc(name)}</td>
            <td>${s.hangers}</td><td>${s.knocked}</td>
            <td><strong>${s.total}</strong></td>
            <td>${s.last ? _fmtDate(s.last) : '—'}</td>
          </tr>`).join('')}
        </tbody></table>`;
    };

    this._modal('🏆 Leaderboard', `
      <div class="lb-tabs">
        <button class="lb-tab active" id="lbt-today" onclick="UI._lbTab('today')">Today</button>
        <button class="lb-tab" id="lbt-all" onclick="UI._lbTab('all')">All Time</button>
      </div>
      <div id="lb-today">${tableHtml(tally(todayHouses))}</div>
      <div id="lb-all" style="display:none">${tableHtml(tally(allHouses))}</div>
    `, null, null);
  },

  _lbTab(tab) {
    document.getElementById('lb-today').style.display = tab === 'today' ? '' : 'none';
    document.getElementById('lb-all').style.display   = tab === 'all'   ? '' : 'none';
    document.getElementById('lbt-today')?.classList.toggle('active', tab === 'today');
    document.getElementById('lbt-all')?.classList.toggle('active', tab === 'all');
  },

  // ── CSV Export ────────────────────────────────────────────────────────────
  exportCSV() {
    const rows = [['Turf', 'Address', 'Owner', 'Result', 'Result By', 'Result Date', 'Notes', 'Lat', 'Lon']];
    App.state.turfs.forEach(t => {
      t.houses.forEach(h => {
        rows.push([t.letter, h.address, h.owner, h.result, h.result_by, h.result_date, h.notes, h.lat, h.lon]);
      });
    });
    const csv = rows.map(r => r.map(v => `"${(v||'').toString().replace(/"/g,'""')}"`).join(',')).join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `chaka_canvass_${new Date().toISOString().slice(0,10)}.csv`;
    a.click();
    this.toast('CSV exported ✓', 'success');
  },

  // ── Draw mode ───────────────────────────────────────────────────────────────
  toggleDrawMode() {
    const on  = TurfDraw.toggle();
    const btn = document.getElementById('draw-mode-btn');
    if (btn) { btn.textContent = on ? '✏️ Exit Draw' : '✏️ Draw Zone'; btn.classList.toggle('active-admin-btn', on); }
  },

  // ── Edit boundary banner ────────────────────────────────────────────────────
  showEditBoundaryBanner(letter, onSave, onCancel) {
    document.getElementById('edit-boundary-banner')?.remove();
    const banner = document.createElement('div');
    banner.id = 'edit-boundary-banner';
    banner.className = 'edit-boundary-banner';
    banner.innerHTML = `
      <span>Editing Zone <strong>${letter}</strong> boundary — drag vertices</span>
      <div class="ebb-btns">
        <button class="ebb-save" onclick="(${onSave.toString()})()">✓ Save</button>
        <button class="ebb-cancel" onclick="(${onCancel.toString()})()">✕ Cancel</button>
      </div>`;
    document.body.appendChild(banner);
  },

  hideEditBoundaryBanner() {
    document.getElementById('edit-boundary-banner')?.remove();
  },

  // ── Filters ─────────────────────────────────────────────────────────────────
  setTurfFilter(val) {
    this.turfFilter = val || null;
    App.render();
    if (val) { const t = App.state.turfs.find(t => t.letter === val); if (t) MapModule.focusTurf(t); }
  },
  setResultFilter(val) { this.resultFilter = val || null; App.render(); },
  setModeFilter(val)   { this.modeFilter   = val || null; App.render(); },

  // ── Stats bar ────────────────────────────────────────────────────────────────
  updateStats(turfs) {
    const bar = document.getElementById('stats-bar');
    if (!bar) return;
    const allH      = turfs.flatMap(t => t.houses);
    const total     = allH.length;
    const byResult  = {};
    CONFIG.RESULTS.forEach(r => { byResult[r.key] = 0; });
    allH.forEach(h => { if (h.result) byResult[h.result] = (byResult[h.result] || 0) + 1; });
    const contacted = allH.filter(h => h.result && h.result !== 'skip').length;
    const pct       = total ? Math.round(contacted / total * 100) : 0;

    bar.innerHTML = `
      <div class="stat-chip">${contacted}<span class="stat-chip-label">/${total} contacted</span></div>
      <div class="stat-chip">${byResult['hanger'] || 0}<span class="stat-chip-label"> hangers</span></div>
      <div class="stat-chip">${byResult['knocked'] || 0}<span class="stat-chip-label"> knocked</span></div>
      <div class="stat-chip">${byResult['not_home'] || 0}<span class="stat-chip-label"> NH</span></div>
      <div class="stat-track-wrap">
        <div class="stat-track">
          ${CONFIG.RESULTS.filter(r => r.key !== 'skip').map(r => {
            const w = total ? (byResult[r.key] / total * 100).toFixed(1) : 0;
            return `<div class="stat-seg" style="width:${w}%;background:${r.color}" title="${r.label}: ${byResult[r.key]}"></div>`;
          }).join('')}
        </div>
        <span class="stat-pct">${pct}%</span>
      </div>`;
  },

  // ── Sidebar ──────────────────────────────────────────────────────────────────
  renderSidebar(turfs) {
    const sel = document.getElementById('turf-filter-sel');
    if (sel) {
      const cur = sel.value;
      sel.innerHTML = '<option value="">All Zones</option>' +
        App.state.turfs.map(t =>
          `<option value="${t.letter}" ${cur === t.letter ? 'selected' : ''}>${t.letter} — ${_esc(t.volunteer)}</option>`
        ).join('');
    }

    const list = document.getElementById('turf-list');
    if (!list) return;
    // Non-admins only see turfs matching their mode
    const modeFiltered = this.isAdmin ? turfs : turfs.filter(t => (t.mode || 'hanger') === this.userMode);
    // Apply explicit mode filter (from dropdown)
    const modeApplied  = this.modeFilter ? modeFiltered.filter(t => (t.mode || 'hanger') === this.modeFilter) : modeFiltered;
    const filtered = this.turfFilter ? modeApplied.filter(t => t.letter === this.turfFilter) : modeApplied;

    if (!filtered.length) {
      list.innerHTML = `<div class="sb-empty">${this.isAdmin ? 'No zones yet. Use <strong>✏️ Draw Zone</strong> to create one.' : 'No data loaded.'}</div>`;
      return;
    }

    list.innerHTML = filtered.map((turf, i) => {
      const color     = turf.color || CONFIG.TURF_COLORS[i % CONFIG.TURF_COLORS.length];
      const houses    = this._filterHouses(turf.houses);
      const total     = turf.houses.length;
      const contacted = turf.houses.filter(h => h.result && h.result !== 'skip').length;
      const pct       = total ? Math.round(contacted / total * 100) : 0;
      const is100     = total > 0 && contacted === total;
      const expanded  = this._expandedTurfs.has(turf.letter) || !!this.turfFilter;
      const houseCards = houses.map((house, hi) => this._houseCard(house, turf, hi, color)).join('');

      const adminBtns = this.isAdmin ? `
        <button class="turf-action-btn" title="Edit volunteer/color" onclick="event.stopPropagation();UI.showEditTurfModal('${turf.letter}')">✎</button>
        <button class="turf-action-btn" title="Edit boundary" onclick="event.stopPropagation();TurfDraw.startEditBoundary('${turf.letter}')">⬡</button>
        <button class="turf-action-btn" title="Re-sort walk order" onclick="event.stopPropagation();TurfDraw.resortTurf('${turf.letter}',MapModule.getCurrentLatLon())">🔄</button>
        <button class="turf-action-btn danger" title="Delete" onclick="event.stopPropagation();UI.confirmDeleteTurf('${turf.letter}')">✕</button>` : '';

      return `<div class="${expanded ? 'turf-block turf-expanded' : 'turf-block'}${is100 ? ' turf-complete' : ''}" id="turf-block-${turf.letter}">
        <div class="turf-header" style="--tc:${color}" onclick="UI._toggleTurf('${turf.letter}')">
          <div class="turf-letter-badge" style="background:${color}">${turf.letter}</div>
          <div class="turf-info">
            <div class="turf-volunteer">${_esc(turf.volunteer)}${is100 ? ' <span class="turf-complete-badge">✓ Complete!</span>' : ''}</div>
            <div class="turf-progress-row">
              <div class="turf-prog-track">
                <div class="turf-prog-fill" style="width:${pct}%;background:${is100 ? '#2d9e5f' : color}"></div>
              </div>
              <div class="turf-pct">${contacted}/${total}</div>
            </div>
          </div>
          <div class="turf-chevron" id="chev-${turf.letter}">${expanded ? '▾' : '▸'}</div>
          ${adminBtns}
        </div>
        <div class="turf-houses" id="houses-${turf.letter}" style="display:${expanded ? 'block' : 'none'}">
          ${houseCards || `<div class="sb-empty-turf">No houses${this.resultFilter ? ' matching filter' : ''}.${this.isAdmin ? ' Draw a zone boundary to populate.' : ''}</div>`}
        </div>
      </div>`;
    }).join('');
  },

  _filterHouses(houses) {
    let h = houses;
    if (this.resultFilter === 'none') h = h.filter(x => !x.result);
    else if (this.resultFilter) h = h.filter(x => x.result === this.resultFilter);
    if (this.hideDone) h = h.filter(x => !x.result);
    return h;
  },

  _houseCard(house, turf, idx, color) {
    const result    = house.result || '';
    const resultDef = CONFIG.RESULTS.find(r => r.key === result);
    const badgeHtml = result
      ? `<span class="house-badge" style="background:${resultDef.bg};color:${resultDef.color}">${resultDef.icon} ${resultDef.label}</span>`
      : `<span class="house-badge unvisited">Not visited</span>`;

    // Done key depends on mode: hanger turfs → 'hanger', doorknock → 'knocked'
    const doneKey = (turf.mode || 'hanger') === 'doorknock' ? 'knocked' : 'hanger';
    const doneR   = CONFIG.RESULTS.find(x => x.key === doneKey);
    const skipR   = CONFIG.RESULTS.find(x => x.key === 'skip');
    const isDone  = house.result === doneKey;
    const isSkip  = house.result === 'skip';

    const quickBtns = [
      { r: doneR, key: doneKey, active: isDone, label: '✓' },
      { r: skipR, key: 'skip',  active: isSkip, label: '⤭' },
    ].map(({ r, key, active, label }) =>
      `<button class="quick-btn${active ? ' qbtn-active' : ''}"
        style="--qc:${r.color};--qbg:${r.bg}"
        onclick="event.stopPropagation();App.setResult('${house.id}','${active ? '' : key}')"
        title="${r.label}">${label}</button>`
    ).join('');

    // Street number label — always the actual house number
    const streetNum = (house.address || '').trim().match(/^(\d+)/)?.[1] || String(idx + 1);

    window._houseCache = window._houseCache || {};
    window._houseCache[house.id] = { house, turf, color };

    const attribution = (result && house.result_by)
      ? `<div class="house-attr">${_esc(house.result_by)}${house.result_date ? ' · ' + _fmtDate(house.result_date) : ''}</div>`
      : '';

    const scriptHtml = turf._script
      ? `<div class="house-script">📋 ${_esc(turf._script)}</div>` : '';

    return `<div class="house-card${result ? ' house-done' : ''}${house.id === UI._nextDoorId ? ' next-door' : ''}" id="hcard-${house.id}"
      onclick="UI._cardClick('${house.id}')">
      <div class="house-num" style="background:${result ? (resultDef?.color || '#9ca3af') : '#d1d5db'}">${streetNum}</div>
      <div class="house-body">
        <div class="house-addr">${_esc(house.address)}${house.notes ? '<span class="note-star"> ✱</span>' : ''}</div>
        ${house.owner ? `<div class="house-name">${_esc(house.owner)}</div>` : ''}
        ${house.notes ? `<div class="house-notes">📝 ${_esc(house.notes)}</div>` : ''}
        ${scriptHtml}
        <div class="house-footer">${badgeHtml}${attribution}</div>
      </div>
      <div class="house-quick">${quickBtns}</div>
      ${this.isAdmin ? `<button class="house-del-btn" title="Remove" onclick="event.stopPropagation();UI.confirmDeleteHouse('${house.id}')">✕</button>` : ''}
    </div>`;
  },

  _cardClick(houseId) {
    const cached = window._houseCache?.[houseId];
    if (!cached) return;
    MapModule.focusHouse(cached.house);
    MapModule._openHousePopup(cached.house, cached.turf, cached.color);
  },

  _toggleTurf(letter) {
    const el    = document.getElementById('houses-' + letter);
    const chev  = document.getElementById('chev-' + letter);
    const block = document.getElementById('turf-block-' + letter);
    if (!el) return;
    const open = el.style.display !== 'none';
    el.style.display = open ? 'none' : 'block';
    if (chev)  chev.textContent = open ? '▸' : '▾';
    if (block) block.classList.toggle('turf-expanded', !open);
    if (open) this._expandedTurfs.delete(letter); else this._expandedTurfs.add(letter);
  },

  // ── Presence ─────────────────────────────────────────────────────────────────
  updatePresence(users) {
    const bar = document.getElementById('presence-bar');
    if (!bar) return;
    const avatarColors = ['#2e6ec2','#2d9e5f','#c9831a','#7c4dcc','#c4487a','#1a9e9e','#c44848','#c27a1a'];
    const colorFor = (sid) => {
      let h = 0;
      for (let i = 0; i < sid.length; i++) h = (h * 31 + sid.charCodeAt(i)) >>> 0;
      return avatarColors[h % avatarColors.length];
    };
    const initials = (name) => {
      if (!name) return '?';
      const p = name.trim().split(/\s+/);
      return p.length === 1 ? p[0][0].toUpperCase() : (p[0][0] + p[p.length-1][0]).toUpperCase();
    };
    const timeAgo = (iso) => {
      if (!iso) return '';
      const s = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
      if (s < 10) return 'just now';
      if (s < 60) return `${s}s ago`;
      return `${Math.round(s/60)}m ago`;
    };
    const all = [
      { name: this.currentUser, sessionId: this.sessionId, me: true, last_seen: new Date().toISOString() },
      ...users.filter(u => u.sessionId !== this.sessionId).map(u => ({ ...u, me: false }))
    ];
    bar.innerHTML = all.map(u => {
      const color  = u.me ? '#2d9e5f' : colorFor(u.sessionId);
      const border = u.me ? '2px solid rgba(255,255,255,0.6)' : '2px solid transparent';
      const tip    = `${u.name}${u.me ? ' (you)' : ''} · ${timeAgo(u.last_seen)}`;
      return `<div class="presence-avatar" style="background:${color};border:${border}" title="${tip}">${initials(u.name)}</div>`;
    }).join('');
  },

  setOffline(off) { document.getElementById('offline-banner')?.classList.toggle('visible', off); },

  toast(msg, type = 'info') {
    const t = document.createElement('div');
    t.className   = `toast toast-${type}`;
    t.textContent = msg;
    document.getElementById('toast-container')?.appendChild(t);
    requestAnimationFrame(() => t.classList.add('toast-show'));
    setTimeout(() => { t.classList.remove('toast-show'); setTimeout(() => t.remove(), 300); }, 2800);
  },

  // ── Modal helper ──────────────────────────────────────────────────────────────
  _modal(title, bodyHtml, onConfirm, confirmLabel = 'Save') {
    document.getElementById('modal-overlay')?.remove();
    const overlay = document.createElement('div');
    overlay.id    = 'modal-overlay';
    overlay.innerHTML = `
      <div class="modal-card">
        <div class="modal-header">
          <div class="modal-title">${title}</div>
          <button class="modal-close" onclick="document.getElementById('modal-overlay').remove()">✕</button>
        </div>
        <div class="modal-body">${bodyHtml}</div>
        <div class="modal-footer">
          ${onConfirm ? `<button class="modal-cancel" onclick="document.getElementById('modal-overlay').remove()">Cancel</button>` : ''}
          ${onConfirm ? `<button class="modal-confirm" id="modal-confirm-btn">${confirmLabel}</button>` : `<button class="modal-cancel" onclick="document.getElementById('modal-overlay').remove()">Close</button>`}
        </div>
      </div>`;
    document.body.appendChild(overlay);
    overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });
    if (onConfirm) document.getElementById('modal-confirm-btn').addEventListener('click', () => { if (onConfirm()) overlay.remove(); });
    setTimeout(() => overlay.querySelector('input')?.focus(), 50);
  },

  // ── Edit zone (volunteer/color only — boundary uses startEditBoundary) ────────
  showEditTurfModal(letter) {
    const zone      = App.state.turfs.find(t => t.letter === letter);
    if (!turf) return;
    const colors    = CONFIG.TURF_COLORS;
    const colorOpts = colors.map(c =>
      `<span class="color-swatch${c === turf.color ? ' selected' : ''}" data-color="${c}" style="background:${c}"
        onclick="this.parentElement.querySelectorAll('.color-swatch').forEach(s=>s.classList.remove('selected'));this.classList.add('selected')"></span>`
    ).join('');
    this._modal(`Edit Zone ${letter}`, `
      <label class="f-label">Volunteer</label>
      <input id="f-volunteer" class="f-input" type="text" value="${_esc(turf.volunteer === '[UNASSIGNED]' ? '' : turf.volunteer)}" placeholder="Volunteer name"/>
      <label class="f-label">Mode</label>
      <div class="mode-toggle-row">
        <label class="mode-opt${(turf.mode||'hanger')==='hanger' ? ' selected' : ''}" id="emode-hanger" onclick="this.parentElement.querySelectorAll('.mode-opt').forEach(m=>m.classList.remove('selected'));this.classList.add('selected')">🗂 Hanger</label>
        <label class="mode-opt${(turf.mode||'hanger')==='doorknock' ? ' selected' : ''}" id="emode-doorknock" onclick="this.parentElement.querySelectorAll('.mode-opt').forEach(m=>m.classList.remove('selected'));this.classList.add('selected')">🚪 Door Knock</label>
      </div>
      <label class="f-label">Talking Points / Script (optional)</label>
      <input id="f-script" class="f-input" type="text" value="${_esc(turf._script || '')}" placeholder="e.g. Hi, I'm volunteering for Kevin Chaka…"/>
      <label class="f-label">Color</label>
      <div class="color-row">${colorOpts}</div>
      ${turf.houses.length ? `
        <div class="clear-turf-row">
          <button class="clear-turf-btn" onclick="UI._confirmClearTurf('${letter}')">🗑 Clear All Houses</button>
          <span class="clear-turf-hint">${turf.houses.length} houses · ${turf.houses.filter(h=>h.result).length} with results</span>
        </div>` : ''}
    `, () => {
      const volunteer = (document.getElementById('f-volunteer')?.value || '').trim() || '[UNASSIGNED]';
      const color     = document.querySelector('.color-swatch.selected')?.dataset.color || turf.color;
      const mode      = document.getElementById('emode-doorknock')?.classList.contains('selected') ? 'doorknock' : 'hanger';
      const script    = (document.getElementById('f-script')?.value || '').trim();
      App.updateTurf(letter, { volunteer, color, mode });
      const t = App.state.turfs.find(x => x.letter === letter);
      if (t) t._script = script;
      return true;
    });
  },

  _confirmClearTurf(letter) {
    document.getElementById('modal-overlay')?.remove();
    const zone = App.state.turfs.find(t => t.letter === letter);
    if (!turf) return;
    const withResults = turf.houses.filter(h => h.result).length;
    const msg = withResults > 0
      ? `⚠️ ${withResults} house${withResults > 1 ? 's have' : ' has'} recorded results that will be permanently deleted.\n\nAre you sure you want to clear all ${turf.houses.length} houses from Zone ${letter}?`
      : `Clear all ${turf.houses.length} houses from Zone ${letter}? This cannot be undone.`;
    if (!confirm(msg)) return;
    App.clearTurfHouses(letter);
  },

  confirmDeleteTurf(letter) {
    const zone = App.state.turfs.find(t => t.letter === letter);
    if (turf?.houses.length) { this.toast(`Remove all houses from Zone ${letter} first`, 'error'); return; }
    if (!confirm(`Delete Zone ${letter}? This cannot be undone.`)) return;
    App.deleteTurf(letter);
  },

  // ── Add House — parcel search picker ────────────────────────────────────────
  showAddHouseModal() {
    if (!App.state.turfs.length) { this.toast('Create a zone first', 'error'); return; }
    const turfOpts = App.state.turfs.map(t => `<option value="${t.letter}">${t.letter} — ${_esc(t.volunteer)}</option>`).join('');
    this._modal('Add House from Parcels', `
      <label class="f-label">Turf</label>
      <select id="f-turf" class="f-input">${turfOpts}</select>
      <label class="f-label">Search address or owner</label>
      <input id="parcel-search" class="f-input" type="text" placeholder="e.g. 745 Canongate or SMITH"
        oninput="UI._updateParcelResults()" autocomplete="off"/>
      <div id="parcel-results" class="parcel-results"></div>
      <div id="parcel-selected" class="parcel-selected" style="display:none"></div>
    `, () => {
      const selected = UI._selectedParcel;
      const zone     = document.getElementById('f-turf')?.value;
      if (!selected) { this.toast('Select a parcel from the results', 'error'); return false; }
      if (!turf)     { this.toast('Select a turf', 'error'); return false; }
      App.addHouse({ turf, address: selected.address, owner: selected.owner, lat: selected.lat, lon: selected.lon });
      UI._selectedParcel = null;
      return true;
    }, 'Add House');

    UI._selectedParcel = null;
    setTimeout(() => document.getElementById('parcel-search')?.focus(), 80);
  },

  _selectedParcel: null,

  _updateParcelResults() {
    const q       = (document.getElementById('parcel-search')?.value || '').trim();
    const results = document.getElementById('parcel-results');
    const selDiv  = document.getElementById('parcel-selected');
    if (!results) return;
    if (q.length < 2) { results.innerHTML = ''; return; }

    const matches = ParcelsUtil.searchParcels(q, 20);
    if (!matches.length) { results.innerHTML = '<div class="parcel-no-results">No parcels found</div>'; return; }

    results.innerHTML = matches.map((p, i) =>
      `<div class="parcel-result-row" onclick="UI._selectParcel(${i})" data-idx="${i}">
        <div class="pr-addr">${_esc(p.address)}</div>
        <div class="pr-owner">${_esc(p.owner)}</div>
       </div>`
    ).join('');
    results._matches = matches;
  },

  _selectParcel(idx) {
    const results = document.getElementById('parcel-results');
    const selDiv  = document.getElementById('parcel-selected');
    if (!results?._matches) return;
    const p = results._matches[idx];
    UI._selectedParcel = p;
    results.innerHTML  = '';
    if (selDiv) {
      selDiv.style.display = 'block';
      selDiv.innerHTML = `<div class="parcel-selected-row">
        <span class="ps-check">✓</span>
        <div>
          <div class="pr-addr">${_esc(p.address)}</div>
          <div class="pr-owner">${_esc(p.owner)}</div>
        </div>
        <button class="ps-clear" onclick="UI._clearParcelSelection()">✕</button>
      </div>`;
    }
    document.getElementById('parcel-search').value = p.address;
  },

  _clearParcelSelection() {
    UI._selectedParcel = null;
    const selDiv = document.getElementById('parcel-selected');
    if (selDiv) selDiv.style.display = 'none';
    const search = document.getElementById('parcel-search');
    if (search) { search.value = ''; search.focus(); }
    const results = document.getElementById('parcel-results');
    if (results) results.innerHTML = '';
  },

  confirmDeleteHouse(id) {
    if (!confirm('Remove this house?')) return;
    App.removeHouse(id);
  },

  // ── Report Missing House (non-admin map-tap) ──────────────────────────────
  _mapTapPending: false,
  _mapTapMarker: null,

  startMissingHouseReport() {
    if (this._mapTapPending) return;
    // Find user's zone
    const userZone = App.state.turfs.find(t => (t.mode || 'hanger') === this.userMode);
    if (!userZone && !this.isAdmin) { this.toast('No zone assigned to you yet', 'error'); return; }
    this._mapTapPending = true;
    this.toast('Tap the map where the house is located', 'info');
    document.getElementById('map-wrap')?.classList.add('tap-mode');
  },

  _onMapTap(latlng) {
    this._mapTapPending = false;
    document.getElementById('map-wrap')?.classList.remove('tap-mode');
    // Drop a temporary marker
    if (this._mapTapMarker) MapModule.map.removeLayer(this._mapTapMarker);
    this._mapTapMarker = L.circleMarker([latlng.lat, latlng.lng], {
      radius: 10, color: '#f59e0b', fillColor: '#f59e0b', fillOpacity: 0.6, weight: 2
    }).addTo(MapModule.map);

    const turfOpts = App.state.turfs.map(t =>
      `<option value="${t.letter}">${t.letter} — ${_esc(t.volunteer)}</option>`
    ).join('');

    this._modal('Report Missing House', `
      <div class="f-hint" style="margin-bottom:8px">📍 Location tapped: ${latlng.lat.toFixed(5)}, ${latlng.lng.toFixed(5)}</div>
      <label class="f-label">Address</label>
      <input id="missing-addr" class="f-input" type="text" placeholder="e.g. 123 Main St, Coppell TX" autocomplete="off"/>
      <label class="f-label" style="margin-top:8px">Zone</label>
      <select id="missing-turf" class="f-input">${turfOpts}</select>
    `, () => {
      const addr  = (document.getElementById('missing-addr')?.value || '').trim();
      const turf  = document.getElementById('missing-turf')?.value;
      if (!addr) { this.toast('Please enter an address', 'error'); return false; }
      if (!turf) { this.toast('Please select a zone', 'error'); return false; }
      App.addHouse({ turf, address: addr, owner: '', lat: latlng.lat, lon: latlng.lng });
      if (this._mapTapMarker) { MapModule.map.removeLayer(this._mapTapMarker); this._mapTapMarker = null; }
      return true;
    }, 'Add House');
  },

  // ── Zone completion chat announcement ─────────────────────────────────────
  _completedZones: new Set(),

  checkZoneCompletion(turfs) {
    turfs.forEach(turf => {
      if (!turf.houses.length) return;
      const total     = turf.houses.length;
      const contacted = turf.houses.filter(h => h.result && h.result !== 'skip').length;
      if (contacted === total && !this._completedZones.has(turf.letter)) {
        this._completedZones.add(turf.letter);
        const msg = `📣 Zone ${turf.letter} is complete — great work, ${_esc(turf.volunteer)}! (${total}/${total} houses)`;
        SheetsAPI.sendChat('System', 'system', msg).catch(() => {});
      }
    });
  },
  _chatOpen: false,
  _chatMessages: [],
  _chatLastSeen: 0,
  _chatPollTimer: null,

  toggleChat() {
    this._chatOpen = !this._chatOpen;
    let panel = document.getElementById('chat-panel');
    if (this._chatOpen) {
      if (!panel) this._buildChatPanel();
      document.getElementById('chat-panel').classList.add('open');
      this._chatUnread = 0;
      const badge = document.getElementById('chat-unread');
      if (badge) badge.style.display = 'none';
      setTimeout(() => document.getElementById('chat-input')?.focus(), 100);
      this._scrollChatBottom();
    } else {
      document.getElementById('chat-panel')?.classList.remove('open');
    }
  },

  _buildChatPanel() {
    const panel = document.createElement('div');
    panel.id = 'chat-panel';
    panel.innerHTML = `
      <div class="chat-header">
        <span class="chat-title">💬 Team Chat</span>
        <button class="chat-close" onclick="UI.toggleChat()">✕</button>
      </div>
      <div class="chat-messages" id="chat-messages"></div>
      <div class="chat-input-row">
        <input id="chat-input" class="chat-input" type="text" placeholder="Message the team…" maxlength="280"
          onkeydown="if(event.key==='Enter')UI._sendChat()"/>
        <button class="chat-send" onclick="UI._sendChat()">Send</button>
      </div>`;
    document.body.appendChild(panel);
    this._renderChatMessages();
  },

  async _sendChat() {
    const inp = document.getElementById('chat-input');
    const msg = (inp?.value || '').trim();
    if (!msg) return;
    inp.value = '';
    try {
      await SheetsAPI.sendChat(this.currentUser, this.sessionId, msg);
      await this._fetchChat();
    } catch(e) { this.toast('Failed to send message', 'error'); }
  },

  async _fetchChat() {
    try {
      const data = await SheetsAPI.getChat();
      if (!data.messages) return;
      this._chatMessages = data.messages.map(m => ({ ...m, ts: new Date(m.timestamp).getTime() }));
      const newCount = this._chatMessages.filter(m => m.ts > this._chatLastSeen && m.session_id !== this.sessionId).length;
      if (newCount > 0 && !this._chatOpen) {
        this._chatUnread = (this._chatUnread || 0) + newCount;
        const badge = document.getElementById('chat-unread');
        if (badge) { badge.textContent = this._chatUnread; badge.style.display = ''; }
      }
      if (data.messages.length) this._chatLastSeen = Math.max(...data.messages.map(m => m.ts));
      if (this._chatOpen) this._renderChatMessages();
    } catch(e) {}
  },

  _renderChatMessages() {
    const el = document.getElementById('chat-messages');
    if (!el) return;
    if (!this._chatMessages.length) {
      el.innerHTML = '<div class="chat-empty">No messages yet. Say hi! 👋</div>';
      return;
    }
    let lastDate = '';
    el.innerHTML = this._chatMessages.map(m => {
      const d       = new Date(m.timestamp);
      const dateStr = d.toLocaleDateString('en-US', { timeZone: 'America/Chicago', weekday: 'short', month: 'short', day: 'numeric' });
      const timeStr = d.toLocaleTimeString('en-US', { timeZone: 'America/Chicago', hour: 'numeric', minute: '2-digit', hour12: true });
      const isMe    = m.sessionId === this.sessionId;
      let html = '';
      if (dateStr !== lastDate) {
        lastDate = dateStr;
        html += `<div class="chat-date-bar"><span>${dateStr}</span></div>`;
      }
      html += `<div class="chat-msg ${isMe ? 'chat-mine' : 'chat-theirs'}">
        ${!isMe ? `<div class="chat-name">${_esc(m.name)}</div>` : ''}
        <div class="chat-bubble">${_esc(m.message)}</div>
        <div class="chat-time">${timeStr}</div>
      </div>`;
      return html;
    }).join('');
    this._scrollChatBottom();
  },

  _scrollChatBottom() {
    const el = document.getElementById('chat-messages');
    if (el) el.scrollTop = el.scrollHeight;
  },

  startChatPoll() {
    this._fetchChat();
    this._chatPollTimer = setInterval(() => this._fetchChat(), 10000);
  },
};
