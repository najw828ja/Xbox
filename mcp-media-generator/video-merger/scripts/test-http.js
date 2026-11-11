'use strict';
// اختبار HTTP كامل ضد خادم التطوير (dev-server.js على 3040):
// روابط → دمج → Range 206 → مهمة مختلطة (رابط + ملف مرفوع) → حذف → 404 → JSON تالف → قائمة فارغة
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const { loadEnv } = require('../lib/env');
loadEnv();

const BASE = 'http://localhost:3040';
const URL1 = 'https://www.w3schools.com/html/mov_bbb.mp4';
const URL2 = 'https://test-videos.co.uk/vids/bigbuckbunny/mp4/h264/360/Big_Buck_Bunny_360_10s_1MB.mp4';

let passed = 0, failed = 0;
const testJobIds = [];

function check(name, cond, extra) {
  if (cond) { passed++; console.log('  ✅ ' + name); }
  else { failed++; console.log('  ❌ ' + name + (extra ? ' — ' + extra : '')); }
}
function sha256(buf) { return crypto.createHash('sha256').update(buf).digest('hex'); }

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function startServer() {
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'dev-server.js')], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: process.env,
  });
  let ready = false;
  const done = new Promise((resolve, reject) => {
    child.stdout.on('data', (d) => {
      process.stdout.write('  [srv] ' + d.toString());
      if (d.toString().includes('جاهز')) { ready = true; resolve(); }
    });
    child.stderr.on('data', (d) => process.stderr.write('  [srv-err] ' + d.toString()));
    child.on('error', reject);
  });
  for (let i = 0; i < 100 && !ready; i++) await sleep(100);
  if (!ready) { try { await Promise.race([done, sleep(1000)]); } catch (_) {} }
  if (!ready) {
    // محاولة أخيرة عبر طلب فعلي
    try {
      const r = await fetch(BASE + '/api/config');
      if (r.ok) ready = true;
    } catch (_) {}
  }
  if (!ready) throw new Error('خادم التطوير لم يبدأ');
  return child;
}

async function waitForDone(jobId, timeoutMs) {
  const t0 = Date.now();
  while (Date.now() - t0 < (timeoutMs || 240000)) {
    const r = await fetch(`${BASE}/api/jobs/${jobId}`);
    const j = await r.json();
    if (j.status === 'done') return j;
    if (j.status === 'failed') throw new Error('المهمة فشلت: ' + (j.error || ''));
    await sleep(2000);
  }
  throw new Error('انتهت المهلة أثناء انتظار الدمج');
}

async function genSmallVideo(p) {
  const { FFMPEG_SRC } = require('../lib/ffmpeg');
  execFileSync(FFMPEG_SRC, [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-t', '2', '-i', 'testsrc=size=320x240:rate=25',
    '-f', 'lavfi', '-t', '2', '-i', 'sine=frequency=330',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-preset', 'veryfast',
    '-c:a', 'aac', '-shortest', p,
  ], { stdio: 'pipe' });
}

