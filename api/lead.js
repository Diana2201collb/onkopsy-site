// Приём заявок с сайта и создание сделки в amoCRM.
// Переменные окружения в Vercel: AMO_TOKEN (долгосрочный токен), AMO_DOMAIN (psychologyhealth.amocrm.ru),
// AMO_PIPELINE_ID и AMO_STATUS_ID — воронка и этап для новых заявок, ALLOWED_ORIGINS — адреса сайта,
// CHECK_KEY — ключ служебной проверки.
const EDU = { psy: 'высшее психологическое', other: 'высшее непсихологическое', none: 'высшего пока нет' };
const ROUTE = { '72': 'КПК 72 часа', '360': 'ДПП 360 часов', '520': 'ДПП 520 часов', metanoia: 'клуб METANOIA' };

const clean = (v, max = 300) => String(v == null ? '' : v).replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, max);

function cors(req, res) {
  const origin = req.headers.origin || '';
  const allow = (process.env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
  const sameHost = origin && req.headers.host && origin.replace(/^https?:\/\//, '') === req.headers.host;
  const ok = !origin || sameHost || !allow.length || allow.includes(origin);
  res.setHeader('Access-Control-Allow-Origin', allow.length ? (allow.includes(origin) ? origin : allow[0]) : '*');
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Max-Age', '86400');
  return ok;
}

async function createLead(domain, token, d, extra) {
  const api = (path, body) => fetch(`https://${domain}${path}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  const routeTxt = ROUTE[d.route] || '';
  const lead = {
    name: `${d.test ? 'ТЕСТ — ' : ''}Онкопсихология — заявка с сайта${routeTxt ? ' (' + routeTxt + ')' : ''}`,
    _embedded: {
      tags: [{ name: 'Сайт онкопсихология' }].concat(routeTxt ? [{ name: routeTxt }] : []),
      contacts: [{
        first_name: d.name,
        custom_fields_values: [
          { field_code: 'PHONE', values: [{ value: d.phone, enum_code: 'WORK' }] },
          { field_code: 'EMAIL', values: [{ value: d.email, enum_code: 'WORK' }] }
        ]
      }]
    }
  };
  if (process.env.AMO_PIPELINE_ID) lead.pipeline_id = Number(process.env.AMO_PIPELINE_ID);
  if (process.env.AMO_STATUS_ID) lead.status_id = Number(process.env.AMO_STATUS_ID);

  const r = await api('/api/v4/leads/complex', [lead]);
  if (!r.ok) {
    const txt = (await r.text()).slice(0, 800);
    console.error('amo leads/complex', r.status, txt);
    return { ok: false, status: r.status, detail: txt };
  }
  const created = await r.json();
  const leadId = created && created[0] && created[0].id;

  const lines = [
    d.test ? 'ТЕСТОВАЯ заявка — проверка связи сайта с CRM, её можно удалить.' : 'Заявка с сайта «Обучение онкопсихологии»',
    `Имя: ${d.name}`, `Телефон: ${d.phone}`, `Email: ${d.email}`,
    `Образование: ${EDU[d.education] || '—'}`,
    `Программа: ${routeTxt || 'не выбрана'}`,
    `Удобный способ связи: ${d.messenger || '—'}`
  ];
  if (d.profession) lines.push(`Профессия и опыт: ${d.profession}`);
  if (d.goal) lines.push(`Цель обучения: ${d.goal}`);
  const utm = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term']
    .map(k => extra[k] ? `${k}: ${clean(extra[k], 200)}` : '').filter(Boolean);
  if (utm.length) lines.push('', ...utm);
  if (extra.referrer) lines.push(`Источник перехода: ${clean(extra.referrer, 300)}`);
  if (extra.landing) lines.push(`Страница: ${clean(extra.landing, 300)}`);

  let noteOk = true;
  if (leadId) {
    const n = await api(`/api/v4/leads/${leadId}/notes`, [{ note_type: 'common', params: { text: lines.join('\n') } }]);
    if (!n.ok) { noteOk = false; console.error('amo notes', n.status, (await n.text()).slice(0, 300)); }
  }
  return { ok: true, lead_id: leadId || null, note: noteOk };
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const originOk = cors(req, res);
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (!originOk) return res.status(403).json({ ok: false, error: 'origin' });
  const token = process.env.AMO_TOKEN;
  const domain = (process.env.AMO_DOMAIN || 'psychologyhealth.amocrm.ru').replace(/^https?:\/\//, '').replace(/\/$/, '');
  const q = req.query || {};

  // Служебная проверка: GET /api/lead?check=<CHECK_KEY>  — только чтение;
  // GET /api/lead?check=<CHECK_KEY>&test=1 — создаёт одну тестовую сделку «ТЕСТ — …».
  if (req.method === 'GET' && process.env.CHECK_KEY && q.check === process.env.CHECK_KEY) {
    if (!token) return res.status(503).json({ ok: false, error: 'not_configured' });
    try {
      if (q.test === '1') {
        const r = await createLead(domain, token, {
          test: true, name: 'Тест сайта', phone: '+7 900 000-00-00', email: 'test@assurgina.ru',
          education: 'psy', route: '360', messenger: 'Telegram'
        }, {});
        return res.status(r.ok ? 200 : 502).json(Object.assign({
          pipeline_id: process.env.AMO_PIPELINE_ID || null, status_id: process.env.AMO_STATUS_ID || null,
          allowed_origins: process.env.ALLOWED_ORIGINS || null
        }, r));
      }
      const h = { Authorization: `Bearer ${token}` };
      const a = await fetch(`https://${domain}/api/v4/account`, { headers: h });
      if (!a.ok) return res.status(502).json({ ok: false, error: 'crm', status: a.status });
      const acc = await a.json();
      return res.status(200).json({ ok: true, account: acc.name, pipeline_id: process.env.AMO_PIPELINE_ID || null, status_id: process.env.AMO_STATUS_ID || null });
    } catch (e) { return res.status(502).json({ ok: false, error: 'network', message: e && e.message }); }
  }

  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'method' });
  if (!token) return res.status(503).json({ ok: false, error: 'not_configured' });

  let b = req.body;
  if (typeof b === 'string') { try { b = JSON.parse(b); } catch (e) { b = {}; } }
  b = b || {};
  if (b.website) return res.status(200).json({ ok: true }); // бот заполнил скрытое поле

  const d = {
    name: clean(b.name, 120), phone: clean(b.phone, 40), email: clean(b.email, 120),
    messenger: clean(b.messenger, 30), education: clean(b.education, 20), route: clean(b.route, 20),
    profession: clean(b.profession), goal: clean(b.goal, 1000)
  };
  const digits = d.phone.replace(/\D/g, '');
  if (d.name.length < 2 || digits.length < 10 || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(d.email)) {
    return res.status(400).json({ ok: false, error: 'invalid' });
  }
  try {
    const r = await createLead(domain, token, d, b);
    return res.status(r.ok ? 200 : 502).json(r.ok ? { ok: true, lead_id: r.lead_id } : { ok: false, error: 'crm' });
  } catch (e) {
    console.error('amo error', e && e.message);
    return res.status(502).json({ ok: false, error: 'network' });
  }
};
