'use strict';
// GET /api/config — الحدود العامة + version
const { config } = require('../lib/config');
const { handleOptions, sendJson, sendError } = require('../lib/http');

module.exports = async (req, res) => {
  if (handleOptions(req, res)) return;
  if (req.method !== 'GET') {
    return sendError(res, 405, 'طريقة غير مسموحة لهذه النقطة — استخدم GET');
  }
  return sendJson(res, 200, {
    version: config.version,
    maxSources: config.maxSources,
    sourceMaxMb: Math.round(config.sourceMaxBytes / 1048576),
    outputMaxMb: Math.round(config.outputMaxBytes / 1048576),
    maxTotalDurationSec: config.maxTotalDurationSec,
    uploadChunkBytes: config.uploadChunkBytes,
    expireHours: config.expireHours,
    maxResolution: `${config.maxResW}x${config.maxResH}`,
    fps: config.fps,
    preset: config.ffmpegPreset,
  });
};
