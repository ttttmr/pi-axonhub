import { type Api } from "@earendil-works/pi-ai";
import { getAgentDir, type ExtensionAPI, type ProviderModelConfig } from "@earendil-works/pi-coding-agent";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const PROVIDER_ID = "axonhub";
const DEFAULT_BASE_URL = "http://localhost:8090";
const AXONHUB_CACHE_FILE = join(homedir(), ".cache", "pi", "axonhub-models.json");

type PluginOptions = {
  baseUrl?: string;
  apiKey?: string;
};

type AxonHubModel = {
  id?: string;
  name?: string;
  display_name?: string;
  created?: number;
  created_at?: string;
  owned_by?: string;
  context_length?: number;
  max_output_tokens?: number;
  capabilities?: {
    vision?: boolean;
    tool_call?: boolean;
    toolCall?: boolean;
    reasoning?: boolean;
  };
  pricing?: {
    input?: number;
    output?: number;
    cache_read?: number;
    cacheRead?: number;
    cache_write?: number;
    cacheWrite?: number;
  };
};

type AxonHubModelsResponse = {
  data?: AxonHubModel[];
};

type AxonHubModelConfig = ProviderModelConfig;

function normalizeBaseUrl(baseUrl: string) {
  return baseUrl.replace(/\/v1\/?$/, "").replace(/\/+$/, "");
}

function resolveOption(value: string | undefined) {
  if (!value) return;
  return process.env[value] || value;
}

function resolveBaseUrl(options?: PluginOptions) {
  return normalizeBaseUrl(options?.baseUrl ?? process.env.AXONHUB_BASE_URL ?? DEFAULT_BASE_URL);
}

function resolveApiKey(options?: PluginOptions) {
  return resolveOption(options?.apiKey) ?? process.env.AXONHUB_API_KEY;
}

async function readPiAuthApiKey() {
  try {
    const payload = JSON.parse(await readFile(join(getAgentDir(), "auth.json"), "utf8")) as Record<
      string,
      { type?: string; key?: string }
    >;
    const auth = payload[PROVIDER_ID];
    if (auth?.type === "api_key" && typeof auth.key === "string" && auth.key.length > 0) return auth.key;
  } catch {
    return;
  }
}


async function readCache<T>(file: string) {
  try {
    return JSON.parse(await readFile(file, "utf8")) as T;
  } catch {
    return;
  }
}

async function writeCache(file: string, payload: unknown) {
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(payload, null, 2));
}

async function fetchModels(baseUrl: string, key: string): Promise<AxonHubModelsResponse> {
  const response = await fetch(`${baseUrl}/v1/models?include=all`, {
    headers: { Authorization: `Bearer ${key}` },
    signal: AbortSignal.timeout(5000),
  });
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
  const payload = (await response.json()) as AxonHubModelsResponse;
  return { data: Array.isArray(payload.data) ? payload.data.filter((m) => m.id) : [] };
}


const OWNER_BY_PROVIDER_ID: Record<string, "anthropic" | "gemini" | "openai"> = {
  anthropic: "anthropic",
  gemini: "gemini",
  google: "gemini",
  openai: "openai",
};

function normalizeOwner(owner?: string) {
  return owner ? OWNER_BY_PROVIDER_ID[owner] : undefined;
}

function ownerFromItem(item: AxonHubModel) {
  return normalizeOwner(item.owned_by);
}

function modelApi(id: string, owner?: string): Api {
  if (id.includes("gpt")) return "openai-responses";
  if (owner === "anthropic") return "anthropic-messages";
  if (owner === "gemini") return "google-generative-ai";
  return "openai-completions";
}

function modelBaseUrl(baseUrl: string, owner?: string) {
  if (owner === "anthropic") return `${baseUrl}/anthropic`;
  if (owner === "gemini") return `${baseUrl}/gemini/v1beta`;
  return `${baseUrl}/v1`;
}

function isAnthropicAdaptiveThinkingModel(id: string) {
  return (
    id.includes("opus-4-6") ||
    id.includes("opus-4.6") ||
    id.includes("opus-4-7") ||
    id.includes("opus-4.7") ||
    id.includes("sonnet-4-6") ||
    id.includes("sonnet-4.6")
  );
}

function modelCompat(id: string, owner?: string): ProviderModelConfig["compat"] | undefined {
  if (owner === "anthropic") {
    return isAnthropicAdaptiveThinkingModel(id) ? { forceAdaptiveThinking: true } : undefined;
  }
  if (owner === "gemini") return undefined;
  return {
    supportsStore: false,
    supportsDeveloperRole: false,
    supportsReasoningEffort: false,
    maxTokensField: "max_tokens" as const,
    thinkingFormat: "openai" as const,
  };
}

