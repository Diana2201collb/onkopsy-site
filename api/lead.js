// Приём заявок с сайта и создание сделки в amoCRM.
// Переменные окружения в Vercel: AMO_TOKEN (долгосрочный токен), AMO_DOMAIN (psychologyhealth.amocrm.ru),
// AMO_PIPELINE_ID и AMO_STATUS_ID — воронка и этап для новых заявок, ALLOWED_ORIGINS — адреса сайта,
// CHECK_KEY — ключ служебной проверки.
const EDU = { psy: 'высшее психологическое', other: 'высшее непсихологическое', none: 'высшего пока нет' };
const ROUTE = { '72': 'КПК 72 часа', '360': 'ДПП 360 часов', '520': 'ДПП 520 часов', metanoia: 'клуб METANOIA' };
const UTM = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term'];
const TRACKING = UTM.concat(['yclid', 'gclid', 'fbclid', 'from', 'roistat', 'openstat_service', 'openstat_campaign', 'openstat_ad', 'openstat_source']);

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

// ---------- поля сделки в amoCRM ----------
// Поля ищутся по коду или названию (без учёта регистра), список кэшируется на 10 минут.
let fieldCache = null, fieldCacheAt = 0;
async function leadFields(domain, token) {
  if (fieldCache && Date.now() - fieldCacheAt < 600000) return fieldCache;
  const out = [];
  for (let page = 1; page <= 5; page++) {
    const r = await fetch(`https://${domain}/api/v4/leads/custom_fields?limit=250&page=${page}`, { headers: { Authorization: `Bearer ${token}` } });
    if (r.status === 204 || !r.ok) break;
    const j = await r.json();
    const list = (j._embedded && j._embedded.custom_fields) || [];
    out.push(...list);
    if (!j._links || !j._links.next) break;
  }
  fieldCache = out; fieldCacheAt = Date.now();
  return out;
}

function findField(fields, key) {
  const k = key.toLowerCase();
  return fields.find(f => (f.code || '').toLowerCase() === k)
      || fields.find(f => (f.name || '').trim().toLowerCase() === k);
}

// Значение в формате amoCRM в зависимости от типа поля.
function fieldValue(f, value) {
  if (value == null || value === '') return null;
  const t = f.type;
  if (t === 'checkbox') return { field_id: f.id, values: [{ value: true }] };
  if (t === 'select' || t === 'radiobutton' || t === 'multiselect') {
    const v = String(value).toLowerCase();
    const e = (f.enums || []).find(x => String(x.value).toLowerCase() === v)
           || (f.enums || []).find(x => String(x.value).toLowerCase().includes(v) || v.includes(String(x.value).toLowerCase()));
    return e ? { field_id: f.id, values: [{ enum_id: e.id }] } : null;
  }
  return { field_id: f.id, values: [{ value: String(value) }] };
}

function buildFieldValues(fields, map) {
  const values = [], used = {}, missing = [];
  Object.keys(map).forEach(key => {
    const f = findField(fields, key);
    if (!f) { missing.push(key); return; }
    if (used[f.id]) return;
    const fv = fieldValue(f, map[key]);
    if (fv) { values.push(fv); used[f.id] = key; } else if (map[key]) missing.push(key + ' (значение не подошло)');
  });
  return { values, used: Object.values(used), missing };
}

