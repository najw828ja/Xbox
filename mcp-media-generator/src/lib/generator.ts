/**
 * منسّق التوليد مع سياسة «لا مفتاح يتوقف أبدًا»:
 * - المفتاح المرفوض من المزود (401/403) يُعطَّل تلقائيًا حسب المواصفة،
 *   أما المفتاح المستنزف رصيده فيبقى في الدورة دائمًا (تشحن رصيده فيكمل العمل)،
 *   والتعطيل اليدوي من الواجهة معطّل أيضًا.
 * - عند فشل أي مفتاح (أو نفاد رصيده في منتصف التوليد) تُعاد المهمة إنشاؤها تلقائيًا
 *   على المفتاح التالي بنفس task_id — العميل (GPT) يرى «قيد المعالجة» فقط ويكمل
 *   المتابعة حتى ظهور النتيجة دون أن يعلم بحدوث أي تبديل.
 * - مهمة فشل إنشاؤها على كل المفاتيح تبقى «قيد المعالجة» وتُعاد محاولتها تلقائيًا
 *   مع كل استعلام get_task — فعند شحن رصيد أي مفتاح تكتمل المهمة من تلقاء نفسها.
 * - أخطاء المعطيات (params) فقط تتوقف فورًا لأن تبديل المفاتيح لن يحلها.
 * أثناء الانتظار يرسل Progress notifications للعميل عبر onProgress.
 */
import { MODELS, findModel, type MediaType, type ModelDef } from "./models";
import { kieAdapter } from "./providers/kie";
import { cometApiAdapter } from "./providers/cometapi";
import type { ProviderAdapter } from "./providers/base";
import {
  CLASS_MESSAGES,
  classifyProviderError,
  getKeyPool,
  getKey,
  maskKey,
  recordKeyOutcome,
  setKeyStatus,
  touchKeyUsage,
  type ApiKeyRow,
} from "./keys";
import { getTask, insertTask, updateTask, type TaskRow } from "./tasks";
import { refreshMergeTask } from "./merger";

export const adapters: Record<"kie" | "cometapi", ProviderAdapter> = {
  kie: kieAdapter,
  cometapi: cometApiAdapter,
};

export interface ProgressInfo {
  /** ثوانٍ منقضية أو نسبة مئوية حسب السياق */
  progress: number;
  /** إجمالي تقديري لنفس الوحدة */
  total: number;
  message: string;
  percent?: number;
  taskId?: string;
}

export type ProgressCb = (info: ProgressInfo) => Promise<void> | void;

export interface GenerationArgs {
  type: MediaType;
  model?: string;
  prompt: string;
  imageUrl?: string;
  aspectRatio?: string;
  resolution?: string;
  background?: string;
  outputFormat?: string;
  duration?: number;
  enableAudio?: boolean;
  waitSeconds: number;
  onProgress?: ProgressCb;
  signal?: AbortSignal;
}

export type GenerationOutcome =
  | { kind: "completed"; task: TaskRow }
  | { kind: "processing"; task: TaskRow }
  | { kind: "failed"; task: TaskRow }
  | { kind: "invalid"; reason: string }
  | { kind: "no_keys"; model: string };

const POLL_INTERVAL_MS = 3_000;
/** مهلة قبل إعادة محاولة التبديل بعد نفاد كل المفاتيح المتاحة (حتى لا نضغط المزودين) */
const RESTART_COOLDOWN_MS = 45_000;
/** أنماط تشير لمشكلة مفتاح/رصيد حتى لو وردت داخل رسالة فشل المهمة نفسها */
const KEY_ISSUE_PATTERN = /insufficient|balance|credit|quota|arrears|充值|out of credits|exhausted|resource.?exhausted|invalid.{0,20}key|unauthorized|forbidden|402|401/i;

function estimateTotalSeconds(type: MediaType, duration?: number): number {
  if (type === "image") return 60;
  return (duration ?? 8) * 8 + 60; // فيديو: تقدير تقريبي
}

async function safe(fn: () => Promise<unknown>): Promise<void> {
  try { await fn(); } catch { /* تجاهل أخطاء الحفظ الثانوية */ }
}

