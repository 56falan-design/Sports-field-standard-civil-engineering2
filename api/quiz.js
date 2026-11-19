// กระดานคะแนนแบบฝึกหัด รายสัปดาห์
// GET  /api/quiz                          -> {week, top:[{name, score, total}]}
// POST {name, score, total}               -> บันทึกคะแนน (ชื่อเดียวกันเก็บคะแนนที่ดีที่สุด)
const crypto = require('crypto');
const { pipeline } = require('./_redis');

const clean = (v, n) => String(v == null ? '' : v).replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, n);
const ipOf = req => String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown';
function weekKey(t){
  const d = new Date(t + 7 * 3600e3); // เวลาไทย
  const day = (d.getUTCDay() + 6) % 7; d.setUTCDate(d.getUTCDate() - day + 3);
  const y = d.getUTCFullYear(), w1 = new Date(Date.UTC(y, 0, 4));
  return y + '-W' + String(1 + Math.round(((d - w1) / 864e5 - 3 + (w1.getUTCDay() + 6) % 7) / 7)).padStart(2, '0');
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const week = weekKey(Date.now()), key = 'fs:qz:' + week;
  try {
    if (req.method === 'GET') {
      const [flat] = await pipeline([['ZREVRANGE', key, '0', '9', 'WITHSCORES']]);
      const top = [];
      if (Array.isArray(flat)) for (let i = 0; i < flat.length; i += 2) top.push({ name: String(flat[i]), score: Number(flat[i + 1]) || 0, total: 10 });
      return res.status(200).json({ week, top });
    }
    if (req.method !== 'POST') { res.setHeader('Allow', 'GET, POST'); return res.status(405).end(); }
    let body = req.body;
    if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = {}; } }
    body = body || {};
    const name = clean(body.name, 24), score = Number(body.score), total = Number(body.total);
    if (!name || total !== 10 || !Number.isInteger(score) || score < 0 || score > 10) return res.status(400).json({ error: 'ข้อมูลคะแนนไม่ถูกต้อง' });
    const rl = 'fs:rl:qz:' + crypto.createHash('sha256').update(ipOf(req)).digest('hex').slice(0, 16) + ':' + Math.floor(Date.now() / 3600e3);
    const [n] = await pipeline([['INCR', rl], ['EXPIRE', rl, '3700']]);
    if (n > 30) return res.status(429).json({ error: 'ส่งคะแนนถี่เกินไป' });
    // GT: เก็บคะแนนใหม่เฉพาะเมื่อดีกว่าเดิม
    await pipeline([['ZADD', key, 'GT', String(score), name], ['EXPIRE', key, String(3600 * 24 * 40)]]);
    const [rank] = await pipeline([['ZREVRANK', key, name]]);
    return res.status(200).json({ week, rank: rank === null ? null : Number(rank) + 1 });
  } catch (e) {
    return res.status(503).json({ error: 'กระดานคะแนนใช้งานไม่ได้ชั่วคราว' });
  }
};
