// แชร์งานออกแบบสนาม + แกลเลอรี
// GET  /api/designs?id=abc            -> งานหนึ่งชิ้น (ถ้าเจ้าของยังไม่เผยแพร่ ก็เปิดได้ด้วยลิงก์ตรง)
// GET  /api/designs?ids=a,b,c         -> หลายชิ้น (หน้า "งานของฉัน")
// GET  /api/designs?list=new|top      -> งานที่เผยแพร่ในแกลเลอรี ล่าสุดหรือถูกใจมากสุด
// POST {action:'create', design, title, author, pub}  -> {id, token}  เก็บ token ไว้ที่เครื่องเจ้าของ
// POST {action:'set', id, token, pub}                 -> เจ้าของเลือกเผยแพร่หรือซ่อน
// POST {action:'delete', id, token}                   -> เจ้าของลบงาน (หรือผู้ดูแลที่ส่ง x-admin-token)
// POST {action:'like', id}                            -> ถูกใจ ได้ครั้งเดียวต่อเครื่องต่อชิ้น
const crypto = require('crypto');
const { pipeline } = require('./_redis');

const MAX_DESIGN = 30000;
const clean = (v, n) => String(v == null ? '' : v).replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, n);
const hash = t => crypto.createHash('sha256').update(String(t)).digest('hex');
const newId = () => crypto.randomBytes(6).toString('base64').replace(/[^a-zA-Z0-9]/g, '').slice(0, 8).padEnd(8, 'x');
const validId = id => typeof id === 'string' && /^[a-zA-Z0-9]{6,12}$/.test(id);
const ipOf = req => String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown';

function pub(rec, id, likes){
  return {id, title: rec.title, author: rec.author, sport: rec.sport, pub: !!rec.pub, created: rec.created, likes: Number(likes) || 0, design: rec.design};
}

async function getMany(ids){
  if (!ids.length) return [];
  const res = await pipeline(ids.flatMap(id => [['GET', 'fs:d:' + id], ['GET', 'fs:dl:' + id]]));
  const out = [];
  ids.forEach((id, k) => { const raw = res[2 * k]; if (!raw) return; try { out.push(pub(JSON.parse(raw), id, res[2 * k + 1])); } catch (e) {} });
  return out;
}

