// ─── Map Module ──────────────────────────────────────────────────────────────
const MapModule = {
  map: null,
  turfPolygonGroup: null,
  turfLabelGroup: null,
  houseGroup: null,
  addressLabelGroup: null,
  houseMarkers: {},
  _legend: null,
  _gpsPanDone: false,
  _labelZoomMin: 18,

  init() {
    // Compute CISD bounds for maxBounds
    let cisdBounds = null;
    if (typeof CISD_BOUNDARY !== 'undefined') {
      try {
        const coords = CISD_BOUNDARY.geometry.coordinates[0];
        const lats = coords.map(c => c[1]);
        const lons = coords.map(c => c[0]);
        const pad = 0.02;
        cisdBounds = L.latLngBounds(
          [Math.min(...lats) - pad, Math.min(...lons) - pad],
          [Math.max(...lats) + pad, Math.max(...lons) + pad]
        );
      } catch(e) {}
    }

    this.map = L.map('map', {
      zoomControl: true,
      minZoom: 12,
      maxZoom: 19,
      ...(cisdBounds ? { maxBounds: cisdBounds, maxBoundsViscosity: 0.85 } : {}),
    }).setView(CONFIG.MAP_CENTER, CONFIG.MAP_ZOOM);

    const street = L.tileLayer(
      'https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png',
      { attribution: '© <a href="https://carto.com/">CARTO</a> © <a href="https://www.openstreetmap.org/copyright">OSM</a>', maxZoom: 20, subdomains: 'abcd' }
    );
    const satellite = L.tileLayer(
      'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
      { attribution: '© Esri', maxZoom: 19, opacity: 0.65, crossOrigin: true }
    );

    this.map.createPane('labelsPane');
    this.map.getPane('labelsPane').style.zIndex = 580;
    this.map.getPane('labelsPane').style.pointerEvents = 'none';
    const labels = L.tileLayer(
      'https://{s}.basemaps.cartocdn.com/rastertiles/voyager_only_labels/{z}/{x}/{y}{r}.png',
      { attribution: '', maxZoom: 20, subdomains: 'abcd', pane: 'labelsPane' }
    );

    // Zone label pane — above markerPane (z600) but below addrPane (z660)
    this.map.createPane('turfLabelPane');
    this.map.getPane('turfLabelPane').style.zIndex = 645;
    this.map.getPane('turfLabelPane').style.pointerEvents = 'auto';

    // Dedicated house marker pane — hidden below _minMarkerZoom without touching markerPane
    this.map.createPane('housePane');
    this.map.getPane('housePane').style.zIndex = 620;
    this.map.getPane('housePane').style.pointerEvents = 'auto';

    // Address label pane — above default markerPane
    this.map.createPane('addrPane');
    this.map.getPane('addrPane').style.zIndex = 660;
    this.map.getPane('addrPane').style.pointerEvents = 'none';

    satellite.addTo(this.map);
    labels.addTo(this.map);
    // Aerial tile opacity 0.65 on all devices for consistent look

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

    const layerControlPos = window.innerWidth <= 680 ? 'bottomleft' : 'bottomright';
    this._layerControl = L.control.layers(
      { 'Aerial': satellite, 'Street': street },
      {
        'Road Labels': labels,
        ...(this._cisdLayer ? { 'CISD Boundary': this._cisdLayer } : {}),
        ...(this._schoolLayer ? { 'School Labels': this._schoolLayer } : {}),
      },
      { position: layerControlPos, collapsed: true }
    ).addTo(this.map);

    this.turfPolygonGroup  = L.layerGroup().addTo(this.map);
    this.turfLabelGroup    = L.layerGroup({ pane: 'turfLabelPane' }).addTo(this.map);
    this.houseGroup        = L.layerGroup().addTo(this.map);
    this.addressLabelGroup = L.layerGroup({ pane: 'addrPane' }).addTo(this.map);

    setTimeout(() => this.map.invalidateSize(), 100);
    this._tryInitialGPS();

    // Split zoom and pan listeners — address labels only at zoom≥18, markers gated at zoom≥15
    this.map.on('zoomend', () => {
      this._updateZoomStyle();
      this._renderAddressLabels();
      this._refreshVisibleMarkers();
    });
    // Debounce moveend so rapid panning doesn't rebuild markers on every pixel
    let _moveTimer = null;
    this.map.on('moveend', () => {
      clearTimeout(_moveTimer);
      _moveTimer = setTimeout(() => {
        this._renderAddressLabels();
        this._refreshVisibleMarkers();
      }, 150);
    });
    this._updateZoomStyle();

    // Map-tap for knock placement (admin) and missing house report (non-admin)
    this.map.on('click', e => {
      if (UI._mapTapPending) {
        UI._onMapTap(e.latlng);
        return;
      }
      if (UI.isAdmin) return;
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

    const bounds = this.map.getBounds().pad(0.05);

    // Pass 1: collect all addr2 street names for parcels in viewport
    // A street name is "local" if 3+ parcels in the viewport share it
    const streetCount = {};
    const inViewport  = [];
    for (const f of PARCELS_GEOJSON.features) {
      const addr2 = (f.properties.addr2 || '').trim();
      if (!addr2 || ParcelsUtil.isCommercialOrApt(addr2, f.properties)) continue;
      const c = ParcelsUtil.featureCentroid(f);
      if (!c || !bounds.contains([c.lat, c.lon])) continue;
      // Extract street name (everything after the leading number)
      const streetMatch = addr2.match(/^\d+\s+(.+)$/);
      if (!streetMatch) continue;
      const street = streetMatch[1].toUpperCase().trim();
      streetCount[street] = (streetCount[street] || 0) + 1;
      inViewport.push({ f, addr2, street, c });
    }

    // Pass 2: render all parcels with a valid street number
    const seen = new Set();
    for (const { f, addr2, street, c } of inViewport) {
      if ((streetCount[street] || 0) < 1) continue;
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

  _updateZoomStyle() {
    const z = this.map.getZoom();
    const belowThreshold = z < this._minMarkerZoom;

    // Interpolate size and opacity across zoom range 13-18
    const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
    const lerp  = (a, b, t) => a + (b - a) * clamp(t, 0, 1);
    const t = (z - 13) / (18 - 13); // 0 at zoom 13, 1 at zoom 18
    const size    = Math.round(lerp(8, 26, t));
    const opacity = lerp(0.65, 0.95, t).toFixed(2);
    const anchor  = Math.round(size / 2);
    const polyFill = lerp(0.28, 0.15, t).toFixed(2);

    // Update polygon fill opacity
    this.turfPolygonGroup?.eachLayer(layer => {
      if (layer.setStyle) layer.setStyle({ fillOpacity: belowThreshold ? 0.25 : parseFloat(polyFill) });
    });

    const wrap = document.getElementById('map');
    if (wrap) {
      wrap.style.setProperty('--dot-size', size + 'px');
      wrap.style.setProperty('--dot-opacity', opacity);
      wrap.classList.toggle('hide-turf-labels', z >= this._labelZoomMin);
    }

    if (belowThreshold) {
      // Below hanger threshold — only knock markers visible, still scale them
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
      return;
    }

    // Ensure housePane is visible above threshold
    const housePane = this.map.getPane('housePane');
    if (housePane) housePane.style.display = '';

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

  _minMarkerZoom: 17,
  _allTurfsCache: [],  // store last rendered turfs for viewport refresh

  _turfPolyByLetter: {},  // letter → L.geoJSON layer in turfPolygonGroup (Item 4)

  // ── Full render ────────────────────────────────────────────────────────────
  renderAll(turfs) {
    this.turfPolygonGroup.clearLayers();
    this.turfLabelGroup.clearLayers();
    this.houseGroup.clearLayers();
    this.houseMarkers = {};
    this._turfPolyByLetter = {};
    this._allTurfsCache = turfs;
    turfs.forEach(turf => {
      this._renderTurfPolygon(turf, _turfColor(turf));
    });
    // Apply zoom threshold before adding markers
    this._updateZoomStyle();
    this._refreshVisibleMarkers();
    this._renderAddressLabels();
    this._renderLegend();
  },

  // ── Refresh only markers in current viewport at current zoom ───────────────
  _refreshVisibleMarkers() {
    const zoom = this.map.getZoom();
    const turfs = this._allTurfsCache;
    if (!turfs) return;

    const bounds = this.map.getBounds().pad(0.05);
    this.houseGroup.clearLayers();
    this.houseMarkers = {};

    turfs.forEach((turf) => {
      const isKnock = (turf.mode || 'hanger') === 'knock';
      // Hanger markers: only show at zoom >= threshold. Knock markers: always visible.
      if (!isKnock && zoom < this._minMarkerZoom) return;
      const color = _turfColor(turf);
      // No longer dim markers for "other mode" zones — anyone can log knocks (Item 9)
      turf.houses.forEach((house, idx) => {
        if (!bounds.contains([house.lat, house.lon])) return;
        this._renderHouse(house, turf, idx, color, false);
      });
    });
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
    // Unassigned zones: solid black border and black label. Assigned: zone color, fully opaque.
    const isUnassigned = !turf.volunteer || turf.volunteer === '[UNASSIGNED]';
    const borderColor  = isUnassigned ? '#000000' : color;
    const labelBg      = isUnassigned ? '#000000' : color;
    try {
      const poly = L.geoJSON(geojson, {
        style: { color: borderColor, fillColor: '#000000', fillOpacity: 0.14, weight: 2.5, opacity: 1.0, dashArray: null }
      }).addTo(this.turfPolygonGroup);
      this._turfPolyByLetter[String(turf.letter)] = poly; // track for instant setStyle (Item 4)
      const bounds = poly.getBounds();
      if (bounds.isValid()) {
      // Zone label in turfLabelPane (z645) — above dots (z600), below address chips (z660)
      const marker = L.marker(bounds.getCenter(), {
        icon: L.divIcon({
          html: `<div class="turf-label" style="background:${labelBg}">${turf.letter}</div>`,
          className: '',
          iconSize: [40, 40],
          iconAnchor: [20, 20],
        }),
        interactive: true,
        pane: 'turfLabelPane',
      });
      marker.on('click', e => {
        L.DomEvent.stopPropagation(e);
        // Suppress zone popups while drawing — clicks belong to the polygon tool
        if (TurfDraw.isActive()) return;
        if (UI.isAdmin) {
          UI.showZoneAdminPopup(turf.letter);
        } else {
          UI.showZoneStatsPopup(turf.letter);
        }
      });
      marker.addTo(this.turfLabelGroup);
      }
    } catch(e) { console.warn('Polygon render error:', e, geojson); }
  },

  // ── Instant zone color update — no full re-render needed (Item 4) ─────────
  setZoneStyle(letter, color) {
    const poly = this._turfPolyByLetter[String(letter)];
    if (!poly) return;
    const isUnassigned = !color || color === '#6b7280';
    const borderColor  = isUnassigned ? '#000000' : color;
    poly.eachLayer(l => {
      if (l.setStyle) l.setStyle({ color: borderColor });
    });
  },

  // ── House dot — blank, color = result status, shape = turf mode ───────────
  _renderHouse(house, turf, idx, color, isOtherZone) {
    const marker = this._makeMarker(house, turf, isOtherZone);
    marker.on('click', () => {
      // Suppress all popups while a zone is being drawn — clicks belong to the polygon tool
      if (TurfDraw.isActive()) return;
      // In multi-select mode: toggle selection instead of opening popup
      if (UI._multiSelectTurf && String(UI._multiSelectTurf) === String(turf.letter)) {
        if (UI._selectedHouseIds.has(house.id)) {
          UI._selectedHouseIds.delete(house.id);
        } else {
          UI._selectedHouseIds.add(house.id);
        }
        App.render();
        return;
      }
      // Auto-expand this zone in sidebar
      UI._expandedTurfs.add(turf.letter);
      this._openHousePopup(house, turf, color);
    });
    marker.addTo(this.houseGroup);
    this.houseMarkers[house.id] = marker;
  },

  _makeMarker(house, turf, isOtherZone = false) {
    const result       = house.result || '';
    const isDone       = !!result;
    const isDoorKnock  = (turf?.mode || 'hanger') === 'knock';
    const isComplex    = house.house_type === 'apartment_complex';
    const resultDef    = CONFIG.RESULTS.find(r => r.key === result);
    const inMs         = UI._multiSelectTurf && String(UI._multiSelectTurf) === String(turf.letter);
    const isSelected   = inMs && UI._selectedHouseIds.has(house.id);

    // Apartment complex building — badge shows building ID + unit count
    if (isComplex) {
      const dotColor = resultDef ? resultDef.color : '#7c4dcc';
      const cls = `house-dot complex-marker${isDone ? ' done' : ''}${isOtherZone ? ' other-zone' : ''}`;
      const bldgLabel = house.building_id ? `Bldg ${_esc(house.building_id)}` : '🏢';
      const unitLabel = house.unit_count ? `${house.unit_count}u` : '';
      const badgeText = house.building_id
        ? `<span class="cbadge-id">${bldgLabel}</span>${unitLabel ? `<span class="cbadge-units">${unitLabel}</span>` : ''}`
        : '🏢';
      return L.marker([house.lat, house.lon], {
        icon: L.divIcon({
          html: `<div class="${cls}" style="--dc:${dotColor}" title="${_esc(house.complex_name || house.address)}">${badgeText}</div>`,
          className: '',
          iconSize: house.building_id ? [60, 28] : [34, 34],
          iconAnchor: house.building_id ? [30, 14] : [17, 17],
        }),
        pane: 'housePane',
        zIndexOffset: isOtherZone ? -100 : 150,
      });
    }

    // Multi-select mode: selected = green ✓, unselected = dashed gray circle
    if (inMs) {
      const msCls = `house-dot ms-dot${isSelected ? ' ms-dot-selected' : ''}${isDoorKnock ? ' diamond' : ''}`;
      return L.marker([house.lat, house.lon], {
        icon: L.divIcon({
          html: `<div class="${msCls}">${isSelected ? '✓' : ''}</div>`,
          className: '',
          iconSize: [26, 26],
          iconAnchor: [13, 13],
        }),
        pane: 'housePane',
        zIndexOffset: isSelected ? 200 : 100,
      });
    }

    const dotColor     = resultDef ? resultDef.color : (isDoorKnock ? '#b3a8c8' : '#6b7280');
    // Circle = hanger, diamond = knock
    const cls = `house-dot${isDone ? ' done' : ''}${isDoorKnock ? ' diamond' : ''}${isOtherZone ? ' other-zone' : ''}`;
    return L.marker([house.lat, house.lon], {
      icon: L.divIcon({
        html: `<div class="${cls}" style="--dc:${dotColor}"></div>`,
        className: '',
        iconSize: [26, 26],
        iconAnchor: [13, 13],
      }),
      pane: 'housePane',
      zIndexOffset: isOtherZone ? -200 : (isDone ? 0 : 100),
    });
  },

  updateHouseMarker(house, turf, idx) {
    const old = this.houseMarkers[house.id];
    if (!old) return;
    const color       = _turfColor(turf);
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
    const isDoorKnock = !isHanger;
    const isComplex = house.house_type === 'apartment_complex';
    // Hanger: hanger + skip. Knock: knocked + not_home + refused. Complex: office visit results
    const visibleResults = isComplex
      ? CONFIG.RESULTS.filter(r => CONFIG.COMPLEX_RESULTS.includes(r.key))
      : isHanger
        ? CONFIG.RESULTS.filter(r => r.key === 'hanger' || r.key === 'skip')
        : CONFIG.RESULTS.filter(r => r.key === 'knocked' || r.key === 'not_home' || r.key === 'refused');
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
    // In admin mode, render existing note tokens as deletable chips
    const existingChips = UI.isAdmin && house.notes
      ? house.notes.split(',').map(s => s.trim()).filter(Boolean).map(c =>
          `<span class="note-chip note-chip-deletable">${_esc(c)}<button class="note-chip-x" onclick="event.stopPropagation();MapModule._removeChip('${house.id}','${c.replace(/'/g,"\\'")}')">✕</button></span>`
        ).join('')
      : '';
    const notesHtml = `
      <div class="popup-notes-row">
        <input id="pnotes-${house.id}" class="popup-notes-input" type="text"
          placeholder="Add a note…" value="${safeNotes}"
          onkeydown="if(event.key==='Enter')MapModule._saveNotes('${house.id}',this.value)"/>
        <button class="popup-notes-save"
          onclick="MapModule._saveNotes('${house.id}',document.getElementById('pnotes-${house.id}').value)">Save</button>
      </div>
      ${existingChips ? `<div class="popup-chips popup-chips-existing">${existingChips}</div>` : ''}
      <div class="popup-chips">
        ${['Kids in CISD 🏫','Khanh Supporter ❌','Interested ✅','🪧 Wants Sign','📋 Filled Form'].map(c =>
          `<span class="note-chip" onclick="MapModule._appendChip('${house.id}',this.textContent)">${c}</span>`
        ).join('')}
      </div>`;

    // For knock zones, "knocked" implies hanger was left — show combined label
    const knockedDef = CONFIG.RESULTS.find(r => r.key === 'knocked');
    const effectiveResultDef = (isDoorKnock && result === 'knocked' && knockedDef)
      ? { ...knockedDef, label: 'Knocked · Hanger Left', icon: '✊📬' }
      : resultDef;

    const statusHtml = result
      ? `<div class="popup-status" style="background:${effectiveResultDef.bg};color:${effectiveResultDef.color}">
           ${effectiveResultDef.icon} ${effectiveResultDef.label}
           ${house.result_by  ? ` · <em>${_esc(house.result_by)}</em>`  : ''}
           ${house.result_date ? ` · ${_fmtDate(house.result_date)}`     : ''}
         </div>`
      : `<div class="popup-status unpopulated">No contact recorded</div>`;

    const clearBtn = result
      ? `<button class="popup-clear-btn" onclick="MapModule._handlePopupResult('${house.id}','')">↩ Clear result</button>`
      : '';

    const deleteBtn = UI.isAdmin
      ? `<button class="popup-delete-btn" onclick="MapModule._confirmDeleteMarker('${house.id}')">🗑 Remove marker</button>`
      : '';

    const showInListBtn = `<button class="popup-list-btn" onclick="MapModule._showInList('${house.id}','${_esc(turf.letter)}')">📋 Show in List</button>`;

    const modeBadge = isComplex
      ? `<span class="mode-badge complex">🏢 Complex${house.unit_count ? ' · ' + house.unit_count + ' units' : ''}</span>`
      : (turf.mode || 'hanger') === 'knock'
        ? `<span class="mode-badge knock">Knock</span>`
        : `<span class="mode-badge hanger">Hanger</span>`;

    // Registered voters lookup (Item 2)
    const voterHtml = (() => {
      if (typeof VOTER_DATA === 'undefined') return '';
      const addr2 = (house.address || '').trim();
      // Normalize: strip city/state/zip suffix, uppercase
      const normKey = addr2
        .replace(/,\s*COPPELL\s*,\s*TX\s*\d{5}.*/i, '')
        .replace(/,\s*COPPELL\s*,\s*TX.*/i, '')
        .replace(/,\s*TX\s*\d{5}.*/i, '')
        .replace(/,\s*TX.*/i, '')
        .replace(/\s+/g, ' ').trim().toUpperCase();
      const entry = VOTER_DATA[normKey];
      if (!entry || !entry.voters || !entry.voters.length) return '';
      const rows = entry.voters.map(v => {
        const redStars  = v.may_votes  > 0 ? `<span class="voter-stars voter-stars-red">${'★'.repeat(v.may_votes)}</span>`  : '';
        const blueStars = v.nov_votes  > 0 ? `<span class="voter-stars voter-stars-blue">${'★'.repeat(v.nov_votes)}</span>` : '';
        return `<div class="voter-row">
          <div class="voter-name">${_esc(v.name)}</div>
          <div class="voter-star-rows">${redStars}${blueStars}</div>
        </div>`;
      }).join('');
      return `<div class="popup-voters"><div class="popup-voters-title">Registered Voters</div>${rows}</div>`;
    })();

    const gridCols = visibleResults.length <= 2 ? 2 : 3;
    const html = `
      <div class="house-popup">
        <div class="popup-header" style="border-color:${color}">
          <div class="popup-turf-badge" style="background:${color}">Zone ${_esc(turf.letter)}</div>
          <div class="popup-addr">
            <div class="popup-name">${_esc(house.address)}</div>
            ${house.owner ? `<div class="popup-sub owner-line">${_esc(house.owner)}</div>` : ''}
            ${modeBadge}
          </div>
        </div>
        ${voterHtml}
        ${statusHtml}
        <div class="popup-result-grid" style="grid-template-columns:repeat(${gridCols},1fr)">${btnRows}</div>
        ${notesHtml}
        ${clearBtn}
        ${showInListBtn}
        ${deleteBtn}
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
    MapModule._saveNotes(houseId, inp.value);
  },

  _removeChip(houseId, chipText) {
    const { house } = App._findHouse(houseId);
    if (!house) return;
    const tokens = (house.notes || '').split(',').map(s => s.trim()).filter(s => s && s !== chipText.trim());
    const newNotes = tokens.join(', ');
    house.notes = newNotes;
    // Update input if popup still open
    const inp = document.getElementById('pnotes-' + houseId);
    if (inp) inp.value = newNotes;
    App.saveNotes(houseId, newNotes);
    // Re-open popup to refresh chip list
    const cached = window._houseCache?.[houseId];
    if (cached) MapModule._openHousePopup(cached.house, cached.turf, cached.color);
  },

  _showInList(houseId, letter) {
    this.map.closePopup();
    // Expand the zone in sidebar
    UI._expandedTurfs.add(isNaN(letter) ? letter : Number(letter));
    App.render();
    // On mobile, switch to list view
    if (window.innerWidth <= 680) {
      const sidebar = document.getElementById('sidebar');
      if (sidebar && !sidebar.classList.contains('sidebar-open')) UI.toggleMap();
    }
    // Scroll to and highlight the house card
    setTimeout(() => {
      const el = document.getElementById('hcard-' + houseId);
      if (el) {
        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        el.classList.add('highlight-pulse');
        setTimeout(() => el.classList.remove('highlight-pulse'), 2000);
      }
    }, 150);
  },

  async _confirmDeleteMarker(houseId) {
    this.map.closePopup();
    const { house } = App._findHouse(houseId);
    const label = house?.address || 'this marker';
    const confirmed = await UI._confirm(
      'Remove Marker',
      `Remove <strong>${_esc(label)}</strong> from the map?<br><br>This cannot be undone.`,
      'Remove', true
    );
    if (confirmed) App.removeHouse(houseId);
  },
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
    // Diamond shape helper for knock result rows
    const diamondRowHtml = (keys) => keys.map(k => {
      const r = CONFIG.RESULTS.find(x => x.key === k);
      return `<div class="legend-row">
        <span class="legend-dot legend-diamond" style="background:${r.color}"></span>
        <span class="legend-label">${r.icon} ${r.label}</span>
      </div>`;
    }).join('');

    const legendContent =
      rowHtml(group1) +
      `<div class="legend-row"><span class="legend-dot" style="background:#9ca3af"></span><span class="legend-label">Not visited</span></div>` +
      `<div class="legend-divider"></div>` +
      diamondRowHtml(group2) +
      `<div class="legend-row"><span class="legend-dot legend-diamond" style="background:#b3a8c8"></span><span class="legend-label">Not knocked</span></div>`;

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
      pane: 'housePane',
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

function _turfColor(turf) {
  if (!turf.volunteer || turf.volunteer === '[UNASSIGNED]') return '#6b7280';
  if ((turf.mode || 'hanger') === 'knock') return '#b3a8c8';
  const userRec = (UI._users || []).find(u => u.name === turf.volunteer);
  return userRec?.color || turf.color || '#6b7280';
}

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
