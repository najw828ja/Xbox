/**
 * مكيّف CometAPI — توثيق: https://api.cometapi.com (متوافق مع OpenAI)
 * - صور (متزامن): POST {base}/v1/images/generations
 * - فيديو (غير متزامن): POST {base}/v1/videos  ثم GET {base}/v1/videos/{task_id}
 *   الحالات: queued/PENDING → RUNNING → SUCCEEDED/FAILED
 * - فحص صلاحية المفتاح (مجاني): /v1/dashboard/billing/credit_grants ثم /v1/models كبديل
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

const base = () => (process.env.COMETAPI_API_BASE || "https://api.cometapi.com").replace(/\/+$/, "");

/** تحويل aspect_ratio + resolution إلى size بصيغة OpenAI مثل "1280x720" */
function sizeFor(aspect?: string, resolution?: string): string | undefined {
  const short = resolution === "720p" ? 720 : 480;
  switch (aspect) {
    case "16:9": case "9:16":
      return aspect === "16:9" ? `${Math.round((short * 16) / 9)}x${short}` : `${short}x${Math.round((short * 16) / 9)}`;
    case "4:3": case "3:4":
      return aspect === "4:3" ? `${Math.round((short * 4) / 3)}x${short}` : `${short}x${Math.round((short * 4) / 3)}`;
    case "1:1":
      return `${short}x${short}`;
    default:
      return undefined; // auto — نترك المزود يقرر
  }
}

