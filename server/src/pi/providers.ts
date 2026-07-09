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

/**
 * Register OpenCode Zen's KEYLESS free models as a custom provider. Zen's `-free`
 * models accept requests with NO Authorization header — but the pi-ai openai-completions
 * path uses the OpenAI SDK, which always attaches a Bearer header from apiKey, causing
 * Zen to 401. To bypass this entirely, we supply a custom `streamSimple` that calls
 * Zen's SSE endpoint directly via fetch (no auth header) and emits the proper
 * AssistantMessageEvent protocol. This is the only zero-config (no API key) inference
 * path among our providers, enabling out-of-the-box chat without credentials.
 */
export function registerKeylessZenProvider(): void {
  const FREE_MODELS = [
    "deepseek-v4-flash-free",
    "mimo-v2.5-free",
    "hy3-free",
    "nemotron-3-ultra-free",
    "north-mini-code-free",
  ];
  const ZEN_BASE = "https://opencode.ai/zen/v1";

  modelRegistry.registerProvider("zenfree", {
    name: "OpenCode Zen (Free, no key)",
    baseUrl: ZEN_BASE,
    // A UNIQUE api value so registerApiProvider registers our custom streamer as
    // its own handler, not overriding (or being overridden by) the built-in
    // openai-completions path that would attach an Authorization header.
    api: "zen-keyless" as any,
    apiKey: "unused", // only satisfies validation; streamZen bypasses auth entirely.
    streamSimple: (model: any, context: any, options?: any) => streamZen(model, context, options),
    models: FREE_MODELS.map((id) => ({
      id,
      name: id,
      api: "zen-keyless" as any,
      baseUrl: ZEN_BASE,
      reasoning: false,
      input: ["text" as const],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 131072,
      maxTokens: 8192,
      compat: { supportsStore: false, supportsDeveloperRole: false, maxTokensField: "max_tokens" },
    })),
  });
}

// Eagerly load the event-stream factory so streamZen can create a stream
// synchronously (pi-ai calls streamSimple and expects an event stream back).
// Import from the public compat entry (the internal utils path isn't exported).
let createEventStreamFn: ((...a: any[]) => any) | null = null;
const eventStreamReady = import("@earendil-works/pi-ai/compat").then(
  (m) => {
    createEventStreamFn = (m as any).createAssistantMessageEventStream;
  },
  () => {
    /* ignore; streamZen will error if used before loaded */
  },
);

// Custom SSE streamer for Zen's keyless free models. Emits the same
// AssistantMessageEvent protocol pi-ai's built-in streamers do, so the agent
// loop and our event mapping work unchanged.
function streamZen(model: Model<any>, context: any, options?: any): any {
  if (!createEventStreamFn) {
    // Event-stream module not loaded yet; return a stream that errors. This is
    // unreachable in practice because registerKeylessZenProvider runs at startup
    // and the import resolves before any prompt.
    throw new Error("event-stream module not yet loaded");
  }
  const stream = createEventStreamFn!();

  const messages = (context.messages ?? []).map((m: any) => ({
    role: m.role === "toolResult" ? "tool" : m.role,
    content: typeof m.content === "string" ? m.content : (m.content ?? []),
  }));
  if (context.systemPrompt) {
    messages.unshift({ role: "system", content: context.systemPrompt });
  }

  const body = JSON.stringify({
    model: model.id,
    messages,
    max_tokens: options?.maxTokens ?? 4096,
    temperature: options?.temperature,
    stream: true,
  });

  (async () => {
    let partial = {
      role: "assistant" as const,
      content: [] as any[],
      api: "zen-keyless",
      provider: model.provider,
      model: model.id,
      usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, totalTokens: 0, cost: { input: 0, output: 0, total: 0 } },
      stopReason: "stop" as const,
      timestamp: Date.now(),
    };
    let textBuf = "";
    let started = false;
    try {
      const res = await fetch(`${model.baseUrl}/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" }, // NO Authorization header
        body,
        signal: options?.signal,
      });
      if (!res.ok || !res.body) {
        const errText = await res.text().catch(() => "");
        stream.push({
          type: "error",
          reason: "error",
          error: { ...partial, stopReason: "error", errorMessage: `Zen ${res.status}: ${errText.slice(0, 200)}` },
        });
        (stream as any).end?.();
        return;
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let sseBuf = "";
      let finishReason: string | null = null;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        sseBuf += decoder.decode(value, { stream: true });
        const lines = sseBuf.split("\n");
        sseBuf = lines.pop() ?? "";
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith("data:")) continue;
          const data = trimmed.slice(5).trim();
          if (data === "[DONE]") continue;
          let chunk: any;
          try {
            chunk = JSON.parse(data);
          } catch {
            continue;
          }
          const choice = chunk.choices?.[0];
          const delta = choice?.delta;
          if (delta?.content) {
            if (!started) {
              started = true;
              partial = { ...partial, content: [{ type: "text", text: "" }] };
              stream.push({ type: "start", partial });
              stream.push({ type: "text_start", contentIndex: 0, partial });
            }
            textBuf += delta.content;
            partial.content[0].text = textBuf;
            stream.push({ type: "text_delta", contentIndex: 0, delta: delta.content, partial });
          }
          if (choice?.finish_reason) finishReason = choice.finish_reason;
          if (chunk.usage) {
            partial.usage.inputTokens = chunk.usage.prompt_tokens ?? 0;
            partial.usage.outputTokens = chunk.usage.completion_tokens ?? 0;
            partial.usage.totalTokens = chunk.usage.total_tokens ?? 0;
          }
        }
      }
      if (started) {
        stream.push({ type: "text_end", contentIndex: 0, content: textBuf, partial });
        const reason: "stop" | "length" | "toolUse" =
          finishReason === "length" ? "length" : "stop";
        stream.push({ type: "done", reason, message: { ...partial, stopReason: reason } });
      } else {
        // No content streamed; emit a minimal done so the agent loop completes.
        stream.push({
          type: "done",
          reason: "stop",
          message: { ...partial, content: [{ type: "text", text: "" }] },
        });
      }
    } catch (e: any) {
      stream.push({
        type: "error",
        reason: "error",
        error: { ...partial, stopReason: "error", errorMessage: e?.message ?? String(e) },
      });
    }
    (stream as any).end?.();
  })();

  return stream;
}

/** Resolve the default model: prefer the keyless Zen free model so chat works
 *  out-of-the-box without an API key. */
export function defaultModel(): Model<any> | undefined {
  return modelRegistry.find("zenfree", "deepseek-v4-flash-free");
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
