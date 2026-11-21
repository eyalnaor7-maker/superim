// ai-substitutes: for products a chain does not sell, an AI picks up to two similar products from our own database,
// and they are saved as the product's substitutes, so every later comparison tries them automatically.
// Signed-in users only (Supabase checks the token before this runs); once a day per user; owners have no limit.
// Secrets (Supabase > Edge Functions > Secrets): GEMINI_API_KEY, optional GEMINI_MODEL.
import { createClient } from 'npm:@supabase/supabase-js@2.119.2';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const reply = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } });
const STORES = ['shufersal', 'rami_levy', 'victory', 'machsanei_hashuk'];

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return reply({ error: 'bad_request' }, 405);

  const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } });
  const ip = (req.headers.get('x-forwarded-for') || '').split(',')[0].trim().slice(0, 64);
  const log = (user_id: string | null, event: string, detail?: unknown) =>
    admin.from('security_log').insert({ user_id, event, detail: detail ?? null, ip }).then(() => {}, () => {});

  const jwt = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
  const { data: { user } } = await admin.auth.getUser(jwt);
  if (!user) return reply({ error: 'not_signed_in' }, 401);

  let body: any;
  try { body = await req.json(); } catch { return reply({ error: 'bad_request' }, 400); }
  const items = (Array.isArray(body?.items) ? body.items : [])
    .map((i: any) => ({
      barcode: String(i?.barcode ?? '').replace(/^P_/, ''),
      name: String(i?.name ?? '').slice(0, 120),
      missingIn: (Array.isArray(i?.missingIn) ? i.missingIn : []).filter((s: string) => STORES.includes(s)),
    }))
    .filter((i: any) => /^\d{4,14}$/.test(i.barcode) && i.name)
    .slice(0, 8);
  if (!items.length) return reply({ error: 'bad_request' }, 400);

  // the daily limit: the (user, day) primary key lets only the first request of the day through
  const { data: owner } = await admin.from('owners').select('user_id').eq('user_id', user.id).maybeSingle();
  let claimed = false;
  if (!owner) {
    const { error } = await admin.from('ai_usage').insert({ user_id: user.id });
    if (error) { await log(user.id, 'ai_limit_reached'); return reply({ error: 'daily_limit' }, 429); }
    claimed = true;
  }

  try {
    const lists: Record<string, { barcode: string; name: string; stores: string }[]> = {};
    for (const it of items) {
      const { data, error } = await admin.rpc('ai_candidates', { p_name: it.name, p_exclude: 'P_' + it.barcode, p_limit: 12 });
      if (error) throw error;
      lists[it.barcode] = data || [];
    }
    const prompt = `אתה עוזר לקונה בסופרמרקט בישראל. לכל מוצר מקורי מופיעה רשימת מועמדים.
בחר לכל מוצר עד 2 מועמדים שהם תחליף אמיתי: אותו סוג מוצר ובגודל דומה (מותג אחר מותר).
העדף מועמדים שנמכרים ברשתות שבהן המקורי חסר. אם אין תחליף מתאים, החזר רשימה ריקה.
החזר JSON בלבד בצורה {"<ברקוד מקורי>": ["<ברקוד מועמד>", ...]} ורק ברקודים מהרשימה של אותו מוצר.

` + items.map((it: any) => `מוצר ${it.barcode}: ${it.name}. חסר ב: ${it.missingIn.join(', ') || 'לא ידוע'}.
מועמדים:
` + lists[it.barcode].map(c => `- ${c.barcode} | ${c.name} | נמכר ב: ${c.stores}`).join('\n')).join('\n\n');

    const model = Deno.env.get('GEMINI_MODEL') || 'gemini-flash-latest'; // Google's alias for its current Flash model: 2.5 is closed to new keys
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': Deno.env.get('GEMINI_API_KEY') || '' },
      body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig: { temperature: 0, responseMimeType: 'application/json' } }),
    });
    if (!r.ok) throw new Error(`gemini ${r.status} ${(await r.text()).slice(0, 300)}`);
    const out = await r.json();
    const picks = JSON.parse(out?.candidates?.[0]?.content?.parts?.[0]?.text || '{}');

    const found = [];
    for (const it of items) {
      const allowed = new Map(lists[it.barcode].map(c => [c.barcode, c.name]));
      const chosen = (Array.isArray(picks?.[it.barcode]) ? picks[it.barcode] : []).map(String)
        .map((b: string) => (b.startsWith('P_') ? b : 'P_' + b)).filter((b: string) => allowed.has(b)).slice(0, 2);
      if (!chosen.length) continue;
      const { error } = await admin.from('substitutes').upsert({
        original_barcode: 'P_' + it.barcode, substitute_barcode_1: chosen[0], substitute_barcode_2: chosen[1] ?? null, status: 'ai',
      }, { onConflict: 'original_barcode' });
      if (error) { console.error('substitute not saved', it.barcode, error.message); continue; }
      found.push({ barcode: 'P_' + it.barcode, name: it.name, substitutes: chosen.map((b: string) => ({ barcode: b, name: allowed.get(b) })) });
    }
    await log(user.id, 'ai_substitutes', { asked: items.length, found: found.length, owner: !!owner });
    return reply({ ok: true, found });
  } catch (e) {
    console.error('ai-substitutes failed', e); // details stay in the server log; the user gets a plain code
    if (claimed) await admin.from('ai_usage').delete().eq('user_id', user.id).eq('day', new Date().toISOString().slice(0, 10));
    await log(user.id, 'ai_failed');
    return reply({ error: 'unavailable' }, 502);
  }
});
