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
 * Chaka Canvassing — Google Sheets Backend v4.9
 *
 *  "houses"       — id | turf | owner | address | lat | lon | notes |
 *                   result | result_date | result_by | sort_order
 *  "turfs"        — letter | color | volunteer | mode | polygon_geojson | created_date
 *  "presence"     — session_id | name | last_seen
 *  "logins"       — timestamp | name | mode | session_id
 *  "chat"         — id | timestamp | name | session_id | message
 *  "users"        — email | name | color | created_date
 *  "deleted_zones"— timestamp | letter | volunteer | house_count | result_count | data_json
 */

function doGet(e) {
  try {
    if (e.parameter.payload) {
      return handleAction(JSON.parse(decodeURIComponent(e.parameter.payload)));
    }
    return json(getAllData());
  } catch (err) { return json({ error: err.toString() }); }
}

function doPost(e) {
  try { return handleAction(JSON.parse(e.postData.contents)); }
  catch (err) { return json({ error: err.toString() }); }
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
      case 'addTurf':         return json(addTurf(data.letter, data.color, data.volunteer, data.mode));
      case 'deleteTurf':      return json(deleteTurf(data.letter));
      case 'updateTurf':      return json(updateTurf(data.letter, data.fields));
      case 'saveTurfPolygon': return json(saveTurfPolygon(data.letter, data.geojson));
      case 'reorderHouses':   return json(reorderHouses(data.turf, data.order));
      case 'bulkImport':      return json(bulkImport(data.turfs));
      case 'bulkImportHouses': return json(bulkImportHouses(data.letter, data.houses));
      case 'createZone':       return json(createZone(data.letter, data.color, data.volunteer, data.geojson, data.houses));
      case 'claimZone':        return json(claimZone(data.letter, data.volunteer, data.color));
      case 'clearTurf':       return json(clearTurf(data.letter));
      case 'heartbeat':       return json(heartbeat(data.name, data.sessionId));
      case 'getPresence':     return json(getPresence());
      case 'logLogin':        return json(logLogin(data.name, data.mode, data.sessionId));
      case 'getLogins':       return json(getLogins());
      case 'sendChat':        return json(sendChat(data.name, data.sessionId, data.message));
      case 'getChat':         return json(getChat(data.since));
      case 'getLeaderboard':  return json(getLeaderboard());
      case 'exportCSV':       return json(exportCSV());
      case 'getUsers':        return json(getUsers());
      case 'createUser':      return json(createUser(data.email, data.name, data.color));
      case 'getUser':         return json(getUser(data.email));
      case 'backupZone':      return json(backupZone(data.letter));
      default:                return json({ error: 'Unknown action: ' + data.action });
    }
  } catch (err) { return json({ error: err.toString() }); }
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
    if (name === 'houses')   sheet.appendRow(['id','turf','owner','address','lat','lon','notes','result','result_date','result_by','sort_order']);
    else if (name === 'turfs')    sheet.appendRow(['letter','color','volunteer','mode','polygon_geojson','created_date']);
    else if (name === 'presence') sheet.appendRow(['session_id','name','last_seen']);
    else if (name === 'logins')   sheet.appendRow(['timestamp','name','mode','session_id']);
    else if (name === 'chat')          sheet.appendRow(['id','timestamp','name','session_id','message']);
    else if (name === 'users')         sheet.appendRow(['email','name','color','created_date']);
    else if (name === 'deleted_zones') sheet.appendRow(['timestamp','letter','volunteer','house_count','result_count','data_json']);
  }
  return sheet;
}

function uid() { return Utilities.getUuid().substring(0, 8); }

function sheetToObjects(sheet) {
  const data = sheet.getDataRange().getValues();
  if (data.length < 2) return [];
  const headers = data[0];
  return data.slice(1)
    .map(row => { const obj = {}; headers.forEach((h, i) => { obj[h] = row[i]; }); return obj; })
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
    mode:            t.mode || 'hanger',
    polygon_geojson: t.polygon_geojson || '',
    houses: housesData
      .filter(h => h.turf === t.letter)
      .sort((a, b) => (parseInt(a.sort_order) || 0) - (parseInt(b.sort_order) || 0))
      .map(h => ({
        id: h.id, owner: h.owner || '', address: h.address || '',
        lat: parseFloat(h.lat), lon: parseFloat(h.lon),
        notes: h.notes || '', result: h.result || '',
        result_date: h.result_date || '', result_by: h.result_by || '',
        sort_order: parseInt(h.sort_order) || 0
      }))
  }));
  return { turfs, timestamp: new Date().toISOString() };
}