function toProviderModel(baseUrl: string, item: AxonHubModel): AxonHubModelConfig | undefined {
  if (!item.id) return;

  const owner = ownerFromItem(item);
  const supportsVision = item.capabilities?.vision ?? true;

  return {
    id: item.id,
    name: item.name ?? item.display_name ?? item.id,
    api: modelApi(item.id, owner),
    reasoning: item.capabilities?.reasoning ?? true,
    input: supportsVision ? ["text", "image"] : ["text"],
    cost: {
      input: item.pricing?.input ?? 0,
      output: item.pricing?.output ?? 0,
      cacheRead: item.pricing?.cache_read ?? item.pricing?.cacheRead ?? 0,
      cacheWrite: item.pricing?.cache_write ?? item.pricing?.cacheWrite ?? 0,
    },
    contextWindow: item.context_length ?? 200000,
    maxTokens: item.max_output_tokens ?? 32000,
    compat: modelCompat(item.id, owner),
    baseUrl: modelBaseUrl(baseUrl, owner),
  };
}

function buildModels(baseUrl: string, payload: AxonHubModelsResponse): AxonHubModelConfig[] {
  return (payload.data ?? [])
    .map((item) => toProviderModel(baseUrl, item))
    .filter((model): model is AxonHubModelConfig => model !== undefined);
}

export default async function (pi: ExtensionAPI, options?: PluginOptions) {
  const baseUrl = resolveBaseUrl(options);
  const key = resolveApiKey(options) ?? (await readPiAuthApiKey());
  if (!key) return;

  const apiKeyOption = options?.apiKey ?? "AXONHUB_API_KEY";
  const register = (models: AxonHubModelConfig[]) => {
    pi.registerProvider(PROVIDER_ID, { baseUrl, apiKey: apiKeyOption, models });
  };

  // Notifications: queued before session_start, then routed to ctx.ui.notify after.
  // Fallback to console.warn only when there is no UI (print/RPC mode).
  type Notice = { message: string; type: "warning" | "error" };
  type UI = { notify: (m: string, t?: "info" | "warning" | "error") => void };
  let ui: UI | null = null;
  let hasUI = false;
  let sessionStarted = false;
  const pendingNotices: Notice[] = [];
  const notify = (message: string, type: "warning" | "error" = "warning") => {
    const prefixed = `[axonhub] ${message}`;
    if (sessionStarted) {
      if (hasUI && ui) ui.notify(prefixed, type);
      else console.warn(prefixed);
      return;
    }
    pendingNotices.push({ message: prefixed, type });
  };

  // @ts-expect-error - ExtensionAPI.on exists at runtime via jiti, but ts can't resolve due to symlink
  pi.on("session_start", (_event, ctx: { ui: UI; hasUI: boolean }) => {
    ui = ctx.ui;
    hasUI = ctx.hasUI;
    sessionStarted = true;
    if (!hasUI) {
      for (const n of pendingNotices) console.warn(n.message);
    } else {
      for (const n of pendingNotices) ui.notify(n.message, n.type);
    }
    pendingNotices.length = 0;
  });

  const errMessage = (err: unknown) => (err instanceof Error ? err.message : String(err));

  const cached = await readCache<AxonHubModelsResponse>(AXONHUB_CACHE_FILE);

  if (cached) {
    // Fast path: register cached models immediately, refresh in background
    register(buildModels(baseUrl, cached));

    fetchModels(baseUrl, key)
      .then(async (payload) => {
        await writeCache(AXONHUB_CACHE_FILE, payload);
        register(buildModels(baseUrl, payload));
      })
      .catch((err) => {
        notify(`failed to refresh models from ${baseUrl}, using cached list: ${errMessage(err)}`);
      });
    return;
  }

  // Cold start: fetch synchronously so models are available on first use.
  // Failures must not block pi startup — fall back to empty provider with a warning.
  try {
    const payload = await fetchModels(baseUrl, key);
    await writeCache(AXONHUB_CACHE_FILE, payload);
    register(buildModels(baseUrl, payload));
  } catch (err) {
    notify(
      `failed to fetch models from ${baseUrl}: ${errMessage(err)}. No axonhub models available this session.`,
      "error",
    );
    register([]);
  }

  // Inject web_search tool for gpt-* models from axonhub
  // @ts-expect-error - ExtensionAPI.on exists at runtime via jiti, but ts can't resolve due to symlink
  pi.on("before_provider_request", (event: { payload: unknown }, ctx: { model?: { provider: string; id: string } }) => {
    const model = ctx.model;
    if (model?.provider !== PROVIDER_ID) return;
    if (!model.id.startsWith("gpt-")) return;

    const payload = event.payload as {
      tools?: Array<{ type: string; name?: string; [key: string]: unknown }>;
      [key: string]: unknown;
    };

    // Add web_search built-in tool
    const webSearchTool = { type: "web_search" as const };
    const existingTools = payload.tools ?? [];
    const hasWebSearch = existingTools.some((t) => t.type === "web_search");
    if (!hasWebSearch) {
      payload.tools = [...existingTools, webSearchTool];
    }

    return payload;
  });
}
