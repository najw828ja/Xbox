/**
 * محرّك التحرير — خطة تحرير اختيارية فوق بنية مهام الدمج الموجودة (Phase 2 core).
 *
 * المبدأ: مهمة دمج بلا خطة = المسار المُتحقق منه في Phase 1 حرفيًا.
 * مهمة بخطة تحرير = نفس البنية نفسها (إنشاء/رفع/تنفيذ/حالة/ناتج) مع filter_graph مختلف.
 *
 * نموذج الخطة:
 * - source_trims: [{seq, start, end?}] — قصّ لكل مصدر قبل الدمج.
 *   يُنفَّذ بخيارات -ss/-t على المدخلات (قبل -i) → ffmpeg يفكّ ترميز الجزء المطلوب فقط.
 * - ops: سلسلة عمليات مرتّبة تُطبَّق على الخط الزمني النهائي بعد الدمج:
 *     {op:"trim", start, end?}                       → قصّ زمني (فلاتر trim/atrim — الأطر المهمَلة لا تُرمَّز)
 *     {op:"crop", aspect:"9:16"|"16:9"|"1:1", gravity?} → قصّ حاشدة (crop-fill) ثم توحيد الدقة القياسية للنسبة:
 *         9:16 → 1080x1920 ، 16:9 → 1920x1080 ، 1:1 → 1080x1080
 *     {op:"resize", width, height, mode:"fit"|"fill"} → fit = letterbox ، fill = قصّ حاشدة
 * كل شيء في تمريرة filter_complex واحدة — ترميز واحد بلا ملفات وسيطة (حماية حد 300s).
 */
import { mergeConfig } from "./config";

// ---------- الأنواع ----------

export interface SourceTrim {
  seq: number;
  start: number;
  end?: number; // غائب → حتى نهاية المصدر
}

export type EditOp =
  | { op: "trim"; start: number; end?: number }
  | { op: "crop"; aspect: "9:16" | "16:9" | "1:1"; gravity: string }
  | { op: "resize"; width: number; height: number; mode: "fit" | "fill" };

export interface EditPlan {
  ops?: EditOp[];
  source_trims?: SourceTrim[];
}

export interface ProbeInfo {
  duration: number;
}

const MAX_OPS = 10;
/** تسامح لمقارنات المدة مع تقريب ffprobe (ليس قصًّا صامتًا — أخطاء حقيقية تُرفض) */
const DUR_EPS = 0.1;
/** الدقة القياسية لكل نسبة بعد crop */
const CROP_STANDARD: Record<string, { w: number; h: number }> = {
  "9:16": { w: 1080, h: 1920 },
  "16:9": { w: 1920, h: 1080 },
  "1:1": { w: 1080, h: 1080 },
};
const GRAVITIES = ["center", "top", "bottom", "left", "right"];

function evenize(n: number): number {
  const v = Math.round(n);
  return v % 2 ? v - 1 : v;
}

function isNum(n: unknown): n is number {
  return typeof n === "number" && Number.isFinite(n);
}

// ---------- التحقق النحوي من الخطة (قبل لمس أي ملف أو مفتاح) ----------

