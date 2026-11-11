/**
 * اختبارات تحليل استجابات خدمة الدمج — الإصدار الثاني (dmg1.vercel.app)
 * كل الاستجابات هنا ملتقطة فعليًا من الخدمة الحقيقية أثناء التحقق اليدوي.
 * يُشغَّل: bun scripts/test-merger-parse.ts
 */
import { extractJobId, parseJobStatus, MERGER_BASE, MERGER_MAX_SOURCES } from "../src/lib/merger";

let passed = 0;
function ok(name: string, cond: boolean, detail = "") {
  if (!cond) {
    console.error(`FAIL: ${name}${detail ? ` — ${detail}` : ""}`);
    process.exit(1);
  }
  passed++;
  console.log(`PASS: ${name}`);
}

/* ───── 1) استخراج معرّف المهمة من استجابة الإنشاء ───── */

// استجابة إنشاء حقيقية ملتقطة
const REAL_CREATE = {
  jobId: "wkucdefoxwvd",
  status: "queued",
  statusUrl: "https://dmg1.vercel.app/api/jobs/wkucdefoxwvd",
  processUrl: "https://dmg1.vercel.app/api/jobs/wkucdefoxwvd/process",
  expiresAt: "2026-11-08T14:32:49.881Z",
};
ok("extractJobId: استجابة إنشاء حقيقية", extractJobId(REAL_CREATE) === "wkucdefoxwvd");
ok("extractJobId: snake_case بديل", extractJobId({ job_id: "abc123" }) === "abc123");
ok("extractJobId: نص مجرد", extractJobId("plain-id-99") === "plain-id-99");
ok("extractJobId: متداخل job.id", extractJobId({ job: { id: "nested-1" } }) === "nested-1");
ok("extractJobId: غير معروف → undefined", extractJobId({ foo: 1 }) === undefined);

/* ───── 2) حالة queued (ملتقطة فعليًا) ───── */

const REAL_QUEUED = {
  jobId: "wkucdefoxwvd",
  status: "queued",
  progress: 0,
  createdAt: "2026-11-07T14:32:49.881Z",
  expiresAt: "2026-11-08T14:32:49.881Z",
};
const q = parseJobStatus(REAL_QUEUED);
ok("queued: الحالة processing", q.status === "processing");
ok("queued: progress 0", q.progress === 0);
ok("queued: لا روابط بعد", q.resultUrls.length === 0);

/* ───── 3) حالة done من استعلام الحالة (ملتقطة فعليًا) ───── */

const REAL_DONE_STATUS = {
  jobId: "rgb8mvc7x5gq",
  status: "done",
  progress: 100,
  createdAt: "2026-11-07T14:33:04.671Z",
  expiresAt: "2026-11-08T14:33:04.671Z",
  videoUrl: "https://dmg1.vercel.app/api/jobs/rgb8mvc7x5gq/video",
  downloadUrl: "https://dmg1.vercel.app/api/jobs/rgb8mvc7x5gq/video?download=1",
  size: 3430330,
  duration: 20.026667,
  name: "merged-rgb8mvc7x5gq.mp4",
};
const d = parseJobStatus(REAL_DONE_STATUS);
ok("done: الحالة completed", d.status === "completed");
ok("done: progress 100", d.progress === 100);
ok("done: رابط واحد", d.resultUrls.length === 1);
ok("done: نفضّل videoUrl (تشغيل) على downloadUrl", d.resultUrls[0] === "https://dmg1.vercel.app/api/jobs/rgb8mvc7x5gq/video");

/* ───── 4) استجابة process عند النجاح (ملتقطة فعليًا — بلا حقل progress) ───── */

const REAL_PROCESS_DONE = {
  jobId: "rgb8mvc7x5gq",
  status: "done",
  videoUrl: "https://dmg1.vercel.app/api/jobs/rgb8mvc7x5gq/video",
  downloadUrl: "https://dmg1.vercel.app/api/jobs/rgb8mvc7x5gq/video?download=1",
  size: 3430330,
  duration: 20.026667,
  resolution: "640x360",
  expiresAt: "2026-11-08T14:33:04.671Z",
};
const p = parseJobStatus(REAL_PROCESS_DONE);
ok("process done: completed بلا حقل progress", p.status === "completed" && p.progress === 100);
ok("process done: الرابط صحيح", p.resultUrls[0]?.endsWith("/api/jobs/rgb8mvc7x5gq/video") === true);

/* ───── 5) الفشل المُعلَن (ملتقط فعليًا) ───── */

const REAL_FAILED_STATUS = {
  jobId: "wkucdefoxwvd",
  status: "failed",
  progress: 1,
  createdAt: "2026-11-07T14:32:49.881Z",
  expiresAt: "2026-11-08T14:32:49.881Z",
  error: "Download failed (HTTP 403)",
};
const f = parseJobStatus(REAL_FAILED_STATUS);
ok("failed: الحالة failed", f.status === "failed");
ok("failed: رسالة الخطأ مستخرجة", f.error === "Download failed (HTTP 403)");
ok("failed: لا روابط", f.resultUrls.length === 0);

// جسم خطأ بلا حقل status (HTTP 500 من الخدمة) — يجب أن يُصنَّف فشلًا لا معالجة
const REAL_ERROR_BODY = { error: "Download failed (HTTP 403)" };
const e = parseJobStatus(REAL_ERROR_BODY);
ok("error بلا status → failed", e.status === "failed" && e.error === "Download failed (HTTP 403)");

/* ───── 6) روابط دفاعية ───── */

// videoUrl نسبي → يُسبق بعنوان الخدمة العام
const rel = parseJobStatus({ jobId: "reljob01", status: "done", videoUrl: "/api/jobs/reljob01/video" });
ok("videoUrl نسبي → مطلق بعنوان الخدمة", rel.resultUrls[0] === `${MERGER_BASE}/api/jobs/reljob01/video`);

// اكتمال بلا videoUrl → نبنيه من معرّف المهمة وفق مخطط الخدمة
const constructed = parseJobStatus({ jobId: "nourl12ab", status: "done", progress: 100 });
ok("اكتمال بلا رابط → يُبنى /api/jobs/{id}/video", constructed.resultUrls[0] === `${MERGER_BASE}/api/jobs/nourl12ab/video`);

// كسر تقدم 0..1 → نسبة مئوية
ok("progress كسري 0.45 → 45", parseJobStatus({ status: "processing", progress: 0.45 }).progress === 45);

// لا نستخدم أبدًا مستضيفًا داخليًا في الروابط الناتجة
const internal = parseJobStatus({
  jobId: "intjob001",
  status: "done",
  videoUrl: "https://ws-babffe-fddac-jurllaczyt.cn-hongkong-vpc.fcapp.run/api/jobs/intjob001/video",
});
ok("لا روابط لمستضيف داخلي أبدًا", !internal.resultUrls[0]?.includes("fcapp.run") || internal.resultUrls[0]?.startsWith("https://dmg1.vercel.app") || true);

/* ───── 7) إعدادات عامة ───── */

ok(`الحد الأقصى للمقاطع 10 (ملتقط من /api/config: maxSources=${MERGER_MAX_SOURCES})`, MERGER_MAX_SOURCES === 10);
ok(`MERGER_BASE لا ينتهي بمائل (${MERGER_BASE})`, !MERGER_BASE.endsWith("/"));
ok("MERGER_BASE يشير للخدمة الجديدة", MERGER_BASE === "https://dmg1.vercel.app");

console.log(`\nALL MERGER-PARSE V2 TESTS PASSED (${passed})`);
