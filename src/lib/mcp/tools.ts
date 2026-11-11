/**
 * أدوات MCP الخمسة:
 * - generate_image : توليد صورة (gpt-image-2-6/flare-text-to-image)
 * - generate_video : توليد فيديو (grok-imagine-video-1-5-preview)
 * - merge_videos   : دمج عدة فيديوهات في مقطع واحد (خدمة Video Merger)
 * - get_task       : متابعة حالة أي مهمة من قاعدة البيانات (استعلام كل ~10 ثوانٍ)
 * - list_media     : جلب أحدث الروابط المخزنة في قاعدة البيانات
 */
import { MODELS } from "../models";
import { runGeneration, refreshTask, renderTaskForClient, type ProgressCb } from "../generator";
import { runMerge } from "../merger";
import { getTask, listRecentTasks } from "../tasks";

export interface ToolDef {
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export const TOOLS: ToolDef[] = [
  {
    name: "generate_image",
    title: "Generate image",
    description:
      "Generate an AI image from a text prompt using gpt-image-2-6/flare-text-to-image (auto-switches across all active API keys/providers). " +
      "Returns the finished image URL (markdown) inline when ready within the wait window; otherwise returns a task_id — " +
      "in that case call get_task with that task_id every ~10 seconds until status is completed, then show the image URL to the user and stop.",
    inputSchema: {
      type: "object",
      properties: {
        prompt: { type: "string", description: "What to draw. Detailed prompts give better results.", minLength: 1 },
        model: {
          type: "string",
          enum: ["gpt-image-2-6/flare-text-to-image", "gpt-image-2.6/flare-text-to-image"],
          default: "gpt-image-2-6/flare-text-to-image",
          description: "Image model (both spellings are accepted and normalized).",
        },
        aspect_ratio: {
          type: "string",
          enum: ["auto", "1:1", "3:2", "2:3", "4:3", "3:4", "5:4", "4:5", "16:9", "9:16", "2:1", "1:2", "21:9", "9:21", "3:1", "1:3"],
          default: "auto",
        },
        resolution: { type: "string", enum: ["1K", "2K", "4K"], default: "1K", description: "Output size tier." },
        background: { type: "string", enum: ["auto", "transparent", "opaque"], default: "auto", description: "Only applied at 1K." },
        output_format: { type: "string", enum: ["png", "jpeg", "webp", "gif"], default: "png" },
        wait_seconds: {
          type: "integer",
          minimum: 0,
          maximum: 240,
          default: 90,
          description: "Wait inline (sending progress updates) for the result. If it is not done in time, a task_id is returned for get_task polling.",
        },
      },
      required: ["prompt"],
    },
  },
  {
    name: "generate_video",
    title: "Generate video",
    description:
      "Generate an AI video from a text prompt (and optional starting image) using grok-imagine-video-1-5-preview (native synchronized audio, auto-switches across all active API keys/providers). " +
      "Video takes minutes: the tool waits briefly (streaming progress), then returns a task_id — " +
      "call get_task with that task_id every ~10 seconds until status is completed, then show the video URL to the user and stop polling.",
    inputSchema: {
      type: "object",
      properties: {
        prompt: { type: "string", description: "Scene description (max 4096 characters). Dialogue in the prompt is spoken in the video.", maxLength: 4096 },
        image_url: { type: "string", description: "Optional public image URL to use as the first frame (image-to-video)." },
        model: {
          type: "string",
          enum: ["grok-imagine-video-1-5-preview", "grok-imagine-video-1.5-preview"],
          default: "grok-imagine-video-1-5-preview",
          description: "Video model (both spellings are accepted and normalized).",
        },
        aspect_ratio: { type: "string", enum: ["auto", "1:1", "16:9", "9:16", "3:2", "2:3"], default: "auto" },
        resolution: { type: "string", enum: ["480p", "720p", "1080p"], default: "480p" },
        enable_audio: { type: "boolean", default: true, description: "Generate native synchronized audio (dialogue, sfx, music). On by default." },
        duration: { type: "integer", minimum: 1, maximum: 15, default: 8, description: "Duration in seconds." },
        wait_seconds: {
          type: "integer",
          minimum: 0,
          maximum: 240,
          default: 25,
          description: "How long to keep the request open streaming progress before returning the task_id.",
        },
      },
      required: ["prompt"],
    },
  },
  {
    name: "merge_videos",
    title: "Merge videos",
    description:
      "Concatenate several video clips into ONE final video (MP4 / H.264+AAC, up to 1080p), in the exact order given. " +
      "Provide 'urls' (public direct video links — e.g. the URLs returned by generate_video) OR 'task_ids' " +
      "(task_ids of completed video tasks; their stored URLs are resolved in order — perfect right after generating multiple clips). Max 10 clips. " +
      "The tool waits briefly (streaming progress), then returns a merge task_id — " +
      "call get_task with it every ~10 seconds until status is completed, then show the merged video URL and stop. " +
      "Note: the merged file is stored on the merging service for ~24 hours only — tell the user to watch/download it promptly.",
    inputSchema: {
      type: "object",
      properties: {
        urls: {
          type: "array",
          items: { type: "string" },
          minItems: 2,
          maxItems: 10,
          description: "Public direct video URLs (http/https) in merge order — the first clip starts the final video.",
        },
        task_ids: {
          type: "array",
          items: { type: "string" },
          minItems: 2,
          maxItems: 10,
          description:
            "Alternative to urls: task_ids of COMPLETED video generation tasks — their result URLs are merged in this order.",
        },
        wait_seconds: {
          type: "integer",
          minimum: 0,
          maximum: 240,
          default: 60,
          description: "Wait inline (streaming progress) for the merge to finish. Otherwise a merge task_id is returned for get_task polling.",
        },
      },
    },
  },
  {
    name: "get_task",
    title: "Get task status",
    description:
      "Track any task by its task_id — image/video generation AND video merging (reads the shared Turso database, refreshing from the provider/service when still running). " +
      "Poll it every ~10 seconds after generate_image / generate_video / merge_videos returns a task_id. When status is completed the result URLs are included — display them to the user and stop polling.",
    inputSchema: {
      type: "object",
      properties: {
        task_id: { type: "string", description: "The task_id returned by generate_image / generate_video / merge_videos." },
      },
      required: ["task_id"],
    },
  },
  {
    name: "list_media",
    title: "List stored media",
    description:
      "List recently generated images/videos and merged outputs with their stored URLs from the database (no re-generation). Useful to recall previous results by task_id.",
    inputSchema: {
      type: "object",
      properties: {
        type: { type: "string", enum: ["image", "video", "merge"], description: "Filter by media type (merge = merged videos)." },
        status: { type: "string", enum: ["completed", "failed", "processing"], description: "Filter by task status." },
        limit: { type: "integer", minimum: 1, maximum: 50, default: 10 },
      },
    },
  },
];

export interface ToolCallResult {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}

function text(t: string): ToolCallResult {
  return { content: [{ type: "text", text: t }] };
}

function clamp(n: unknown, min: number, max: number, dflt: number): number {
  const v = typeof n === "number" && Number.isFinite(n) ? Math.round(n) : NaN;
  return Number.isNaN(v) ? dflt : Math.max(min, Math.min(max, v));
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

export async function callTool(
  name: string,
  rawArgs: Record<string, unknown> | undefined,
  ctx: { sendProgress?: ProgressCb; signal?: AbortSignal }
): Promise<ToolCallResult> {
  const args = rawArgs ?? {};

  if (name === "generate_image" || name === "generate_video") {
    const type = name === "generate_image" ? "image" : "video";
    const defaultWait = type === "image" ? 90 : 25;
    const outcome = await runGeneration({
      type,
      model: str(args.model),
      prompt: str(args.prompt) ?? "",
      imageUrl: str(args.image_url),
      aspectRatio: str(args.aspect_ratio),
      resolution: str(args.resolution),
      background: str(args.background),
      outputFormat: str(args.output_format),
      duration: typeof args.duration === "number" ? args.duration : undefined,
      enableAudio: typeof args.enable_audio === "boolean" ? args.enable_audio : undefined,
      waitSeconds: clamp(args.wait_seconds, 0, 240, defaultWait),
      onProgress: ctx.sendProgress,
      signal: ctx.signal,
    });

    switch (outcome.kind) {
      case "completed":
        return text(renderTaskForClient(outcome.task));
      case "processing":
        return text(renderTaskForClient(outcome.task));
      case "failed":
        return { ...text(renderTaskForClient(outcome.task)), isError: true };
      case "invalid":
        return { ...text(`❌ ${outcome.reason}`), isError: true };
      case "no_keys":
        return {
          ...text(
            `❌ لا توجد مفاتيح نشطة لخدمة ${outcome.model}.\n` +
              `أضف مفتاحًا واحدًا على الأقل (kie.ai أو CometAPI) من واجهة الإدارة، ثم أعد المحاولة.\n` +
              `No active API keys are configured — add keys in the web dashboard and retry.`
          ),
          isError: true,
        };
    }
  }

  if (name === "merge_videos") {
    // 1) جمع الروابط: task_ids تُحلّ من قاعدة البيانات، ثم urls المباشرة تُلحق بالترتيب
    const resolved: string[] = [];
    const problems: string[] = [];
    const taskIds = Array.isArray(args.task_ids) ? args.task_ids.map((t) => String(t).trim()).filter(Boolean) : [];
    for (const tid of taskIds) {
      const t = await getTask(tid);
      if (!t) {
        problems.push(`task_id ${tid}: غير موجود في قاعدة البيانات`);
      } else if (t.status !== "completed" || t.resultUrls.length === 0) {
        problems.push(`task_id ${tid}: الحالة ${t.status} — لا يوجد رابط جاهز للدمج بعد`);
      } else {
        resolved.push(...t.resultUrls);
      }
    }
    const direct = Array.isArray(args.urls)
      ? args.urls.map((u) => String(u).trim()).filter((u) => /^https?:\/\//i.test(u))
      : [];
    const badUrls = Array.isArray(args.urls)
      ? args.urls.map((u) => String(u).trim()).filter((u) => u && !/^https?:\/\//i.test(u))
      : [];
    for (const u of badUrls) problems.push(`رابط غير صالح (يجب أن يكون http/https مباشرًا): ${u}`);

    const urls = [...resolved, ...direct];
    if (urls.length < 2) {
      const detail = problems.length ? `\nتفاصيل:\n- ${problems.join("\n- ")}` : "";
      return {
        ...text(
          `❌ الدمج يحتاج مقطعَين على الأقل. مرّر urls (روابط مباشرة) أو task_ids لمهام مكتملة (الحد الأقصى 10 مقاطع).${detail}`
        ),
        isError: true,
      };
    }
    if (urls.length > 10) {
      return {
        ...text(`❌ أقصى عدد مقاطع للدمج هو 10 (خدمة الدمج تقبل 10 مقاطع كحد أقصى).`),
        isError: true,
      };
    }

    // 2) تنفيذ الدمج عبر خدمة Video Merger (بلا مفاتيح API — الناتج MP4 حتى 1080p)
    const outcome = await runMerge({
      urls,
      waitSeconds: clamp(args.wait_seconds, 0, 240, 60),
      onProgress: ctx.sendProgress,
      signal: ctx.signal,
    });

    switch (outcome.kind) {
      case "completed":
        return text(renderTaskForClient(outcome.task));
      case "processing":
        return text(renderTaskForClient(outcome.task));
      case "failed":
        return { ...text(renderTaskForClient(outcome.task)), isError: true };
      case "invalid":
        return { ...text(`❌ ${outcome.reason}`), isError: true };
    }
  }

  if (name === "get_task") {
    const taskId = str(args.task_id);
    if (!taskId) return { ...text("❌ task_id مطلوب (required)"), isError: true };
    const task = await refreshTask(taskId, ctx.signal);
    if (!task) return { ...text(`❌ لا توجد مهمة بهذا المعرّف: ${taskId} (task not found in database)`), isError: true };
    return text(renderTaskForClient(task, { forTool: "get_task" }));
  }

  if (name === "list_media") {
    const typeRaw = str(args.type);
    const type = typeRaw === "image" || typeRaw === "video" || typeRaw === "merge" ? typeRaw : undefined;
    const status = str(args.status);
    const limit = clamp(args.limit, 1, 50, 10);
    const tasks = await listRecentTasks(limit, {
      type,
      status: status === "completed" || status === "failed" || status === "processing" ? status : undefined,
    });
    if (tasks.length === 0) return text("لا توجد مهام مخزنة بعد (database has no tasks yet).");
    const lines = tasks.map((t) => {
      const head = `• [${t.status}] ${t.type} — task_id: ${t.id} — model: ${t.model} — ${t.createdAt}`;
      if (t.status === "completed" && t.resultUrls.length) return `${head}\n  ${t.resultUrls.join("\n  ")}`;
      if (t.status === "failed") return `${head}\n  error: ${t.errorMessage ?? "?"}`;
      return head;
    });
    return text(`أحدث ${tasks.length} مهمة من قاعدة البيانات:\n\n${lines.join("\n\n")}`);
  }

  return { ...text(`❌ أداة غير معروفة: ${name}. المتاح: ${TOOLS.map((t) => t.name).join(", ")}`), isError: true };
}

export const SERVER_INFO = { name: "media-generator-mcp", version: "1.2.0" } as const;

export const SERVER_INSTRUCTIONS =
  "AI media generation server (kie.ai + CometAPI with automatic multi-key failover, plus video merging). " +
  "Workflow: call generate_image or generate_video. If the response contains finished URLs, show them to the user. " +
  "If it returns a task_id with status PROCESSING, call get_task with that task_id every ~10 seconds until status is completed (show the URL) or failed (explain why). " +
  "IMPORTANT: the server automatically switches API keys on any failure (exhausted balance, invalid key, rate limits) and continues the SAME task under the same task_id — " +
  "you will never encounter key/balance errors. Never stop or warn the user about keys or balances; just keep polling get_task until the result appears. " +
  "To concatenate several finished clips into one video, call merge_videos with 'urls' (direct links) or 'task_ids' (completed video tasks, in merge order); track it with get_task the same way. " +
  "Use list_media to recall previously generated media from the database.";

export const SUPPORTED_MODELS_TEXT = MODELS.map((m) => `${m.canonical} (${m.type})`).join(", ");