async function persistAttempt(taskId: string, attempt: TaskRow["attempts"][number]) {
  await safe(() => updateTask(taskId, { appendAttempt: attempt }));
}

/** بناء معطيات إعادة الإنشاء من صف المهمة المخزن (لتكملة نفس المهمة على مفتاح آخر) */
function argsFromTask(task: TaskRow, signal?: AbortSignal): GenerationArgs {
  let p: Record<string, unknown> = {};
  try { p = JSON.parse(task.paramsJson || "{}") as Record<string, unknown>; } catch { /* تجاهل */ }
  return {
    type: task.type,
    model: task.model,
    prompt: task.prompt,
    imageUrl: typeof p.image_url === "string" ? p.image_url : undefined,
    aspectRatio: typeof p.aspect_ratio === "string" ? p.aspect_ratio : undefined,
    resolution: typeof p.resolution === "string" ? p.resolution : undefined,
    background: typeof p.background === "string" ? p.background : undefined,
    outputFormat: typeof p.output_format === "string" ? p.output_format : undefined,
    duration: typeof p.duration === "number" ? p.duration : undefined,
    enableAudio: typeof p.enable_audio === "boolean" ? p.enable_audio : undefined,
    waitSeconds: 0,
    signal,
  };
}

/**
 * إنشاء مهمة المزود على مفتاح محدد:
 * - صور مزود متزامن (CometAPI) → النتيجة تعود فورًا.
 * - غير ذلك → مهمة غير متزامنة بمعرّف providerTaskId.
 */
async function createProviderTask(
  key: ApiKeyRow,
  def: ModelDef,
  args: GenerationArgs
): Promise<{ kind: "async"; providerTaskId: string } | { kind: "sync"; urls: string[]; failed?: string }> {
  const adapter = adapters[key.provider];
  if (args.type === "image" && adapter.createImageSync) {
    const status = await adapter.createImageSync(key.apiKey, def.providerModel[key.provider], {
      prompt: args.prompt,
      aspect_ratio: args.aspectRatio,
      resolution: args.resolution,
      background: args.background,
      output_format: args.outputFormat,
    }, args.signal);
    return {
      kind: "sync",
      urls: status.urls,
      ...(status.status === "failed" ? { failed: status.error ?? "unknown error" } : {}),
    };
  }
  const created = args.type === "image"
    ? await adapter.createImageTask(key.apiKey, def.providerModel[key.provider], {
        prompt: args.prompt,
        aspect_ratio: args.aspectRatio,
        resolution: args.resolution,
        background: args.background,
        output_format: args.outputFormat,
      }, args.signal)
    : await adapter.createVideoTask(key.apiKey, def.providerModel[key.provider], {
        prompt: args.prompt,
        image_url: args.imageUrl,
        aspect_ratio: args.aspectRatio,
        resolution: args.resolution,
        duration: args.duration,
        enable_audio: args.enableAudio,
      }, args.signal);
  return { kind: "async", providerTaskId: created.providerTaskId };
}

interface RunCtx {
  def: ModelDef;
  args: GenerationArgs;
  pool: ApiKeyRow[];
  usedKeyIds: Set<string>;
  attempts: TaskRow["attempts"];
}

type RestartResult =
  | { kind: "switched"; task: TaskRow; key: ApiKeyRow }
  | { kind: "completed"; task: TaskRow }
  | { kind: "failed"; task: TaskRow }
  | { kind: "exhausted_pool" };

/**
 * قلب سياسة «لا مفتاح يتوقف»: إعادة إنشاء نفس المهمة على المفتاح التالي
 * بنفس صف المهمة في Turso (نفس task_id أمام العميل) دون أي انقطاع.
 */