export function parseEditPlan(raw: unknown): { ok: true; plan: EditPlan } | { ok: false; error: string } {
  if (raw === undefined || raw === null) return { ok: false, error: "خطة تحرير فارغة" };
  // قبول شكلين: مصفوفة العمليات مباشرة [{op:...}] أو كائن الخطة {ops?, source_trims?}
  if (Array.isArray(raw)) raw = { ops: raw };
  if (typeof raw !== "object") {
    return { ok: false, error: "ops يجب أن يكون كائن خطة تحرير {ops?, source_trims?} أو مصفوفة عمليات" };
  }
  const body = raw as Record<string, unknown>;
  const plan: EditPlan = {};

  // source_trims
  if (body.source_trims !== undefined && body.source_trims !== null) {
    const list = body.source_trims;
    if (!Array.isArray(list) || list.length === 0 || list.length > MAX_OPS) {
      return { ok: false, error: `source_trims يجب أن تكون مصفوفة غير فارغة بحد أقصى ${MAX_OPS} عناصر` };
    }
    const trims: SourceTrim[] = [];
    for (const t of list) {
      if (typeof t !== "object" || t === null) return { ok: false, error: "عنصر source_trims تالف (كائن مطلوب)" };
      const o = t as Record<string, unknown>;
      if (!Number.isInteger(o.seq) || (o.seq as number) < 0) {
        return { ok: false, error: "source_trims.seq يجب أن يكون رقم مصدر صحيحًا ≥ 0" };
      }
      // start اختياري (افتراضي 0) — {seq,end} يعني "أول end ثوانٍ"
      const start = o.start === undefined || o.start === null ? 0 : o.start;
      if (!isNum(start) || start < 0) {
        return { ok: false, error: "source_trims.start يجب أن يكون رقمًا ≥ 0 (ثوانٍ)" };
      }
      let end: number | undefined;
      if (o.end !== undefined && o.end !== null) {
        if (!isNum(o.end) || o.end <= start) {
          return { ok: false, error: "source_trims.end يجب أن يكون رقمًا > start" };
        }
        end = o.end;
      }
      trims.push({ seq: o.seq as number, start, end });
    }
    plan.source_trims = trims;
  }

  // ops
  if (body.ops !== undefined && body.ops !== null) {
    const list = body.ops;
    if (!Array.isArray(list) || list.length === 0 || list.length > MAX_OPS) {
      return { ok: false, error: `ops يجب أن تكون مصفوفة غير فارغة بحد أقصى ${MAX_OPS} عمليات` };
    }
    const ops: EditOp[] = [];
    for (const item of list) {
      if (typeof item !== "object" || item === null) return { ok: false, error: "عنصر ops تالف (كائن مطلوب)" };
      const o = item as Record<string, unknown>;
      switch (o.op) {
        case "trim": {
          // start اختياري (افتراضي 0) — {op:"trim", end:4} يعني "أول 4 ثوانٍ"
          const start = o.start === undefined || o.start === null ? 0 : o.start;
          if (!isNum(start) || start < 0) return { ok: false, error: "op trim: start يجب أن يكون رقمًا ≥ 0 ثوانٍ" };
          let end: number | undefined;
          if (o.end !== undefined && o.end !== null) {
            if (!isNum(o.end) || o.end <= start) return { ok: false, error: "op trim: end يجب أن يكون رقمًا > start" };
            end = o.end;
          }
          ops.push({ op: "trim", start, end });
          break;
        }
        case "crop": {
          if (o.aspect !== "9:16" && o.aspect !== "16:9" && o.aspect !== "1:1") {
            return { ok: false, error: "op crop: aspect يجب أن يكون 9:16 أو 16:9 أو 1:1" };
          }
          const g = o.gravity === undefined || o.gravity === null ? "center" : o.gravity;
          if (typeof g !== "string" || !GRAVITIES.includes(g)) {
            return { ok: false, error: "op crop: gravity يجب أن تكون center|top|bottom|left|right" };
          }
          ops.push({ op: "crop", aspect: o.aspect, gravity: g });
          break;
        }
        case "resize": {
          if (!isNum(o.width) || !isNum(o.height)) {
            return { ok: false, error: "op resize: width و height مطلوبتان (أرقام)" };
          }
          const w = evenize(o.width);
          const h = evenize(o.height);
          if (w < 16 || h < 16) return { ok: false, error: "op resize: الأبعاد يجب أن تكون ≥ 16" };
          const maxDim = Math.max(mergeConfig.maxResW, mergeConfig.maxResH);
          if (w > maxDim || h > maxDim) {
            return { ok: false, error: `op resize: كل بُعد يجب أن يكون ≤ ${maxDim}` };
          }
          const mode = o.mode === undefined || o.mode === null ? "fit" : o.mode;
          if (mode !== "fit" && mode !== "fill") {
            return { ok: false, error: "op resize: mode يجب أن يكون fit أو fill" };
          }
          ops.push({ op: "resize", width: w, height: h, mode });
          break;
        }
        default:
          return { ok: false, error: `عملية غير مدعومة: ${String(o.op)} — المدعوم: trim | crop | resize` };
      }
    }
    plan.ops = ops;
  }

  if (!plan.ops?.length && !plan.source_trims?.length) {
    return { ok: false, error: "خطة تحرير فارغة — أضف ops أو source_trims" };
  }
  return { ok: true, plan };
}

