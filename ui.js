// ─── UI Module ────────────────────────────────────────────────────────────────

const UI = {
  isAdmin:      false,
  currentUser:  '',
  turfFilter:   null,
  resultFilter: null,
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
      this._postLogin();
    } else {
      this._showLoginModal();
    }
  },

  // ── Login persistence ─────────────────────────────────────────────────────
  _saveLogin(name, isAdmin) {
    localStorage.setItem('ck_user', JSON.stringify({ name, isAdmin }));
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
      <div class="header-left">
        <div class="header-logo">🏡</div>
        <div>
          <div class="header-title">${CONFIG.APP_NAME}</div>
          <div class="header-sub">${CONFIG.CANDIDATE} · ${CONFIG.RACE}</div>
        </div>
      </div>
      <div class="header-right" id="header-controls">
        <div id="stats-bar" class="stats-bar"></div>
        <div id="presence-bar" class="presence-bar"></div>
        <button class="hdr-btn" id="loc-btn" onclick="MapModule.toggleMyLocation()">📍 My Location</button>
      </div>`;

    document.getElementById('offline-banner').textContent = '⚠ Offline — results will sync when reconnected';

    document.getElementById('sidebar').innerHTML = `
      <div id="sidebar-header">
        <div class="sb-filter-row">
          <select id="turf-filter-sel" onchange="UI.setTurfFilter(this.value)">
            <option value="">All Turfs</option>
          </select>
          <select id="result-filter-sel" onchange="UI.setResultFilter(this.value)">
            <option value="">All Results</option>
            <option value="none">Not visited</option>
            ${CONFIG.RESULTS.map(r => `<option value="${r.key}">${r.icon} ${r.label}</option>`).join('')}
          </select>
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
          <button class="login-btn" onclick="UI._submitLogin()">Enter</button>
          <div id="login-error" class="login-error"></div>
        </div>
      </div>`;
    document.body.appendChild(overlay);
    setTimeout(() => document.getElementById('login-name')?.focus(), 200);
    document.getElementById('login-name')?.addEventListener('keydown', e => { if (e.key === 'Enter') this._submitLogin(); });
    document.getElementById('login-pw')?.addEventListener('keydown',   e => { if (e.key === 'Enter') this._submitLogin(); });
  },

  _toggleAdminLogin() {
    const pwLabel = document.getElementById('pw-label');
    const pwInput = document.getElementById('login-pw');
    const toggle  = document.getElementById('admin-toggle');
    const show    = pwInput.style.display === 'none';
    pwLabel.style.display = show ? 'block' : 'none';
    pwInput.style.display = show ? 'block' : 'none';
    toggle.textContent    = show ? '← Back to field login' : '🔒 Admin login';
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
    this._saveLogin(name, this.isAdmin);
    document.getElementById('login-overlay')?.remove();
    this._postLogin();
  },

  _postLogin() {
    const adminTools = document.getElementById('admin-tools');
    if (this.isAdmin && adminTools) {
      adminTools.style.display = 'flex';
      adminTools.innerHTML = `
        <div class="admin-label">Admin</div>
        <button class="admin-btn" id="draw-mode-btn" onclick="UI.toggleDrawMode()">✏️ Draw Turf</button>
        <button class="admin-btn" onclick="UI.showAddHouseModal()">＋ House</button>
        <button class="admin-btn" onclick="UI.showImportModal()">⬆ Import</button>`;
    }
    if (this.isAdmin) {
      const badge = document.createElement('div');
      badge.className = 'admin-badge';
      badge.innerHTML = `<span>🛡 Admin</span><button class="logout-btn" onclick="UI._clearLogin()">Log out</button>`;
      document.getElementById('header-controls')?.prepend(badge);
    } else {
      // Non-admin logout
      const logoutBtn = document.createElement('button');
      logoutBtn.className = 'hdr-btn logout-small';
      logoutBtn.textContent = 'Log out';
      logoutBtn.onclick = () => UI._clearLogin();
      document.getElementById('header-controls')?.appendChild(logoutBtn);
    }
    App.init();
  },

  // ── Draw mode ───────────────────────────────────────────────────────────────
  toggleDrawMode() {
    const on  = TurfDraw.toggle();
    const btn = document.getElementById('draw-mode-btn');
    if (btn) { btn.textContent = on ? '✏️ Exit Draw' : '✏️ Draw Turf'; btn.classList.toggle('active-admin-btn', on); }
  },

  // ── Edit boundary banner ────────────────────────────────────────────────────
  showEditBoundaryBanner(letter, onSave, onCancel) {
    document.getElementById('edit-boundary-banner')?.remove();
    const banner = document.createElement('div');
    banner.id = 'edit-boundary-banner';
    banner.className = 'edit-boundary-banner';
    banner.innerHTML = `
      <span>Editing Turf <strong>${letter}</strong> boundary — drag vertices</span>
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

  // ── Stats bar ────────────────────────────────────────────────────────────────
  updateStats(turfs) {
    const bar    = document.getElementById('stats-bar');
    if (!bar) return;
    const allH   = turfs.flatMap(t => t.houses);
    const total  = allH.length;
    const byResult = {};
    CONFIG.RESULTS.forEach(r => { byResult[r.key] = 0; });
    allH.forEach(h => { if (h.result) byResult[h.result] = (byResult[h.result] || 0) + 1; });
    const contacted = allH.filter(h => h.result && h.result !== 'skip').length;

    const segs = CONFIG.RESULTS.filter(r => r.key !== 'skip').map(r => {
      const pct = total ? (byResult[r.key] / total * 100).toFixed(1) : 0;
      return `<span class="stat-seg" style="background:${r.color}" data-pct="${pct}" title="${r.label}: ${byResult[r.key]}"></span>`;
    }).join('');

    bar.innerHTML = `
      <div class="stat-summary">${contacted}/${total} contacted</div>
      <div class="stat-track">${segs}</div>
      <div class="stat-pills">
        ${CONFIG.RESULTS.filter(r => r.key !== 'skip').map(r =>
          `<span class="stat-pill" style="color:${r.color}">${r.icon} ${byResult[r.key]}</span>`
        ).join('')}
      </div>`;

    requestAnimationFrame(() => {
      bar.querySelectorAll('.stat-seg').forEach(el => { el.style.flexBasis = el.dataset.pct + '%'; });
    });
  },

  // ── Sidebar ──────────────────────────────────────────────────────────────────
  renderSidebar(turfs) {
    const sel = document.getElementById('turf-filter-sel');
    if (sel) {
      const cur = sel.value;
      sel.innerHTML = '<option value="">All Turfs</option>' +
        App.state.turfs.map(t =>
          `<option value="${t.letter}" ${cur === t.letter ? 'selected' : ''}>${t.letter} — ${_esc(t.volunteer)}</option>`
        ).join('');
    }

    const list = document.getElementById('turf-list');
    if (!list) return;
    const filtered = this.turfFilter ? turfs.filter(t => t.letter === this.turfFilter) : turfs;

    if (!filtered.length) {
      list.innerHTML = `<div class="sb-empty">${this.isAdmin ? 'No turfs yet. Use <strong>✏️ Draw Turf</strong> to create one.' : 'No data loaded.'}</div>`;
      return;
    }

    list.innerHTML = filtered.map((turf, i) => {
      const color     = turf.color || CONFIG.TURF_COLORS[i % CONFIG.TURF_COLORS.length];
      const houses    = this._filterHouses(turf.houses);
      const total     = turf.houses.length;
      const contacted = turf.houses.filter(h => h.result && h.result !== 'skip').length;
      const pct       = total ? Math.round(contacted / total * 100) : 0;
      const expanded  = this._expandedTurfs.has(turf.letter) || !!this.turfFilter;
      const houseCards = houses.map((house, hi) => this._houseCard(house, turf, hi, color)).join('');

      const adminBtns = this.isAdmin ? `
        <button class="turf-action-btn" title="Edit volunteer/color" onclick="event.stopPropagation();UI.showEditTurfModal('${turf.letter}')">✎</button>
        <button class="turf-action-btn" title="Edit boundary" onclick="event.stopPropagation();TurfDraw.startEditBoundary('${turf.letter}')">⬡</button>
        <button class="turf-action-btn" title="Re-sort walk order" onclick="event.stopPropagation();TurfDraw.resortTurf('${turf.letter}',MapModule.getCurrentLatLon())">🔄</button>
        <button class="turf-action-btn danger" title="Delete" onclick="event.stopPropagation();UI.confirmDeleteTurf('${turf.letter}')">✕</button>` : '';

      return `<div class="turf-block" id="turf-block-${turf.letter}">
        <div class="turf-header" style="--tc:${color}" onclick="UI._toggleTurf('${turf.letter}')">
          <div class="turf-letter-badge" style="background:${color}">${turf.letter}</div>
          <div class="turf-info">
            <div class="turf-volunteer">${_esc(turf.volunteer)}</div>
            <div class="turf-progress-row">
              <div class="turf-prog-track">
                <div class="turf-prog-fill" style="width:${pct}%;background:${color}"></div>
              </div>
              <div class="turf-pct">${contacted}/${total}</div>
            </div>
          </div>
          <div class="turf-chevron" id="chev-${turf.letter}">${expanded ? '▾' : '▸'}</div>
          ${adminBtns}
        </div>
        <div class="turf-houses" id="houses-${turf.letter}" style="display:${expanded ? 'block' : 'none'}">
          ${houseCards || `<div class="sb-empty-turf">No houses${this.resultFilter ? ' matching filter' : ''}.${this.isAdmin ? ' Draw a turf boundary to populate.' : ''}</div>`}
        </div>
      </div>`;
    }).join('');
  },

  _filterHouses(houses) {
    if (!this.resultFilter) return houses;
    if (this.resultFilter === 'none') return houses.filter(h => !h.result);
    return houses.filter(h => h.result === this.resultFilter);
  },

  _houseCard(house, turf, idx, color) {
    const result    = house.result || '';
    const resultDef = CONFIG.RESULTS.find(r => r.key === result);
    const badgeHtml = result
      ? `<span class="house-badge" style="background:${resultDef.bg};color:${resultDef.color}">${resultDef.icon} ${resultDef.label}</span>`
      : `<span class="house-badge unvisited">Not visited</span>`;

    const quickBtns = ['knocked', 'hanger'].map(key => {
      const r = CONFIG.RESULTS.find(x => x.key === key);
      const active = house.result === key;
      return `<button class="quick-btn${active ? ' qbtn-active' : ''}"
        style="--qc:${r.color};--qbg:${r.bg}"
        onclick="event.stopPropagation();App.setResult('${house.id}','${active ? '' : key}')"
        title="${r.label}">${r.icon}</button>`;
    }).join('');

    // Street number label — always the actual house number
    const streetNum = (house.address || '').trim().match(/^(\d+)/)?.[1] || String(idx + 1);

    window._houseCache = window._houseCache || {};
    window._houseCache[house.id] = { house, turf, color };

    return `<div class="house-card${result ? ' house-done' : ''}" id="hcard-${house.id}"
      onclick="UI._cardClick('${house.id}')">
      <div class="house-num" style="background:${result ? (resultDef?.color || '#9ca3af') : '#d1d5db'}">${streetNum}</div>
      <div class="house-body">
        <div class="house-addr">${_esc(house.address)}</div>
        ${house.owner ? `<div class="house-name">${_esc(house.owner)}</div>` : ''}
        ${house.notes ? `<div class="house-notes">📝 ${_esc(house.notes)}</div>` : ''}
        <div class="house-footer">${badgeHtml}</div>
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
    const el   = document.getElementById('houses-' + letter);
    const chev = document.getElementById('chev-' + letter);
    if (!el) return;
    const open = el.style.display !== 'none';
    el.style.display = open ? 'none' : 'block';
    if (chev) chev.textContent = open ? '▸' : '▾';
    if (open) this._expandedTurfs.delete(letter); else this._expandedTurfs.add(letter);
  },

  // ── Presence ─────────────────────────────────────────────────────────────────
  updatePresence(users) {
    const bar = document.getElementById('presence-bar');
    if (!bar) return;
    bar.innerHTML = [
      { name: this.currentUser, me: true },
      ...users.filter(u => u.sessionId !== this.sessionId).map(u => ({ name: u.name, me: false }))
    ].map(u => `<span class="presence-pill${u.me ? ' me' : ''}">${u.me ? '👤 ' : '👥 '}${_esc(u.name)}${u.me ? ' (you)' : ''}</span>`).join('');
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
          <button class="modal-cancel" onclick="document.getElementById('modal-overlay').remove()">Cancel</button>
          <button class="modal-confirm" id="modal-confirm-btn">${confirmLabel}</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);
    overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });
    document.getElementById('modal-confirm-btn').addEventListener('click', () => { if (onConfirm()) overlay.remove(); });
    setTimeout(() => overlay.querySelector('input')?.focus(), 50);
  },

  // ── Edit turf (volunteer/color only — boundary uses startEditBoundary) ────────
  showEditTurfModal(letter) {
    const turf      = App.state.turfs.find(t => t.letter === letter);
    if (!turf) return;
    const colors    = CONFIG.TURF_COLORS;
    const colorOpts = colors.map(c =>
      `<span class="color-swatch${c === turf.color ? ' selected' : ''}" data-color="${c}" style="background:${c}"
        onclick="this.parentElement.querySelectorAll('.color-swatch').forEach(s=>s.classList.remove('selected'));this.classList.add('selected')"></span>`
    ).join('');
    this._modal(`Edit Turf ${letter}`, `
      <label class="f-label">Volunteer</label>
      <input id="f-volunteer" class="f-input" type="text" value="${_esc(turf.volunteer === '[UNASSIGNED]' ? '' : turf.volunteer)}" placeholder="Volunteer name"/>
      <label class="f-label">Color</label>
      <div class="color-row">${colorOpts}</div>
    `, () => {
      const volunteer = (document.getElementById('f-volunteer')?.value || '').trim() || '[UNASSIGNED]';
      const color     = document.querySelector('.color-swatch.selected')?.dataset.color || turf.color;
      App.updateTurf(letter, { volunteer, color });
      return true;
    });
  },

  confirmDeleteTurf(letter) {
    const turf = App.state.turfs.find(t => t.letter === letter);
    if (turf?.houses.length) { this.toast(`Remove all houses from Turf ${letter} first`, 'error'); return; }
    if (!confirm(`Delete Turf ${letter}? This cannot be undone.`)) return;
    App.deleteTurf(letter);
  },

  // ── Add House — parcel search picker ────────────────────────────────────────
  showAddHouseModal() {
    if (!App.state.turfs.length) { this.toast('Create a turf first', 'error'); return; }
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
      const turf     = document.getElementById('f-turf')?.value;
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

  showImportModal() {
    this._modal('Bulk Import', `
      <div class="f-hint" style="margin-bottom:10px">
        Paste JSON array of turfs. Each turf: <code>letter, volunteer, color, houses[]</code><br>
        Each house: <code>address, lat, lon</code> (owner/notes optional).
        <pre class="import-example">[{"letter":"A","volunteer":"Alice","color":"#e05c4b","houses":[{"address":"100 Main St","lat":32.97,"lon":-96.97}]}]</pre>
      </div>
      <textarea id="import-json" class="f-textarea" rows="8" placeholder='[{"letter":"A",...}]'></textarea>
      <div id="import-error" class="login-error"></div>
    `, () => {
      const raw = (document.getElementById('import-json')?.value || '').trim();
      let data;
      try { data = JSON.parse(raw); } catch(e) { document.getElementById('import-error').textContent = 'Invalid JSON: ' + e.message; return false; }
      if (!Array.isArray(data)) { document.getElementById('import-error').textContent = 'Must be a JSON array'; return false; }
      App.bulkImport(data);
      return true;
    }, 'Import');
  },
};