async function restartOnNextKey(task: TaskRow, currentKeyId: string | null, ctx: RunCtx): Promise<RestartResult> {
  const remaining = ctx.pool.filter((k) => k.id !== currentKeyId && !ctx.usedKeyIds.has(k.id));
  if (remaining.length === 0) return { kind: "exhausted_pool" };

  const total = estimateTotalSeconds(task.type, (JSON.parse(task.paramsJson || "{}") as { duration?: number }).duration);
  for (const key of remaining) {
    ctx.usedKeyIds.add(key.id);
    await safe(() => touchKeyUsage(key.id));
    const label = key.label || maskKey(key.apiKey);
    await ctx.args.onProgress?.({
      progress: 0,
      total,
      percent: 5,
      message: `تبديل تلقائي إلى مفتاح آخر (${key.provider}) — تكملة نفس المهمة…`,
      taskId: task.id,
    });
    try {
      const created = await createProviderTask(key, ctx.def, ctx.args);

      if (created.kind === "sync") {
        // صورة متزامنة اكتملت أثناء التبديل مباشرة
        const ok = !created.failed;
        await safe(() => recordKeyOutcome(key.id, ok, created.failed));
        const updated = await updateTask(task.id, {
          provider: key.provider,
          providerTaskId: null,
          keyId: key.id,
          status: ok ? "completed" : "processing",
          progress: ok ? 100 : 5,
          resultUrls: ok ? created.urls : undefined,
          errorMessage: null,
          appendAttempt: {
            provider: key.provider, keyId: key.id, keyLabel: label, ok,
            errorClass: ok ? undefined : "provider",
            error: created.failed,
            at: new Date().toISOString(),
          },
        });
        if (ok) {
          await ctx.args.onProgress?.({ progress: 1, total: 1, percent: 100, message: "تم التوليد بنجاح ✓", taskId: task.id });
          return { kind: "completed", task: updated! };
        }
        continue; // فشل هذا المفتاح أيضًا — جرّب التالي
      }

      // مهمة غير متزامنة جديدة على المفتاح البديل — نفس task_id أمام العميل
      const updated = await updateTask(task.id, {
        provider: key.provider,
        providerTaskId: created.providerTaskId,
        keyId: key.id,
        status: "processing",
        progress: 5,
        errorMessage: null,
        appendAttempt: { provider: key.provider, keyId: key.id, keyLabel: label, ok: true, at: new Date().toISOString() },
      });
      await ctx.args.onProgress?.({
        progress: 0,
        total,
        percent: 5,
        message: `قُبل الطلب في ${key.provider} بعد التبديل — جارٍ التوليد…`,
        taskId: task.id,
      });
      return { kind: "switched", task: updated!, key };
    } catch (err) {
      const { cls, status, message } = classifyProviderError(err);
      const attempt = {
        provider: key.provider,
        keyId: key.id,
        keyLabel: label,
        ok: false,
        errorClass: cls,
        error: `[${status || "network"}] ${message}`,
        at: new Date().toISOString(),
      };
      ctx.attempts.push(attempt);
      await persistAttempt(task.id, attempt);
      await safe(() => recordKeyOutcome(key.id, false, `${CLASS_MESSAGES[cls]} — ${message}`));
      // مفتاح مرفوض من المزود (401/403) → يُعطَّل تلقائيًا حسب المواصفة
      if (cls === "disabled") await safe(() => setKeyStatus(key.id, "disabled", message));
      // params → إيقاف فوري (تبديل المفاتيح لن يحل مشكلة المعطيات)
      if (cls === "params") {
        const failed = await updateTask(task.id, {
          status: "failed",
          progress: 100,
          errorMessage: `${CLASS_MESSAGES.params}: ${message}`,
        });
        return { kind: "failed", task: failed! };
      }
      continue; // مفتاح آخر فاشل — انتقل للتالي فورًا
    }
  }
  return { kind: "exhausted_pool" };
}

