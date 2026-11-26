import http from "node:http";
import https from "node:https";
import type { ModelConnectivityResult } from "@zcode/shared";
import type { ProviderSettingsConnectivityTester } from "./providerFacadeServices.js";

interface FormalModelConnectivityInput {
  readonly workspacePath: string;
  readonly workspaceIdentity?: string;
  readonly selection: {
    readonly providerId: string;
    readonly modelId: string;
  };
}

type FormalModelConnectivityExecutor = (
  input: FormalModelConnectivityInput,
) => Promise<{ readonly success: true }>;

/**
 * 设置页只负责把已经落盘并进入 Registry 的 ModelSelection 交给目标 Environment。
 * Provider 鉴权、headers、reasoning 映射和流消费全部由正式 Model 执行链负责。
 */
export function createProviderSettingsConnectivityTester(dependencies: {
  readonly testModelConnectivity: FormalModelConnectivityExecutor;
}): ProviderSettingsConnectivityTester {
  return async (input) => {
    try {
      await dependencies.testModelConnectivity({
        workspacePath: input.workspacePath,
        ...(input.workspaceIdentity ? { workspaceIdentity: input.workspaceIdentity } : {}),
        selection: {
          providerId: input.providerId,
          modelId: input.modelId,
        },
      });
      return { success: true };
    } catch (error) {
      return {
        success: false,
        error: { message: error instanceof Error ? error.message : String(error) },
      };
    }
  };
}

export type { ModelConnectivityResult };

const LOCAL_PROVIDER_HOSTS = new Set(["api.cloudpersonal.ru", "localhost", "127.0.0.1", "::1"]);
const MODEL_LIST_TIMEOUT_MS = 20_000;
const MODEL_LIST_BODY_LIMIT = 2 * 1024 * 1024;

export type ListKeyModelsFailureCode = "invalid-url" | "unauthorized" | "http" | "network" | "empty";

export type ListKeyModelsResult =
  | { readonly ok: true; readonly modelIds: readonly string[] }
  | {
      readonly ok: false;
      readonly code: ListKeyModelsFailureCode;
      readonly status?: number;
      readonly message?: string;
    };

/** OpenAI 兼容目录。baseUrl 已含 /v1 时结果是 {baseUrl}/models。 */
export type KeyRequestFormat = "openai-chat-completions" | "anthropic-messages";

export function providerEndpointUrl(baseUrl: string, leaf: string): URL {
  const url = new URL(baseUrl.trim());
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("invalid-url");
  }
  const path = url.pathname.replace(/\/+$/u, "");
  url.pathname = `${path}/${leaf.replace(/^\/+/u, "")}`;
  url.search = "";
  url.hash = "";
  return url;
}

export function openAiModelsUrl(baseUrl: string): URL {
  return providerEndpointUrl(baseUrl, "models");
}

export function parseOpenAiModelIds(body: string): string[] {
  const parsed: unknown = JSON.parse(body);
  const items = modelItems(parsed);
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    const id =
      typeof item === "string"
        ? item
        : isRecord(item) && typeof item.id === "string"
          ? item.id
          : "";
    const trimmed = id.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    ids.push(trimmed);
  }
  return ids;
}

/** 本机和已登记的局域网模型地址使用私有 CA。只对这些主机跳过校验。 */
export function shouldSkipProviderTlsVerification(url: URL): boolean {
  if (url.protocol !== "https:") return false;
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/u, "");
  if (LOCAL_PROVIDER_HOSTS.has(host) || host.endsWith(".local")) return true;
  return isPrivateIpv4(host);
}

export async function listOpenAiCompatibleModels(input: {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly signal?: AbortSignal;
}): Promise<ListKeyModelsResult> {
  const apiKey = input.apiKey.trim();
  if (!apiKey) return { ok: false, code: "unauthorized" };
  let url: URL;
  try {
    url = openAiModelsUrl(input.baseUrl);
  } catch {
    return { ok: false, code: "invalid-url" };
  }

  let response: { status: number; body: string };
  try {
    response = await requestProvider(url, input.signal, {
      headers: {
        accept: "application/json",
        authorization: `Bearer ${apiKey}`,
      },
    });
  } catch (error) {
    // 原因留在结果里，密钥只在请求头，不进入 message。
    return {
      ok: false,
      code: "network",
      message: error instanceof Error ? error.message : "network",
    };
  }
  if (response.status === 401 || response.status === 403) {
    return { ok: false, code: "unauthorized", status: response.status };
  }
  if (response.status < 200 || response.status >= 300) {
    return { ok: false, code: "http", status: response.status };
  }
  let modelIds: string[];
  try {
    modelIds = parseOpenAiModelIds(response.body);
  } catch {
    return { ok: false, code: "http", status: response.status };
  }
  if (modelIds.length === 0) return { ok: false, code: "empty" };
  return { ok: true, modelIds };
}

