// Pi-Cowork desktop shell (Electron main process).
//
// Architecture: the main process spawns the existing Node server (server/dist)
// as a child, waits for it to listen, then opens a native BrowserWindow that
// loads the built web app (web/dist). This wraps the web UI in native window
// chrome — matching Claude Cowork's desktop-app model — without forking the
// server or UI code.
//
// Run with: npm run build:desktop && npm -w @pi-cowork/desktop run start
// (or `npm run desktop` from the root, which builds then starts.)

const { app, BrowserWindow, shell } = require("electron");
const path = require("node:path");
const { spawn, execSync } = require("node:child_process");
const http = require("node:http");
const fs = require("node:fs");

/** Resolve the real Node binary (NOT Electron's bundled runtime). */
function resolveNode() {
  if (process.env.NODE_BINARY && fs.existsSync(process.env.NODE_BINARY)) return process.env.NODE_BINARY;
  // `which node` — most reliable across platforms.
  try {
    const found = execSync("which node 2>/dev/null || command -v node", { stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
    if (found && fs.existsSync(found)) return found;
  } catch {
    /* ignore */
  }
  // Fallback: assume `node` is on PATH (spawn resolves it).
  return "node";
}

const ROOT = path.resolve(__dirname, "..");
const SERVER_DIST = path.join(ROOT, "server", "dist");
const SERVER_INDEX = path.join(SERVER_DIST, "index.js");
const WEB_DIST = path.join(ROOT, "web", "dist");
const PORT = Number(process.env.PORT) || 5174;

let serverProcess = null;
let mainWindow = null;

function log(msg) {
  // Electron main has no console in some contexts; write to stdout.
  process.stdout.write(`[pi-cowork:desktop] ${msg}\n`);
}

/** Wait until the server responds on PORT (poll /api/health). */
function waitForServer(timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const tick = () => {
      const req = http.get(
        { host: "127.0.0.1", port: PORT, path: "/api/health", timeout: 1000 },
        (res) => {
          res.resume();
          if (res.statusCode === 200) resolve();
          else retry();
        },
      );
      req.on("error", retry);
      req.on("timeout", () => {
        req.destroy();
        retry();
      });
    };
    const retry = () => {
      if (Date.now() > deadline) reject(new Error("server did not start in time"));
      else setTimeout(tick, 400);
    };
    tick();
  });
}

function startServer() {
  if (!fs.existsSync(SERVER_INDEX)) {
    throw new Error(
      `Server not built: ${SERVER_INDEX} missing. Run "npm run build:desktop" first.`,
    );
  }
  // IMPORTANT: run the server under the real Node binary, NOT Electron's bundled
  // runtime. Inside Electron, process.execPath is the Electron binary; spawning
  // the server with it would load the server under Electron's older Node, which
  // breaks undici (markAsUncloneable) and other modern APIs.
  const nodeBin = resolveNode();
  serverProcess = spawn(nodeBin, [SERVER_INDEX], {
    cwd: path.join(ROOT, "server"),
    env: { ...process.env, PORT: String(PORT), NODE_ENV: "production" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  serverProcess.stdout.on("data", (d) => log(`server: ${d.toString().trim()}`));
  serverProcess.stderr.on("data", (d) => log(`server err: ${d.toString().trim()}`));
  serverProcess.on("exit", (code) => log(`server exited (${code})`));
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: "#0f1115",
    title: "Pi-Cowork",
    autoHideMenuBar: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  // In packaged/desktop mode, serve the built web app from the running server
  // (the server serves web/dist in production). Fall back to loading the file
  // directly if the server isn't reachable.
  const serverUrl = `http://127.0.0.1:${PORT}/`;
  mainWindow.loadURL(serverUrl).catch(async () => {
    const fileIndex = path.join(WEB_DIST, "index.html");
    if (fs.existsSync(fileIndex)) {
      await mainWindow.loadFile(fileIndex);
    } else {
      mainWindow.loadURL("data:text/html,<h1>Pi-Cowork</h1><p>Build the app first: npm run build:desktop</p>");
    }
  });

  // Open external links in the user's browser, not inside the app window.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("http")) {
      shell.openExternal(url);
      return { action: "deny" };
    }
    return { action: "allow" };
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

app.whenReady().then(async () => {
  try {
    startServer();
    await waitForServer();
  } catch (e) {
    log(`Server start failed: ${e.message}. Continuing without server (file mode).`);
  }
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

// Quit when all windows are closed (except on macOS).
app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

// Clean up the server child process on exit.
const cleanup = () => {
  if (serverProcess && !serverProcess.killed) {
    try {
      serverProcess.kill("SIGTERM");
    } catch {
      /* ignore */
    }
  }
};
app.on("before-quit", cleanup);
process.on("exit", cleanup);
process.on("SIGINT", () => {
  cleanup();
  app.quit();
});
process.on("SIGTERM", () => {
  cleanup();
  app.quit();
});
