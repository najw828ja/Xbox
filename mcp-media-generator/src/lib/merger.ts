/**
 * عميل خدمة دمج الفيديوهات — Video Merger API (الإصدار الثاني: dmg1.vercel.app)
 *
 * دمج عدة مقاطع فيديو في مقطع واحد — دون تنزيل أي وسائط على هذا السيرفر:
 * نرسل روابط الفيديوهات للخدمة، ننفّذ الدمج، ونخزّن رابط الفيديو النهائي في Turso.
 *
 * REST (عنوان الخدمة MERGER_API_BASE):
 *   POST   /api/jobs                    {videos:[...]} → {jobId, status:"queued", ...}
 *   POST   /api/jobs/{id}/process       تنفيذ الدمج (يحجب حتى الاكتمال عادةً)
 *                                        → {status:"done", videoUrl, downloadUrl, ...} أو {error}
 *   GET    /api/jobs/{id}               {status:"queued"|"done"|"failed", progress:0..100, videoUrl?, error?}
 *   GET    /api/jobs/{id}/video?download=1   الفيديو الناتج MP4 (H.264+AAC حتى 1080p)
 *   DELETE /api/jobs/{id}               حذف المهمة فورًا
 *   GET    /api/config                  حدود الخدمة (10 مقاطع، 200MB/رابط، 150MB ناتج، 600 ثانية)
 *
 * ملاحظات الخدمة: تُحذف البيانات تلقائيًا بعد 24 ساعة من إنشاء المهمة.
 * الأخطاء المُعلَنة من الخدمة (HTTP 4xx/5xx بجسم {error}) حتمية غالبًا (روابط غير قابلة للتنزيل
 * مثلًا) → نفشل المهمة فورًا؛ أما انقطاع الشبكة/المهلة لدينا فمؤقت → نُكمل المحاولة.
 */
import { insertTask, updateTask, type TaskRow } from "./tasks";

export const MERGER_BASE = (process.env.MERGER_API_BASE || "https://dmg1.vercel.app")
  .trim()
  .replace(/\/+$/, "");

export const MERGER_MODEL = "video-merger";

/** حدود الخدمة (من /api/config — قيم افتراضية مطابقة) */
export const MERGER_MAX_SOURCES = 10;

/** أنواع نتائج runMerge — نفس منطق runGeneration لكن بدون مفاتيح API */
export type MergeOutcome =
  | { kind: "completed"; task: TaskRow }
  | { kind: "processing"; task: TaskRow }
  | { kind: "failed"; task: TaskRow }
  | { kind: "invalid"; reason: string };

export interface MergeJobStatus {
  status: "processing" | "completed" | "failed";
  progress: number; // 0..100
  resultUrls: string[];
  error?: string;
}

const CREATE_TIMEOUT_MS = 30_000;
const PROCESS_TIMEOUT_MS = 240_000;
const STATUS_TIMEOUT_MS = 15_000;
const POLL_INTERVAL_MS = 3_000;

