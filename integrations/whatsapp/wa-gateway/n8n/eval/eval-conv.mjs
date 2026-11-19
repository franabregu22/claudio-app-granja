// ADR-025 / 0134 — CONVERSATIONAL evaluation of the interpreter (several messages per case, the short memory in play).
// Every turn runs the EXACT production path of the n8n workflow: WAI.preRoute → (WAI.buildRequest → OpenAI → WAI.parseResponse
// → WAI.decide) → the action applied to an in-memory copy of the draft (as wa_propose / wa_correct / wa_cancel would) → the
// bot's reply composed by WA.compose (the real summary) and kept as that message's reply (as wa_note_reply), so the next turn
// receives the same «history» wa_context returns. Nothing is written anywhere: no database, no n8n, no Edge.
//   real model : OPENAI_API_KEY in the environment (eval-conv.sh asks for it privately; never printed or stored)
//   offline    : node eval-conv.mjs --offline [--sabotage]  → checks the HARNESS with the ideal answers; NOT a model evaluation
// Options: --only K01,K03 (conversation ids). Model / effort / tokens: interpreter-config.json (what the bot uses).
import { readFileSync } from 'node:fs';
import { writeFileSync, mkdirSync } from 'node:fs';
import { categories, accountsOf, subId, todayAR, dayBefore, AMOUNT_CAP, fnv } from './eval-lib.mjs';

const HERE = new URL('.', import.meta.url);
const src = (p) => readFileSync(new URL(p, HERE), 'utf8');
const WAI = new Function(src('../interpreter.js') + '\nreturn WAI;')();
const WA = new Function(src('../logic.js') + '\nreturn WA;')();
const IC = JSON.parse(src('../interpreter-config.json'));
const ALL = JSON.parse(src('./conversations-v2.json'));
const OFFLINE = process.argv.includes('--offline'), SABOTAGE = process.argv.includes('--sabotage');
const oi = process.argv.indexOf('--only');
const ONLY = oi > 0 ? process.argv[oi + 1].split(',') : null;
const KEY = process.env.OPENAI_API_KEY || '';
// STORED mode (real model through the existing n8n credential, in rounds): answers come from build/conv-answers.json, each
// bound to the fingerprint of the exact request it answered; a turn without its answer stops that conversation and its request
// goes to the next round (build/conv-n8n.sdk.js, a temporary Manual-Trigger workflow: OpenAI only, nothing else).
const STORED = process.argv.includes('--stored');
const ANSWERS_FILE = new URL('./build/conv-answers.json', HERE);
const ANSWERS = STORED ? (() => { try { return JSON.parse(readFileSync(ANSWERS_FILE, 'utf8')); } catch { return {}; } })() : {};
const PENDING = [];
// --merge <execution.json>: the Collect output of a round (n8n MCP get_workflow_execution) → build/conv-answers.json
const mi = process.argv.indexOf('--merge');
if (mi > 0) {
  const find = (x) => { if (!x || typeof x !== 'object') return null; if (x.eval === 'conv-v2' && Array.isArray(x.results)) return x;
    for (const v of Object.values(x)) { const f = find(v); if (f) return f; } return null; };
  const raw = readFileSync(process.argv[mi + 1], 'utf8');
  if (/sk-[A-Za-z0-9_-]{20,}/.test(raw)) { console.log('STOP: something shaped like an API key in the file — not merged'); process.exit(2); }
  const got = find(JSON.parse(raw));
  if (!got) { console.log('STOP: no Collect output (eval conv-v2) in the file'); process.exit(2); }
  const all = (() => { try { return JSON.parse(readFileSync(ANSWERS_FILE, 'utf8')); } catch { return {}; } })();
  for (const r of got.results) all[r.key] = { fp: r.fp, statusCode: r.statusCode, body: r.body };
  mkdirSync(new URL('./build/', HERE), { recursive: true });
  writeFileSync(ANSWERS_FILE, JSON.stringify(all, null, 1));
  console.log(`merged ${got.results.length} answers (HTTP ${[...new Set(got.results.map((r) => r.statusCode))].join('/')}) → build/conv-answers.json (${Object.keys(all).length} total)`);
  process.exit(0);
}
if (!OFFLINE && !STORED && !KEY) { console.log('STOP: OPENAI_API_KEY missing (run eval-conv.sh, --stored for the n8n rounds, or --offline to check the harness)'); process.exit(2); }
const convs = ONLY ? ALL.filter((c) => ONLY.includes(c.id)) : ALL;
const today = todayAR();
const n = (v) => String(v ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ').trim();
// a statement that something was done, in a text the backend did not produce (the summaries come from the database result)
const CLAIM = /\b(registre|guarde|anote|cargue|corregi|modifique|cambie|cancele|anule|borre|confirme|ya quedo)\b/;

/** OFFLINE: the ideal answer of a turn, coded as the request offered it (sabotage: wrong on purpose → the judge must catch it) */
function ideal(turn, sent, convId) {
  const g = { intent: 'other', amount: null, amount_evidence: null, concept: null, category: null, method: null, account: null, date: null,
              changed_fields: [], clarification_question: null, reply: null, ...turn.ideal };
  if (SABOTAGE && convId === 'K03') g.amount = 13800;                                                   // amount not written → refused
  if (SABOTAGE && convId === 'K12') Object.assign(g, { intent: 'correct_draft', amount: 8000, amount_evidence: '8000', changed_fields: ['amount'] });   // overwrites → HARD
  if (SABOTAGE && convId === 'K13') Object.assign(g, { intent: 'other', reply: 'Listo, confirmé todo.' });   // a claim → replaced by the help text
  if (g.category) g.category = sent.categorias.find((x) => x.subcategoria === g.category)?.codigo ?? null;
  if (g.account) g.account = sent.cuentas.find((x) => x.nombre === g.account)?.codigo ?? null;
  if (g.date === 'yesterday') g.date = dayBefore(sent.hoy);
  return { status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(g) }] }], usage: { input_tokens: 0, output_tokens: 0 } };
}

