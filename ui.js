// ─── UI Module ────────────────────────────────────────────────────────────────

const UI = {
  isAdmin:      false,
  currentUser:  '',
  currentEmail: '',
  userMode:     'hanger',
  turfFilter:   null,
  resultFilter: null,
  modeFilter:   null,
  sessionId:    localStorage.getItem('ck_sess') || ('s_' + Math.random().toString(36).slice(2) + Date.now().toString(36)),
  _users:       [],
  _userColorPalette: [
    '#e05c4b','#c9831a','#2d9e5f','#2e6ec2','#7c4dcc','#c4487a',
    '#1a9e9e','#c27a1a','#4d8c2f','#4a7abf','#a0522d','#2e8b57',
  ],
  _expandedTurfs: new Set(),

  // localStorage key version — bump to force relogin after schema changes
  _LOGIN_KEY: 'ck_user_v2',

  init() {
    localStorage.setItem('ck_sess', this.sessionId);
    // Migrate: clear old key if present
    if (localStorage.getItem('ck_user')) { localStorage.removeItem('ck_user'); }
    this._buildShell();

    const saved = this._loadSavedLogin();
    if (saved) {
      this.currentUser  = saved.name;
      this.currentEmail = saved.email || '';
      this.isAdmin      = saved.isAdmin;
      this.userMode     = saved.userMode || 'hanger';
      SheetsAPI.getUsers().then(r => { this._users = r.users || []; }).catch(() => {});
      this._postLogin();
    } else {
      this._showLoginModal();
    }
  },

  // ── Login persistence ─────────────────────────────────────────────────────
  _saveLogin(name, isAdmin, userMode, email) {
    localStorage.setItem(this._LOGIN_KEY, JSON.stringify({ name, isAdmin, userMode: userMode || 'hanger', email: email || '' }));
  },
  _loadSavedLogin() {
    try { return JSON.parse(localStorage.getItem(this._LOGIN_KEY) || 'null'); } catch(e) { return null; }
  },
  _clearLogin() {
    localStorage.removeItem(this._LOGIN_KEY);
    location.reload();
  },

  _buildShell() {
    document.getElementById('header').innerHTML = `
      <div class="header-row1">
        <div class="header-left">
          <div class="header-logo">&#x1F682;</div>
          <div>
            <div class="header-title">Chaka Canvassing</div>
            <div class="header-sub">${CONFIG.CANDIDATE} &middot; ${CONFIG.RACE}</div>
          </div>
        </div>
        <div class="header-right" id="header-controls">
          <div class="header-right-top">
            <div id="presence-bar" class="presence-bar"></div>
            <button class="hdr-btn mobile-chat-btn" id="chat-btn" onclick="UI.toggleChat()" title="Team Chat">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
              <span id="chat-unread" class="chat-unread" style="display:none"></span>
            </button>
            <button class="hdr-btn desktop-hide" id="map-toggle-btn" onclick="UI.toggleMap()" title="Show/hide map">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polygon points="1 6 1 22 8 18 16 22 23 18 23 2 16 6 8 2 1 6"/><line x1="8" y1="2" x2="8" y2="18"/><line x1="16" y1="6" x2="16" y2="22"/></svg>
            </button>
            <button class="hdr-btn icon-btn" id="loc-btn" onclick="MapModule.toggleMyLocation()" title="My Location">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3"/><circle cx="12" cy="12" r="8" stroke-opacity="0.35"/></svg>
            </button>
            <button class="hdr-btn icon-btn" id="lock-btn" onclick="UI.promptAdminUnlock()" title="Admin login" style="display:none">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
            </button>
          </div>
          <div class="header-credit">by Brent Billington &middot; v4.9</div>
        </div>
      </div>
      <div class="header-row2" id="header-row2">
        <div id="stats-bar" class="stats-bar"></div>
        <div id="top3-bar" class="top3-bar" style="display:none"></div>
        <div id="row2-right" class="row2-right">
          <div id="admin-row2" style="display:none"></div>
          <div id="sync-indicator" class="sync-indicator"></div>
        </div>
      </div>`;

    document.getElementById('offline-banner').textContent = 'Offline - results will sync when reconnected';

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
            <option value="hanger">Hangers Only</option>
            <option value="doorknock">Knocking Only</option>
          </select>
          <label class="hide-done-toggle" title="Hide completed houses">
            <input type="checkbox" id="hide-done-chk" onchange="UI.setHideDone(this.checked)"/> Hide done
          </label>
        </div>
        <div id="non-admin-tools" class="admin-tools" style="display:none"></div>
      </div>
      <div id="turf-list"></div>
      <div id="sidebar-chat" class="sidebar-chat desktop-only">
        <div class="sc-header">
          <span class="sc-title">Team Chat</span>
          <span id="sc-unread" class="chat-unread" style="display:none"></span>
        </div>
        <div class="sc-messages" id="sc-messages"><div class="chat-empty">No messages yet. Say hi!</div></div>
        <div class="sc-input-row">
          <input id="sc-input" class="sc-input" type="text" placeholder="Message the team..." maxlength="280"
            onkeydown="if(event.key==='Enter')UI._sendChat()"/>
          <button class="sc-send" onclick="UI._sendChat()">Send</button>
        </div>
      </div>`;
  },

  // -- Login modal (email-based accounts) ------------------------------------
  _showLoginModal() {
    const overlay = document.createElement('div');
    overlay.id    = 'login-overlay';
    overlay.innerHTML = `
      <div class="login-card">
        <div class="login-logo">&#x1F682;</div>
        <div class="login-title">${CONFIG.APP_NAME}</div>
        <div class="login-sub">${CONFIG.CANDIDATE} &middot; ${CONFIG.RACE}</div>
        <div class="login-form">
          <label class="login-label">Email address</label>
          <input id="login-email" class="login-input" type="email" placeholder="your@email.com" autocomplete="email"/>
          <div id="login-name-row" style="display:none;margin-top:8px">
            <label class="login-label">First name &amp; last initial</label>
            <input id="login-name" class="login-input" type="text" placeholder="e.g. Kevin C." autocomplete="off"/>
          </div>
          <label class="login-label" id="pw-label" style="display:none;margin-top:10px">Admin password</label>
          <input id="login-pw" class="login-input" type="password" placeholder="Password" style="display:none" autocomplete="off"/>
          <button class="login-admin-toggle" id="admin-toggle" onclick="UI._toggleAdminLogin()">&#x1F512; Admin login</button>
          <div id="login-mode-row" class="login-mode-row">
            <div class="login-mode-label">I'm here to:</div>
            <div class="mode-toggle-row">
              <label class="mode-opt selected" id="lmode-hanger" onclick="UI._setLoginMode('hanger')">&#x1F5C2; Drop Hangers</label>
              <label class="mode-opt" id="lmode-doorknock" onclick="UI._setLoginMode('doorknock')">&#x1F6AA; Door Knock</label>
            </div>
          </div>
          <button class="login-btn" id="login-btn" onclick="UI._submitLogin()">Continue</button>
          <div id="login-error" class="login-error"></div>
        </div>
      </div>`;
    document.body.appendChild(overlay);
    setTimeout(() => document.getElementById('login-email')?.focus(), 200);
    ['login-email','login-name','login-pw'].forEach(id => {
      document.getElementById(id)?.addEventListener('keydown', e => { if (e.key === 'Enter') UI._submitLogin(); });
    });
    document.getElementById('login-email')?.addEventListener('blur', () => UI._checkEmailLookup());
  },

  _pendingMode: 'hanger',
  _foundUser:   null,

  async _checkEmailLookup() {
    const email = (document.getElementById('login-email')?.value || '').trim().toLowerCase();
    if (!email || !email.includes('@')) return;
    const nameRow = document.getElementById('login-name-row');
    const btn     = document.getElementById('login-btn');
    try {
      const res = await SheetsAPI.getUser(email);
      if (res.user) {
        this._foundUser = res.user;
        if (nameRow) nameRow.style.display = 'none';
        if (btn) btn.textContent = 'Sign In';
        document.getElementById('login-error').textContent = '';
      } else {
        this._foundUser = null;
        if (nameRow) nameRow.style.display = 'block';
        if (btn) btn.textContent = 'Create Account';
        setTimeout(() => document.getElementById('login-name')?.focus(), 50);
      }
    } catch(e) {
      this._foundUser = null;
      if (nameRow) nameRow.style.display = 'block';
    }
  },

  _setLoginMode(mode) {
    this._pendingMode = mode;
    document.getElementById('lmode-hanger')?.classList.toggle('selected', mode === 'hanger');
    document.getElementById('lmode-doorknock')?.classList.toggle('selected', mode === 'doorknock');
  },

  _toggleAdminLogin() {
    const pwLabel  = document.getElementById('pw-label');
    const pwInput  = document.getElementById('login-pw');
    const toggle   = document.getElementById('admin-toggle');
    const modeRow  = document.getElementById('login-mode-row');
    const show     = pwInput.style.display === 'none';
    pwLabel.style.display  = show ? 'block' : 'none';
    pwInput.style.display  = show ? 'block' : 'none';
    if (modeRow) modeRow.style.display = show ? 'none' : 'flex';
    toggle.textContent = show ? '<- Back to field login' : 'Admin login';
    if (show) setTimeout(() => pwInput.focus(), 50);
  },

  async _submitLogin() {
    const email = (document.getElementById('login-email')?.value || '').trim().toLowerCase();
    const pw    = (document.getElementById('login-pw')?.value  || '').trim();
    const errEl = document.getElementById('login-error');

    if (!email || !email.includes('@')) { errEl.textContent = 'Please enter a valid email.'; return; }

    if (pw) {
      if (pw !== CONFIG.ADMIN_PASSWORD) { errEl.textContent = 'Incorrect password.'; return; }
      this.isAdmin = true;
    }

    let name, color;
    if (this._foundUser) {
      name  = this._foundUser.name;
      color = this._foundUser.color;
    } else {
      name = (document.getElementById('login-name')?.value || '').trim();
      if (!name) { errEl.textContent = 'Please enter your name.'; return; }
      try {
        const usersRes = await SheetsAPI.getUsers();
        this._users = usersRes.users || [];
      } catch(e) {}
      const usedColors = new Set(this._users.map(u => u.color));
      color = this._userColorPalette.find(c => !usedColors.has(c)) || this._userColorPalette[this._users.length % this._userColorPalette.length];
      try {
        const res = await SheetsAPI.createUser(email, name, color);
        if (res.error && !res.existing) { errEl.textContent = res.error; return; }
      } catch(e) { errEl.textContent = 'Failed to create account.'; return; }
    }

    this.currentUser  = name;
    this.currentEmail = email;
    this.userMode     = this.isAdmin ? 'all' : (this._pendingMode || 'hanger');
    this._saveLogin(name, this.isAdmin, this.userMode, email);
    document.getElementById('login-overlay')?.remove();
    try { SheetsAPI.logLogin(name, this.sessionId, this.userMode); } catch(e) {}
    SheetsAPI.getUsers().then(r => { this._users = r.users || []; }).catch(() => {});
    this._postLogin();
  },

  _postLogin() {
    if (this.isAdmin) {
      const adminRow2 = document.getElementById('admin-row2');
      if (adminRow2) {
        adminRow2.style.display = 'flex';
        adminRow2.innerHTML = `
          <div class="admin-badge-row2">
            <span class="admin-shield">Admin</span>
            <button class="admin-field-btn" onclick="UI._dropToFieldMode()">Field</button>
            <button class="admin-logout-btn" onclick="UI._clearLogin()">Log out</button>
          </div>
          <button class="admin-btn" id="draw-mode-btn" onclick="UI.toggleDrawMode()">Draw Zone</button>
          <button class="admin-btn" onclick="UI.showAddHouseModal()">+ House</button>
          <button class="admin-btn" onclick="UI.showImportModal()">Import</button>
          <button class="admin-btn" onclick="UI.exportCSV()">Export</button>`;
      }
      this._renderTop3();
    } else {
      const lockBtn = document.getElementById('lock-btn');
      if (lockBtn) lockBtn.style.display = '';
      const nonAdminTools = document.getElementById('non-admin-tools');
      if (nonAdminTools) {
        nonAdminTools.style.display = 'flex';
        nonAdminTools.innerHTML = `<button class="admin-btn" onclick="UI.startMissingHouseReport()">+ Add Missing House</button>`;
      }
      const logoutBtn = document.createElement('button');
      logoutBtn.className = 'hdr-btn logout-small';
      logoutBtn.textContent = 'Log out';
      logoutBtn.onclick = () => UI._clearLogin();
      document.getElementById('header-controls')?.appendChild(logoutBtn);
    }
    App.init();
  },

  _dropToFieldMode() {
    this._modal('Switch to Field View', `
      <div class="f-hint" style="margin-bottom:12px">Re-unlock admin with the lock button any time.</div>
      <div class="mode-toggle-row">
        <label class="mode-opt selected" id="fm-hanger"
          onclick="this.parentElement.querySelectorAll('.mode-opt').forEach(m=>m.classList.remove('selected'));this.classList.add('selected')">
          Drop Hangers</label>
        <label class="mode-opt" id="fm-doorknock"
          onclick="this.parentElement.querySelectorAll('.mode-opt').forEach(m=>m.classList.remove('selected'));this.classList.add('selected')">
          Door Knock</label>
      </div>
    `, () => {
      const mode = document.getElementById('fm-doorknock')?.classList.contains('selected') ? 'doorknock' : 'hanger';
      this.isAdmin = false;
      this.userMode = mode;
      this._saveLogin(this.currentUser, false, mode, this.currentEmail);
      location.reload();
      return true;
    }, 'Switch to Field View');
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
    if (btn) btn.classList.toggle('active-btn', hidden);
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

  // -- Top-3 leaderboard chip --------------------------------------------------
  _renderTop3() {
    const bar = document.getElementById('top3-bar');
    if (!bar) return;
    const allH = App.state.turfs.flatMap(t => t.houses);
    const weekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
    const weekH = allH.filter(h => h.result && h.result_by && h.result_date &&
      new Date(h.result_date).getTime() >= weekAgo);
    const tally = {};
    weekH.forEach(h => { tally[h.result_by] = (tally[h.result_by] || 0) + 1; });
    const sorted = Object.entries(tally).sort((a, b) => b[1] - a[1]).slice(0, 3);
    if (!sorted.length) { bar.style.display = 'none'; return; }
    const medals = ['&#x1F947;','&#x1F948;','&#x1F949;'];
    bar.style.display = 'flex';
    bar.innerHTML = `<button class="top3-lb-btn" onclick="UI.showLeaderboard()" title="Full leaderboard">&#x1F3C6; Leaderboard</button>` +
      sorted.map(([name, cnt], i) =>
        `<span class="top3-chip">${medals[i]} ${name.split(' ')[0]} <strong>${cnt}</strong></span>`
      ).join('');
  },

  // ── Leaderboard ───────────────────────────────────────────────────────────
  showLeaderboard() {
    const allHouses  = App.state.turfs.flatMap(t => t.houses);
    const today      = new Date().toLocaleDateString('en-US', { timeZone: 'America/Chicago' });
    const weekAgo    = Date.now() - 7 * 24 * 60 * 60 * 1000;

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

    const todayH = allHouses.filter(h => h.result_date &&
      new Date(h.result_date).toLocaleDateString('en-US', { timeZone: 'America/Chicago' }) === today);
    const weekH  = allHouses.filter(h => h.result_date && new Date(h.result_date).getTime() >= weekAgo);

    const tableHtml = (entries) => {
      if (!entries.length) return '<div class="lb-empty">No activity yet</div>';
      return `<table class="lb-table">
        <thead><tr><th>#</th><th>Name</th><th>HG</th><th>KN</th><th>Total</th><th>Last</th></tr></thead>
        <tbody>${entries.map(([name, s], i) => `
          <tr class="${i === 0 ? 'lb-gold' : i === 1 ? 'lb-silver' : i === 2 ? 'lb-bronze' : ''}">
            <td>${i + 1}</td><td>${_esc(name)}</td>
            <td>${s.hangers}</td><td>${s.knocked}</td>
            <td><strong>${s.total}</strong></td>
            <td>${s.last ? _fmtDate(s.last) : '-'}</td>
          </tr>`).join('')}
        </tbody></table>`;
    };

    this._modal('Leaderboard', `
      <div class="lb-tabs">
        <button class="lb-tab" id="lbt-today" onclick="UI._lbTab('today')">Today</button>
        <button class="lb-tab active" id="lbt-week" onclick="UI._lbTab('week')">This Week</button>
        <button class="lb-tab" id="lbt-all" onclick="UI._lbTab('all')">All Time</button>
      </div>
      <div id="lb-today" style="display:none">${tableHtml(tally(todayH))}</div>
      <div id="lb-week">${tableHtml(tally(weekH))}</div>
      <div id="lb-all" style="display:none">${tableHtml(tally(allHouses))}</div>
    `, null, null);
  },

  _lbTab(tab) {
    ['today','week','all'].forEach(t => {
      document.getElementById('lb-' + t).style.display = t === tab ? '' : 'none';
      document.getElementById('lbt-' + t)?.classList.toggle('active', t === tab);
    });
  },

  // ── CSV Export ────────────────────────────────────────────────────────────
  exportCSV() {
    const rows = [['Zone', 'Address', 'Owner', 'Result', 'Result By', 'Result Date', 'Notes', 'Lat', 'Lon']];
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
    if (this.isAdmin) this._renderTop3();
    const bar = document.getElementById('stats-bar');
    if (!bar) return;

    // Hanger turfs only
    const hangerHouses = turfs.filter(t => (t.mode || 'hanger') === 'hanger').flatMap(t => t.houses);
    const hTotal   = hangerHouses.length;
    const hDone    = hangerHouses.filter(h => h.result === 'hanger' || h.result === 'skip' || h.result === 'not_home').length;
    const hHangers = hangerHouses.filter(h => h.result === 'hanger').length;
    const hPct     = hTotal ? Math.round(hDone / hTotal * 100) : 0;

    // Door knock turfs only
    const knockHouses = turfs.filter(t => (t.mode || 'hanger') === 'doorknock').flatMap(t => t.houses);
    const kTotal   = knockHouses.length;
    const kDone    = knockHouses.filter(h => h.result === 'knocked' || h.result === 'not_home').length;
    const kKnocked = knockHouses.filter(h => h.result === 'knocked').length;
    const kPct     = kTotal ? Math.round(kDone / kTotal * 100) : 0;

    // Segment colors from config
    const col = {};
    CONFIG.RESULTS.forEach(r => { col[r.key] = r.color; });

    const hangerBar = hTotal ? `
      <div class="stat-track-wrap">
        <div class="stat-track">
          <div class="stat-seg" style="width:${hTotal ? (hangerHouses.filter(h=>h.result==='hanger').length/hTotal*100).toFixed(1) : 0}%;background:${col.hanger}" title="Hanger: ${hHangers}"></div>
          <div class="stat-seg" style="width:${hTotal ? (hangerHouses.filter(h=>h.result==='skip').length/hTotal*100).toFixed(1) : 0}%;background:${col.skip}" title="Skip"></div>
          <div class="stat-seg" style="width:${hTotal ? (hangerHouses.filter(h=>h.result==='not_home').length/hTotal*100).toFixed(1) : 0}%;background:${col.not_home}" title="NH"></div>
        </div>
        <span class="stat-pct">${hPct}%</span>
      </div>` : '';

    const knockBar = kTotal ? `
      <div class="stat-track-wrap">
        <div class="stat-track">
          <div class="stat-seg" style="width:${kTotal ? (knockHouses.filter(h=>h.result==='knocked').length/kTotal*100).toFixed(1) : 0}%;background:${col.knocked}" title="Knocked: ${kKnocked}"></div>
          <div class="stat-seg" style="width:${kTotal ? (knockHouses.filter(h=>h.result==='not_home').length/kTotal*100).toFixed(1) : 0}%;background:${col.not_home}" title="NH"></div>
        </div>
        <span class="stat-pct">${kPct}%</span>
      </div>` : '';

    const hangerGroup = hTotal ? `
      <div class="stat-group">
        <div class="stat-chip">📬 ${hHangers}<span class="stat-chip-label">/${hTotal}</span></div>
        ${hangerBar}
      </div>` : '';

    const knockGroup = kTotal ? `
      <div class="stat-group">
        <div class="stat-chip">✊ ${kKnocked}<span class="stat-chip-label">/${kTotal}</span></div>
        ${knockBar}
      </div>` : '';

    const divider = (hTotal && kTotal) ? '<div class="stat-divider"></div>' : '';

    bar.innerHTML = hangerGroup + divider + knockGroup;
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

      const isUnassigned = !turf.volunteer || turf.volunteer === '[UNASSIGNED]';
      const claimBtn = !this.isAdmin && isUnassigned
        ? `<button class="claim-zone-btn" onclick="event.stopPropagation();UI._confirmClaimZone('${turf.letter}')">Claim Zone</button>`
        : '';

      return `<div class="${expanded ? 'turf-block turf-expanded' : 'turf-block'}${is100 ? ' turf-complete' : ''}" id="turf-block-${turf.letter}">
        <div class="turf-header" style="--tc:${color}" onclick="UI._toggleTurf('${turf.letter}')">
          <div class="turf-letter-badge" style="background:${color}">${turf.letter}</div>
          <div class="turf-info">
            <div class="turf-volunteer">${isUnassigned ? '<em style="color:#9ca3af">Unassigned</em>' : _esc(turf.volunteer)}${is100 ? ' <span class="turf-complete-badge">✓ Complete!</span>' : ''}${claimBtn}</div>
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


  _confirmClaimZone(letter) {
    const user = App._getUserRecord();
    if (!confirm(`Claim Zone ${letter} for ${user.name}?\n\nYou'll be assigned as the volunteer for this zone.`)) return;
    App.claimZone(letter);
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


  _showLegendModal() {
    const content = window._legendContent || '';
    this._modal('Map Legend', `<div class="map-legend" style="box-shadow:none;padding:0">${content}</div>`, null, null);
  },

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

  // ── Promise-based confirm modal (for async delete flows) ───────────────────
  _confirm(title, bodyHtml, confirmLabel = 'Confirm', danger = false) {
    return new Promise(resolve => {
      document.getElementById('modal-overlay')?.remove();
      const overlay = document.createElement('div');
      overlay.id = 'modal-overlay';
      overlay.innerHTML = `
        <div class="modal-card">
          <div class="modal-header">
            <div class="modal-title">${title}</div>
            <button class="modal-close" id="modal-x-btn">✕</button>
          </div>
          <div class="modal-body">${bodyHtml}</div>
          <div class="modal-footer">
            <button class="modal-cancel" id="modal-cancel-btn">Cancel</button>
            <button class="modal-confirm${danger ? ' danger' : ''}" id="modal-confirm-btn">${confirmLabel}</button>
          </div>
        </div>`;
      document.body.appendChild(overlay);
      const close = (val) => { overlay.remove(); resolve(val); };
      overlay.addEventListener('click', e => { if (e.target === overlay) close(false); });
      document.getElementById('modal-x-btn').addEventListener('click', () => close(false));
      document.getElementById('modal-cancel-btn').addEventListener('click', () => close(false));
      document.getElementById('modal-confirm-btn').addEventListener('click', () => close(true));
    });
  },

  // ── Edit zone (volunteer/color only — boundary uses startEditBoundary) ────────

  // ── User dropdown helper ──────────────────────────────────────────────────
  _userDropdownHtml(selectedName) {
    const none = `<option value="[UNASSIGNED]"${!selectedName || selectedName === '[UNASSIGNED]' ? ' selected' : ''}>[None] — Unassigned</option>`;
    const opts = this._users.map(u => {
      const sel = u.name === selectedName ? ' selected' : '';
      return `<option value="${_esc(u.name)}" data-color="${u.color}"${sel}>${_esc(u.name)}</option>`;
    }).join('');
    return `<select id="f-volunteer-sel" class="f-input user-dropdown" onchange="UI._onUserDropdownChange(this)">
      ${none}${opts}
    </select>
    <div id="f-volunteer-color" class="volunteer-color-preview" style="display:${selectedName && selectedName !== '[UNASSIGNED]' ? 'flex' : 'none'}"></div>`;
  },

  _onUserDropdownChange(sel) {
    const opt   = sel.options[sel.selectedIndex];
    const color = opt?.dataset?.color || '';
    const prev  = document.getElementById('f-volunteer-color');
    if (prev) {
      if (color && opt.value !== '[UNASSIGNED]') {
        prev.style.display = 'flex';
        prev.style.background = color;
      } else {
        prev.style.display = 'none';
      }
    }
  },

  showEditTurfModal(letter) {
    const turf = App.state.turfs.find(t => t.letter === letter);
    if (!turf) return;
    this._modal(`Edit Zone ${letter}`, `
      <label class="f-label">Assigned Volunteer</label>
      ${this._userDropdownHtml(turf.volunteer)}
      <label class="f-label" style="margin-top:10px">Talking Points / Script (optional)</label>
      <input id="f-script" class="f-input" type="text" value="${_esc(turf._script || '')}" placeholder="e.g. Hi, I'm volunteering for Kevin Chaka…"/>
      ${turf.houses.length ? `
        <div class="clear-turf-row">
          <button class="clear-turf-btn" onclick="UI._confirmClearTurf('${letter}')">Clear All Houses</button>
          <span class="clear-turf-hint">${turf.houses.length} houses · ${turf.houses.filter(h=>h.result).length} with results</span>
        </div>` : ''}
    `, () => {
      const sel       = document.getElementById('f-volunteer-sel');
      const volunteer = sel?.value || '[UNASSIGNED]';
      const opt       = sel?.options[sel.selectedIndex];
      const color     = (opt?.dataset?.color && volunteer !== '[UNASSIGNED]') ? opt.dataset.color : '#6b7280';
      const script    = (document.getElementById('f-script')?.value || '').trim();
      App.updateTurf(letter, { volunteer, color, mode: turf.mode || 'hanger' });
      const t = App.state.turfs.find(x => x.letter === letter);
      if (t) t._script = script;
      return true;
    });
  },

  async _confirmClearTurf(letter) {
    document.getElementById('modal-overlay')?.remove();
    const turf = App.state.turfs.find(t => t.letter === letter);
    if (!turf) return;
    const withResults = turf.houses.filter(h => h.result).length;
    const msg = withResults > 0
      ? `⚠️ <strong>${withResults}</strong> house${withResults > 1 ? 's have' : ' has'} recorded results that will be permanently deleted.<br><br>Clear all ${turf.houses.length} houses from Zone ${letter}?`
      : `Clear all <strong>${turf.houses.length}</strong> houses from Zone ${letter}? This cannot be undone.`;
    const ok = await this._confirm(`Clear Zone ${letter}`, msg, 'Clear All', true);
    if (!ok) return;
    App.clearTurfHouses(letter);
  },

  async confirmDeleteTurf(letter) {
    const turf = App.state.turfs.find(t => t.letter === letter);
    if (!turf) return;
    const resultCount = turf.houses.filter(h => h.result && h.result !== '').length;
    const houseCount  = turf.houses.length;
    const vol = turf.volunteer && turf.volunteer !== '[UNASSIGNED]' ? ` (${turf.volunteer})` : '';

    // First confirm
    const msg1 = resultCount > 0
      ? `Zone ${letter}${vol} has <strong>${resultCount}</strong> recorded result${resultCount > 1 ? 's' : ''} out of ${houseCount} houses.<br><br>This data will be backed up but removed from the map.`
      : `Delete Zone ${letter}${vol}?<br><br>This will remove all <strong>${houseCount}</strong> houses. This cannot be undone.`;
    const ok1 = await this._confirm(`Delete Zone ${letter}`, msg1, 'Delete', true);
    if (!ok1) return;

    // Second confirm + backup if results exist
    if (resultCount > 0) {
      const ok2 = await this._confirm(`Confirm Delete Zone ${letter}`, `Final confirmation — permanently delete Zone ${letter} and all its data?`, 'Yes, Delete', true);
      if (!ok2) return;
      try {
        await SheetsAPI.backupZone(letter);
        this.toast(`Zone ${letter} backed up`, 'info');
      } catch(e) {
        const ok3 = await this._confirm('Backup Failed', 'Could not back up zone data. Delete anyway?', 'Delete Anyway', true);
        if (!ok3) return;
      }
    }
    await App.deleteTurf(letter);
  },

  // ── Add House — parcel search picker ────────────────────────────────────────
  showAddHouseModal() {
    if (!App.state.turfs.length) { this.toast('Create a zone first', 'error'); return; }
    const turfOpts = App.state.turfs.map(t => `<option value="${t.letter}">${t.letter} — ${_esc(t.volunteer)}</option>`).join('');
    this._modal('Add House from Parcels', `
      <label class="f-label">Zone</label>
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
      if (!turf)     { this.toast('Select a zone', 'error'); return false; }
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

  async confirmDeleteHouse(id) {
    const ok = await this._confirm('Remove House', 'Remove this house from the zone?', 'Remove', true);
    if (!ok) return;
    App.removeHouse(id);
  },

  // ── Report Missing House (non-admin map-tap) ──────────────────────────────
  _mapTapPending: false,
  _mapTapMarker: null,

  startMissingHouseReport() {
    if (this._mapTapPending) return;
    this._mapTapPending = true;
    this.toast('Tap the map where the missing house is', 'info');
    document.getElementById('map-wrap')?.classList.add('tap-mode');
  },

  _onMapTap(latlng) {
    this._mapTapPending = false;
    document.getElementById('map-wrap')?.classList.remove('tap-mode');
    if (this._mapTapMarker) MapModule.map.removeLayer(this._mapTapMarker);
    this._mapTapMarker = L.circleMarker([latlng.lat, latlng.lng], {
      radius: 10, color: '#f59e0b', fillColor: '#f59e0b', fillOpacity: 0.6, weight: 2
    }).addTo(MapModule.map);

    // Auto-detect which zone contains the tapped point
    const pt = { lat: latlng.lat, lon: latlng.lng };
    let autoZone = null;
    for (const turf of App.state.turfs) {
      if (!turf.polygon_geojson) continue;
      try {
        let gj = turf.polygon_geojson;
        if (typeof gj === 'string') gj = JSON.parse(gj);
        const ring = (gj.coordinates || gj.geometry?.coordinates)?.[0];
        if (ring && ParcelsUtil.ptInDrawnRing(pt, ring.map(c => ({ lat: c[1], lng: c[0] })))) {
          autoZone = turf.letter;
          break;
        }
      } catch(e) {}
    }

    // Build zone dropdown (auto-selected if detected)
    const turfOpts = App.state.turfs.map(t =>
      `<option value="${t.letter}"${t.letter === autoZone ? ' selected' : ''}>${t.letter} — ${_esc(t.volunteer)}</option>`
    ).join('');

    const zoneHint = autoZone
      ? `<div class="f-hint" style="color:#2d9e5f;margin-bottom:4px">Detected Zone ${autoZone} — change if wrong</div>`
      : `<div class="f-hint" style="color:#c9831a;margin-bottom:4px">Outside all zone boundaries — select manually</div>`;

    this._modal('Add Missing House', `
      <div class="f-hint" style="margin-bottom:8px">Location: ${latlng.lat.toFixed(5)}, ${latlng.lng.toFixed(5)}</div>
      <label class="f-label">Address</label>
      <input id="missing-addr" class="f-input" type="text" placeholder="e.g. 123 Main St, Coppell TX" autocomplete="off"/>
      <label class="f-label" style="margin-top:8px">Zone</label>
      ${zoneHint}
      <select id="missing-turf" class="f-input">${turfOpts}</select>
    `, () => {
      const addr = (document.getElementById('missing-addr')?.value || '').trim();
      const turf = document.getElementById('missing-turf')?.value;
      if (!addr) { this.toast('Please enter an address', 'error'); return false; }
      if (!turf) { this.toast('Please select a zone', 'error'); return false; }
      App.addHouse({ turf, address: addr, owner: '', lat: latlng.lat, lon: latlng.lng });
      if (this._mapTapMarker) { MapModule.map.removeLayer(this._mapTapMarker); this._mapTapMarker = null; }
      return true;
    }, 'Add House');
  },

  // ── Zone completion chat announcement ─────────────────────────────────────
  _completedZones: new Set(),
  _chatOpen: false,
  _chatMessages: [],
  _chatLastSeen: 0,
  _chatUnread: 0,
  _chatPollTimer: null,

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
    let panel = document.getElementById('chat-panel');
    if (!panel) this._buildMobileChatPanel();
    panel = document.getElementById('chat-panel');
    const isOpen = panel.classList.toggle('open');
    this._chatOpen = isOpen;
    if (isOpen) {
      this._chatUnread = 0;
      this._clearUnreadBadges();
      setTimeout(() => document.getElementById('chat-input')?.focus(), 120);
      this._scrollChatBottom('chat-messages');
    }
  },

  _buildMobileChatPanel() {
    const panel = document.createElement('div');
    panel.id = 'chat-panel';
    panel.innerHTML = `
      <div class="chat-header">
        <span class="chat-title">Team Chat</span>
        <button class="chat-close" onclick="UI.toggleChat()">X</button>
      </div>
      <div class="chat-messages" id="chat-messages"></div>
      <div class="chat-input-row">
        <input id="chat-input" class="chat-input" type="text" placeholder="Message the team..." maxlength="280"
          onkeydown="if(event.key==='Enter')UI._sendChat()"/>
        <button class="chat-send" onclick="UI._sendChat()">Send</button>
      </div>`;
    document.body.appendChild(panel);
    this._renderChatMessages('chat-messages');
  },

  async _sendChat() {
    const scInp  = document.getElementById('sc-input');
    const mobInp = document.getElementById('chat-input');
    const inp = (scInp?.value || '').trim() ? scInp
              : (mobInp?.value || '').trim() ? mobInp
              : scInp || mobInp;
    const msg = (inp?.value || '').trim();
    if (!msg) { this.toast('Type a message first', 'info'); return; }
    if (!this.currentUser) { this.toast('Not logged in', 'error'); return; }
    inp.value = '';
    // Optimistic: append locally right away so it feels instant
    const now = new Date().toISOString();
    const optimistic = { id: '_opt_' + Date.now(), timestamp: now, name: this.currentUser,
      session_id: this.sessionId, message: msg, ts: Date.now() };
    this._chatMessages = [...(this._chatMessages || []), optimistic];
    this._renderChatMessages('sc-messages');
    if (this._chatOpen) this._renderChatMessages('chat-messages');
    // Fire-and-forget send, then fetch to confirm
    SheetsAPI.sendChat(this.currentUser, this.sessionId, msg)
      .then(() => this._fetchChat())
      .catch(() => this.toast('Failed to send - check connection', 'error'));
  },

  async _fetchChat() {
    try {
      const data = await SheetsAPI.getChat();
      if (!data.messages) return;
      this._chatMessages = data.messages.map(m => ({ ...m, ts: new Date(m.timestamp).getTime() }));
      const newCount = this._chatMessages.filter(m =>
        m.ts > this._chatLastSeen && (m.session_id || m.sessionId) !== this.sessionId
      ).length;
      if (newCount > 0) {
        this._chatUnread = (this._chatUnread || 0) + newCount;
        this._updateUnreadBadges();
      }
      if (data.messages.length) this._chatLastSeen = Math.max(...data.messages.map(m => m.ts));
      this._renderChatMessages('sc-messages');
      if (this._chatOpen) this._renderChatMessages('chat-messages');
    } catch(e) {}
  },

  _updateUnreadBadges() {
    const b1 = document.getElementById('chat-unread');
    if (b1 && !this._chatOpen) { b1.textContent = this._chatUnread; b1.style.display = ''; }
    const b2 = document.getElementById('sc-unread');
    if (b2) { b2.textContent = this._chatUnread; b2.style.display = this._chatUnread > 0 ? '' : 'none'; }
  },

  _clearUnreadBadges() {
    this._chatUnread = 0;
    ['chat-unread','sc-unread'].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.style.display = 'none';
    });
  },

  _renderChatMessages(elId) {
    const el = document.getElementById(elId);
    if (!el) return;
    const msgs    = this._chatMessages || [];
    const isStrip = elId === 'sc-messages';
    const display = msgs;
    if (!display.length) {
      el.innerHTML = '<div class="chat-empty">No messages yet. Say hi!</div>';
      return;
    }
    let lastDate = '';
    el.innerHTML = display.map(m => {
      const d       = new Date(m.timestamp);
      const dateStr = d.toLocaleDateString('en-US', { timeZone: 'America/Chicago', weekday: 'short', month: 'short', day: 'numeric' });
      const timeStr = d.toLocaleTimeString('en-US', { timeZone: 'America/Chicago', hour: 'numeric', minute: '2-digit', hour12: true });
      const isMe    = (m.session_id || m.sessionId) === this.sessionId;
      let html = '';
      if (!isStrip && dateStr !== lastDate) {
        lastDate = dateStr;
        html += `<div class="chat-date-bar"><span>${dateStr}</span></div>`;
      }
      if (isStrip) {
        const nameTag = `<span class="sc-name">${isMe ? 'You' : _esc(m.name)}</span>`;
        html += `<div class="sc-msg ${isMe ? 'sc-mine' : 'sc-theirs'}">
          ${nameTag}<span class="sc-bubble">${_esc(m.message)}</span>
          <span class="sc-time">${timeStr}</span>
        </div>`;
      } else {
        const nameStr = isMe ? 'You' : _esc(m.name || 'Unknown');
        html += `<div class="chat-msg ${isMe ? 'chat-mine' : 'chat-theirs'}">
          <div class="chat-name">${nameStr}</div>
          <div class="chat-bubble">${_esc(m.message)}</div>
          <div class="chat-time">${timeStr}</div>
        </div>`;
      }
      return html;
    }).join('');
    // Only auto-scroll if user is already near the bottom (or it's a fresh send)
    const scrollEl = document.getElementById(elId);
    if (scrollEl) {
      const nearBottom = scrollEl.scrollHeight - scrollEl.scrollTop - scrollEl.clientHeight < 60;
      if (nearBottom) this._scrollChatBottom(elId);
    }
  },

  _scrollChatBottom(elId) {
    const el = document.getElementById(elId || 'sc-messages');
    if (el) el.scrollTop = el.scrollHeight;
  },

  startChatPoll() {
    this._fetchChat();
    this._chatPollTimer = setInterval(() => this._fetchChat(), 10000);
  },
};