// ---------- الدورات الفعلية بعد معرفة مدد المصادر ----------

/**
 * مدد المصادر الفعلية بعد source_trims — مع تحقق دلالي صارم (لا قصّ صامت):
 * start داخل المدة، end ≤ المدة (+تسامح تقريب ffprobe).
 */
export function effectiveDurations(probes: ProbeInfo[], plan: EditPlan): number[] {
  const durs = probes.map((p) => p.duration);
  for (const t of plan.source_trims ?? []) {
    if (t.seq >= probes.length || t.seq < 0) {
      throw new Error(`source_trims: لا يوجد مصدر برقم ${t.seq} (المصادر ${probes.length})`);
    }
    const dur = durs[t.seq];
    if (t.start >= dur - DUR_EPS) {
      throw new Error(`source_trims[${t.seq}]: start (${t.start}s) يتجاوز مدة المصدر (${dur.toFixed(2)}s)`);
    }
    if (t.end !== undefined && t.end > dur + DUR_EPS) {
      throw new Error(`source_trims[${t.seq}]: end (${t.end}s) يتجاوز مدة المصدر (${dur.toFixed(2)}s)`);
    }
    durs[t.seq] = (t.end ?? dur) - t.start;
  }
  return durs;
}

/** خيارات المدخلات لكل مصدر: -ss/-t قبل -i (فك ترميز الجزء المطلوب فقط) */
export function sourceInputArgs(plan: EditPlan, count: number, durations: number[]): string[][] {
  const bySeq = new Map<number, SourceTrim>();
  for (const t of plan.source_trims ?? []) bySeq.set(t.seq, t);
  const args: string[][] = [];
  for (let i = 0; i < count; i++) {
    const t = bySeq.get(i);
    if (!t) {
      args.push([]);
      continue;
    }
    const dur = t.end !== undefined ? t.end - t.start : durations[i];
    args.push(["-ss", t.start.toFixed(3), "-t", Math.max(0.04, dur).toFixed(3)]);
  }
  return args;
}

// ---------- بناء filter_complex لخطة التحرير ----------

export interface EditGraph {
  filter: string;
  W: number;
  H: number;
  vOut: string;
  aOut: string;
  durations: number[];
}

