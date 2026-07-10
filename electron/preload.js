// Preload runs in an isolated context with access to a subset of Node/Electron
// APIs. Pi-Cowork's web app is fully self-contained (talks to the local server
// over HTTP/WS), so the desktop shell exposes only a minimal, safe surface.
const { contextBridge } = require("electron");

contextBridge.exposeInMainWorld("piCoworkDesktop", {
  isDesktop: true,
  version: process.env.npm_package_version || "0.1.0",
});
