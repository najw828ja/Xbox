'use strict';
// تغليف ثنائيات ffmpeg/ffprobe + ensureExecutable (نسخ إلى /tmp بصلاحية 755)
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const ffmpegStatic = require('ffmpeg-static');
const ffprobeStatic = require('ffprobe-static');

const FFMPEG_SRC = ffmpegStatic;
const FFPROBE_SRC = ffprobeStatic.path;

// ثنائي قد يفقد صلاحية التنفيذ في الاستضافة → ننسخه إلى /tmp بصلاحية 755 عند الحاجة
async function ensureExecutable(srcPath) {
  const tmp = path.join(os.tmpdir(), `vm-${path.basename(srcPath)}`);
  try {
    fs.accessSync(tmp, fs.constants.X_OK);
    // نتأكد أن الملف في /tmp موجود ومطابق الحجم
    if (fs.statSync(tmp).size === fs.statSync(srcPath).size) return tmp;
  } catch (_) { /* غير موجود أو غير قابل للتنفيذ */ }
  fs.copyFileSync(srcPath, tmp);
  fs.chmodSync(tmp, 0o755);
  return tmp;
}

async function getFfmpeg() { return ensureExecutable(FFMPEG_SRC); }
async function getFfprobe() { return ensureExecutable(FFPROBE_SRC); }

function run(bin, args, opts = {}) {
  return new Promise((resolve, reject) => {
    execFile(bin, args, { maxBuffer: 64 * 1024 * 1024, timeout: 5 * 60 * 1000, ...opts }, (err, stdout, stderr) => {
      if (err) {
        err.stderr = (stderr || '').toString().slice(-4000);
        reject(err);
      } else {
        resolve({ stdout, stderr });
      }
    });
  });
}

// ffprobe ملف محلي → {duration, width, height, fps, hasAudio}
async function ffprobeFile(file) {
  const bin = await getFfprobe();
  const { stdout } = await run(bin, [
    '-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file,
  ]);
  const info = JSON.parse(stdout);
  const vStream = (info.streams || []).find((s) => s.codec_type === 'video');
  const aStreams = (info.streams || []).filter((s) => s.codec_type === 'audio');
  if (!vStream) throw new Error('لا يحتوي الملف على مسار فيديو صالح');

  let duration = null;
  if (info.format && info.format.duration) duration = parseFloat(info.format.duration);
  if ((!duration || !Number.isFinite(duration)) && vStream.duration) duration = parseFloat(vStream.duration);
  if (!duration || !Number.isFinite(duration)) duration = 0;

  let fps = 30;
  if (vStream.r_frame_rate && vStream.r_frame_rate.includes('/')) {
    const [n, d] = vStream.r_frame_rate.split('/').map(Number);
    if (d > 0 && n > 0) fps = n / d;
  }

  return {
    duration,
    width: vStream.width,
    height: vStream.height,
    fps,
    hasAudio: aStreams.length > 0,
  };
}

module.exports = { getFfmpeg, getFfprobe, ffprobeFile, run, ensureExecutable, FFMPEG_SRC, FFPROBE_SRC };
