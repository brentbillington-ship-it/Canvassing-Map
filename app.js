// ─── App Module ───────────────────────────────────────────────────────────────

const App = {
  state: { turfs: [] },
  _offlineQueue: JSON.parse(localStorage.getItem('ck_queue') || '[]'),
  _refreshTimer: null,
  _presenceTimer: null,
  _lastHash: '',
  _flushing: false,
  _writeLock: {},   // houseId → expiry timestamp

  async init() {
    MapModule.init();
    TurfDraw.init(MapModule.map);
    this._showLoadingOverlay(true);
    await this.loadData();
    this._showLoadingOverlay(false);
    this._startTimers();
    this._flushQueue();
    UI.startChatPoll();
    window.addEventListener('online',  () => { UI.setOffline(false); this._flushQueue(); });
    window.addEventListener('offline', () => UI.setOffline(true));
    window.addEventListener('focus',   () => this._flushQueue());
  },

  _showLoadingOverlay(show) {
    let el = document.getElementById('loading-overlay');
    if (show) {
      if (!el) {
        el = document.createElement('div');
        el.id = 'loading-overlay';
        el.innerHTML = '<div class="loading-spinner"></div><div class="loading-text">Loading data…</div>';
        document.getElementById('map-wrap')?.appendChild(el);
      }
    } else { el?.remove(); }
  },

  async loadData() {
    try {
      // Fetch turfs+houses and polygons in parallel — polygons are large, kept separate
      const [data, polyData] = await Promise.all([
        SheetsAPI.getAll(),
        SheetsAPI.getPolygons().catch(() => null)
      ]);
      if (data.error) throw new Error(data.error);
      this.state.turfs = data.turfs;
      this._mergePolygons(polyData?.polygons);
      this.render();
      UI.toast('Data loaded ✓', 'success');
      UI.setOffline(false);
    } catch(e) {
      console.error('Load failed:', e);
      UI.toast('Failed to load — check SHEETS_API_URL in config.js', 'error');
      UI.setOffline(true);
    }
  },

  // Merge polygon_geojson into state.turfs from a getPolygons response
  _mergePolygons(polygons) {
    if (!polygons) return;
    polygons.forEach(p => {
      const turf = this.state.turfs.find(t => String(t.letter) === String(p.letter));
      if (turf && p.polygon_geojson) turf.polygon_geojson = p.polygon_geojson;
    });
  },

  render() {
    const turfs = this._visibleTurfs();
    UI.updateStats(this.state.turfs);
    UI.renderSidebar(turfs);
    MapModule.renderAll(turfs);
    TurfDraw.loadTurfs(this.state.turfs);
    UI.checkZoneCompletion(this.state.turfs);
  },

  _visibleTurfs() {
    let turfs = this.state.turfs;

    // View mode (All / Hangers / Knocks) — filters both sidebar AND map
    if (UI.viewMode) {
      turfs = turfs.filter(t => (t.mode || 'hanger') === UI.viewMode);
    }
    // Single-zone filter
    if (UI.turfFilter) {
      turfs = turfs.filter(t => String(t.letter) === String(UI.turfFilter));
    }
    // Volunteer filter — hide other volunteers' zones from map too
    if (UI.volunteerFilter) {
      turfs = turfs.filter(t => {
        if (UI.volunteerFilter === '[UNASSIGNED]') return !t.volunteer || t.volunteer === '[UNASSIGNED]';
        return t.volunteer === UI.volunteerFilter;
      });
    }
    // Result filter — only show turfs that contain at least one house matching the result
    if (UI.resultFilter) {
      turfs = turfs.filter(t => t.houses.some(h => {
        if (UI.resultFilter === 'none') return !h.result;
        return h.result === UI.resultFilter;
      }));
    }
    return turfs;
  },

  _startTimers() {
    this._refreshTimer  = setInterval(() => this._silentRefresh(), CONFIG.REFRESH_INTERVAL);
    this._presenceTimer = setInterval(() => this._heartbeat(), 30000);
    this._heartbeat();
    this._pollPresence();
    setInterval(() => this._pollPresence(), 15000);
  },

  async _silentRefresh() {
    if (document.getElementById('modal-overlay')) return;
    try {
      const data = await SheetsAPI.getAll();
      if (data.error) return;
      const hash = JSON.stringify(data.turfs.map(t => t.houses.map(h => h.result + h.result_by + h.notes)));
      if (hash === this._lastHash) return;
      this._lastHash   = hash;
      // Apply write lock — don't overwrite recently-set local results
      const now = Date.now();
      data.turfs.forEach(turf => {
        turf.houses.forEach(house => {
          if (this._writeLock[house.id] && this._writeLock[house.id] > now) {
            const local = this._findHouse(house.id);
            if (local.house) {
              house.result      = local.house.result;
              house.result_by   = local.house.result_by;
              house.result_date = local.house.result_date;
            }
          }
        });
      });
      // Preserve polygon_geojson from existing state — re-fetch every 4th refresh
      // to pick up newly created zones without hammering the API
      this._silentRefreshCount = (this._silentRefreshCount || 0) + 1;
      if (this._silentRefreshCount % 4 === 0) {
        const freshPoly = await SheetsAPI.getPolygons().catch(() => null);
        this._mergePolygons(freshPoly?.polygons);
        data.turfs.forEach(t => {
          const existing = this.state.turfs.find(e => String(e.letter) === String(t.letter));
          if (existing?.polygon_geojson) t.polygon_geojson = existing.polygon_geojson;
        });
      } else {
        data.turfs.forEach(t => {
          const existing = this.state.turfs.find(e => String(e.letter) === String(t.letter));
          if (existing?.polygon_geojson) t.polygon_geojson = existing.polygon_geojson;
        });
      }
      this.state.turfs = data.turfs;
      this.render();
    } catch(e) {}
  },

  async _heartbeat() { try { await SheetsAPI.heartbeat(UI.currentUser, UI.sessionId); } catch(e) {} },
  async _pollPresence() { try { const d = await SheetsAPI.getPresence(); if (d.users) UI.updatePresence(d.users); } catch(e) {} },

  _saveQueue() { localStorage.setItem('ck_queue', JSON.stringify(this._offlineQueue)); },
  _newQid() {
    return (typeof crypto !== 'undefined' && crypto.randomUUID)
      ? crypto.randomUUID()
      : Date.now().toString(36) + Math.random().toString(36).slice(2);
  },

  async _flushQueue() {
    if (this._flushing || !this._offlineQueue.length) return;
    this._flushing = true;
    const pending  = [...this._offlineQueue];
    for (const item of pending) {
      try {
        const res = item.result === ''
          ? await SheetsAPI.clearResult(item.id)
          : await SheetsAPI.setResult(item.id, item.result, item.by);
        if (!res.error) {
          this._offlineQueue = this._offlineQueue.filter(q => q._qid !== item._qid);
          this._saveQueue();
        }
      } catch(e) { break; }
    }
    this._flushing = false;
    if (this._offlineQueue.length) setTimeout(() => this._flushQueue(), 5000);
  },

  // ── Actions ───────────────────────────────────────────────────────────────────
  async setResult(houseId, resultKey) {
    const { turf, house, idx } = this._findHouse(houseId);
    if (!house) return;
    house.result    = resultKey;
    house.result_by = UI.currentUser;
    house.result_date = new Date().toISOString();
    // Lock this house for 10s to prevent silent refresh overwrite
    this._writeLock[houseId] = Date.now() + 10000;
    MapModule.updateHouseMarker(house, turf, idx);
    UI.renderSidebar(this._visibleTurfs());
    UI.updateStats(this.state.turfs);
    UI.updateNextDoor();
    UI.setSyncStatus('syncing');

    const item = { _qid: this._newQid(), id: houseId, result: resultKey, by: UI.currentUser };
    this._offlineQueue.push(item);
    this._saveQueue();

    try {
      const res = resultKey === ''
        ? await SheetsAPI.clearResult(houseId)
        : await SheetsAPI.setResult(houseId, resultKey, UI.currentUser);
      if (res.error) throw new Error(res.error);
      this._offlineQueue = this._offlineQueue.filter(q => q._qid !== item._qid);
      this._saveQueue();
      UI.setSyncStatus('ok');
      const icon = CONFIG.RESULTS.find(r => r.key === resultKey)?.icon || '';
      UI.toast(resultKey ? `${icon} Saved` : 'Result cleared', 'success');
    } catch(e) {
      UI.setSyncStatus('error');
      UI.toast('Saved locally — will sync when online', 'info');
    }
  },

  async clearTurfHouses(letter) {
    const turf = this.state.turfs.find(t => t.letter === letter);
    if (!turf) return;
    UI.toast('Clearing houses…', 'info');
    try {
      for (const h of turf.houses) {
        await SheetsAPI.removeHouse(h.id);
      }
      turf.houses = [];
      this.render();
      UI.toast(`Zone ${letter} cleared ✓`, 'success');
    } catch(e) { UI.toast('Failed to clear some houses', 'error'); }
  },

  async saveNotes(houseId, notes) {
    const { house } = this._findHouse(houseId);
    if (!house) return;
    house.notes = notes;
    try { await SheetsAPI.updateHouse(houseId, { notes }); } catch(e) { UI.toast('Notes saved locally', 'info'); }
  },

  async updateTurf(letter, fields) {
    try {
      await SheetsAPI.updateTurf(letter, fields);
      const turf = this.state.turfs.find(t => t.letter === letter);
      if (turf) Object.assign(turf, fields);
      this.render();
      UI.toast(`Zone ${letter} updated`, 'success');
    } catch(e) { UI.toast('Failed to update zone', 'error'); }
  },

  async deleteTurf(letter) {
    try {
      const res = await SheetsAPI.deleteTurf(letter);
      if (res.error) { UI.toast(res.error, 'error'); return; }
      this.state.turfs = this.state.turfs.filter(t => t.letter !== letter);
      TurfDraw.removeTurfLayer(letter);
      this.render();
      UI.toast(`Zone ${letter} deleted`);
    } catch(e) { UI.toast('Failed to delete zone', 'error'); }
  },

  async saveTurfPolygon(letter, geojson) {
    try {
      const res = await SheetsAPI.saveTurfPolygon(letter, geojson);
      if (res.error) { UI.toast(res.error, 'error'); return; }
      const turf = this.state.turfs.find(t => t.letter === letter);
      if (turf) turf.polygon_geojson = geojson;
      MapModule.renderAll(this._visibleTurfs());
    } catch(e) { UI.toast('Failed to save zone boundary', 'error'); }
  },

  async clearTurfPolygon(letter) {
    try {
      await SheetsAPI.saveTurfPolygon(letter, null);
      const turf = this.state.turfs.find(t => t.letter === letter);
      if (turf) turf.polygon_geojson = '';
      MapModule.renderAll(this._visibleTurfs());
    } catch(e) {}
  },

  // ── Create turf from draw (new) ───────────────────────────────────────────
  async createTurfFromDraw({ letter, color, volunteer, geojson, parcels }) {
    App._showCreatingOverlay(true, `Creating Zone ${letter}…`);
    try {
      const houses = parcels.map(p => ({ address: p.address, owner: p.owner || '', lat: p.lat, lon: p.lon }));
      // Single atomic call: creates turf + polygon + houses, rolls back on failure
      let res = await SheetsAPI.createZone(letter, color, volunteer || '[UNASSIGNED]', geojson, houses);

      // Collision detected — server tells us the next safe number; offer to retry
      if (res.error && res.nextAvailable) {
        App._showCreatingOverlay(false);
        const retry = await UI._confirm('Zone Taken', `Zone ${letter} was just created by another admin.<br><br>Create as Zone ${res.nextAvailable} instead?`, `Create as Zone ${res.nextAvailable}`);
        if (!retry) return;
        letter = String(res.nextAvailable);
        App._showCreatingOverlay(true, `Creating Zone ${letter}…`);
        res = await SheetsAPI.createZone(letter, color, volunteer || '[UNASSIGNED]', geojson, houses);
      }

      if (res.error) { UI.toast(res.error, 'error'); return; }
      await this.loadData();
      UI.toast(`Zone ${letter} created with ${res.houseCount} houses ✓`, 'success');
    } catch(e) { UI.toast('Failed to create zone — check connection', 'error'); console.error(e); }
    finally { App._showCreatingOverlay(false); }
  },

  async claimZone(letter) {
    const user = this._getUserRecord();
    if (!user) { UI.toast('Could not find your user record', 'error'); return; }
    try {
      const res = await SheetsAPI.claimZone(letter, user.name, user.color);
      if (res.error) { UI.toast(res.error, 'error'); return; }
      // Update local state
      const turf = this.state.turfs.find(t => t.letter === letter);
      if (turf) { turf.volunteer = user.name; turf.color = user.color; }
      this.render();
      UI.toast(`Zone ${letter} claimed ✓`, 'success');
    } catch(e) { UI.toast('Failed to claim zone', 'error'); }
  },

  _getUserRecord() {
    // Find current user in _users cache by email
    const email = UI.currentEmail;
    if (!email) return { name: UI.currentUser, color: '#6b7280' };
    const found = UI._users.find(u => u.email === email);
    return found || { name: UI.currentUser, color: '#6b7280' };
  },

  _showCreatingOverlay(show, msg = 'Working…') {
    document.getElementById('creating-overlay')?.remove();
    if (!show) return;
    const el = document.createElement('div');
    el.id = 'creating-overlay';
    el.innerHTML = `<div class="creating-spinner"></div><div class="creating-text">${msg}</div>`;
    document.getElementById('map-wrap')?.appendChild(el);
  },

  // ── Update turf boundary (edit) ────────────────────────────────────────────
  async updateTurfBoundary({ letter, geojson, toKeep, toRemove, toAdd }) {
    UI.toast('Updating boundary…', 'info');
    try {
      // Save new boundary
      await SheetsAPI.saveTurfPolygon(letter, geojson);

      // Remove houses with no result
      for (const h of toRemove) {
        await SheetsAPI.removeHouse(h.id);
      }

      // Add new houses
      if (toAdd.length) {
        const houses = toAdd.map(p => ({ address: p.address, owner: p.owner, lat: p.lat, lon: p.lon }));
        const turf   = this.state.turfs.find(t => t.letter === letter);
        await SheetsAPI.bulkImport([{
          letter, color: turf?.color || '#2e6ec2',
          volunteer: turf?.volunteer || '[UNASSIGNED]',
          houses
        }]);
      }

      await this.loadData();
      UI.toast(`Zone ${letter} boundary updated ✓`, 'success');
    } catch(e) { UI.toast('Failed to update boundary', 'error'); console.error(e); }
  },

  async addHouse(house) {
    try {
      const res = await SheetsAPI.addHouse(house);
      if (res.error) { UI.toast(res.error, 'error'); return; }
      const newHouse = { ...house, id: res.id, result: '', result_by: '', result_date: '', notes: '' };
      const turf = this.state.turfs.find(t => t.letter === house.turf);
      if (turf) turf.houses.push(newHouse);
      this.render();
      const isKnockTurf = (App.state.turfs.find(t => t.letter === house.turf)?.mode || 'hanger') === 'doorknock';
      UI.toast(isKnockTurf ? 'Knock location added ✊' : 'House added', 'success');
      MapModule.focusHouse(newHouse);
    } catch(e) { UI.toast('Failed to add house', 'error'); }
  },

  async removeHouse(id) {
    try {
      const res = await SheetsAPI.removeHouse(id);
      if (res.error) { UI.toast(res.error, 'error'); return; }
      this.state.turfs.forEach(t => { t.houses = t.houses.filter(h => h.id !== id); });
      this.render();
      UI.toast('House removed');
    } catch(e) { UI.toast('Failed to remove house', 'error'); }
  },

  async bulkImport(turfs) {
    UI.toast('Importing…', 'info');
    try {
      const res = await SheetsAPI.bulkImport(turfs);
      if (res.error) { UI.toast(res.error, 'error'); return; }
      await this.loadData();
      UI.toast(`Imported ${res.turfs} turfs, ${res.houses} houses ✓`, 'success');
    } catch(e) { UI.toast('Import failed', 'error'); }
  },

  async reorderTurfHouses(letter, newOrder) {
    const turf = this.state.turfs.find(t => t.letter === letter);
    if (!turf) return;
    turf.houses = newOrder;
    this.render();
    try {
      const ids = newOrder.map(h => h.id);
      await SheetsAPI.reorderHouses(letter, ids);
    } catch(e) { UI.toast('Re-order saved locally', 'info'); }
  },

  _findHouse(id) {
    for (const turf of this.state.turfs) {
      const idx = turf.houses.findIndex(h => h.id === id);
      if (idx >= 0) return { turf, house: turf.houses[idx], idx };
    }
    return { turf: null, house: null, idx: -1 };
  },
};
