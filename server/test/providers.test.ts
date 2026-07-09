import { describe, it, expect } from "vitest";
import {
  OUR_PROVIDERS,
  listProviders,
  setApiKey,
  listModels,
  reinitAuthStorageInMemory,
} from "../src/pi/providers.js";

describe("providers", () => {
  it("exposes the four target providers", () => {
    const ids = OUR_PROVIDERS.map((p) => p.id);
    expect(ids).toEqual(
      expect.arrayContaining(["openrouter", "zai", "minimax", "opencode"]),
    );
  });

  it("reports hasKey=false when no key set", async () => {
    reinitAuthStorageInMemory();
    const providers = await listProviders();
    for (const p of providers) expect(p.hasKey).toBe(false);
  });

  it("stores and reflects a runtime key", async () => {
    reinitAuthStorageInMemory();
    await setApiKey("zai", "test-key");
    const providers = await listProviders();
    const zai = providers.find((p) => p.id === "zai");
    expect(zai?.hasKey).toBe(true);
  });

  it("lists the known model catalogs for each provider", () => {
    reinitAuthStorageInMemory();
    for (const p of OUR_PROVIDERS) {
      const models = listModels(p.id);
      expect(models.length, `${p.id} should have models`).toBeGreaterThan(0);
    }
  });

  it("clears a key", async () => {
    reinitAuthStorageInMemory();
    await setApiKey("minimax", "k");
    const { clearApiKey } = await import("../src/pi/providers.js");
    clearApiKey("minimax");
    const providers = await listProviders();
    expect(providers.find((p) => p.id === "minimax")?.hasKey).toBe(false);
  });
});
