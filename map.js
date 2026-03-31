// ─── Map Module ──────────────────────────────────────────────────────────────
const MapModule = {
  map: null,
  turfPolygonGroup: null,
  houseGroup: null,
  addressLabelGroup: null,
  houseMarkers: {},
  _legend: null,
  _gpsPanDone: false,
  _labelZoomMin: 20,

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

    // Address label pane — above tiles, below markers
    this.map.createPane('addrPane');
    this.map.getPane('addrPane').style.zIndex = 400;
    this.map.getPane('addrPane').style.pointerEvents = 'none';

    satellite.addTo(this.map);
    labels.addTo(this.map);
    L.control.layers(
      { 'Aerial': satellite, 'Street': street },
      { 'Road Labels': labels },
      { position: 'bottomright', collapsed: true }
    ).addTo(this.map);

    this.turfPolygonGroup = L.layerGroup().addTo(this.map);
    this.houseGroup       = L.layerGroup().addTo(this.map);
    this.addressLabelGroup = L.layerGroup({ pane: 'addrPane' }).addTo(this.map);

    setTimeout(() => this.map.invalidateSize(), 100);
    this._tryInitialGPS();

    // Rebuild address labels on zoom
    this.map.on('zoomend', () => this._renderAddressLabels());
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

  // ── Address labels from parcels.js — always on, zoom-gated ──────────────
  _renderAddressLabels() {
    this.addressLabelGroup.clearLayers();
    if (typeof PARCELS_GEOJSON === 'undefined') return;
    if (this.map.getZoom() < this._labelZoomMin) return;

    const bounds = this.map.getBounds().pad(0.1);
    const seen = new Set();

    for (const f of PARCELS_GEOJSON.features) {
      const addr2 = (f.properties.addr2 || '').trim();
      if (!addr2) continue;
      if (seen.has(addr2)) continue;         // skip co-owner duplicates
      seen.add(addr2);

      const num = addr2.match(/^(\d+)/)?.[1];
      if (!num) continue;

      const c = ParcelsUtil.featureCentroid(f);
      if (!c) continue;
      if (!bounds.contains([c.lat, c.lon])) continue;

      L.marker([c.lat, c.lon], {
        icon: L.divIcon({
          html: `<div class="addr-label">${num}</div>`,
          className: '',
          iconSize: null,
          iconAnchor: [0, 0],   // anchor at top-left; CSS centers the label
        }),
        pane: 'addrPane',
        interactive: false,
        zIndexOffset: -1000,
      }).addTo(this.addressLabelGroup);
    }
  },

  // ── Full render ────────────────────────────────────────────────────────────
  renderAll(turfs) {
    this.turfPolygonGroup.clearLayers();
    this.houseGroup.clearLayers();
    this.houseMarkers = {};
    turfs.forEach((turf, i) => {
      const color = turf.color || CONFIG.TURF_COLORS[i % CONFIG.TURF_COLORS.length];
      this._renderTurfPolygon(turf, color);
      turf.houses.forEach((house, idx) => this._renderHouse(house, turf, idx, color));
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
    try {
      const poly = L.geoJSON(geojson, {
        style: { color, fillColor: color, fillOpacity: 0.10, weight: 2, opacity: 0.6, dashArray: '5,4' }
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
    } catch(e) {}
  },

  // ── House dot — blank, color = result status, shape = turf mode ───────────
  _renderHouse(house, turf, idx, color) {
    const marker = this._makeMarker(house, turf);
    marker.on('click', () => this._openHousePopup(house, turf, color));
    marker.addTo(this.houseGroup);
    this.houseMarkers[house.id] = marker;
  },

  _makeMarker(house, turf) {
    const result    = house.result || '';
    const resultDef = CONFIG.RESULTS.find(r => r.key === result);
    const dotColor  = resultDef ? resultDef.color : '#6b7280';
    const isDone       = !!result;
    const isDoorKnock  = (turf?.mode || 'hanger') === 'doorknock';

    // Circle = hanger, diamond = door knock
    const cls = `house-dot${isDone ? ' done' : ''}${isDoorKnock ? ' diamond' : ''}`;
    return L.marker([house.lat, house.lon], {
      icon: L.divIcon({
        html: `<div class="${cls}" style="--dc:${dotColor}"></div>`,
        className: '',
        iconSize: [20, 20],
        iconAnchor: [10, 10],   // centered on parcel centroid; addr label offset above
      }),
      zIndexOffset: isDone ? 0 : 100,
    });
  },

  updateHouseMarker(house, turf, idx) {
    const old = this.houseMarkers[house.id];
    if (!old) return;
    const color   = turf.color || CONFIG.TURF_COLORS[0];
    const updated = this._makeMarker(house, turf);
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

    const btnRows = CONFIG.RESULTS.map(r => {
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
        <div class="popup-result-grid">${btnRows}</div>
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

  // ── Legend ──────────────────────────────────────────────────────────────────
  _renderLegend() {
    if (this._legend) this._legend.remove();
    const legend = L.control({ position: 'bottomleft' });
    legend.onAdd = () => {
      const div = L.DomUtil.create('div', 'map-legend');
      div.innerHTML = CONFIG.RESULTS.map(r =>
        `<div class="legend-row">
           <span class="legend-dot" style="background:${r.color}"></span>
           <span class="legend-label">${r.icon} ${r.label}</span>
         </div>`
      ).join('')
      + `<div class="legend-row">
           <span class="legend-dot" style="background:#9ca3af"></span>
           <span class="legend-label">Not visited</span>
         </div>
         <div class="legend-row" style="margin-top:4px;padding-top:4px;border-top:1px solid rgba(0,0,0,0.1)">
           <span class="legend-dot" style="border-radius:3px;background:#6b7280"></span>
           <span class="legend-label">◆ Door Knock</span>
         </div>`;
      L.DomEvent.disableClickPropagation(div);
      return div;
    };
    legend.addTo(this.map);
    this._legend = legend;
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
    if (btn) btn.textContent = '📍 Locating…';
    navigator.geolocation.getCurrentPosition(pos => {
      this._locationActive = true;
      this._gpsPanDone = true;
      if (btn) { btn.textContent = '📍 Stop'; btn.classList.add('active-btn'); }
      this._updateLocationMarker(pos);
      this.map.setView([pos.coords.latitude, pos.coords.longitude],
        Math.max(this.map.getZoom(), 16));
      UI.toast('Location found', 'success');
      this._locationWatchId = navigator.geolocation.watchPosition(
        p  => this._updateLocationMarker(p),
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
    if (btn) { btn.textContent = '📍 My Location'; btn.classList.remove('active-btn'); }
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
    if (btn) { btn.textContent = '📍 My Location'; btn.classList.remove('active-btn'); }
    UI.toast({ 1: 'Location access denied', 2: 'Location unavailable', 3: 'Location timed out' }[err.code] || 'Location error', 'error');
  },

  getCurrentLatLon() {
    if (!this._locationMarker) return null;
    const ll = this._locationMarker.getLatLng();
    return { lat: ll.lat, lon: ll.lng };
  },
};

function _esc(s) {
  return (s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
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
