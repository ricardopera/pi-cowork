// Build the server to dist/ using esbuild. Bundles local src (with .ts -> .js)
// while keeping node_modules external (they resolve at runtime via Node ESM).
// This mirrors what dev (tsx) tolerates for the JSON-schema tool params without
// forcing TypeBox types. Type-checking stays available via `npm -w server run check`.
import esbuild from "esbuild";
import { rm, mkdir } from "node:fs/promises";

await rm("dist", { recursive: true, force: true });
await mkdir("dist", { recursive: true });

// Bundle everything (local + the imports it needs), marking node built-ins and
// our workspace deps external so native/ESM packages resolve from node_modules.
const result = await esbuild.build({
  entryPoints: ["src/index.ts"],
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node20",
  outfile: "dist/index.js",
  packages: "external", // keep ALL node_modules external (native deps, ESM)
  sourcemap: false,
  logLevel: "info",
  // Allow importing .ts that the source references as .js (ESM convention).
  resolveExtensions: [".ts", ".js", ".json"],
});
console.log("server bundled to dist/index.js");
