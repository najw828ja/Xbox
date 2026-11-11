/**
 * تغليف ثنائيات ffmpeg/ffprobe (ffmpeg-static / ffprobe-static) + ضمان صلاحية التنفيذ.
 * قد تفقد الثنائيات صلاحية التنفيذ في الاستضافة → ننسخها إلى /tmp بصلاحية 755 عند الحاجة.
 */
import fs from "fs";
import os from "os";
import path from "path";
import { execFile } from "child_process";
import ffmpegStatic from "ffmpeg-static";
import ffprobeStatic from "ffprobe-static";

const FFMPEG_SRC: string = ffmpegStatic as unknown as string;
const FFPROBE_SRC: string = ffprobeStatic.path;

async function ensureExecutable(srcPath: string): Promise<string> {
  const tmp = path.join(os.tmpdir(), `vm-${path.basename(srcPath)}`);
  try {
    fs.accessSync(tmp, fs.constants.X_OK);
    if (fs.statSync(tmp).size === fs.statSync(srcPath).size) return tmp;
  } catch {
    /* غير موجود أو غير قابل للتنفيذ */
  }
  fs.copyFileSync(srcPath, tmp);
  fs.chmodSync(tmp, 0o755);
  return tmp;
}

export async function getFfmpeg(): Promise<string> {
  return ensureExecutable(FFMPEG_SRC);
}

export async function getFfprobe(): Promise<string> {
  return ensureExecutable(FFPROBE_SRC);
}

function run(bin: string, args: string[], opts: { timeout?: number } = {}): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(
      bin,
      args,
      { maxBuffer: 64 * 1024 * 1024, timeout: opts.timeout ?? 5 * 60 * 1000 },
      (err, stdout, stderr) => {
        if (err) {
          const e = err as Error & { stderr?: string };
          e.stderr = (stderr || "").toString().slice(-4000);
          reject(e);
        } else {
          resolve({ stdout, stderr });
        }
      }
    );
  });
}

export interface ProbeResult {
  duration: number;
  width: number;
  height: number;
  fps: number;
  hasAudio: boolean;
}

/** ffprobe ملف محلي → {duration, width, height, fps, hasAudio} */
export async function ffprobeFile(file: string): Promise<ProbeResult> {
  const bin = await getFfprobe();
  const { stdout } = await run(bin, ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", file]);
  const info = JSON.parse(stdout) as {
    streams?: Array<{ codec_type: string; width?: number; height?: number; duration?: string; r_frame_rate?: string }>;
    format?: { duration?: string };
  };
  const vStream = (info.streams || []).find((s) => s.codec_type === "video");
  const aStreams = (info.streams || []).filter((s) => s.codec_type === "audio");
  if (!vStream) throw new Error("لا يحتوي الملف على مسار فيديو صالح");

  let duration: number | null = null;
  if (info.format?.duration) duration = parseFloat(info.format.duration);
  if ((!duration || !Number.isFinite(duration)) && vStream.duration) duration = parseFloat(vStream.duration);
  if (!duration || !Number.isFinite(duration)) duration = 0;

  let fps = 30;
  if (vStream.r_frame_rate?.includes("/")) {
    const [n, d] = vStream.r_frame_rate.split("/").map(Number);
    if (d > 0 && n > 0) fps = n / d;
  }

  return {
    duration,
    width: vStream.width ?? 0,
    height: vStream.height ?? 0,
    fps,
    hasAudio: aStreams.length > 0,
  };
}
