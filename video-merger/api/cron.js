'use strict';
// GET /api/cron — حذف المهام المنتهية (Cron يومي في vercel.json)
const store = require('../lib/db');
const { handleOptions, sendJson, sendError } = require('../lib/http');

module.exports = async (req, res) => {
  if (handleOptions(req, res)) return;
  if (req.method !== 'GET') {
    return sendError(res, 405, 'طريقة غير مسموحة لهذه النقطة — استخدم GET');
  }
  let deleted = 0;
  try {
    deleted = await store.cleanupExpired();
  } catch (e) {
    return sendError(res, 500, `فشل التنظيف: ${e.message}`);
  }
  return sendJson(res, 200, { deleted, at: new Date().toISOString() });
};
