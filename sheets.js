// ─── Sheets API ───────────────────────────────────────────────────────────────

const SheetsAPI = {
  async _call(payload) {
    const encoded = encodeURIComponent(JSON.stringify(payload));
    const url = CONFIG.SHEETS_API_URL + '?payload=' + encoded;
    const resp = await fetch(url, { mode: 'cors', cache: 'no-store' });
    return resp.json();
  },

  getAll()                              { return this._call({ action: 'getAll' }); },
  addHouse(house)                       { return this._call({ action: 'addHouse', house }); },
  removeHouse(id)                       { return this._call({ action: 'removeHouse', id }); },
  updateHouse(id, fields)               { return this._call({ action: 'updateHouse', id, fields }); },
  setResult(id, result, result_by)      { return this._call({ action: 'setResult', id, result, result_by }); },
  clearResult(id)                       { return this._call({ action: 'clearResult', id }); },
  addTurf(letter, color, volunteer, mode) { return this._call({ action: 'addTurf', letter, color, volunteer, mode }); },
  deleteTurf(letter)                    { return this._call({ action: 'deleteTurf', letter }); },
  updateTurf(letter, fields)            { return this._call({ action: 'updateTurf', letter, fields }); },
  saveTurfPolygon(letter, geojson)      { return this._call({ action: 'saveTurfPolygon', letter, geojson }); },
  reorderHouses(turf, order)            { return this._call({ action: 'reorderHouses', turf, order }); },
  bulkImport(turfs)                     { return this._call({ action: 'bulkImport', turfs }); },
  heartbeat(name, sessionId)            { return this._call({ action: 'heartbeat', name, sessionId }); },
  getPresence()                         { return this._call({ action: 'getPresence' }); },
  sendChat(name, sessionId, message)    { return this._call({ action: 'sendChat', name, sessionId, message }); },
  getChat(since)                        { return this._call({ action: 'getChat', since: since || 0 }); },
  logLogin(name, sessionId, mode)       { return this._call({ action: 'logLogin', name, sessionId, mode }); },
  getUsers()                            { return this._call({ action: 'getUsers' }); },
  createUser(email, name, color)        { return this._call({ action: 'createUser', email, name, color }); },
  getUser(email)                        { return this._call({ action: 'getUser', email }); },
  backupZone(letter)                    { return this._call({ action: 'backupZone', letter }); },
  bulkImportHouses(letter, houses)      { return this._call({ action: 'bulkImportHouses', letter, houses }); },
  createZone(letter, color, volunteer, geojson, houses) { return this._call({ action: 'createZone', letter, color, volunteer, geojson, houses }); },
  claimZone(letter, volunteer, color)   { return this._call({ action: 'claimZone', letter, volunteer, color }); },
};
