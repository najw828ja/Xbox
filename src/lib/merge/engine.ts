/**
 * محرك الدمج: تنزيل/تجميع المصادر → ffprobe → filter_complex موحّد → ترميز → تخزين الناتج.
 * يعمل داخل المشروع نفسه (Node runtime) — لا خدمة خارجية.
 */
import fs from "fs";
import os from "os";
import path from "path";
import { spawn } from "child_process";
import { mergeConfig as config } from "./config";
import * as store from "./store";
import { getFfmpeg, getFfprobe, ffprobeFile } from "./ffmpeg";
import {
  buildEditFilterGraph,
  effectiveDurations,
  parseEditPlan,
  sourceInputArgs,
  type EditPlan,
} from "./edit";

// ---------- تنزيل من رابط مباشر مع عدّ البايتات والتحقق من الحد ----------

export async function downloadToFile(url: string, dest: string, maxBytes: number, onBytes?: (n: number) => void): Promise<number> {
  let res: Response;
  try {
    res = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(120_000) });
  } catch {
    throw new Error(`تعذّر الوصول إلى الرابط: ${url}`);
  }
  if (!res.ok) throw new Error(`فشل تنزيل المصدر (الحالة ${res.status}): ${url}`);
  if (!res.body) throw new Error(`مصدر بلا محتوى: ${url}`);

  const declared = parseInt(res.headers.get("content-length") || "0", 10);
  if (declared && declared > maxBytes) {
    throw new Error(`حجم المصدر (${(declared / 1048576).toFixed(1)}MB) يتجاوز الحد المسموح`);
  }

  const out = fs.createWriteStream(dest);
  let count = 0;
  const reader = res.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    count += value.length;
    if (count > maxBytes) {
      out.destroy();
      reader.cancel().catch(() => {});
      throw new Error(`حجم المصدر يتجاوز الحد المسموح (${config.sourceMaxBytes / 1048576}MB)`);
    }
    if (onBytes) onBytes(count);
    await new Promise((r) => out.write(Buffer.from(value), r));
  }
  await new Promise((r) => out.end(r));
  return count;
}

// ---------- حساب الدقة الهدف ----------

function targetResolution(w: number, h: number): { W: number; H: number } {
  // نأخذ أكبر دقة بين المدخلات بحد أقصى 1920×1080، وأبعاد زوجية
  let W = Math.min(Math.max(w, 2), config.maxResW);
  let H = Math.min(Math.max(h, 2), config.maxResH);
  if (W % 2) W -= 1;
  if (H % 2) H -= 1;
  return { W, H };
}

// ---------- بناء filter_complex ----------

export function buildFilterGraph(probes: { width: number; height: number; duration: number; hasAudio: boolean }[]): {
  filter: string;
  W: number;
  H: number;
} {
  const { W, H } = targetResolution(
    Math.max(...probes.map((p) => p.width)),
    Math.max(...probes.map((p) => p.height))
  );
  const filters: string[] = [];
  const concatPairs: string[] = [];
  let lavfiIdx = probes.length; // مدخلات anullsrc تُضاف بعد الملفات

  probes.forEach((p, i) => {
    filters.push(
      `[${i}:v]scale=${W}:${H}:force_original_aspect_ratio=decrease,` +
        `pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2,` +
        `fps=${config.fps},setsar=1,format=yuv420p[v${i}]`
    );
    if (p.hasAudio) {
      filters.push(`[${i}:a]aresample=${config.audioRate},aformat=sample_fmts=fltp:channel_layouts=stereo[a${i}]`);
    } else {
      // مصدر بلا صوت → مسار صامت anullsrc بنفس مدته
      filters.push(
        `[${lavfiIdx}:a]atrim=0:${p.duration.toFixed(3)},asetpts=PTS-STARTPTS,aformat=sample_fmts=fltp:channel_layouts=stereo[a${i}]`
      );
      lavfiIdx += 1;
    }
    concatPairs.push(`[v${i}][a${i}]`);
  });

  filters.push(`${concatPairs.join("")}concat=n=${probes.length}:v=1:a=1[vout][aout]`);
  return { filter: filters.join(";"), W, H };
}

// ---------- ترميز مع قراءة التقدم ----------

function encodeWithProgress(
  binPath: string,
  args: string[],
  totalDurationSec: number,
  onProgress?: (pct: number) => Promise<void> | void
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(binPath, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stderrTail = "";
    let lastPct = -1;
    child.stdout.on("data", (d: Buffer) => {
      const s = d.toString();
      const m = s.match(/out_time_us=(\d+)/);
      if (m && totalDurationSec > 0 && onProgress) {
        const ratio = Math.min(1, parseInt(m[1], 10) / (totalDurationSec * 1e6));
        const pct = 40 + Math.floor(ratio * 50); // 40→90 الترميز
        if (pct > lastPct) {
          lastPct = pct;
          onProgress(pct);
        }
      }
    });
    child.stderr.on("data", (d: Buffer) => {
      stderrTail = (stderrTail + d.toString()).slice(-4000);
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else
        reject(
          new Error(
            `فشل الترميز (ffmpeg غادر بالكود ${code})${stderrTail ? ": " + stderrTail.split("\n").slice(-3).join(" | ") : ""}`
          )
        );
    });
  });
}

