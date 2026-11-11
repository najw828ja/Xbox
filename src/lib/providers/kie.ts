/**
 * مكيّف kie.ai — توثيق: https://docs.kie.ai
 * - إنشاء مهمة:  POST {base}/api/v1/jobs/createTask
 * - متابعة:      GET  {base}/api/v1/jobs/recordInfo?taskId=...
 *   الحالات: waiting | queuing | generating | success | fail
 *   النتيجة: data.resultJson = '{"resultUrls":["..."]}' + data.progress + data.failMsg
 * - فحص الرصيد:  GET  {base}/api/v1/chat/credit  (مجاني)
 * ملاحظة ١: أخطاء kie.ai قد تعود بـ HTTP 200 مع code داخل الجسم — نوحّدها.
 * ملاحظة ٢: لو رفض kie اسم الموديل بصيغة معينة، نجرّب الصيغة البديلة تلقائيًا
 *           (gpt-image-2.6 ↔ gpt-image-2-6 ، grok-imagine-video-1.5-preview ↔ grok-imagine-video-1-5-preview)
 *           حتى يعمل الطلب سواء أرسل العميل الاسم بالشرطات أو بالنقاط.
 */
import {
  fetchWithTimeout,
  parseJsonResponse,
  ProviderError,
  type CheckKeyResult,
  type CreateTaskResult,
  type ImageGenInput,
  type ProviderAdapter,
  type ProviderTaskStatus,
  type VideoGenInput,
} from "./base";
import type { MediaType } from "../models";

const base = () => (process.env.KIE_API_BASE || "https://api.kie.ai").replace(/\/+$/, "");

/** kie.ai يعيد HTTP 200 غالبًا مع code في الجسم — نحوّل أي code غير 200 إلى ProviderError */
function assertKieOk(body: Record<string, unknown>) {
  const code = typeof body.code === "number" ? body.code : 200;
  if (code !== 200) {
    const msg = typeof body.msg === "string" && body.msg ? body.msg : `kie.ai error code ${code}`;
    throw new ProviderError(code, msg, body);
  }
}

function cleanInput(obj: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined && v !== null && v !== ""));
}

/** صيغ بديلة لاسم الموديل لدى kie — تُجرّب تلقائيًا إذا رفض kie الاسم الأول */
const KIE_MODEL_ALTERNATES: Record<string, string> = {
  "gpt-image-2.6/flare-text-to-image": "gpt-image-2-6/flare-text-to-image",
  "gpt-image-2-6/flare-text-to-image": "gpt-image-2.6/flare-text-to-image",
  "grok-imagine-video-1-5-preview": "grok-imagine-video-1.5-preview",
  "grok-imagine-video-1.5-preview": "grok-imagine-video-1-5-preview",
};

function isModelRejected(err: unknown): boolean {
  if (!(err instanceof ProviderError)) return false;
  const m = (err.message || "").toLowerCase();
  return (
    /model[^;]{0,40}(not|un)[^;]{0,20}(found|support|available)|unsupported model|unknown model|invalid model|no such model/.test(m) ||
    (err.status === 400 && /model/.test(m) && /invalid|not|unknown|unsupported/.test(m))
  );
}

async function createTaskWithFallback(
  key: string,
  model: string,
  input: Record<string, unknown>,
  signal?: AbortSignal
): Promise<CreateTaskResult> {
  try {
    return await createTask(key, model, input, signal);
  } catch (err) {
    const alt = KIE_MODEL_ALTERNATES[model];
    if (alt && isModelRejected(err)) {
      return await createTask(key, alt, input, signal);
    }
    throw err;
  }
}