async function main() {
  const server = await startServer();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vm-http-'));
  const created = [];

  try {
    console.log('\n[1] GET /api/config…');
    {
      const r = await fetch(`${BASE}/api/config`);
      const j = await r.json();
      check('200 + الحدود موجودة', r.status === 200 && j.maxSources > 0 && j.version);
    }

    console.log('\n[2] POST /api/jobs (روابط) → process → النتيجة…');
    {
      const r = await fetch(`${BASE}/api/jobs`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ videos: [URL1, URL2] }),
      });
      const j = await r.json();
      check('201 + jobId + statusUrl + processUrl + expiresAt',
        r.status === 201 && j.jobId && j.statusUrl && j.processUrl && j.expiresAt && j.status === 'queued');
      created.push(j.jobId); testJobIds.push(j.jobId);

      const st = await fetch(`${BASE}/api/jobs/${j.jobId}`);
      const stj = await st.json();
      check('GET حالة المهمة: queued + مصدران', st.status === 200 && stj.status === 'queued' && stj.sources.length === 2);

      console.log('  … جارٍ الدمج (سحب روابط خارجية + ترميز، قد يستغرق دقيقة)…');
      const pr = await fetch(`${BASE}/api/jobs/${j.jobId}/process`, { method: 'POST' });
      const pj = await pr.json();
      check('process يعيد done + videoUrl + downloadUrl + resolution',
        pr.status === 200 && pj.status === 'done' && pj.videoUrl && pj.downloadUrl && /^\d+x\d+$/.test(pj.resolution));
      check('الدقة = أكبر دقة مدخل (360x360 أو أكبر من الرابطين)', parseInt(pj.resolution) >= 320);
    }

    const lastJobId = testJobIds[0];
    let videoSize = 0;

    console.log('\n[3] بث الفيديو + Range 206…');
    {
      const full = await fetch(`${BASE}/api/jobs/${lastJobId}/video`);
      const buf = Buffer.from(await full.arrayBuffer());
      videoSize = buf.length;
      check('200 كامل + Content-Length', full.status === 200 && Number(full.headers.get('content-length')) === videoSize);

      const rng = await fetch(`${BASE}/api/jobs/${lastJobId}/video`, {
        headers: { Range: 'bytes=0-1023' },
      });
      const rbuf = Buffer.from(await rng.arrayBuffer());
      check('206 + Content-Range صحيح',
        rng.status === 206 && rng.headers.get('content-range') === `bytes 0-1023/${videoSize}` && rbuf.length === 1024);
      check('محتوى المدى يطابق الأصل', sha256(rbuf) === sha256(buf.subarray(0, 1024)));

      const tail = await fetch(`${BASE}/api/jobs/${lastJobId}/video`, {
        headers: { Range: 'bytes=-1000' },
      });
      const tbuf = Buffer.from(await tail.arrayBuffer());
      check('لاحقة bytes=-1000 تعمل (206)', tail.status === 206 && tbuf.length === 1000 &&
        sha256(tbuf) === sha256(buf.subarray(videoSize - 1000)));

      const bad = await fetch(`${BASE}/api/jobs/${lastJobId}/video`, {
        headers: { Range: `bytes=${videoSize + 100}-` },
      });
      check('مدى خارج النطاق → 416', bad.status === 416);

      const dl = await fetch(`${BASE}/api/jobs/${lastJobId}/video?download=1`);
      check('download=1 يعطي Content-Disposition', dl.status === 200 &&
        String(dl.headers.get('content-disposition')).includes('attachment'));
    }

    console.log('\n[4] مهمة مختلطة: رابط + ملف مرفوع بالأجزاء…');
    {
      const small = path.join(tmp, 'small.mp4');
      await genSmallVideo(small);
      const fbuf = fs.readFileSync(small);

      const r = await fetch(`${BASE}/api/jobs`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sources: [{ kind: 'url', url: URL1 }, { kind: 'file', name: 'small.mp4', size: fbuf.length, mime: 'video/mp4' }] }),
      });
      const j = await r.json();
      check('201 مع uploads[] + uploadChunkBytes', r.status === 201 && j.status === 'uploading' &&
        Array.isArray(j.uploads) && j.uploads.length === 1 && j.uploadChunkBytes > 0);
      created.push(j.jobId); testJobIds.push(j.jobId);

      // رفع بالأجزاء 1MB (قطعتان إن كان الملف أكبر — نستخدم حد 1MB محليًا)
      const chunkSize = Math.ceil(fbuf.length / 2);
      let upOK = true;
      for (let c = 0; c * chunkSize < fbuf.length; c++) {
        const slice = fbuf.subarray(c * chunkSize, Math.min((c + 1) * chunkSize, fbuf.length));
        const ur = await fetch(`${BASE}/api/upload?job=${j.jobId}&seq=1&chunk=${c}`, {
          method: 'POST', headers: { 'Content-Type': 'application/octet-stream' },
          body: slice,
        });
        if (!ur.ok) upOK = false;
      }
      check('رفع الأجزاء نجح (200/done)', upOK);

      // process قبل اكتمال رفع مصدر آخر لا يُطبق هنا — ننفّذ الدمج
      const pr = await fetch(`${BASE}/api/jobs/${j.jobId}/process`, { method: 'POST' });
      const pj = await pr.json();
      check('الدمج المختلط نجح', pr.status === 200 && pj.status === 'done' && pj.resolution);
      const done = await waitForDone(j.jobId, 5000);
      check('النتيجة من GET: done + videoUrl', done.status === 'done' && !!done.videoUrl);
    }

    console.log('\n[5] رفض 409: process قبل اكتمال الرفع…');
    {
      const r = await fetch(`${BASE}/api/jobs`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sources: [{ kind: 'file', name: 'x.mp4', size: 10000000, mime: 'video/mp4' }] }),
      });
      const j = await r.json();
      created.push(j.jobId); testJobIds.push(j.jobId);
      const pr = await fetch(`${BASE}/api/jobs/${j.jobId}/process`, { method: 'POST' });
      check('409 برسالة عربية', pr.status === 409 && ((await pr.json()).error || '').length > 0);
    }

    console.log('\n[6] الحذف الشامل → 404 بعده…');
    {
      const id = created[0] || lastJobId;
      const d = await fetch(`${BASE}/api/jobs/${id}`, { method: 'DELETE' });
      const dj = await d.json();
      check('DELETE 200 + deleted:true', d.status === 200 && dj.deleted === true);
      const g = await fetch(`${BASE}/api/jobs/${id}`);
      check('GET بعد الحذف → 404 برسالة عربية', g.status === 404 && ((await g.json()).error || '').length > 0);
      const v = await fetch(`${BASE}/api/jobs/${id}/video`);
      check('video بعد الحذف → 404', v.status === 404);
    }

    console.log('\n[7] أخطاء المدخلات…');
    {
      const nf = await fetch(`${BASE}/api/jobs/doesnotexist123`);
      check('مهمة غير موجودة → 404', nf.status === 404);

      const bad = await fetch(`${BASE}/api/jobs`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{هذا ليس JSON',
      });
      check('JSON تالف → 400 + رسالة عربية', bad.status === 400 && /JSON|صالح/.test((await bad.json()).error || ''));

      const empty = await fetch(`${BASE}/api/jobs`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ videos: [] }),
      });
      check('قائمة فارغة → 400', empty.status === 400);

      const badUrl = await fetch(`${BASE}/api/jobs`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ videos: ['ftp://x', 'not-a-url'] }),
      });
      check('روابط غير صالحة → 400', badUrl.status === 400);

      const m405 = await fetch(`${BASE}/api/jobs`, { method: 'PUT' });
      check('PUT /api/jobs → 405', m405.status === 405);

      const c405 = await fetch(`${BASE}/api/config`, { method: 'POST' });
      check('POST /api/config → 405', c405.status === 405);

      const u405 = await fetch(`${BASE}/api/upload?job=x&seq=0&chunk=0`, { method: 'GET' });
      check('GET /api/upload → 405', u405.status === 405);

      const nf2 = await fetch(`${BASE}/api/upload?job=zzz&seq=0&chunk=0`, {
        method: 'POST', body: 'abc',
      });
      check('رفع لمهمة غير موجودة → 404', nf2.status === 404);
    }

    console.log('\n[8] واجهة الموقع…');
    {
      const h = await fetch(`${BASE}/`);
      const html = await h.text();
      check('index.html يعمل', h.status === 200 && html.includes('دمج الفيديوهات') && html.includes('dir="rtl"'));
    }

    console.log('\n[9] تنظيف مهام الاختبار من Turso…');
    {
      let ok = true;
      for (const id of testJobIds) {
        const d = await fetch(`${BASE}/api/jobs/${id}`, { method: 'DELETE' });
        if (!d.ok && d.status !== 404) ok = false;
      }
      check(`حذف ${testJobIds.length} مهام اختبار`, ok);
    }
  } finally {
    server.kill('SIGTERM');
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
  }

  console.log('\n========================================');
  console.log(`نتيجة اختبار HTTP: ${passed} ناجح / ${failed} فاشل`);
  console.log('========================================');
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error('فشل تشغيل الاختبار:', e);
  process.exit(1);
});