function extractUrls(data: unknown): string[] {
  // بحث مرن عن روابط في استجابات المزودين المختلفة
  const urls: string[] = [];
  const push = (v: unknown) => {
    if (typeof v === "string" && /^https?:\/\//.test(v)) urls.push(v);
    else if (typeof v === "string" && v.startsWith("data:image/")) urls.push(v);
  };
  const walk = (node: unknown, depth = 0) => {
    if (depth > 4 || node == null) return;
    if (Array.isArray(node)) return node.forEach((n) => walk(n, depth + 1));
    if (typeof node === "object") {
      const obj = node as Record<string, unknown>;
      for (const k of ["url", "video_url", "image_url", "result_url", "b64_json", "content"]) {
        if (k in obj && (k !== "content" || typeof obj[k] === "string")) push(obj[k]);
      }
      if ("output" in obj) walk(obj.output, depth + 1);
      if ("result" in obj) walk(obj.result, depth + 1);
      if ("data" in obj) walk(obj.data, depth + 1);
      if ("results" in obj) walk(obj.results, depth + 1);
    }
  };
  walk(data);
  return [...new Set(urls)];
}

function mapVideoStatus(raw: string, progress: unknown): ProviderTaskStatus {
  const s = String(raw).toLowerCase();
  const p = typeof progress === "number" ? Math.max(0, Math.min(100, Math.round(progress))) : 0;
  if (["succeeded", "completed", "success", "done"].includes(s))
    return { status: "completed", progress: 100, urls: [] };
  if (["failed", "error", "cancelled", "canceled"].includes(s))
    return { status: "failed", progress: 100, urls: [] };
  if (["running", "in_progress", "processing", "generating"].includes(s))
    return { status: "processing", progress: Math.max(p, 25), urls: [] };
  return { status: "processing", progress: Math.max(p, 8), urls: [] }; // queued / pending
}

export const cometApiAdapter: ProviderAdapter = {
  id: "cometapi",

  async createImageTask(key, model, input: ImageGenInput, signal) {
    // CometAPI يولّد الصور بشكل متزامن عبر /v1/images/generations —
    // نغلّفها كـ"مهمة" برقم داخلي حتى تتوافق مع بقية النظام.
    const status = await this.createImageSync!(key, model, input, signal);
    if (status.status === "failed") throw new ProviderError(500, status.error || "image generation failed");
    // نعيد معرّفًا زائفًا — النتيجة محفوظة فعلًا (سيرفعها المنسّق إلى قاعدة البيانات)
    return { providerTaskId: `sync-${Date.now()}-${Math.random().toString(36).slice(2, 8)}` };
  },

  async createImageSync(key, model, input: ImageGenInput, signal): Promise<ProviderTaskStatus> {
    const res = await fetchWithTimeout(`${base()}/v1/images/generations`, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model, prompt: input.prompt, n: 1, size: sizeFor(input.aspect_ratio, input.resolution) }),
      timeoutMs: 120_000, // التوليد المتزامن قد يستغرق وقتًا
      signal,
    });
    const body = await parseJsonResponse(res);
    const urls = extractUrls(body);
    if (urls.length === 0) {
      throw new ProviderError(502, "CometAPI returned no image URL (possibly b64 too large or unsupported model)", body);
    }
    return { status: "completed", progress: 100, urls };
  },

  async createVideoTask(key, model, input: VideoGenInput, signal): Promise<CreateTaskResult> {
    // التوثيق يستخدم multipart/form-data
    const form = new FormData();
    form.append("model", model);
    form.append("prompt", input.prompt);
    if (input.duration) form.append("seconds", String(input.duration));
    const size = sizeFor(input.aspect_ratio, input.resolution);
    if (size) form.append("size", size);
    if (input.image_url) form.append("image_url", input.image_url);

    const res = await fetchWithTimeout(`${base()}/v1/videos`, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}` },
      body: form,
      signal,
    });
    const body = await parseJsonResponse(res);
    const nestedData = body.data as Record<string, unknown> | undefined;
    const id =
      (typeof body.id === "string" && body.id) ||
      (typeof body.task_id === "string" && body.task_id) ||
      (nestedData && typeof nestedData.task_id === "string" ? (nestedData.task_id as string) : null);
    if (!id) throw new ProviderError(502, "CometAPI did not return a task id", body);
    return { providerTaskId: id };
  },

  async getTaskStatus(key, providerTaskId, kind, signal): Promise<ProviderTaskStatus> {
    if (kind === "image") {
      // المزامنة تُحلَّل قبل الوصول إلى هنا؛ كإجراء احترازي نعتبرها فاشلة
      return { status: "failed", progress: 100, urls: [], error: "sync image task has nothing to poll" };
    }
    const res = await fetchWithTimeout(`${base()}/v1/videos/${encodeURIComponent(providerTaskId)}`, {
      method: "GET",
      headers: { Authorization: `Bearer ${key}` },
      signal,
    });
    const body = await parseJsonResponse(res);
    const statusRaw = String(body.status ?? body.state ?? "pending");
    const mapped = mapVideoStatus(statusRaw, body.progress);

    if (mapped.status === "failed") {
      mapped.error =
        (typeof body.error === "string" && body.error) ||
        (typeof (body.error as Record<string, unknown>)?.message === "string"
          ? String((body.error as Record<string, unknown>).message)
          : undefined) ||
        `video task failed (${statusRaw})`;
    }
    if (mapped.status === "completed") {
      mapped.urls = extractUrls(body);
      if (mapped.urls.length === 0) {
        // بعض الاستجابات تعيد رابط محتوى يتطلب المفتاح — نخزن المسار كملاحظة
        mapped.urls = [`${base()}/v1/videos/${providerTaskId}/content`];
        mapped.error = "تم إكمال الفيديو لكن الرابط قد يتطلب مفتاح CometAPI للتحميل (/content)";
      }
    }
    return mapped;
  },

  async checkKey(key, signal): Promise<CheckKeyResult> {
    // محاولة 1: نقطة فحص الرصيد بنمط OpenAI القديم
    try {
      const res = await fetchWithTimeout(`${base()}/v1/dashboard/billing/credit_grants`, {
        method: "GET",
        headers: { Authorization: `Bearer ${key}` },
        signal,
      });
      if (res.ok) {
        const body = await parseJsonResponse(res);
        const grants = body.grants as Record<string, unknown> | undefined;
        const grantsData = grants && Array.isArray(grants.data) ? (grants.data as Array<Record<string, unknown>>) : undefined;
        const bal = body.total_available ?? body.total_granted ?? grantsData?.[0]?.total_available;
        return {
          ok: true,
          balance: bal != null ? String(bal) : undefined,
          message: bal != null ? `مفتاح صالح — الرصيد المتاح: ${bal}` : "مفتاح صالح",
        };
      }
      if (res.status === 401 || res.status === 403) throw new ProviderError(res.status, "invalid api key");
    } catch (err) {
      if (err instanceof ProviderError && (err.status === 401 || err.status === 403)) throw err;
      // نكمل للمحاولة 2
    }
    // محاولة 2: قائمة الموديلات (مجانية)
    const res2 = await fetchWithTimeout(`${base()}/v1/models`, {
      method: "GET",
      headers: { Authorization: `Bearer ${key}` },
      signal,
    });
    if (res2.ok) return { ok: true, message: "مفتاح صالح (تم التحقق عبر قائمة الموديلات)" };
    const body2 = await parseJsonResponse(res2).catch(() => ({}) as Record<string, unknown>);
    throw new ProviderError(res2.status, String(body2?.message ?? res2.statusText ?? "check failed"), body2);
  },
};