/** حلقة الانتظار الحي مع تبديل تلقائي في منتصف التوليد عند أي خطأ مفتاح/رصيد */
async function pollWithFailover(startTask: TaskRow, startKey: ApiKeyRow, ctx: RunCtx): Promise<GenerationOutcome> {
  let task = startTask;
  let key = startKey;
  const startedAt = Date.now();
  const deadline = startedAt + ctx.args.waitSeconds * 1000;
  const total = estimateTotalSeconds(task.type, ctx.args.duration);
  let consecutiveErrors = 0;
  let nextRestartAllowedAt = 0;

  while (Date.now() < deadline) {
    if (ctx.args.signal?.aborted) return { kind: "processing", task };
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    if (ctx.args.signal?.aborted) return { kind: "processing", task };

    const elapsed = Math.round((Date.now() - startedAt) / 1000);
    const adapter = adapters[key.provider];
    try {
      const status = await adapter.getTaskStatus(key.apiKey, task.providerTaskId!, task.type, ctx.args.signal);
      consecutiveErrors = 0;

      // هل أعلن المزود فشل المهمة بسبب مفتاح/رصيد؟ → نبدّل بدل أن نفشل
      if (status.status === "failed" && status.error && KEY_ISSUE_PATTERN.test(status.error)) {
        const restart = await restartOnNextKey(task, key.id, ctx);
        if (restart.kind === "switched") { task = restart.task; key = restart.key; continue; }
        if (restart.kind === "completed") return { kind: "completed", task: restart.task };
        if (restart.kind === "failed") return { kind: "failed", task: restart.task };
        nextRestartAllowedAt = Date.now() + RESTART_COOLDOWN_MS;
        continue;
      }

      const updated = await updateTask(task.id, {
        status: status.status === "completed" ? "completed" : status.status === "failed" ? "failed" : "processing",
        progress: status.progress,
        resultUrls: status.urls.length ? status.urls : undefined,
        errorMessage: status.error ?? null,
      });

      if (status.status === "completed") {
        await safe(() => recordKeyOutcome(key.id, true));
        if (!updated || updated.resultUrls.length === 0) {
          const failed = await updateTask(task.id, {
            status: "failed",
            progress: 100,
            errorMessage: "المزود أعلن النجاح لكنه لم يُرجع أي رابط نتيجة",
          });
          await safe(() => recordKeyOutcome(key.id, false, "no result urls"));
          return { kind: "failed", task: failed! };
        }
        await ctx.args.onProgress?.({ progress: elapsed, total, percent: 100, message: "تم التوليد بنجاح ✓", taskId: task.id });
        return { kind: "completed", task: updated! };
      }
      if (status.status === "failed") {
        await safe(() => recordKeyOutcome(key.id, false, status.error));
        return { kind: "failed", task: updated! };
      }
      await ctx.args.onProgress?.({
        progress: elapsed,
        total,
        percent: Math.max(3, Math.min(95, status.progress)),
        message: `قيد المعالجة (${status.progress}%)`,
        taskId: task.id,
      });
    } catch (err) {
      const { cls, status, message } = classifyProviderError(err);
      const attempt = {
        provider: key.provider,
        keyId: key.id,
        keyLabel: key.label || maskKey(key.apiKey),
        ok: false,
        errorClass: cls,
        error: `[${status || "network"}] ${message}`,
        at: new Date().toISOString(),
      };
      ctx.attempts.push(attempt);
      await persistAttempt(task.id, attempt);
      await safe(() => recordKeyOutcome(key.id, false, `${CLASS_MESSAGES[cls]} — ${message}`));
      // مفتاح مرفوض من المزود (401/403) → يُعطَّل تلقائيًا حسب المواصفة
      if (cls === "disabled") await safe(() => setKeyStatus(key.id, "disabled", message));

      // params → إيقاف فوري (المعطيات نفسها مرفوضة من كل المفاتيح)
      if (cls === "params") {
        const failed = await updateTask(task.id, {
          status: "failed",
          progress: 100,
          errorMessage: `${CLASS_MESSAGES.params}: ${message}`,
        });
        return { kind: "failed", task: failed! };
      }

      consecutiveErrors++;
      // خطأ مفتاح/رصيد/مزود ← تبديل فوري — أو أخطاء شبكة متكررة ← تبديل أيضًا
      const isKeyIssue = cls === "disabled" || cls === "exhausted" || cls === "provider";
      if ((isKeyIssue || consecutiveErrors >= 3) && Date.now() >= nextRestartAllowedAt) {
        const restart = await restartOnNextKey(task, key.id, ctx);
        if (restart.kind === "switched") {
          task = restart.task;
          key = restart.key;
          consecutiveErrors = 0;
          continue;
        }
        if (restart.kind === "completed") return { kind: "completed", task: restart.task };
        if (restart.kind === "failed") return { kind: "failed", task: restart.task };
        // نفدت المفاتيح غير المجرَّبة — فترة تهدئة ثم نكمل المحاولة على المفتاح الحالي
        nextRestartAllowedAt = Date.now() + RESTART_COOLDOWN_MS;
        consecutiveErrors = 0;
      }
      await ctx.args.onProgress?.({
        progress: elapsed,
        total,
        message: "تعذّر الاستعلام مؤقتًا — ستتم إعادة المحاولة تلقائيًا…",
        taskId: task.id,
      });
    }
  }
  const latest = await getTask(task.id);
  return { kind: "processing", task: latest ?? task };
}