async function createTask(
  key: string,
  model: string,
  input: Record<string, unknown>,
  signal?: AbortSignal
): Promise<CreateTaskResult> {
  const res = await fetchWithTimeout(`${base()}/api/v1/jobs/createTask`, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model, input }),
    signal,
  });
  const body = await parseJsonResponse(res); // يرمي ProviderError على !res.ok
  assertKieOk(body);
  const taskId = (body.data as Record<string, unknown> | undefined)?.taskId;
  if (typeof taskId !== "string" || !taskId) {
    throw new ProviderError(500, "kie.ai did not return a taskId", body);
  }
  return { providerTaskId: taskId };
}

function mapState(state: string, progress: unknown): ProviderTaskStatus {
  const p = typeof progress === "number" ? Math.max(0, Math.min(100, Math.round(progress))) : 0;
  switch (state) {
    case "success":
      return { status: "completed", progress: 100, urls: [] };
    case "fail":
      return { status: "failed", progress: 100, urls: [] };
    case "waiting":
    case "queuing":
      return { status: "processing", progress: Math.max(p, 5), urls: [] };
    default: // generating
      return { status: "processing", progress: Math.max(p, 15), urls: [] };
  }
}

export const kieAdapter: ProviderAdapter = {
  id: "kie",

  async createImageTask(key, model, input: ImageGenInput, signal) {
    return createTaskWithFallback(
      key,
      model,
      cleanInput({
        prompt: input.prompt,
        aspect_ratio: input.aspect_ratio,
        resolution: input.resolution,
        background: input.resolution === "1K" ? input.background : undefined, // background يعمل على 1K فقط
        output_format: input.output_format,
      }),
      signal
    );
  },

  async createVideoTask(key, model, input: VideoGenInput, signal) {
    return createTaskWithFallback(
      key,
      model,
      cleanInput({
        prompt: input.prompt,
        image_urls: input.image_url ? [input.image_url] : undefined,
        aspect_ratio: input.aspect_ratio,
        resolution: input.resolution,
        duration: input.duration,
        enable_audio: input.enable_audio,
      }),
      signal
    );
  },

  async getTaskStatus(key, providerTaskId, _kind: MediaType, signal): Promise<ProviderTaskStatus> {
    const res = await fetchWithTimeout(`${base()}/api/v1/jobs/recordInfo?taskId=${encodeURIComponent(providerTaskId)}`, {
      method: "GET",
      headers: { Authorization: `Bearer ${key}` },
      signal,
    });
    const body = await parseJsonResponse(res);
    assertKieOk(body);
    const data = (body.data ?? {}) as Record<string, unknown>;
    const state = typeof data.state === "string" ? data.state : "waiting";
    const mapped = mapState(state, data.progress);

    if (state === "fail") {
      mapped.error =
        (typeof data.failMsg === "string" && data.failMsg) ||
        (typeof data.failCode === "string" && data.failCode) ||
        "generation failed";
    }
    if (state === "success") {
      try {
        const resultJson = typeof data.resultJson === "string" ? JSON.parse(data.resultJson) : data.resultJson;
        const urls = (resultJson as Record<string, unknown>)?.resultUrls;
        if (Array.isArray(urls)) mapped.urls = urls.filter((u): u is string => typeof u === "string" && u.length > 0);
      } catch {
        // تجاهل — أعالجها أسفل كـ "لا روابط"
      }
      if (mapped.urls.length === 0) mapped.error = "task succeeded but no result URLs were returned";
    }
    return mapped;
  },

  async checkKey(key, signal): Promise<CheckKeyResult> {
    // فحص مجاني تمامًا: استعلام رصيد الحساب
    const res = await fetchWithTimeout(`${base()}/api/v1/chat/credit`, {
      method: "GET",
      headers: { Authorization: `Bearer ${key}` },
      signal,
    });
    const body = await parseJsonResponse(res);
    assertKieOk(body);
    const balance = body.data;
    return {
      ok: true,
      balance: typeof balance === "number" ? String(balance) : balance ? String(balance) : undefined,
      message: typeof balance === "number" ? `مفتاح صالح — الرصيد المتاح: ${balance}` : "مفتاح صالح",
    };
  },
};