/** 用这条模型探测密钥实际接受的请求格式。两种都通或都失败时返回 null，不覆盖用户选择。 */
export async function detectKeyApiFormat(input: {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly modelId: string;
  readonly signal?: AbortSignal;
}): Promise<KeyRequestFormat | null> {
  const apiKey = input.apiKey.trim();
  const modelId = input.modelId.trim();
  if (!apiKey || !modelId) return null;
  let chatUrl: URL;
  let messagesUrl: URL;
  try {
    chatUrl = providerEndpointUrl(input.baseUrl, "chat/completions");
    messagesUrl = providerEndpointUrl(input.baseUrl, "messages");
  } catch {
    return null;
  }
  const body = JSON.stringify({
    model: modelId,
    max_tokens: 1,
    messages: [{ role: "user", content: "ok" }],
  });
  const [chat, messages] = await Promise.all([
    requestProvider(chatUrl, input.signal, {
      method: "POST",
      body,
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        authorization: `Bearer ${apiKey}`,
      },
    }).catch(() => null),
    requestProvider(messagesUrl, input.signal, {
      method: "POST",
      body,
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        authorization: `Bearer ${apiKey}`,
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
    }).catch(() => null),
  ]);
  const chatOk = chat !== null && routeAcceptsModel(chat.status);
  const messagesOk = messages !== null && routeAcceptsModel(messages.status);
  if (chatOk && !messagesOk) return "openai-chat-completions";
  if (messagesOk && !chatOk) return "anthropic-messages";
  return null;
}

function routeAcceptsModel(status: number): boolean {
  return status > 0 && status !== 401 && status !== 403 && status !== 404 && status < 500;
}

function modelItems(parsed: unknown): readonly unknown[] {
  if (Array.isArray(parsed)) return parsed;
  if (!isRecord(parsed)) return [];
  if (Array.isArray(parsed.data)) return parsed.data;
  if (Array.isArray(parsed.models)) return parsed.models;
  return [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPrivateIpv4(host: string): boolean {
  const parts = host.split(".");
  if (parts.length !== 4) return false;
  const octets = parts.map((part) => Number(part));
  if (octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) return false;
  const [first, second] = octets;
  if (first === undefined || second === undefined) return false;
  return (
    first === 10 ||
    first === 127 ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168) ||
    (first === 169 && second === 254)
  );
}

function requestProvider(
  url: URL,
  signal: AbortSignal | undefined,
  init: { method?: "GET" | "POST"; headers: Record<string, string>; body?: string },
): Promise<{ status: number; body: string }> {
  const transport = url.protocol === "https:" ? https : http;
  const skipTls = shouldSkipProviderTlsVerification(url);
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError());
      return;
    }
    const request = transport.request(
      url,
      {
        method: init.method ?? "GET",
        headers: init.headers,
        ...(skipTls ? { rejectUnauthorized: false } : {}),
      },
      (response) => {
        const chunks: Buffer[] = [];
        let size = 0;
        response.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > MODEL_LIST_BODY_LIMIT) {
            response.destroy();
            reject(new Error("body-limit"));
            return;
          }
          chunks.push(chunk);
        });
        response.on("end", () => {
          resolve({
            status: response.statusCode ?? 0,
            body: Buffer.concat(chunks).toString("utf8"),
          });
        });
      },
    );
    const timeout = setTimeout(() => {
      request.destroy(new Error("timeout"));
    }, MODEL_LIST_TIMEOUT_MS);
    const onAbort = () => {
      request.destroy(abortError());
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    request.on("error", (error) => {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", onAbort);
      reject(error);
    });
    request.on("close", () => {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", onAbort);
    });
    if (init.body) request.write(init.body);
    request.end();
  });
}

function abortError(): Error {
  const error = new Error("The operation was aborted.");
  error.name = "AbortError";
  return error;
}