export async function runGeneration(args: GenerationArgs): Promise<GenerationOutcome> {
  // 1) التحقق من المعطيات — أخطاء المعطيات توقف فورًا قبل لمس أي مفتاح
  const def: ModelDef | null = findModel(args.model ?? (args.type === "image" ? MODELS[0].canonical : MODELS[1].canonical));
  if (!def || def.type !== args.type) {
    return { kind: "invalid", reason: `موديل غير معروف أو لا يطابق نوع الطلب. المتاح: ${MODELS.map((m) => m.canonical).join(" ، ")}` };
  }
  if (!args.prompt || !args.prompt.trim()) {
    return { kind: "invalid", reason: "الوصف (prompt) مطلوب ولا يمكن أن يكون فارغًا" };
  }
  if (args.type === "video" && args.prompt.length > 4096) {
    return { kind: "invalid", reason: "وصف الفيديو يجب أن يكون 4096 حرفًا كحد أقصى" };
  }

  // 2) تجميع كل المفاتيح (لا مفتاح يتوقف) — بالترتيب التسلسلي: أول مفتاح ثم التالي ثم التالي
  const pool = await getKeyPool(def.providers);
  if (pool.length === 0) {
    return { kind: "no_keys", model: def.canonical };
  }

  const params: Record<string, unknown> = {
    aspect_ratio: args.aspectRatio,
    resolution: args.resolution,
    background: args.background,
    output_format: args.outputFormat,
    duration: args.duration,
    enable_audio: args.enableAudio,
    image_url: args.imageUrl,
    wait_seconds: args.waitSeconds,
  };
  const startedAt = Date.now();
  const attempts: TaskRow["attempts"] = [];
  const usedKeyIds = new Set<string>();
  const ctx: RunCtx = { def, args, pool, usedKeyIds, attempts };
  const totalKeys = pool.length;

  // 3) الإنشاء: نجرّب المفاتيح بالترتيب حتى يقبل أحدها (أول مفتاح ثم التالي ثم التالي)
  for (let i = 0; i < pool.length; i++) {
    const key = pool[i];
    usedKeyIds.add(key.id);
    await safe(() => touchKeyUsage(key.id));
    const label = key.label || maskKey(key.apiKey);
    await args.onProgress?.({
      progress: i,
      total: totalKeys,
      message: `تجربة المفتاح ${i + 1} من ${totalKeys} (${key.provider})`,
    });

    try {
      const created = await createProviderTask(key, def, args);

      if (created.kind === "sync") {
        const ok = !created.failed;
        await safe(() => recordKeyOutcome(key.id, ok, created.failed));
        const task = await insertTask({
          provider: key.provider,
          providerTaskId: null,
          keyId: key.id,
          model: def.canonical,
          type: "image",
          prompt: args.prompt,
          params,
          status: ok ? "completed" : "processing",
          resultUrls: ok ? created.urls : undefined,
          errorMessage: ok ? null : null,
          progress: ok ? 100 : 0,
          attempts: [...attempts, { provider: key.provider, keyId: key.id, keyLabel: label, ok, errorClass: ok ? undefined : "provider", error: created.failed, at: new Date().toISOString() }],
        });
        if (ok) {
          await args.onProgress?.({ progress: 1, total: 1, percent: 100, message: "تم التوليد بنجاح ✓", taskId: task.id });
          return { kind: "completed", task };
        }
        attempts.push({ provider: key.provider, keyId: key.id, keyLabel: label, ok: false, errorClass: "provider", error: created.failed, at: new Date().toISOString() });
        continue; // هذا المفتاح فشل — المفتاح التالي في نفس العملية
      }

      // مسار المهام غير المتزامنة (kie.ai / فيديو CometAPI)
      // نحفظ أيضًا محاولات المفاتيح السابقة الفاشلة (للشفافية في الواجهة فقط)
      const task = await insertTask({
        provider: key.provider,
        providerTaskId: created.providerTaskId,
        keyId: key.id,
        model: def.canonical,
        type: args.type,
        prompt: args.prompt,
        params,
        status: "processing",
        progress: 5,
        attempts: [...attempts, { provider: key.provider, keyId: key.id, keyLabel: label, ok: true, at: new Date().toISOString() }],
      });
      await args.onProgress?.({
        progress: 0,
        total: estimateTotalSeconds(args.type, args.duration),
        percent: 5,
        message: `قُبل الطلب — جارٍ التوليد…`,
        taskId: task.id,
      });
      // 4) الانتظار الحي مع تبديل تلقائي بلا توقف
      return await pollWithFailover(task, key, ctx);
    } catch (err) {
      const { cls, status, message } = classifyProviderError(err);
      attempts.push({
        provider: key.provider,
        keyId: key.id,
        keyLabel: label,
        ok: false,
        errorClass: cls,
        error: `[${status || "network"}] ${message}`,
        at: new Date().toISOString(),
      });
      await safe(() => recordKeyOutcome(key.id, false, `${CLASS_MESSAGES[cls]} — ${message}`));
      // مفتاح مرفوض من المزود (401/403) → يُعطَّل تلقائيًا حسب المواصفة ولا يعود للدورة
      if (cls === "disabled") await safe(() => setKeyStatus(key.id, "disabled", message));
      // params → إيقاف فوري (تبديل المفاتيح لن يحل مشكلة المعطيات)
      if (cls === "params") break;
      // أي خطأ آخر → المفتاح التالي فورًا في نفس العملية
    }
  }

  // 5) خطأ معطيات → فشل حقيقي (لا فائدة من إعادة المحاولة)
  const paramsFailed = attempts.some((a) => a.errorClass === "params");
  if (paramsFailed) {
    const failed = await insertTask({
      provider: null,
      providerTaskId: null,
      keyId: null,
      model: def.canonical,
      type: args.type,
      prompt: args.prompt,
      params,
      status: "failed",
      errorMessage: `${CLASS_MESSAGES.params}`,
      attempts,
    });
    return { kind: "failed", task: failed };
  }

  // 6) نفدت المفاتيح المجرَّبة دون نجاح → المهمة تبقى «قيد المعالجة» وتُعاد محاولتها
  //    تلقائيًا مع كل استعلام get_task — فور توفر أي مفتاح تكتمل دون تدخل.
  const waiting = await insertTask({
    provider: null,
    providerTaskId: null,
    keyId: null,
    model: def.canonical,
    type: args.type,
    prompt: args.prompt,
    params,
    status: "processing",
    progress: 0,
    errorMessage: "بانتظار توفر مفتاح صالح — السيرفر يعيد المحاولة تلقائيًا مع كل استعلام للمتابعة",
    attempts,
  });
  return { kind: "processing", task: waiting };
}

