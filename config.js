// ─── Chaka Door Canvass — Configuration ───
// Paste your Google Apps Script deployment URL below
const CONFIG = {
  SHEETS_API_URL: 'https://script.google.com/macros/s/AKfycbzWPPXdD0Y2nv1wkLrt6pqLJVnBq_DMp7rLW83AZMiSWWyJyqqTJdKxoMe2x3JE816I/exec',
  ADMIN_PASSWORD: 'choochoo',
  APP_NAME: 'Chaka Door Canvass',
  CANDIDATE: 'Kevin Chaka',
  RACE: 'Coppell ISD Place 5',
  DEFAULT_CITY: 'Coppell, TX 75019',
  MAP_CENTER: [32.972, -96.978],
  MAP_ZOOM: 15,

  // Colors for turf zones — used for polygon fills and sidebar headers
  TURF_COLORS: [
    '#e05c4b', '#c9831a', '#2d9e5f', '#2e6ec2',
    '#7c4dcc', '#c4487a', '#1a9e9e', '#c27a1a',
    '#4d8c2f', '#4a7abf', '#c44848', '#6b5ea8'
  ],

  // Contact result definitions — drives markers, buttons, legend, and stats
  RESULTS: [
    { key: 'knocked',  label: 'Knocked',     short: 'KN', icon: '✊', color: '#2d9e5f', bg: '#e6f7ee' },
    { key: 'hanger',   label: 'Hanger Left', short: 'HG', icon: '📎', color: '#2e6ec2', bg: '#e8f0fc' },
    { key: 'not_home', label: 'Not Home',     short: 'NH', icon: '🚪', color: '#c9831a', bg: '#fdf3e3' },
    { key: 'refused',  label: 'Refused',      short: 'RF', icon: '⛔', color: '#c44848', bg: '#fde8e8' },
    { key: 'skip',     label: 'Skip',         short: 'SK', icon: '⤭',  color: '#1f2937', bg: '#f0f1f3' },
  ],

  REFRESH_INTERVAL: 15000,
  PRESENCE_TIMEOUT: 90000,
};