// ─── House CRUD ───────────────────────────────────────────────────────────────

function addHouse(house) {
  const sheet = getSheet('houses');
  const all   = sheetToObjects(sheet);
  const maxOrder = all.filter(h => h.turf === house.turf)
    .reduce((max, h) => Math.max(max, parseInt(h.sort_order) || 0), 0);
  const id = uid();
  sheet.appendRow([id, house.turf||'A', house.owner||'', house.address||'',
    house.lat||0, house.lon||0, house.notes||'', '', '', '', maxOrder + 1]);
  SpreadsheetApp.flush();
  return { success: true, id };
}

function removeHouse(id) {
  const sheet = getSheet('houses');
  const data  = sheet.getDataRange().getValues();
  for (let i = 1; i < data.length; i++) {
    if (String(data[i][0]) === String(id)) { sheet.deleteRow(i + 1); SpreadsheetApp.flush(); return { success: true }; }
  }
  return { error: 'House not found: ' + id };
}

function updateHouse(id, fields) {
  const sheet = getSheet('houses');
  const data  = sheet.getDataRange().getValues();
  const hdrs  = data[0];
  for (let i = 1; i < data.length; i++) {
    if (String(data[i][0]) === String(id)) {
      for (const [k, v] of Object.entries(fields)) { const c = hdrs.indexOf(k); if (c >= 0) sheet.getRange(i+1,c+1).setValue(v); }
      SpreadsheetApp.flush(); return { success: true };
    }
  }
  return { error: 'House not found: ' + id };
}

function setResult(id, result, resultBy) {
  const sheet = getSheet('houses');
  const data  = sheet.getDataRange().getValues();
  const hdrs  = data[0];
  for (let i = 1; i < data.length; i++) {
    if (String(data[i][0]) === String(id)) {
      sheet.getRange(i+1, hdrs.indexOf('result')+1).setValue(result);
      sheet.getRange(i+1, hdrs.indexOf('result_date')+1).setValue(new Date().toISOString());
      sheet.getRange(i+1, hdrs.indexOf('result_by')+1).setValue(resultBy||'');
      SpreadsheetApp.flush(); return { success: true };
    }
  }
  return { error: 'House not found: ' + id };
}

function clearResult(id) {
  const sheet = getSheet('houses');
  const data  = sheet.getDataRange().getValues();
  const hdrs  = data[0];
  for (let i = 1; i < data.length; i++) {
    if (String(data[i][0]) === String(id)) {
      sheet.getRange(i+1, hdrs.indexOf('result')+1).setValue('');
      sheet.getRange(i+1, hdrs.indexOf('result_date')+1).setValue('');
      sheet.getRange(i+1, hdrs.indexOf('result_by')+1).setValue('');
      SpreadsheetApp.flush(); return { success: true };
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
      if (String(data[i][0]) === String(id)) { sheet.getRange(i+1, sortCol+1).setValue(idx+1); break; }
    }
  });
  SpreadsheetApp.flush();
  return { success: true };
}

// ─── Clear Turf Houses ────────────────────────────────────────────────────────

function clearTurf(letter) {
  const sheet = getSheet('houses');
  const data  = sheet.getDataRange().getValues();
  const toDelete = [];
  for (let i = 1; i < data.length; i++) {
    if (String(data[i][1]) === String(letter)) toDelete.push(i + 1);
  }
  for (let i = toDelete.length - 1; i >= 0; i--) sheet.deleteRow(toDelete[i]);
  SpreadsheetApp.flush();
  return { success: true, deleted: toDelete.length };
}

// ─── Turf CRUD ────────────────────────────────────────────────────────────────

