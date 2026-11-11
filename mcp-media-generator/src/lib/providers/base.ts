import type { MediaType } from "../models";

/** خطأ موحّد من المزود — status=0 يعني فشل شبكة/اتصال */
export class ProviderError extends Error {
  status: number;
  body?: unknown;
  constructor(status: number, message: string, body?: unknown) {
    super(message);
    this.name = "ProviderError";
    this.status = status;
    this.body = body;
  }
}

export interface CreateTaskResult {
  providerTaskId: string;
}

/** حالة موحّدة لأي مهمة لدى أي مزود */
export interface ProviderTaskStatus {
  status: "processing" | "completed" | "failed";
  progress: number; // 0-100
  urls: string[];
  error?: string;
}

export interface ImageGenInput {
  prompt: string;
  aspect_ratio?: string;
  resolution?: string;
  background?: string;
  output_format?: string;
}

export interface VideoGenInput {
  prompt: string;
  image_url?: string;
  aspect_ratio?: string;
  resolution?: string;
  duration?: number;
  /** توليد صوت أصلي متزامن — افتراضي true لدى kie */
  enable_audio?: boolean;
}

export interface CheckKeyResult {
  ok: boolean;
  balance?: string;
  message: string;
}

export interface ProviderAdapter {
  id: "kie" | "cometapi";
  createImageTask(key: string, model: string, input: ImageGenInput, signal?: AbortSignal): Promise<CreateTaskResult>;
  createVideoTask(key: string, model: string, input: VideoGenInput, signal?: AbortSignal): Promise<CreateTaskResult>;
  /** مهمة متزامنة (صور CometAPI) — ترجع النتيجة فورًا إن دعم المزود ذلك */
  createImageSync?(key: string, model: string, input: ImageGenInput, signal?: AbortSignal): Promise<ProviderTaskStatus>;
  getTaskStatus(key: string, providerTaskId: string, kind: MediaType, signal?: AbortSignal): Promise<ProviderTaskStatus>;
  checkKey(key: string, signal?: AbortSignal): Promise<CheckKeyResult>;
}

const DEFAULT_TIMEOUT = 30_000;

export async function fetchWithTimeout(
  url: string,
  init: RequestInit & { timeoutMs?: number } = {}
): Promise<Response> {
  const { timeoutMs = DEFAULT_TIMEOUT, ...rest } = init;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error(`timeout after ${timeoutMs}ms`)), timeoutMs);
  // ربط إشارة الإلغاء الخارجية (إن وجدت) بمؤقت المهلة
  const outer = rest.signal;
  const onAbort = () => controller.abort(outer?.reason);
  if (outer) {
    if (outer.aborted) controller.abort(outer.reason);
    else outer.addEventListener("abort", onAbort, { once: true });
  }
  try {
    return await fetch(url, { ...rest, signal: controller.signal });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new ProviderError(0, `network error: ${msg}`);
  } finally {
    clearTimeout(timer);
    if (outer) outer.removeEventListener("abort", onAbort);
  }
}

export async function parseJsonResponse(res: Response): Promise<Record<string, unknown>> {
  const text = await res.text().catch(() => "");
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = { raw: text.slice(0, 500) };
  }
  if (!res.ok) {
    const b = body as Record<string, unknown> | null;
    const msg =
      (b && (typeof b.msg === "string" && b.msg) ||
        (typeof b?.message === "string" && b.message) ||
        (typeof b?.error === "string" && b.error)) ||
      res.statusText ||
      "request failed";
    throw new ProviderError(res.status, String(msg), body);
  }
  return (body ?? {}) as Record<string, unknown>;
}
