'use strict';
// POST /api/jobs — إنشاء مهمة دمج
const store = require('../lib/db');
const { config } = require('../lib/config');
const { handleOptions, sendJson, sendError, readJsonBody } = require('../lib/http');

module.exports = async (req, res) => {
  if (handleOptions(req, res)) return;

  if (req.method !== 'POST') {
    return sendError(res, 405, 'طريقة غير مسموحة لهذه النقطة — استخدم POST لإنشاء مهمة');
  }

  let body;
  try {
    body = await readJsonBody(req, 256 * 1024);
  } catch (e) {
    if (e.code === 400) return sendError(res, 400, e.message || 'جسم الطلب مطلوب بصيغة JSON');
    if (e.code === 413) return sendError(res, 413, 'جسم الطلب كبير جدًا');
    return sendError(res, 400, 'تعذّر قراءة جسم الطلب');
  }

  // تقبل {"videos":[...]} أو {"sources":[{kind,url|name,size,mime}]}
  let sources = [];
  try {
    if (Array.isArray(body.videos)) {
      sources = body.videos.map((u) => ({ kind: 'url', url: String(u) }));
    } else if (Array.isArray(body.sources)) {
      for (const s of body.sources) {
        if (!s || typeof s !== 'object') throw new Error('عنصر مصدر تالف');
        if (s.kind === 'url' || (typeof s.url === 'string' && !s.kind)) {
          sources.push({ kind: 'url', url: String(s.url) });
        } else if (s.kind === 'file') {
          sources.push({
            kind: 'file',
            name: s.name ? String(s.name) : 'file',
            size: Number(s.size),
            mime: s.mime ? String(s.mime) : 'video/mp4',
          });
        } else {
          throw new Error('نوع مصدر غير مدعوم — استخدم "url" أو "file"');
        }
      }
    }
  } catch (e) {
    return sendError(res, 400, `مدخلات تالفة: ${e.message}`);
  }

  if (!sources.length) {
    return sendError(res, 400, 'قائمة المصادر فارغة — أضف رابطًا واحدًا على الأقل أو ملفًا');
  }
  if (sources.length > config.maxSources) {
    return sendError(res, 400, `عدد المصادر يتجاوز الحد المسموح (${config.maxSources})`);
  }
  for (const s of sources) {
    if (s.kind === 'url') {
      try {
        const u = new URL(s.url);
        if (!['http:', 'https:'].includes(u.protocol)) throw new Error('بروتوكول غير مدعوم');
      } catch (_) {
        return sendError(res, 400, `رابط غير صالح: ${s.url}`);
      }
    } else {
      if (!Number.isFinite(s.size) || s.size <= 0) {
        return sendError(res, 400, `حجم الملف "${s.name}" غير صالح`);
      }
      if (s.size > config.sourceMaxBytes) {
        return sendError(res, 413, `حجم الملف "${s.name}" (${(s.size / 1048576).toFixed(1)}MB) يتجاوز الحد المسموح (${config.sourceMaxBytes / 1048576}MB)`);
      }
    }
  }

  // تنظيف كسول عند كل إنشاء
  try { await store.cleanupExpired(); } catch (_) {}

  const job = await store.createJob(sources);

  const fileSources = sources
    .map((s, seq) => ({ s, seq }))
    .filter(({ s }) => s.kind === 'file')
    .map(({ s, seq }) => ({
      seq,
      name: s.name,
      size: s.size,
      mime: s.mime || 'video/mp4',
      chunks: Math.ceil(s.size / config.uploadChunkBytes),
      uploadUrl: `/api/upload?job=${job.id}&seq=${seq}`,
    }));

  const payload = {
    jobId: job.id,
    status: job.status,
    statusUrl: `/api/jobs/${job.id}`,
    processUrl: `/api/jobs/${job.id}/process`,
    expiresAt: job.expiresAt.toISOString(),
  };
  if (fileSources.length) {
    payload.uploads = fileSources;
    payload.uploadChunkBytes = config.uploadChunkBytes;
  }

  return sendJson(res, 201, payload);
};