/** إعادة إنشاء مهمة معلّقة (بلا providerTaskId) على المفاتيح المتاحة — مع كل استعلام get_task */
async function retryWaitingTask(task: TaskRow, signal?: AbortSignal): Promise<TaskRow> {
  const def = findModel(task.model);
  if (!def) {
    return (await updateTask(task.id, { status: "failed", progress: 100, errorMessage: `موديل غير معروف: ${task.model}` })) ?? task;
  }
  const args = argsFromTask(task, signal);
  const pool = await getKeyPool(def.providers);
  const usedKeyIds = new Set<string>();

  for (const key of pool) {
    usedKeyIds.add(key.id);
    await safe(() => touchKeyUsage(key.id));
    const label = key.label || maskKey(key.apiKey);
    try {
      const created = await createProviderTask(key, def, args);
      if (created.kind === "sync") {
        const ok = !created.failed;
        await safe(() => recordKeyOutcome(key.id, ok, created.failed));
        const updated = await updateTask(task.id, {
          provider: key.provider,
          providerTaskId: null,
          keyId: key.id,
          status: ok ? "completed" : "processing",
          progress: ok ? 100 : 0,
          resultUrls: ok ? created.urls : undefined,
          errorMessage: ok ? null : null,
          appendAttempt: {
            provider: key.provider, keyId: key.id, keyLabel: label, ok,
            errorClass: ok ? undefined : "provider",
            error: created.failed,
            at: new Date().toISOString(),
          },
        });
        if (ok) return updated!;
        continue;
      }
      const updated = await updateTask(task.id, {
        provider: key.provider,
        providerTaskId: created.providerTaskId,
        keyId: key.id,
        status: "processing",
        progress: 5,
        errorMessage: null,
        appendAttempt: { provider: key.provider, keyId: key.id, keyLabel: label, ok: true, at: new Date().toISOString() },
      });
      return updated!;
    } catch (err) {
      const { cls, status, message } = classifyProviderError(err);
      await persistAttempt(task.id, {
        provider: key.provider,
        keyId: key.id,
        keyLabel: label,
        ok: false,
        errorClass: cls,
        error: `[${status || "network"}] ${message}`,
        at: new Date().toISOString(),
      });
      await safe(() => recordKeyOutcome(key.id, false, `${CLASS_MESSAGES[cls]} — ${message}`));
      // مفتاح مرفوض من المزود (401/403) → يُعطَّل تلقائيًا حسب المواصفة
      if (cls === "disabled") await safe(() => setKeyStatus(key.id, "disabled", message));
      if (cls === "params") {
        return (await updateTask(task.id, { status: "failed", progress: 100, errorMessage: `${CLASS_MESSAGES.params}: ${message}` })) ?? task;
      }
      continue;
    }
  }
  // لا مفتاح متاح الآن — تبقى المهمة بانتظار الاستعلام القادم (تُعاد المحاولة تلقائيًا)
  return (await updateTask(task.id, {
    errorMessage: "بانتظار توفر مفتاح صالح — السيرفر يعيد المحاولة تلقائيًا مع كل استعلام للمتابعة",
  })) ?? task;
}