/* ─────────────────────────── مساعدات تحليل دفاعية ─────────────────────────── */

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function pickStr(...vals: unknown[]): string | undefined {
  for (const v of vals) {
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return undefined;
}

function toAbsoluteUrl(raw: string | undefined, base: string): string | undefined {
  if (!raw) return undefined;
  const v = raw.trim();
  if (/^https?:\/\//i.test(v)) return v; // رابط مطلق جاهز
  if (v.startsWith("/")) return `${base}${v}`; // مسار نسبي
  return undefined;
}

/** استخراج معرّف المهمة من استجابة POST /api/jobs بأي صيغة معقولة (مُصدَّر للاختبار) */
export function extractJobId(data: unknown): string | undefined {
  if (typeof data === "string" && data.trim()) return data.trim(); // بعض الخدمات تعيد النص مجردًا
  if (!isObj(data)) return undefined;
  const inner = isObj(data.job) ? data.job : data;
  return pickStr(inner.jobId, inner.job_id, inner.id, inner.uuid) ?? undefined;
}

/**
 * تحليل حالة المهمة من استجابة GET /api/jobs/{id} أو POST /api/jobs/{id}/process
 * بأي صيغة معقولة (مُصدَّر للاختبار).
 * الأولوية لرابط التشغيل videoUrl (يعمل في المتصفح وكمدخل مباشر لدمج لاحق)؛
 * وإن غاب واكتملت المهمة نبنيه من معرّف المهمة: /api/jobs/{id}/video.
 */
export function parseJobStatus(data: unknown): MergeJobStatus {
  const root = isObj(data) ? data : {};
  const job = isObj(root.job) ? root.job : isObj(root.data) ? root.data : root;
  const result = isObj(job.result) ? job.result : isObj(root.result) ? root.result : {};

  const statusRaw = (pickStr(job.status, job.state, root.status, root.state) ?? "").toLowerCase();
  const err =
    pickStr(job.error, root.error) ??
    (typeof job.detail === "string" ? job.detail : undefined) ??
    (typeof root.detail === "string" ? root.detail : undefined) ??
    (isObj(job.error) ? pickStr((job.error as Record<string, unknown>).message) : undefined);

  const completed = ["done", "completed", "complete", "success", "succeeded", "finished"].includes(statusRaw);
  const failed = ["error", "failed", "failure", "cancelled", "canceled"].includes(statusRaw)
    // استجابة خطأ بلا حقل status صريح (مثل {"error":"..."}) ← فشل
    || (!statusRaw && Boolean(err));

  let progress = Number(job.progress ?? job.percent ?? root.progress ?? root.percent ?? 0);
  if (!Number.isFinite(progress) || progress < 0) progress = 0;
  if (progress > 0 && progress <= 1) progress *= 100; // بعض الخدمات تعيد كسرًا 0..1
  if (completed) progress = 100;
  if (failed) progress = Math.max(progress, 100);

  const jobId = pickStr(job.jobId, job.job_id, job.id, root.jobId, root.job_id, root.id);
  const videoRaw =
    pickStr(job.videoUrl, job.video_url, job.downloadUrl, job.download_url, root.videoUrl, root.video_url, root.downloadUrl, root.download_url, result.videoUrl, result.downloadUrl) ??
    undefined;
  const url = toAbsoluteUrl(videoRaw, MERGER_BASE)
    // احتياط أخير: نبني الرابط من معرّف المهمة وفق مخطط الخدمة الثابت
    ?? (completed && jobId ? `${MERGER_BASE}/api/jobs/${encodeURIComponent(jobId)}/video` : undefined);

  return {
    status: completed ? "completed" : failed ? "failed" : "processing",
    progress: Math.round(progress),
    resultUrls: completed && url ? [url] : [],
    ...(err ? { error: err } : {}),
  };
}

/* ─────────────────────────── نداءات REST ─────────────────────────── */

async function fetchJson(url: string, init: RequestInit = {}, timeoutMs = STATUS_TIMEOUT_MS): Promise<unknown> {
  const res = await fetch(url, {
    ...init,
    signal: AbortSignal.timeout(timeoutMs),
    headers: { ...(init.headers ?? {}) },
    cache: "no-store",
  });
  const text = await res.text();
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch { /* نص غير JSON — نمرره كما هو */ }
  if (!res.ok) {
    const msg = pickStr(
      isObj(body) ? (body.error as string) : undefined,
      isObj(body) ? (body.detail as string) : undefined,
      typeof body === "string" ? body.slice(0, 300) : undefined
    );
    // أخطاء الخدمة المُعلَنة (HTTP 4xx/5xx) — رسالتها تصل لمسار الفشل الحتمي
    throw new Error(`خدمة الدمج ردّت ${res.status}${msg ? `: ${msg.slice(0, 300)}` : ""}`);
  }
  return body;
}

/** هل الخطأ مُعلَن من الخدمة (HTTP 4xx/5xx) وليس انقطاع شبكة/مهلة لدينا؟ */
function isServiceDeclaredError(err: unknown): boolean {
  return err instanceof Error && /خدمة الدمج ردّت \d{3}/.test(err.message);
}

/** فحص جهوزية خدمة الدمج (يُستخدم في /api/health) — عبر /api/config */
export async function mergerHealthy(): Promise<boolean> {
  try {
    const res = await fetch(`${MERGER_BASE}/api/config`, { signal: AbortSignal.timeout(4_000), cache: "no-store" });
    return res.ok;
  } catch {
    return false;
  }
}

/** إنشاء مهمة دمج جديدة من روابط — يعيد jobId (الحالة تبدأ queued) */
export async function createMergeJob(opts: { urls: string[] }, signal?: AbortSignal): Promise<string> {
  if (signal?.aborted) throw new Error("aborted");
  const body = await fetchJson(
    `${MERGER_BASE}/api/jobs`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ videos: opts.urls }),
    },
    CREATE_TIMEOUT_MS
  );
  const jobId = extractJobId(body);
  if (!jobId) throw new Error(`استجابة غير متوقعة من خدمة الدمج عند إنشاء المهمة: ${JSON.stringify(body).slice(0, 300)}`);
  return jobId;
}

