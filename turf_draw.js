// ─── Turf Draw Module ─────────────────────────────────────────────────────────

const TurfDraw = (() => {
  let _map           = null;
  let _drawnLayers   = null;
  let _drawControl   = null;
  let _polygonHandler = null;   // active Leaflet.draw handler
  let _active        = false;
  let _turfLetters   = {};
  let _editingLetter = null;
  let _editLayer     = null;
  let _pendingRing   = null;
  let _lastEscTime   = 0;

  const _isMobile = () => window.innerWidth <= 680 || 'ontouchstart' in window;

  function init(mapRef) {
    _map         = mapRef;
    _drawnLayers = new L.FeatureGroup().addTo(_map);

    // Draw control — only used on desktop for the polygon tool
    // Bright yellow stroke so the in-progress polygon reads clearly against satellite imagery
    _drawControl = new L.Control.Draw({
      position: 'topright',
      draw: {
        polygon: {
          allowIntersection: false,
          showArea: false,
          shapeOptions: {
            color:       '#FFE600',
            fillColor:   '#FFE600',
            fillOpacity: 0.22,
            weight:      3.5,
            opacity:     1.0,
          },
          // Guide line from last vertex to cursor
          guideLayers: [],
        },
        rectangle:    false,
        polyline:     false, circle: false, circlemarker: false, marker: false,
      },
      edit: { featureGroup: _drawnLayers, remove: false }
    });

    _map.on(L.Draw.Event.CREATED, e => {
      if (_editingLetter) return; // ignore CREATED events during edit mode
      _onNewPolygon(e.layer);
    });
    _map.on(L.Draw.Event.EDITED,  e => {
      e.layers.eachLayer(layer => {
        const lid    = _drawnLayers.getLayerId(layer);
        const letter = _turfLetters[lid];
        if (letter) _onEditedPolygon(letter, layer);
      });
    });

    // Right-click: undo last vertex during draw (first), cancel (second within 1s)
    let _lastRightClickTime = 0;
    _map.on('contextmenu', e => {
      L.DomEvent.preventDefault(e.originalEvent);
      if (_editingLetter) { _cancelEditMode(); UI.toast('Edit cancelled'); return; }
      if (_active && _polygonHandler) {
        const now = Date.now();
        if (_lastRightClickTime && now - _lastRightClickTime < 1000) {
          _deactivateDraw();
          _active = false;
          const btn = document.getElementById('draw-mode-btn');
          if (btn) { btn.textContent = '✏️ Draw Zone'; btn.classList.remove('active-admin-btn'); }
          _hideDrawToolbar();
          document.getElementById('draw-mode-banner')?.remove();
          UI.toast('Draw cancelled');
        } else {
          try { _polygonHandler.deleteLastVertex(); } catch(err) {}
          UI.toast('Last point removed — right-click again to cancel', 'info');
        }
        _lastRightClickTime = now;
      }
    });

    // ESC: first press removes last vertex during draw; second press cancels draw
    document.addEventListener('keydown', e => {
      if (e.key !== 'Escape') return;
      if (_editingLetter) { _cancelEditMode(); UI.toast('Edit cancelled'); return; }
      if (_active && _polygonHandler) {
        const now = Date.now();
        if (_lastEscTime && now - _lastEscTime < 1000) {
          // Second ESC within 1s — cancel draw entirely
          _deactivateDraw();
          _active = false;
          const btn = document.getElementById('draw-mode-btn');
          if (btn) { btn.textContent = '✏️ Draw Zone'; btn.classList.remove('active-admin-btn'); }
          _hideDrawToolbar();
          document.getElementById('draw-mode-banner')?.remove();
          UI.toast('Draw cancelled');
        } else {
          // First ESC — delete last vertex
          try { _polygonHandler.deleteLastVertex(); } catch(err) {}
          UI.toast('Last vertex removed — ESC again to cancel', 'info');
        }
        _lastEscTime = now;
      }
    });
  }

  // ── Toggle draw mode ──────────────────────────────────────────────────────
  function toggle() {
    _active = !_active;
    if (_active) {
      if (_isMobile()) {
        // Mobile: freeform polygon draw with double-tap
        _startMobilePolygonMode();
      } else {
        // Desktop: add toolbar and immediately activate polygon handler
        _map.addControl(_drawControl);
        _activatePolygonDraw();
        _showDrawToolbar();
        UI.toast('Click to place vertices — double-click to finish', 'info');
      }
    } else {
      _deactivateDraw();
      _hideDrawToolbar();
      UI.toast('Draw mode OFF');
    }
    return _active;
  }

  function isActive() { return _active; }

  // ── Desktop: activate polygon draw handler directly ───────────────────────
  function _activatePolygonDraw() {
    // Leaflet.draw exposes the handler directly — enable it programmatically
    if (_polygonHandler) { try { _polygonHandler.disable(); } catch(e) {} }
    _polygonHandler = new L.Draw.Polygon(_map, _drawControl.options.draw.polygon);
    _polygonHandler.enable();
  }

  function _deactivateDraw() {
    if (_polygonHandler) { try { _polygonHandler.disable(); } catch(e) {} _polygonHandler = null; }
    if (!_isMobile()) { try { _map.removeControl(_drawControl); } catch(e) {} }
    _cancelEditMode();
    _removeMobilePolygonUI();
  }

  // ── Mobile: freeform polygon draw (double-tap to place vertices) ─────────
  let _mobileVertices = [];
  let _mobilePolyline = null;
  let _mobilePolygonPreview = null;
  let _mobileMarkers  = [];
  let _lastTapTime    = 0;
  let _lastTapPoint   = null;

  function _startMobilePolygonMode() {
    _mobileVertices = [];
    _mobilePolyline = null;
    _mobilePolygonPreview = null;
    _mobileMarkers  = [];
    _lastTapTime    = 0;
    _lastTapPoint   = null;
    _showMobilePolyBanner();
    _map.getContainer().addEventListener('touchend', _onMobileTouchEnd);
    UI.toast('Double-tap to place zone vertices', 'info');
  }

  function _onMobileTouchEnd(e) {
    // Ignore multi-touch (pinch zoom still in progress)
    if (e.touches.length > 0) return;
    const now   = Date.now();
    const touch = e.changedTouches[0];
    const pt    = { x: touch.clientX, y: touch.clientY };

    if (_lastTapTime && (now - _lastTapTime) < 350 && _lastTapPoint) {
      const dx = pt.x - _lastTapPoint.x;
      const dy = pt.y - _lastTapPoint.y;
      if (Math.sqrt(dx * dx + dy * dy) < 40) {
        // Double-tap detected — prevent map zoom and place vertex
        e.preventDefault();
        const rect = _map.getContainer().getBoundingClientRect();
        const cp   = L.point(pt.x - rect.left, pt.y - rect.top);
        const ll   = _map.containerPointToLatLng(cp);
        _addMobileVertex(ll);
        _lastTapTime  = 0;
        _lastTapPoint = null;
        return;
      }
    }
    _lastTapTime  = now;
    _lastTapPoint = pt;
  }

  // Draw colors — bright yellow so in-progress polygon reads on satellite imagery
  const DRAW_COLOR      = '#FFE600';
  const DRAW_FILL       = '#FFE600';
  const DRAW_FILL_OPACITY = 0.22;
  const DRAW_WEIGHT     = 3.5;

  function _addMobileVertex(latlng) {
    _mobileVertices.push(latlng);

    // Vertex marker — large, high-contrast yellow dot with dark outline
    const m = L.circleMarker(latlng, {
      radius: 9, color: '#1a1a1a', fillColor: DRAW_COLOR, fillOpacity: 1.0, weight: 2
    }).addTo(_map);
    _mobileMarkers.push(m);

    // Polyline through vertices
    if (_mobilePolyline) _mobilePolyline.remove();
    _mobilePolyline = L.polyline(_mobileVertices, {
      color: DRAW_COLOR, weight: DRAW_WEIGHT,
    }).addTo(_map);

    // Polygon preview when 3+ vertices
    if (_mobilePolygonPreview) _mobilePolygonPreview.remove();
    if (_mobileVertices.length >= 3) {
      _mobilePolygonPreview = L.polygon(_mobileVertices, {
        color: DRAW_COLOR, fillColor: DRAW_FILL,
        fillOpacity: DRAW_FILL_OPACITY, weight: DRAW_WEIGHT,
      }).addTo(_map);
      _showFinishZoneBtn();
    }

    _updateMobilePolyBanner();
  }

  function _undoMobileVertex() {
    if (!_mobileVertices.length) return;
    _mobileVertices.pop();
    const m = _mobileMarkers.pop();
    if (m) m.remove();

    if (_mobilePolyline) { _mobilePolyline.remove(); _mobilePolyline = null; }
    if (_mobilePolygonPreview) { _mobilePolygonPreview.remove(); _mobilePolygonPreview = null; }

    if (_mobileVertices.length >= 1) {
      _mobilePolyline = L.polyline(_mobileVertices, {
        color: DRAW_COLOR, weight: DRAW_WEIGHT,
      }).addTo(_map);
    }
    if (_mobileVertices.length >= 3) {
      _mobilePolygonPreview = L.polygon(_mobileVertices, {
        color: DRAW_COLOR, fillColor: DRAW_FILL,
        fillOpacity: DRAW_FILL_OPACITY, weight: DRAW_WEIGHT,
      }).addTo(_map);
      _showFinishZoneBtn();
    } else {
      _hideFinishZoneBtn();
    }
    _updateMobilePolyBanner();
  }

  function _finishMobilePolygon() {
    if (_mobileVertices.length < 3) return;
    const layer = L.polygon(_mobileVertices, {
      color: DRAW_COLOR, fillColor: DRAW_FILL,
      fillOpacity: DRAW_FILL_OPACITY, weight: DRAW_WEIGHT,
    });
    _removeMobilePolygonUI();
    _onNewPolygon(layer);
  }

  function _removeMobilePolygonUI() {
    _map.getContainer().removeEventListener('touchend', _onMobileTouchEnd);
    _mobileMarkers.forEach(m => m.remove());
    _mobileMarkers = [];
    if (_mobilePolyline) { _mobilePolyline.remove(); _mobilePolyline = null; }
    if (_mobilePolygonPreview) { _mobilePolygonPreview.remove(); _mobilePolygonPreview = null; }
    _mobileVertices = [];
    _lastTapTime = 0;
    _lastTapPoint = null;
    _removeMobilePolyBanner();
    _hideFinishZoneBtn();
  }

  function _showMobilePolyBanner() {
    document.getElementById('mobile-poly-banner')?.remove();
    const b = document.createElement('div');
    b.id        = 'mobile-poly-banner';
    b.className = 'mobile-poly-banner';
    b.innerHTML = `<span id="mpb-status">Double-tap to place vertices (0 placed)</span>
      <div class="mpb-btns">
        <button onclick="TurfDraw._undoMobileVertex()">↩ Undo</button>
        <button onclick="TurfDraw._cancelMobilePolygon()">✕ Cancel</button>
      </div>`;
    document.body.appendChild(b);
  }

  function _updateMobilePolyBanner() {
    const el = document.getElementById('mpb-status');
    if (el) el.textContent = `Double-tap to place vertices (${_mobileVertices.length} placed)`;
  }

  function _removeMobilePolyBanner() {
    document.getElementById('mobile-poly-banner')?.remove();
  }

  function _showFinishZoneBtn() {
    if (document.getElementById('finish-zone-btn')) return;
    const btn = document.createElement('button');
    btn.id = 'finish-zone-btn';
    btn.className = 'finish-zone-btn';
    btn.textContent = 'Finish Zone';
    btn.onclick = () => TurfDraw._finishMobilePolygon();
    document.body.appendChild(btn);
  }

  function _hideFinishZoneBtn() {
    document.getElementById('finish-zone-btn')?.remove();
  }

  function _cancelMobilePolygon() {
    _removeMobilePolygonUI();
    _active = false;
    const btn = document.getElementById('draw-mode-btn');
    if (btn) { btn.textContent = '✏️ Draw Zone'; btn.classList.remove('active-admin-btn'); }
    document.getElementById('draw-mode-banner')?.remove();
    UI.toast('Draw cancelled');
  }

  // ── Load saved turf polygons ──────────────────────────────────────────────
  function loadTurfs(turfs) {
    _drawnLayers.clearLayers();
    _turfLetters = {};
    turfs.forEach((turf, i) => {
      if (!turf.polygon_geojson) return;
      let geojson = turf.polygon_geojson;
      if (typeof geojson === 'string') { try { geojson = JSON.parse(geojson); } catch(e) { return; } }
      try {
        const color = turf.color || CONFIG.TURF_COLORS[i % CONFIG.TURF_COLORS.length];
        // Wrap bare Geometry in Feature so L.geoJSON can parse it
        let gjInput = geojson;
        if (gjInput.type === 'Polygon' || gjInput.type === 'MultiPolygon') {
          gjInput = { type: 'Feature', geometry: gjInput, properties: {} };
        }
        L.geoJSON(gjInput).eachLayer(gjLayer => {
          const poly = L.polygon(gjLayer.getLatLngs(), {
            color, fillColor: color, fillOpacity: 0.12, weight: 2.5, dashArray: null, opacity: 1.0
          });
          _drawnLayers.addLayer(poly);
          _turfLetters[_drawnLayers.getLayerId(poly)] = turf.letter;
        });
      } catch(e) {}
    });
  }

  function removeTurfLayer(letter) {
    Object.entries(_turfLetters).forEach(([lid, l]) => {
      if (String(l) === String(letter)) {
        const layer = _drawnLayers.getLayer(parseInt(lid));
        if (layer) _drawnLayers.removeLayer(layer);
        delete _turfLetters[parseInt(lid)];
      }
    });
  }

  // ── Edit boundary mode ────────────────────────────────────────────────────
  function startEditBoundary(letter) {
    const turf = App.state.turfs.find(t => String(t.letter) === String(letter));
    if (!turf || !turf.polygon_geojson) {
      UI.toast('No boundary yet — draw one first', 'error'); return;
    }
    // Deactivate draw mode if active — prevents draw staying on after edit exits
    if (_active) {
      _deactivateDraw();
      _active = false;
      const btn = document.getElementById('draw-mode-btn');
      if (btn) { btn.textContent = '✏️ Draw Zone'; btn.classList.remove('active-admin-btn'); }
    }
    _cancelEditMode();
    _editingLetter = letter;

    // Do NOT add draw control during edit — it overrides polygon colors with Leaflet.draw blue
    // L.EditToolbar.Edit works standalone without the draw toolbar mounted

    let foundLayer = null;
    Object.entries(_turfLetters).forEach(([lid, l]) => {
      if (String(l) === String(letter)) foundLayer = _drawnLayers.getLayer(parseInt(lid));
    });
    if (!foundLayer) { UI.toast('Layer not found — try refreshing', 'error'); _editingLetter = null; return; }

    _editLayer = foundLayer;
    try {
      const editFG  = L.featureGroup([foundLayer]);
      const handler = new L.EditToolbar.Edit(_map, { featureGroup: editFG });
      handler.enable();
      _editLayer._ckEditHandler = handler;
    } catch(e) { console.warn('Edit handler error:', e); }

    UI.showEditBoundaryBanner(letter);
  }

  function _commitEdit() {
    if (!_editingLetter || !_editLayer) return;
    if (_editLayer._ckEditHandler) {
      _editLayer._ckEditHandler.save();
      _editLayer._ckEditHandler.disable();
    }
    _onEditedPolygon(_editingLetter, _editLayer);
    _editingLetter = null; _editLayer = null;
    UI.hideEditBoundaryBanner();
  }

  function _cancelEditMode() {
    if (_editLayer?._ckEditHandler) {
      try { _editLayer._ckEditHandler.revertLayers(); _editLayer._ckEditHandler.disable(); } catch(e) {}
    }
    _editingLetter = null; _editLayer = null;
    UI.hideEditBoundaryBanner();
  }

  // ── New polygon drawn ─────────────────────────────────────────────────────
  function _onNewPolygon(layer) {
    // Snap vertices to nearby parcel boundaries before computing contained parcels.
    // Do not snap in a way that pulls zone boundaries into unintended parcels —
    // snapping only moves existing vertices, never adds new ones.
    const rawRing = _getOuterRing(layer);
    const ring    = _snapRingToParcelVertices(rawRing);
    _pendingRing = ring;
    const { residential, excluded } = ParcelsUtil.parcelsInPolygon(ring, false);
    const centroid = ParcelsUtil.leafletRingCentroid(ring);
    const sorted   = ParcelsUtil.walkOrder(residential, centroid);
    _hideDrawToolbar();
    _showPopulateModal({ layer, ring, sorted, excluded });
    // Disable current handler — will re-arm after modal resolves
    if (_polygonHandler) { try { _polygonHandler.disable(); } catch(e) {} _polygonHandler = null; }
  }

  // Re-arm polygon draw so user can immediately draw another zone
  function _rearmDraw() {
    if (!_active || _editingLetter) return;
    if (_isMobile()) {
      // On mobile, restart touch-based vertex mode so the next zone can be drawn immediately
      _startMobilePolygonMode();
      return;
    }
    _activatePolygonDraw();
    _showDrawToolbar();
    // Disable undo button until first vertex is placed (fresh state)
    const undoBtn = document.querySelector('.dt-undo');
    if (undoBtn) undoBtn.disabled = true;
    UI.toast('Draw mode ready — click to start next zone', 'info', 2000);
  }

  // ── Edited polygon ────────────────────────────────────────────────────────
  function _onEditedPolygon(letter, layer) {
    const ring = _getOuterRing(layer);
    const turf = App.state.turfs.find(t => String(t.letter) === String(letter));
    if (!turf) return;

    const { residential, excluded } = ParcelsUtil.parcelsInPolygon(ring, false);
    const existingAddrs = new Set(turf.houses.map(h => h.address.toUpperCase().trim()));
    const newAddrs      = new Set(residential.map(p => p.address.toUpperCase().trim()));

    const toRemove  = turf.houses.filter(h => !newAddrs.has(h.address.toUpperCase().trim()) && !h.result);
    const toKeep    = turf.houses.filter(h =>  newAddrs.has(h.address.toUpperCase().trim()) || !!h.result);
    const toAdd     = residential.filter(p => !existingAddrs.has(p.address.toUpperCase().trim()));
    const centroid  = ParcelsUtil.leafletRingCentroid(ring);
    const sortedNew = ParcelsUtil.walkOrder(toAdd, centroid);
    _showDiffModal({ letter, layer, toKeep, toRemove, toAdd: sortedNew, excluded });
  }

  // ── Populate modal ────────────────────────────────────────────────────────
  function _nextAvailableLetter(usedSet) {
    for (let i = 1; i < 1000; i++) {
      if (!usedSet.has(String(i))) return String(i);
    }
    return null;
  }

  async function _showPopulateModal({ layer, ring, sorted, excluded }) {
    // Capture geojson immediately before any await (layer reference stays valid but be safe)
    const geojsonSnapshot = layer.toGeoJSON().geometry;
    // Fetch live zone list from server to get accurate next number
    UI.toast('Checking zones…', 'info', 1500);
    let liveLetters;
    try {
      const res = await SheetsAPI.getAll();
      liveLetters = new Set((res.turfs || []).map(t => String(t.letter)));
      // Sync local turf list but preserve house data and polygon already in state
      if (res.turfs) {
        res.turfs.forEach(rt => {
          const existing = App.state.turfs.find(t => String(t.letter) === String(rt.letter));
          if (existing) {
            rt.houses = existing.houses;
            rt.polygon_geojson = existing.polygon_geojson; // preserve — not in getAll anymore
          }
        });
        App.state.turfs = App._dedupTurfs(res.turfs);
      }
    } catch(e) {
      liveLetters = new Set(App.state.turfs.map(t => String(t.letter)));
    }
    // Also exclude zone numbers already reserved in this session's queue or pending polygons.
    // This prevents "Zone X already taken" collisions when a single user queues multiple zones
    // in rapid succession before any of them have been written to the Sheet.
    const queuedLetters = App._createQueue.map(j => String(j.letter));
    const pendingLetters = Object.keys(App._pendingPolygons);
    queuedLetters.forEach(l => liveLetters.add(l));
    pendingLetters.forEach(l => liveLetters.add(l));
    let nextLetter = _nextAvailableLetter(liveLetters);
    if (!nextLetter) { UI.toast('No zone numbers available', 'error'); return; }

    const exclHtml = excluded.length
      ? `<div class="pop-excl-row">
           <span class="pop-excl-count">${excluded.length} commercial/apt excluded</span>
           <label class="pop-excl-toggle">
             <input type="checkbox" id="include-commercial"
               onchange="TurfDraw._onCommercialToggle()"/> Include them
           </label>
         </div>`
      : '';

    UI._modal('Create Zone from Drawing', `
      <div class="pop-count-row">
        <span class="pop-count-badge" id="pop-count-badge">${sorted.length}</span>
        <span class="pop-count-label"> residential parcels found</span>
      </div>
      ${exclHtml}
      <div class="pop-letter-row">
        <span class="pop-letter-label">Zone ID:</span>
        <span class="pop-letter-badge" id="zone-id-badge">${nextLetter}</span>
      </div>

      <label class="f-label" style="margin-top:8px">Assign Volunteer</label>
      ${UI._userDropdownHtml('')}
    `, () => {
      const letter    = nextLetter;
      const sel       = document.getElementById('f-volunteer-sel');
      const volunteer = sel?.value || '[UNASSIGNED]';
      const opt       = sel?.options[sel?.selectedIndex];
      const color     = (opt?.dataset?.color && volunteer !== '[UNASSIGNED]') ? opt.dataset.color : '#6b7280';
      const inclComm  = document.getElementById('include-commercial')?.checked || false;

      if (!letter) { UI.toast('No available zone number — check existing zones', 'error'); return false; }

      const { residential } = ParcelsUtil.parcelsInPolygon(ring, inclComm);
      if (!residential.length) { UI.toast('No parcels found — try a different area', 'error'); return false; }
      const centroid     = ParcelsUtil.leafletRingCentroid(ring);
      const finalParcels = ParcelsUtil.walkOrder(residential, centroid);

      const geojson = geojsonSnapshot;
      App.createTurfFromDraw({ letter, color, volunteer, geojson, parcels: finalParcels, pendingLayer: layer });
      _rearmDraw();
      return true;
    }, 'Create Zone', () => _rearmDraw());
  }
  // ── Diff modal ────────────────────────────────────────────────────────────
  function _showDiffModal({ letter, layer, toKeep, toRemove, toAdd, excluded }) {
    const kept = toKeep.filter(h => !!h.result).length;
    UI._modal(`Edit Zone ${letter} Boundary`, `
      <div class="diff-summary">
        <div class="diff-row diff-add"><span class="diff-icon">＋</span><strong>${toAdd.length}</strong> new parcels will be added</div>
        <div class="diff-row diff-remove"><span class="diff-icon">−</span><strong>${toRemove.length}</strong> parcels removed (no action taken)</div>
        <div class="diff-row diff-keep"><span class="diff-icon">✓</span><strong>${kept}</strong> parcels kept (have recorded results)</div>
        ${excluded.length ? `<div class="diff-row diff-excl"><span class="diff-icon">○</span><strong>${excluded.length}</strong> commercial/apt excluded</div>` : ''}
      </div>
      <div class="f-hint" style="margin-top:10px">Houses with recorded results are always preserved.</div>
    `, () => {
      const geojson = layer.toGeoJSON().geometry;
      App.updateTurfBoundary({ letter, geojson, toKeep, toRemove, toAdd });
      return true;
    }, 'Apply Changes');
  }

  // ── Commercial toggle ─────────────────────────────────────────────────────
  function _onCommercialToggle() {
    if (!_pendingRing) return;
    const incl = document.getElementById('include-commercial')?.checked || false;
    const { residential } = ParcelsUtil.parcelsInPolygon(_pendingRing, incl);
    const badge = document.getElementById('pop-count-badge');
    if (badge) badge.textContent = residential.length;
  }

  // ── Re-sort by walk order ─────────────────────────────────────────────────
  function resortTurf(letter, startPt) {
    const turf = App.state.turfs.find(t => String(t.letter) === String(letter));
    if (!turf || !turf.houses.length) return;

    const withResult    = turf.houses.filter(h => h.result);
    const withoutResult = turf.houses.filter(h => !h.result);

    let pt = startPt;
    if (!pt && turf.polygon_geojson) {
      try {
        let gj = turf.polygon_geojson;
        if (typeof gj === 'string') gj = JSON.parse(gj);
        const ring = gj.coordinates[0].map(([lo, la]) => ({ lat: la, lon: lo }));
        pt = ParcelsUtil.leafletRingCentroid(ring);
      } catch(e) {}
    }
    if (!pt && withoutResult.length) pt = withoutResult[0];

    const sorted = turf.mode === 'knock'
      ? withoutResult.slice().sort((a, b) => a.address.localeCompare(b.address))
      : ParcelsUtil.walkOrder(withoutResult, pt || { lat: 32.972, lon: -96.978 });
    App.reorderTurfHouses(letter, [...withResult, ...sorted]);
    UI.toast(`Zone ${letter} re-sorted ✓`, 'success');
  }

  function _getOuterRing(layer) {
    const lls = layer.getLatLngs();
    return Array.isArray(lls[0]) ? lls[0] : lls;
  }

  function isEditing() { return !!_editingLetter; }

  // ── Parcel vertex snapping ────────────────────────────────────────────────
  // Configurable threshold (meters). Vertices closer than this to a parcel
  // vertex will snap to that parcel vertex.
  const SNAP_THRESHOLD_M = 10;

  // Lazy-built grid index: cell_deg bucket → [{lat,lon}] parcel vertices
  let _parcelGrid = null;
  const _GRID_CELL = 0.001; // ~110m grid cells

  function _buildParcelGrid() {
    if (_parcelGrid) return _parcelGrid;
    if (typeof PARCELS_GEOJSON === 'undefined') { _parcelGrid = {}; return _parcelGrid; }
    const grid = {};
    const cell = _GRID_CELL;
    for (const feat of PARCELS_GEOJSON.features) {
      const g = feat.geometry;
      const rings = g.type === 'Polygon'      ? g.coordinates
                  : g.type === 'MultiPolygon' ? g.coordinates.flatMap(p => p)
                  : [];
      for (const ring of rings) {
        for (const [lon, lat] of ring) {
          const key = `${Math.floor(lat / cell)},${Math.floor(lon / cell)}`;
          if (!grid[key]) grid[key] = [];
          grid[key].push({ lat, lon });
        }
      }
    }
    _parcelGrid = grid;
    return _parcelGrid;
  }

  function _distM(lat1, lon1, lat2, lon2) {
    const dlat = (lat2 - lat1) * 111320;
    const dlon = (lon2 - lon1) * 111320 * Math.cos((lat1 + lat2) * Math.PI / 360);
    return Math.sqrt(dlat * dlat + dlon * dlon);
  }

  // Return nearest parcel vertex within SNAP_THRESHOLD_M, or null
  function _nearestParcelVertex(lat, lon) {
    const grid  = _buildParcelGrid();
    const cell  = _GRID_CELL;
    const radCells = Math.ceil(SNAP_THRESHOLD_M / (111320 * cell)) + 1;
    const rBase = Math.floor(lat / cell);
    const cBase = Math.floor(lon / cell);
    let best = null, bestDist = SNAP_THRESHOLD_M + 1;
    for (let dr = -radCells; dr <= radCells; dr++) {
      for (let dc = -radCells; dc <= radCells; dc++) {
        const key = `${rBase + dr},${cBase + dc}`;
        for (const v of (grid[key] || [])) {
          const d = _distM(lat, lon, v.lat, v.lon);
          if (d < bestDist) { bestDist = d; best = v; }
        }
      }
    }
    return best;
  }

  // Snap a drawn ring (array of Leaflet LatLngs) to nearest parcel vertices.
  // Returns a new array of Leaflet LatLngs.
  function _snapRingToParcelVertices(ring) {
    return ring.map(ll => {
      const lat = ll.lat ?? ll[0];
      const lon = ll.lng ?? ll[1];
      const snap = _nearestParcelVertex(lat, lon);
      if (snap) return L.latLng(snap.lat, snap.lon);
      return ll;
    });
  }

  // ── Floating draw toolbar ──────────────────────────────────────────────────
  function _showDrawToolbar() {
    _hideDrawToolbar();
    const bar = document.createElement('div');
    bar.id = 'draw-toolbar';
    bar.className = 'draw-toolbar';
    bar.innerHTML = `
      <span class="dt-hint">Click to place points · Double-click to finish</span>
      <button class="dt-btn dt-undo" onclick="TurfDraw._undoLastVertex()" disabled>↩ Undo Last Point</button>
      <button class="dt-btn dt-cancel" onclick="TurfDraw._cancelDraw()">✕ Cancel</button>`;
    document.body.appendChild(bar);
    // Enable undo button when the first vertex is placed
    _map.once('draw:drawvertex', () => {
      const btn = document.querySelector('.dt-undo');
      if (btn) btn.disabled = false;
    });
  }

  function _hideDrawToolbar() {
    document.getElementById('draw-toolbar')?.remove();
  }

  function _undoLastVertex() {
    if (_polygonHandler) {
      try { _polygonHandler.deleteLastVertex(); } catch(e) {}
    }
  }

  function _cancelDraw() {
    _deactivateDraw();
    _active = false;
    _hideDrawToolbar();
    const btn = document.getElementById('draw-mode-btn');
    if (btn) { btn.textContent = '✏️ Draw Zone'; btn.classList.remove('active-admin-btn'); }
    document.getElementById('draw-mode-banner')?.remove();
    UI.toast('Draw cancelled');
  }

  return {
    init, toggle, isActive, isEditing, loadTurfs, removeTurfLayer,
    startEditBoundary, resortTurf, _onCommercialToggle,
    _cancelMobilePolygon, _undoMobileVertex, _finishMobilePolygon,
    _commitEdit, _cancelEditMode, _undoLastVertex, _cancelDraw,
  };
})();
