/**
 * ⚠️  EVERY TIME YOU CHANGE THIS FILE:
 *  1. Save (Ctrl+S)
 *  2. Deploy → Manage deployments
 *  3. Click the ✏️ pencil on your existing deployment
 *  4. Version → "New version"
 *  5. Click Deploy
 *  ✅ Same URL — no config.js change needed
 * ─────────────────────────────────────────────────────────────
 *
 * Chaka Door Canvass — Google Sheets Backend
 *
 * SETUP:
 * 1. Create a new Google Sheet
 * 2. Open Extensions → Apps Script
 * 3. Paste this entire file, replacing the default code
 * 4. Deploy → New deployment
 *    - Type: Web app
 *    - Execute as: Me
 *    - Who has access: Anyone
 * 5. Copy the deployment URL into config.js → SHEETS_API_URL
 *
 * SHEETS AUTO-CREATED ON FIRST REQUEST:
 *
 *  "houses"   — id | turf | name | address | lat | lon | notes |
 *               result | result_date | result_by | sort_order
 *
 *  "turfs"    — letter | color | volunteer | polygon_geojson | created_date
 *
 *  "presence" — session_id | name | last_seen
 */

// ─── Entry Points ─────────────────────────────────────────────────────────────

function doGet(e) {
  try {
    if (e.parameter.payload) {
      return handleAction(JSON.parse(decodeURIComponent(e.parameter.payload)));
    }
    const action = e.parameter.action || 'getAll';
    if (action === 'getAll') {
      return json(getAllData());
    }
    return json({ error: 'Unknown action: ' + action });
  } catch (err) {
    return json({ error: err.toString() });
  }
}

function doPost(e) {
  try {
    return handleAction(JSON.parse(e.postData.contents));
  } catch (err) {
    return json({ error: err.toString() });
  }
}