/** تنفيذ الدمج — يحجب حتى الاكتمال عادةً (ثوانٍ) ويعيد النتيجة أو الخطأ */
export async function processMergeJob(jobId: string, signal?: AbortSignal): Promise<MergeJobStatus> {
  if (signal?.aborted) throw new Error("aborted");
  const body = await fetchJson(
    `${MERGER_BASE}/api/jobs/${encodeURIComponent(jobId)}/process`,
    { method: "POST", headers: { "Content-Type": "application/json" } },
    PROCESS_TIMEOUT_MS
  );
  return parseJobStatus(body);
}

/** الاستعلام عن حالة مهمة دمج */
export async function getMergeJob(jobId: string): Promise<MergeJobStatus> {
  const body = await fetchJson(`${MERGER_BASE}/api/jobs/${encodeURIComponent(jobId)}`);
  return parseJobStatus(body);
}

/* ─────────────────────────── التدفق الكامل ─────────────────────────── */

export interface MergeArgs {
  urls: string[];
  waitSeconds: number;
  onProgress?: (info: { progress: number; total: number; message: string; percent?: number; taskId?: string }) => Promise<void> | void;
  signal?: AbortSignal;
}

/** تقدير مدة الدمج الكلية بالثواني (لنسب التقدم أثناء الانتظار) */
function estimateMergeSeconds(urls: string[]): number {
  return Math.max(30, 15 + urls.length * 8);
}

async function safe(fn: () => Promise<unknown>): Promise<void> {
  try { await fn(); } catch { /* تجاهل أخطاء الحفظ الثانوية */ }
}

/** مهام process الجارية الآن — تمنع تنفيذًا مزدوجًا بين runMerge و refreshMergeTask */
const processInFlight = new Set<string>();

/** إنهاء مهمة الدمج في Turso حسب نتيجة الخدمة */
async function finalizeMerge(task: TaskRow, st: MergeJobStatus): Promise<MergeOutcome> {
  if (st.status === "completed") {
    if (!st.resultUrls.length) {
      const failed = (await updateTask(task.id, {
        status: "failed",
        progress: 100,
        errorMessage: "الخدمة أعلنت الاكتمال لكنها لم تُرجع رابط الفيديو النهائي",
      })) ?? task;
      return { kind: "failed", task: failed };
    }
    const done = (await updateTask(task.id, {
      status: "completed",
      progress: 100,
      resultUrls: st.resultUrls,
      errorMessage: null,
    })) ?? task;
    return { kind: "completed", task: done };
  }
  const failed = (await updateTask(task.id, {
    status: "failed",
    progress: 100,
    errorMessage: st.error ?? "فشل الدمج في الخدمة",
  })) ?? task;
  return { kind: "failed", task: failed };
}

/**
 * تنفيذ عملية دمج كاملة: إنشاء المهمة في Turso → إرسال الروابط للخدمة →
 * تنفيذ الدمج (process) مع نبضات تقدم → تخزين رابط الفيديو النهائي عند الاكتمال.
 * لو انتهت نافذة الانتظار قبل الاكتمال يبقى process يعمل في الخلفية ويحدّث Turso
 * عند انتهائه، وتكمل get_task المتابعة بسلاسة (نفس تجربة مهام التوليد).
 */