function addTurf(letter, color, volunteer, mode) {
  const sheet    = getSheet('turfs');
  const existing = sheetToObjects(sheet);
  if (existing.some(t => t.letter === letter)) return { error: 'Turf ' + letter + ' already exists' };
  sheet.appendRow([letter, color||'', volunteer||'[UNASSIGNED]', mode||'hanger', '', new Date().toISOString()]);
  SpreadsheetApp.flush();
  return { success: true };
}

function deleteTurf(letter) {
  // Cascade: delete all houses in this zone first
  const housesSheet = getSheet('houses');
  const hData = housesSheet.getDataRange().getValues();
  // Delete from bottom up to avoid row index shifting
  for (let i = hData.length - 1; i >= 1; i--) {
    if (String(hData[i][1]) === String(letter)) {
      housesSheet.deleteRow(i + 1);
    }
  }
  // Now delete the turf row
  const turfsSheet = getSheet('turfs');
  const tData = turfsSheet.getDataRange().getValues();
  for (let i = 1; i < tData.length; i++) {
    if (String(tData[i][0]) === String(letter)) {
      turfsSheet.deleteRow(i + 1);
      SpreadsheetApp.flush();
      return { success: true };
    }
  }
  SpreadsheetApp.flush();
  return { error: 'Zone not found: ' + letter };
}

function updateTurf(letter, fields) {
  const sheet = getSheet('turfs');
  const data  = sheet.getDataRange().getValues();
  const hdrs  = data[0];
  for (let i = 1; i < data.length; i++) {
    if (data[i][0] === letter) {
      for (const [k, v] of Object.entries(fields)) { const c = hdrs.indexOf(k); if (c >= 0) sheet.getRange(i+1,c+1).setValue(v); }
      SpreadsheetApp.flush(); return { success: true };
    }
  }
  return { error: 'Turf not found: ' + letter };
}

function saveTurfPolygon(letter, geojson) {
  const sheet = getSheet('turfs');
  const data  = sheet.getDataRange().getValues();
  const hdrs  = data[0];
  const col   = hdrs.indexOf('polygon_geojson') + 1;
  for (let i = 1; i < data.length; i++) {
    if (data[i][0] === letter) {
      sheet.getRange(i+1, col).setValue(geojson ? JSON.stringify(geojson) : '');
      SpreadsheetApp.flush(); return { success: true };
    }
  }
  return { error: 'Turf not found: ' + letter };
}

// ─── Bulk Import ──────────────────────────────────────────────────────────────

function bulkImport(turfs) {
  const housesSheet    = getSheet('houses');
  const turfsSheet     = getSheet('turfs');
  const existingTurfs  = sheetToObjects(turfsSheet).map(t => t.letter);
  const existingHouses = sheetToObjects(housesSheet);
  const defaultColors  = ['#e05c4b','#c9831a','#2d9e5f','#2e6ec2','#7c4dcc','#c4487a','#1a9e9e','#c27a1a'];
  let addedTurfs = 0, addedHouses = 0;

  turfs.forEach((turf, ti) => {
    if (!existingTurfs.includes(turf.letter)) {
      turfsSheet.appendRow([turf.letter, turf.color||defaultColors[ti%defaultColors.length],
        turf.volunteer||'[UNASSIGNED]', turf.mode||'hanger',
        turf.polygon_geojson ? JSON.stringify(turf.polygon_geojson) : '', new Date().toISOString()]);
      addedTurfs++;
    }
    const turfHouses    = existingHouses.filter(h => h.turf === turf.letter);
    let maxOrder        = turfHouses.reduce((max, h) => Math.max(max, parseInt(h.sort_order)||0), 0);
    const existingAddrs = new Set(turfHouses.map(h => (h.address||'').toUpperCase().trim()));
    (turf.houses||[]).forEach(house => {
      const addrKey = (house.address||'').toUpperCase().trim();
      if (existingAddrs.has(addrKey)) return;
      existingAddrs.add(addrKey);
      maxOrder++;
      housesSheet.appendRow([uid(), turf.letter, house.owner||'', house.address||'',
        house.lat||0, house.lon||0, house.notes||'', '', '', '', maxOrder]);
      addedHouses++;
    });
  });
  SpreadsheetApp.flush();
  return { success: true, turfs: addedTurfs, houses: addedHouses };
}