export function buildEditFilterGraph(
  probes: { width: number; height: number; duration: number; hasAudio: boolean }[],
  plan: EditPlan
): EditGraph {
  const durations = effectiveDurations(probes, plan);
  const totalDur = durations.reduce((a, b) => a + b, 0);
  if (totalDur > mergeConfig.maxTotalDurationSec) {
    throw new Error(
      `المدة الإجمالية بعد التحرير (${totalDur.toFixed(1)}s) تتجاوز الحد (${mergeConfig.maxTotalDurationSec}s)`
    );
  }

  // الدقة الأساس: أكبر أبعاد بين المدخلات بحد أقصى 1920 لكل بُعد (يسمح 1080x1920 عموديًا)
  let W = evenize(Math.min(Math.max(...probes.map((p) => p.width)), 1920));
  let H = evenize(Math.min(Math.max(...probes.map((p) => p.height)), 1920));
  if (W < 2) W = 2;
  if (H < 2) H = 2;

  const filters: string[] = [];
  const concatPairs: string[] = [];
  let lavfiIdx = probes.length;

  probes.forEach((p, i) => {
    filters.push(
      `[${i}:v]scale=${W}:${H}:force_original_aspect_ratio=decrease,` +
        `pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2,` +
        `fps=${mergeConfig.fps},setsar=1,format=yuv420p[v${i}]`
    );
    if (p.hasAudio) {
      filters.push(`[${i}:a]aresample=${mergeConfig.audioRate},aformat=sample_fmts=fltp:channel_layouts=stereo[a${i}]`);
    } else {
      filters.push(
        `[${lavfiIdx}:a]atrim=0:${durations[i].toFixed(3)},asetpts=PTS-STARTPTS,aformat=sample_fmts=fltp:channel_layouts=stereo[a${i}]`
      );
      lavfiIdx += 1;
    }
    concatPairs.push(`[v${i}][a${i}]`);
  });

  filters.push(`${concatPairs.join("")}concat=n=${probes.length}:v=1:a=1[vc][ac]`);

  // سلسلة العمليات على الخط الزمني النهائي
  let vLabel = "vc";
  let aLabel = "ac";
  let timelineDur = totalDur;
  let idx = 0;

  for (const op of plan.ops ?? []) {
    if (op.op === "trim") {
      const end = op.end ?? timelineDur;
      if (op.start >= timelineDur - DUR_EPS) {
        throw new Error(`op trim: start (${op.start}s) يتجاوز مدة الفيديو الحالية (${timelineDur.toFixed(2)}s)`);
      }
      if (end > timelineDur + DUR_EPS) {
        throw new Error(`op trim: end (${end}s) يتجاوز مدة الفيديو الحالية (${timelineDur.toFixed(2)}s)`);
      }
      filters.push(`[${vLabel}]trim=start=${op.start.toFixed(3)}:end=${end.toFixed(3)},setpts=PTS-STARTPTS[tv${idx}]`);
      filters.push(`[${aLabel}]atrim=start=${op.start.toFixed(3)}:end=${end.toFixed(3)},asetpts=PTS-STARTPTS[ta${idx}]`);
      timelineDur = end - op.start;
      vLabel = `tv${idx}`;
      aLabel = `ta${idx}`;
      idx += 1;
    } else if (op.op === "crop") {
      const std = CROP_STANDARD[op.aspect];
      // بعد scale=increase يفيض بُعد واحد فقط — نحدد المحور من نسبة الأبعاد الحالية
      const horizontalOverflow = W * std.h > H * std.w;
      const gx =
        op.gravity === "left" ? "0" : op.gravity === "right" ? "iw-ow" : "(iw-ow)/2";
      const gy =
        op.gravity === "top" ? "0" : op.gravity === "bottom" ? "ih-oh" : "(ih-oh)/2";
      const x = horizontalOverflow ? gx : "0";
      const y = horizontalOverflow ? "0" : gy;
      filters.push(
        `[${vLabel}]scale=${std.w}:${std.h}:force_original_aspect_ratio=increase,` +
          `crop=${std.w}:${std.h}:${x}:${y},setsar=1,format=yuv420p[cv${idx}]`
      );
      W = std.w;
      H = std.h;
      vLabel = `cv${idx}`;
      idx += 1;
    } else if (op.op === "resize") {
      if (op.mode === "fit") {
        filters.push(
          `[${vLabel}]scale=${op.width}:${op.height}:force_original_aspect_ratio=decrease,` +
            `pad=${op.width}:${op.height}:(ow-iw)/2:(oh-ih)/2,setsar=1,format=yuv420p[rv${idx}]`
        );
      } else {
        filters.push(
          `[${vLabel}]scale=${op.width}:${op.height}:force_original_aspect_ratio=increase,` +
            `crop=${op.width}:${op.height}:(iw-ow)/2:(ih-oh)/2,setsar=1,format=yuv420p[rv${idx}]`
        );
      }
      W = op.width;
      H = op.height;
      vLabel = `rv${idx}`;
      idx += 1;
    }
  }

  return { filter: filters.join(";"), W, H, vOut: vLabel, aOut: aLabel, durations };
}
