'use strict';
// GET /api/jobs/<id> — الحالة والتقدم | DELETE — حذف فوري شامل
const store = require('../../lib/db');
const { handleOptions, sendJson, sendError, baseUrl } = require('../../lib/http');

function jobView(job, sources, origin) {
  const payload = {
    jobId: job.id,
    status: String(job.status),
    progress: Number(job.progress || 0),
    createdAt: job.created_at,
    expiresAt: job.expires_at,
    sources: sources.map((s) => ({
      seq: Number(s.seq),
      kind: String(s.kind),
      name: s.name || s.url || null,
      size: s.size === null ? null : Number(s.size),
      status: String(s.status),
    })),
  };
  if (job.error) payload.error = String(job.error);
  if (String(job.status) === 'done') {
    payload.videoUrl = `${origin}/api/jobs/${job.id}/video`;
    payload.downloadUrl = `${origin}/api/jobs/${job.id}/video?download=1`;
    payload.size = job.output_size === null ? null : Number(job.output_size);
    payload.duration = job.output_duration === null ? null : Number(job.output_duration);
    payload.resolution = job.output_width && job.output_height
      ? `${Number(job.output_width)}x${Number(job.output_height)}` : null;
  }
  return payload;
}

module.exports = async (req, res) => {
  if (handleOptions(req, res)) return;

  const id = (req.query && req.query.id) || '';

  if (req.method === 'GET' || req.method === 'HEAD') {
    const job = await store.getJob(id);
    if (!job) return sendError(res, 404, 'المهمة غير موجودة');
    const sources = await store.getSources(id);
    const view = jobView(job, sources, baseUrl(req));
    return sendJson(res, 200, view);
  }

  if (req.method === 'DELETE') {
    const job = await store.getJob(id);
    if (!job) return sendError(res, 404, 'المهمة غير موجودة');
    await store.deleteJob(id);
    return sendJson(res, 200, { deleted: true, jobId: id });
  }

  return sendError(res, 405, 'طريقة غير مسموحة — استخدم GET أو DELETE');
};
