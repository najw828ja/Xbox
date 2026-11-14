/**
 * طبقة Turso لمهام دمج الفيديو — المخطط + المهام + تخزين الـ Blobs المقسمة + التنظيف.
 * تستخدم نفس عميل Turso للمشروع (getTurso) — لا قاعدة بيانات منفصلة.
 */
import { getTurso } from "@/lib/turso";
import { mergeConfig } from "./config";

let schemaReady: Promise<void> | undefined;

export async function ensureMergeSchema(): Promise<void> {
  if (!schemaReady) {
    schemaReady = getTurso()
      .batch(
        [
          `CREATE TABLE IF NOT EXISTS merge_jobs (
          id TEXT PRIMARY KEY,
          status TEXT NOT NULL DEFAULT 'queued',
          progress INTEGER NOT NULL DEFAULT 0,
          error TEXT,
          created_at TEXT NOT NULL,
          expires_at TEXT NOT NULL,
          output_size INTEGER,
          output_duration REAL,
          output_width INTEGER,
          output_height INTEGER,
          output_mime TEXT
        )`,
          `CREATE TABLE IF NOT EXISTS merge_sources (
          job_id TEXT NOT NULL,
          seq INTEGER NOT NULL,
          kind TEXT NOT NULL,
          url TEXT,
          name TEXT,
          size INTEGER,
          mime TEXT,
          received INTEGER NOT NULL DEFAULT 0,
          duration REAL,
          width INTEGER,
          height INTEGER,
          has_audio INTEGER,
          status TEXT NOT NULL DEFAULT 'pending',
          PRIMARY KEY (job_id, seq)
        )`,
          `CREATE TABLE IF NOT EXISTS merge_source_chunks (
          job_id TEXT NOT NULL,
          seq INTEGER NOT NULL,
          idx INTEGER NOT NULL,
          data BLOB NOT NULL,
          PRIMARY KEY (job_id, seq, idx)
        )`,
          `CREATE TABLE IF NOT EXISTS merge_output_chunks (
          job_id TEXT NOT NULL,
          idx INTEGER NOT NULL,
          data BLOB NOT NULL,
          PRIMARY KEY (job_id, idx)
        )`,
        ].map((sql) => ({ sql })),
        "write"
      )
      .catch((err) => {
        schemaReady = undefined;
        throw err;
      })
      .then(async () => {
        // ترحيل إضافي آمن وقابل للتكرار: عمود خطة التحرير (Phase 2) — لا يمس الصفوف الموجودة
        try {
          await getTurso().execute("ALTER TABLE merge_jobs ADD COLUMN ops_json TEXT");
        } catch {
          /* العمود موجود مسبقًا */
        }
      });
  }
  await schemaReady;
}

// ---------- أنواع الصفوف ----------

export interface MergeJobRow {
  id: string;
  status: string;
  progress: number;
  error: string | null;
  created_at: string;
  expires_at: string;
  output_size: number | null;
  output_duration: number | null;
  output_width: number | null;
  output_height: number | null;
  output_mime: string | null;
  ops_json?: string | null;
}

export interface MergeSourceRow {
  job_id: string;
  seq: number;
  kind: string;
  url: string | null;
  name: string | null;
  size: number | null;
  mime: string | null;
  received: number;
  duration: number | null;
  width: number | null;
  height: number | null;
  has_audio: number | null;
  status: string;
}

export interface NewSource {
  kind: "url" | "file";
  url?: string;
  name?: string;
  size?: number;
  mime?: string;
}

// ---------- المهام ----------

function newId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
}

