// Optional local-model selection for the pet assistant. [FRONTEND]
//
// The built-in assistant never needs this. When the user runs Ollama, LM Studio
// or llama.cpp, the panel can store the chosen loopback endpoint and model id
// and send free-form questions through `pet_ai_chat`. The backend re-validates
// every endpoint; nothing here is a security boundary, only a persisted choice.
//
// No chat history is stored: messages live in the panel's memory and disappear
// when it closes.

export const LOCAL_AI_STORAGE_ID = 'pet.ai';
export const LOCAL_AI_ENDPOINT_MAX = 300;
export const LOCAL_AI_MODEL_MAX = 120;

export interface LocalAiServer {
  id: string;
  name: string;
  baseUrl: string;
  reachable: boolean;
  models: string[];
  issue: string | null;
}

export interface LocalAiConfig {
  enabled: boolean;
  baseUrl: string;
  model: string;
  serverId: string;
}

export const DEFAULT_LOCAL_AI: LocalAiConfig = {
  enabled: false,
  baseUrl: '',
  model: '',
  serverId: '',
};

/** True when `value` is an http(s) literal-loopback endpoint. */
export function isLoopbackEndpoint(value: string): boolean {
  const raw = value.trim();
  if (!raw || raw.length > LOCAL_AI_ENDPOINT_MAX) return false;
  try {
    const url = new URL(raw);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
    if (url.username || url.password || url.search || url.hash) return false;
    const host = url.hostname.toLowerCase();
    return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]';
  } catch {
    return false;
  }
}

function cleanModel(value: string): string {
  const model = value.trim().slice(0, LOCAL_AI_MODEL_MAX);
  // Model ids are single tokens; whitespace means this is not a saved model id.
  return /\s/.test(model) ? '' : model;
}

/** Repair one persisted config; an incomplete choice is stored but not enabled. */
export function parseLocalAiConfig(raw: unknown): LocalAiConfig {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ...DEFAULT_LOCAL_AI };
  }
  const record = raw as Record<string, unknown>;
  const baseUrl =
    typeof record.baseUrl === 'string' && isLoopbackEndpoint(record.baseUrl)
      ? record.baseUrl.trim().slice(0, LOCAL_AI_ENDPOINT_MAX)
      : '';
  const model = typeof record.model === 'string' ? cleanModel(record.model) : '';
  const serverId =
    typeof record.serverId === 'string'
      ? record.serverId.trim().replace(/[^a-z0-9-]/gi, '').slice(0, 32)
      : '';
  return {
    enabled: record.enabled === true && baseUrl !== '' && model !== '',
    baseUrl,
    model,
    serverId,
  };
}

/** The model and endpoint are both present and the user opted in. */
export function localAiReady(config: LocalAiConfig): boolean {
  return config.enabled && config.baseUrl !== '' && config.model !== '';
}

/** Keep the previous model when the newly selected server still offers it. */
export function selectLocalAiServer(
  config: LocalAiConfig,
  server: LocalAiServer
): LocalAiConfig {
  const model =
    config.model && server.models.includes(config.model) ? config.model : server.models[0] ?? '';
  return {
    ...config,
    serverId: server.id,
    baseUrl: server.baseUrl,
    model,
  };
}

/** A server row is selectable only when it answered and has at least one model. */
export function serverSelectable(server: LocalAiServer): boolean {
  return server.reachable && server.models.length > 0;
}