// ─── Atomic Zone Creation ─────────────────────────────────────────────────────

function createZone(letter, color, volunteer, geojson, houses) {
  const turfsSheet  = getSheet('turfs');
  const housesSheet = getSheet('houses');

  // Guard: duplicate letter check
  const existing = sheetToObjects(turfsSheet);
  if (existing.some(t => String(t.letter) === String(letter))) {
    return { error: 'Zone ' + letter + ' already exists' };
  }

  try {
    // 1. Write turf row with polygon inline
    const geojsonStr = geojson ? JSON.stringify(geojson) : '';
    turfsSheet.appendRow([
      letter, color || '#6b7280', volunteer || '[UNASSIGNED]',
      'hanger', geojsonStr, new Date().toISOString()
    ]);

    // 2. Write houses
    let order = 0;
    (houses || []).forEach(house => {
      order++;
      housesSheet.appendRow([
        uid(), letter, house.owner || '', house.address || '',
        house.lat || 0, house.lon || 0, '', '', '', '', order
      ]);
    });

    SpreadsheetApp.flush();
    return { success: true, letter, houseCount: (houses || []).length };
  } catch(err) {
    // Attempt rollback: remove the turf row if it was written
    try {
      const tData = turfsSheet.getDataRange().getValues();
      for (let i = tData.length - 1; i >= 1; i--) {
        if (String(tData[i][0]) === String(letter)) { turfsSheet.deleteRow(i + 1); break; }
      }
      // Remove any houses written for this zone
      const hData = housesSheet.getDataRange().getValues();
      for (let i = hData.length - 1; i >= 1; i--) {
        if (String(hData[i][1]) === String(letter)) housesSheet.deleteRow(i + 1);
      }
      SpreadsheetApp.flush();
    } catch(e2) {}
    return { error: 'Zone creation failed: ' + err.toString() };
  }
}

function claimZone(letter, volunteer, color) {
  const sheet = getSheet('turfs');
  const data  = sheet.getDataRange().getValues();
  const hdrs  = data[0];
  const volCol   = hdrs.indexOf('volunteer') + 1;
  const colorCol = hdrs.indexOf('color') + 1;
  for (let i = 1; i < data.length; i++) {
    if (String(data[i][0]) === String(letter)) {
      if (volCol > 0) sheet.getRange(i + 1, volCol).setValue(volunteer || '[UNASSIGNED]');
      if (colorCol > 0 && color) sheet.getRange(i + 1, colorCol).setValue(color);
      SpreadsheetApp.flush();
      return { success: true };
    }
  }
  return { error: 'Zone not found: ' + letter };
}

// ─── Bulk Import Houses Only (for zone creation — turf already exists) ───────

function bulkImportHouses(letter, houses) {
  if (!letter || !houses || !houses.length) return { success: true, added: 0 };
  const housesSheet    = getSheet('houses');
  const existingHouses = sheetToObjects(housesSheet).filter(h => h.turf === letter);
  const existingAddrs  = new Set(existingHouses.map(h => (h.address||'').toUpperCase().trim()));
  let maxOrder = existingHouses.reduce((m, h) => Math.max(m, parseInt(h.sort_order)||0), 0);
  let added = 0;
  houses.forEach(house => {
    const key = (house.address||'').toUpperCase().trim();
    if (existingAddrs.has(key)) return;
    existingAddrs.add(key);
    maxOrder++;
    housesSheet.appendRow([uid(), letter, house.owner||'', house.address||'',
      house.lat||0, house.lon||0, house.notes||'', '', '', '', maxOrder]);
    added++;
  });
  SpreadsheetApp.flush();
  return { success: true, added };
}

// ─── Presence ─────────────────────────────────────────────────────────────────

