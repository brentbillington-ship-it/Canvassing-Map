# Apps Script Deployment

## Script ID
`1c-Soph2Lgi3CP5l8b5It-lF17O7y2uDwUgOEUC7nQIH-t0cz_q9wl1gj`

## Deployment URL (stable)
The web app URL in `config.js` (`SHEETS_API_URL`) is a stable versioned deployment.
Do NOT create a new deployment — always update the existing one.

## Workflow: Editing Apps Script

All Apps Script changes go through the repo. Never paste code into the browser editor.

```bash
# 1. Edit apps_script.js in the repo
# 2. Push to Google Apps Script
npm run gas:push        # or: npx @google/clasp push

# 3. Deploy a new version under the same stable URL
npm run gas:deploy      # or: npx @google/clasp deploy --deploymentId <ID>
```

## First-time CLASP Setup

```bash
# Install CLASP (if not using npx)
npm install -D @google/clasp

# Login — opens browser for Google OAuth
npx @google/clasp login

# Verify connection
npx @google/clasp pull   # should pull the live script
```

## Files Pushed to Apps Script
Controlled by `.claspignore` — only `apps_script.js` and `appsscript.json` are pushed.

## Security
- `.clasprc.json` contains OAuth tokens and is in `.gitignore` — never commit it.
- The `API_TOKEN` in `config.js` authenticates client requests to the Apps Script web app.
