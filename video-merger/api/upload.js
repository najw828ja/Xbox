'use strict';
// POST /api/upload?job=<id>&seq=<n>&chunk=<k> — رفع أجزاء الملفات (ثنائي ≤4MB)
const store = require('../lib/db');
const { config } = require('../lib/config');
const { handleOptions, sendJson, sendError, readRawBody } = require('../lib/http');

module.exports = async (req, res) => {
  if (handleOptions(req, res)) return;

  if (req.method !== 'POST') {
    return sendError(res, 405, 'طريقة غير مسموحة لهذه النقطة — استخدم POST لرفع الأجزاء');
  }

  const q = req.query || {};
  const jobId = String(q.job || '');
  const seq = parseInt(q.seq, 10);
  const chunk = parseInt(q.chunk, 10);

  if (!jobId || !Number.isFinite(seq) || !Number.isFinite(chunk) || seq < 0 || chunk < 0) {
    return sendError(res, 400, 'معاملات الرفع مطلوبة: job و seq و chunk');
  }

  const job = await store.getJob(jobId);
  if (!job) return sendError(res, 404, 'المهمة غير موجودة');
  if (['processing', 'done', 'failed'].includes(String(job.status))) {
    return sendError(res, 409, 'المهمة لم تعد في حالة الرفع — لا يمكن استقبال أجزاء جديدة');
  }

  const sources = await store.getSources(jobId);
  const src = sources.find((s) => Number(s.seq) === seq);
  if (!src) return sendError(res, 404, 'المصدر المحدد غير موجود في هذه المهمة');
  if (String(src.kind) !== 'file') {
    return sendError(res, 400, 'هذا المصدر رابط وليس ملفًا — لا يحتاج رفعًا');
  }

  let body;
  try {
    body = await readRawBody(req, config.uploadChunkBytes);
  } catch (e) {
    if (e.code === 413) {
      return sendError(res, 413, `حجم الجزء يتجاوز الحد المسموح (${config.uploadChunkBytes / 1048576}MB)`);
    }
    return sendError(res, 400, 'تعذّر قراءة جسم الطلب');
  }
  if (!body.length) return sendError(res, 400, 'الجزء المرفوع فارغ');

  await store.saveSourceChunk(jobId, seq, chunk, body);

  const received = Number(src.received || 0) + body.length;
  const expectedChunks = Math.ceil(Number(src.size) / config.uploadChunkBytes);
  const size = Number(src.size);
  const done = chunk + 1 >= expectedChunks || received >= size;

  await store.updateSource(jobId, seq, {
    received,
    status: done ? 'ready' : 'receiving',
  });

  return sendJson(res, 200, {
    ok: true,
    seq,
    chunk,
    receivedBytes: received,
    expectedBytes: size,
    expectedChunks,
    done,
  });
};
