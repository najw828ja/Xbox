'use strict';
// طبقة Turso (libSQL عبر HTTP): المخطط + المهام + تخزين الـ Blobs المقسمة + التنظيف
const { createClient } = require('@libsql/client/web');
const { config } = require('./config');

if (!process.env.TURSO_DATABASE_URL || !process.env.TURSO_AUTH_TOKEN) {
  throw new Error('متغيرات البيئة TURSO_DATABASE_URL و TURSO_AUTH_TOKEN إلزامية');
}

const db = createClient({
  url: process.env.TURSO_DATABASE_URL,
  authToken: process.env.TURSO_AUTH_TOKEN,
});

let schemaReady = null;

async function ensureSchema() {
  if (!schemaReady) {
    schemaReady = db.batch([
      `CREATE TABLE IF NOT EXISTS jobs (
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
      `CREATE TABLE IF NOT EXISTS sources (
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
      `CREATE TABLE IF NOT EXISTS source_chunks (
        job_id TEXT NOT NULL,
        seq INTEGER NOT NULL,
        idx INTEGER NOT NULL,
        data BLOB NOT NULL,
        PRIMARY KEY (job_id, seq, idx)
      )`,
      `CREATE TABLE IF NOT EXISTS output_chunks (
        job_id TEXT NOT NULL,
        idx INTEGER NOT NULL,
        data BLOB NOT NULL,
        PRIMARY KEY (job_id, idx)
      )`,
    ], 'write');
  }
  await schemaReady;
}

// ---------- المهام ----------

function newId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
}

