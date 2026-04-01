// ─── Parcels Utility Module ───────────────────────────────────────────────────

const ParcelsUtil = (() => {

  // ── Centroid of a ring ([lon,lat] array) ─────────────────────────────────
  function _ringCentroid(ring) {
    let lat = 0, lon = 0;
    ring.forEach(([lo, la]) => { lon += lo; lat += la; });
    return { lat: lat / ring.length, lon: lon / ring.length };
  }

  function featureCentroid(feature) {
    const g = feature.geometry;
    if (g.type === 'Polygon')      return _ringCentroid(g.coordinates[0]);
    if (g.type === 'MultiPolygon') return _ringCentroid(g.coordinates[0][0]);
    return null;
  }

  // ── Count vertices — used to pick best feature for a duplicate address ───
  function _vertexCount(feature) {
    const g = feature.geometry;
    if (g.type === 'Polygon')      return g.coordinates[0].length;
    if (g.type === 'MultiPolygon') return g.coordinates[0][0].length;
    return 0;
  }

  // ── Ray-casting point-in-polygon ─────────────────────────────────────────
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

  function ptInDrawnRing(pt, drawnRing) {
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
    if (!(/^\d/.test(addr))) return true;
    if (addr.length > 45) return true;
    return false;
  }

  function _isApartment(addr2) {
    const addr = (addr2 || '').toUpperCase();
    return APT_WORDS.some(k => addr.includes(k));
  }

  // ── Dedup: group features by addr2, return best representative per group ─
  // "Best" = most vertices (richest geometry = most accurate centroid).
  // This replaces the old first-seen filter that dropped co-owner records.
  function _bestFeaturePerAddr(features) {
    const groups = {};
    features.forEach(f => {
      const key = (f.properties.addr2 || '').trim().toUpperCase();
      if (!key) return;
      if (!groups[key]) { groups[key] = f; return; }
      // Keep the feature with the most vertices
      if (_vertexCount(f) > _vertexCount(groups[key])) groups[key] = f;
    });
    return Object.values(groups);
  }

  // Count how many distinct addr2 values resolve to same key — used for
  // apartment detection (3+ records sharing exact same address string)
  function _buildAddrCounts(features) {
    const counts = {};
    features.forEach(f => {
      const key = (f.properties.addr2 || '').trim().toUpperCase();
      if (key) counts[key] = (counts[key] || 0) + 1;
    });
    return counts;
  }

  // ── Nearest-neighbor walk-order sort ─────────────────────────────────────
  function walkOrder(houses, startPt) {
    if (!houses.length) return houses;
    const remaining = [...houses];
    const ordered   = [];
    let cur = startPt;
    while (remaining.length) {
      let bestIdx = 0, bestDist = Infinity;
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

  function _dist(a, b) {
    const dlat = a.lat - b.lat;
    const dlon = (a.lon - b.lon) * Math.cos((a.lat + b.lat) * Math.PI / 360);
    return dlat * dlat + dlon * dlon;
  }

  function leafletRingCentroid(ring) {
    let lat = 0, lon = 0;
    ring.forEach(ll => {
      lat += Array.isArray(ll) ? ll[0] : ll.lat;
      lon += Array.isArray(ll) ? ll[1] : ll.lng;
    });
    return { lat: lat / ring.length, lon: lon / ring.length };
  }

  // ── Main: parcels inside a drawn polygon ─────────────────────────────────
  function parcelsInPolygon(drawnRing, includeCommercial = false) {
    if (typeof PARCELS_GEOJSON === 'undefined') return { residential: [], excluded: [] };

    const allFeatures = PARCELS_GEOJSON.features;

    // Step 1: find all features whose centroid is inside the drawn ring
    const inside = allFeatures.filter(f => {
      const c = featureCentroid(f);
      return c && ptInDrawnRing(c, drawnRing);
    });

    // Step 2: deduplicate — pick best-geometry feature per address
    // (fixes co-owner records dropping half the houses)
    const deduped = _bestFeaturePerAddr(inside);

    // Step 3: count records per address within this drawn area only
    // (apartment detection: 3+ separate records for same address in local area)
    const localCounts = _buildAddrCounts(inside);  // uses raw inside, not deduped

    const residential = [];
    const excluded    = [];

    deduped.forEach(f => {
      const addr2 = (f.properties.addr2 || '').trim();
      if (!addr2) return;
      const key = addr2.toUpperCase();
      const c   = featureCentroid(f);
      if (!c) return;

      const isComm = _isCommercial(f.properties, addr2);
      const isApt  = _isApartment(addr2) || (localCounts[key] || 0) >= 3;

      const entry = {
        lat: c.lat, lon: c.lon,
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

  // ── Parcel search (Add House picker) ─────────────────────────────────────
  function searchParcels(query, maxResults = 30) {
    if (typeof PARCELS_GEOJSON === 'undefined' || !query || query.length < 2) return [];
    const q = query.toUpperCase().trim();
    const seen = new Set();
    const results = [];
    for (const f of PARCELS_GEOJSON.features) {
      const addr  = (f.properties.addr2  || '').toUpperCase();
      const owner = (f.properties.owner  || '').toUpperCase();
      if (!addr) continue;
      if (seen.has(addr)) continue;   // skip co-owner duplicates in search too
      if (addr.includes(q) || owner.includes(q)) {
        const c = featureCentroid(f);
        if (!c) continue;
        seen.add(addr);
        results.push({
          lat: c.lat, lon: c.lon,
          address: f.properties.addr2 || '',
          owner:   f.properties.owner || '',
        });
        if (results.length >= maxResults) break;
      }
    }
    return results;
  }

  // Public helper for map.js address label filter
  function isCommercialOrApt(addr2, props) {
    return _isCommercial(props || {}, addr2) || _isApartment(addr2);
  }

  return { parcelsInPolygon, searchParcels, walkOrder, leafletRingCentroid, featureCentroid, ptInDrawnRing, isCommercialOrApt };
})();
