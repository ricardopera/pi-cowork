# @pi-cowork/desktop

Native desktop shell (Electron) that wraps the Pi-Cowork web app — matching
Claude Cowork's desktop-app model.

## Architecture

The Electron **main process** (`main.js`):
1. Spawns the existing Node server (`server/dist/index.js`) as a child process
   on port 5174.
2. Polls `GET /api/health` until the server is ready.
3. Opens a native `BrowserWindow` that loads the served web app (the server
   serves `web/dist` in production).
4. Handles lifecycle: external links open in the user's browser; the server is
   cleaned up on quit.

This wraps the **unchanged** web UI in native window chrome — no fork of the
server or frontend code.

## Run

From the repo root:

```bash
# build the server + web, then launch the desktop shell
npm run build:desktop
npm run desktop
```

Or directly: `npm -w @pi-cowork/desktop run start` (after building).

## Environment

- `PORT` — server port (default 5174)
- `NODE_ENV=production` is set automatically so the server serves the built web app
