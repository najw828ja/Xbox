/**
 * إعدادات محرك دمج الفيديوهات (مدمجة في المشروع نفسه — لا خدمة خارجية).
 * الحدود كلها قابلة للضبط عبر متغيرات البيئة، والقيم الافتراضية مطابقة للمواصفات.
 */
const MB = 1024 * 1024;

function intEnv(name: string, def: number): number {
  const v = parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(v) && v > 0 ? v : def;
}

export const mergeConfig = {
  // حدود الاستخدام
  maxSources: intEnv("MAX_SOURCES", 10),
  sourceMaxBytes: intEnv("SOURCE_MAX_MB", 200) * MB,
  outputMaxBytes: intEnv("OUTPUT_MAX_MB", 150) * MB,
  maxTotalDurationSec: intEnv("MAX_TOTAL_DURATION_SEC", 600),
  ffmpegPreset: process.env.FFMPEG_PRESET || "medium",

  // حدود ثابتة تقنية
  uploadChunkBytes: 4 * MB, // حد حجم الطلب في Vercel ≈ 4.5MB → نرفع بأجزاء 4MB
  tursoRowBytes: 2 * MB, // حد HTTP لكل صف Blob في Turso → نقسّم إلى صفوف 2MB
  readPageRows: 8, // قراءة الـ Blobs تدفقيًا بصفحات من 8 صفوف
  expireHours: 24, // عمر المهمة قبل الحذف التلقائي (تحذير الـ 24 ساعة في المواصفات)
  maxResW: 1920, // حد أقصى لأبعاد الناتج (زوجية)
  maxResH: 1080,
  fps: 30,
  crf: 18,
  audioBitrate: "192k",
  audioRate: 44100,
  version: "1.0.0",
};
