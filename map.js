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
  _labelZoomMin: 17,  // v5.20: show every-parcel circles starting at zoom 17

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

    // v5.23: Road Labels is ON by default. The label-only tile is darkened via
    // CSS filter so text reads clearly on the satellite/aerial basemap. The
    // Street base layer already has street names baked in — toggling to Street
    // still shows labels, just double-layered (harmless and very readable).
    this.map.createPane('labelsPane');
    this.map.getPane('labelsPane').style.zIndex = 580;
    this.map.getPane('labelsPane').style.pointerEvents = 'none';
    // Darken the label tile so street names read clearly against satellite imagery
    this.map.getPane('labelsPane').style.filter = 'brightness(0.6) contrast(1.3)';
    const labels = L.tileLayer(
      'https://{s}.basemaps.cartocdn.com/rastertiles/voyager_only_labels/{z}/{x}/{y}{r}.png',
      { attribution: '', maxZoom: 20, subdomains: 'abcd', pane: 'labelsPane' }
    );

    // Pane z-index order (low -> high):
    //   labelsPane (580)   — voyager street labels, on by default, darkened for aerial
    //   markerPane (600)   — Leaflet default
    //   addrPane   (610)   — unassigned residential parcel markers (neutral gray)
    //   housePane  (620)   — canvassing house-dots (turf colors, knock diamonds)
    //   turfLabelPane(645) — zone letter badges, clickable
    //   schoolPane (700)   — 🏫 school labels, always on top
    this.map.createPane('turfLabelPane');
    this.map.getPane('turfLabelPane').style.zIndex = 645;
    this.map.getPane('turfLabelPane').style.pointerEvents = 'auto';

    // Dedicated house marker pane — canvassing markers (knock/hanger) render HERE
    this.map.createPane('housePane');
    this.map.getPane('housePane').style.zIndex = 620;
    this.map.getPane('housePane').style.pointerEvents = 'auto';

    // Address-label pane — every residential parcel gets a circle marker here.
    // z 610 is BELOW housePane (620) so canvassing markers render on top of
    // address markers. This unifies the visual style: every parcel shows a
    // consistent white circle, then hanger circles / knock diamonds overlay
    // for parcels with canvassing state.
    this.map.createPane('addrPane');
    this.map.getPane('addrPane').style.zIndex = 610;
    this.map.getPane('addrPane').style.pointerEvents = 'none';

    satellite.addTo(this.map);
    labels.addTo(this.map);  // v5.23: Road Labels on by default

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

    // Zoom and pan listeners — markers gated at zoom 17 / 16 per type
    // _refreshVisibleMarkers runs first so that the turf house-dot dedupe set
    // in _renderUnassignedMarkers is populated from the data cache, then the
    // unassigned gray dots render for everything else.
    this.map.on('zoomend', () => {
      this._updateZoomStyle();
      this._refreshVisibleMarkers();
      this._renderUnassignedMarkers();
    });
    // Debounce moveend so rapid panning doesn't rebuild markers on every pixel
    let _moveTimer = null;
    this.map.on('moveend', () => {
      clearTimeout(_moveTimer);
      _moveTimer = setTimeout(() => {
        this._refreshVisibleMarkers();
        this._renderUnassignedMarkers();
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

  // ── Unassigned residential parcel markers ───────────────────────────────
  // v5.23: Renders at zoom 17+. Every residential parcel NOT already covered
  // by a canvassing house-dot gets one dark-grey hanger-style circle with the
  // house number in black text inside — the exact same visual as an unvisited
  // hanger marker. Parcels WITH a turf house are deduped out via 15 m
  // proximity so they show ONLY the colored hanger dot, never a stacked dup.
  //
  // Dedupe strategy:
  //   1. Internal: one marker per normalized addr2 (handled by `seen`)
  //   2. Against turf houses: proximity within 15 m of any turf house centroid
  //      (spatial bucket index, 0.0003° / ~33 m buckets, 3x3 window).
  //      15 m is tight enough to preserve neighboring lots (~15-25 m apart
  //      centroid-to-centroid) while catching the ~5-15 m aerial-alignment
  //      drift between old DCAD sheet rows and new Coppell KMZ geometries.
  _renderUnassignedMarkers() {
    this.addressLabelGroup.clearLayers();
    if (typeof PARCELS_GEOJSON === 'undefined') return;
    if (this.map.getZoom() < this._labelZoomMin) return;

    // Build spatial index of turf house centroids — bucketed by ~33 m.
    const TURF_BUCKET = 0.0003;
    const turfBuckets = new Map();
    const tBK = (lat, lon) => Math.floor(lat / TURF_BUCKET) + ':' + Math.floor(lon / TURF_BUCKET);
    for (const turf of (this._allTurfsCache || [])) {
      for (const house of (turf.houses || [])) {
        if (!house.lat || !house.lon) continue;
        const k = tBK(house.lat, house.lon);
        let arr = turfBuckets.get(k);
        if (!arr) { arr = []; turfBuckets.set(k, arr); }
        arr.push([house.lat, house.lon]);
      }
    }

    // 15 m radius in meters^2 — compared using (deg * meters_per_deg) math.
    const M_PER_DEG_LAT = 111_000;
    const COS_LAT = Math.cos(32.95 * Math.PI / 180);
    const M_PER_DEG_LNG = M_PER_DEG_LAT * COS_LAT;
    const RADIUS_M = 15;
    const RADIUS_M_SQ = RADIUS_M * RADIUS_M;
    function nearTurfHouse(lat, lon) {
      const bx = Math.floor(lat / TURF_BUCKET);
      const by = Math.floor(lon / TURF_BUCKET);
      for (let dx = -1; dx <= 1; dx++) {
        for (let dy = -1; dy <= 1; dy++) {
          const arr = turfBuckets.get((bx + dx) + ':' + (by + dy));
          if (!arr) continue;
          for (let i = 0; i < arr.length; i++) {
            const dy_m = (arr[i][0] - lat) * M_PER_DEG_LAT;
            const dx_m = (arr[i][1] - lon) * M_PER_DEG_LNG;
            if (dx_m * dx_m + dy_m * dy_m < RADIUS_M_SQ) return true;
          }
        }
      }
      return false;
    }

    const bounds = this.map.getBounds().pad(0.05);
    const seen = new Set();

    for (const f of PARCELS_GEOJSON.features) {
      const addr2 = (f.properties.addr2 || '').trim();
      if (!addr2) continue;
      if (ParcelsUtil.isCommercialOrApt(addr2, f.properties)) continue;
      // Require number + whitespace + at least one non-whitespace char.
      // Catches garbage entries like "9001", "803", "HIGHLAND DR" that have
      // no real street address — those should never render as markers.
      if (!/^\d+\s+\S/.test(addr2)) continue;
      const num = addr2.match(/^(\d+)/)[1];
      // Coppell physical addresses are always ≤ 9999. Anything higher is
      // a DCAD mailing address (Dallas/Irving/Lewisville owner address)
      // bleeding through — skip it. (v5.22 accidentally raised this to
      // 99999, which let 5-digit mailing addresses like "16815" render.)
      if (parseInt(num, 10) > 9999) continue;
      const c = ParcelsUtil.featureCentroid(f);
      if (!c || !bounds.contains([c.lat, c.lon])) continue;

      const dedupeKey = addr2.toUpperCase().replace(/\s+/g, ' ').trim();
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);

      // Proximity dedupe against canvassing house-dots — fixes the stale-
      // sheet-address problem that left ghost duplicates in v5.21.
      if (nearTurfHouse(c.lat, c.lon)) continue;

      // Render using the same house-dot visual as real hanger markers —
      // #9ca3af (legend "Not visited" grey), white ring, black number label.
      // Placed in addrPane (z610, non-interactive) so colored canvassing dots
      // in housePane (z620) always render on top when present.
      L.marker([c.lat, c.lon], {
        icon: L.divIcon({
          html: `<div class="house-dot parcel-only" style="--dc:#9ca3af"><span class="house-dot-num">${num}</span></div>`,
          className: '',
          iconSize: [32, 32],
          iconAnchor: [16, 16],
        }),
        pane: 'addrPane',
        interactive: false,
        keyboard: false,
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

    // Interpolate size and opacity across zoom range 13-19
    const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
    const lerp  = (a, b, t) => a + (b - a) * clamp(t, 0, 1);
    const t = (z - 13) / (18 - 13); // 0 at zoom 13, 1 at zoom 18
    const size    = Math.round(lerp(8, 26, t));
    // v5.21: bump opacity lerp from 0.65-0.95 -> 0.80-1.0. The old range was
    // tuned to let a white addr-marker show through from underneath — that
    // layer is gone in v5.21, so turf colors need to read at full saturation
    // against the satellite imagery (no more washed-out pastel dots).
    const opacity = lerp(0.80, 1.0, t).toFixed(2);
    const anchor  = Math.round(size / 2);
    // Polygon fill opacity: 0.30 at zoom 13 (visible from far) → 0.05 at zoom 18+
    // (very transparent so markers dominate). Markers appear at zoom 16.
    const polyFill = lerp(0.30, 0.05, t).toFixed(2);

    // Update polygon fill opacity
    this.turfPolygonGroup?.eachLayer(layer => {
      if (layer.setStyle) layer.setStyle({ fillOpacity: parseFloat(polyFill) });
    });

    const wrap = document.getElementById('map');
    if (wrap) {
      wrap.style.setProperty('--dot-size', size + 'px');
      wrap.style.setProperty('--dot-opacity', opacity);
      wrap.classList.toggle('hide-turf-labels', z >= this._labelZoomMin);
    }

    // Ensure housePane is visible above threshold
    const housePane = this.map.getPane('housePane');
    if (housePane) housePane.style.display = '';

    // Update all marker icon sizes without full re-render.
    // Knock diamonds get a smaller size (~55% of hanger circles) so they don't
    // obscure hanger markers at the same lat/lon.
    const diamondSize   = Math.round(size * 0.55);
    const diamondAnchor = Math.round(diamondSize / 2);
    this.houseGroup?.eachLayer(marker => {
      if (!marker._icon) return;
      const icon = marker._icon.querySelector('.house-dot');
      const isDiamond = icon && icon.classList.contains('diamond');
      const sz = isDiamond ? diamondSize : size;
      const an = isDiamond ? diamondAnchor : anchor;
      if (icon) {
        icon.style.width  = sz + 'px';
        icon.style.height = sz + 'px';
      }
      marker._icon.style.marginLeft = -an + 'px';
      marker._icon.style.marginTop  = -an + 'px';
      marker._icon.style.width      = sz + 'px';
      marker._icon.style.height     = sz + 'px';
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
    // Apply zoom threshold before adding markers. Turf house-dots must render
    // first so _renderUnassignedMarkers can dedupe against _allTurfsCache.
    this._updateZoomStyle();
    this._refreshVisibleMarkers();
    this._renderUnassignedMarkers();
    this._renderLegend();
  },

  // ── Refresh only markers in current viewport at current zoom ───────────────
  _refreshVisibleMarkers() {
    const zoom = this.map.getZoom();
    const turfs = this._allTurfsCache;
    if (!turfs) return;

    // Below zoom 16: no house markers of any type — clear everything for performance
    if (zoom < 16) {
      this.houseGroup.clearLayers();
      this.houseMarkers = {};
      return;
    }

    const bounds = this.map.getBounds().pad(0.05);
    this.houseGroup.clearLayers();
    this.houseMarkers = {};

    turfs.forEach((turf) => {
      const isKnock = (turf.mode || 'hanger') === 'knock';
      // Two-tier zoom: knock diamonds at 16 (one level before hangers), hanger circles at 17
      const minZoom = isKnock ? 16 : this._minMarkerZoom;
      if (zoom < minZoom) return;
      const color = _turfColor(turf);
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
    // Unassigned zones: black border + black fill. Assigned zones: volunteer color for both border and fill.
    // Initial fillOpacity is set high (0.30); _updateZoomStyle interpolates lower as you zoom in
    // so polygons don't compete with marker visibility at zoom 16+.
    const isUnassigned = !turf.volunteer || turf.volunteer === '[UNASSIGNED]';
    const borderColor  = isUnassigned ? '#000000' : color;
    const fillColor    = isUnassigned ? '#000000' : color;
    const labelBg      = isUnassigned ? '#000000' : color;
    try {
      const poly = L.geoJSON(geojson, {
        style: { color: borderColor, fillColor, fillOpacity: 0.30, weight: 2.5, opacity: 1.0, dashArray: null }
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

  // ── Instant zone color update — updates BOTH border and fill (v5.18) ─────
  setZoneStyle(letter, color) {
    const poly = this._turfPolyByLetter[String(letter)];
    if (!poly) return;
    const isUnassigned = !color || color === '#6b7280';
    const newColor = isUnassigned ? '#000000' : color;
    poly.eachLayer(l => {
      if (l.setStyle) l.setStyle({ color: newColor, fillColor: newColor });
    });
    // Also update the zone label background
    this.turfLabelGroup.eachLayer(m => {
      const icon = m._icon;
      if (icon) {
        const labelDiv = icon.querySelector('.turf-label');
        if (labelDiv && labelDiv.textContent === String(letter)) {
          labelDiv.style.background = newColor;
        }
      }
    });
    // Re-apply current zoom-based fill opacity so the new fill color shows correctly
    this._updateZoomStyle();
  },

  // ── House dot — blank, color = result status, shape = turf mode ───────────
  _renderHouse(house, turf, idx, color, isOtherZone) {
    const marker = this._makeMarker(house, turf, isOtherZone);
    marker.on('click', () => {
      // Suppress all popups while a zone is being drawn — clicks belong to the polygon tool
      if (TurfDraw.isActive()) return;
      // In multi-select mode: toggle selection without a full re-render.
      // Directly update just this marker's icon + the Apply count display.
      if (UI._multiSelectTurf && String(UI._multiSelectTurf) === String(turf.letter)) {
        const wasSelected = UI._selectedHouseIds.has(house.id);
        if (wasSelected) {
          UI._selectedHouseIds.delete(house.id);
        } else {
          UI._selectedHouseIds.add(house.id);
        }
        const isSelected  = !wasSelected;
        const isDK        = (turf?.mode || 'hanger') === 'knock';
        const msCls       = `house-dot ms-dot${isSelected ? ' ms-dot-selected' : ''}${isDK ? ' diamond' : ''}`;
        marker.setIcon(L.divIcon({
          html: `<div class="${msCls}">${isSelected ? '✓' : ''}</div>`,
          className: '',
          iconSize: [26, 26],
          iconAnchor: [13, 13],
        }));
        marker.setZIndexOffset(isSelected ? 200 : 100);
        UI._msUpdateCount();
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

    // Unvisited hanger: #9ca3af matches the legend "Not visited" swatch.
    const dotColor     = resultDef ? resultDef.color : (isDoorKnock ? '#b3a8c8' : '#9ca3af');
    // Circle = hanger, diamond = knock. Knock diamonds are SMALL and translated up-right
    // via the .diamond CSS rule so they sit beside (not on top of) hanger circles
    // at the same address. The translate is part of the CSS transform so :hover scale still works.
    const cls = `house-dot${isDone ? ' done' : ''}${isDoorKnock ? ' diamond' : ''}${isOtherZone ? ' other-zone' : ''}`;
    const markerSize = isDoorKnock ? 14 : 26;
    const markerAnchor = Math.round(markerSize / 2);
    // Hanger circles show the street number for at-a-glance navigation.
    // Knock diamonds are 14 px — too small to fit a number legibly — so skip.
    // Coppell physical addresses are always ≤ 9999. Numbers above that are
    // DCAD owner mailing addresses (Dallas/Irving/Lewisville) bleeding through.
    const _rawNum = !isDoorKnock ? ((house.address || '').match(/^(\d+)/)?.[1] || '') : '';
    const numLabel = _rawNum && parseInt(_rawNum, 10) <= 9999 ? _rawNum : '';
    return L.marker([house.lat, house.lon], {
      icon: L.divIcon({
        html: `<div class="${cls}" style="--dc:${dotColor}">${numLabel ? `<span class="house-dot-num">${numLabel}</span>` : ''}</div>`,
        className: '',
        iconSize: [markerSize, markerSize],
        iconAnchor: [markerAnchor, markerAnchor],
      }),
      pane: 'housePane',
      // Hangers above knocks so the circle is the click-target when stacked.
      zIndexOffset: isOtherZone ? -200 : (isDoorKnock ? 50 : (isDone ? 0 : 100)),
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
