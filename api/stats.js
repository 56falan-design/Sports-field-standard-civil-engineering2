// GET /api/stats -> {views, reads, ch:{c4:12,...}}
const { pipeline } = require('./_redis');

module.exports = async (req, res) => {
  try {
    const [views, reads, flat] = await pipeline([['GET', 'fs:views'], ['GET', 'fs:reads'], ['HGETALL', 'fs:ch']]);
    const ch = {};
    if (Array.isArray(flat)) for (let i = 0; i < flat.length; i += 2) ch[flat[i]] = Number(flat[i + 1]) || 0;
    else if (flat && typeof flat === 'object') for (const k in flat) ch[k] = Number(flat[k]) || 0;
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json({ views: Number(views) || 0, reads: Number(reads) || 0, ch });
  } catch (e) {
    return res.status(503).json({ error: 'counter unavailable' });
  }
};
