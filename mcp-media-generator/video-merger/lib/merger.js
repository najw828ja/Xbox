'use strict';
// محرك الدمج: تنزيل/تجميع المصادر → ffprobe → filter_complex موحّد → ترميز → تخزين الناتج
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { config } = require('./config');
const store = require('./db');
const { getFfmpeg, getFfprobe, ffprobeFile } = require('./ffmpeg');

// ---------- تنزيل من رابط مباشر مع عدّ البايتات والتحقق من الحد ----------

async function downloadToFile(url, dest, maxBytes, onBytes) {
  let res;
  try {
    res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(120000) });
  } catch (e) {
    throw new Error(`تعذّر الوصول إلى الرابط: ${url}`);
  }
  if (!res.ok) throw new Error(`فشل تنزيل المصدر (الحالة ${res.status}): ${url}`);

  const declared = parseInt(res.headers.get('content-length') || '0', 10);
  if (declared && declared > maxBytes) {
    throw new Error(`حجم المصدر (${(declared / 1048576).toFixed(1)}MB) يتجاوز الحد المسموح`);
  }

  const out = fs.createWriteStream(dest);
  let count = 0;
  const reader = res.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    count += value.length;
    if (count > maxBytes) {
      out.destroy();
      reader.cancel().catch(() => {});
      throw new Error(`حجم المصدر يتجاوز الحد المسموح (${config.sourceMaxBytes / 1048576}MB)`);
    }
    if (onBytes) onBytes(count);
    await new Promise((r) => out.write(Buffer.from(value), r));
  }
  await new Promise((r) => out.end(r));
  return count;
}

// ---------- حساب الدقة الهدف ----------

function targetResolution(w, h) {
  // نأخذ أكبر دقة بين المدخلات بحد أقصى 1920×1080، وأبعاد زوجية
  let W = Math.min(Math.max(w, 2), config.maxResW);
  let H = Math.min(Math.max(h, 2), config.maxResH);
  if (W % 2) W -= 1;
  if (H % 2) H -= 1;
  return { W, H };
}

// ---------- بناء filter_complex ----------

function buildFilterGraph(probes) {
  const { W, H } = targetResolution(
    Math.max(...probes.map((p) => p.width)),
    Math.max(...probes.map((p) => p.height)),
  );
  const filters = [];
  const concatPairs = [];
  let lavfiIdx = probes.length; // مدخلات anullsrc تُضاف بعد الملفات

  probes.forEach((p, i) => {
    filters.push(
      `[${i}:v]scale=${W}:${H}:force_original_aspect_ratio=decrease,` +
      `pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2,` +
      `fps=${config.fps},setsar=1,format=yuv420p[v${i}]`,
    );
    if (p.hasAudio) {
      filters.push(`[${i}:a]aresample=${config.audioRate},aformat=sample_fmts=fltp:channel_layouts=stereo[a${i}]`);
    } else {
      // مصدر بلا صوت → مسار صامت anullsrc بنفس مدته
      filters.push(`[${lavfiIdx}:a]atrim=0:${p.duration.toFixed(3)},asetpts=PTS-STARTPTS,aformat=sample_fmts=fltp:channel_layouts=stereo[a${i}]`);
      lavfiIdx += 1;
    }
    concatPairs.push(`[v${i}][a${i}]`);
  });

  filters.push(`${concatPairs.join('')}concat=n=${probes.length}:v=1:a=1[vout][aout]`);
  return { filter: filters.join(';'), W, H };
}

// ---------- ترميز مع قراءة التقدم ----------

function encodeWithProgress(binPath, args, totalDurationSec, onProgress, logTag) {
  return new Promise((resolve, reject) => {
    const child = spawn(binPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderrTail = '';
    let lastPct = -1;
    child.stdout.on('data', (d) => {
      const s = d.toString();
      const m = s.match(/out_time_us=(\d+)/);
      if (m && totalDurationSec > 0 && onProgress) {
        const ratio = Math.min(1, parseInt(m[1], 10) / (totalDurationSec * 1e6));
        const pct = 40 + Math.floor(ratio * 50); // 40→90 الترميز
        if (pct > lastPct) { lastPct = pct; onProgress(pct); }
      }
    });
    child.stderr.on('data', (d) => {
      stderrTail = (stderrTail + d.toString()).slice(-4000);
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`فشل الترميز (ffmpeg غادر بالكود ${code})${stderrTail ? ': ' + stderrTail.split('\n').slice(-3).join(' | ') : ''}`));
    });
  });
}

// ---------- دمج ملفات محلية (تُستخدم في الاختبارات أيضًا) ----------