// ---------- دمج ملفات محلية ----------

export interface MergeLocalResult {
  outPath: string;
  size: number;
  duration: number;
  width: number;
  height: number;
  hasAudio: boolean;
  W: number;
  H: number;
  totalDur: number;
}

export async function mergeLocalFiles(
  files: string[],
  onProgress?: (pct: number) => Promise<void> | void,
  plan?: EditPlan
): Promise<MergeLocalResult> {
  if (!files.length) throw new Error("لا توجد مصادر للدمج");
  const ffmpeg = await getFfmpeg();
  const ffprobe = await getFfprobe();

  const probes = [];
  for (const f of files) probes.push(await ffprobeFile(f));

  // المدد الفعلية: مع خطة تحرير تُحسب بعد القصّ (تحقق دلالي صارم)، وإلا مدد المصادر كاملة (مسار Phase 1 حرفيًا)
  let durations = probes.map((p) => p.duration);
  let inputArgs: string[][] = files.map(() => []);
  let graph: { filter: string; W: number; H: number; vOut: string; aOut: string };
  if (plan) {
    durations = effectiveDurations(probes, plan);
    inputArgs = sourceInputArgs(plan, files.length, durations);
    graph = buildEditFilterGraph(probes, plan);
  } else {
    graph = { ...buildFilterGraph(probes), vOut: "vout", aOut: "aout" };
  }

  const totalDur = durations.reduce((a, d) => a + d, 0);
  if (totalDur > config.maxTotalDurationSec) {
    throw new Error(
      `المدة الإجمالية (${totalDur.toFixed(1)} ثانية) تتجاوز الحد المسموح (${config.maxTotalDurationSec} ثانية)`
    );
  }

  const outPath = path.join(os.tmpdir(), `vm-out-${Date.now()}-${Math.random().toString(36).slice(2)}.mp4`);

  const args: string[] = ["-hide_banner", "-loglevel", "error", "-y", "-nostdin"];
  for (let i = 0; i < files.length; i++) args.push(...inputArgs[i], "-i", files[i]);
  for (let i = 0; i < probes.length; i++) {
    if (!probes[i].hasAudio) {
      args.push("-f", "lavfi", "-t", durations[i].toFixed(3), "-i", `anullsrc=channel_layout=stereo:sample_rate=${config.audioRate}`);
    }
  }
  args.push(
    "-filter_complex",
    graph.filter,
    "-map",
    `[${graph.vOut}]`,
    "-map",
    `[${graph.aOut}]`,
    "-c:v",
    "libx264",
    "-crf",
    String(config.crf),
    "-preset",
    config.ffmpegPreset,
    "-c:a",
    "aac",
    "-b:a",
    config.audioBitrate,
    "-ar",
    String(config.audioRate),
    "-movflags",
    "+faststart",
    "-progress",
    "pipe:1",
    "-nostats",
    outPath
  );

  try {
    await encodeWithProgress(ffmpeg, args, totalDur, onProgress);
    const st = fs.statSync(outPath);
    if (st.size > config.outputMaxBytes) {
      throw new Error(`حجم الناتج (${(st.size / 1048576).toFixed(1)}MB) يتجاوز الحد المسموح (${config.outputMaxBytes / 1048576}MB)`);
    }
    const probe = await ffprobeFile(outPath);
    return {
      outPath,
      size: st.size,
      duration: probe.duration,
      width: probe.width,
      height: probe.height,
      hasAudio: probe.hasAudio,
      W: graph.W,
      H: graph.H,
      totalDur,
    };
  } catch (e) {
    try {
      fs.unlinkSync(outPath);
    } catch {
      /* تجاهل */
    }
    throw e;
  }
}

// ---------- تنفيذ مهمة كاملة: من قاعدة البيانات إلى الناتج المخزّن ----------

export interface ProcessJobResult {
  size: number;
  duration: number;
  resolution: string;
}

type CodedError = Error & { code?: number };

