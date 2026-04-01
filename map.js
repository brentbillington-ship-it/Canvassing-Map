// ─── Map Module ──────────────────────────────────────────────────────────────
const MapModule = {
  map: null,
  turfPolygonGroup: null,
  houseGroup: null,
  addressLabelGroup: null,
  houseMarkers: {},
  _legend: null,
  _gpsPanDone: false,
  _labelZoomMin: 18,

  init() {
    this.map = L.map('map', { zoomControl: true }).setView(CONFIG.MAP_CENTER, CONFIG.MAP_ZOOM);

    const street = L.tileLayer(
      'https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png',
      { attribution: '© <a href="https://carto.com/">CARTO</a> © <a href="https://www.openstreetmap.org/copyright">OSM</a>', maxZoom: 20, subdomains: 'abcd' }
    );
    const satellite = L.tileLayer(
      'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
      { attribution: '© Esri', maxZoom: 20, opacity: 0.6 }
    );

    this.map.createPane('labelsPane');
    this.map.getPane('labelsPane').style.zIndex = 650;
    this.map.getPane('labelsPane').style.pointerEvents = 'none';
    const labels = L.tileLayer(
      'https://{s}.basemaps.cartocdn.com/rastertiles/voyager_only_labels/{z}/{x}/{y}{r}.png',
      { attribution: '', maxZoom: 20, subdomains: 'abcd', pane: 'labelsPane' }
    );

    // Address label pane — above house markers
    this.map.createPane('addrPane');
    this.map.getPane('addrPane').style.zIndex = 650;
    this.map.getPane('addrPane').style.pointerEvents = 'none';

    satellite.addTo(this.map);
    labels.addTo(this.map);

    // CISD boundary layer
    this._cisdLayer = null;
    if (typeof CISD_BOUNDARY !== 'undefined') {
      this._cisdLayer = L.geoJSON(CISD_BOUNDARY, {
        style: { color: '#9b1c1c', weight: 3, opacity: 0.4, fillOpacity: 0, dashArray: null }
      });
      this._cisdLayer.addTo(this.map);
    }

    // School label pane — always on top, persistent at all zoom levels
    this.map.createPane('schoolPane');
    this.map.getPane('schoolPane').style.zIndex = 700;
    this.map.getPane('schoolPane').style.pointerEvents = 'none';
    this._renderSchoolLabels();

    L.control.layers(
      { 'Aerial': satellite, 'Street': street },
      {
        'Road Labels': labels,
        ...(this._cisdLayer ? { 'CISD Boundary': this._cisdLayer } : {}),
        ...(this._schoolLayer ? { 'School Labels': this._schoolLayer } : {}),
      },
      { position: 'bottomright', collapsed: true }
    ).addTo(this.map);

    this.turfPolygonGroup = L.layerGroup().addTo(this.map);
    this.houseGroup       = L.layerGroup().addTo(this.map);
    this.addressLabelGroup = L.layerGroup({ pane: 'addrPane' }).addTo(this.map);

    setTimeout(() => this.map.invalidateSize(), 100);
    this._tryInitialGPS();

    // Rebuild address labels on zoom and pan
    this.map.on('zoomend moveend', () => this._renderAddressLabels());
    this.map.on('zoomend', () => this._updateZoomStyle());
    this._updateZoomStyle(); // set initial

    // Map-tap for non-admin missing house report
    this.map.on('click', e => {
      if (UI.isAdmin) return;
      if (UI._mapTapPending) {
        UI._onMapTap(e.latlng);
      }
    });
  },

  _tryInitialGPS() {
    if (!navigator.geolocation || this._gpsPanDone) return;
    navigator.geolocation.getCurrentPosition(pos => {
      if (this._gpsPanDone) return;
      this._gpsPanDone = true;
      this.map.setView([pos.coords.latitude, pos.coords.longitude],
        Math.max(this.map.getZoom(), 16));
    }, () => {}, { enableHighAccuracy: false, timeout: 6000, maximumAge: 60000 });
  },

  // ── Address labels from parcels.js — zoom-gated, local-street filter ──────
  _renderAddressLabels() {
    this.addressLabelGroup.clearLayers();
    if (typeof PARCELS_GEOJSON === 'undefined') return;
    if (this.map.getZoom() < this._labelZoomMin) return;

    const bounds = this.map.getBounds().pad(0.15);

    // Pass 1: collect all addr2 street names for parcels in viewport
    // A street name is "local" if 3+ parcels in the viewport share it
    const streetCount = {};
    const inViewport  = [];
    for (const f of PARCELS_GEOJSON.features) {
      const addr2 = (f.properties.addr2 || '').trim();
      if (!addr2 || ParcelsUtil.isCommercialOrApt(addr2)) continue;
      const c = ParcelsUtil.featureCentroid(f);
      if (!c || !bounds.contains([c.lat, c.lon])) continue;
      // Extract street name (everything after the leading number)
      const streetMatch = addr2.match(/^\d+\s+(.+)$/);
      if (!streetMatch) continue;
      const street = streetMatch[1].toUpperCase().trim();
      streetCount[street] = (streetCount[street] || 0) + 1;
      inViewport.push({ f, addr2, street, c });
    }

    // Pass 2: render only parcels whose street has 3+ local occurrences
    const seen = new Set();
    for (const { f, addr2, street, c } of inViewport) {
      if ((streetCount[street] || 0) < 3) continue;
      const dedupeKey = addr2.toUpperCase().replace(/\s+/g, ' ').trim();
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);
      const num = addr2.match(/^(\d+)/)?.[1];
      if (!num || parseInt(num, 10) > 9999) continue;

      L.marker([c.lat, c.lon], {
        icon: L.divIcon({
          html: `<div class="addr-label">${num}</div>`,
          className: '',
          iconSize: null,
          iconAnchor: [0, 0],
        }),
        pane: 'addrPane',
        interactive: false,
      }).addTo(this.addressLabelGroup);
    }
  },

  // ── School labels — toggleable layer ─────────────────────────────────────
  _renderSchoolLabels() {
    if (typeof CISD_SCHOOLS === 'undefined') return;
    this._schoolLayer = L.layerGroup();
    CISD_SCHOOLS.forEach(s => {
      const sizeClass = s.type === 'hs' ? 'school-label-hs' : s.type === 'ms' ? 'school-label-ms' : 'school-label-es';
      L.marker([s.lat, s.lon], {
        icon: L.divIcon({
          html: `<div class="school-label ${sizeClass}" title="${s.name}">🏫 ${s.short}</div>`,
          className: '',
          iconSize: null,
          iconAnchor: [0, 8],
        }),
        pane: 'schoolPane',
        interactive: false,
        zIndexOffset: 900,
      }).addTo(this._schoolLayer);
    });
    this._schoolLayer.addTo(this.map); // on by default
  },

  // ── Zoom-based dot scaling ─────────────────────────────────────────────────
  _updateZoomStyle() {
    const z = this.map.getZoom();
    // Interpolate size and opacity across zoom range 13-18
    const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
    const lerp  = (a, b, t) => a + (b - a) * clamp(t, 0, 1);
    const t = (z - 13) / (18 - 13); // 0 at zoom 13, 1 at zoom 18
    const size    = Math.round(lerp(14, 26, t));
    const opacity = lerp(0.35, 0.92, t).toFixed(2);
    const anchor  = Math.round(size / 2);
    const polyFill = lerp(0.22, 0.12, t).toFixed(2); // more fill when zoomed out

    const wrap = document.getElementById('map');
    if (wrap) {
      wrap.style.setProperty('--dot-size', size + 'px');
      wrap.style.setProperty('--dot-opacity', opacity);
    }

    // Update polygon fill opacity
    this.turfPolygonGroup?.eachLayer(layer => {
      if (layer.setStyle) layer.setStyle({ fillOpacity: parseFloat(polyFill) });
    });

    // Update all marker icon sizes without full re-render
    this.houseGroup?.eachLayer(marker => {
      if (!marker._icon) return;
      const icon = marker._icon.querySelector('.house-dot');
      if (icon) {
        icon.style.width  = size + 'px';
        icon.style.height = size + 'px';
      }
      if (marker._icon) {
        marker._icon.style.marginLeft = -anchor + 'px';
        marker._icon.style.marginTop  = -anchor + 'px';
        marker._icon.style.width      = size + 'px';
        marker._icon.style.height     = size + 'px';
      }
    });
  },

  // ── Full render ────────────────────────────────────────────────────────────
  renderAll(turfs) {
    this.turfPolygonGroup.clearLayers();
    this.houseGroup.clearLayers();
    this.houseMarkers = {};
    turfs.forEach((turf, i) => {
      const color = turf.color || CONFIG.TURF_COLORS[i % CONFIG.TURF_COLORS.length];
      // Non-admins: fade dots for zones that don't match their mode
      const isOtherZone = !UI.isAdmin && UI.userMode !== 'all' && (turf.mode || 'hanger') !== UI.userMode;
      this._renderTurfPolygon(turf, color);
      turf.houses.forEach((house, idx) => this._renderHouse(house, turf, idx, color, isOtherZone));
    });
    this._renderAddressLabels();
    this._renderLegend();
  },

  // ── Turf polygon ──────────────────────────────────────────────────────────
  _renderTurfPolygon(turf, color) {
    if (!turf.polygon_geojson) return;
    let geojson = turf.polygon_geojson;
    if (typeof geojson === 'string') {
      try { geojson = JSON.parse(geojson); } catch(e) { return; }
    }
    // L.geoJSON requires a Feature or FeatureCollection, not a bare Geometry
    if (geojson.type === 'Polygon' || geojson.type === 'MultiPolygon') {
      geojson = { type: 'Feature', geometry: geojson, properties: {} };
    }
    try {
      const poly = L.geoJSON(geojson, {
        style: { color, fillColor: color, fillOpacity: 0.15, weight: 2.5, opacity: 0.8, dashArray: '6,4' }
      }).addTo(this.turfPolygonGroup);
      const bounds = poly.getBounds();
      if (bounds.isValid()) {
        L.marker(bounds.getCenter(), {
          icon: L.divIcon({
            html: `<div class="turf-label" style="background:${color}">${turf.letter}</div>`,
            className: '',
            iconSize: [28, 28],
            iconAnchor: [14, 14]
          }),
          interactive: false,
          zIndexOffset: -500
        }).addTo(this.turfPolygonGroup);
      }
    } catch(e) { console.warn('Polygon render error:', e, geojson); }
  },

  // ── House dot — blank, color = result status, shape = turf mode ───────────
  _renderHouse(house, turf, idx, color, isOtherZone) {
    const marker = this._makeMarker(house, turf, isOtherZone);
    marker.on('click', () => this._openHousePopup(house, turf, color));
    marker.addTo(this.houseGroup);
    this.houseMarkers[house.id] = marker;
  },

  _makeMarker(house, turf, isOtherZone = false) {
    const result    = house.result || '';
    const resultDef = CONFIG.RESULTS.find(r => r.key === result);
    const dotColor  = resultDef ? resultDef.color : '#6b7280';
    const isDone       = !!result;
    const isDoorKnock  = (turf?.mode || 'hanger') === 'doorknock';

    // Circle = hanger, diamond = door knock
    const cls = `house-dot${isDone ? ' done' : ''}${isDoorKnock ? ' diamond' : ''}${isOtherZone ? ' other-zone' : ''}`;
    return L.marker([house.lat, house.lon], {
      icon: L.divIcon({
        html: `<div class="${cls}" style="--dc:${dotColor}"></div>`,
        className: '',
        iconSize: [26, 26],
        iconAnchor: [13, 13],
      }),
      zIndexOffset: isOtherZone ? -200 : (isDone ? 0 : 100),
    });
  },

  updateHouseMarker(house, turf, idx) {
    const old = this.houseMarkers[house.id];
    if (!old) return;
    const color       = turf.color || CONFIG.TURF_COLORS[0];
    const isOtherZone = !UI.isAdmin && UI.userMode !== 'all' && (turf.mode || 'hanger') !== UI.userMode;
    const updated     = this._makeMarker(house, turf, isOtherZone);
    updated.on('click', () => this._openHousePopup(house, turf, color));
    this.houseGroup.removeLayer(old);
    updated.addTo(this.houseGroup);
    this.houseMarkers[house.id] = updated;
  },

  // ── House popup ────────────────────────────────────────────────────────────
  _openHousePopup(house, turf, color) {
    window._houseCache = window._houseCache || {};
    window._houseCache[house.id] = { house, turf, color };

    const result    = house.result || '';
    const resultDef = CONFIG.RESULTS.find(r => r.key === result);

    const isHanger = (turf.mode || 'hanger') === 'hanger';
    const visibleResults = isHanger
      ? CONFIG.RESULTS.filter(r => r.key === 'hanger' || r.key === 'skip')
      : CONFIG.RESULTS;
    const btnRows = visibleResults.map(r => {
      const active = r.key === result;
      return `<button class="popup-result-btn${active ? ' active' : ''}" style="--rc:${r.color};--rbg:${r.bg}"
        onclick="MapModule._handlePopupResult('${house.id}','${r.key}')">
        <span class="pbtn-icon">${r.icon}</span>
        <span class="pbtn-label">${r.label}</span>
        ${active ? '<span class="pbtn-check">✓</span>' : ''}
      </button>`;
    }).join('');

    const safeNotes = _esc(house.notes || '');
    const notesHtml = `
      <div class="popup-notes-row">
        <input id="pnotes-${house.id}" class="popup-notes-input" type="text"
          placeholder="Add a note…" value="${safeNotes}"
          onkeydown="if(event.key==='Enter')MapModule._saveNotes('${house.id}',this.value)"/>
        <button class="popup-notes-save"
          onclick="MapModule._saveNotes('${house.id}',document.getElementById('pnotes-${house.id}').value)">Save</button>
      </div>
      <div class="popup-chips">
        ${['Kids in CISD 🏫','Talked 💬','Khanh Supporter ✕','Spanish 🗣️','Hindi 🗣️','Interested ✅'].map(c =>
          `<span class="note-chip" onclick="MapModule._appendChip('${house.id}',this.textContent)">${c}</span>`
        ).join('')}
      </div>`;

    const statusHtml = result
      ? `<div class="popup-status" style="background:${resultDef.bg};color:${resultDef.color}">
           ${resultDef.icon} ${resultDef.label}
           ${house.result_by  ? ` · <em>${_esc(house.result_by)}</em>`  : ''}
           ${house.result_date ? ` · ${_fmtDate(house.result_date)}`     : ''}
         </div>`
      : `<div class="popup-status unpopulated">No contact recorded</div>`;

    const clearBtn = result
      ? `<button class="popup-clear-btn" onclick="MapModule._handlePopupResult('${house.id}','')">↩ Clear result</button>`
      : '';

    const modeBadge = (turf.mode || 'hanger') === 'doorknock'
      ? `<span class="mode-badge doorknock">Door Knock</span>`
      : `<span class="mode-badge hanger">Hanger</span>`;

    const gridCols = visibleResults.length <= 2 ? 2 : 3;
    const html = `
      <div class="house-popup">
        <div class="popup-header" style="border-color:${color}">
          <div class="popup-turf-badge" style="background:${color}">Turf ${_esc(turf.letter)}</div>
          <div class="popup-addr">
            <div class="popup-name">${_esc(house.address)}</div>
            ${house.owner ? `<div class="popup-sub owner-line">${_esc(house.owner)}</div>` : ''}
            ${modeBadge}
          </div>
        </div>
        ${statusHtml}
        <div class="popup-result-grid" style="grid-template-columns:repeat(${gridCols},1fr)">${btnRows}</div>
        ${notesHtml}
        ${clearBtn}
      </div>`;

    this.map.closePopup();
    L.popup({ maxWidth: 310, minWidth: 270, className: 'house-popup-wrap' })
      .setLatLng([house.lat, house.lon])
      .setContent(html)
      .openOn(this.map);
  },

  _handlePopupResult(houseId, resultKey) {
    this.map.closePopup();
    App.setResult(houseId, resultKey);
  },

  _saveNotes(houseId, notes) {
    App.saveNotes(houseId, notes);
    UI.toast('Notes saved');
  },

  _appendChip(houseId, chip) {
    const inp = document.getElementById('pnotes-' + houseId);
    if (!inp) return;
    inp.value = inp.value ? inp.value + ', ' + chip.trim() : chip.trim();
    inp.focus();
  },

  // -- Legend — desktop always-on, mobile info button ──────────────────────────
  _renderLegend() {
    if (this._legend) this._legend.remove();
    const group1 = ['hanger', 'skip'];
    const group2 = ['knocked', 'not_home', 'refused'];
    const rowHtml = (keys) => keys.map(k => {
      const r = CONFIG.RESULTS.find(x => x.key === k);
      return `<div class="legend-row">
        <span class="legend-dot" style="background:${r.color}"></span>
        <span class="legend-label">${r.icon} ${r.label}</span>
      </div>`;
    }).join('');
    const legendContent =
      rowHtml(group1) +
      `<div class="legend-row"><span class="legend-dot" style="background:#9ca3af"></span><span class="legend-label">Not visited</span></div>` +
      `<div class="legend-divider"></div>` +
      rowHtml(group2) +
      `<div class="legend-row" style="margin-top:4px;padding-top:4px;border-top:1px solid rgba(0,0,0,0.1)">
        <span class="legend-dot" style="border-radius:3px;background:#6b7280"></span>
        <span class="legend-label">&#9670; Door Knock</span>
      </div>`;

    const legend = L.control({ position: 'bottomleft' });
    legend.onAdd = () => {
      const isMobile = window.innerWidth <= 680;
      const div = L.DomUtil.create('div', isMobile ? 'legend-info-btn' : 'map-legend');
      if (isMobile) {
        div.innerHTML = `<button class="legend-btn" onclick="UI._showLegendModal()" title="Map legend">&#x2139;</button>`;
        // Store legend content for modal
        window._legendContent = legendContent;
      } else {
        div.innerHTML = legendContent;
      }
      L.DomEvent.disableClickPropagation(div);
      return div;
    };
    legend.addTo(this.map);
    this._legend = legend;
  },

  // ── Next Door highlight ────────────────────────────────────────────────────
  _nextDoorMarker: null,

  highlightNextDoor(house) {
    this._clearNextDoor();
    if (!house) return;
    this._nextDoorMarker = L.marker([house.lat, house.lon], {
      icon: L.divIcon({
        html: `<div class="next-door-ring"><div class="next-door-label">NEXT</div></div>`,
        className: '',
        iconSize: [44, 44],
        iconAnchor: [22, 22],
      }),
      zIndexOffset: 2000,
      interactive: false,
    }).addTo(this.houseGroup);
  },

  _clearNextDoor() {
    if (this._nextDoorMarker) {
      this.houseGroup.removeLayer(this._nextDoorMarker);
      this._nextDoorMarker = null;
    }
  },

  // ── Focus helpers ──────────────────────────────────────────────────────────
  focusTurf(turf) {
    const coords = turf.houses.map(h => [h.lat, h.lon]).filter(c => !isNaN(c[0]));
    if (!coords.length) return;
    try { this.map.fitBounds(L.latLngBounds(coords), { padding: [40, 40] }); } catch(e) {}
  },

  focusHouse(house) {
    this.map.setView([house.lat, house.lon], Math.max(this.map.getZoom(), 17));
    if (window.innerWidth <= 680)
      document.getElementById('map-wrap')?.scrollIntoView({ behavior: 'smooth' });
  },

  // ── My Location ────────────────────────────────────────────────────────────
  _locationWatchId: null,
  _locationMarker:  null,
  _locationCircle:  null,
  _locationActive:  false,

  toggleMyLocation() { this._locationActive ? this._stopLocation() : this._startLocation(); },

  _startLocation() {
    if (!navigator.geolocation) { UI.toast('Geolocation not supported', 'error'); return; }
    const btn = document.getElementById('loc-btn');
    if (btn) btn.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" style="animation:spin 1s linear infinite"><circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3"/><circle cx="12" cy="12" r="8" stroke-dasharray="none" stroke-opacity="0.35"/></svg>';
    navigator.geolocation.getCurrentPosition(pos => {
      this._locationActive = true;
      this._gpsPanDone = true;
      if (btn) { btn.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3"/><circle cx="12" cy="12" r="8" stroke-dasharray="none" stroke-opacity="0.35"/></svg>'; btn.classList.add('active-btn'); }
      this._updateLocationMarker(pos);
      this.map.setView([pos.coords.latitude, pos.coords.longitude],
        Math.max(this.map.getZoom(), 16));
      UI.toast('Location found', 'success');
      UI.updateNextDoor();
      this._locationWatchId = navigator.geolocation.watchPosition(
        p  => { this._updateLocationMarker(p); UI.updateNextDoor(); },
        e  => this._locationError(e),
        { enableHighAccuracy: true, maximumAge: 5000 }
      );
    }, err => this._locationError(err), { enableHighAccuracy: true, timeout: 10000 });
  },

  _stopLocation() {
    if (this._locationWatchId !== null) {
      navigator.geolocation.clearWatch(this._locationWatchId);
      this._locationWatchId = null;
    }
    if (this._locationMarker) { this._locationMarker.remove(); this._locationMarker = null; }
    if (this._locationCircle) { this._locationCircle.remove(); this._locationCircle = null; }
    this._locationActive = false;
    const btn = document.getElementById('loc-btn');
    if (btn) { btn.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3"/><circle cx="12" cy="12" r="8" stroke-dasharray="none" stroke-opacity="0.35"/></svg>'; btn.classList.remove('active-btn'); }
  },

  _updateLocationMarker(pos) {
    const { latitude: lat, longitude: lon, accuracy } = pos.coords;
    if (this._locationCircle)
      this._locationCircle.setLatLng([lat, lon]).setRadius(accuracy);
    else
      this._locationCircle = L.circle([lat, lon], {
        radius: accuracy, color: '#3b82f6', fillColor: '#3b82f6', fillOpacity: 0.1, weight: 1
      }).addTo(this.map);

    if (this._locationMarker)
      this._locationMarker.setLatLng([lat, lon]);
    else
      this._locationMarker = L.marker([lat, lon], {
        icon: L.divIcon({
          html: '<div class="loc-dot"><div class="loc-pulse"></div></div>',
          className: '',
          iconSize: [20, 20],
          iconAnchor: [10, 10]
        }),
        zIndexOffset: 2000
      }).addTo(this.map);
  },

  _locationError(err) {
    this._locationActive = false;
    const btn = document.getElementById('loc-btn');
    if (btn) { btn.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3"/><circle cx="12" cy="12" r="8" stroke-dasharray="none" stroke-opacity="0.35"/></svg>'; btn.classList.remove('active-btn'); }
    UI.toast({ 1: 'Location access denied', 2: 'Location unavailable', 3: 'Location timed out' }[err.code] || 'Location error', 'error');
  },

  getCurrentLatLon() {
    if (!this._locationMarker) return null;
    const ll = this._locationMarker.getLatLng();
    return { lat: ll.lat, lon: ll.lng };
  },
};

function _esc(s) {
  return (String(s === null || s === undefined ? '' : s))
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}

function _fmtDate(iso) {
  try {
    return new Date(iso).toLocaleString('en-US', {
      timeZone: 'America/Chicago', month: 'numeric', day: 'numeric',
      hour: 'numeric', minute: '2-digit', hour12: true
    }) + ' CT';
  } catch(e) { return iso; }
}