function heartbeat(name, sessionId) {
  const sheet = getSheet('presence');
  const rows  = sheet.getDataRange().getValues();
  const hdrs  = rows[0];
  const sidCol = hdrs.indexOf('session_id')+1, nameCol = hdrs.indexOf('name')+1, seenCol = hdrs.indexOf('last_seen')+1;
  const now   = new Date().toISOString();
  for (let i = 1; i < rows.length; i++) {
    if (String(rows[i][sidCol-1]) === String(sessionId)) {
      sheet.getRange(i+1,nameCol).setValue(name||'Unknown');
      sheet.getRange(i+1,seenCol).setValue(now);
      SpreadsheetApp.flush(); return { success: true };
    }
  }
  sheet.appendRow([sessionId, name||'Unknown', now]);
  SpreadsheetApp.flush(); return { success: true };
}

function getPresence() {
  const sheet = getSheet('presence');
  if (sheet.getLastRow() < 2) return { users: [] };
  const rows    = sheet.getDataRange().getValues();
  const hdrs    = rows[0];
  const sidCol  = hdrs.indexOf('session_id'), nameCol = hdrs.indexOf('name'), seenCol = hdrs.indexOf('last_seen');
  const cutoff  = Date.now() - 90000;
  const users   = rows.slice(1)
    .filter(r => r[seenCol] && new Date(r[seenCol]).getTime() >= cutoff)
    .map(r => ({ sessionId: String(r[sidCol]), name: r[nameCol]||'Unknown', last_seen: r[seenCol] }));
  return { users };
}

// ─── Login Log ────────────────────────────────────────────────────────────────

function logLogin(name, mode, sessionId) {
  const sheet = getSheet('logins');
  sheet.appendRow([new Date().toISOString(), name||'Unknown', mode||'hanger', sessionId||'']);
  SpreadsheetApp.flush();
  return { success: true };
}

function getLogins() {
  const sheet = getSheet('logins');
  if (sheet.getLastRow() < 2) return { logins: [] };
  const rows = sheet.getDataRange().getValues();
  const hdrs = rows[0];
  return { logins: rows.slice(1).map(r => { const o={}; hdrs.forEach((h,i)=>{ o[h]=r[i]; }); return o; }).filter(r=>r.timestamp) };
}

// ─── Chat ─────────────────────────────────────────────────────────────────────

function sendChat(name, sessionId, message) {
  if (!message || !message.trim()) return { error: 'Empty message' };
  const sheet = getSheet('chat');
  const id = uid(), now = new Date().toISOString();
  sheet.appendRow([id, now, name||'Unknown', sessionId||'', message.trim()]);
  SpreadsheetApp.flush();
  return { success: true, id, timestamp: now };
}

function getChat(since) {
  const sheet = getSheet('chat');
  if (sheet.getLastRow() < 2) return { messages: [] };
  const rows   = sheet.getDataRange().getValues();
  const hdrs   = rows[0];
  const cutoff = since ? new Date(since).getTime() : 0;
  const messages = rows.slice(1)
    .map(r => { const o={}; hdrs.forEach((h,i)=>{ o[h]=r[i]; }); return o; })
    .filter(m => m.id && m.timestamp && (!since || new Date(m.timestamp).getTime() > cutoff))
    .map(m => ({ id:String(m.id), timestamp:String(m.timestamp), name:String(m.name),
                 sessionId:String(m.session_id), message:String(m.message) }));
  return { messages: messages.slice(-200) };
}

// ─── Leaderboard ──────────────────────────────────────────────────────────────

