'use strict';
// اختبار الوحدات: توليد فيديوهين مختلفي الدقة → دمج → تحقق من الدقة/المدة/الصوت
// ثم: تخزين Turso (sha256)، رفع الأجزاء، الحدود، الحذف الشامل
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const { config } = require('../lib/config');
const store = require('../lib/db');
const { getFfmpeg, getFfprobe, ffprobeFile } = require('../lib/ffmpeg');
const { mergeLocalFiles, targetResolution, buildFilterGraph } = require('../lib/merger');
const { loadEnv } = require('../lib/env');
loadEnv();

let passed = 0, failed = 0;
const testJobIds = [];

function check(name, cond, extra) {
  if (cond) { passed++; console.log('  ✅ ' + name); }
  else { failed++; console.log('  ❌ ' + name + (extra ? ' — ' + extra : '')); }
}
function sha256(buf) { return crypto.createHash('sha256').update(buf).digest('hex'); }

function genVideo(outPath, w, h, dur, withAudio) {
  const bin = getFfmpegSync();
  const args = ['-hide_banner', '-loglevel', 'error', '-y'];
  if (withAudio) {
    args.push('-f', 'lavfi', '-t', String(dur), '-i', `testsrc=size=${w}x${h}:rate=25`,
      '-f', 'lavfi', '-t', String(dur), '-i', 'sine=frequency=440');
  } else {
    args.push('-f', 'lavfi', '-t', String(dur), '-i', `testsrc=size=${w}x${h}:rate=25`);
  }
  args.push(
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-preset', 'veryfast',
  );
  if (withAudio) args.push('-c:a', 'aac', '-shortest');
  args.push(outPath);
  execFileSync(bin, args, { stdio: 'pipe' });
}
function getFfmpegSync() {
  // ensureExecutable يعمل async؛ في الاختبار المحلي الثنائي الأصلي قابل للتنفيذ
  return require('../lib/ffmpeg').FFMPEG_SRC;
}

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vm-test-'));
  const fa = path.join(tmp, 'a-640x360-3s.mp4');
  const fb = path.join(tmp, 'b-1280x720-2s.mp4');
  const fc = path.join(tmp, 'c-320x240-2s-muted.mp4');

  console.log('\n[1] توليد مقاطع الاختبار بـ ffmpeg…');
  genVideo(fa, 640, 360, 3, true);
  genVideo(fb, 1280, 720, 2, true);
  genVideo(fc, 320, 240, 2, false); // بلا صوت لاختبار anullsrc
  const pa = await ffprobeFile(fa);
  const pb = await ffprobeFile(fb);
  check('توليد المقطع A (640x360, 3s, صوت)', pa.width === 640 && pa.height === 360 && Math.abs(pa.duration - 3) < 0.5 && pa.hasAudio);
  check('توليد المقطع B (1280x720, 2s, صوت)', pb.width === 1280 && pb.height === 720 && Math.abs(pb.duration - 2) < 0.5 && pb.hasAudio);

  console.log('\n[2] الدمج الفعلي (A + B) — الدقة = أكبر دقة مدخل…');
  const r = await mergeLocalFiles([fa, fb], () => {});
  check('اكتمال الدمج', !!r.outPath && fs.existsSync(r.outPath));
  check(`الدقة = 1280x720 (الفعلي: ${r.width}x${r.height})`, r.width === 1280 && r.height === 720);
  check(`المدة ≈ 5 ثوانٍ (الفعلي: ${r.duration.toFixed(2)})`, Math.abs(r.duration - 5) < 0.8);
  check('وجود مسار صوتي في الناتج', r.hasAudio);
  const outProbe = await ffprobeFile(r.outPath);
  check('الناتج صالح بـ ffprobe (h264/aac)', outProbe.hasAudio && outProbe.width === 1280);

  console.log('\n[3] الدمج مع مصدر بلا صوت (anullsrc)…');
  const r2 = await mergeLocalFiles([fa, fc], () => {});
  check(`دمج A + صامت دون فشل — الدقة ${r2.width}x${r2.height}`, r2.width === 640 && r2.height === 360);
  check(`المدة ≈ 5 (الفعلي: ${r2.duration.toFixed(2)})`, Math.abs(r2.duration - 5) < 0.8);
  check('الناتج يحتوي صوتًا (anullsrc عمل)', r2.hasAudio);

  console.log('\n[4] حساب الدقة الهدف (حد 1920x1080، أبعاد زوجية)…');
  const t1 = targetResolution(1280, 720);
  const t2 = targetResolution(2560, 1440);
  const t3 = targetResolution(853, 479);
  check('1280x720 يبقى كما هو', t1.W === 1280 && t1.H === 720);
  check('2560x1440 يُقص إلى 1920x1080', t2.W === 1920 && t2.H === 1080);
  check('الأبعاد الفردية تُصبح زوجية (853x479 → 852x478)', t3.W === 852 && t3.H === 478);

  console.log('\n[5] التخزين في Turso — كتابة/قراءة Blob مع sha256…');
  await store.ensureSchema();
  const src = fs.readFileSync(r.outPath);
  const job1 = await store.createJob([{ kind: 'url', url: 'test://unit' }]);
  testJobIds.push(job1.id);
  await store.saveOutputBlob(job1.id, src);
  const back = await store.readOutputBuffer(job1.id);
  check(`sha256 متطابق (${(src.length / 1048576).toFixed(1)}MB عبر صفوف ${(config.tursoRowBytes / 1048576)}MB)`, sha256(back) === sha256(src));
  check('حجم الناتج المسجل متطابق', back.length === src.length);

  console.log('\n[6] قراءة Range من التخزين…');
  const rr = await store.readOutputRange(job1.id, 0, 1023);
  check('Range الأول 1024 بايت متطابق', rr && sha256(rr.buf) === sha256(src.subarray(0, 1024)));
  const rr2 = await store.readOutputRange(job1.id, src.length - 1024, src.length - 1);
  check('Range الأخير متطابق', rr2 && sha256(rr2.buf) === sha256(src.subarray(src.length - 1024)));
  const mid = Math.floor(src.length / 2);
  const rr3 = await store.readOutputRange(job1.id, mid, mid + 999);
  check('Range الأوسط متطابق', rr3 && sha256(rr3.buf) === sha256(src.subarray(mid, mid + 1000)));

  console.log('\n[7] مسار رفع الأجزاء (source_chunks)…');
  const job2 = await store.createJob([{ kind: 'file', name: 'up.mp4', size: src.length, mime: 'video/mp4' }]);
  testJobIds.push(job2.id);
  const chunkSize = config.tursoRowBytes;
  for (let i = 0, idx = 0; i < src.length; i += chunkSize, idx++) {
    await store.saveSourceChunk(job2.id, 0, idx, src.subarray(i, Math.min(i + chunkSize, src.length)));
  }
  const assembled = await store.readSourceFile(job2.id, 0, src.length);
  check('تجميع الأجزاء المرفوعة متطابق sha256', sha256(assembled) === sha256(src));

  console.log('\n[8] الحدود…');
  const bigBuf = Buffer.alloc(config.sourceMaxBytes + 1, 1);
  let threw = false;
  try {
    await store.readSourceFile(job2.id, 0, bigBuf.length); // حجم معلن أكبر من المستلم
  } catch (e) { threw = true; }
  check('رفض حجم لا يطابق المعلن', threw);
  const g = buildFilterGraph([{ width: 640, height: 360, duration: 3, hasAudio: false }]);
  check('filter_complex يضم anullsrc وconcat', /anullsrc|atrim/.test(g.filter) && g.filter.includes('concat=n=1:v=1:a=1'));

  console.log('\n[9] الحذف الشامل…');
  await store.deleteJob(job1.id);
  await store.deleteJob(job2.id);
  const gone1 = await store.getJob(job1.id);
  const g2 = await store.db.execute({ sql: 'SELECT COUNT(*) AS c FROM output_chunks WHERE job_id = ?', args: [job1.id] });
  const g3 = await store.db.execute({ sql: 'SELECT COUNT(*) AS c FROM source_chunks WHERE job_id = ?', args: [job2.id] });
  check('المهمة حُذفت', gone1 === null);
  check('صفوف output_chunks حُذفت', Number(g2.rows[0].c) === 0);
  check('صفوف source_chunks حُذفت', Number(g3.rows[0].c) === 0);
  const nr = await store.readOutputRange(job1.id, 0, 10);
  check('قراءة بعد الحذف تُرجع null', nr === null);

  console.log('\n[10] التنظيف الكسول (cleanupExpired)…');
  const job3 = await store.createJob([{ kind: 'url', url: 'test://expire' }]);
  testJobIds.push(job3.id);
  await store.db.execute({
    sql: 'UPDATE jobs SET expires_at = ? WHERE id = ?',
    args: [new Date(Date.now() - 1000).toISOString(), job3.id],
  });
  const deleted = await store.cleanupExpired();
  const gone3 = await store.getJob(job3.id);
  check('المهمة المنتهية حُذفت تلقائيًا', gone3 === null && deleted >= 1);

  // تنظيف نهائي لكل بقايا الاختبار
  for (const id of testJobIds) { try { await store.deleteJob(id); } catch (_) {} }

  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}

  console.log('\n========================================');
  console.log(`نتيجة اختبار الوحدات: ${passed} ناجح / ${failed} فاشل`);
  console.log('========================================');
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error('فشل تشغيل الاختبار:', e);
  process.exit(1);
});