function handleAction(data) {
  try {
    switch (data.action) {
      case 'getAll':          return json(getAllData());
      case 'addHouse':        return json(addHouse(data.house));
      case 'removeHouse':     return json(removeHouse(data.id));
      case 'updateHouse':     return json(updateHouse(data.id, data.fields));
      case 'setResult':       return json(setResult(data.id, data.result, data.result_by));
      case 'clearResult':     return json(clearResult(data.id));
      case 'addTurf':         return json(addTurf(data.letter, data.color, data.volunteer));
      case 'deleteTurf':      return json(deleteTurf(data.letter));
      case 'updateTurf':      return json(updateTurf(data.letter, data.fields));
      case 'saveTurfPolygon': return json(saveTurfPolygon(data.letter, data.geojson));
      case 'reorderHouses':   return json(reorderHouses(data.turf, data.order));
      case 'bulkImport':      return json(bulkImport(data.turfs));
      case 'heartbeat':       return json(heartbeat(data.name, data.sessionId));
      case 'getPresence':     return json(getPresence());
      default:                return json({ error: 'Unknown action: ' + data.action });
    }
  } catch (err) {
    return json({ error: err.toString() });
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function json(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

function getSheet(name) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(name);
  if (!sheet) {
    sheet = ss.insertSheet(name);
    if (name === 'houses') {
      sheet.appendRow(['id','turf','name','address','lat','lon','notes','result','result_date','result_by','sort_order']);
    } else if (name === 'turfs') {
      sheet.appendRow(['letter','color','volunteer','polygon_geojson','created_date']);
    } else if (name === 'presence') {
      sheet.appendRow(['session_id','name','last_seen']);
    }
  }
  return sheet;
}

function uid() {
  return Utilities.getUuid().substring(0, 8);
}

function sheetToObjects(sheet) {
  const data = sheet.getDataRange().getValues();
  if (data.length < 2) return [];
  const headers = data[0];
  return data.slice(1)
    .map(row => {
      const obj = {};
      headers.forEach((h, i) => { obj[h] = row[i]; });
      return obj;
    })
    .filter(obj => obj[headers[0]] !== '');
}

// ─── Read All ─────────────────────────────────────────────────────────────────

function getAllData() {
  const housesData = sheetToObjects(getSheet('houses'));
  const turfsData  = sheetToObjects(getSheet('turfs'));

  const turfs = turfsData.map(t => ({
    letter:          t.letter,
    color:           t.color || '',
    volunteer:       t.volunteer || '[UNASSIGNED]',
    polygon_geojson: t.polygon_geojson || '',
    houses: housesData
      .filter(h => h.turf === t.letter)
      .sort((a, b) => (parseInt(a.sort_order) || 0) - (parseInt(b.sort_order) || 0))
      .map(h => ({
        id:          h.id,
        name:        h.name || '',
        address:     h.address || '',
        lat:         parseFloat(h.lat),
        lon:         parseFloat(h.lon),
        notes:       h.notes || '',
        result:      h.result || '',
        result_date: h.result_date || '',
        result_by:   h.result_by || '',
        sort_order:  parseInt(h.sort_order) || 0
      }))
  }));

  return { turfs, timestamp: new Date().toISOString() };
}

// ─── House CRUD ───────────────────────────────────────────────────────────────

function addHouse(house) {
  const sheet = getSheet('houses');
  const all   = sheetToObjects(sheet);
  const maxOrder = all
    .filter(h => h.turf === house.turf)
    .reduce((max, h) => Math.max(max, parseInt(h.sort_order) || 0), 0);
  const id = uid();
  sheet.appendRow([
    id, house.turf || 'A',
    house.name || '', house.address || '',
    house.lat  || 0,  house.lon     || 0,
    house.notes || '', '', '', '',
    maxOrder + 1
  ]);
  SpreadsheetApp.flush();
  return { success: true, id };
}

function removeHouse(id) {
  const sheet = getSheet('houses');
  const data  = sheet.getDataRange().getValues();
  for (let i = 1; i < data.length; i++) {
    if (String(data[i][0]) === String(id)) {
      sheet.deleteRow(i + 1);
      SpreadsheetApp.flush();
      return { success: true };
    }
  }
  return { error: 'House not found: ' + id };
}

function updateHouse(id, fields) {
  const sheet   = getSheet('houses');
  const data    = sheet.getDataRange().getValues();
  const headers = data[0];
  for (let i = 1; i < data.length; i++) {
    if (String(data[i][0]) === String(id)) {
      for (const [key, value] of Object.entries(fields)) {
        const col = headers.indexOf(key);
        if (col >= 0) sheet.getRange(i + 1, col + 1).setValue(value);
      }
      SpreadsheetApp.flush();
      return { success: true };
    }
  }
  return { error: 'House not found: ' + id };
}

function setResult(id, result, resultBy) {
  const sheet   = getSheet('houses');
  const data    = sheet.getDataRange().getValues();
  const headers = data[0];
  for (let i = 1; i < data.length; i++) {
    if (String(data[i][0]) === String(id)) {
      sheet.getRange(i + 1, headers.indexOf('result')      + 1).setValue(result);
      sheet.getRange(i + 1, headers.indexOf('result_date') + 1).setValue(new Date().toISOString());
      sheet.getRange(i + 1, headers.indexOf('result_by')   + 1).setValue(resultBy || '');
      SpreadsheetApp.flush();
      return { success: true };
    }
  }
  return { error: 'House not found: ' + id };
}

function clearResult(id) {
  const sheet   = getSheet('houses');
  const data    = sheet.getDataRange().getValues();
  const headers = data[0];
  for (let i = 1; i < data.length; i++) {
    if (String(data[i][0]) === String(id)) {
      sheet.getRange(i + 1, headers.indexOf('result')      + 1).setValue('');
      sheet.getRange(i + 1, headers.indexOf('result_date') + 1).setValue('');
      sheet.getRange(i + 1, headers.indexOf('result_by')   + 1).setValue('');
      SpreadsheetApp.flush();
      return { success: true };
    }
  }
  return { error: 'House not found: ' + id };
}

function reorderHouses(turfLetter, orderIds) {
  const sheet   = getSheet('houses');
  const data    = sheet.getDataRange().getValues();
  const headers = data[0];
  const sortCol = headers.indexOf('sort_order');
  orderIds.forEach((id, idx) => {
    for (let i = 1; i < data.length; i++) {
      if (String(data[i][0]) === String(id)) {
        sheet.getRange(i + 1, sortCol + 1).setValue(idx + 1);
        break;
      }
    }
  });
  SpreadsheetApp.flush();
  return { success: true };
}

// ─── Turf CRUD ────────────────────────────────────────────────────────────────

function addTurf(letter, color, volunteer) {
  const sheet    = getSheet('turfs');
  const existing = sheetToObjects(sheet);
  if (existing.some(t => t.letter === letter)) return { error: 'Turf ' + letter + ' already exists' };
  sheet.appendRow([letter, color || '', volunteer || '[UNASSIGNED]', '', new Date().toISOString()]);
  SpreadsheetApp.flush();
  return { success: true };
}

function deleteTurf(letter) {
  const houses = sheetToObjects(getSheet('houses'));
  if (houses.some(h => h.turf === letter)) {
    return { error: 'Cannot delete turf ' + letter + ' — it still has houses. Remove them first.' };
  }
  const sheet = getSheet('turfs');
  const data  = sheet.getDataRange().getValues();
  for (let i = 1; i < data.length; i++) {
    if (data[i][0] === letter) {
      sheet.deleteRow(i + 1);
      SpreadsheetApp.flush();
      return { success: true };
    }
  }
  return { error: 'Turf not found: ' + letter };
}

function updateTurf(letter, fields) {
  const sheet   = getSheet('turfs');
  const data    = sheet.getDataRange().getValues();
  const headers = data[0];
  for (let i = 1; i < data.length; i++) {
    if (data[i][0] === letter) {
      for (const [key, value] of Object.entries(fields)) {
        const col = headers.indexOf(key);
        if (col >= 0) sheet.getRange(i + 1, col + 1).setValue(value);
      }
      SpreadsheetApp.flush();
      return { success: true };
    }
  }
  return { error: 'Turf not found: ' + letter };
}

function saveTurfPolygon(letter, geojson) {
  const sheet   = getSheet('turfs');
  const data    = sheet.getDataRange().getValues();
  const headers = data[0];
  const col     = headers.indexOf('polygon_geojson') + 1;
  for (let i = 1; i < data.length; i++) {
    if (data[i][0] === letter) {
      sheet.getRange(i + 1, col).setValue(geojson ? JSON.stringify(geojson) : '');
      SpreadsheetApp.flush();
      return { success: true };
    }
  }
  return { error: 'Turf not found: ' + letter };
}

// ─── Bulk Import ──────────────────────────────────────────────────────────────

function bulkImport(turfs) {
  const housesSheet = getSheet('houses');
  const turfsSheet  = getSheet('turfs');
  if (housesSheet.getLastRow() > 1) housesSheet.deleteRows(2, housesSheet.getLastRow() - 1);
  if (turfsSheet.getLastRow()  > 1) turfsSheet.deleteRows(2,  turfsSheet.getLastRow()  - 1);

  const defaultColors = ['#e05c4b','#c9831a','#2d9e5f','#2e6ec2','#7c4dcc','#c4487a','#1a9e9e','#c27a1a'];
  turfs.forEach((turf, ti) => {
    turfsSheet.appendRow([
      turf.letter,
      turf.color || defaultColors[ti % defaultColors.length],
      turf.volunteer || '[UNASSIGNED]',
      turf.polygon_geojson ? JSON.stringify(turf.polygon_geojson) : '',
      new Date().toISOString()
    ]);
    turf.houses.forEach((house, hi) => {
      housesSheet.appendRow([
        uid(), turf.letter,
        house.name || '', house.address || '',
        house.lat  || 0,  house.lon     || 0,
        house.notes || '', '', '', '',
        hi + 1
      ]);
    });
  });
  SpreadsheetApp.flush();
  return {
    success: true,
    turfs: turfs.length,
    houses: turfs.reduce((s, t) => s + t.houses.length, 0)
  };
}

// ─── Presence ─────────────────────────────────────────────────────────────────

function heartbeat(name, sessionId) {
  const sheet = getSheet('presence');
  if (sheet.getLastRow() === 0) sheet.appendRow(['session_id','name','last_seen']);
  const rows    = sheet.getDataRange().getValues();
  const hdrs    = rows[0];
  const sidCol  = hdrs.indexOf('session_id') + 1;
  const nameCol = hdrs.indexOf('name') + 1;
  const seenCol = hdrs.indexOf('last_seen') + 1;
  const now     = new Date().toISOString();
  for (let i = 1; i < rows.length; i++) {
    if (String(rows[i][sidCol - 1]) === String(sessionId)) {
      sheet.getRange(i + 1, nameCol).setValue(name || 'Unknown');
      sheet.getRange(i + 1, seenCol).setValue(now);
      SpreadsheetApp.flush();
      return { success: true };
    }
  }
  sheet.appendRow([sessionId, name || 'Unknown', now]);
  SpreadsheetApp.flush();
  return { success: true };
}

function getPresence() {
  const sheet = getSheet('presence');
  if (sheet.getLastRow() < 2) return { users: [] };
  const rows    = sheet.getDataRange().getValues();
  const hdrs    = rows[0];
  const sidCol  = hdrs.indexOf('session_id');
  const nameCol = hdrs.indexOf('name');
  const seenCol = hdrs.indexOf('last_seen');
  const cutoff  = Date.now() - 90000;
  const users   = rows.slice(1)
    .filter(r => r[seenCol] && new Date(r[seenCol]).getTime() >= cutoff)
    .map(r => ({ sessionId: String(r[sidCol]), name: r[nameCol] || 'Unknown', last_seen: r[seenCol] }));
  return { users };
}