function getLeaderboard() {
  const houses = sheetToObjects(getSheet('houses'));
  // Today in CT
  const ctNow    = new Date(Date.now() + (-6 * 60 * 60000));
  const todayStr = ctNow.toISOString().slice(0, 10);
  const allTime = {}, today = {};

  houses.forEach(h => {
    if (!h.result || !h.result_by || h.result === 'skip') return;
    const by = String(h.result_by).trim();
    if (!by) return;
    if (!allTime[by]) allTime[by] = { name:by, total:0, hangers:0, knocked:0, not_home:0, refused:0, last_active:'' };
    allTime[by].total++;
    if (h.result === 'hanger')   allTime[by].hangers++;
    if (h.result === 'knocked')  allTime[by].knocked++;
    if (h.result === 'not_home') allTime[by].not_home++;
    if (h.result === 'refused')  allTime[by].refused++;
    if (!allTime[by].last_active || String(h.result_date) > allTime[by].last_active)
      allTime[by].last_active = String(h.result_date);
    const day = h.result_date ? String(h.result_date).slice(0,10) : '';
    if (day === todayStr) {
      if (!today[by]) today[by] = { name:by, total:0, hangers:0, knocked:0, not_home:0, refused:0 };
      today[by].total++;
      if (h.result === 'hanger')   today[by].hangers++;
      if (h.result === 'knocked')  today[by].knocked++;
      if (h.result === 'not_home') today[by].not_home++;
      if (h.result === 'refused')  today[by].refused++;
    }
  });
  return {
    allTime: Object.values(allTime).sort((a,b) => b.total - a.total),
    today:   Object.values(today).sort((a,b) => b.total - a.total)
  };
}

// ─── CSV Export ───────────────────────────────────────────────────────────────

// ─── Users ────────────────────────────────────────────────────────────────────

function getUsers() {
  const users = sheetToObjects(getSheet('users'));
  return { users: users.map(u => ({
    email: String(u.email).toLowerCase().trim(),
    name:  String(u.name),
    color: String(u.color),
    created_date: String(u.created_date)
  }))};
}

function getUser(email) {
  if (!email) return { user: null };
  const key = String(email).toLowerCase().trim();
  const users = sheetToObjects(getSheet('users'));
  const found = users.find(u => String(u.email).toLowerCase().trim() === key);
  return { user: found ? {
    email: String(found.email).toLowerCase().trim(),
    name:  String(found.name),
    color: String(found.color),
    created_date: String(found.created_date)
  } : null };
}

function createUser(email, name, color) {
  if (!email || !name) return { error: 'Email and name required' };
  const key   = String(email).toLowerCase().trim();
  const sheet = getSheet('users');
  const existing = sheetToObjects(sheet);
  if (existing.some(u => String(u.email).toLowerCase().trim() === key)) {
    return { error: 'User already exists', existing: true };
  }
  sheet.appendRow([key, name.trim(), color || '#6b7280', new Date().toISOString()]);
  SpreadsheetApp.flush();
  return { success: true, email: key, name: name.trim(), color: color || '#6b7280' };
}

// ─── Zone Backup (before delete) ──────────────────────────────────────────────

function backupZone(letter) {
  if (!letter) return { error: 'No letter provided' };
  const turfsData  = sheetToObjects(getSheet('turfs'));
  const housesData = sheetToObjects(getSheet('houses'));
  const turf  = turfsData.find(t => t.letter === letter);
  if (!turf) return { error: 'Zone not found: ' + letter };
  const houses = housesData.filter(h => h.turf === letter);
  const resultCount = houses.filter(h => h.result && h.result !== '').length;
  const dataJson = JSON.stringify({ turf, houses });
  const sheet = getSheet('deleted_zones');
  sheet.appendRow([
    new Date().toISOString(), letter, turf.volunteer || '',
    houses.length, resultCount, dataJson
  ]);
  SpreadsheetApp.flush();
  return { success: true, houseCount: houses.length, resultCount };
}

function exportCSV() {
  const houses  = sheetToObjects(getSheet('houses'));
  const turfs   = sheetToObjects(getSheet('turfs'));
  const turfMap = {};
  turfs.forEach(t => { turfMap[t.letter] = t; });
  const rows = [['turf','volunteer','mode','address','owner','lat','lon','result','result_by','result_date','notes']];
  houses.forEach(h => {
    const t = turfMap[h.turf] || {};
    rows.push([h.turf||'', t.volunteer||'', t.mode||'hanger', h.address||'', h.owner||'',
               h.lat||'', h.lon||'', h.result||'', h.result_by||'', h.result_date||'', h.notes||'']);
  });
  const csv = rows.map(r => r.map(c => {
    const s = String(c).replace(/"/g,'""');
    return (s.includes(',')||s.includes('"')||s.includes('\n')) ? `"${s}"` : s;
  }).join(',')).join('\n');
  return { success: true, csv };
}
