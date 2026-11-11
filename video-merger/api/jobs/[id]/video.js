'use strict';
// GET /api/jobs/<id>/video — بث الناتج مع دعم Range (206) و ?download=1
const store = require('../../../lib/db');
const { applyCors, sendError } = require('../../../lib/http');

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') {
    applyCors(res);
    res.statusCode = 204;
    return res.end();
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return sendError(res, 405, 'طريقة غير مسموحة — استخدم GET لبث الفيديو');
  }

  const id = (req.query && req.query.id) || '';
  const job = await store.getJob(id);
  if (!job) return sendError(res, 404, 'المهمة غير موجودة');
  if (String(job.status) !== 'done') {
    return sendError(res, 404, 'الفيديو غير متوفر بعد — المهمة ليست مكتملة');
  }

  const total = Number(job.output_size || 0);
  if (!total) return sendError(res, 404, 'الفيديو غير موجود');

  const isDownload = req.query && String(req.query.download || '') === '1';
  applyCors(res);
  res.setHeader('Content-Type', String(job.output_mime || 'video/mp4'));
  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('Cache-Control', 'no-store');
  const fname = `merged-${id}.mp4`;
  res.setHeader('Content-Disposition',
    `${isDownload ? 'attachment' : 'inline'}; filename="${fname}"`);

  const rangeHeader = req.headers && req.headers.range;

  if (!rangeHeader) {
    res.statusCode = 200;
    res.setHeader('Content-Length', total);
    if (req.method === 'HEAD') return res.end();
    const whole = await store.readOutputRange(id, 0, total - 1);
    return res.end(whole ? whole.buf : Buffer.alloc(0));
  }

  // تحليل "bytes=start-end"
  const m = /^bytes=(\d*)-(\d*)$/.exec(String(rangeHeader).trim());
  if (!m || (m[1] === '' && m[2] === '')) {
    res.statusCode = 416;
    res.setHeader('Content-Range', `bytes */${total}`);
    return res.end();
  }

  let start;
  let end;
  if (m[1] === '') {
    // لاحقة: bytes=-N → آخر N بايت
    const n = parseInt(m[2], 10);
    if (!n) {
      res.statusCode = 416;
      res.setHeader('Content-Range', `bytes */${total}`);
      return res.end();
    }
    start = Math.max(0, total - n);
    end = total - 1;
  } else {
    start = parseInt(m[1], 10);
    end = m[2] === '' ? total - 1 : Math.min(parseInt(m[2], 10), total - 1);
  }

  if (start > end || start >= total) {
    res.statusCode = 416;
    res.setHeader('Content-Range', `bytes */${total}`);
    return res.end();
  }

  const slice = await store.readOutputRange(id, start, end);
  res.statusCode = 206;
  res.setHeader('Content-Range', `bytes ${start}-${end}/${total}`);
  res.setHeader('Content-Length', end - start + 1);
  if (req.method === 'HEAD') return res.end();
  return res.end(slice ? slice.buf : Buffer.alloc(0));
};
