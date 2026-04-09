// ─── Chaka Door Canvass — Configuration ───
// Paste your Google Apps Script deployment URL below
const CONFIG = {
  SHEETS_API_URL: 'https://script.google.com/macros/s/AKfycbzWPPXdD0Y2nv1wkLrt6pqLJVnBq_DMp7rLW83AZMiSWWyJyqqTJdKxoMe2x3JE816I/exec',
  API_TOKEN: '8j9zZkuX23vRW80-BKoixdRBJQNdcvdGU9ts425VP14',
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
  // Group 1: hanger workflow. Group 2: door knock workflow (divided in legend)
  // Group 3: apartment complex office visit results
  RESULTS: [
    { key: 'hanger',          label: 'Hanger Left',        short: 'HG', icon: '📬', color: '#2d9e5f', bg: '#e6f7ee' },
    { key: 'skip',            label: 'Skip',               short: 'SK', icon: '⤭',  color: '#1f2937', bg: '#f0f1f3' },
    { key: 'knocked',         label: 'Knocked',            short: 'KN', icon: '✊', color: '#2e6ec2', bg: '#e8f0fc' },
    { key: 'not_home',        label: 'Not Home',           short: 'NH', icon: '🚪', color: '#c9831a', bg: '#fdf3e3' },
    { key: 'refused',         label: 'Refused',            short: 'RF', icon: '⛔', color: '#c44848', bg: '#fde8e8' },
    { key: 'left_materials',  label: 'Left at Office',     short: 'LM', icon: '📋', color: '#7c4dcc', bg: '#f3eeff' },
    { key: 'spoke_manager',   label: 'Spoke to Manager',   short: 'SM', icon: '🤝', color: '#1a9e9e', bg: '#e6f7f7' },
    { key: 'no_answer_office',label: 'No Answer — Office', short: 'NA', icon: '🏢', color: '#c9831a', bg: '#fdf3e3' },
    { key: 'knocked_building',label: 'Door Knocked Bldg',  short: 'KB', icon: '🚪', color: '#2e6ec2', bg: '#e8f0fc' },
  ],

  // Apartment complex result keys — shown instead of standard buttons for complex markers
  COMPLEX_RESULTS: ['left_materials', 'spoke_manager', 'knocked_building', 'no_answer_office', 'skip'],

  // Pre-defined apartment complex data for Zone 21 area (SE corner Parkway Blvd / N Moore Rd)
  // Building counts are estimates from property research — admin should adjust as needed
  COMPLEX_PRESETS: [
    {
      name: 'Townlake of Coppell',
      address: '215 N Moore Rd',
      totalUnits: 398,
      stories: 2,
      buildingCount: 20,
      unitsPerBuilding: 20, // 398 / 20 ≈ 20
      lat: 32.9630,
      lon: -96.9795,
    },
    {
      name: 'Town Creek',
      address: '190 N Moore Rd',
      totalUnits: 192,
      stories: 2,
      buildingCount: 12,
      unitsPerBuilding: 16, // 192 / 12 = 16
      lat: 32.9645,
      lon: -96.9790,
    },
  ],

  // Legend grouping: keys before divider = group 1, after = group 2
  LEGEND_DIVIDER_AFTER: 'skip',

  // Talking points shown in house popup — update with your actual script
  CANVASS_SCRIPT: `Hi, I'm a neighbor volunteering for Kevin Chaka, who's running for Coppell ISD Place 5 School Board. We're focused on keeping our schools excellent and fiscally responsible. Do you have a moment to hear more?`,

  REFRESH_INTERVAL: 15000,
  PRESENCE_TIMEOUT: 120000,
};
