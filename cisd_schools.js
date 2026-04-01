// ─── CISD School Locations ─────────────────────────────────────────────────
// Coordinates verified via Google Places API — April 2026
// Rendered as persistent red labels at all zoom levels

const CISD_SCHOOLS = [
  // ── High Schools ──────────────────────────────────────────────────────────
  { name: 'Coppell HS',       short: 'CHS',        lat: 32.9747, lon: -96.9987, type: 'hs' },
  { name: 'New Tech High',    short: 'New Tech',    lat: 32.9721, lon: -96.9730, type: 'hs' },
  { name: 'CHS 9th Grade',    short: 'CHS 9',       lat: 32.9378, lon: -97.0027, type: 'hs' },
  // ── Middle Schools ────────────────────────────────────────────────────────
  { name: 'MS East',          short: 'MS East',     lat: 32.9611, lon: -96.9688, type: 'ms' },
  { name: 'MS North',         short: 'MS North',    lat: 32.9833, lon: -96.9913, type: 'ms' },
  { name: 'MS West',          short: 'MS West',     lat: 32.9269, lon: -96.9825, type: 'ms' },
  // ── Elementary Schools ────────────────────────────────────────────────────
  { name: 'Austin ES',        short: 'Austin',      lat: 32.9660, lon: -96.9783, type: 'es' },
  { name: 'Canyon Ranch ES',  short: 'Canyon Ranch',lat: 32.9361, lon: -96.9650, type: 'es' },
  { name: 'Cottonwood Creek', short: 'Cottonwood',  lat: 32.9764, lon: -97.0074, type: 'es' },
  { name: 'Denton Creek ES',  short: 'Denton Creek',lat: 32.9836, lon: -96.9890, type: 'es' },
  { name: 'Lakeside ES',      short: 'Lakeside',    lat: 32.9724, lon: -96.9590, type: 'es' },
  { name: 'Mockingbird ES',   short: 'Mockingbird', lat: 32.9629, lon: -96.9691, type: 'es' },
  { name: 'Pinkerton ES',     short: 'Pinkerton',   lat: 32.9487, lon: -96.9980, type: 'es' },
  { name: 'Richard J. Lee',   short: 'Lee ES',      lat: 32.9269, lon: -96.9747, type: 'es' },
  { name: 'Town Center ES',   short: 'Town Center', lat: 32.9746, lon: -96.9901, type: 'es' },
  { name: 'Valley Ranch ES',  short: 'Valley Ranch',lat: 32.9378, lon: -96.9559, type: 'es' },
  { name: 'Wilson ES',        short: 'Wilson',      lat: 32.9646, lon: -97.0058, type: 'es' },
];