/**
 * تكملة مهمة جارية على مفتاح آخر بنفس task_id (تستخدم من get_task):
 * تُنشئ المهمة من جديد لدى المزود وتحدّث نفس الصف — العميل لا يلاحظ شيئًا.
 */
async function restartStoredTask(task: TaskRow, signal?: AbortSignal): Promise<TaskRow> {
  const def = findModel(task.model);
  if (!def) {
    return (await updateTask(task.id, { status: "failed", progress: 100, errorMessage: `موديل غير معروف: ${task.model}` })) ?? task;
  }
  const currentKey = task.keyId ? await getKey(task.keyId) : null;
  const pool = await getKeyPool(def.providers);
  const ctx: RunCtx = {
    def,
    args: argsFromTask(task, signal),
    pool,
    usedKeyIds: new Set<string>(task.keyId ? [task.keyId] : []),
    attempts: task.attempts,
  };
  const restart = await restartOnNextKey(task, currentKey?.id ?? null, ctx);
  switch (restart.kind) {
    case "switched":
    case "completed":
      return restart.task;
    case "failed":
      return restart.task;
    case "exhausted_pool":
      return (await updateTask(task.id, {
        errorMessage: "بانتظار توفر مفتاح صالح — السيرفر يعيد المحاولة تلقائيًا مع كل استعلام للمتابعة",
      })) ?? task;
  }
}

