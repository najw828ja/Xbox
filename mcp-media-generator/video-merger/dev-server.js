'use strict';
// خادم تطوير محلي يحاكي بيئة Vercel:
// - يحلل المسارات الديناميكية (/api/jobs/<id> ...) ويضعها في req.query
// - يقدم الملفات الثابتة من public/
// - منفذ 3040 فقط
const http = require('http');
const fs = require('fs');
const path = require('path');
const { loadEnv } = require('./lib/env');

loadEnv();

const PORT = 3040;
const PUBLIC_DIR = path.join(__dirname, 'public');

const jobsHandler = require('./api/jobs');
const uploadHandler = require('./api/upload');
const jobByIdHandler = require('./api/jobs/[id]');
const processHandler = require('./api/jobs/[id]/process');
const videoHandler = require('./api/jobs/[id]/video');
const configHandler = require('./api/config');
const cronHandler = require('./api/cron');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

function serveStatic(req, res, urlPath) {
  let rel = urlPath === '/' ? '/index.html' : urlPath;
  const filePath = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.statusCode = 403;
    return res.end('Forbidden');
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      // fallback إلى index.html (تطبيق صفحة واحدة)
      fs.readFile(path.join(PUBLIC_DIR, 'index.html'), (e2, idx) => {
        if (e2) { res.statusCode = 404; return res.end('Not Found'); }
        res.setHeader('Content-Type', MIME['.html']);
        res.end(idx);
      });
      return;
    }
    res.setHeader('Content-Type', MIME[path.extname(filePath)] || 'application/octet-stream');
    res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  try {
    const u = new URL(req.url, `http://localhost:${PORT}`);
    req.query = Object.fromEntries(u.searchParams);
    const p = u.pathname;

    // مسارات ديناميكية → نضع المعرفات في req.query كما تفعل Vercel
    let m;
    if (p === '/api/jobs') return await jobsHandler(req, res);
    if (p === '/api/upload') return await uploadHandler(req, res);
    if ((m = p.match(/^\/api\/jobs\/([^/]+)\/(process|video)$/))) {
      req.query.id = decodeURIComponent(m[1]);
      return await (m[2] === 'process' ? processHandler(req, res) : videoHandler(req, res));
    }
    if ((m = p.match(/^\/api\/jobs\/([^/]+)$/))) {
      req.query.id = decodeURIComponent(m[1]);
      return await jobByIdHandler(req, res);
    }
    if (p === '/api/config') return await configHandler(req, res);
    if (p === '/api/cron') return await cronHandler(req, res);

    if (p.startsWith('/api/')) {
      res.statusCode = 404;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      return res.end(JSON.stringify({ error: 'نقطة API غير موجودة' }));
    }
    return serveStatic(req, res, p);
  } catch (e) {
    console.error('[dev-server] خطأ غير متوقع:', e);
    if (!res.headersSent) {
      res.statusCode = 500;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.end(JSON.stringify({ error: 'خطأ داخلي في الخادم' }));
    }
  }
});

server.listen(PORT, () => {
  console.log(`[dev-server] جاهز على http://localhost:${PORT}`);
});
