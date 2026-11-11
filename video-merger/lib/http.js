'use strict';
// أدوات HTTP مشتركة لدوال Vercel: CORS، JSON، قراءة الجسم، الأخطاء العربية

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS, HEAD',
  'Access-Control-Allow-Headers': 'Content-Type, Range, Authorization',
  'Access-Control-Expose-Headers': 'Content-Range, Accept-Ranges, Content-Length, Content-Disposition',
};

function applyCors(res) {
  for (const [k, v] of Object.entries(CORS_HEADERS)) res.setHeader(k, v);
}

function handleOptions(req, res) {
  if ((req.method || '').toUpperCase() !== 'OPTIONS') return false;
  applyCors(res);
  res.statusCode = 204;
  res.end();
  return true;
}

function sendJson(res, code, obj) {
  applyCors(res);
  res.statusCode = code;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(obj));
}

function sendError(res, code, message) {
  sendJson(res, code, { error: message });
}

// قراءة الجسم الثنائي مع حد أقصى
function readRawBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let done = false;
    req.on('data', (c) => {
      if (done) return;
      size += c.length;
      if (size > maxBytes) {
        done = true;
        reject(Object.assign(new Error('TOO_LARGE'), { code: 413 }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => { if (!done) { done = true; resolve(Buffer.concat(chunks)); } });
    req.on('error', (e) => { if (!done) { done = true; reject(e); } });
  });
}

async function readJsonBody(req, maxBytes) {
  const buf = await readRawBody(req, maxBytes);
  if (!buf.length) throw Object.assign(new Error('EMPTY'), { code: 400 });
  try {
    return JSON.parse(buf.toString('utf8'));
  } catch (_) {
    throw Object.assign(new Error('التنسيق غير صالح: المتوقع JSON صحيح'), { code: 400 });
  }
}

// بناء رابط أساسي مطلق من ترويسات الطلب (Vercel تمرر x-forwarded-*؛ محليًا http)
function baseUrl(req) {
  const host = (req.headers && (req.headers['x-forwarded-host'] || req.headers.host)) || 'localhost';
  let proto = req.headers && req.headers['x-forwarded-proto'];
  if (!proto) {
    const h = String(host).split(':')[0];
    proto = (h === 'localhost' || h === '127.0.0.1') ? 'http' : 'https';
  }
  return `${proto}://${host}`;
}

module.exports = { applyCors, handleOptions, sendJson, sendError, readRawBody, readJsonBody, baseUrl, CORS_HEADERS };