async function createLead(domain, token, d, extra) {
  const api = (path, body) => fetch(`https://${domain}${path}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  const routeTxt = ROUTE[d.route] || '';

  // Полная ссылка, с которой пришла заявка, вместе с UTM-метками.
  let sourceUrl = clean(extra.landing, 1000);
  if (!sourceUrl && extra.page) sourceUrl = clean(extra.page, 1000);

  const map = {
    referrer: sourceUrl, REFERER: sourceUrl, utm_referrer: sourceUrl,
    MESSENGER: d.messenger,
    PRIVACYPOLICY: d.consent ? 'YES' : ''
  };
  // UTM-метки и другие метки рекламы — в системные поля amoCRM (UTM_SOURCE, UTM_MEDIUM, …, YCLID, GCLID, FBCLID).
  // Берутся из формы, а если их там нет — из полной ссылки, с которой пришла заявка.
  let params = null;
  try { params = sourceUrl ? new URL(sourceUrl).searchParams : null; } catch (e) { params = null; }
  TRACKING.forEach(k => {
    const v = extra[k] || (params && params.get(k));
    if (v) map[k] = clean(v, 250);
  });

  let cf = { values: [], used: [], missing: [] };
  try { cf = buildFieldValues(await leadFields(domain, token), map); }
  catch (e) { console.error('amo custom_fields', e && e.message); }

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
  if (cf.values.length) lead.custom_fields_values = cf.values;
  if (process.env.AMO_PIPELINE_ID) lead.pipeline_id = Number(process.env.AMO_PIPELINE_ID);
  if (process.env.AMO_STATUS_ID) lead.status_id = Number(process.env.AMO_STATUS_ID);

  let r = await api('/api/v4/leads/complex', [lead]);
  if (!r.ok && lead.custom_fields_values) {
    // Если какое-то поле не приняли — не теряем заявку: создаём без доп. полей, всё останется в примечании.
    console.error('amo leads/complex with fields', r.status, (await r.text()).slice(0, 800));
    delete lead.custom_fields_values;
    cf.missing.push('поля не приняты amoCRM');
    r = await api('/api/v4/leads/complex', [lead]);
  }
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
    `Удобный способ связи: ${d.messenger || '—'}`,
    `Согласие на обработку данных: ${d.consent ? 'да' : 'нет'}`
  ];
  if (d.profession) lines.push(`Профессия и опыт: ${d.profession}`);
  if (d.goal) lines.push(`Цель обучения: ${d.goal}`);
  if (sourceUrl) lines.push('', `Страница заявки: ${sourceUrl}`);
  if (extra.referrer) lines.push(`Откуда пришли на сайт: ${clean(extra.referrer, 500)}`);

  let noteOk = true;
  if (leadId) {
    const n = await api(`/api/v4/leads/${leadId}/notes`, [{ note_type: 'common', params: { text: lines.join('\n') } }]);
    if (!n.ok) { noteOk = false; console.error('amo notes', n.status, (await n.text()).slice(0, 300)); }
  }
  return { ok: true, lead_id: leadId || null, note: noteOk, fields_filled: cf.used, fields_missing: cf.missing };
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const originOk = cors(req, res);
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (!originOk) return res.status(403).json({ ok: false, error: 'origin' });
  const token = process.env.AMO_TOKEN;
  const domain = (process.env.AMO_DOMAIN || 'psychologyhealth.amocrm.ru').replace(/^https?:\/\//, '').replace(/\/$/, '');
  const q = req.query || {};

  // Служебная проверка (ключ CHECK_KEY):
  //   ?check=KEY           — связь с amoCRM (только чтение)
  //   ?check=KEY&fields=1  — список полей сделки (только чтение)
//   ?check=KEY&stats=1   — заявки с сайта для аналитики (только чтение)
  //   ?check=KEY&test=1    — создаёт одну тестовую сделку «ТЕСТ — …»
  if (req.method === 'GET' && process.env.CHECK_KEY && q.check === process.env.CHECK_KEY) {
    if (!token) return res.status(503).json({ ok: false, error: 'not_configured' });
    try {
      if (q.stats === '1') {
        // Заявки с сайта: сделки «Онкопсихология — заявка с сайта…» (без тестовых).
        const h = { Authorization: `Bearer ${token}` };
        const st = await fetch(`https://${domain}/api/v4/leads/pipelines`, { headers: h }).then(r => r.ok ? r.json() : null).catch(() => null);
        const stName = {};
        (st && st._embedded ? st._embedded.pipelines : []).forEach(p => (p._embedded.statuses || []).forEach(x => { stName[x.id] = p.name + ' / ' + x.name; }));
        const leads = [];
        for (let page = 1; page <= 20; page++) {
          const r = await fetch(`https://${domain}/api/v4/leads?limit=250&page=${page}&query=${encodeURIComponent('заявка с сайта')}`, { headers: h });
          if (r.status === 204 || !r.ok) break;
          const j = await r.json();
          const list = (j._embedded && j._embedded.leads) || [];
          leads.push(...list);
          if (!j._links || !j._links.next) break;
        }
        const cfv = (l, code) => { const f = (l.custom_fields_values || []).find(x => (x.field_code || '') === code); return f && f.values[0] ? String(f.values[0].value) : ''; };
        const rows = leads.filter(l => /^Онкопсихология — заявка с сайта/.test(l.name || '')).map(l => ({
          id: l.id, name: l.name, created: new Date(l.created_at * 1000).toISOString(), status: stName[l.status_id] || String(l.status_id),
          closed: l.closed_at ? new Date(l.closed_at * 1000).toISOString() : null, price: l.price || 0,
          utm_source: cfv(l, 'UTM_SOURCE'), utm_medium: cfv(l, 'UTM_MEDIUM'), utm_campaign: cfv(l, 'UTM_CAMPAIGN'),
          utm_content: cfv(l, 'UTM_CONTENT'), utm_term: cfv(l, 'UTM_TERM'), referrer: cfv(l, 'REFERRER'), messenger: cfv(l, 'MESSENGER')
        }));
        return res.status(200).json({ ok: true, total: rows.length, leads: rows });
      }
      if (q.fields === '1') {
        fieldCache = null;
        const fs = await leadFields(domain, token);
        return res.status(200).json({ ok: true, lead_fields: fs.map(f => ({ id: f.id, name: f.name, code: f.code || null, type: f.type, enums: (f.enums || []).map(e => e.value) })) });
      }
      if (q.test === '1') {
        const r = await createLead(domain, token, {
          test: true, name: 'Тест сайта', phone: '+7 900 000-00-00', email: 'test@assurgina.ru',
          education: 'psy', route: '360', messenger: 'Telegram', consent: true
        }, { landing: 'https://onko.assurgina.ru/?utm_source=test_source&utm_medium=test_medium&utm_campaign=test_campaign&utm_content=test_content&utm_term=test_term&yclid=test_yclid' });
        return res.status(r.ok ? 200 : 502).json(Object.assign({
          pipeline_id: process.env.AMO_PIPELINE_ID || null, status_id: process.env.AMO_STATUS_ID || null
        }, r));
      }
      const a = await fetch(`https://${domain}/api/v4/account`, { headers: { Authorization: `Bearer ${token}` } });
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
    profession: clean(b.profession), goal: clean(b.goal, 1000),
    consent: b.consent === true || b.consent === 'on' || b.consent === 'YES' || b.consent === 'yes'
  };
  const digits = d.phone.replace(/\D/g, '');
  if (d.name.length < 2 || digits.length < 10 || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(d.email) || !d.consent) {
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
