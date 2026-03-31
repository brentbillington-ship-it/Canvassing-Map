// ─── Parcels Utility Module ───────────────────────────────────────────────────
// Centroid, point-in-polygon, commercial filtering, dedup, nearest-neighbor sort.
// Requires: PARCELS_GEOJSON (loaded from parcels.js)

const ParcelsUtil = (() => {

  // ── Centroid of a ring (array of [lon,lat]) ──────────────────────────────
  function _ringCentroid(ring) {
    let lat = 0, lon = 0;
    ring.forEach(([lo, la]) => { lon += lo; lat += la; });
    return { lat: lat / ring.length, lon: lon / ring.length };
  }

  // ── Centroid of a Feature (Polygon or MultiPolygon) ──────────────────────
  function featureCentroid(feature) {
    const g = feature.geometry;
    if (g.type === 'Polygon') return _ringCentroid(g.coordinates[0]);
    if (g.type === 'MultiPolygon') return _ringCentroid(g.coordinates[0][0]);
    return null;
  }

  // ── Ray-casting point-in-polygon  ────────────────────────────────────────
  // pt: {lat,lon}  ring: [[lon,lat],...]
  function _ptInRing(pt, ring) {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i];
      const [xj, yj] = ring[j];
      const intersect = ((yi > pt.lat) !== (yj > pt.lat)) &&
        (pt.lon < (xj - xi) * (pt.lat - yi) / (yj - yi) + xi);
      if (intersect) inside = !inside;
    }
    return inside;
  }

  // Test a point against a drawn Leaflet polygon's latlngs
  // drawnRing: [[lat,lon],...] from layer.getLatLngs()[0]
  function ptInDrawnRing(pt, drawnRing) {
    // Convert Leaflet {lat,lng} objects or [lat,lon] pairs → [lon,lat] for ray cast
    const ring = drawnRing.map(ll =>
      Array.isArray(ll) ? [ll[1], ll[0]] : [ll.lng, ll.lat]
    );
    return _ptInRing(pt, ring);
  }

  // ── Commercial / non-residential filter ─────────────────────────────────
  const OWNER_EXCL = [
    'CITY OF', ' ISD', 'COUNTY', ' INC', ' CORP', 'CHURCH', 'SCHOOL',
    'DISTRICT', 'ASSOCIATION', 'ASSOC ', 'ASSN ', 'UNIVERSITY', 'HOSPITAL',
  ];
  const ADDR_EXCL_WORDS = [
    'STE ', 'SUITE', ' FL ', 'FLOOR', 'HWY ', 'HIGHWAY', ' FM ',
    ' IH-', ' US-', 'PO BOX', 'P O BOX',
  ];
  const APT_WORDS = ['APT ', ' APT', ' TRLR', ' #', 'UNIT '];

  function _isCommercial(props, addr2) {
    const owner = (props.owner || '').toUpperCase();
    const addr  = (addr2 || '').toUpperCase();
    if (OWNER_EXCL.some(k => owner.includes(k))) return true;
    if (ADDR_EXCL_WORDS.some(k => addr.includes(k))) return true;
    if (!(/^\d/.test(addr))) return true;          // no street number
    if (addr.length > 45) return true;
    return false;
  }

  function _isApartment(props, addr2) {
    const addr = (addr2 || '').toUpperCase();
    return APT_WORDS.some(k => addr.includes(k));
  }

  // ── Deduplicate on addr2 (keep first occurrence) ─────────────────────────
  function _dedupByAddr(features) {
    const seen = new Set();
    return features.filter(f => {
      const key = (f.properties.addr2 || '').trim().toUpperCase();
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  // Count duplicates per addr2 — used to detect apartments (3+ same address)
  function _buildAddrCounts(features) {
    const counts = {};
    features.forEach(f => {
      const key = (f.properties.addr2 || '').trim().toUpperCase();
      if (key) counts[key] = (counts[key] || 0) + 1;
    });
    return counts;
  }

  // ── Nearest-neighbor walk-order sort ────────────────────────────────────
  // houses: [{lat,lon,...}]  startPt: {lat,lon} (GPS or polygon centroid)
  // Returns houses in walk order.
  function walkOrder(houses, startPt) {
    if (!houses.length) return houses;
    const remaining = [...houses];
    const ordered   = [];
    let cur = startPt;

    while (remaining.length) {
      let bestIdx = 0;
      let bestDist = Infinity;
      remaining.forEach((h, i) => {
        const d = _dist(cur, h);
        if (d < bestDist) { bestDist = d; bestIdx = i; }
      });
      ordered.push(remaining[bestIdx]);
      cur = remaining[bestIdx];
      remaining.splice(bestIdx, 1);
    }
    return ordered;
  }

  // Haversine-ish squared distance (good enough for short distances, fast)
  function _dist(a, b) {
    const dlat = a.lat - b.lat;
    const dlon = (a.lon - b.lon) * Math.cos((a.lat + b.lat) * Math.PI / 360);
    return dlat * dlat + dlon * dlon;
  }

  // ── Polygon centroid from Leaflet latlngs ────────────────────────────────
  function leafletRingCentroid(ring) {
    let lat = 0, lon = 0;
    ring.forEach(ll => {
      lat += Array.isArray(ll) ? ll[0] : ll.lat;
      lon += Array.isArray(ll) ? ll[1] : ll.lng;
    });
    return { lat: lat / ring.length, lon: lon / ring.length };
  }

  // ── Main: find parcels inside a drawn polygon ────────────────────────────
  // Returns { residential: [...], excluded: [...] }
  // Each item: { lat, lon, address, owner, _feature }
  // includeCommercial: admin override flag
  function parcelsInPolygon(drawnRing, includeCommercial = false) {
    if (typeof PARCELS_GEOJSON === 'undefined') return { residential: [], excluded: [] };

    const features = PARCELS_GEOJSON.features;
    const addrCounts = _buildAddrCounts(features);

    const inside = features.filter(f => {
      const c = featureCentroid(f);
      return c && ptInDrawnRing(c, drawnRing);
    });

    const residential = [];
    const excluded    = [];

    // Deduplicate
    const seen = new Set();

    inside.forEach(f => {
      const addr2 = (f.properties.addr2 || '').trim();
      const key   = addr2.toUpperCase();
      const c     = featureCentroid(f);
      if (!c || !addr2 || seen.has(key)) return;
      seen.add(key);

      const isComm = _isCommercial(f.properties, addr2);
      const isApt  = _isApartment(f.properties, addr2) || (addrCounts[key] || 0) >= 3;

      const entry = {
        lat: c.lat,
        lon: c.lon,
        address: addr2,
        owner: f.properties.owner || '',
      };

      if ((isComm || isApt) && !includeCommercial) {
        excluded.push({ ...entry, reason: isApt ? 'apartment' : 'commercial' });
      } else {
        residential.push(entry);
      }
    });

    return { residential, excluded };
  }

  // ── Parcel search (for Add House picker) ────────────────────────────────
  // Returns up to maxResults parcels matching query string (addr or owner)
  function searchParcels(query, maxResults = 30) {
    if (typeof PARCELS_GEOJSON === 'undefined' || !query || query.length < 2) return [];
    const q = query.toUpperCase().trim();
    const results = [];
    for (const f of PARCELS_GEOJSON.features) {
      const addr  = (f.properties.addr2  || '').toUpperCase();
      const owner = (f.properties.owner  || '').toUpperCase();
      if (addr.includes(q) || owner.includes(q)) {
        const c = featureCentroid(f);
        if (!c) continue;
        results.push({
          lat: c.lat,
          lon: c.lon,
          address: f.properties.addr2 || '',
          owner: f.properties.owner   || '',
        });
        if (results.length >= maxResults) break;
      }
    }
    return results;
  }

  return { parcelsInPolygon, searchParcels, walkOrder, leafletRingCentroid, featureCentroid, ptInDrawnRing };
})();