async function limited(req, key, max, sec){
  const k = 'fs:rl:' + key + ':' + hash(ipOf(req)).slice(0, 16) + ':' + Math.floor(Date.now() / (sec * 1000));
  const [n] = await pipeline([['INCR', k], ['EXPIRE', k, String(sec + 10)]]);
  return n > max;
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  try {
    if (req.method === 'GET') {
      const q = req.query || {};
      if (q.id) {
        if (!validId(q.id)) return res.status(400).json({ error: 'bad id' });
        const [item] = await getMany([q.id]);
        return item ? res.status(200).json(item) : res.status(404).json({ error: 'not found' });
      }
      if (q.ids) {
        const ids = String(q.ids).split(',').filter(validId).slice(0, 40);
        return res.status(200).json({ items: await getMany(ids) });
      }
      const key = q.list === 'top' ? 'fs:gal:top' : 'fs:gal:new';
      const off = Math.max(0, Math.min(500, parseInt(q.offset, 10) || 0));
      const [ids] = await pipeline([['ZREVRANGE', key, String(off), String(off + 47)]]);
      const items = (await getMany(Array.isArray(ids) ? ids : [])).filter(x => x.pub);
      return res.status(200).json({ items });
    }
    if (req.method !== 'POST') { res.setHeader('Allow', 'GET, POST'); return res.status(405).end(); }

    let body = req.body;
    if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = {}; } }
    body = body || {};
    const action = body.action;

    if (action === 'create') {
      if (await limited(req, 'dc', 12, 3600)) return res.status(429).json({ error: 'ส่งงานถี่เกินไป ลองใหม่ในอีกสักครู่' });
      const d = body.design;
      if (!d || typeof d !== 'object' || typeof d.sport !== 'string' || typeof d.surf !== 'string') return res.status(400).json({ error: 'ข้อมูลงานไม่ครบ' });
      const json = JSON.stringify(d);
      if (json.length > MAX_DESIGN) return res.status(413).json({ error: 'งานมีขนาดใหญ่เกินไป' });
      const sport = clean(d.uspDef && d.uspDef.n ? d.uspDef.n : body.sportName || d.sport, 60);
      const rec = { title: clean(body.title, 60) || 'สนามไม่มีชื่อ', author: clean(body.author, 40) || 'ไม่ระบุชื่อ', sport,
        pub: !!body.pub, created: Date.now(), tok: '', design: d };
      let id = newId();
      for (let i = 0; i < 3; i++) { const [ex] = await pipeline([['EXISTS', 'fs:d:' + id]]); if (!Number(ex)) break; id = newId(); }
      const token = crypto.randomBytes(18).toString('hex');
      rec.tok = hash(token);
      const cmds = [['SET', 'fs:d:' + id, JSON.stringify(rec)]];
      if (rec.pub) cmds.push(['ZADD', 'fs:gal:new', String(rec.created), id], ['ZADD', 'fs:gal:top', '0', id]);
      await pipeline(cmds);
      return res.status(200).json({ id, token });
    }

    if (!validId(body.id)) return res.status(400).json({ error: 'bad id' });
    const [raw] = await pipeline([['GET', 'fs:d:' + body.id]]);
    if (!raw) return res.status(404).json({ error: 'not found' });
    const rec = JSON.parse(raw);

    if (action === 'like') {
      if (!rec.pub) return res.status(403).json({ error: 'งานนี้ไม่ได้เผยแพร่' });
      const once = 'fs:lk:' + body.id + ':' + hash(ipOf(req)).slice(0, 16);
      const [ok] = await pipeline([['SET', once, '1', 'NX', 'EX', String(3600 * 24 * 365)]]);
      if (ok !== 'OK') { const [n] = await pipeline([['GET', 'fs:dl:' + body.id]]); return res.status(200).json({ likes: Number(n) || 0, already: true }); }
      const [n] = await pipeline([['INCR', 'fs:dl:' + body.id], ['ZINCRBY', 'fs:gal:top', '1', body.id]]);
      return res.status(200).json({ likes: Number(n) || 0 });
    }

    const admin = process.env.FS_ADMIN_TOKEN && req.headers['x-admin-token'] === process.env.FS_ADMIN_TOKEN;
    if (!admin && (!body.token || hash(body.token) !== rec.tok)) return res.status(403).json({ error: 'ไม่มีสิทธิ์แก้ไขงานนี้' });

    if (action === 'set') {
      rec.pub = !!body.pub;
      const [likes] = await pipeline([['GET', 'fs:dl:' + body.id]]);
      const cmds = [['SET', 'fs:d:' + body.id, JSON.stringify(rec)]];
      if (rec.pub) cmds.push(['ZADD', 'fs:gal:new', String(rec.created), body.id], ['ZADD', 'fs:gal:top', String(Number(likes) || 0), body.id]);
      else cmds.push(['ZREM', 'fs:gal:new', body.id], ['ZREM', 'fs:gal:top', body.id]);
      await pipeline(cmds);
      return res.status(200).json({ id: body.id, pub: rec.pub });
    }
    if (action === 'delete') {
      await pipeline([['DEL', 'fs:d:' + body.id], ['DEL', 'fs:dl:' + body.id], ['ZREM', 'fs:gal:new', body.id], ['ZREM', 'fs:gal:top', body.id]]);
      return res.status(200).json({ id: body.id, deleted: true });
    }
    return res.status(400).json({ error: 'bad action' });
  } catch (e) {
    return res.status(503).json({ error: 'ระบบแชร์ใช้งานไม่ได้ชั่วคราว' });
  }
};
