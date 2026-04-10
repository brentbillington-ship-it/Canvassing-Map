// ─── App Module ───────────────────────────────────────────────────────────────

const App = {
  state: { turfs: [] },
  _offlineQueue: JSON.parse(localStorage.getItem('ck_queue') || '[]'),
  _refreshTimer: null,
  _presenceTimer: null,
  _lastHash: '',
  _flushing: false,
  _writeLock: {},   // houseId → expiry timestamp
  _deletingLetters: new Set(),  // zone letters with in-flight background deletes

  async init() {
    MapModule.init();
    TurfDraw.init(MapModule.map);
    this._showLoadingOverlay(true);
    await this.loadData();
    this._showLoadingOverlay(false);
    this._startTimers();
    this._loadZoneQueue();   // restore any pending zone writes that survived a tab close/refresh
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

  _loadInProgress: false,

  // Dedup turfs by zone letter — keeps the last occurrence (most recent write wins).
  // Prevents duplicate Sheet rows for the same zone number from doubling up in the UI.
  _dedupTurfs(turfs) {
    const seen = {};
    // Iterate in order so later entries (newer writes) overwrite earlier ones
    turfs.forEach(t => { seen[String(t.letter)] = t; });
    return Object.values(seen);
  },

  async loadData() {
    if (this._loadInProgress) return;
    this._loadInProgress = true;
    try {
      const [data, polyData] = await Promise.all([
        SheetsAPI.getAll(),
        SheetsAPI.getPolygons().catch(() => null)
      ]);
      if (data.error) throw new Error(data.error);
      this.state.turfs = this._dedupTurfs(data.turfs);
      this._mergePolygons(polyData?.polygons);
      this.render();
      UI.setOffline(false);
    } catch(e) {
      // Silent retry after 3s — Apps Script cold starts are common
      await new Promise(r => setTimeout(r, 3000));
      try {
        const [data, polyData] = await Promise.all([
          SheetsAPI.getAll(),
          SheetsAPI.getPolygons().catch(() => null)
        ]);
        if (data.error) throw new Error(data.error);
        this.state.turfs = this._dedupTurfs(data.turfs);
        this._mergePolygons(polyData?.polygons);
        this.render();
        UI.setOffline(false);
      } catch(e2) {
        // Still failing after retry — show offline state quietly, _silentRefresh will recover
        console.error('Load failed after retry:', e2);
        UI.setOffline(true);
      }
    } finally {
      this._loadInProgress = false;
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
    const sidebar = document.getElementById('sidebar');
    const scrollTop = sidebar ? sidebar.scrollTop : 0;
    UI.renderSidebar(turfs);
    if (sidebar) sidebar.scrollTop = scrollTop;
    MapModule.renderAll(turfs);
    // Don't rebuild drawn layers or re-render polygons while an edit is in progress
    if (!TurfDraw.isEditing()) TurfDraw.loadTurfs(this.state.turfs);
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
    this._presenceTimer = setInterval(() => this._heartbeat(), 15000);
    this._heartbeat();
    this._pollPresence();
    setInterval(() => this._pollPresence(), 15000);
  },

  _silentRefreshFailures: 0,

  async _silentRefresh() {
    if (document.getElementById('modal-overlay')) return;
    if (!navigator.onLine || document.visibilityState === 'hidden') return;
    if (this._loadInProgress) return;
    try {
      const data = await SheetsAPI.getAll();
      if (data.error) return;
      const hash = JSON.stringify(data.turfs.map(t => [t.volunteer, t.color, t.mode, t.houses.map(h => h.result + h.result_by + h.notes)]));
      if (hash === this._lastHash) return;
      this._lastHash   = hash;
      // Apply write lock — don't overwrite recently-set local results
      const now = Date.now();
      // Prune expired write locks to prevent unbounded growth over long sessions
      Object.keys(this._writeLock).forEach(id => {
        if (this._writeLock[id] <= now) delete this._writeLock[id];
      });
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
      let freshPolygons = null;
      if (this._silentRefreshCount % 4 === 0) {
        const freshPoly = await SheetsAPI.getPolygons().catch(() => null);
        freshPolygons = freshPoly?.polygons || null;
      }
      // Preserve existing polygon data into incoming data before swapping state
      data.turfs.forEach(t => {
        const existing = this.state.turfs.find(e => String(e.letter) === String(t.letter));
        if (existing?.polygon_geojson) t.polygon_geojson = existing.polygon_geojson;
      });
      // Filter out zones with in-flight deletes — prevents ghost zone resurrection
      data.turfs = data.turfs.filter(t => !this._deletingLetters.has(String(t.letter)));
      this.state.turfs = this._dedupTurfs(data.turfs);
      // Now merge fresh polygons on top — after state is set so we don't overwrite with stale
      if (freshPolygons) this._mergePolygons(freshPolygons);
      this.render();
    } catch(e) {
      this._silentRefreshFailures = (this._silentRefreshFailures || 0) + 1;
      console.warn('Silent refresh failed:', e);
      if (this._silentRefreshFailures >= 3) UI.setOffline(true);
      return;
    }
    this._silentRefreshFailures = 0;
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
    // Preserve sidebar scroll position across re-render
    const sidebar = document.getElementById('sidebar');
    const scrollTop = sidebar ? sidebar.scrollTop : 0;
    UI.renderSidebar(this._visibleTurfs());
    if (sidebar) sidebar.scrollTop = scrollTop;
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
      // Instant polygon color update — same frame as API response (Item 4)
      const newColor = (turf?.color) || '#6b7280';
      MapModule.setZoneStyle(letter, newColor);
      TurfDraw.setZoneStyle(letter, newColor);
      this.render();
      UI.toast(`Zone ${letter} updated`, 'success');
    } catch(e) { UI.toast('Failed to update zone', 'error'); }
  },

  async deleteTurf(letter) {
    // Immediately remove all graphics — zone polygon, label, and house markers vanish at once.
    // The Sheet deletion runs in the background; UI is already clean.
    const removed = this.state.turfs.find(t => String(t.letter) === String(letter));
    this.state.turfs = this.state.turfs.filter(t => String(t.letter) !== String(letter));
    TurfDraw.removeTurfLayer(letter);
    // Track in-flight delete to prevent new zones from colliding with this letter
    this._deletingLetters.add(String(letter));
    this.render();
    UI.toast(`Zone ${letter} deleted`);

    try {
      const res = await SheetsAPI.deleteTurf(letter);
      if (res.error) {
        UI.toast(`Zone ${letter} could not be fully deleted — reloading`, 'error');
        await this.loadData();
      }
    } catch(e) {
      UI.toast('Delete failed — reloading to sync', 'error');
      await this.loadData();
    } finally {
      // Delete is complete (success or fail) — letter is no longer in-flight
      this._deletingLetters.delete(String(letter));
    }
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

  // ── Zone creation queue — processes in background, no full-screen freeze ──
  _createQueue: [],
  _queueRunning: false,
  _pendingPolygons: {}, // letter → Leaflet layer

  // Persist zone queue to localStorage so in-progress saves survive a tab close or refresh
  _saveZoneQueue() {
    try {
      const toSave = this._createQueue.map(j => ({
        letter: j.letter, color: j.color, volunteer: j.volunteer,
        geojson: j.geojson, houses: j.houses, mode: j.mode || 'hanger',
      }));
      localStorage.setItem('ck_zone_queue', JSON.stringify(toSave));
    } catch(e) {}
  },

  _loadZoneQueue() {
    try {
      const saved = JSON.parse(localStorage.getItem('ck_zone_queue') || '[]');
      if (!saved.length) return;
      saved.forEach(job => {
        // Recreate the dashed-black pending polygon from saved geojson
        const pending = L.geoJSON(
          { type: 'Feature', geometry: job.geojson, properties: {} },
          { style: { color: '#000', fillColor: '#000', fillOpacity: 0, weight: 2.5, dashArray: '8,4', opacity: 1 } }
        ).addTo(MapModule.map);
        this._pendingPolygons[job.letter] = pending;
        this._createQueue.push(job);
      });
      this._updateQueueBanner();
      UI.toast(`Resuming ${saved.length} pending zone${saved.length > 1 ? 's' : ''}…`, 'info', 3000);
      this._runCreateQueue();
    } catch(e) {
      localStorage.removeItem('ck_zone_queue');
    }
  },

  createTurfFromDraw({ letter, color, volunteer, geojson, parcels, pendingLayer, mode }) {
    // Convert parcels to serializable houses format immediately (no Leaflet objects)
    const houses = (parcels || []).map(p => ({
      address: p.address, owner: p.owner || '', lat: p.lat, lon: p.lon,
    }));
    // Show dashed-black "pending" outline — no fill so it's clearly distinguishable from saved zones
    if (pendingLayer) {
      const pending = L.geoJSON(
        { type: 'Feature', geometry: geojson, properties: {} },
        { style: { color: '#000', fillColor: '#000', fillOpacity: 0, weight: 2.5, dashArray: '8,4', opacity: 1 } }
      ).addTo(MapModule.map);
      this._pendingPolygons[letter] = pending;
    }
    UI.toast(`Zone ${letter} queued — drawing next zone now`, 'info', 2500);
    this._createQueue.push({ letter, color, volunteer, geojson, houses, mode: mode || 'hanger' });
    this._saveZoneQueue();
    this._updateQueueBanner();
    if (!this._queueRunning) this._runCreateQueue();
  },

  _updateQueueBanner() {
    const total   = this._createQueue.length;
    const running = this._queueRunning;
    // Bottom banner
    let banner = document.getElementById('zone-queue-banner');
    if (!total && !running) {
      banner?.remove();
    } else {
      if (!banner) {
        banner = document.createElement('div');
        banner.id = 'zone-queue-banner';
        document.body.appendChild(banner);
      }
      const current = this._createQueue[0];
      banner.className = 'zone-queue-banner';
      banner.innerHTML = total > 1
        ? `⏳ Creating Zone ${current?.letter}… <span class="zqb-count">${total} zones in queue</span>`
        : `⏳ Creating Zone ${current?.letter}…`;
    }
    // Sidebar indicator
    if (typeof UI !== 'undefined' && UI._updatePendingZonesBar) {
      UI._updatePendingZonesBar(total + (running ? 1 : 0));
    }
  },

  async _runCreateQueue() {
    if (this._queueRunning || !this._createQueue.length) return;
    this._queueRunning = true;
    this._updateQueueBanner();
    while (this._createQueue.length) {
      const job = this._createQueue[0];
      let { letter, color, volunteer, geojson, houses, mode } = job;
      this._updateQueueBanner();
      try {
        let res = await SheetsAPI.createZone(letter, color, volunteer || '[UNASSIGNED]', geojson, houses, mode || 'hanger');

        // Collision — another admin grabbed this number
        if (res.error && res.nextAvailable) {
          if (this._pendingPolygons[letter]) {
            MapModule.map.removeLayer(this._pendingPolygons[letter]);
            delete this._pendingPolygons[letter];
          }
          const retry = await UI._confirm(
            'Zone Taken',
            `Zone ${letter} was just created by another admin.<br><br>Create as Zone ${res.nextAvailable} instead?`,
            `Create as Zone ${res.nextAvailable}`
          );
          if (!retry) {
            this._createQueue.shift();
            this._saveZoneQueue();
            this._updateQueueBanner();
            continue;
          }
          letter = String(res.nextAvailable);
          res = await SheetsAPI.createZone(letter, color, volunteer || '[UNASSIGNED]', geojson, houses, mode || 'hanger');
        }

        // Remove pending polygon — real one comes from loadData
        if (this._pendingPolygons[letter]) {
          MapModule.map.removeLayer(this._pendingPolygons[letter]);
          delete this._pendingPolygons[letter];
        }

        if (res.error) {
          UI.toast(`Zone ${letter} failed: ${res.error}`, 'error');
        } else {
          // If mode is knock, set it now — createZone defaults to hanger if apps_script not yet updated
          if ((mode || 'hanger') === 'knock') {
            await SheetsAPI.updateTurf(letter, { mode: 'knock' }).catch(() => {});
          }
          await this.loadData();
          UI.toast(`Zone ${letter} created with ${res.houseCount} houses ✓`, 'success');
        }
      } catch(e) {
        UI.toast(`Zone ${letter} failed — check connection`, 'error');
        console.error(e);
        if (this._pendingPolygons[letter]) {
          MapModule.map.removeLayer(this._pendingPolygons[letter]);
          delete this._pendingPolygons[letter];
        }
      }
      this._createQueue.shift();
      this._saveZoneQueue();
      this._updateQueueBanner();
    }
    this._queueRunning = false;
    this._saveZoneQueue();  // clear persisted queue now that everything is done
    this._updateQueueBanner();
  },

  async claimZone(letter) {
    const user = this._getUserRecord();
    if (!user) { UI.toast('Could not find your user record', 'error'); return; }
    try {
      const res = await SheetsAPI.claimZone(letter, user.name, user.color);
      if (res.error) { UI.toast(res.error, 'error'); return; }
      // Ensure user is in _users cache so _turfColor resolves immediately
      if (!UI._users.find(u => u.name === user.name)) {
        UI._users = [...UI._users, { name: user.name, color: user.color }];
      }
      const turf = this.state.turfs.find(t => String(t.letter) === String(letter));
      if (turf) { turf.volunteer = user.name; turf.color = user.color; }
      // Instant polygon color update — same frame as API response (Item 4)
      MapModule.setZoneStyle(letter, user.color);
      TurfDraw.setZoneStyle(letter, user.color);
      this.render();
      UI.toast(`Zone ${letter} claimed ✓`, 'success');
    } catch(e) { UI.toast('Failed to claim zone', 'error'); }
  },

  async unclaimZone(letter) {
    try {
      const res = await SheetsAPI.updateTurf(letter, { volunteer: '[UNASSIGNED]', color: '#6b7280' });
      if (res.error) { UI.toast(res.error, 'error'); return; }
      const turf = this.state.turfs.find(t => String(t.letter) === String(letter));
      if (turf) { turf.volunteer = '[UNASSIGNED]'; turf.color = '#6b7280'; }
      // Instant polygon color update (Item 4)
      MapModule.setZoneStyle(letter, '#6b7280');
      TurfDraw.setZoneStyle(letter, '#6b7280');
      this.render();
      UI.toast(`Zone ${letter} unclaimed`, 'success');
    } catch(e) { UI.toast('Failed to unclaim zone', 'error'); }
  },

  _getUserRecord() {
    // Find current user in _users cache by email
    const email = UI.currentEmail;
    if (!email) return { name: UI.currentUser, color: '#6b7280' };
    const found = UI._users.find(u => u.email === email);
    return found || { name: UI.currentUser, color: '#6b7280' };
  },

  // ── Update turf boundary (edit) ────────────────────────────────────────────
  async updateTurfBoundary({ letter, geojson, toKeep, toRemove, toAdd }) {
    UI.toast('Updating boundary…', 'info');
    let succeeded = false;
    try {
      // Save new boundary first — bail early with clear error if this fails
      const saveRes = await SheetsAPI.saveTurfPolygon(letter, geojson);
      if (saveRes?.error) {
        UI.toast(`Boundary save failed: ${saveRes.error}`, 'error');
        console.error('saveTurfPolygon error:', saveRes.error);
        return;
      }

      // Remove houses that fell outside the new boundary (only if no result)
      for (const h of toRemove) {
        const res = await SheetsAPI.removeHouse(h.id);
        if (res?.error) console.warn('removeHouse failed for', h.id, res.error);
      }

      // Add new houses that entered the boundary
      if (toAdd.length) {
        const turf = this.state.turfs.find(t => String(t.letter) === String(letter));
        const houses = toAdd.map(p => ({ address: p.address, owner: p.owner || '', lat: p.lat, lon: p.lon }));
        const res = await SheetsAPI.bulkImport([{
          letter,
          color: turf?.color || '#2e6ec2',
          volunteer: turf?.volunteer || '[UNASSIGNED]',
          houses,
        }]);
        if (res?.error) console.warn('bulkImport partial error:', res.error);
      }

      succeeded = true;
      UI.toast(`Zone ${letter} boundary updated ✓`, 'success');
    } catch(e) {
      UI.toast('Failed to update boundary — reloading to sync', 'error');
      console.error('updateTurfBoundary error:', e);
    } finally {
      // Always reload — keeps UI consistent with actual Sheets state whether or not we succeeded
      await this.loadData();
    }
  },

  async addHouse(house) {
    try {
      const res = await SheetsAPI.addHouse(house);
      if (res.error) { UI.toast(res.error, 'error'); return; }
      const newHouse = { ...house, id: res.id, result: '', result_by: '', result_date: '', notes: '' };
      const turf = this.state.turfs.find(t => t.letter === house.turf);
      if (turf) turf.houses.push(newHouse);
      this.render();
      const isKnockTurf = (App.state.turfs.find(t => t.letter === house.turf)?.mode || 'hanger') === 'knock';
      UI.toast(isKnockTurf ? 'Knock location added ✊' : 'House added', 'success');
      MapModule.focusHouse(newHouse);
    } catch(e) { UI.toast('Failed to add house', 'error'); }
  },

  async removeHouse(id) {
    // Optimistic remove — update UI immediately, restore on failure
    let removed = null, removedTurf = null, removedIdx = -1;
    for (const turf of this.state.turfs) {
      const idx = turf.houses.findIndex(h => h.id === id);
      if (idx >= 0) { removed = turf.houses[idx]; removedTurf = turf; removedIdx = idx; break; }
    }
    if (removed) { removedTurf.houses.splice(removedIdx, 1); this.render(); }
    try {
      const res = await SheetsAPI.removeHouse(id);
      if (res.error) {
        // Restore on failure
        if (removed && removedTurf) { removedTurf.houses.splice(removedIdx, 0, removed); this.render(); }
        UI.toast(res.error, 'error'); return;
      }
      UI.toast('Marker removed');
    } catch(e) {
      if (removed && removedTurf) { removedTurf.houses.splice(removedIdx, 0, removed); this.render(); }
      UI.toast('Failed to remove marker', 'error');
    }
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

  async applyMultiResult(ids, resultKey, notes) {
    if (!ids.length) return;
    // Snapshot previous state for undo
    const prev = ids.map(id => {
      const { house } = this._findHouse(id);
      return house ? { id, result: house.result, result_by: house.result_by, result_date: house.result_date, notes: house.notes } : null;
    }).filter(Boolean);

    // Optimistic update all immediately
    const now = new Date().toISOString();
    ids.forEach(id => {
      const { house, turf, idx } = this._findHouse(id);
      if (!house) return;
      house.result      = resultKey;
      house.result_by   = UI.currentUser;
      house.result_date = now;
      if (notes) house.notes = house.notes ? house.notes + '; ' + notes : notes;
      this._writeLock[id] = Date.now() + 15000;
      MapModule.updateHouseMarker(house, turf, idx);
    });
    UI.renderSidebar(this._visibleTurfs());
    UI.updateStats(this.state.turfs);

    const icon = CONFIG.RESULTS.find(r => r.key === resultKey)?.icon || '';
    // Show undo toast
    UI.toastUndo(`${icon} Applied to ${ids.length} houses`, () => {
      // Undo: restore all to previous state
      prev.forEach(p => {
        const { house, turf, idx } = this._findHouse(p.id);
        if (!house) return;
        house.result      = p.result;
        house.result_by   = p.result_by;
        house.result_date = p.result_date;
        house.notes       = p.notes;
        this._writeLock[p.id] = Date.now() + 10000;
        MapModule.updateHouseMarker(house, turf, idx);
        // Fire undo API call
        if (p.result) SheetsAPI.setResult(p.id, p.result, p.result_by).catch(() => {});
        else SheetsAPI.clearResult(p.id).catch(() => {});
      });
      UI.renderSidebar(this._visibleTurfs());
      UI.updateStats(this.state.turfs);
      UI.toast('Undone ✓', 'success');
    });

    // Single batch API call instead of one per house
    UI.setSyncStatus('syncing');
    try {
      const items = ids.map(id => ({ id, result: resultKey, result_by: UI.currentUser }));
      const res = await SheetsAPI.bulkSetResult(items);
      if (res.error) {
        UI.setSyncStatus('error');
        UI.toast('Batch save failed — retrying individually', 'error');
        // Fallback: fire individual calls
        let failed = 0;
        await Promise.all(ids.map(async id => {
          try {
            const r = resultKey
              ? await SheetsAPI.setResult(id, resultKey, UI.currentUser)
              : await SheetsAPI.clearResult(id);
            if (r.error) failed++;
          } catch(e) { failed++; }
        }));
        UI.setSyncStatus(failed ? 'error' : 'ok');
      } else {
        UI.setSyncStatus('ok');
      }
    } catch(e) {
      UI.setSyncStatus('error');
      UI.toast('Batch save failed', 'error');
    }
  },

  _findHouse(id) {
    for (const turf of this.state.turfs) {
      const idx = turf.houses.findIndex(h => h.id === id);
      if (idx >= 0) return { turf, house: turf.houses[idx], idx };
    }
    return { turf: null, house: null, idx: -1 };
  },
};