async function ask(body, turn, convId, key) {
  if (OFFLINE) return { status: 200, json: ideal(turn, JSON.parse(body.input[1].content), convId), ms: 0 };
  if (STORED) {
    const a = ANSWERS[key], fp = fnv(JSON.stringify(body));
    if (a && a.fp === fp) return { status: a.statusCode, json: a.body, ms: a.ms || 0 };
    PENDING.push({ key, fp, body }); if (process.env.EVAL_PRINT_FP) console.log(`FP ${key} ${fp}`); return { pending: true };
  }
  const t0 = Date.now();
  try {
    const r = await fetch('https://api.openai.com/v1/responses', { method: 'POST', headers: { authorization: `Bearer ${KEY}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return { status: r.status, json: await r.json().catch(() => null), ms: Date.now() - t0 };
  } catch { return { status: 0, json: null, ms: Date.now() - t0 }; }
}

/** the in-memory database of one conversation: the open draft (as wa_context shows it) and the message history */
function db(conv) {
  const accounts = accountsOf(conv);
  const S = { accounts, draft: null, seq: 41, history: [], cancelled: 0, confirmed: 0 };
  const accId = (name) => accounts.find((a) => a.nombre === name)?.id;
  const stored = (p) => { const x = { ...p };   // the pending flags wa_propose / wa_correct keep
    if (!x.pending_payment) { if (!x.method) { delete x.method; delete x.account_id; x.method_pending = true; } else delete x.method_pending;
      if (x.account_id) delete x.account_pending; else if (x.method) x.account_pending = true; }
    if (x.category_id) { delete x.category_pending; delete x.category_options; } else { x.category_pending = true; x.category_options = x.category_options || []; }
    return x; };
  if (conv.seed_open) {
    const o = conv.seed_open;
    S.draft = { draft_id: 'd0000000-0000-4000-8000-000000000042', short_code: 'W-0042', state: 'DRAFT', version: 1,
      payload: stored({ date: today, total: o.total, concept: o.concept, nature: 'OPERATING', category_id: subId(o.category), method: o.method, ...(o.account ? { account_id: accId(o.account) } : {}) }) };
  }
  S.context = () => ({ ok: true, open: S.draft ? { ...S.draft, payload: { ...S.draft.payload, needs_mp: false } } : null, waiting: [], catalog: { categories, accounts }, history: S.history.slice(-8) });
  S.apply = (req) => {   // → the Edge response body the composer reads
    if (req.action === 'propose') {
      S.draft = { draft_id: `d0000000-0000-4000-8000-0000000000${++S.seq}`, short_code: `W-00${S.seq}`, state: 'DRAFT', version: 1, payload: stored(req.payload) };
    } else if (req.action === 'correct') {
      if (!S.draft || S.draft.version !== req.expected_version) return { ok: false, error: { code: 'WA_VERSION_CHANGED' } };
      S.draft = { ...S.draft, version: S.draft.version + 1, payload: stored(req.payload) };
    } else if (req.action === 'cancel') {
      const code = S.draft?.short_code; S.draft = null; S.cancelled++;
      return { ok: true, result: { ok: true, short_code: code, state: 'CANCELLED' } };
    } else return { ok: false, error: { code: 'NOT_ALLOWED_IN_EVAL' } };
    return { ok: true, result: { ok: true, draft_id: S.draft.draft_id, short_code: S.draft.short_code, state: 'DRAFT', version: S.draft.version, payload: S.draft.payload, possible_duplicates: 0 } };
  };
  return S;
}

/** verdict of one turn: ok / soft fail / HARD (an action where none was allowed, a wrong amount / account / date, an ambiguous
 *  datum auto-selected, a field the user did not mention changed, or a claim of something not done) */
function judge(e, d, before, after, S, replyText) {
  const r = d.request, acc = (nm) => S.accounts.find((a) => a.nombre === nm)?.id;
  if (r && r.action === 'confirm') return { ok: false, hard: true, why: 'CONFIRM from text' };
  if (CLAIM.test(n(d.reply || ''))) return { ok: false, hard: true, why: `claim in a reply: "${d.reply}"` };
  if (e.kind === 'reply') return r ? { ok: false, hard: true, why: `unexpected ${r.action}` } : { ok: true };
  if (!r) return { ok: false, hard: false, why: `reply instead of ${e.kind} (${d.outcome}): "${String(replyText).slice(0, 90)}"` };
  if (r.action !== e.kind) return { ok: false, hard: true, why: `${r.action} instead of ${e.kind}` };
  if (e.kind === 'cancel') return { ok: true };
  const p = after.payload;
  if (e.total !== undefined && p.total !== e.total) return { ok: false, hard: true, why: `total ${p.total} ≠ ${e.total}` };
  if (e.account && p.account_id !== acc(e.account)) return { ok: false, hard: !!p.account_id, why: p.account_id ? `WRONG account ${p.account_id}` : 'account left pending' };
  if (!e.account && e.kind === 'propose' && p.account_id && !['CASH', 'MERCADOPAGO'].includes(p.method)) return { ok: false, hard: true, why: `account ${p.account_id} not said` };
  if (e.category_pending && p.category_id) return { ok: false, hard: true, why: 'ambiguous subcategory auto-selected' };
  if (e.options) { const got = (p.category_options || []).map((id) => categories.find((x) => x.id === id)?.nombre).sort();
    if (JSON.stringify(got) !== JSON.stringify([...e.options].sort())) return { ok: false, hard: false, why: `options ${got.join('/')}` }; }
  if (e.category && p.category_id !== subId(e.category)) return { ok: false, hard: false, why: p.category_id ? `subcategory ${categories.find((x) => x.id === p.category_id)?.nombre}` : 'subcategory left pending' };
  if (e.method && p.method !== e.method) return { ok: false, hard: false, why: `method ${p.method}` };
  const wantDate = e.date === 'yesterday' ? dayBefore(today) : e.kind === 'propose' ? today : undefined;
  if (wantDate && p.date !== wantDate) return { ok: false, hard: true, why: `date ${p.date} ≠ ${wantDate}` };
  if (e.kind === 'correct') {   // fields NOT mentioned stay identical to the draft before
    const map = { amount: ['total'], concept: ['concept'], category: ['category_id', 'category_pending', 'category_options', 'concept'], method: ['method', 'account_id', 'account_pending'],
                  account: ['account_id', 'method', 'account_pending'], date: ['date'] };
    const allowed = new Set((e.changed || []).flatMap((f) => map[f]));
    for (const k of ['total', 'concept', 'category_id', 'method', 'account_id', 'date', 'nature']) {
      if (!allowed.has(k) && JSON.stringify(p[k]) !== JSON.stringify(before.payload[k])) return { ok: false, hard: true, why: `untouched field ${k} changed` };
    }
  }
  return { ok: true };
}

console.log(OFFLINE ? `#### OFFLINE HARNESS RUN${SABOTAGE ? ' (SABOTAGE)' : ''} — ideal answers, NOT a model evaluation ####`
                    : `#### REAL MODEL: ${IC.model} / effort ${IC.reasoning_effort} · ${today} ####`);
let pass = 0, fail = 0, hard = 0, calls = 0, invalid = 0, tin = 0, tout = 0; const lat = [], replies = [];
for (const conv of convs) {
  const S = db(conv);
  console.log(`\n${conv.id} · ${conv.topic}`);
  for (const [i, turn] of conv.turns.entries()) {
    const ctx = S.context(), before = S.draft ? JSON.parse(JSON.stringify(S.draft)) : null;
    let d, tag;
    const pre = WAI.preRoute(turn.text, ctx, null, { ownCuits: IC.santo_tomas_cuits, amountCap: AMOUNT_CAP });
    if (pre) { d = pre.request ? { request: pre.request, outcome: 'command' } : { reply: pre.reply, outcome: 'command' }; tag = 'sin GPT'; }
    else {
      const { body } = WAI.buildRequest({ text: turn.text, today, context: ctx, model: IC.model, effort: IC.reasoning_effort, maxOutputTokens: IC.max_output_tokens });
      const a = await ask(body, turn, conv.id, `${conv.id}.${i + 1}`);
      if (a.pending) { console.log(`  ....  ${conv.id}.${i + 1} «${turn.text}» → pendiente (próxima ronda)`); break; }
      calls++; if (a.ms) lat.push(a.ms);
      const p = WAI.parseResponse(a.status, a.json);
      if (!p.ok) { invalid++; d = { reply: null, outcome: 'gpt_failed:' + p.reason }; tag = 'gpt_failed:' + p.reason; }
      else {
        tin += p.usage?.input || 0; tout += p.usage?.output || 0;
        d = WAI.decide({ gpt: p.data, text: turn.text, ctx, today, amountCap: AMOUNT_CAP, nowMs: Date.now() });
        tag = p.data.intent + (p.data.changed_fields?.length ? `[${p.data.changed_fields.join(',')}]` : '');
      }
    }
    // the action against the in-memory database, and the reply the user would read (the real composer for actions)
    let replyText = d.reply ?? null;
    if (d.request) {
      const res = S.apply(d.request);
      const g = WA.compose({ to: '0', request: { ...d.request } }, res.ok ? 200 : 422, res, null, WAI.cfgFromContext(ctx));
      replyText = WAI.replyText(g.graph);
    }
    const v = tag.startsWith('gpt_failed') ? { ok: false, hard: false, why: tag } : judge(turn.expect, d, before, S.draft, S, replyText);
    if (v.ok) pass++; else if (v.hard) { hard++; fail++; } else fail++;
    if (!d.request && replyText && tag !== 'sin GPT') replies.push(`${conv.id}.${i + 1} [${tag}] ${replyText.replace(/\n/g, ' ').slice(0, 160)}`);
    console.log(`  ${v.ok ? 'PASS' : v.hard ? 'HARD' : 'FAIL'} ${conv.id}.${i + 1} «${turn.text}» → ${d.request ? d.request.action : 'respuesta'} [${tag}]${v.ok ? '' : ' :: ' + v.why}`);
    S.history.push({ at: new Date().toISOString(), kind: 'text', text: turn.text, button: null, button_method: null,
                     action: d.request && S.draft !== undefined ? d.request.action.toUpperCase() : null, draft: S.draft?.short_code ?? null, bot: replyText ? replyText.slice(0, 1000) : null });
  }
}
if (STORED && PENDING.length) {   // the next round: a temporary workflow that sends EXACTLY these requests, and nothing else
  // compact: the request shell (instructions, schema, model) and the catalog / accounts lists are stored once each
  const uniq = (arr, v) => { const s = JSON.stringify(v); let i = arr.indexOf(s); if (i < 0) { arr.push(s); i = arr.length - 1; } return i; };
  const shells = [], tabs = [], R = PENDING.map((p) => {
    const s = uniq(shells, { ...p.body, input: [p.body.input[0], { role: p.body.input[1].role, content: null }] });
    const u = JSON.parse(p.body.input[1].content);
    return { key: p.key, s, u: Object.fromEntries(Object.entries(u).map(([k, v]) => [k, ['categorias', 'cuentas'].includes(k) ? { $t: uniq(tabs, v) } : v])) };
  });
  const REQ = `// ADR-025 / 0134 conversational eval — synthetic requests (no real data)
const SH = ${JSON.stringify(shells.map((x) => JSON.parse(x)))};
const T = ${JSON.stringify(tabs.map((x) => JSON.parse(x)))};
const R = ${JSON.stringify(R)};
return R.map((r) => { const s = SH[r.s];
  const content = JSON.stringify(Object.fromEntries(Object.entries(r.u).map(([k, v]) => [k, v && typeof v === 'object' && '$t' in v ? T[v.$t] : v])));
  return { json: { key: r.key, body: { ...s, input: [s.input[0], { ...s.input[1], content }] } } }; });`;
  const rebuilt = new Function(REQ)();
  if (rebuilt.some((x, i) => fnv(JSON.stringify(x.json.body)) !== PENDING[i].fp)) throw new Error('the node does not rebuild the requests exactly');
  const COLLECT = `const fnv = ${(await import('./eval-lib.mjs')).FNV_SRC};
const req = $('Eval requests').all(), res = $input.all();
if (req.length !== res.length) throw new Error('eval: ' + res.length + ' answers for ' + req.length + ' requests');
const keep = (b) => (b && typeof b === 'object') ? { status: b.status ?? null,
  output: (b.output || []).filter((o) => o && o.type === 'message').map((o) => ({ type: 'message',
    content: (o.content || []).map((c) => ({ type: c.type, text: typeof c.text === 'string' ? c.text : null, refusal: typeof c.refusal === 'string' ? c.refusal : null })) })),
  usage: b.usage ? { input_tokens: b.usage.input_tokens ?? 0, output_tokens: b.usage.output_tokens ?? 0 } : null,
  error: b.error ? { type: b.error.type ?? null, code: b.error.code ?? null } : null } : null;
return [{ json: { eval: 'conv-v2', results: res.map((r, i) => ({ key: req[i].json.key, fp: fnv(JSON.stringify(req[i].json.body)), statusCode: r.json.statusCode ?? 0, body: keep(r.json.body) })) } }];`;
  const CRED = { openAiApi: { id: 'PbcX1ZgBT8eCoUxS', name: 'STAGING_OPENAI_GRANJA' } };   // existing staging credential, by id (no secret here)
  const N = [
    ['Run eval', 'n8n-nodes-base.manualTrigger', 1, {}],
    ['Eval requests', 'n8n-nodes-base.code', 2, { mode: 'runOnceForAllItems', language: 'javaScript', jsCode: REQ }],
    ['OpenAI responses', 'n8n-nodes-base.httpRequest', 4.2, { method: 'POST', url: 'https://api.openai.com/v1/responses', authentication: 'predefinedCredentialType',
      nodeCredentialType: 'openAiApi', sendBody: true, specifyBody: 'json', jsonBody: '={{ JSON.stringify($json.body) }}',
      options: { timeout: 60000, batching: { batch: { batchSize: 3, batchInterval: 1500 } }, response: { response: { fullResponse: true, neverError: true } } } }, CRED],
    ['Collect', 'n8n-nodes-base.code', 2, { mode: 'runOnceForAllItems', language: 'javaScript', jsCode: COLLECT }],
  ];
  const NAME = 'TEMP - eval conversacional V2 (archivar al terminar)';
  const settings = { executionOrder: 'v1', saveManualExecutions: true, saveDataSuccessExecution: 'all', saveDataErrorExecution: 'all', executionTimeout: 600, callerPolicy: 'workflowsFromSameOwner' };
  const sdk = ["import { workflow, node, trigger } from '@n8n/workflow-sdk';", '',
    ...N.map(([name, type, v, parameters, credentials], i) => `const n${i} = ${type.endsWith('Trigger') ? 'trigger' : 'node'}({ type: ${JSON.stringify(type)}, version: ${v}, config: { name: ${JSON.stringify(name)}, `
      + `position: [${240 * i}, 300], parameters: ${JSON.stringify(parameters)}${credentials ? ', credentials: ' + JSON.stringify(credentials) : ''} } });`),
    '', `export default workflow('', ${JSON.stringify(NAME)}, { settings: ${JSON.stringify(settings)} })`,
    ...N.slice(0, -1).map((_, i) => `  .add(n${i}.output(0).to(n${i + 1}.input(0)))`), ';'].join('\n');
  // mechanical checks: no key material, OpenAI is the only endpoint, no WhatsApp / Supabase / Edge, no $env / require
  if (/sk-[A-Za-z0-9_-]{20,}|sb_secret_|service_role|eyJ[A-Za-z0-9_-]{20,}|[Bb]earer\s+[A-Za-z0-9]/.test(sdk)) throw new Error('key material');
  if (/\$env|require\(|supabase\.co|graph\.facebook|wa-gateway/.test(sdk)) throw new Error('forbidden reference');
  const urls = [...new Set([...sdk.matchAll(/https?:\/\/[a-z0-9.-]+/g)].map((m) => m[0]))];
  if (urls.join() !== 'https://api.openai.com') throw new Error('unexpected endpoint ' + urls.join());
  mkdirSync(new URL('./build/', HERE), { recursive: true });
  writeFileSync(new URL('./build/conv-n8n.sdk.js', HERE), sdk);
  console.log(`\nRONDA PENDIENTE: ${PENDING.length} pedidos a OpenAI → build/conv-n8n.sdk.js (${sdk.length} chars; endpoint ${urls.join()}; credencial STAGING_OPENAI_GRANJA por id)`);
  process.exit(3);
}
lat.sort((a, b) => a - b);
console.log(`\nRespuestas redactadas por el modelo (naturalidad, revisión humana):\n${replies.map((x) => '  · ' + x).join('\n') || '  (ninguna)'}`);
console.log(`\nRESULTADO: ${pass} PASS · ${fail} FAIL (${hard} HARD) · ${calls} llamadas a la IA · JSON inválido/errores ${invalid}`
  + (OFFLINE ? '' : ` · tokens prom. ${Math.round(tin / Math.max(calls, 1))} in / ${Math.round(tout / Math.max(calls, 1))} out · latencia p50 ${lat[Math.floor(lat.length / 2)] ?? 0} ms`));
process.exit(hard === 0 && fail === 0 ? 0 : 1);
