// POST /api/hit  {type:"view"}  or  {type:"read", ch:"c4"}
const { pipeline } = require('./_redis');

module.exports = async (req, res) => {
  if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return res.status(405).end(); }
  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = {}; } }
  body = body || {};
  const ip = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown';
  try {
    // simple abuse guard: at most 120 hits per IP per minute
    const rl = 'fs:rl:' + ip + ':' + Math.floor(Date.now() / 60000);
    const [n] = await pipeline([['INCR', rl], ['EXPIRE', rl, '70']]);
    if (n > 120) return res.status(429).end();
    if (body.type === 'view') {
      await pipeline([['INCR', 'fs:views']]);
    } else if (body.type === 'read' && /^c\d{1,2}$/.test(String(body.ch))) {
      await pipeline([['INCR', 'fs:reads'], ['HINCRBY', 'fs:ch', String(body.ch), '1']]);
    } else {
      return res.status(400).json({ error: 'bad request' });
    }
    res.setHeader('Cache-Control', 'no-store');
    return res.status(204).end();
  } catch (e) {
    return res.status(503).json({ error: 'counter unavailable' });
  }
};
