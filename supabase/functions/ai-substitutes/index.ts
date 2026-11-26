// ai-substitutes: 3-layer substitute & private-label matcher powered by Google Gemini.
// Signed-in users get 3 searches per day (owners unlimited). Approved catalog substitutes are never overwritten.
import { createClient } from 'npm:@supabase/supabase-js@2.119.2';

const DAILY_LIMIT = 3;
const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const reply = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } });
const STORES = ['shufersal', 'rami_levy', 'victory', 'machsanei_hashuk'];
const POPUP_STORE: Record<string, string> = {
  shufersal: 'shufersal',
  ramiLevy: 'rami_levy',
  victory: 'victory',
  machsaneiHashuk: 'machsanei_hashuk',
};

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return reply({ error: 'bad_request' }, 405);

  const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, {
    auth: { persistSession: false },
  });
  const ip = (req.headers.get('x-forwarded-for') || '').split(',')[0].trim().slice(0, 64);
  const log = (user_id: string | null, event: string, detail?: unknown) =>
    admin.from('security_log').insert({ user_id, event, detail: detail ?? null, ip }).then(() => {}, () => {});

  const jwt = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
  const { data: { user } } = await admin.auth.getUser(jwt);
  if (!user) return reply({ error: 'not_signed_in' }, 401);

  let body: any;
  try { body = await req.json(); } catch { return reply({ error: 'bad_request' }, 400); }
  const { data: owner } = await admin.from('owners').select('user_id').eq('user_id', user.id).maybeSingle();
  const today = () => new Date().toISOString().slice(0, 10);

  if (body?.quota === true) {
    if (owner) return reply({ ok: true, remaining: null, limit: DAILY_LIMIT });
    const { data: used } = await admin.from('ai_usage').select('uses').eq('user_id', user.id).eq('day', today()).maybeSingle();
    return reply({ ok: true, remaining: Math.max(0, DAILY_LIMIT - Number(used?.uses ?? 0)), limit: DAILY_LIMIT });
  }

  const items = (Array.isArray(body?.items) ? body.items : [])
    .map((i: any) => ({
      barcode: String(i?.barcode ?? '').replace(/^P_/, ''),
      name: String(i?.name ?? '').slice(0, 120),
      missingIn: (Array.isArray(i?.missingIn) ? i.missingIn : []).filter((s: string) => STORES.includes(s)),
    }))
    .filter((i: any) => /^\d{4,14}$/.test(i.barcode) && i.name)
    .slice(0, 8);
  const unknown = (Array.isArray(body?.unknown) ? body.unknown : [])
    .map((u: any) => ({ store: POPUP_STORE[String(u?.store)] || '', code: String(u?.code ?? ''), name: String(u?.name ?? '').slice(0, 120) }))
    .filter((u: any) => u.store && /^[\w-]{1,40}$/.test(u.code) && u.name.length >= 2)
    .slice(0, 8 - items.length);
  if (!items.length && !unknown.length) return reply({ error: 'bad_request' }, 400);

  let claimed = false;
  let remaining: number | null = null;
  if (!owner) {
    const { data: rem, error } = await admin.rpc('claim_ai_quota', { p_user: user.id, p_limit: DAILY_LIMIT });
    if (error || rem === null || rem < 0) {
      await log(user.id, 'ai_limit_reached');
      return reply({ error: 'daily_limit', remaining: 0 }, 429);
    }
    claimed = true;
    remaining = Number(rem);
  }

  try {
    type Cand = { barcode: string; name: string; stores: string; unit_qty?: number | null; unit_type?: string | null };
    const lists: Record<string, Cand[]> = {};
    for (const it of items) {
      const { data, error } = await admin.rpc('ai_candidates_v2', {
        p_name: it.name,
        p_exclude: 'P_' + it.barcode,
        p_limit: 12,
        p_missing_stores: it.missingIn.length ? it.missingIn : null,
      });
      if (error) throw error;
      lists[it.barcode] = data || [];
    }
    for (const [n, u] of unknown.entries()) {
      const otherStores = STORES.filter(s => s !== u.store);
      const { data, error } = await admin.rpc('ai_candidates_v2', {
        p_name: u.name,
        p_exclude: '',
        p_limit: 12,
        p_missing_stores: otherStores,
      });
      if (error) throw error;
      lists['u' + n] = data || [];
    }

    const fmtUnit = (c: Cand) => (c.unit_qty && c.unit_type ? ` | מידה: ${c.unit_qty}${c.unit_type}` : '');
    const prompt = `אתה מומחה קמעונאות מזון בישראל. לכל מוצר מקורי מופיעה רשימת מועמדים מסוננת.
כללי ברזל לבחירה:
1. בחר לכל מוצר עד 2 מועמדים שהם תחליף אמיתי: אותו סוג מוצר בדיוק ובגודל אריזה דומה (אסור לבחור מארז שקטן או גדול ביותר מ-25% מהמקורי!).
2. שמור בקפדנות על תכונות מיוחדות: ללא גלוטן (לל"ג), נטול/דל לקטוז, כשל"פ או מהדרין אם מופיעים במוצר המקורי.
3. העדף מועמדים שנמכרים ברשתות שבהן המקורי חסר. אם אין תחליף אמיתי וראוי, החזר רשימה ריקה [].
4. החזר JSON בלבד בצורה {"<ברקוד מקורי>": ["<ברקוד מועמד>", ...]} ורק ברקודים שמופיעים ברשימה של אותו מוצר.

` + items.map((it: any) => `מוצר ${it.barcode}: ${it.name}. חסר ב: ${it.missingIn.join(', ') || 'לא ידוע'}.
מועמדים:
` + (lists[it.barcode].length ? lists[it.barcode].map(c => `- ${c.barcode} | ${c.name}${fmtUnit(c)} | נמכר ב: ${c.stores}`).join('\n') : '(אין מועמדים)')).join('\n\n')
      + (unknown.length ? `

מוצרים שאינם במאגר (למשל מותג פרטי של רשת). לכל אחד בחר מועמד אחד בלבד: המוצר המקביל ביותר באותו סוג ובאותו משקל/נפח (±25%), או רשימה ריקה []. המפתח הוא המזהה (u0, u1...).
` + unknown.map((u: any, n: number) => `מוצר u${n}: ${u.name} (מהרשת ${u.store}).
מועמדים:
` + (lists['u' + n].length ? lists['u' + n].map(c => `- ${c.barcode} | ${c.name}${fmtUnit(c)} | נמכר ב: ${c.stores}`).join('\n') : '(אין מועמדים)')).join('\n\n') : '');

    const model = Deno.env.get('GEMINI_MODEL') || 'gemini-flash-latest';
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': Deno.env.get('GEMINI_API_KEY') || '' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0, responseMimeType: 'application/json' },
      }),
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

      const origBc = 'P_' + it.barcode;
      const { data: existing } = await admin.from('substitutes')
        .select('status, substitute_barcode_1, substitute_barcode_2')
        .eq('original_barcode', origBc)
        .maybeSingle();

      // Never overwrite an approved human/catalog substitute; only fill empty slot 2 if helpful
      if (existing?.status === 'approved' && existing.substitute_barcode_1) {
        if (!existing.substitute_barcode_2) {
          const extra = chosen.find((b: string) => b !== existing.substitute_barcode_1);
          if (extra) {
            await admin.from('substitutes').update({ substitute_barcode_2: extra }).eq('original_barcode', origBc);
          }
        }
        found.push({ barcode: origBc, name: it.name, substitutes: chosen.map((b: string) => ({ barcode: b, name: allowed.get(b) })) });
        continue;
      }

      const { error } = await admin.from('substitutes').upsert({
        original_barcode: origBc,
        substitute_barcode_1: chosen[0],
        substitute_barcode_2: chosen[1] ?? null,
        status: 'ai',
        neg_votes: 0,
      }, { onConflict: 'original_barcode' });
      if (error) { console.error('substitute not saved', it.barcode, error.message); continue; }
      found.push({ barcode: origBc, name: it.name, substitutes: chosen.map((b: string) => ({ barcode: b, name: allowed.get(b) })) });
    }

    for (const [n, u] of unknown.entries()) {
      const allowed = new Map(lists['u' + n].map(c => [c.barcode, c.name]));
      const pick = (Array.isArray(picks?.['u' + n]) ? picks['u' + n] : []).map(String)
        .map((b: string) => (b.startsWith('P_') ? b : 'P_' + b)).find((b: string) => allowed.has(b));
      if (!pick) continue;
      const { error } = await admin.from('ai_matches').upsert({
        store_name: u.store,
        store_code: u.code,
        barcode: pick,
        name: u.name,
        neg_votes: 0,
      }, { onConflict: 'store_name,store_code' });
      if (error) { console.error('match not saved', u.code, error.message); continue; }
      found.push({ code: u.code, name: u.name, substitutes: [{ barcode: pick, name: allowed.get(pick) }] });
    }

    await log(user.id, 'ai_substitutes', { asked: items.length + unknown.length, found: found.length, owner: !!owner });
    return reply({ ok: true, found, remaining });
  } catch (e) {
    console.error('ai-substitutes failed', e);
    if (claimed) await admin.rpc('refund_ai_quota', { p_user: user.id });
    await log(user.id, 'ai_failed');
    return reply({ error: 'unavailable' }, 502);
  }
});