export async function runMerge(args: MergeArgs): Promise<MergeOutcome> {
  // 1) تحقق صارم من المعطيات — أخطاء المعطيات توقف فورًا
  const urls = args.urls.map((u) => u.trim()).filter(Boolean);
  if (urls.length < 2) {
    return { kind: "invalid", reason: "الدمج يحتاج رابطَي فيديو على الأقل (min 2 urls)" };
  }
  const bad = urls.filter((u) => !/^https?:\/\//i.test(u));
  if (bad.length) {
    return { kind: "invalid", reason: `كل الروابط يجب أن تكون روابط http/https مباشرة وعامة. غير صالح: ${bad.slice(0, 3).join(" ، ")}` };
  }
  if (urls.length > MERGER_MAX_SOURCES) {
    return { kind: "invalid", reason: `أقصى عدد مقاطع للدمج هو ${MERGER_MAX_SOURCES} (حدود الخدمة)` };
  }

  // 2) تسجيل المهمة في Turso أولًا (قابلة للتتبع حتى لو فشل الاتصال بالخدمة)
  const prompt = `دمج ${urls.length} مقاطع فيديو`;
  let task = await insertTask({
    provider: "merger",
    providerTaskId: null,
    keyId: null,
    model: MERGER_MODEL,
    type: "merge",
    prompt,
    params: { urls },
    status: "pending",
    progress: 0,
  });

  // 3) إنشاء المهمة لدى خدمة الدمج
  let jobId: string;
  try {
    jobId = await createMergeJob({ urls }, args.signal);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    task = (await updateTask(task.id, { status: "failed", progress: 100, errorMessage: `فشل إنشاء مهمة الدمج: ${msg}` })) ?? task;
    return { kind: "failed", task };
  }

  task = (await updateTask(task.id, { providerTaskId: jobId, status: "processing", progress: 5 })) ?? task;
  const total = estimateMergeSeconds(urls);
  const startedAt = Date.now();
  const deadline = startedAt + args.waitSeconds * 1000;

  await args.onProgress?.({
    progress: 0,
    total,
    percent: 5,
    message: `قُبلت مهمة الدمج في الخدمة — جارٍ دمج ${urls.length} مقاطع…`,
    taskId: task.id,
  });

  // 4) تنفيذ الدمج — نبدأ process فورًا ونُتابع الحالة بنبضات حتى نهاية نافذة الانتظار
  let settled = false;
  processInFlight.add(jobId);
  const processPromise = processMergeJob(jobId)
    .then((st) => {
      processInFlight.delete(jobId);
      return finalizeMerge(task, st);
    })
    .catch(async (err) => {
      processInFlight.delete(jobId);
      if (settled) return { kind: "processing", task } as MergeOutcome;
      // خطأ مُعلَن من الخدمة (روابط غير قابلة للتنزيل مثلًا) → فشل حتمي
      if (isServiceDeclaredError(err)) {
        const msg = err instanceof Error ? err.message : String(err);
        const failed = (await updateTask(task.id, { status: "failed", progress: 100, errorMessage: msg })) ?? task;
        return { kind: "failed", task: failed } as MergeOutcome;
      }
      // مهلة/شبكة لدينا → مؤقت: نُكمل بالمتابعة عبر حالة المهمة (process قد يُعاد لاحقًا)
      return { kind: "processing", task } as MergeOutcome;
    });

  const heartbeat = async () => {
    const elapsed = Math.round((Date.now() - startedAt) / 1000);
    await args.onProgress?.({
      progress: elapsed,
      total,
      percent: Math.max(3, Math.min(95, Math.round((elapsed / total) * 100))),
      message: "قيد الدمج…",
      taskId: task.id,
    });
  };

  while (Date.now() < deadline) {
    if (args.signal?.aborted) break;
    const tick = new Promise<"tick">((r) => setTimeout(r, POLL_INTERVAL_MS));
    const raced = await Promise.race([
      processPromise.then((r) => ({ from: "process" as const, r })),
      tick.then(() => null),
    ]);
    if (raced) {
      settled = true;
      if (raced.r.kind === "completed") {
        await args.onProgress?.({ progress: total, total, percent: 100, message: "تم الدمج بنجاح ✓", taskId: task.id });
      }
      return raced.r;
    }

    // نبضة: نستعلم الحالة المباشرة (قد تُظهر تقدمًا أو حتى اكتمالًا سبق process)
    try {
      const st = await getMergeJob(jobId);
      if (st.status === "completed" && st.resultUrls.length) {
        settled = true;
        task = (await updateTask(task.id, { status: "completed", progress: 100, resultUrls: st.resultUrls, errorMessage: null })) ?? task;
        await args.onProgress?.({ progress: total, total, percent: 100, message: "تم الدمج بنجاح ✓", taskId: task.id });
        return { kind: "completed", task };
      }
      if (st.status === "failed") {
        settled = true;
        task = (await updateTask(task.id, { status: "failed", progress: 100, errorMessage: st.error ?? "فشل الدمج في الخدمة" })) ?? task;
        return { kind: "failed", task };
      }
      if (st.progress > 0) {
        const elapsed = Math.round((Date.now() - startedAt) / 1000);
        await args.onProgress?.({
          progress: elapsed,
          total,
          percent: Math.max(3, Math.min(95, st.progress)),
          message: "قيد الدمج…", // النسبة تُلحق تلقائيًا بواسطة طبقة MCP
          taskId: task.id,
        });
      } else {
        await heartbeat();
      }
    } catch {
      await heartbeat(); // تعذّر استعلام مؤقت — نبضة زمنية ونكمل
    }
  }

  // 5) انتهت نافذة الانتظار (أو أُلغي الطلب) — process يبقى يعمل في الخلفية ويحدّث Turso
  //    عند انتهائه، وget_task يكمل المتابعة في الاستعلامات القادمة.
  return { kind: "processing", task };
}

/**
 * تحديث حي لمهمة دمج من الخدمة — تستخدمه get_task عند provider = "merger".
 * مهمة لم يُنفَّذ process لها بعد (أو انقطع) نُعيد تنفيذه هنا حتى تكتمل مهما حدث.
 */
export async function refreshMergeTask(task: TaskRow): Promise<TaskRow> {
  if (!task.providerTaskId) return task;
  const jobId = task.providerTaskId;
  try {
    const st = await getMergeJob(jobId);

    if (st.status !== "processing") {
      return (
        (await updateTask(task.id, {
          status: st.status === "completed" ? "completed" : "failed",
          progress: st.progress,
          resultUrls: st.resultUrls.length ? st.resultUrls : undefined,
          errorMessage: st.error ?? null,
        })) ?? task
      );
    }

    // المهمة ما زالت queued/processing: لو لا يوجد process جارٍ نُشغّله الآن
    if (!processInFlight.has(jobId)) {
      processInFlight.add(jobId);
      try {
        const done = await processMergeJob(jobId);
        return (
          (await updateTask(task.id, {
            status: done.status === "completed" ? "completed" : done.status === "failed" ? "failed" : "processing",
            progress: done.progress,
            resultUrls: done.resultUrls.length ? done.resultUrls : undefined,
            errorMessage: done.error ?? null,
          })) ?? task
        );
      } finally {
        processInFlight.delete(jobId);
      }
    }
    return (await updateTask(task.id, { status: "processing", progress: Math.max(task.progress, st.progress) })) ?? task;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // المهمة غير موجودة لدى الخدمة (حُذفت أو مرّت 24 ساعة أو من خدمة قديمة) → فشل نهائي
    if (/خدمة الدمج ردّت 404/.test(message)) {
      return (
        (await updateTask(task.id, {
          status: "failed",
          progress: 100,
          errorMessage: "مهمة الدمج غير موجودة في الخدمة (حُذفت أو انتهت صلاحيتها بعد 24 ساعة)",
        })) ?? task
      );
    }
    return (await updateTask(task.id, { errorMessage: `تعذّر التحديث من خدمة الدمج: ${message}` })) ?? task;
  }
}
