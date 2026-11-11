'use strict';
// POST /api/jobs/<id>/process — تنفيذ الدمج كاملًا (متزامن) | 202 لو جارية
const store = require('../../../lib/db');
const { processJob } = require('../../../lib/merger');
const { handleOptions, sendJson, sendError, baseUrl } = require('../../../lib/http');

module.exports = async (req, res) => {
  if (handleOptions(req, res)) return;

  if (req.method !== 'POST') {
    return sendError(res, 405, 'طريقة غير مسموحة لهذه النقطة — استخدم POST لتنفيذ الدمج');
  }

  const id = (req.query && req.query.id) || '';
  const job = await store.getJob(id);
  if (!job) return sendError(res, 404, 'المهمة غير موجودة');

  const status = String(job.status);
  if (status === 'processing') {
    return sendJson(res, 202, { status: 'processing', progress: Number(job.progress || 0) });
  }
  if (status === 'done') {
    const origin = baseUrl(req);
    return sendJson(res, 200, {
      status: 'done',
      videoUrl: `${origin}/api/jobs/${id}/video`,
      downloadUrl: `${origin}/api/jobs/${id}/video?download=1`,
      size: job.output_size === null ? null : Number(job.output_size),
      duration: job.output_duration === null ? null : Number(job.output_duration),
      resolution: job.output_width && job.output_height
        ? `${Number(job.output_width)}x${Number(job.output_height)}` : null,
      expiresAt: job.expires_at,
    });
  }
  if (status === 'uploading') {
    // تأكد أن كل ملفات المصدر اكتمل رفعها
    const sources = await store.getSources(id);
    const missing = sources.filter((s) =>
      String(s.kind) === 'file' && Number(s.received || 0) < Number(s.size || 0));
    if (missing.length) {
      return sendError(res, 409, 'لم يتم رفع جميع أجزاء الملفات بعد — أكمل الرفع أولًا');
    }
  }

  try {
    const result = await processJob(id);
    const origin = baseUrl(req);
    const job2 = await store.getJob(id);
    return sendJson(res, 200, {
      status: 'done',
      videoUrl: `${origin}/api/jobs/${id}/video`,
      downloadUrl: `${origin}/api/jobs/${id}/video?download=1`,
      size: result.size,
      duration: result.duration,
      resolution: result.resolution,
      expiresAt: job2 ? String(job2.expires_at) : undefined,
    });
  } catch (e) {
    const code = (e && e.code) || 500;
    const msg = e && e.message ? e.message : 'فشل الدمج بسبب غير معروف';
    return sendError(res, code, msg);
  }
};
