import path from "node:path";
import { AuthStorage, ModelRegistry } from "@earendil-works/pi-coding-agent";
import type { Model } from "@earendil-works/pi-ai";
import { config } from "../config.js";
import type { ProviderInfo, ModelInfo } from "../event-schema.js";

// The four providers the objective calls out, with display metadata.
export const OUR_PROVIDERS: { id: string; name: string; envVar: string }[] = [
  { id: "openrouter", name: "OpenRouter", envVar: "OPENROUTER_API_KEY" },
  { id: "zai", name: "Z.ai Coding Plan", envVar: "ZAI_API_KEY" },
  { id: "minimax", name: "Minimax Token Plan", envVar: "MINIMAX_API_KEY" },
  { id: "opencode", name: "Opencode Zen", envVar: "OPENCODE_API_KEY" },
];

let authStorage: AuthStorage;
let modelRegistry: ModelRegistry;

export function initAuthStorage(): void {
  authStorage = AuthStorage.create(path.join(config.agentDir, "auth.json"));
  modelRegistry = ModelRegistry.create(authStorage);
}

// For tests: in-memory so nothing touches disk.
export function reinitAuthStorageInMemory(): void {
  authStorage = AuthStorage.inMemory();
  modelRegistry = ModelRegistry.inMemory(authStorage);
}

export function getAuthStorage(): AuthStorage {
  return authStorage;
}

export function getModelRegistry(): ModelRegistry {
  return modelRegistry;
}

// Seed runtime keys from environment on startup.
export function seedFromEnv(): void {
  for (const p of OUR_PROVIDERS) {
    const val = process.env[p.envVar];
    if (val) authStorage.setRuntimeApiKey(p.id, val);
  }
}

export async function listProviders(): Promise<ProviderInfo[]> {
  return Promise.all(
    OUR_PROVIDERS.map(async (p) => ({
      id: p.id,
      name: p.name,
      envVar: p.envVar,
      hasKey: (await authStorage.getApiKey(p.id)) != null,
    })),
  );
}

export async function setApiKey(providerId: string, key: string): Promise<void> {
  authStorage.setRuntimeApiKey(providerId, key.trim());
}

export function clearApiKey(providerId: string): void {
  // Clear both the persisted auth.json entry and the in-memory runtime override,
  // since setApiKey uses setRuntimeApiKey (non-persisted) and remove() only
  // touches the persisted store.
  authStorage.remove(providerId);
  authStorage.removeRuntimeApiKey(providerId);
}

// NOTE: uses getAll() (full catalog) not getAvailable() (auth-filtered), so the
// settings UI can list models before a key is entered.
export function listModels(providerId: string): ModelInfo[] {
  return modelRegistry
    .getAll()
    .filter((m) => m.provider === providerId)
    .map((m) => ({
      id: m.id,
      name: m.name,
      provider: m.provider,
      reasoning: !!m.reasoning,
      contextWindow: m.contextWindow,
    }));
}

export function resolveModel(providerId: string, modelId: string): Model<any> | undefined {
  return modelRegistry.find(providerId, modelId);
}
