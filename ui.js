// ─── UI Module ────────────────────────────────────────────────────────────────

const UI = {
  isAdmin:      false,
  currentUser:  '',
  currentEmail: '',
  userMode:     'hanger',
  turfFilter:      null,
  resultFilter:    null,
  modeFilter:      null,
  viewMode:        null,
  volunteerFilter: null,
  sessionId:    localStorage.getItem('ck_sess') || ('s_' + Math.random().toString(36).slice(2) + Date.now().toString(36)),
  _users:       [],
  _userColorPalette: [
    '#e05c4b','#c9831a','#2d9e5f','#2e6ec2','#8b5e9e','#c4487a',
    '#1a9e9e','#c27a1a','#4d8c2f','#4a7abf','#a0522d','#2e8b57',
  ],
  _expandedTurfs: new Set(),
  _multiSelectTurf: null,      // letter of zone in multi-select mode
  _selectedHouseIds: new Set(), // currently selected house IDs

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
            <button class="hdr-btn desktop-hide list-toggle-btn" id="map-toggle-btn" onclick="UI.toggleMap()" title="Show list">List</button>
            <button class="hdr-btn icon-btn" id="loc-btn" onclick="MapModule.toggleMyLocation()" title="My Location">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3"/><circle cx="12" cy="12" r="8" stroke-opacity="0.35"/></svg>
            </button>
            <button class="hdr-btn icon-btn" id="lock-btn" onclick="UI.promptAdminUnlock()" title="Admin login" style="display:none">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
            </button>
          </div>
          <div class="header-credit">by Brent Billington &middot; ${typeof APP_VERSION !== "undefined" ? APP_VERSION : "v4.21"}</div>
        </div>
      </div>
      <div class="header-row2" id="header-row2">
        <div class="addr-search-wrap" id="addr-search-wrap">
          <input id="addr-search-input" class="addr-search-input" type="text" placeholder="🔍 Search address…" autocomplete="off"
            oninput="UI._addrSearchInput()" onkeydown="UI._addrSearchKey(event)"/>
          <div id="addr-search-results" class="addr-search-results" style="display:none"></div>
        </div>
        <div id="my-progress-bar" class="my-progress-bar" style="display:none"></div>
        <div id="stats-bar" class="stats-bar"></div>
        <div id="top3-bar" class="top3-bar" style="display:none"></div>
        <div id="row2-right" class="row2-right">
          <div id="admin-row2" style="display:none"></div>
          <div id="sync-indicator" class="sync-indicator"></div>
        </div>
      </div>`;

    document.getElementById('offline-banner').textContent = 'Offline - results will sync when reconnected';
    // Mobile map filter overlay — visible when list is closed on mobile
    if (!document.getElementById('mobile-map-filter')) {
      const f = document.createElement('div');
      f.id = 'mobile-map-filter';
      f.className = 'mobile-map-filter';
      f.innerHTML = `
        <select id="mmf-view" onchange="UI.setViewMode(this.value);UI._syncMobileFilter()" title="Type">
          <option value="">All</option>
          <option value="hanger">Hangers</option>
          <option value="knock">Knocks</option>
        </select>
        <select id="mmf-vol" onchange="UI.setVolunteerFilter(this.value)" title="Volunteer">
          <option value="">All Volunteers</option>
        </select>
        <select id="mmf-result" onchange="UI.setResultFilter(this.value)" title="Result">
          <option value="">All Results</option>
          <option value="none">Not visited</option>
          ${CONFIG.RESULTS.map(r => `<option value="${r.key}">${r.icon} ${r.label}</option>`).join('')}
        </select>`;
      document.body.appendChild(f);
    }
    if (!document.getElementById('mobile-list-fab')) {
      const fab = document.createElement('button');
      fab.id = 'mobile-list-fab';
      fab.className = 'mobile-list-fab';
      fab.innerHTML = '📋';
      fab.title = 'Show list';
      fab.onclick = () => UI.toggleMap();
      document.body.appendChild(fab);
    }
    // Measure actual header height and set CSS var for mobile filter positioning
    this._setMobileHeaderVar();

    document.getElementById('sidebar').innerHTML = `
      <div id="sidebar-header">
        <button class="sidebar-close-btn desktop-hide" onclick="UI.toggleMap()" title="Close list">✕ Map</button>
        <div class="sb-filter-row">
          <select id="view-mode-sel" onchange="UI.setViewMode(this.value)" title="Filter by type">
            <option value="">All</option>
            <option value="hanger">Hangers</option>
            <option value="knock">Knocks</option>
          </select>
          <select id="vol-filter-sel" onchange="UI.setVolunteerFilter(this.value)">
            <option value="">All Volunteers</option>
          </select>
          <select id="result-filter-sel" onchange="UI.setResultFilter(this.value)">
            <option value="">All Results</option>
            <option value="none">Not visited</option>
            ${CONFIG.RESULTS.map(r => `<option value="${r.key}">${r.icon} ${r.label}</option>`).join('')}
          </select>
        </div>
        <div class="sb-filter-row">
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

  // ── Set mobile header height CSS var for filter bar positioning ─────────────
  _setMobileHeaderVar() {
    const set = () => {
      const h = document.getElementById('header')?.offsetHeight || 90;
      document.documentElement.style.setProperty('--mobile-header-h', h + 'px');
    };
    set();
    // Re-measure after fonts/content load
    window.addEventListener('load', set, { once: true });
    window.addEventListener('resize', set, { passive: true });
    // Re-measure whenever header size changes (stats load, admin toggle, etc.)
    if (!this._headerObserver) {
      const hdr = document.getElementById('header');
      if (hdr && typeof ResizeObserver !== 'undefined') {
        this._headerObserver = new ResizeObserver(set);
        this._headerObserver.observe(hdr);
      }
    }
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
          <div id="login-mode-row" class="login-mode-row">
            <div class="login-mode-label">I'm here to:</div>
            <div class="mode-toggle-row">
              <label class="mode-opt selected" id="lmode-hanger" onclick="UI._setLoginMode('hanger')">&#x1F5C2; Drop Hangers</label>
              <label class="mode-opt" id="lmode-knock" onclick="UI._setLoginMode('knock')">&#x1F6AA; Door Knock</label>
            </div>
          </div>
          <button class="login-btn" id="login-btn" onclick="UI._submitLogin()">Continue</button>
          <div id="login-error" class="login-error"></div>
        </div>
      </div>`;
    document.body.appendChild(overlay);
    setTimeout(() => document.getElementById('login-email')?.focus(), 200);
    ['login-email','login-name'].forEach(id => {
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
    document.getElementById('lmode-knock')?.classList.toggle('selected', mode === 'knock');
  },

  async _submitLogin() {
    const email = (document.getElementById('login-email')?.value || '').trim().toLowerCase();
    const errEl = document.getElementById('login-error');

    if (!email || !email.includes('@')) { errEl.textContent = 'Please enter a valid email.'; return; }

    // Always check for existing user before proceeding — handles Enter key
    // bypassing the blur-triggered _checkEmailLookup
    if (!this._foundUser) {
      try {
        const res = await SheetsAPI.getUser(email);
        if (res.user) {
          this._foundUser = res.user;
          const nameRow = document.getElementById('login-name-row');
          if (nameRow) nameRow.style.display = 'none';
        }
      } catch(e) { /* proceed as new user */ }
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
    const existingLogout = document.getElementById('logout-hdr-btn');
    if (!existingLogout) {
      const logoutBtn = document.createElement('button');
      logoutBtn.id = 'logout-hdr-btn';
      logoutBtn.className = 'hdr-btn logout-small';
      logoutBtn.textContent = 'Log out';
      logoutBtn.onclick = () => UI._clearLogin();
      document.querySelector('.header-right-top')?.appendChild(logoutBtn);
    }
    if (this.isAdmin) {
      const adminRow2 = document.getElementById('admin-row2');
      if (adminRow2) {
        adminRow2.style.display = 'flex';
        adminRow2.innerHTML = `
          <div class="admin-badge-row2">
            <span class="admin-shield">Admin</span>
            <button class="admin-field-btn" onclick="UI._dropToFieldMode()">Exit Admin</button>
          </div>
          <button class="admin-btn" id="draw-mode-btn" onclick="UI.toggleDrawMode()">Draw Zone</button>
          <button class="admin-btn" onclick="UI.showAddHouseModal()">+ House</button>
          <button class="admin-btn" onclick="UI.showAddKnockModal()">+ Knock</button>
          <button class="admin-btn" onclick="UI.showImportModal()">Import</button>
          <button class="admin-btn" onclick="UI.exportCSV()">Export</button>
          <button class="admin-btn" onclick="UI.exportZonesCSV()">Export Zones</button>
          <button class="admin-btn" onclick="UI.showImportZonesModal()">Import Zones</button>`;
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
    }
    App.init();
    // Re-measure header height now that admin/user UI is fully rendered
    setTimeout(() => this._setMobileHeaderVar(), 100);
  },

  _dropToFieldMode() {
    this.isAdmin = false;
    this._saveLogin(this.currentUser, false, 'field', this.currentEmail);
    location.reload();
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
      this.userMode = 'all';
      this._saveLogin(this.currentUser, true, 'all', this.currentEmail);
      // Upgrade UI in place — no reload
      const lockBtn = document.getElementById('lock-btn');
      if (lockBtn) lockBtn.style.display = 'none';
      const nonAdminTools = document.getElementById('non-admin-tools');
      if (nonAdminTools) nonAdminTools.style.display = 'none';
      // Remove field logout button if present
      document.querySelector('.logout-small')?.remove();
      const adminRow2 = document.getElementById('admin-row2');
      if (adminRow2) {
        adminRow2.style.display = 'flex';
        adminRow2.innerHTML = `
          <div class="admin-badge-row2">
            <span class="admin-shield">Admin</span>
            <span class="mode-label">Mode:</span>
            <button class="admin-field-btn" onclick="UI._dropToFieldMode()">Field</button>
            <button class="admin-logout-btn" onclick="UI._clearLogin()">Log out</button>
          </div>
          <button class="admin-btn" id="draw-mode-btn" onclick="UI.toggleDrawMode()">Draw Zone</button>
          <button class="admin-btn" onclick="UI.showAddHouseModal()">+ House</button>
          <button class="admin-btn" onclick="UI.showAddKnockModal()">+ Knock</button>
          <button class="admin-btn" onclick="UI.showImportModal()">Import</button>
          <button class="admin-btn" onclick="UI.exportCSV()">Export</button>
          <button class="admin-btn" onclick="UI.exportZonesCSV()">Export Zones</button>
          <button class="admin-btn" onclick="UI.showImportZonesModal()">Import Zones</button>`;
      }
      App.render();
      UI.toast('Admin mode active', 'success');
      return true;
    }, 'Unlock');
  },

  // ── Map toggle ────────────────────────────────────────────────────────────
  toggleMap() {
    const isMobile = window.innerWidth <= 680;
    const fab = document.getElementById('mobile-list-fab');
    if (isMobile) {
      const sidebar = document.getElementById('sidebar');
      const btn     = document.getElementById('map-toggle-btn');
      const open    = sidebar?.classList.toggle('sidebar-open');
      if (btn) {
        btn.classList.toggle('active-btn', !!open);
        btn.textContent = open ? 'Map' : 'List';
        btn.title = open ? 'Back to map' : 'Show list';
      }
      if (fab) fab.innerHTML = open ? '🗺️' : '📋';
      if (open && sidebar) { /* swipe removed */ }
      return;
    }
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
    for (const turf of App.state.turfs) {
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
    if (!sorted.length) {
      bar.style.display = 'flex';
      bar.innerHTML = `<button class="hdr-btn top3-lb-btn" onclick="UI.showLeaderboard()" title="Full leaderboard">🏆 Leaderboard</button>`;
      return;
    }
    const medals = ['&#x1F947;','&#x1F948;','&#x1F949;'];
    bar.style.display = 'flex';
    bar.innerHTML = `<button class="hdr-btn top3-lb-btn" onclick="UI.showLeaderboard()" title="Full leaderboard">🏆 Leaderboard</button>` +
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

  // ── Zone CSV Export (Item 3a) ─────────────────────────────────────────────
  exportZonesCSV() {
    const rows = [['zone_id','zone_name','zone_color','zone_type','assignee','volunteer_name','status','polygon_coordinates','house_count']];
    App.state.turfs.forEach(t => {
      const total     = t.houses.length;
      const contacted = t.houses.filter(h => h.result && h.result !== 'skip').length;
      const status    = total === 0 ? 'unstarted'
                      : contacted === total ? 'complete'
                      : contacted > 0 ? 'in_progress'
                      : 'unstarted';
      let poly = '';
      if (t.polygon_geojson) {
        try { poly = JSON.stringify(t.polygon_geojson); } catch(e) {}
      }
      rows.push([
        t.letter,
        t.name || `Zone ${t.letter}`,
        t.color || '#6b7280',
        t.mode || 'hanger',
        t.volunteer || '[UNASSIGNED]',
        t.volunteer || '[UNASSIGNED]',
        status,
        poly,
        total,
      ]);
    });
    const csv = rows.map(r => r.map(v => `"${(v||'').toString().replace(/"/g,'""')}"`).join(',')).join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `zones_export_${new Date().toISOString().slice(0,10)}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
    this.toast(`${App.state.turfs.length} zones exported ✓`, 'success');
  },

  // ── Zone CSV Import (Item 3b) ─────────────────────────────────────────────
  showImportZonesModal() {
    this._modal('Import Zones CSV', `
      <div class="import-section">
        <div class="import-step-label">Select a zones_export CSV to import</div>
        <div class="f-hint">Columns required: <strong>zone_id, zone_color, zone_type, assignee, polygon_coordinates</strong></div>
        <input type="file" id="zone-import-file" accept=".csv" class="import-file-input"
          onchange="UI._handleZoneImportFile(this)"/>
        <label for="zone-import-file" class="import-file-label" id="zone-import-file-label">📂 Choose zones CSV…</label>
      </div>
      <div id="zone-import-preview" style="margin-top:10px;font-size:13px;color:var(--text2)"></div>
    `, async () => {
      const rows = UI._importZoneRows;
      if (!rows || !rows.length) { UI.toast('No zone rows to import', 'error'); return false; }
      const ok = await UI._confirm(
        'Confirm Zone Import',
        `This will upsert <strong>${rows.length}</strong> zone${rows.length !== 1 ? 's' : ''}.<br><br>Existing zones with the same ID will be updated. New zones will be created. No zones will be deleted.`,
        'Import Zones'
      );
      if (!ok) return false;
      await UI._doZoneImport(rows);
      return true;
    }, 'Preview & Import');
  },

  _importZoneRows: null,

  _handleZoneImportFile(input) {
    const file = input.files[0];
    if (!file) return;
    document.getElementById('zone-import-file-label').textContent = '✓ ' + file.name;
    const reader = new FileReader();
    reader.onload = e => {
      try {
        const lines = e.target.result.split(/\r?\n/).filter(l => l.trim());
        if (lines.length < 2) { UI.toast('CSV appears empty', 'error'); return; }
        const header = lines[0].split(',').map(h => h.replace(/^"|"$/g,'').trim().toLowerCase());
        const req = ['zone_id','zone_color','zone_type','assignee'];
        const missing = req.filter(c => !header.includes(c));
        if (missing.length) { UI.toast(`Missing columns: ${missing.join(', ')}`, 'error'); return; }
        const col = c => header.indexOf(c);

        const parseCell = s => s.trim().replace(/^"|"$/g,'');
        const rows = lines.slice(1).map(line => {
          // CSV-aware split: handle quoted commas
          const cells = [];
          let cur = '', inQ = false;
          for (let i = 0; i < line.length; i++) {
            const ch = line[i];
            if (ch === '"') { inQ = !inQ; }
            else if (ch === ',' && !inQ) { cells.push(cur); cur = ''; }
            else { cur += ch; }
          }
          cells.push(cur);
          const get = c => col(c) >= 0 ? parseCell(cells[col(c)] || '') : '';
          return {
            zone_id:   get('zone_id'),
            zone_color: get('zone_color') || '#6b7280',
            zone_type:  get('zone_type')  || 'hanger',
            assignee:   get('assignee')   || '[UNASSIGNED]',
            volunteer_name: get('volunteer_name') || get('assignee') || '[UNASSIGNED]',
            polygon_coordinates: get('polygon_coordinates'),
          };
        }).filter(r => r.zone_id);

        UI._importZoneRows = rows;
        const prev = document.getElementById('zone-import-preview');
        if (prev) {
          const existing = rows.filter(r => App.state.turfs.some(t => String(t.letter) === String(r.zone_id))).length;
          const newCount = rows.length - existing;
          prev.innerHTML = `<strong>${rows.length}</strong> zones found — <strong>${existing}</strong> updates, <strong>${newCount}</strong> new`;
        }
      } catch(err) {
        UI.toast('Failed to parse CSV: ' + err.message, 'error');
      }
    };
    reader.readAsText(file);
  },

  async _doZoneImport(rows) {
    UI.toast(`Importing ${rows.length} zones…`, 'info');
    let updated = 0, created = 0, failed = 0;
    for (const row of rows) {
      const existingTurf = App.state.turfs.find(t => String(t.letter) === String(row.zone_id));
      try {
        if (existingTurf) {
          // Update existing zone
          const fields = { color: row.zone_color, mode: row.zone_type, volunteer: row.assignee };
          await SheetsAPI.updateTurf(row.zone_id, fields);
          Object.assign(existingTurf, fields);
          // Update polygon if provided
          if (row.polygon_coordinates) {
            try {
              const poly = JSON.parse(row.polygon_coordinates);
              await SheetsAPI.saveTurfPolygon(row.zone_id, poly);
              existingTurf.polygon_geojson = poly;
            } catch(e) { /* skip bad polygon */ }
          }
          updated++;
        } else {
          // Create new zone
          let geojson = null;
          if (row.polygon_coordinates) {
            try { geojson = JSON.parse(row.polygon_coordinates); } catch(e) {}
          }
          const res = await SheetsAPI.createZone(
            row.zone_id, row.zone_color,
            row.assignee || '[UNASSIGNED]',
            geojson, []
          );
          if (!res.error) created++;
          else failed++;
        }
      } catch(e) { failed++; }
    }
    await App.loadData();
    this.toast(`Import done — ${updated} updated, ${created} created${failed ? ', ' + failed + ' failed' : ''} ✓`, 'success');
  },

  // ── CSV Import ────────────────────────────────────────────────────────────
  showImportModal() {
    const zones = App.state.turfs;
    const zoneOpts = zones.length
      ? zones.map(t => `<option value="${t.letter}">${t.letter}${t.volunteer && t.volunteer !== '[UNASSIGNED]' ? ' — ' + _esc(t.volunteer) : ''}</option>`).join('')
      : '<option value="">No zones yet</option>';
    this._modal('Import Addresses', `
      <div class="import-section">
        <div class="import-step-label">Step 1 — Download the template</div>
        <button class="import-template-btn" onclick="UI._downloadImportTemplate()">⬇ Download CSV Template</button>
        <div class="f-hint">Columns: <strong>Address</strong>, <strong>Type</strong> (hanger or knock), <strong>Volunteer</strong> (optional — auto-routes to their zone)</div>
      </div>
      <div class="import-section">
        <div class="import-step-label">Step 2 — Fill it in &amp; upload</div>
        <input type="file" id="import-file-input" accept=".csv" class="import-file-input"
          onchange="UI._handleImportFile(this)"/>
        <label for="import-file-input" class="import-file-label" id="import-file-label">📂 Choose CSV file…</label>
      </div>
      <div class="import-section" id="import-zone-row" style="display:none">
        <div class="import-step-label">Step 3 — Assign to zone <span class="f-hint" style="display:inline">(skipped if Volunteer column is present)</span></div>
        <select id="import-zone-sel" class="f-input">${zoneOpts}</select>
      </div>
      <div id="import-preview" class="import-preview" style="display:none"></div>
    `, async () => {
      const rows = UI._importRows;
      if (!rows || !rows.length) { UI.toast('No rows to import', 'error'); return false; }

      // Block if any volunteer name errors
      if (rows.some(r => r.volunteerError)) {
        UI.toast('Fix unrecognized volunteer name(s) before importing', 'error'); return false;
      }
      // Block if any Nominatim results still pending confirmation
      if (rows.some(r => r.geocodeSource === 'nominatim' && !r.nominatimConfirmed)) {
        UI.toast('Confirm or skip the Nominatim-geocoded address(es) first', 'error'); return false;
      }

      const hasVolCol = rows.some(r => r.volunteer != null);
      const letter    = document.getElementById('import-zone-sel')?.value;

      if (hasVolCol) {
        const byZone = {};
        for (const r of rows) {
          if (!r.matched && !r.nominatimConfirmed) continue;
          const z = r.zoneLetter || letter;
          if (!z) continue;
          if (!byZone[z]) byZone[z] = [];
          byZone[z].push({ address: r.address, owner: r.owner || '', lat: r.lat, lon: r.lon });
        }
        const payloads = Object.entries(byZone).map(([l, houses]) => {
          const turf = App.state.turfs.find(t => t.letter === l);
          return { letter: l, color: turf?.color || CONFIG.TURF_COLORS[0], volunteer: turf?.volunteer || '[UNASSIGNED]', houses };
        });
        if (!payloads.length) { UI.toast('No importable rows', 'error'); return false; }
        await App.bulkImport(payloads);
      } else {
        if (!letter) { UI.toast('Select a zone', 'error'); return false; }
        const turf   = App.state.turfs.find(t => t.letter === letter);
        const houses = rows.filter(r => r.matched || r.nominatimConfirmed).map(r => ({
          address: r.address, owner: r.owner || '', lat: r.lat, lon: r.lon
        }));
        if (!houses.length) { UI.toast('No matched addresses to import', 'error'); return false; }
        await App.bulkImport([{ letter, color: turf?.color || CONFIG.TURF_COLORS[0], volunteer: turf?.volunteer || '[UNASSIGNED]', houses }]);
      }
      UI._importRows = null;
      return true;
    }, 'Import');
  },

  _downloadImportTemplate() {
    const csv = 'Address,Type,Volunteer\n123 Main St,hanger,Alice Smith\n456 Oak Ave,knock,Bob Jones\n789 Elm St,hanger,\n';
    const blob = new Blob([csv], { type: 'text/csv' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'chaka_import_template.csv';
    a.click();
    URL.revokeObjectURL(a.href);
  },

  _handleImportFile(input) {
    const file = input.files[0];
    if (!file) return;
    document.getElementById('import-file-label').textContent = '✓ ' + file.name;
    const reader = new FileReader();
    reader.onload = async (e) => {
      try {
        const lines = e.target.result.split(/\r?\n/).filter(l => l.trim());
        if (!lines.length) { UI.toast('Empty file', 'error'); return; }
        const header   = lines[0].split(',').map(h => h.trim().toLowerCase().replace(/"/g, ''));
        const addrIdx  = header.findIndex(h => h === 'address');
        const typeIdx  = header.findIndex(h => h === 'type');
        const volIdx   = header.findIndex(h => h === 'volunteer');
        if (addrIdx < 0) { UI.toast('CSV must have an "Address" column', 'error'); return; }

        // Build volunteer → zone letter lookup
        const volToZone = {};
        App.state.turfs.forEach(t => {
          if (t.volunteer && t.volunteer !== '[UNASSIGNED]')
            volToZone[t.volunteer.trim().toLowerCase()] = t.letter;
        });
        const allKnownNames = new Set([
          ...App.state.turfs.map(t => t.volunteer).filter(v => v && v !== '[UNASSIGNED]').map(v => v.trim().toLowerCase()),
          ...(UI._users || []).map(u => u.name.trim().toLowerCase()),
        ]);

        const parseCols = line => (line.match(/(".*?"|[^,]+|(?<=,)(?=,)|^(?=,)|(?<=,)$)/g) || line.split(','));

        const rows = lines.slice(1).map(line => {
          const cols = parseCols(line);
          const addr = (cols[addrIdx] || '').replace(/^"|"$/g, '').trim();
          const type = typeIdx >= 0 ? (cols[typeIdx] || '').replace(/^"|"$/g, '').trim().toLowerCase() : 'hanger';
          const vol  = volIdx  >= 0 ? (cols[volIdx]  || '').replace(/^"|"$/g, '').trim() : '';
          if (!addr) return null;
          const matches = ParcelsUtil.searchParcels(addr, 1);
          const match   = matches[0] || null;

          let volunteerError = null, zoneLetter = null;
          if (vol) {
            const key = vol.toLowerCase();
            if (!allKnownNames.has(key)) volunteerError = `"${vol}" not recognized`;
            else zoneLetter = volToZone[key] || null;
          }

          return {
            address: match ? match.address : addr,
            owner: match ? match.owner : '',
            lat: match ? match.lat : null,
            lon: match ? match.lon : null,
            type: type === 'knock' ? 'knock' : 'hanger',
            originalAddr: addr,
            matched: !!match,
            geocodeSource: match ? 'parcel' : null,
            nominatimConfirmed: false,
            volunteer: vol || null,
            volunteerError,
            zoneLetter,
          };
        }).filter(Boolean);

        UI._importRows = rows;
        UI._renderImportPreview(rows);

        // Nominatim pass for unmatched rows
        const unmatched = rows.filter(r => !r.matched);
        if (unmatched.length) {
          UI.toast(`Geocoding ${unmatched.length} unmatched address(es)…`, 'info');
          for (const row of unmatched) {
            await UI._nominatimGeocode(row);
            UI._renderImportPreview(UI._importRows);
            await new Promise(r => setTimeout(r, 1100));
          }
        }
      } catch(ex) {
        UI.toast('Could not parse CSV — check the format', 'error');
        console.error(ex);
      }
    };
    reader.readAsText(file);
  },

  async _nominatimGeocode(row) {
    const query = encodeURIComponent(row.originalAddr + ', Coppell TX');
    try {
      const resp = await fetch(`https://nominatim.openstreetmap.org/search?q=${query}&format=json&limit=1&countrycodes=us`, { headers: { 'Accept-Language': 'en' } });
      const data = await resp.json();
      if (data && data[0]) {
        row.lat = parseFloat(data[0].lat);
        row.lon = parseFloat(data[0].lon);
        row.address = data[0].display_name.split(',')[0].trim() || row.originalAddr;
        row.geocodeSource = 'nominatim';
        row.nominatimConfirmed = false;
      }
    } catch(e) { /* Nominatim unavailable — leave unmatched */ }
  },

  _confirmNominatim(idx, confirm) {
    const row = UI._importRows[idx];
    if (!row) return;
    if (confirm) { row.nominatimConfirmed = true; row.matched = true; }
    else { row.geocodeSource = null; row.lat = null; row.lon = null; }
    UI._renderImportPreview(UI._importRows);
  },

  _renderImportPreview(rows) {
    const previewEl = document.getElementById('import-preview');
    if (!previewEl) return;
    const matched    = rows.filter(r => r.matched || r.nominatimConfirmed).length;
    const pending    = rows.filter(r => r.geocodeSource === 'nominatim' && !r.nominatimConfirmed).length;
    const unmatched  = rows.filter(r => !r.matched && !r.geocodeSource).length;
    const nameErrors = rows.filter(r => r.volunteerError).length;
    const hasVolCol  = rows.some(r => r.volunteer != null);

    previewEl.style.display = 'block';
    previewEl.innerHTML = `
      <div class="import-summary">
        <span class="import-ok">✓ ${matched} matched</span>
        ${pending    ? `<span class="import-warn">⏳ ${pending} awaiting confirmation</span>` : ''}
        ${unmatched  ? `<span class="import-warn">✕ ${unmatched} not found</span>` : ''}
        ${nameErrors ? `<span class="import-err">⚠ ${nameErrors} unknown volunteer(s)</span>` : ''}
      </div>
      <div class="import-row-list">
        ${rows.map((r, i) => {
          let cls = 'imp-ok', icon = '✓', extra = '';
          if (r.volunteerError) {
            cls = 'imp-err'; icon = '⚠';
            extra = `<span class="imp-vol-err">${_esc(r.volunteerError)}</span>`;
          } else if (r.geocodeSource === 'nominatim' && !r.nominatimConfirmed) {
            cls = 'imp-nominatim'; icon = '⏳';
            extra = `<span class="imp-nominatim-label">${_esc(r.address)}</span>
              <button class="imp-confirm-btn" onclick="UI._confirmNominatim(${i},true)">✓ Use</button>
              <button class="imp-reject-btn" onclick="UI._confirmNominatim(${i},false)">✕ Skip</button>`;
          } else if (!r.matched && !r.nominatimConfirmed) {
            cls = 'imp-miss'; icon = '✕';
          }
          const volTag = hasVolCol && r.volunteer
            ? `<span class="imp-vol ${r.volunteerError ? 'imp-vol-bad' : ''}">${_esc(r.volunteer)}</span>`
            : '';
          return `<div class="import-row ${cls}">
            <span class="imp-icon">${icon}</span>
            <span class="imp-addr">${_esc(r.matched || r.nominatimConfirmed ? r.address : r.originalAddr)}</span>
            <span class="imp-type">${r.type}</span>
            ${volTag}${extra}
          </div>`;
        }).join('')}
      </div>`;
    const zoneRow = document.getElementById('import-zone-row');
    if (zoneRow) zoneRow.style.display = (matched > 0 && !hasVolCol) ? '' : 'none';
  },

  // ── Draw mode ───────────────────────────────────────────────────────────────
  toggleDrawMode() {
    const on  = TurfDraw.toggle();
    const btn = document.getElementById('draw-mode-btn');
    if (btn) {
      btn.textContent = on ? '✏️ Exit Draw' : '✏️ Draw Zone';
      btn.classList.toggle('active-admin-btn', on);
    }
    this._setDrawModeBanner(on);
  },

  _setDrawModeBanner(on) {
    document.getElementById('draw-mode-banner')?.remove();
    if (!on) return;
    const pill = document.createElement('div');
    pill.id = 'draw-mode-banner';
    pill.className = 'draw-mode-banner';
    pill.textContent = '✏️ Drawing Zone — click to place points';
    document.body.appendChild(pill);
  },

  // ── Pending zone saves indicator (sidebar) ─────────────────────────────────
  _updatePendingZonesBar(count) {
    let bar = document.getElementById('zone-pending-bar');
    if (!count) { bar?.remove(); return; }
    if (!bar) {
      bar = document.createElement('div');
      bar.id = 'zone-pending-bar';
      // Insert just before the turf-list element, inside the sidebar
      const list = document.getElementById('turf-list');
      list ? list.parentNode.insertBefore(bar, list) : document.getElementById('sidebar')?.appendChild(bar);
    }
    bar.className = 'zone-pending-bar';
    bar.innerHTML = `<span class="zpb-dot"></span>⏳ ${count} zone${count > 1 ? 's' : ''} saving…`;
  },

  // ── Edit boundary banner ────────────────────────────────────────────────────
  showEditBoundaryBanner(letter) {
    document.getElementById('edit-boundary-banner')?.remove();
    const banner = document.createElement('div');
    banner.id = 'edit-boundary-banner';
    banner.className = 'edit-boundary-banner';
    banner.innerHTML = `
      <span>Editing Zone <strong>${letter}</strong> boundary — drag vertices</span>
      <div class="ebb-btns">
        <button class="ebb-save" onclick="TurfDraw._commitEdit()">✓ Save</button>
        <button class="ebb-cancel" onclick="TurfDraw._cancelEditMode();UI.toast('Edit cancelled')">✕ Cancel</button>
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
    if (val) { const t = App.state.turfs.find(t => String(t.letter) === String(val)); if (t) MapModule.focusTurf(t); }
  },
  setVolunteerFilter(val) { this.volunteerFilter = val || null; App.render(); },
  setResultFilter(val) { this.resultFilter = val || null; App.render(); },
  setModeFilter(val)   { this.modeFilter   = val || null; App.render(); },
  setViewMode(val)     { this.viewMode     = val || null; App.render(); },

  // ── Stats bar ────────────────────────────────────────────────────────────────
  updateStats(turfs) {
    this._renderTop3();
    const bar = document.getElementById('stats-bar');
    if (!bar) return;

    // Hanger turfs only
    const hangerHouses = turfs.filter(t => (t.mode || 'hanger') === 'hanger').flatMap(t => t.houses);
    const hTotal   = hangerHouses.length;
    const hDone    = hangerHouses.filter(h => h.result === 'hanger' || h.result === 'skip' || h.result === 'not_home').length;
    const hHangers = hangerHouses.filter(h => h.result === 'hanger').length;
    const hPct     = hTotal ? Math.round(hDone / hTotal * 100) : 0;

    // Door knock turfs only
    const knockHouses = turfs.filter(t => (t.mode || 'hanger') === 'knock').flatMap(t => t.houses);
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
    this.updateMyProgress(turfs);
  },

  // ── Personal progress bar — shows assigned hanger progress for current user ──
  updateMyProgress(turfs) {
    const bar = document.getElementById('my-progress-bar');
    if (!bar || this.isAdmin) { if (bar) bar.style.display = 'none'; return; }

    // My hanger zones only
    const myTurfs = turfs.filter(t =>
      (t.mode || 'hanger') === 'hanger' && t.volunteer === this.currentUser
    );
    if (!myTurfs.length) { bar.style.display = 'none'; return; }

    const myHouses  = myTurfs.flatMap(t => t.houses);
    const myTotal   = myHouses.length;
    const myDone    = myHouses.filter(h => h.result === 'hanger' || h.result === 'skip' || h.result === 'not_home').length;
    const myHangers = myHouses.filter(h => h.result === 'hanger').length;
    const myPct     = myTotal ? Math.round(myDone / myTotal * 100) : 0;

    const col = {};
    CONFIG.RESULTS.forEach(r => { col[r.key] = r.color; });

    const hPct    = myTotal ? (myHouses.filter(h=>h.result==='hanger').length / myTotal * 100).toFixed(1) : 0;
    const sPct    = myTotal ? (myHouses.filter(h=>h.result==='skip').length   / myTotal * 100).toFixed(1) : 0;
    const nhPct   = myTotal ? (myHouses.filter(h=>h.result==='not_home').length / myTotal * 100).toFixed(1) : 0;

    bar.style.display = 'flex';
    bar.innerHTML = `
      <span class="my-prog-label">My Progress</span>
      <div class="my-prog-track">
        <div class="my-prog-seg" style="width:${hPct}%;background:${col.hanger}" title="Hangers: ${myHangers}"></div>
        <div class="my-prog-seg" style="width:${sPct}%;background:${col.skip}"   title="Skipped"></div>
        <div class="my-prog-seg" style="width:${nhPct}%;background:${col.not_home}" title="Not home"></div>
      </div>
      <span class="my-prog-pct">${myPct}%</span>
      <span class="my-prog-count">${myDone}/${myTotal}</span>`;
  },

  // ── Sidebar ──────────────────────────────────────────────────────────────────
  renderSidebar(turfs) {
    const sel = document.getElementById('vol-filter-sel');
    if (sel) {
      const cur = sel.value;
      const allTurfs = App.state.turfs;
      const volunteers = [...new Set(
        allTurfs.map(t => t.volunteer).filter(v => v && v !== '[UNASSIGNED]')
      )].sort();
      const volOpts = '<option value="">All Volunteers</option>' +
        '<option value="[UNASSIGNED]"' + (cur === '[UNASSIGNED]' ? ' selected' : '') + '>Unassigned</option>' +
        volunteers.map(v => `<option value="${_esc(v)}"${cur === v ? ' selected' : ''}>${_esc(v)}</option>`).join('');
      sel.innerHTML = volOpts;
      // Sync mobile volunteer dropdown
      const mmfVol = document.getElementById('mmf-vol');
      if (mmfVol) {
        const mmfCur = mmfVol.value;
        mmfVol.innerHTML = volOpts;
        mmfVol.value = mmfCur || this.volunteerFilter || '';
      }
    }

    const list = document.getElementById('turf-list');
    if (!list) return;
    // turfs arg already has viewMode applied by _visibleTurfs(); don't re-apply here.
    // Apply volunteer / zone filter on top of what was passed in.
    const filtered = this.volunteerFilter
      ? turfs.filter(t => {
          if (this.volunteerFilter === '[UNASSIGNED]') return !t.volunteer || t.volunteer === '[UNASSIGNED]';
          return t.volunteer === this.volunteerFilter;
        })
      : (this.turfFilter ? turfs.filter(t => String(t.letter) === String(this.turfFilter)) : turfs);

    if (!filtered.length) {
      list.innerHTML = `<div class="sb-empty">${this.isAdmin ? 'No zones yet. Use <strong>✏️ Draw Zone</strong> to create one.' : 'No data loaded.'}</div>`;
      return;
    }

    const sorted = [...filtered].sort((a, b) => {
      const aKnock = (a.mode || 'hanger') === 'knock' ? 0 : 1;
      const bKnock = (b.mode || 'hanger') === 'knock' ? 0 : 1;
      if (aKnock !== bKnock) return aKnock - bKnock;

      const me = UI.currentUser;
      const aUnassigned = !a.volunteer || a.volunteer === '[UNASSIGNED]';
      const bUnassigned = !b.volunteer || b.volunteer === '[UNASSIGNED]';

      // Group: my zones (0), unassigned (1), other volunteers (2)
      const aGroup = a.volunteer === me ? 0 : aUnassigned ? 1 : 2;
      const bGroup = b.volunteer === me ? 0 : bUnassigned ? 1 : 2;
      if (aGroup !== bGroup) return aGroup - bGroup;

      // Within assigned groups: sort by volunteer name alphabetically
      const aVol = aUnassigned ? '' : (a.volunteer || '');
      const bVol = bUnassigned ? '' : (b.volunteer || '');
      if (aVol !== bVol) return aVol.localeCompare(bVol);

      // Within same volunteer (or unassigned): sort numerically by zone letter
      const aNum = parseInt(a.letter, 10);
      const bNum = parseInt(b.letter, 10);
      if (!isNaN(aNum) && !isNaN(bNum)) return aNum - bNum;
      return String(a.letter).localeCompare(String(b.letter));
    });
    list.innerHTML = sorted.map((turf, i) => {
      const color     = _turfColor(turf);
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

      const inlineAssign = this.isAdmin ? (() => {
        const vols = [...new Set(App.state.turfs.map(t => t.volunteer).filter(v => v && v !== '[UNASSIGNED]'))].sort();
        const cur  = (!turf.volunteer || turf.volunteer === '[UNASSIGNED]') ? '' : turf.volunteer;
        const opts = `<option value="">— Unassigned —</option>` +
          vols.map(v => `<option value="${_esc(v)}"${cur === v ? ' selected' : ''}>${_esc(v)}</option>`).join('');
        return `<select class="turf-inline-assign" title="Assign volunteer"
          onclick="event.stopPropagation()"
          onchange="event.stopPropagation();UI._inlineAssignVolunteer('${turf.letter}',this.value)">${opts}</select>`;
      })() : '';

      const isKnock = (turf.mode || 'hanger') === 'knock';
      const isUnassigned = !turf.volunteer || turf.volunteer === '[UNASSIGNED]';
      const isMyZone = !this.isAdmin && turf.volunteer === this.currentUser;
      const claimBtn = !this.isAdmin && isUnassigned && !isKnock
        ? `<button class="claim-zone-btn" onclick="event.stopPropagation();UI._confirmClaimZone('${turf.letter}')">Claim Zone</button>`
        : '';
      const unclaimBtn = isMyZone && !isKnock
        ? `<button class="unclaim-zone-btn" onclick="event.stopPropagation();UI._confirmUnclaimZone('${turf.letter}')">Unclaim</button>`
        : '';
      return `<div class="${expanded ? 'turf-block turf-expanded' : 'turf-block'}${is100 ? ' turf-complete' : ''}${isKnock ? ' turf-knock' : ''}" id="turf-block-${turf.letter}">
        <div class="turf-header" style="--tc:${color}" onclick="UI._toggleTurf('${turf.letter}')">
          <div class="turf-letter-badge${isKnock ? ' knock-badge' : ''}" style="background:${isKnock ? '#b3a8c8' : color}">${isKnock ? '<span style="display:inline-block;transform:rotate(-45deg);font-size:14px;line-height:1">✊</span>' : turf.letter}</div>
          <div class="turf-info">
            ${this.isAdmin
              ? inlineAssign
              : `<div class="turf-volunteer">${isKnock ? '<strong>Knocks</strong>' : (isUnassigned ? '<em style="color:#9ca3af">Unassigned</em>' : _esc(turf.volunteer))}${is100 ? ' <span class="turf-complete-badge">✓ Complete!</span>' : ''}${claimBtn}${unclaimBtn}</div>`
            }
            ${isKnock && turf.volunteer && turf.volunteer !== '[UNASSIGNED]' ? `<div style="font-size:11px;color:#b3a8c8;margin-top:1px">◆ ${_esc(turf.volunteer)}</div>` : ''}
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
          ${houses.length > 0 ? `
          <div class="ms-bar" id="ms-bar-${turf.letter}">
            ${this._multiSelectTurf === turf.letter ? `
              <div class="ms-active-bar">
                <div class="ms-street-wrap">
                  <select class="ms-street-sel" onchange="UI._selectByStreet('${turf.letter}',this.value)">
                    <option value="">Select street…</option>
                    ${[...new Set(turf.houses.map(h => (h.address||'').replace(/^\d+\s*/,'').split(',')[0].trim()).filter(Boolean))].sort().map(s => `<option value="${_esc(s)}">${_esc(s)}</option>`).join('')}
                  </select>
                </div>
                <button class="ms-btn ms-all" onclick="UI._msSelectAll('${turf.letter}')">All</button>
                <button class="ms-btn ms-none" onclick="UI._msSelectNone('${turf.letter}')">None</button>
                <button class="ms-btn ms-apply" onclick="UI._msApply('${turf.letter}')">Apply (${this._multiSelectTurf === turf.letter ? this._selectedHouseIds.size : 0})</button>
                <button class="ms-btn ms-cancel" onclick="UI._msCancel()">✕</button>
              </div>
            ` : `
              <button class="ms-start-btn" onclick="event.stopPropagation();UI._msStart('${turf.letter}')">☑ Update Multiple</button>
            `}
          </div>` : ''}
          ${houseCards || `<div class="sb-empty-turf">No houses${this.resultFilter ? ' matching filter' : ''}.${this.isAdmin ? ' Draw a zone boundary to populate.' : ''}</div>`}
        </div>
      </div>`;
    }).join('');
  },


  async _confirmClaimZone(letter) {
    const user = App._getUserRecord();
    const ok = await this._confirm(
      `Claim Zone ${letter}`,
      `Assign Zone <strong>${letter}</strong> to <strong>${user.name}</strong>?<br><br>You'll be listed as the volunteer for this zone.`,
      'Claim Zone'
    );
    if (!ok) return;
    App.claimZone(letter);
  },

  async _confirmUnclaimZone(letter) {
    const ok = await this._confirm(
      `Unclaim Zone ${letter}`,
      `Remove yourself from Zone <strong>${letter}</strong>?<br><br>It will become unassigned.`,
      'Unclaim', true
    );
    if (!ok) return;
    App.unclaimZone(letter);
  },

  // ── Multi-select ──────────────────────────────────────────────────────────
  _msStart(letter) {
    // Coerce to number to match turf.letter from Sheets
    const key = isNaN(letter) ? letter : Number(letter);
    this._multiSelectTurf = key;
    this._selectedHouseIds = new Set();
    this._expandedTurfs.add(key);
    App.render();
    // Scroll to zone card so user sees the active multi-select bar
    setTimeout(() => {
      const el = document.getElementById('turf-block-' + letter);
      if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }, 100);
  },

  _msCancel() {
    this._multiSelectTurf = null;
    this._selectedHouseIds = new Set();
    App.render();
  },

  _msSelectAll(letter) {
    const turf = App.state.turfs.find(t => String(t.letter) === String(letter));
    if (!turf) return;
    const houses = this._filterHouses(turf.houses);
    houses.forEach(h => this._selectedHouseIds.add(h.id));
    App.render();
  },

  _msSelectNone(letter) {
    this._selectedHouseIds = new Set();
    App.render();
  },

  _selectByStreet(letter, streetName) {
    if (!streetName) return;
    const turf = App.state.turfs.find(t => String(t.letter) === String(letter));
    if (!turf) return;
    const houses = this._filterHouses(turf.houses);
    houses.forEach(h => {
      const st = (h.address || '').replace(/^\d+\s*/, '').split(',')[0].trim();
      if (st === streetName) this._selectedHouseIds.add(h.id);
    });
    App.render();
  },

  async _msApply(letter) {
    const ids = [...this._selectedHouseIds];
    if (!ids.length) { this.toast('No houses selected', 'info'); return; }
    const turf = App.state.turfs.find(t => String(t.letter) === String(letter));
    if (!turf) return;
    const isKnock = (turf.mode || 'hanger') === 'knock';
    const resultKey = isKnock ? 'knocked' : 'hanger';
    const resultDef = CONFIG.RESULTS.find(r => r.key === resultKey);

    const ok = await this._confirm(
      `Mark ${ids.length} as ${resultDef.label}`,
      `<div style="display:flex;align-items:center;gap:8px;font-size:14px">
        <span style="font-size:20px">${resultDef.icon}</span>
        <span>Apply <strong>${resultDef.label}</strong> to <strong>${ids.length}</strong> house${ids.length !== 1 ? 's' : ''}?</span>
      </div>`,
      `${resultDef.icon} Apply to ${ids.length}`
    );
    if (!ok) return;

    await App.applyMultiResult(ids, resultKey, null);
    // Clear selection after successful apply but keep multi-select mode active
    this._selectedHouseIds = new Set();
    App.render();
    this.toast(`Applied to ${ids.length} — select more or ✕ to exit`, 'success');
  },

  async _inlineAssignVolunteer(letter, volunteerName) {
    const turf = App.state.turfs.find(t => String(t.letter) === String(letter));
    if (!turf) return;
    const volunteer = volunteerName || '[UNASSIGNED]';
    const userRec = this._users.find(u => u.name === volunteer);
    const color   = userRec?.color || '#6b7280';
    try {
      const res = await SheetsAPI.updateTurf(letter, { volunteer, color });
      if (res?.error) { UI.toast(res.error, 'error'); return; }
      turf.volunteer = volunteer;
      turf.color     = color;
      App.render();
      UI.toast(`Zone ${letter} assigned to ${volunteer === '[UNASSIGNED]' ? 'nobody' : volunteer}`, 'success');
    } catch(e) { UI.toast('Failed to assign volunteer', 'error'); }
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

    // Done key depends on mode: hanger turfs → 'hanger', knock → 'knocked'
    const doneKey = (turf.mode || 'hanger') === 'knock' ? 'knocked' : 'hanger';
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

    const inMs = UI._multiSelectTurf === turf.letter;
    const isSelected = UI._selectedHouseIds.has(house.id);
    const numBg = inMs
      ? (isSelected ? '#2d9e5f' : '#d1d5db')
      : (result ? (resultDef?.color || '#9ca3af') : '#d1d5db');
    const numContent = inMs ? (isSelected ? '✓' : '') : streetNum;
    const numClass = `house-num${inMs ? ' ms-num' : ''}${isSelected ? ' ms-num-selected' : ''}`;

    const isComplex = house.house_type === 'apartment_complex';
    const complexBadge = isComplex
      ? `<span class="complex-badge">🏢${house.building_id ? ' Bldg ' + _esc(house.building_id) : ''}${house.unit_count ? ' · ' + house.unit_count + ' units' : ''}</span>`
      : '';

    return `<div class="house-card${result ? ' house-done' : ''}${isComplex ? ' complex-house' : ''}${house.id === UI._nextDoorId ? ' next-door' : ''}${inMs ? ' ms-mode' : ''}${isSelected ? ' ms-selected' : ''}" id="hcard-${house.id}"
      onclick="UI._cardClick('${house.id}')">
      <div class="${numClass}" style="background:${numBg}">${isComplex ? '🏢' : numContent}</div>
      <div class="house-body">
        <div class="house-addr">${_esc(house.address)}</div>
        ${house.owner && !isComplex ? `<div class="house-name">${_esc(house.owner)}</div>` : ''}
        ${complexBadge}
        ${house.notes ? `<div class="house-notes">${_esc(house.notes)}</div>` : ''}
        ${scriptHtml}
        <div class="house-footer">${badgeHtml}${attribution}</div>
      </div>
      <div class="house-quick">${quickBtns}</div>
      ${this.isAdmin ? `<button class="house-del-btn" title="Remove" onclick="event.stopPropagation();UI.confirmDeleteHouse('${house.id}')">✕</button>` : ''}
    </div>`;
  },

  _cardClick(houseId) {
    // In multi-select mode: toggle selection instead of opening popup
    if (this._multiSelectTurf) {
      const cached = window._houseCache?.[houseId];
      if (!cached || String(cached.turf.letter) !== String(this._multiSelectTurf)) return;
      if (this._selectedHouseIds.has(houseId)) {
        this._selectedHouseIds.delete(houseId);
      } else {
        this._selectedHouseIds.add(houseId);
      }
      App.render();
      return;
    }
    const cached = window._houseCache?.[houseId];
    if (!cached) return;
    MapModule.focusHouse(cached.house);
    MapModule._openHousePopup(cached.house, cached.turf, cached.color);
  },

  _toggleTurf(letter) {
    const key   = isNaN(letter) ? letter : Number(letter);
    const el    = document.getElementById('houses-' + letter);
    const chev  = document.getElementById('chev-' + letter);
    const block = document.getElementById('turf-block-' + letter);
    if (!el) return;
    const open = el.style.display !== 'none';
    el.style.display = open ? 'none' : 'block';
    if (chev)  chev.textContent = open ? '▸' : '▾';
    if (block) block.classList.toggle('turf-expanded', !open);
    if (open) this._expandedTurfs.delete(key); else this._expandedTurfs.add(key);
  },

  // ── Presence ─────────────────────────────────────────────────────────────────
  _knownPresenceNames: new Set(),
  updatePresence(users) {
    const bar = document.getElementById('presence-bar');
    if (!bar) return;
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
    const statusRing = (iso, me) => {
      if (me) return '#4ade80'; // always active green for self
      if (!iso) return '#6b7280';
      const s = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
      if (s < 120)  return '#4ade80'; // active — green
      if (s < 600)  return '#fbbf24'; // recent — yellow
      return '#6b7280';              // inactive — grey
    };
    // Look up assigned user color from _users list by name match
    const userColorFor = (name, me) => {
      if (me) {
        const found = this._users.find(u => u.name === name || u.email === this.currentEmail);
        return found?.color || '#2d9e5f';
      }
      const found = this._users.find(u => u.name === name);
      return found?.color || '#6b7280';
    };
    // Dedup: same person on multiple devices → keep most recent last_seen
    const others = users.filter(u => u.sessionId !== this.sessionId);
    const byName = {};
    others.forEach(u => {
      const key = (u.name || '').trim();
      if (!key) return;
      if (!byName[key] || new Date(u.last_seen) > new Date(byName[key].last_seen)) {
        byName[key] = u;
      }
    });
    const deduped = Object.values(byName).map(u => ({ ...u, me: false }));

    // "X joined 👋" toast for new arrivals
    const currentNames = new Set(deduped.map(u => (u.name || '').trim()).filter(Boolean));
    if (this._knownPresenceNames.size > 0) {
      for (const name of currentNames) {
        if (!this._knownPresenceNames.has(name)) {
          this.toast(`${name} joined 👋`, 'info');
        }
      }
    }
    this._knownPresenceNames = currentNames;

    const all = [
      { name: this.currentUser, sessionId: this.sessionId, me: true, last_seen: new Date().toISOString() },
      ...deduped
    ];
    bar.innerHTML = all.map(u => {
      const bgColor   = userColorFor(u.name, u.me);
      const ringColor = statusRing(u.last_seen, u.me);
      const tip = `${u.name}${u.me ? ' (you)' : ''} · ${timeAgo(u.last_seen)}`;
      return `<div class="presence-avatar" style="background:${bgColor};outline:2.5px solid ${ringColor};outline-offset:1px" title="${tip}">${initials(u.name)}</div>`;
    }).join('');
  },

  setOffline(off) { document.getElementById('offline-banner')?.classList.toggle('visible', off); },


  _showLegendModal() {
    const content = window._legendContent || '';
    this._modal('Map Legend', `<div class="map-legend" style="box-shadow:none;padding:0">${content}</div>`, null, null);
  },

  toast(msg, type = 'info', duration = 2800) {
    const t = document.createElement('div');
    t.className   = `toast toast-${type}`;
    t.textContent = msg;
    document.getElementById('toast-container')?.appendChild(t);
    requestAnimationFrame(() => t.classList.add('toast-show'));
    setTimeout(() => { t.classList.remove('toast-show'); setTimeout(() => t.remove(), 300); }, duration);
  },

  toastUndo(msg, onUndo) {
    // Remove any existing undo toast
    document.querySelector('.toast-undo')?.remove();
    const t = document.createElement('div');
    t.className = 'toast toast-success toast-undo';
    t.innerHTML = `<span>${msg}</span><button class="toast-undo-btn">Undo</button>`;
    document.getElementById('toast-container')?.appendChild(t);
    requestAnimationFrame(() => t.classList.add('toast-show'));
    const timer = setTimeout(() => { t.classList.remove('toast-show'); setTimeout(() => t.remove(), 300); }, 6000);
    t.querySelector('.toast-undo-btn').addEventListener('click', () => {
      clearTimeout(timer);
      t.classList.remove('toast-show');
      setTimeout(() => t.remove(), 300);
      onUndo();
    });
  },

  // ── Modal helper ──────────────────────────────────────────────────────────────
  _modal(title, bodyHtml, onConfirm, confirmLabel = 'Save', onCancel = null) {
    document.getElementById('modal-overlay')?.remove();
    const overlay = document.createElement('div');
    overlay.id    = 'modal-overlay';
    overlay.innerHTML = `
      <div class="modal-card">
        <div class="modal-header">
          <div class="modal-title">${title}</div>
          <button class="modal-close" id="modal-x-close">✕</button>
        </div>
        <div class="modal-body">${bodyHtml}</div>
        <div class="modal-footer">
          ${onConfirm ? `<button class="modal-cancel" id="modal-cancel-close">Cancel</button>` : ''}
          ${onConfirm ? `<button class="modal-confirm" id="modal-confirm-btn">${confirmLabel}</button>` : `<button class="modal-cancel" id="modal-cancel-close">Close</button>`}
        </div>
      </div>`;
    document.body.appendChild(overlay);
    const doCancel = () => { overlay.remove(); onCancel?.(); };
    overlay.addEventListener('click', e => { if (e.target === overlay) doCancel(); });
    document.getElementById('modal-x-close')?.addEventListener('click', doCancel);
    document.getElementById('modal-cancel-close')?.addEventListener('click', doCancel);
    if (onConfirm) {
      const confirmBtn = document.getElementById('modal-confirm-btn');
      if (confirmBtn) confirmBtn._origLabel = confirmLabel || 'Save';
      confirmBtn?.addEventListener('click', async () => {
        const btn = document.getElementById('modal-confirm-btn');
        if (btn) { btn.disabled = true; btn.textContent = 'Saving…'; }
        try {
          const result = await onConfirm();
          if (result !== false) overlay.remove();
        } catch(e) {
          UI.toast('Something went wrong — try again', 'error');
        } finally {
          if (btn && document.body.contains(btn)) {
            btn.disabled = false;
            btn.textContent = btn._origLabel || confirmLabel || 'Save';
          }
        }
      });
    }
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
    const turf = App.state.turfs.find(t => String(t.letter) === String(letter));
    if (!turf) return;
    const curMode = turf.mode || 'hanger';
    this._modal(`Edit Zone ${letter}`, `
      <label class="f-label">Zone Type</label>
      <select id="f-zone-mode" class="f-input">
        <option value="hanger"${curMode === 'hanger' ? ' selected' : ''}>🗂 Drop Hangers</option>
        <option value="knock"${curMode === 'knock' ? ' selected' : ''}>🚪 Door Knock</option>
      </select>
      <label class="f-label" style="margin-top:10px">Assigned Volunteer</label>
      ${this._userDropdownHtml(turf.volunteer)}
      <label class="f-label" style="margin-top:10px">Talking Points / Script (optional)</label>
      <input id="f-script" class="f-input" type="text" value="${_esc(turf._script || '')}" placeholder="e.g. Hi, I'm volunteering for Kevin Chaka…"/>
      ${turf.houses.length ? `
        <div class="clear-turf-row">
          <button class="clear-turf-btn" onclick="UI._confirmClearTurf('${letter}')">Clear All Houses</button>
          <span class="clear-turf-hint">${turf.houses.length} houses · ${turf.houses.filter(h=>h.result).length} with results</span>
        </div>` : ''}
    `, async () => {
      const mode      = document.getElementById('f-zone-mode')?.value || 'hanger';
      const sel       = document.getElementById('f-volunteer-sel');
      const volunteer = sel?.value || '[UNASSIGNED]';
      const opt       = sel?.options[sel.selectedIndex];
      const color = (opt?.dataset?.color && volunteer !== '[UNASSIGNED]')
        ? opt.dataset.color
        : '#6b7280';
      const script    = (document.getElementById('f-script')?.value || '').trim();
      await App.updateTurf(letter, { volunteer, color, mode });
      const t = App.state.turfs.find(x => x.letter === letter);
      if (t) t._script = script;
      return true;
    });
  },

  async _confirmClearTurf(letter) {
    document.getElementById('modal-overlay')?.remove();
    const turf = App.state.turfs.find(t => String(t.letter) === String(letter));
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
    const turf = App.state.turfs.find(t => String(t.letter) === String(letter));
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

      <div class="complex-toggle-row" style="margin:10px 0 8px">
        <label class="hide-done-toggle">
          <input type="checkbox" id="f-is-complex" onchange="UI._toggleComplexFields()"/>
          Apartment Complex
        </label>
      </div>

      <div id="complex-fields" style="display:none">
        <label class="f-label">Complex Name</label>
        <input id="f-complex-name" class="f-input" type="text" placeholder="e.g. Townlake of Coppell" autocomplete="off"/>
        <label class="f-label" style="margin-top:8px">Building ID</label>
        <input id="f-building-id" class="f-input" type="text" placeholder="e.g. A, B, 1, 2..." autocomplete="off"/>
        <label class="f-label" style="margin-top:8px">Units in This Building</label>
        <input id="f-unit-count" class="f-input" type="number" min="1" placeholder="e.g. 20"/>
        <label class="f-label" style="margin-top:8px">Address</label>
        <input id="f-complex-addr" class="f-input" type="text" placeholder="e.g. 215 N Moore Rd" autocomplete="off"/>
        ${(CONFIG.COMPLEX_PRESETS||[]).length ? `
        <div class="f-hint" style="margin-top:8px">Or quick-fill from a known complex:</div>
        <select id="f-preset-sel" class="f-input" onchange="UI._fillComplexPreset()" style="margin-top:4px">
          <option value="">— Select preset —</option>
          ${CONFIG.COMPLEX_PRESETS.map((p,i) => `<option value="${i}">${_esc(p.name)} (${p.totalUnits} units, ~${p.buildingCount} bldgs)</option>`).join('')}
        </select>` : ''}
        <div class="f-hint" style="margin-top:6px">Click on the map after closing to place the marker, or enter coordinates below.</div>
        <div style="display:flex;gap:8px;margin-top:4px">
          <input id="f-complex-lat" class="f-input" type="number" step="0.000001" placeholder="Lat"/>
          <input id="f-complex-lon" class="f-input" type="number" step="0.000001" placeholder="Lon"/>
        </div>
      </div>

      <div id="standard-fields">
        <label class="f-label">Search address or owner</label>
        <input id="parcel-search" class="f-input" type="text" placeholder="e.g. 745 Canongate or SMITH"
          oninput="UI._updateParcelResults()" autocomplete="off"/>
        <div id="parcel-results" class="parcel-results"></div>
        <div id="parcel-selected" class="parcel-selected" style="display:none"></div>
      </div>
    `, () => {
      const zone = document.getElementById('f-turf')?.value;
      if (!zone) { this.toast('Select a zone', 'error'); return false; }

      const isComplex = document.getElementById('f-is-complex')?.checked;
      if (isComplex) {
        const name      = (document.getElementById('f-complex-name')?.value || '').trim();
        const buildingId = (document.getElementById('f-building-id')?.value || '').trim();
        const unitCount = parseInt(document.getElementById('f-unit-count')?.value || '', 10) || null;
        const addr      = (document.getElementById('f-complex-addr')?.value || '').trim() || name;
        const lat       = parseFloat(document.getElementById('f-complex-lat')?.value || '');
        const lon       = parseFloat(document.getElementById('f-complex-lon')?.value || '');
        if (!addr) { this.toast('Enter a complex name or address', 'error'); return false; }
        if (isNaN(lat) || isNaN(lon)) { this.toast('Enter coordinates for the complex (or place on map)', 'error'); return false; }
        App.addHouse({
          turf: zone, address: addr, owner: name, lat, lon,
          house_type: 'apartment_complex', unit_count: unitCount,
          building_id: buildingId, complex_name: name,
        });
        return true;
      }

      const selected = UI._selectedParcel;
      if (!selected) { this.toast('Select a parcel from the results', 'error'); return false; }
      App.addHouse({ turf: zone, address: selected.address, owner: selected.owner, lat: selected.lat, lon: selected.lon });
      UI._selectedParcel = null;
      return true;
    }, 'Add House');

    UI._selectedParcel = null;
    setTimeout(() => document.getElementById('parcel-search')?.focus(), 80);
  },

  _toggleComplexFields() {
    const on = document.getElementById('f-is-complex')?.checked;
    document.getElementById('complex-fields').style.display = on ? '' : 'none';
    document.getElementById('standard-fields').style.display = on ? 'none' : '';
    if (on) setTimeout(() => document.getElementById('f-complex-name')?.focus(), 50);
    else     setTimeout(() => document.getElementById('parcel-search')?.focus(), 50);
  },

  _fillComplexPreset() {
    const sel = document.getElementById('f-preset-sel');
    if (!sel || sel.value === '') return;
    const preset = CONFIG.COMPLEX_PRESETS[parseInt(sel.value)];
    if (!preset) return;
    const nameEl = document.getElementById('f-complex-name');
    const addrEl = document.getElementById('f-complex-addr');
    const latEl  = document.getElementById('f-complex-lat');
    const lonEl  = document.getElementById('f-complex-lon');
    const unitEl = document.getElementById('f-unit-count');
    if (nameEl) nameEl.value = preset.name;
    if (addrEl) addrEl.value = preset.address;
    if (latEl)  latEl.value  = preset.lat;
    if (lonEl)  lonEl.value  = preset.lon;
    if (unitEl) unitEl.value = preset.unitsPerBuilding;
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

  // ── Address search bar (#7) ────────────────────────────────────────────────
  _addrSearchTimer: null,
  _addrSearchInput() {
    clearTimeout(this._addrSearchTimer);
    this._addrSearchTimer = setTimeout(() => {
      const q = (document.getElementById('addr-search-input')?.value || '').trim();
      const box = document.getElementById('addr-search-results');
      if (!box) return;
      if (q.length < 2) { box.style.display = 'none'; box.innerHTML = ''; return; }
      const matches = ParcelsUtil.searchParcels(q, 3);
      if (!matches.length) { box.innerHTML = '<div class="asr-empty">No results</div>'; box.style.display = 'block'; return; }
      box.innerHTML = matches.map((p, i) =>
        `<div class="asr-row" onclick="UI._addrSearchSelect(${i})" data-idx="${i}">
          <div class="asr-addr">${_esc(p.address)}</div>
          <div class="asr-owner">${_esc(p.owner)}</div>
        </div>`
      ).join('');
      box._matches = matches;
      box.style.display = 'block';
    }, 200);
  },

  _addrSearchKey(e) {
    if (e.key === 'Escape') {
      const box = document.getElementById('addr-search-results');
      if (box) { box.style.display = 'none'; box.innerHTML = ''; }
      document.getElementById('addr-search-input').value = '';
    }
  },

  _addrSearchSelect(idx) {
    const box = document.getElementById('addr-search-results');
    if (!box?._matches) return;
    const p = box._matches[idx];
    box.style.display = 'none';
    box.innerHTML = '';
    document.getElementById('addr-search-input').value = '';
    // Pan map and open house popup if tracked
    MapModule.map.setView([p.lat, p.lon], Math.max(MapModule.map.getZoom(), 18));
    // Find if this address is a tracked house
    for (const turf of App.state.turfs) {
      const house = turf.houses.find(h => h.address.toUpperCase().trim() === p.address.toUpperCase().trim());
      if (house) {
        const color = _turfColor(turf);
        setTimeout(() => MapModule._openHousePopup(house, turf, color), 400);
        return;
      }
    }
  },

  // ── Add Knock Location — admin search-based (#8) ───────────────────────────
  showAddKnockModal() {
    // Build volunteer options from known users and turf assignees
    const allVolunteers = [...new Set([
      ...(UI._users || []).map(u => u.name),
      ...App.state.turfs.map(t => t.volunteer).filter(v => v && v !== '[UNASSIGNED]'),
    ])].sort();
    const volOpts = '<option value="">— No volunteer assigned —</option>' +
      allVolunteers.map(v => `<option value="${_esc(v)}">${_esc(v)}</option>`).join('');

    // Find or auto-create the Knocks zone (mode=knock, letter=K)
    const knockTurf = App.state.turfs.find(t => (t.mode || 'hanger') === 'knock');

    this._modal('Add Knock Location', `
      <div class="f-hint" style="margin-bottom:10px">
        Knock locations go into the shared <strong>Knocks</strong> zone. Address is optional —
        you can also <strong>place on map</strong> by clicking after closing this dialog.
      </div>
      <label class="f-label">Volunteer (optional)</label>
      <select id="f-knock-vol" class="f-input">${volOpts}</select>
      <label class="f-label" style="margin-top:10px">Search address (optional)</label>
      <input id="parcel-search" class="f-input" type="text" placeholder="e.g. 745 Canongate — leave blank to place on map"
        oninput="UI._updateParcelResults()" autocomplete="off"/>
      <div id="parcel-results" class="parcel-results"></div>
      <div id="parcel-selected" class="parcel-selected" style="display:none"></div>
      <div style="margin-top:10px;display:flex;align-items:center;gap:8px">
        <button class="import-template-btn" style="flex:1" onclick="UI._startKnockMapPlace();UI._closeModal()">
          📍 Place on Map Instead
        </button>
      </div>
    `, async () => {
      const selected  = UI._selectedParcel;
      const volunteer = document.getElementById('f-knock-vol')?.value || '';

      // Ensure knock zone exists — create it if not
      let knockLetter = knockTurf?.letter;
      if (!knockLetter) {
        const usedLetters = new Set(App.state.turfs.map(t => t.letter));
        knockLetter = 'K';
        if (usedLetters.has('K')) {
          let n = 1;
          while (usedLetters.has('K' + n)) n++;
          knockLetter = 'K' + n;
        }
        try {
          await SheetsAPI.addTurf(knockLetter, '#b3a8c8', volunteer || '[UNASSIGNED]', 'knock');
          await App.loadData();
        } catch(e) { UI.toast('Failed to create Knocks zone', 'error'); return false; }
      } else if (volunteer) {
        // Update volunteer on existing knock turf if one is specified
        await SheetsAPI.updateTurf(knockLetter, { volunteer }).catch(() => {});
      }

      if (selected) {
        // Address was selected from parcel search
        await App.addHouse({ turf: knockLetter, address: selected.address, owner: selected.owner, lat: selected.lat, lon: selected.lon });
      } else {
        // No address — switch to map-click placement mode after modal closes
        UI._pendingKnockTurf = knockLetter;
        UI._startKnockMapPlace();
      }
      UI._selectedParcel = null;
      return true;
    }, 'Add Knock');
    UI._selectedParcel = null;
    setTimeout(() => document.getElementById('parcel-search')?.focus(), 80);
  },

  _closeModal() {
    document.getElementById('modal-overlay')?.remove();
  },

  _pendingKnockTurf: null,

  _startKnockMapPlace() {
    const letter = UI._pendingKnockTurf || (App.state.turfs.find(t => (t.mode||'hanger')==='knock')?.letter) || 'K';
    UI._pendingKnockTurf = letter;
    UI._mapTapPending = true;
    UI.toast('Click the map to place a knock location', 'info');
    // Banner so user knows they're in placement mode
    const existing = document.getElementById('knock-place-banner');
    if (existing) return;
    const banner = document.createElement('div');
    banner.id = 'knock-place-banner';
    banner.className = 'edit-boundary-banner';
    banner.innerHTML = `<span>📍 Click anywhere on the map to place a knock location</span>
      <div class="ebb-btns">
        <button class="ebb-cancel" onclick="UI._cancelKnockMapPlace()">✕ Cancel</button>
      </div>`;
    document.body.appendChild(banner);
  },

  _cancelKnockMapPlace() {
    UI._mapTapPending = false;
    UI._pendingKnockTurf = null;
    document.getElementById('knock-place-banner')?.remove();
  },

  // ── Admin: edit user color (#16) ───────────────────────────────────────────
  showEditUserColorModal() {
    if (!this._users.length) { this.toast('No users found', 'error'); return; }
    const palette = this._userColorPalette;
    const userOpts = this._users.map(u =>
      `<option value="${_esc(u.email)}">${_esc(u.name)} (${_esc(u.email)})</option>`
    ).join('');
    this._modal('Edit User Color', `
      <label class="f-label">User</label>
      <select id="euc-user" class="f-input" onchange="UI._previewUserColor()">${userOpts}</select>
      <label class="f-label" style="margin-top:8px">New color</label>
      <div class="color-swatch-row" id="euc-swatches">
        ${palette.map(c => `<div class="color-swatch euc-sw" style="background:${c}" data-color="${c}" onclick="UI._selectUserColor('${c}')"></div>`).join('')}
      </div>
      <div id="euc-preview" style="margin-top:8px;display:flex;align-items:center;gap:8px">
        <div id="euc-dot" style="width:22px;height:22px;border-radius:50%;border:2px solid #ccc"></div>
        <span id="euc-name" style="font-weight:700;font-size:13px"></span>
      </div>
    `, async () => {
      const email = document.getElementById('euc-user')?.value;
      const color = UI._selectedUserColor;
      if (!color) { UI.toast('Pick a color', 'error'); return false; }
      try {
        await SheetsAPI.updateUser(email, { color });
        const u = this._users.find(u => u.email === email);
        if (u) u.color = color;
        UI._selectedUserColor = null;
        App.render();
        UI.toast('User color updated', 'success');
        return true;
      } catch(e) { UI.toast('Failed to update color', 'error'); return false; }
    }, 'Save Color');
    UI._selectedUserColor = null;
    setTimeout(() => UI._previewUserColor(), 80);
  },

  _selectedUserColor: null,

  _selectUserColor(color) {
    UI._selectedUserColor = color;
    document.querySelectorAll('.euc-sw').forEach(el => {
      el.style.outline = el.dataset.color === color ? '3px solid #000' : '';
    });
    const dot = document.getElementById('euc-dot');
    if (dot) dot.style.background = color;
  },

  _previewUserColor() {
    const sel   = document.getElementById('euc-user');
    const email = sel?.value;
    const u     = this._users.find(u => u.email === email);
    if (!u) return;
    const dot  = document.getElementById('euc-dot');
    const name = document.getElementById('euc-name');
    if (dot)  dot.style.background = UI._selectedUserColor || u.color || '#6b7280';
    if (name) name.textContent = u.name;
  },

  async confirmDeleteHouse(id) {
    const ok = await this._confirm('Remove House', 'Remove this house from the zone?', 'Remove', true);
    if (!ok) return;
    App.removeHouse(id);
  },

  // ── Zone stats popup (clicking zone number on map) ────────────────────────
  showZoneStatsPopup(letter) {
    const turf = App.state.turfs.find(t => String(t.letter) === String(letter));
    if (!turf) return;
    const total     = turf.houses.length;
    const contacted = turf.houses.filter(h => h.result && h.result !== 'skip').length;
    const pct       = total ? Math.round(contacted / total * 100) : 0;
    const isKnock   = (turf.mode || 'hanger') === 'knock';
    const color     = _turfColor(turf);
    const isUnassigned = !turf.volunteer || turf.volunteer === '[UNASSIGNED]';

    // Result breakdown
    const breakdown = CONFIG.RESULTS
      .filter(r => isKnock ? ['knocked','not_home','refused'].includes(r.key) : ['hanger','skip','not_home'].includes(r.key))
      .map(r => {
        const cnt = turf.houses.filter(h => h.result === r.key).length;
        return cnt ? `<div class="zsb-row"><span>${r.icon} ${r.label}</span><strong>${cnt}</strong></div>` : '';
      }).join('');

    const claimBtn = !this.isAdmin && isUnassigned
      ? `<button class="modal-confirm" style="margin-top:12px;width:100%" onclick="App.claimZone('${letter}');document.getElementById('modal-overlay')?.remove()">Claim Zone ${letter}</button>`
      : '';
    const jumpBtn = `<button class="modal-cancel" style="margin-top:8px;width:100%" onclick="document.getElementById('modal-overlay')?.remove();setTimeout(()=>{const el=document.getElementById('turf-block-${letter}');if(el){el.scrollIntoView({behavior:'smooth',block:'center'});el.style.outline='3px solid ${color}';setTimeout(()=>el.style.outline='',1500);}},100)">Jump to Zone in List</button>`;

    const msBtn = `<button class="modal-cancel" style="margin-top:8px;width:100%;background:#e8f0fc;color:#2e6ec2;border-color:#2e6ec2;font-weight:700" onclick="document.getElementById('modal-overlay')?.remove();UI._msStart('${letter}')">☑ Edit Multiple</button>`;

    this._modal(`Zone ${letter}`, `
      <div style="display:flex;align-items:center;gap:10px;margin-bottom:12px">
        <div style="width:36px;height:36px;border-radius:50%;background:${color};display:flex;align-items:center;justify-content:center;color:#fff;font-weight:800;font-size:15px;flex-shrink:0">${isKnock ? '✊' : letter}</div>
        <div>
          <div style="font-weight:700;font-size:14px">${isKnock ? 'Knock Zone' : (isUnassigned ? '<em style="color:#9ca3af">Unassigned</em>' : _esc(turf.volunteer))}</div>
          <div style="font-size:12px;color:var(--text3)">${total} houses · ${pct}% complete</div>
        </div>
      </div>
      <div class="turf-prog-track" style="width:100%;height:8px;border-radius:4px;background:var(--border);overflow:hidden;margin-bottom:12px">
        <div style="width:${pct}%;height:100%;background:${color};border-radius:4px;transition:width 0.4s"></div>
      </div>
      <div class="zsb-breakdown">${breakdown || '<div style="color:var(--text3);font-size:12px">No contacts recorded yet</div>'}</div>
      ${claimBtn}
      ${msBtn}
      ${jumpBtn}
    `, null, null);
  },

  // ── Admin zone popup — clicking zone marker in admin mode ────────────────
  showZoneAdminPopup(letter) {
    const turf = App.state.turfs.find(t => String(t.letter) === String(letter));
    if (!turf) return;
    const color = _turfColor(turf);
    const isKnock = (turf.mode || 'hanger') === 'knock';
    const isUnassigned = !turf.volunteer || turf.volunteer === '[UNASSIGNED]';
    const total = turf.houses.length;
    const contacted = turf.houses.filter(h => h.result && h.result !== 'skip').length;
    const pct = total ? Math.round(contacted / total * 100) : 0;

    this._modal(`Zone ${letter} — Admin`, `
      <div style="display:flex;align-items:center;gap:10px;margin-bottom:14px">
        <div style="width:36px;height:36px;border-radius:50%;background:${color};display:flex;align-items:center;justify-content:center;color:#fff;font-weight:800;font-size:15px;flex-shrink:0">${isKnock ? '✊' : letter}</div>
        <div>
          <div style="font-weight:700;font-size:14px">${isKnock ? 'Knock Zone' : (isUnassigned ? '<em style="color:#9ca3af">Unassigned</em>' : _esc(turf.volunteer))}</div>
          <div style="font-size:12px;color:var(--text3)">${total} houses · ${pct}% complete</div>
        </div>
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:4px">
        <button class="admin-btn" style="padding:8px;font-size:12px" onclick="document.getElementById('modal-overlay')?.remove();UI.showEditTurfModal('${letter}')">✎ Edit Volunteer</button>
        <button class="admin-btn" style="padding:8px;font-size:12px" onclick="document.getElementById('modal-overlay')?.remove();TurfDraw.startEditBoundary('${letter}')">⬡ Edit Boundary</button>
        <button class="admin-btn" style="padding:8px;font-size:12px" onclick="document.getElementById('modal-overlay')?.remove();TurfDraw.resortTurf('${letter}',MapModule.getCurrentLatLon())">🔄 Re-sort Walk</button>
        <button class="admin-btn danger" style="padding:8px;font-size:12px;background:#fee2e2;border-color:#fca5a5;color:#c44848" onclick="document.getElementById('modal-overlay')?.remove();setTimeout(()=>UI.confirmDeleteTurf('${letter}'),50)">✕ Delete Zone</button>
      </div>
      <button class="modal-cancel" style="width:100%;margin-top:6px;background:#e8f0fc;color:#2e6ec2;border-color:#2e6ec2;font-weight:700" onclick="document.getElementById('modal-overlay')?.remove();UI._msStart('${letter}')">☑ Edit Multiple</button>
      <button class="modal-cancel" style="width:100%;margin-top:6px" onclick="document.getElementById('modal-overlay')?.remove();setTimeout(()=>{const el=document.getElementById('turf-block-${letter}');if(el){el.scrollIntoView({behavior:'smooth',block:'center'});el.style.outline='3px solid ${color}';setTimeout(()=>el.style.outline='',1500);}},100)">Jump to Zone in List</button>
    `, null, null);
  },

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
    document.getElementById('knock-place-banner')?.remove();

    // Knock placement mode (admin)
    if (UI._pendingKnockTurf !== null) {
      const letter = UI._pendingKnockTurf;
      UI._pendingKnockTurf = null;
      UI._modal('Confirm Knock Location', `
        <div class="f-hint">Placing knock at:<br><strong>${latlng.lat.toFixed(6)}, ${latlng.lng.toFixed(6)}</strong></div>
        <label class="f-label" style="margin-top:10px">Address label (optional)</label>
        <input id="knock-addr-input" class="f-input" type="text" placeholder="Leave blank if unknown" autocomplete="off"/>
      `, async () => {
        const addr = document.getElementById('knock-addr-input')?.value.trim() || '';
        await App.addHouse({ turf: letter, address: addr, owner: '', lat: latlng.lat, lon: latlng.lng });
        return true;
      }, 'Place Here');
      return;
    }
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

    // Build zone dropdown (auto-selected if detected, Unassigned option when outside)
    const unassignedOpt = `<option value="[UNASSIGNED]"${!autoZone ? ' selected' : ''}>— Unassigned (no zone) —</option>`;
    const turfOpts = unassignedOpt + App.state.turfs.map(t =>
      `<option value="${t.letter}"${t.letter === autoZone ? ' selected' : ''}>${t.letter} — ${_esc(t.volunteer)}</option>`
    ).join('');

    const zoneHint = autoZone
      ? `<div class="f-hint" style="color:#2d9e5f;margin-bottom:4px">Detected Zone ${autoZone} — change if wrong</div>`
      : `<div class="f-hint" style="color:#c9831a;margin-bottom:4px">Outside all zone boundaries — will be unassigned</div>`;

    // #5 Cancel helper — always cleans up the tap marker
    const cleanupTapMarker = () => {
      if (this._mapTapMarker) { MapModule.map.removeLayer(this._mapTapMarker); this._mapTapMarker = null; }
    };

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
      App.addHouse({ turf: turf || '[UNASSIGNED]', address: addr, owner: '', lat: latlng.lat, lon: latlng.lng });
      cleanupTapMarker();
      return true;
    }, 'Add House');

    // #5 Patch cancel/close/backdrop to also remove marker
    requestAnimationFrame(() => {
      const overlay = document.getElementById('modal-overlay');
      if (!overlay) return;
      const origRemove = overlay.remove.bind(overlay);
      overlay.remove = () => { cleanupTapMarker(); origRemove(); };
    });
  },

  // ── Zone completion chat announcement ─────────────────────────────────────
  _completedZones: new Set(JSON.parse(localStorage.getItem('ck_completed_zones') || '[]')),
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
        localStorage.setItem('ck_completed_zones', JSON.stringify([...this._completedZones]));
        const msg = `📣 Zone ${turf.letter} is complete — great work, ${_esc(turf.volunteer)}! (${total}/${total} houses)`;
        SheetsAPI.sendChat('System', 'system', msg).catch(() => {});
      }
    });
  },
  toggleChat() {
    let panel = document.getElementById('chat-panel');
    if (!panel) this._buildMobileChatPanel();
    panel = document.getElementById('chat-panel');
    const isOpen = panel.classList.toggle('open');
    this._chatOpen = isOpen;
    // Manage backdrop for click-outside-to-close
    let backdrop = document.getElementById('chat-backdrop');
    if (isOpen) {
      if (!backdrop) {
        backdrop = document.createElement('div');
        backdrop.id = 'chat-backdrop';
        backdrop.className = 'chat-backdrop';
        backdrop.onclick = () => this.toggleChat();
        document.body.appendChild(backdrop);
      }
      backdrop.classList.add('active');
      this._chatUnread = 0;
      this._clearUnreadBadges();
      setTimeout(() => document.getElementById('chat-input')?.focus(), 120);
      this._scrollChatBottom('chat-messages');
    } else {
      if (backdrop) backdrop.classList.remove('active');
      this._chatOpen = false;
    }
  },

  closeChat() {
    const panel = document.getElementById('chat-panel');
    if (panel?.classList.contains('open')) this.toggleChat();
  },

  _buildMobileChatPanel() {
    const panel = document.createElement('div');
    panel.id = 'chat-panel';
    panel.innerHTML = `
      <div class="chat-header">
        <span class="chat-title">Team Chat</span>
        <button class="chat-close" id="chat-close-btn">✕</button>
      </div>
      <div class="chat-messages" id="chat-messages"></div>
      <div class="chat-input-row">
        <input id="chat-input" class="chat-input" type="text" placeholder="Message the team..." maxlength="280"
          onkeydown="if(event.key==='Enter')UI._sendChat()"/>
        <button class="chat-send" onclick="UI._sendChat()">Send</button>
      </div>`;
    document.body.appendChild(panel);
    // Bind close button via addEventListener to avoid inline onclick issues
    document.getElementById('chat-close-btn')?.addEventListener('click', (e) => {
      e.stopPropagation();
      UI.closeChat();
    });
    // ESC key closes chat
    panel.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') UI.closeChat();
    });
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
    const optId = '_opt_' + Date.now();
    const optimistic = { id: optId, timestamp: now, name: this.currentUser,
      session_id: this.sessionId, message: msg, ts: Date.now() };
    this._chatMessages = [...(this._chatMessages || []), optimistic];
    this._renderChatMessages('sc-messages');
    if (this._chatOpen) this._renderChatMessages('chat-messages');
    // Always scroll to bottom on own send regardless of scroll position
    this._scrollChatBottom('sc-messages');
    if (this._chatOpen) this._scrollChatBottom('chat-messages');
    // Send then fetch — _fetchChat will replace optimistic with real message
    SheetsAPI.sendChat(this.currentUser, this.sessionId, msg)
      .then(() => this._fetchChat())
      .catch(() => this.toast('Failed to send - check connection', 'error'));
  },

  async _fetchChat() {
    try {
      const data = await SheetsAPI.getChat();
      if (!data.messages) return;
      const serverMsgs = data.messages.map(m => ({ ...m, ts: new Date(m.timestamp).getTime() }));
      // Merge: keep optimistic messages that don't yet have a server match
      const optimistic = (this._chatMessages || []).filter(m => String(m.id).startsWith('_opt_'));
      const merged = [...serverMsgs];
      optimistic.forEach(opt => {
        // Match by sender + message text + timestamp within 30s
        const match = serverMsgs.find(s =>
          s.name === opt.name && s.message === opt.message &&
          Math.abs(s.ts - opt.ts) < 30000
        );
        if (!match) merged.push(opt); // keep optimistic until server catches up
      });
      merged.sort((a, b) => a.ts - b.ts);
      this._chatMessages = merged;
      if (!this._chatLastSeen && this._chatMessages.length) {
        this._chatLastSeen = Math.max(...this._chatMessages.map(m => m.ts));
        this._chatUnread = 0;
      }
      const unread = this._chatMessages.filter(m =>
        m.ts > (this._chatLastSeen || 0) && (m.session_id || m.sessionId) !== this.sessionId
      ).length;
      if (!this._chatOpen && unread > 0) {
        this._chatUnread = unread;
        this._updateUnreadBadges();
      } else if (this._chatOpen) {
        this._chatUnread = 0;
        this._clearUnreadBadges();
        if (this._chatMessages.length) this._chatLastSeen = Math.max(...this._chatMessages.map(m => m.ts));
      }
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
    const isStrip = elId === 'sc-messages' || elId === 'chat-messages';
    const display = isStrip ? msgs.slice(-50) : msgs;
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
      if (dateStr !== lastDate) {
        lastDate = dateStr;
        html += `<div class="chat-date-bar"><span>${dateStr}</span></div>`;
      }
      if (isStrip) {
        const nameColor = isMe ? '#9ca3af' : (this._users.find(u => u.name === m.name)?.color || 'var(--header-bg)');
        const nameStr = isMe ? 'You' : _esc(m.name);
        html += `<div class="sc-msg ${isMe ? 'sc-mine' : 'sc-theirs'}">
          <div class="sc-msg-header"><span class="sc-name" style="color:${nameColor}">${nameStr}:</span><span class="sc-time">${timeStr}</span></div>
          <div class="sc-bubble">${_esc(m.message)}</div>
        </div>`;
      } else {
        const nameStr = isMe ? 'You' : _esc(m.name || 'Unknown');
        const nameColor = isMe ? '#9ca3af' : (this._users.find(u => u.name === m.name)?.color || 'var(--header-bg)');
        html += `<div class="chat-msg ${isMe ? 'chat-mine' : 'chat-theirs'}">
          <div class="chat-name" style="color:${nameColor}">${nameStr}:</div>
          <div class="chat-bubble">${_esc(m.message)}</div>
          <div class="chat-time">${timeStr}</div>
        </div>`;
      }
      return html;
    }).join('');
    // Always scroll to bottom on initial load; after that only if near bottom
    const scrollEl = document.getElementById(elId);
    if (scrollEl) {
      const isInitial = scrollEl.scrollTop === 0 && scrollEl.scrollHeight > scrollEl.clientHeight;
      const nearBottom = scrollEl.scrollHeight - scrollEl.scrollTop - scrollEl.clientHeight < 60;
      if (isInitial || nearBottom) this._scrollChatBottom(elId);
    }
  },

  _scrollChatBottom(elId) {
    const el = document.getElementById(elId || 'sc-messages');
    if (el) el.scrollTop = el.scrollHeight;
  },

  _syncMobileFilter() {
    const mmf = document.getElementById('mmf-view');
    const sel = document.getElementById('view-mode-sel');
    if (mmf && sel) sel.value = mmf.value;
  },

  startChatPoll() {
    this._fetchChat();
    this._chatPollTimer = setInterval(() => {
      if (!navigator.onLine || document.visibilityState === 'hidden') return;
      this._fetchChat();
    }, 5000);
  },
};
