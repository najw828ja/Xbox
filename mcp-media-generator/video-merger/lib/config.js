'use strict';
const { loadEnv } = require('./env');

loadEnv();

function intEnv(name, def) {
  const v = parseInt(process.env[name], 10);
  return Number.isFinite(v) && v > 0 ? v : def;
}

const MB = 1024 * 1024;

const config = {
  // حدود الاستخدام (كلها قابلة للضبط عبر متغيرات البيئة)
  maxSources: intEnv('MAX_SOURCES', 10),
  sourceMaxBytes: intEnv('SOURCE_MAX_MB', 200) * MB,
  outputMaxBytes: intEnv('OUTPUT_MAX_MB', 150) * MB,
  maxTotalDurationSec: intEnv('MAX_TOTAL_DURATION_SEC', 600),
  ffmpegPreset: process.env.FFMPEG_PRESET || 'medium',

  // حدود ثابتة تقنية
  uploadChunkBytes: 4 * MB,        // حد حجم الطلب في Vercel ≈ 4.5MB → نرفع بأجزاء 4MB
  tursoRowBytes: 2 * MB,           // حد HTTP لكل صف Blob في Turso → نقسّم إلى صفوف 2MB
  readPageRows: 8,                 // قراءة الـ Blobs تدفقيًا بصفحات من 8 صفوف
  expireHours: 24,                 // عمر المهمة قبل الحذف
  maxResW: 1920,                   // حد أقصى لأبعاد الناتج (زوجية)
  maxResH: 1080,
  fps: 30,
  crf: 18,
  audioBitrate: '192k',
  audioRate: 44100,
  version: '1.0.0',
};

module.exports = { config, MB };
