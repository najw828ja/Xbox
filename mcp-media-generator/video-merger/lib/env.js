'use strict';
// تحميل ملف .env يدويًا (نفس أسلوب Vercel المحلي) — يُستدعى مرة واحدة عند الإقلاع
const fs = require('fs');
const path = require('path');

let loaded = false;

function loadEnv() {
  if (loaded) return;
  loaded = true;
  const envPath = path.join(__dirname, '..', '.env');
  try {
    const raw = fs.readFileSync(envPath, 'utf8');
    for (const line of raw.split(/\r?\n/)) {
      const t = line.trim();
      if (!t || t.startsWith('#')) continue;
      const eq = t.indexOf('=');
      if (eq === -1) continue;
      const key = t.slice(0, eq).trim();
      let val = t.slice(eq + 1).trim();
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      if (!(key in process.env) || process.env[key] === '' || process.env[key] === undefined) {
        process.env[key] = val;
      }
    }
  } catch (_) {
    // لا يوجد .env محليًا — على Vercel تكون المتغيرات في البيئة مباشرة
  }
}

module.exports = { loadEnv };