export async function createJob(
  sources: NewSource[],
  ops?: unknown
): Promise<{ id: string; status: string; createdAt: Date; expiresAt: Date }> {
  await ensureMergeSchema();
  const id = newId();
  const createdAt = new Date();
  const expiresAt = new Date(createdAt.getTime() + mergeConfig.expireHours * 3600 * 1000);
  const hasFiles = sources.some((s) => s.kind === "file");
  const status = hasFiles ? "uploading" : "queued";
  const opsJson = ops === undefined ? null : JSON.stringify(ops);

  const stmts = [
    {
      sql: "INSERT INTO merge_jobs (id, status, progress, created_at, expires_at, ops_json) VALUES (?, ?, 0, ?, ?, ?)",
      args: [id, status, createdAt.toISOString(), expiresAt.toISOString(), opsJson],
    },
    ...sources.map((s, i) => ({
      sql: `INSERT INTO merge_sources (job_id, seq, kind, url, name, size, mime, status)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        id,
        i,
        s.kind,
        s.url || null,
        s.name || null,
        s.size || null,
        s.mime || null,
        s.kind === "url" ? "ready" : "pending",
      ],
    })),
  ];
  await getTurso().batch(stmts, "write");
  return { id, status, createdAt, expiresAt };
}

export async function getJob(id: string): Promise<MergeJobRow | null> {
  await ensureMergeSchema();
  const r = await getTurso().execute({ sql: "SELECT * FROM merge_jobs WHERE id = ?", args: [id] });
  return (r.rows[0] as unknown as MergeJobRow) || null;
}

export async function getSources(jobId: string): Promise<MergeSourceRow[]> {
  const r = await getTurso().execute({
    sql: "SELECT * FROM merge_sources WHERE job_id = ? ORDER BY seq ASC",
    args: [jobId],
  });
  return r.rows as unknown as MergeSourceRow[];
}

type JobFields = Partial<{
  status: string;
  progress: number;
  error: string | null;
  output_size: number;
  output_duration: number;
  output_width: number;
  output_height: number;
  output_mime: string;
}>;

export async function updateJob(id: string, fields: JobFields): Promise<void> {
  const keys = Object.keys(fields) as (keyof JobFields)[];
  if (!keys.length) return;
  const sets = keys.map((k) => `${k} = ?`).join(", ");
  await getTurso().execute({
    sql: `UPDATE merge_jobs SET ${sets} WHERE id = ?`,
    args: [...keys.map((k) => fields[k] as string | number | null), id],
  });
}

type SourceFields = Partial<{
  status: string;
  size: number;
  received: number;
  duration: number;
  width: number;
  height: number;
  has_audio: number;
}>;

export async function updateSource(jobId: string, seq: number, fields: SourceFields): Promise<void> {
  const keys = Object.keys(fields) as (keyof SourceFields)[];
  if (!keys.length) return;
  const sets = keys.map((k) => `${k} = ?`).join(", ");
  await getTurso().execute({
    sql: `UPDATE merge_sources SET ${sets} WHERE job_id = ? AND seq = ?`,
    args: [...keys.map((k) => fields[k] as string | number), jobId, seq],
  });
}

// ---------- تخزين الـ Blobs (صفوف 2MB) ----------

/** يكتب Buffer كاملًا كصفوف BLOB لا يتجاوز كل منها tursoRowBytes */
async function saveBlobChunks(
  table: string,
  keyCols: string[],
  keyArgs: (string | number)[],
  buffer: Buffer
): Promise<void> {
  const rows = [];
  const size = mergeConfig.tursoRowBytes;
  for (let off = 0, idx = 0; off < buffer.length || (buffer.length === 0 && idx === 0); off += size, idx++) {
    const end = Math.min(off + size, buffer.length);
    rows.push({
      sql: `INSERT OR REPLACE INTO ${table} (${keyCols.join(", ")}, idx, data)
            VALUES (${keyArgs.map(() => "?").join(", ")}, ?, ?)`,
      args: [...keyArgs, idx, new Uint8Array(buffer.subarray(off, end))],
    });
    if (buffer.length === 0) break;
  }
  // كتابة على دفعات لتجنب تجاوز حدود الطلب الواحد
  for (let i = 0; i < rows.length; i += 12) {
    await getTurso().batch(rows.slice(i, i + 12), "write");
  }
}

export async function saveSourceChunk(jobId: string, seq: number, idx: number, buf: Buffer): Promise<void> {
  await getTurso().execute({
    sql: "INSERT OR REPLACE INTO merge_source_chunks (job_id, seq, idx, data) VALUES (?, ?, ?, ?)",
    args: [jobId, seq, idx, new Uint8Array(buf)],
  });
}

export async function saveOutputBlob(jobId: string, buffer: Buffer): Promise<void> {
  await ensureMergeSchema();
  await getTurso().execute({ sql: "DELETE FROM merge_output_chunks WHERE job_id = ?", args: [jobId] });
  await saveBlobChunks("merge_output_chunks", ["job_id"], [jobId], buffer);
}

/** تجميع أجزاء مصدر مرفوع إلى Buffer (لملفات المصدر الصغيرة/المتوسطة) */
export async function readSourceFile(jobId: string, seq: number, expectedSize: number | null): Promise<Buffer> {
  const r = await getTurso().execute({
    sql: "SELECT idx, data FROM merge_source_chunks WHERE job_id = ? AND seq = ? ORDER BY idx ASC",
    args: [jobId, seq],
  });
  const parts: Buffer[] = [];
  for (const row of r.rows) {
    const u8 = row.data instanceof Uint8Array ? row.data : new Uint8Array(row.data as unknown as ArrayBuffer);
    parts.push(Buffer.from(u8));
  }
  const buf = Buffer.concat(parts);
  if (expectedSize != null && buf.length !== expectedSize) {
    throw new Error(`حجم الملف المستلم (${buf.length} بايت) لا يطابق المعلن (${expectedSize} بايت)`);
  }
  return buf;
}

/** قراءة مدى بايتات محدد [start, end] معتمًا على أطوال الصفوف — لعمل Range 206 */
export async function readOutputRange(
  jobId: string,
  start: number,
  end: number
): Promise<{ total: number; start: number; end: number; buf: Buffer } | null> {
  const sizes = await getTurso().execute({
    sql: "SELECT idx, LENGTH(data) AS len FROM merge_output_chunks WHERE job_id = ? ORDER BY idx ASC",
    args: [jobId],
  });
  const rows = sizes.rows.map((r) => ({ idx: Number(r.idx), len: Number(r.len) }));
  if (!rows.length) return null;
  const total = rows.reduce((a, r) => a + r.len, 0);
  const realEnd = Math.min(end, total - 1);
  if (start > realEnd || start >= total) return { total, start, end: -1, buf: Buffer.alloc(0) };

  const parts: Buffer[] = [];
  let offset = 0;
  for (const row of rows) {
    const rowStart = offset;
    const rowEnd = offset + row.len - 1;
    offset += row.len;
    if (rowEnd < start || rowStart > realEnd) continue;
    const d = await getTurso().execute({
      sql: "SELECT data FROM merge_output_chunks WHERE job_id = ? AND idx = ?",
      args: [jobId, row.idx],
    });
    const u8 =
      d.rows[0].data instanceof Uint8Array ? d.rows[0].data : new Uint8Array(d.rows[0].data as unknown as ArrayBuffer);
    const from = Math.max(0, start - rowStart);
    const to = Math.min(row.len - 1, realEnd - rowStart);
    parts.push(Buffer.from(u8.subarray(from, to + 1)));
  }
  return { total, start, end: realEnd, buf: Buffer.concat(parts) };
}

// ---------- الحذف والتنظيف ----------

/** حذف شامل: كل صفوف المهمة من الجداول الأربعة في batch واحد */
export async function deleteJob(id: string): Promise<void> {
  await ensureMergeSchema();
  await getTurso().batch(
    [
      { sql: "DELETE FROM merge_jobs WHERE id = ?", args: [id] },
      { sql: "DELETE FROM merge_sources WHERE job_id = ?", args: [id] },
      { sql: "DELETE FROM merge_source_chunks WHERE job_id = ?", args: [id] },
      { sql: "DELETE FROM merge_output_chunks WHERE job_id = ?", args: [id] },
    ],
    "write"
  );
}

export async function deleteSourceChunks(jobId: string): Promise<void> {
  await getTurso().execute({ sql: "DELETE FROM merge_source_chunks WHERE job_id = ?", args: [jobId] });
}

/** تنظيف كسول: يحذف كل المهام المنتهية وجميع صفوفها (تحذير الـ 24 ساعة) */
export async function cleanupExpired(): Promise<number> {
  await ensureMergeSchema();
  const now = new Date().toISOString();
  const r = await getTurso().execute({
    sql: "SELECT id FROM merge_jobs WHERE expires_at <= ?",
    args: [now],
  });
  const ids = r.rows.map((row) => String(row.id));
  for (const id of ids) {
    await deleteJob(id);
  }
  return ids.length;
}