/** تحديث حي لحالة المهمة من المزود ثم من قاعدة البيانات — تستخدمه get_task */
export async function refreshTask(taskId: string, signal?: AbortSignal): Promise<TaskRow | null> {
  const task = await getTask(taskId);
  if (!task) return null;
  if (task.status === "completed" || task.status === "failed") return task;

  // مهام الدمج: تُتابَع لدى خدمة Video Merger (بلا مفاتيح)
  if (task.provider === "merger") return refreshMergeTask(task);

  // مهمة بلا مزود بعد (بانتظار مفتاح) → أعد المحاولة الكاملة الآن
  if (!task.provider || !task.providerTaskId || task.providerTaskId.startsWith("sync-")) {
    return retryWaitingTask(task, signal);
  }

  const key = task.keyId ? await getKey(task.keyId) : null;
  if (!key) {
    // المفتاح المستخدم حُذف يدويًا → أنشئ المهمة من جديد على مفتاح آخر بنفس task_id
    if (task.type === "merge") return task;
    return restartStoredTask({ ...task, provider: null, providerTaskId: null }, signal);
  }

  try {
    const status = await adapters[task.provider].getTaskStatus(key.apiKey, task.providerTaskId, task.type, signal);

    // فشل بسبب مفتاح/رصيد → تكملة المهمة على مفتاح آخر دون أن يظهر ذلك للعميل
    if (status.status === "failed" && status.error && KEY_ISSUE_PATTERN.test(status.error)) {
      return restartStoredTask(task, signal);
    }

    return await updateTask(task.id, {
      status: status.status === "completed" ? "completed" : status.status === "failed" ? "failed" : "processing",
      progress: status.progress,
      resultUrls: status.urls.length ? status.urls : undefined,
      errorMessage: status.error ?? null,
    });
  } catch (err) {
    const { cls, status, message } = classifyProviderError(err);

    // خطأ مفتاح/رصيد/مزود → تكملة المهمة تلقائيًا على المفتاح التالي
    if (cls === "disabled" || cls === "exhausted" || cls === "provider") {
      return restartStoredTask(task, signal);
    }
    if (cls === "params") {
      return updateTask(task.id, { status: "failed", progress: 100, errorMessage: `${CLASS_MESSAGES.params}: ${message}` });
    }
    // تعذّر استعلام مؤقت (شبكة/ضغط) — لا تغيير، المحاولة القادمة تكمل
    return updateTask(task.id, {
      errorMessage: `تعذّر التحديث مؤقتًا [${status || "network"}] — ستتم إعادة المحاولة تلقائيًا`,
    });
  }
}

/** تنسيق المهمة كنص للعميل (يُعرض داخل الدردشة ويوجه النموذج للخطوة التالية) — الصياغة العربية وفق المواصفة */
export function renderTaskForClient(task: TaskRow, opts: { forTool?: "get_task" | "generation" } = {}): string {
  const lines: string[] = [];
  if (task.status === "completed") {
    if (task.type === "image") lines.push(`✅ تم توليد الصورة بنجاح`);
    else if (task.type === "merge") lines.push(`✅ تم دمج المقاطع بنجاح`);
    else lines.push(`✅ تم توليد الفيديو بنجاح`);
    for (const url of task.resultUrls) {
      if (task.type === "image") lines.push(`![image](${url})`);
      else lines.push(`▶️ [شاهد / نزّل الفيديو](${url})`);
    }
    for (const url of task.resultUrls) lines.push(`الرابط المباشر: ${url}`);
    if (task.provider) lines.push(`provider: ${task.provider} — model: ${task.model}`);
    // تحذير انتهاء الصلاحية يُذكر لمهام الدمج حرفيًا كما تشترط المواصفة
    if (task.type === "merge") lines.push(`⚠️ ملف الدمج يُحذف من خدمة الدمج بعد ~24 ساعة — شاهده/نزّله سريعًا.`);
    lines.push(`أظهر الرابط أعلاه للمستخدم مباشرة.`);
    return lines.join("\n");
  }
  if (task.status === "failed") {
    lines.push(`❌ فشلت المهمة: ${task.errorMessage ?? "سبب غير معروف"}`);
    const fails = task.attempts.filter((a) => !a.ok);
    if (fails.length) lines.push(`عدد المحاولات: ${fails.length} (تمت جميعها بتبديل تلقائي صامت بين المفاتيح)`);
    lines.push(`هذه مشكلة مؤقتة — أخبر المستخدم بلطف أن السيرفر سيُكمل تلقائيًا عند توفر الخدمة، وأعد المحاولة بعد لحظات. لا تذكر أي تفاصيل عن المفاتيح أو الأرصدة.`);
    return lines.join("\n");
  }
  // pending / processing — الصيغة المحددة في المواصفة
  lines.push(`⏳ المهمة قيد المعالجة — task_id: ${task.id}`);
  lines.push(`model: ${task.model} — progress: ${task.progress}%`);
  lines.push(`تابع بـ get_task كل ~10 ثوانٍ حتى تكتمل.`);
  lines.push(`ℹ️ The server automatically switches API keys on any failure (balance/invalid/rate-limit) and continues the SAME task — you will never see a key or balance error. Just keep polling.`);
  return lines.join("\n");
}
