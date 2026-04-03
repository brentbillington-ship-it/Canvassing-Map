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
    _drawControl = new L.Control.Draw({
      position: 'topright',
      draw: {
        polygon:      { allowIntersection: false, showArea: false,
                        shapeOptions: { color: '#2e6ec2', fillColor: '#2e6ec2', fillOpacity: 0.15, weight: 2 } },
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
        // Mobile: show rectangle-tap UI instead of polygon draw
        _startMobileRectMode();
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
    _removeMobileRectUI();
  }

  // ── Mobile: two-tap rectangle mode ───────────────────────────────────────
  let _rectCorner1 = null;
  let _rectPreview = null;
  let _mobileStep  = 0;

  function _startMobileRectMode() {
    _mobileStep  = 0;
    _rectCorner1 = null;
    _showMobileRectBanner();
    _map.on('click', _onMobileMapTap);
    UI.toast('Tap first corner of your zone area', 'info');
  }

  function _onMobileMapTap(e) {
    if (_mobileStep === 0) {
      _rectCorner1 = e.latlng;
      _mobileStep  = 1;
      // Show a small pin at corner 1
      if (_rectPreview) { _rectPreview.remove(); }
      _rectPreview = L.circleMarker(_rectCorner1, {
        radius: 7, color: '#2e6ec2', fillColor: '#2e6ec2', fillOpacity: 0.8, weight: 2
      }).addTo(_map);
      UI.toast('Now tap the opposite corner', 'info');
    } else if (_mobileStep === 1 && _rectCorner1) {
      const corner2 = e.latlng;
      if (_rectPreview) { _rectPreview.remove(); _rectPreview = null; }
      _mobileStep = 0;
      _map.off('click', _onMobileMapTap);
      _removeMobileRectBanner();

      // Build rectangle layer from two corners
      const bounds = L.latLngBounds(_rectCorner1, corner2);
      const layer  = L.rectangle(bounds, {
        color: '#2e6ec2', fillColor: '#2e6ec2', fillOpacity: 0.15, weight: 2
      });
      _onNewPolygon(layer);
    }
  }

  function _removeMobileRectUI() {
    _map.off('click', _onMobileMapTap);
    if (_rectPreview) { _rectPreview.remove(); _rectPreview = null; }
    _mobileStep  = 0;
    _rectCorner1 = null;
    _removeMobileRectBanner();
  }

  function _showMobileRectBanner() {
    document.getElementById('mobile-rect-banner')?.remove();
    const b = document.createElement('div');
    b.id        = 'mobile-rect-banner';
    b.className = 'mobile-rect-banner';
    b.innerHTML = `<span>📱 Tap two opposite corners to define zone area</span>
      <button onclick="TurfDraw._cancelMobileRect()">✕ Cancel</button>`;
    document.body.appendChild(b);
  }

  function _removeMobileRectBanner() {
    document.getElementById('mobile-rect-banner')?.remove();
  }

  function _cancelMobileRect() {
    _removeMobileRectUI();
    _active = false;
    const btn = document.getElementById('draw-mode-btn');
    if (btn) { btn.textContent = '✏️ Draw Zone'; btn.classList.remove('active-admin-btn'); }
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
            color, fillColor: color, fillOpacity: 0.12, weight: 2.5, dashArray: '5,4', opacity: 0.8
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
    const ring = _getOuterRing(layer);
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
    if (!_active || _editingLetter || _isMobile()) return;
    _activatePolygonDraw();
    _showDrawToolbar();
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
        App.state.turfs = res.turfs;
      }
    } catch(e) {
      liveLetters = new Set(App.state.turfs.map(t => String(t.letter)));
    }
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

  // ── Floating draw toolbar ──────────────────────────────────────────────────
  function _showDrawToolbar() {
    _hideDrawToolbar();
    const bar = document.createElement('div');
    bar.id = 'draw-toolbar';
    bar.className = 'draw-toolbar';
    bar.innerHTML = `
      <span class="dt-hint">Click to place points · Double-click to finish</span>
      <button class="dt-btn dt-undo" onclick="TurfDraw._undoLastVertex()">↩ Undo Last Point</button>
      <button class="dt-btn dt-cancel" onclick="TurfDraw._cancelDraw()">✕ Cancel</button>`;
    document.body.appendChild(bar);
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
    UI.toast('Draw cancelled');
  }

  return {
    init, toggle, isActive, isEditing, loadTurfs, removeTurfLayer,
    startEditBoundary, resortTurf, _onCommercialToggle, _cancelMobileRect,
    _commitEdit, _cancelEditMode, _undoLastVertex, _cancelDraw,
  };
})();