async function mergeLocalFiles(files, onProgress) {
  if (!files.length) throw new Error('لا توجد مصادر للدمج');
  const ffmpeg = await getFfmpeg();
  const ffprobe = await getFfprobe();

  const probes = [];
  for (const f of files) probes.push(await ffprobeFile(f));

  const totalDur = probes.reduce((a, p) => a + p.duration, 0);
  if (totalDur > config.maxTotalDurationSec) {
    throw new Error(`المدة الإجمالية (${totalDur.toFixed(1)} ثانية) تتجاوز الحد المسموح (${config.maxTotalDurationSec} ثانية)`);
  }

  const { filter, W, H } = buildFilterGraph(probes);
  const outPath = path.join(os.tmpdir(), `vm-out-${Date.now()}-${Math.random().toString(36).slice(2)}.mp4`);
  const silentDur = probes.map((p) => (p.hasAudio ? null : p.duration.toFixed(3))).filter(Boolean);

  const args = ['-hide_banner', '-loglevel', 'error', '-y', '-nostdin'];
  for (const f of files) args.push('-i', f);
  let li = files.length;
  for (const p of probes) {
    if (!p.hasAudio) {
      args.push('-f', 'lavfi', '-t', p.duration.toFixed(3),
        '-i', `anullsrc=channel_layout=stereo:sample_rate=${config.audioRate}`);
      li += 1;
    }
  }
  args.push(
    '-filter_complex', filter,
    '-map', '[vout]', '-map', '[aout]',
    '-c:v', 'libx264', '-crf', String(config.crf), '-preset', config.ffmpegPreset,
    '-c:a', 'aac', '-b:a', config.audioBitrate, '-ar', String(config.audioRate),
    '-movflags', '+faststart',
    '-progress', 'pipe:1', '-nostats',
    outPath,
  );

  try {
    await encodeWithProgress(ffmpeg, args, totalDur, onProgress);
    const st = fs.statSync(outPath);
    if (st.size > config.outputMaxBytes) {
      throw new Error(`حجم الناتج (${(st.size / 1048576).toFixed(1)}MB) يتجاوز الحد المسموح (${config.outputMaxBytes / 1048576}MB)`);
    }
    const probe = await ffprobeFile(outPath);
    return {
      outPath, size: st.size, duration: probe.duration,
      width: probe.width, height: probe.height, hasAudio: probe.hasAudio,
      W, H, totalDur,
    };
  } catch (e) {
    try { fs.unlinkSync(outPath); } catch (_) {}
    throw e;
  }
}

// ---------- تنفيذ مهمة كاملة: من قاعدة البيانات إلى الناتج المخزّن ----------

async function processJob(jobId) {
  const job = await store.getJob(jobId);
  if (!job) throw Object.assign(new Error('المهمة غير موجودة'), { code: 404 });

  const st0 = (v) => (v === undefined ? undefined : v === null ? null : String(v));
  const sources = (await store.getSources(jobId)).map((r) => ({
    seq: Number(r.seq), kind: st0(r.kind), url: st0(r.url), name: st0(r.name),
    size: r.size === null ? null : Number(r.size), mime: st0(r.mime),
    status: st0(r.status),
  }));
  if (!sources.length) throw Object.assign(new Error('لا توجد مصادر في هذه المهمة'), { code: 400 });

  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vm-job-'));
  try {
    await store.updateJob(jobId, { status: 'processing', progress: 1, error: null });

    // المرحلة 1: سحب المصادر (0→40)
    const localFiles = [];
    const probes = [];
    const perSource = 40 / sources.length;

    for (let i = 0; i < sources.length; i++) {
      const s = sources[i];
      let srcPath;
      if (s.kind === 'url') {
        srcPath = path.join(workDir, `src-${i}.bin`);
        await store.updateSource(jobId, s.seq, { status: 'downloading' });
        await store.updateJob(jobId, { progress: Math.min(39, Math.round(i * perSource)) });
        const bytes = await downloadToFile(s.url, srcPath, config.sourceMaxBytes);
        if (bytes === 0) throw new Error(`المصدر فارغ: ${s.url}`);
        await store.updateSource(jobId, s.seq, { status: 'ready', size: bytes });
      } else {
        srcPath = path.join(workDir, `src-${i}.bin`);
        const buf = await store.readSourceFile(jobId, s.seq, s.size);
        if (buf.length > config.sourceMaxBytes) {
          throw Object.assign(
            new Error(`حجم المصدر (${(buf.length / 1048576).toFixed(1)}MB) يتجاوز الحد المسموح (${config.sourceMaxBytes / 1048576}MB)`),
            { code: 413 });
        }
        fs.writeFileSync(srcPath, buf);
      }
      localFiles.push(srcPath);
      const probe = await ffprobeFile(srcPath);
      probes.push(probe);
      await store.updateSource(jobId, s.seq, {
        duration: probe.duration, width: probe.width, height: probe.height,
        has_audio: probe.hasAudio ? 1 : 0,
      });
      await store.updateJob(jobId, { progress: Math.min(40, Math.round((i + 1) * perSource)) });
    }

    // التحقق من المدة الإجمالية قبل الترميز
    const totalDur = probes.reduce((a, p) => a + p.duration, 0);
    if (totalDur > config.maxTotalDurationSec) {
      throw Object.assign(
        new Error(`المدة الإجمالية (${totalDur.toFixed(1)} ثانية) تتجاوز الحد المسموح (${config.maxTotalDurationSec} ثانية)`),
        { code: 413 });
    }

    // المرحلة 2: الترميز (40→90)
    await store.updateJob(jobId, { progress: 40 });
    const result = await mergeLocalFiles(localFiles, async (pct) => {
      await store.updateJob(jobId, { progress: Math.min(90, pct) });
    });

    // المرحلة 3: تخزين الناتج (90→100)
    await store.updateJob(jobId, { progress: 91 });
    const buf = fs.readFileSync(result.outPath);
    await store.saveOutputBlob(jobId, buf);
    await store.deleteSourceChunks(jobId); // بعد النجاح: الناتج فقط هو المطلوب
    await store.updateJob(jobId, {
      status: 'done', progress: 100, error: null,
      output_size: result.size, output_duration: result.duration,
      output_width: result.width, output_height: result.height, output_mime: 'video/mp4',
    });

    return {
      size: result.size,
      duration: result.duration,
      resolution: `${result.width}x${result.height}`,
    };
  } catch (e) {
    const msg = e && e.message ? e.message : 'فشل غير معروف أثناء الدمج';
    try { await store.updateJob(jobId, { status: 'failed', error: msg }); } catch (_) {}
    throw e;
  } finally {
    // نظّف /tmp دائمًا
    try { fs.rmSync(workDir, { recursive: true, force: true }); } catch (_) {}
  }
}

module.exports = { processJob, mergeLocalFiles, downloadToFile, buildFilterGraph, targetResolution, ffprobeFile };