async function createJob(sources) {
  await ensureSchema();
  const id = newId();
  const createdAt = new Date();
  const expiresAt = new Date(createdAt.getTime() + config.expireHours * 3600 * 1000);
  const hasFiles = sources.some((s) => s.kind === 'file');
  const status = hasFiles ? 'uploading' : 'queued';

  const stmts = [
    {
      sql: 'INSERT INTO jobs (id, status, progress, created_at, expires_at) VALUES (?, ?, 0, ?, ?)',
      args: [id, status, createdAt.toISOString(), expiresAt.toISOString()],
    },
    ...sources.map((s, i) => ({
      sql: `INSERT INTO sources (job_id, seq, kind, url, name, size, mime, status)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [id, i, s.kind, s.url || null, s.name || null, s.size || null, s.mime || null,
        s.kind === 'url' ? 'ready' : 'pending'],
    })),
  ];
  await db.batch(stmts, 'write');
  return { id, status, createdAt, expiresAt };
}

async function getJob(id) {
  await ensureSchema();
  const r = await db.execute({ sql: 'SELECT * FROM jobs WHERE id = ?', args: [id] });
  return r.rows[0] || null;
}

async function getSources(jobId) {
  const r = await db.execute({
    sql: 'SELECT * FROM sources WHERE job_id = ? ORDER BY seq ASC',
    args: [jobId],
  });
  return r.rows;
}

async function updateJob(id, fields) {
  const keys = Object.keys(fields);
  if (!keys.length) return;
  const sets = keys.map((k) => `${k} = ?`).join(', ');
  await db.execute({
    sql: `UPDATE jobs SET ${sets} WHERE id = ?`,
    args: [...keys.map((k) => fields[k]), id],
  });
}

async function updateSource(jobId, seq, fields) {
  const keys = Object.keys(fields);
  if (!keys.length) return;
  const sets = keys.map((k) => `${k} = ?`).join(', ');
  await db.execute({
    sql: `UPDATE sources SET ${sets} WHERE job_id = ? AND seq = ?`,
    args: [...keys.map((k) => fields[k]), jobId, seq],
  });
}

// ---------- تخزين الـ Blobs (صفوف 2MB) ----------

async function saveBlobChunks(table, keyCols, keyArgs, buffer) {
  // يكتب Buffer كاملًا كصفوف BLOB لا يتجاوز كل منها tursoRowBytes
  const rows = [];
  const size = config.tursoRowBytes;
  for (let off = 0, idx = 0; off < buffer.length || (buffer.length === 0 && idx === 0); off += size, idx++) {
    const end = Math.min(off + size, buffer.length);
    rows.push({
      sql: `INSERT OR REPLACE INTO ${table} (${keyCols.join(', ')}, idx, data)
            VALUES (${keyArgs.map(() => '?').join(', ')}, ?, ?)`,
      args: [...keyArgs, idx, new Uint8Array(buffer.subarray(off, end))],
    });
    if (buffer.length === 0) break;
  }
  // كتابة على دفعات لتجنب تجاوز حدود الطلب الواحد
  for (let i = 0; i < rows.length; i += 12) {
    await db.batch(rows.slice(i, i + 12), 'write');
  }
}

async function saveSourceChunk(jobId, seq, idx, buf) {
  await db.execute({
    sql: 'INSERT OR REPLACE INTO source_chunks (job_id, seq, idx, data) VALUES (?, ?, ?, ?)',
    args: [jobId, seq, idx, new Uint8Array(buf)],
  });
}

async function saveOutputBlob(jobId, buffer) {
  await ensureSchema();
  await db.execute({ sql: 'DELETE FROM output_chunks WHERE job_id = ?', args: [jobId] });
  await saveBlobChunks('output_chunks', ['job_id'], [jobId], buffer);
}

// تجميع أجزاء مصدر مرفوع إلى Buffer (لملفات المصدر الصغيرة/المتوسطة)
async function readSourceFile(jobId, seq, expectedSize) {
  const r = await db.execute({
    sql: 'SELECT idx, data FROM source_chunks WHERE job_id = ? AND seq = ? ORDER BY idx ASC',
    args: [jobId, seq],
  });
  const parts = [];
  let total = 0;
  for (const row of r.rows) {
    const u8 = row.data instanceof Uint8Array ? row.data : new Uint8Array(row.data);
    parts.push(u8);
    total += u8.length;
  }
  const buf = Buffer.concat(parts.map((p) => Buffer.from(p)));
  if (expectedSize != null && buf.length !== expectedSize) {
    throw new Error(`حجم الملف المستلم (${buf.length} بايت) لا يطابق المعلن (${expectedSize} بايت)`);
  }
  return buf;
}

// قراءة الناتج كاملًا (صفحات من readPageRows صفوف)
async function readOutputBuffer(jobId) {
  const r = await readOutputRange(jobId, 0, Number.MAX_SAFE_INTEGER);
  return r ? r.buf : null;
}

// قراءة مدى بايتات محدد [start, end] معتمًا على أطوال الصفوف — لعمل Range 206
async function readOutputRange(jobId, start, end) {
  const sizes = await db.execute({
    sql: 'SELECT idx, LENGTH(data) AS len FROM output_chunks WHERE job_id = ? ORDER BY idx ASC',
    args: [jobId],
  });
  const rows = sizes.rows.map((r) => ({ idx: Number(r.idx), len: Number(r.len) }));
  if (!rows.length) return null;
  const total = rows.reduce((a, r) => a + r.len, 0);
  const realEnd = Math.min(end, total - 1);
  if (start > realEnd || start >= total) return { total, start, end: -1, buf: Buffer.alloc(0) };

  const parts = [];
  let offset = 0;
  for (const row of rows) {
    const rowStart = offset;
    const rowEnd = offset + row.len - 1;
    offset += row.len;
    if (rowEnd < start || rowStart > realEnd) continue;
    const d = await db.execute({
      sql: 'SELECT data FROM output_chunks WHERE job_id = ? AND idx = ?',
      args: [jobId, row.idx],
    });
    const u8 = d.rows[0].data instanceof Uint8Array ? d.rows[0].data : new Uint8Array(d.rows[0].data);
    const from = Math.max(0, start - rowStart);
    const to = Math.min(row.len - 1, realEnd - rowStart);
    parts.push(Buffer.from(u8.subarray(from, to + 1)));
  }
  return { total, start, end: realEnd, buf: Buffer.concat(parts) };
}

// ---------- الحذف والتنظيف ----------

// حذف شامل: كل صفوف المهمة من الجداول الأربعة في batch واحد
async function deleteJob(id) {
  await ensureSchema();
  await db.batch([
    { sql: 'DELETE FROM jobs WHERE id = ?', args: [id] },
    { sql: 'DELETE FROM sources WHERE job_id = ?', args: [id] },
    { sql: 'DELETE FROM source_chunks WHERE job_id = ?', args: [id] },
    { sql: 'DELETE FROM output_chunks WHERE job_id = ?', args: [id] },
  ], 'write');
}

async function deleteSourceChunks(jobId) {
  await db.execute({ sql: 'DELETE FROM source_chunks WHERE job_id = ?', args: [jobId] });
}

// تنظيف كسول: يحذف كل المهام المنتهية وجميع صفوفها
async function cleanupExpired() {
  await ensureSchema();
  const now = new Date().toISOString();
  const r = await db.execute({
    sql: 'SELECT id FROM jobs WHERE expires_at <= ?',
    args: [now],
  });
  const ids = r.rows.map((row) => row.id);
  for (const id of ids) {
    await deleteJob(id);
  }
  return ids.length;
}

module.exports = {
  db,
  ensureSchema,
  newId,
  createJob,
  getJob,
  getSources,
  updateJob,
  updateSource,
  saveSourceChunk,
  saveOutputBlob,
  readSourceFile,
  readOutputBuffer,
  readOutputRange,
  deleteJob,
  deleteSourceChunks,
  cleanupExpired,
};
