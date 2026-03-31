# Chaka Door Canvass — Setup Guide

## Overview
A collaborative door-knocking and hanger-drop tracker built on GitHub Pages + Google Sheets.
Volunteers see a live map of houses with color-coded contact outcomes.
Admins can draw turf boundaries, manage volunteers, and add/import houses.

---

## Step 1 — Google Sheets Backend

1. Go to [sheets.google.com](https://sheets.google.com) and create a **new spreadsheet**.
2. Open **Extensions → Apps Script**.
3. Delete any existing code and paste the entire contents of `apps_script.js`.
4. Click **Deploy → New deployment**:
   - Type: **Web app**
   - Execute as: **Me**
   - Who has access: **Anyone**
5. Click **Deploy**, authorize when prompted, and copy the deployment URL.

---

## Step 2 — Configure the App

Open `config.js` and update:

```js
SHEETS_API_URL: 'https://script.google.com/macros/s/YOUR_ID_HERE/exec',
ADMIN_PASSWORD: 'your-password-here',
APP_NAME:       'Chaka Door Canvass',
CANDIDATE:      'Kevin Chaka',
RACE:           'Coppell ISD Place 5',
MAP_CENTER:     [32.972, -96.978],   // lat/lon of your campaign area
MAP_ZOOM:       15,
```

---

## Step 3 — GitHub Pages

1. Create a new GitHub repo (or use an existing one).
2. Upload all files: `index.html`, `config.js`, `style.css`, `sheets.js`, `map.js`, `turf_draw.js`, `ui.js`, `app.js`.
3. Go to **Settings → Pages → Source: Deploy from branch → main / root**.
4. Your app will be live at `https://YOUR_USERNAME.github.io/YOUR_REPO/`.

---

## Step 4 — Adding Turfs & Houses

### Option A — Admin UI (recommended for small data sets)
1. Log in with the admin password.
2. Click **＋ Turf** to create turf zones (A, B, C…) and assign volunteers.
3. Click **✏️ Draw Turfs** to enter drawing mode, then draw a polygon on the map for each turf.
4. Click **＋ House** to add individual houses with address and lat/lon.
   - Get lat/lon by right-clicking any location in Google Maps → "What's here?"

### Option B — Bulk Import (recommended for 20+ houses)
Prepare a JSON array and paste it into **⬆ Import**:

```json
[
  {
    "letter": "A",
    "volunteer": "Alice Smith",
    "color": "#e05c4b",
    "houses": [
      { "address": "100 Main St, Coppell TX", "name": "Johnson", "lat": 32.972, "lon": -96.978 },
      { "address": "102 Main St, Coppell TX", "lat": 32.973, "lon": -96.979 }
    ]
  },
  {
    "letter": "B",
    "volunteer": "Bob Jones",
    "color": "#2d9e5f",
    "houses": [...]
  }
]
```

**Getting lat/lon in bulk:** Export your voter file to a spreadsheet and use a geocoder like:
- [geocod.io](https://geocod.io) — free tier covers ~2,500 addresses
- Google Sheets `=GOOGLEMAPS()` macro with Maps API
- Copy/paste into `GEOCODE()` in a spreadsheet with IMPORTXML

---

## Step 5 — Volunteer Instructions

Send volunteers to the GitHub Pages URL. They:
1. Enter their name and tap **Enter**.
2. Tap their turf letter in the sidebar to filter their area.
3. Walk to each house and tap the map marker or the house card.
4. Tap the result button: **Knocked** ✊, **Hanger Left** 📎, **Not Home** 🚪, **Refused** ⛔, or **Skip** ⤭.
5. Optionally add notes using the chips or free text.

---

## Updating Apps Script

⚠️ Every time you change `apps_script.js`:
1. Save (Ctrl+S)
2. Deploy → Manage deployments
3. Click the ✏️ pencil on your existing deployment
4. Version → "New version"
5. Click Deploy

Same URL — no `config.js` change needed.

---

## Contact Result Legend

| Icon | Key | Meaning |
|------|-----|---------|
| ✊ | `knocked` | Door knocked, resident answered |
| 📎 | `hanger`  | Door hanger left (not home or busy) |
| 🚪 | `not_home`| No answer, no hanger left |
| ⛔ | `refused` | Refused to talk / hostile |
| ⤭  | `skip`    | Wrong address or inaccessible |