export async function processJob(jobId: string): Promise<ProcessJobResult> {
  const job = await store.getJob(jobId);
  if (!job) {
    const e: CodedError = Object.assign(new Error("المهمة غير موجودة"), { code: 404 });
    throw e;
  }

  const sources = (await store.getSources(jobId)).map((r) => ({
    seq: Number(r.seq),
    kind: r.kind === null ? undefined : String(r.kind),
    url: r.url === null ? undefined : String(r.url),
    name: r.name === null ? undefined : String(r.name),
    size: r.size === null ? null : Number(r.size),
    mime: r.mime === null ? undefined : String(r.mime),
    status: String(r.status),
  }));
  if (!sources.length) {
    const e: CodedError = Object.assign(new Error("لا توجد مصادر في هذه المهمة"), { code: 400 });
    throw e;
  }

  // خطة تحرير اختيارية (Phase 2) — غائبة = مسار الدمج القياسي حرفيًا
  let plan: EditPlan | undefined;
  if (job.ops_json) {
    let raw: unknown;
    try {
      raw = JSON.parse(String(job.ops_json));
    } catch {
      const e: CodedError = Object.assign(new Error("خطة التحرير المخزنة تالفة (JSON غير صالح)"), { code: 400 });
      throw e;
    }
    const parsed = parseEditPlan(raw);
    if (!parsed.ok) {
      const e: CodedError = Object.assign(new Error(`خطة التحرير المخزنة مرفوضة: ${parsed.error}`), { code: 400 });
      throw e;
    }
    plan = parsed.plan;
  }

  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "vm-job-"));
  try {
    await store.updateJob(jobId, { status: "processing", progress: 1, error: null });

    // المرحلة 1: سحب المصادر (0→40)
    const localFiles: string[] = [];
    const probes = [];
    const perSource = 40 / sources.length;

    for (let i = 0; i < sources.length; i++) {
      const s = sources[i];
      const srcPath = path.join(workDir, `src-${i}.bin`);
      if (s.kind === "url") {
        await store.updateSource(jobId, s.seq, { status: "downloading" });
        await store.updateJob(jobId, { progress: Math.min(39, Math.round(i * perSource)) });
        const bytes = await downloadToFile(s.url!, srcPath, config.sourceMaxBytes);
        if (bytes === 0) throw new Error(`المصدر فارغ: ${s.url}`);
        await store.updateSource(jobId, s.seq, { status: "ready", size: bytes });
      } else {
        const buf = await store.readSourceFile(jobId, s.seq, s.size);
        if (buf.length > config.sourceMaxBytes) {
          const e: CodedError = Object.assign(
            new Error(
              `حجم المصدر (${(buf.length / 1048576).toFixed(1)}MB) يتجاوز الحد المسموح (${config.sourceMaxBytes / 1048576}MB)`
            ),
            { code: 413 }
          );
          throw e;
        }
        fs.writeFileSync(srcPath, buf);
      }
      localFiles.push(srcPath);
      const probe = await ffprobeFile(srcPath);
      probes.push(probe);
      await store.updateSource(jobId, s.seq, {
        duration: probe.duration,
        width: probe.width,
        height: probe.height,
        has_audio: probe.hasAudio ? 1 : 0,
      });
      await store.updateJob(jobId, { progress: Math.min(40, Math.round((i + 1) * perSource)) });
    }

    // التحقق من المدة الإجمالية قبل الترميز — مع خطة تحرير تُحسب بعد القصّ (أخطاء الخطة ← 400)
    let durations = probes.map((p) => p.duration);
    if (plan) {
      try {
        durations = effectiveDurations(probes, plan);
        buildEditFilterGraph(probes, plan); // تحقق كامل من الرسم قبل التنفيذ
      } catch (err) {
        const e: CodedError = Object.assign(
          new Error(err instanceof Error && err.message ? err.message : "خطة التحرير غير صالحة"),
          { code: 400 }
        );
        throw e;
      }
    }
    const totalDur = durations.reduce((a, d) => a + d, 0);
    if (totalDur > config.maxTotalDurationSec) {
      const e: CodedError = Object.assign(
        new Error(`المدة الإجمالية (${totalDur.toFixed(1)} ثانية) تتجاوز الحد المسموح (${config.maxTotalDurationSec} ثانية)`),
        { code: 413 }
      );
      throw e;
    }

    // المرحلة 2: الترميز (40→90)
    await store.updateJob(jobId, { progress: 40 });
    const result = await mergeLocalFiles(localFiles, async (pct) => {
      await store.updateJob(jobId, { progress: Math.min(90, pct) });
    }, plan);

    // المرحلة 3: تخزين الناتج (90→100)
    await store.updateJob(jobId, { progress: 91 });
    const buf = fs.readFileSync(result.outPath);
    await store.saveOutputBlob(jobId, buf);
    await store.deleteSourceChunks(jobId); // بعد النجاح: الناتج فقط هو المطلوب
    await store.updateJob(jobId, {
      status: "done",
      progress: 100,
      error: null,
      output_size: result.size,
      output_duration: result.duration,
      output_width: result.width,
      output_height: result.height,
      output_mime: "video/mp4",
    });
    try {
      fs.unlinkSync(result.outPath);
    } catch {
      /* تجاهل */
    }

    return {
      size: result.size,
      duration: result.duration,
      resolution: `${result.width}x${result.height}`,
    };
  } catch (e) {
    const msg = e instanceof Error && e.message ? e.message : "فشل غير معروف أثناء الدمج";
    try {
      await store.updateJob(jobId, { status: "failed", error: msg });
    } catch {
      /* تجاهل */
    }
    throw e;
  } finally {
    // نظّف /tmp دائمًا
    try {
      fs.rmSync(workDir, { recursive: true, force: true });
    } catch {
      /* تجاهل */
    }
  }
}
