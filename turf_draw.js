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
        rectangle:    { shapeOptions: { color: '#2e6ec2', fillColor: '#2e6ec2', fillOpacity: 0.15, weight: 2 } },
        polyline:     false, circle: false, circlemarker: false, marker: false,
      },
      edit: { featureGroup: _drawnLayers, remove: false }
    });

    _map.on(L.Draw.Event.CREATED, e => _onNewPolygon(e.layer));
    _map.on(L.Draw.Event.EDITED,  e => {
      e.layers.eachLayer(layer => {
        const lid    = _drawnLayers.getLayerId(layer);
        const letter = _turfLetters[lid];
        if (letter) _onEditedPolygon(letter, layer);
      });
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
        UI.toast('Click to place polygon vertices — double-click to finish', 'info');
      }
    } else {
      _deactivateDraw();
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
    UI.toast('Tap first corner of your turf area', 'info');
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
    b.innerHTML = `<span>📱 Tap two opposite corners to define turf area</span>
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
    if (btn) { btn.textContent = '✏️ Draw Turf'; btn.classList.remove('active-admin-btn'); }
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
        L.geoJSON(geojson).eachLayer(gjLayer => {
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
      if (l === letter) {
        const layer = _drawnLayers.getLayer(parseInt(lid));
        if (layer) _drawnLayers.removeLayer(layer);
        delete _turfLetters[parseInt(lid)];
      }
    });
  }

  // ── Edit boundary mode ────────────────────────────────────────────────────
  function startEditBoundary(letter) {
    const turf = App.state.turfs.find(t => t.letter === letter);
    if (!turf || !turf.polygon_geojson) {
      UI.toast('No boundary yet — draw one first', 'error'); return;
    }
    _cancelEditMode();
    _editingLetter = letter;
    if (!_active) toggle();

    let foundLayer = null;
    Object.entries(_turfLetters).forEach(([lid, l]) => {
      if (l === letter) foundLayer = _drawnLayers.getLayer(parseInt(lid));
    });
    if (!foundLayer) { UI.toast('Layer not found — try refreshing', 'error'); _editingLetter = null; return; }

    _editLayer = foundLayer;
    try {
      const editFG  = L.featureGroup([foundLayer]);
      const handler = new L.EditToolbar.Edit(_map, { featureGroup: editFG });
      handler.enable();
      _editLayer._ckEditHandler = handler;
    } catch(e) {}

    UI.showEditBoundaryBanner(letter, () => _commitEdit(), () => _cancelEditMode());
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
    _showPopulateModal({ layer, ring, sorted, excluded });
    // Deactivate draw handler after shape complete
    if (_polygonHandler) { try { _polygonHandler.disable(); } catch(e) {} _polygonHandler = null; }
  }

  // ── Edited polygon ────────────────────────────────────────────────────────
  function _onEditedPolygon(letter, layer) {
    const ring = _getOuterRing(layer);
    const turf = App.state.turfs.find(t => t.letter === letter);
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
  function _showPopulateModal({ layer, ring, sorted, excluded }) {
    const turfs      = App.state.turfs;
    const nextLetter = String.fromCharCode(65 + turfs.length);
    const colors     = CONFIG.TURF_COLORS;
    const colorOpts  = colors.map((c, i) =>
      `<span class="color-swatch${i === 0 ? ' selected' : ''}" data-color="${c}" style="background:${c}"
        onclick="this.parentElement.querySelectorAll('.color-swatch').forEach(s=>s.classList.remove('selected'));this.classList.add('selected')"></span>`
    ).join('');

    const exclHtml = excluded.length
      ? `<div class="pop-excl-row">
           <span class="pop-excl-count">${excluded.length} commercial/apt excluded</span>
           <label class="pop-excl-toggle">
             <input type="checkbox" id="include-commercial"
               onchange="TurfDraw._onCommercialToggle()"/> Include them
           </label>
         </div>`
      : '';

    UI._modal('Create Turf from Drawing', `
      <div class="pop-count-row">
        <span class="pop-count-badge" id="pop-count-badge">${sorted.length}</span>
        <span class="pop-count-label"> residential parcels found</span>
      </div>
      ${exclHtml}
      <label class="f-label" style="margin-top:12px">Turf mode</label>
      <div class="mode-toggle-row">
        <label class="mode-opt selected" id="mode-hanger">
          <input type="radio" name="turf-mode" value="hanger" checked style="display:none"/>
          🗂 Hanger Route
        </label>
        <label class="mode-opt" id="mode-doorknock">
          <input type="radio" name="turf-mode" value="doorknock" style="display:none"/>
          🚪 Door Knock
        </label>
      </div>
      <label class="f-label" style="margin-top:8px">Turf letter</label>
      <input id="f-letter" class="f-input" type="text" maxlength="2" value="${nextLetter}" placeholder="A"/>
      <label class="f-label">Volunteer name (optional)</label>
      <input id="f-volunteer" class="f-input" type="text" placeholder="Volunteer name"/>
      <label class="f-label">Color</label>
      <div class="color-row">${colorOpts}</div>
    `, () => {
      const letter    = (document.getElementById('f-letter')?.value || '').toUpperCase().trim();
      const volunteer = (document.getElementById('f-volunteer')?.value || '').trim();
      const color     = document.querySelector('.color-swatch.selected')?.dataset.color || colors[0];
      const inclComm  = document.getElementById('include-commercial')?.checked || false;
      const mode      = document.querySelector('input[name="turf-mode"]:checked')?.value || 'hanger';

      if (!letter) { UI.toast('Letter required', 'error'); return false; }
      if (turfs.some(t => t.letter === letter)) { UI.toast(`Turf ${letter} already exists`, 'error'); return false; }

      const { residential } = ParcelsUtil.parcelsInPolygon(ring, inclComm);
      if (!residential.length) { UI.toast('No parcels found — try a different area', 'error'); return false; }
      const centroid     = ParcelsUtil.leafletRingCentroid(ring);
      const finalParcels = mode === 'hanger'
        ? ParcelsUtil.walkOrder(residential, centroid)
        : residential.slice().sort((a, b) => a.address.localeCompare(b.address));

      // Don't add layer to _drawnLayers here — let loadTurfs rebuild after save
      const geojson = layer.toGeoJSON().geometry;
      App.createTurfFromDraw({ letter, color, volunteer, mode, geojson, parcels: finalParcels });
      return true;
    }, 'Create Turf');
  }

  // ── Diff modal ────────────────────────────────────────────────────────────
  function _showDiffModal({ letter, layer, toKeep, toRemove, toAdd, excluded }) {
    const kept = toKeep.filter(h => !!h.result).length;
    UI._modal(`Edit Turf ${letter} Boundary`, `
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
    const turf = App.state.turfs.find(t => t.letter === letter);
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

    const sorted = turf.mode === 'doorknock'
      ? withoutResult.slice().sort((a, b) => a.address.localeCompare(b.address))
      : ParcelsUtil.walkOrder(withoutResult, pt || { lat: 32.972, lon: -96.978 });
    App.reorderTurfHouses(letter, [...withResult, ...sorted]);
    UI.toast(`Turf ${letter} re-sorted ✓`, 'success');
  }

  function _getOuterRing(layer) {
    const lls = layer.getLatLngs();
    return Array.isArray(lls[0]) ? lls[0] : lls;
  }

  return {
    init, toggle, isActive, loadTurfs, removeTurfLayer,
    startEditBoundary, resortTurf, _onCommercialToggle, _cancelMobileRect,
  };
})();
