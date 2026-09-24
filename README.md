# DocuFast Agent — Desktop App

A Windows system-tray application that runs silently in the background, polls the DocuFast India cloud for paid print jobs, and sends them to the connected printer automatically. No terminal window — installs and runs like any other Windows app.

## What it does

- Runs silently on Windows startup (system tray icon near the clock)
- Right-click the tray icon for quick status (connected, jobs today, pending)
- Double-click to open the full dashboard
- Dashboard shows all print jobs with timestamps, revenue, printer status
- Settings page to change cloud URL, API key, printer, SumatraPDF path

## Prerequisites on the build machine (your laptop)

1. **Node.js** (v18+) — https://nodejs.org
2. **Git** — https://git-scm.com
3. **Windows Build Tools** (for native modules):
   ```
   npm install -g windows-build-tools
   ```

## Build the .exe installer

```
cd docufast-desktop
npm install
npm run build:installer
```

The installer appears at:
```
dist\DocuFast Agent Setup 1.0.0.exe
```

That single `.exe` is what you give to each shop. Double-click installs it silently and the app starts immediately.

## What happens when a shop installs it

1. First run opens a 3-step setup wizard:
   - Enter the cloud URL (`https://docufast-nu.vercel.app`)
   - Enter their shop API key (you generate this in the owner dashboard)
   - Set SumatraPDF path and optional printer name
2. App installs to `C:\Users\...\AppData\Local\DocuFast Agent\`
3. Registers itself to auto-start with Windows
4. Minimises to system tray, starts polling immediately

## Development (run without building)

```
npm install
npm start
```

To see DevTools (for debugging the dashboard):
```
npm run dev
```

## Giving each shop their key

1. Go to `https://docufast-nu.vercel.app/owner`
2. Enter your owner key → click **+ Add shop**
3. Fill in the shop name and slug → **Create shop**
4. Copy the API key shown (only shown once)
5. Send the shop owner: the `.exe` installer + their API key

## Updating the app

Change the version in `package.json`, then:
```
npm run build:installer
```
Send the new `.exe` to shops — they run it over the existing install and it upgrades automatically.

## Folder structure

```
docufast-desktop/
  src/
    main.js       — Electron main process (tray, agent loop, IPC)
    preload.js    — Secure bridge between renderer and main
  dashboard/
    index.html    — Main dashboard window
    setup.html    — First-run setup wizard
    app.js        — Dashboard renderer logic
    styles.css    — DocuFast navy/gold styles
  assets/
    icon.ico      — App icon (installer + taskbar)
    logo.png      — DocuFast India logo (dashboard)
    tray-icon.png — 16×16 tray icon
  package.json    — Dependencies + electron-builder config
```
