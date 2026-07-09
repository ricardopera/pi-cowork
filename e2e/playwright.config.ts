import { defineConfig } from "@playwright/test";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const root = path.resolve(__dirname, "..");

export default defineConfig({
  testDir: ".",
  use: { baseURL: "http://localhost:5174" },
  webServer: {
    cwd: root,
    command: "npm -w server run dev",
    port: 5174,
    timeout: 60_000,
    reuseExistingServer: !process.env.CI,
  },
  projects: [{ name: "chromium", use: { browserName: "chromium" } }],
});
