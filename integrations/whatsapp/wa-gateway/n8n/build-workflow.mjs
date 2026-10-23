// ADR-025 §18 — builds the importable n8n workflow "STAGING - Gastos WhatsApp" (stage 1: OpenAI text interpreter).
//   node n8n/build-workflow.mjs [--allow-placeholder]  → n8n/build/STAGING_wa_expense_capture.json + SHA256
// Inputs: logic.js + interpreter.js (embedded verbatim), interpreter-config.json (model, limits, method → account name),
// staging-catalog.json (phone_number_id, ar_strip_9; written by deploy --catalog).
// SHARED n8n instance: no secret is embedded, no $env and no require() are used (nothing to change in Railway variables).
// Secrets live only in n8n credentials (encrypted by n8n): STAGING_WA_EDGE_TO_N8N (webhook), STAGING_WA_N8N_TO_EDGE (Edge
// action calls), STAGING_META_GRAPH_TOKEN (Graph API), STAGING_OPENAI_GRANJA (OpenAI, existing credential, by name).
// Draft state is NEVER kept in n8n: every text first reads public.wa_context (database) through the Edge.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REF = 'aplbsutpzgemexayldct';
const WEBHOOK_PATH = 'adr025-staging-gastos-whatsapp';   // unique path: no collision with existing workflows
const EDGE_ACTION = `https://${REF}.supabase.co/functions/v1/wa-gateway/action`;
const OPENAI = 'https://api.openai.com/v1/responses';
const allowPlaceholder = process.argv.includes('--allow-placeholder');
const logic = readFileSync(join(HERE, 'logic.js'), 'utf8');
const interp = readFileSync(join(HERE, 'interpreter.js'), 'utf8');
const conf = JSON.parse(readFileSync(join(HERE, 'interpreter-config.json'), 'utf8'));
const catPath = join(HERE, 'staging-catalog.json');
const catalog = existsSync(catPath) ? JSON.parse(readFileSync(catPath, 'utf8'))
  : allowPlaceholder ? JSON.parse(readFileSync(join(HERE, 'staging-catalog.placeholder.json'), 'utf8')) : null;
if (!catalog) throw new Error('n8n/staging-catalog.json missing — run deploy --catalog <phone-number-id> first (or --allow-placeholder for a dry build)');
if (!allowPlaceholder && !/^[0-9]{6,20}$/.test(String(catalog.phone_number_id))) throw new Error('staging-catalog.json: phone_number_id (Meta TEST number id) missing');
if (!allowPlaceholder && (!/^[a-z0-9][a-z0-9.\-]{2,60}$/.test(conf.model) || conf.model === 'PENDING_EVAL')) throw new Error('interpreter-config.json: model not chosen yet (run the evaluation)');
const CFG = JSON.stringify({ ar_strip_9: !!catalog.ar_strip_9 });
const ICONF = JSON.stringify({ model: conf.model, effort: conf.reasoning_effort, maxOutputTokens: conf.max_output_tokens, amountCap: conf.amount_cap,
  perHour: conf.gpt_calls_per_hour_per_sender });   // paying accounts come live from the ERP (wa_context), never from config
const PNID = JSON.stringify(String(catalog.phone_number_id));
const TEXT = `const PNID = ${PNID};
const textMsg = (to, body) => ({ messaging_product: 'whatsapp', to, type: 'text', text: { preview_url: false, body: String(body).slice(0, 4000) } });`;

const GLUE_ROUTE = `
${logic}
${TEXT}
const CFG = ${CFG};
const sd = $getWorkflowStaticData('global'); sd.seen = sd.seen || []; sd.nonces = sd.nonces || {};
const out = [];
for (const item of $input.all()) {
  const v = WA.verify(item.json.body, Math.floor(Date.now() / 1000), sd.nonces);
  if (!v.ok) { console.log(JSON.stringify({ evt: 'n8n_rejected', reason: v.reason })); continue; }
  if (sd.seen.includes(v.event.inbound_id)) { console.log(JSON.stringify({ evt: 'n8n_duplicate', inbound_id: v.event.inbound_id })); continue; }
  sd.seen = [...sd.seen.slice(-299), v.event.inbound_id];
  const r = WA.route(v.event, CFG);
  console.log(JSON.stringify({ evt: 'n8n_routed', inbound_id: v.event.inbound_id, action: r.request ? r.request.action : 'reply' }));
  out.push({ json: { key: WA.sha256Hex(v.event.phone).slice(0, 16), to: r.to, inbound_id: r.inbound_id, text: r.text || null,
    request: r.request || null, graph: r.reply ? textMsg(r.to, r.reply) : null, phone_number_id: PNID } });
}
return out;`;

const prepareGlue = (from) => `
${logic}
const p = WA.prepare($json.request, Math.floor(Date.now() / 1000), WA.nonce());
return { json: { ...$json, ${from === 'follow' ? '' : 'graph: null, '}raw: p.raw, h: p.headers } };`;

const GLUE_AFTER = `
${logic}
${interp}
${TEXT}
const IC = ${ICONF};
const ctx = $('Prepare request').item.json;
const res = $json;
if (ctx.request.action !== 'context') {
  const c = WA.compose(ctx, res.statusCode, res.body, null, WAI.cfgFromContext(null));
  console.log(JSON.stringify({ evt: 'n8n_action', action: ctx.request.action, status: res.statusCode, code: (res.body && res.body.error && res.body.error.code) || null,
    state: (res.body && res.body.result && res.body.result.state) || null }));
  return { json: { mode: 'reply', graph: c.graph, phone_number_id: PNID } };
}
if (res.statusCode !== 200 || !res.body || !res.body.result || res.body.result.ok !== true) {
  console.log(JSON.stringify({ evt: 'context_failed', status: res.statusCode, code: (res.body && res.body.error && res.body.error.code) || null }));
  return { json: { mode: 'reply', graph: textMsg(ctx.to, 'Hubo un problema técnico; probá de nuevo en unos minutos.'), phone_number_id: PNID } };
}
const context = res.body.result;
const pre = WAI.preRoute(ctx.text, context);
if (pre) {
  console.log(JSON.stringify({ evt: 'command', inbound_id: ctx.inbound_id, action: pre.request ? pre.request.action : 'reply' }));
  return { json: pre.request
    ? { mode: 'action', to: ctx.to, context, changes: pre.changes || null, request: { ...pre.request, inbound_id: ctx.inbound_id, cap: ctx.request.cap } }
    : { mode: 'reply', graph: textMsg(ctx.to, pre.reply), phone_number_id: PNID } };
}
const sd = $getWorkflowStaticData('global'); sd.gpt = sd.gpt || {};
const now = Date.now();
for (const k of Object.keys(sd.gpt)) { sd.gpt[k] = sd.gpt[k].filter((t) => now - t < 3600000); if (!sd.gpt[k].length) delete sd.gpt[k]; }
const calls = sd.gpt[ctx.key] || [];
if (calls.length >= IC.perHour) {
  console.log(JSON.stringify({ evt: 'gpt_rate_limited', inbound_id: ctx.inbound_id }));
  return { json: { mode: 'reply', graph: textMsg(ctx.to, 'Llegaste al límite de mensajes por hora; probá más tarde.'), phone_number_id: PNID } };
}
sd.gpt[ctx.key] = [...calls, now];
const b = WAI.buildRequest({ text: ctx.text, today: WA.today(now), context, model: IC.model, effort: IC.effort, maxOutputTokens: IC.maxOutputTokens });
return { json: { mode: 'gpt', to: ctx.to, key: ctx.key, inbound_id: ctx.inbound_id, cap: ctx.request.cap, text: ctx.text, context, openai_body: b.body } };`;

const GLUE_VALIDATE = `
${logic}
${interp}
${TEXT}
const IC = ${ICONF};
const a = $('After action').item.json;
const p = WAI.parseResponse($json.statusCode, $json.body);
if (!p.ok) {
  console.log(JSON.stringify({ evt: 'gpt_failed', inbound_id: a.inbound_id, reason: p.reason, model: IC.model }));
  return { json: { mode: 'reply', graph: textMsg(a.to, 'No pude interpretar el mensaje ahora; probá de nuevo en un rato.'), phone_number_id: PNID } };
}
const d = WAI.decide({ gpt: p.data, text: a.text, ctx: a.context, today: WA.today(Date.now()), amountCap: IC.amountCap });
console.log(JSON.stringify({ evt: 'gpt', inbound_id: a.inbound_id, model: IC.model, intent: p.data.intent, outcome: d.outcome, changed: d.changed || null,
  tokens_in: p.usage ? p.usage.input : null, tokens_out: p.usage ? p.usage.output : null }));
return { json: d.request
  ? { mode: 'action', to: a.to, context: a.context, changes: d.changes || null, request: { ...d.request, inbound_id: a.inbound_id, cap: a.cap } }
  : { mode: 'reply', graph: textMsg(a.to, d.reply), phone_number_id: PNID } };`;

const GLUE_COMPOSE_FOLLOW = `
${logic}
${interp}
const PNID = ${PNID};
const ctx = $('Prepare follow-up').item.json;
const res = $json;
const c = WA.compose(ctx, res.statusCode, res.body, null, WAI.cfgFromContext(ctx.context));
console.log(JSON.stringify({ evt: 'n8n_action', action: ctx.request.action, status: res.statusCode, code: (res.body && res.body.error && res.body.error.code) || null,
  state: (res.body && res.body.result && res.body.result.state) || null }));
return { json: { graph: c.graph, phone_number_id: PNID } };`;

const GLUE_EXPIRE = `return [{ json: { key: null, to: null, inbound_id: null, text: null, request: { action: 'expire' } } }];`;
// Send WhatsApp keeps neverError (the response is read here); a non-2xx Graph answer FAILS the execution so it is saved and visible.
// Only status / Meta numeric codes / type are reported: never the token, the recipient, the message text or Meta's free-text message.
const GLUE_LOG_SEND = `const r = $json; const e = (r.body && r.body.error) || {};
console.log(JSON.stringify({ evt: 'whatsapp_send', status: r.statusCode, error: e.code || null, subcode: e.error_subcode || null }));
if (!(r.statusCode >= 200 && r.statusCode < 300)) throw new Error('WhatsApp send failed: HTTP ' + r.statusCode + (e.code ? ' code ' + e.code : '')
  + (e.error_subcode ? ' subcode ' + e.error_subcode : '') + (e.type ? ' ' + String(e.type).replace(/[^A-Za-z]/g, '').slice(0, 40) : ''));
return { json: { status: r.statusCode } };`;

let x = 0;
const node = (name, type, typeVersion, parameters, extra = {}) => ({ id: randomUUID(), name, type, typeVersion, position: [220 * x++, 300], parameters, ...extra });
const code = (name, jsCode, mode = 'runOnceForEachItem') => node(name, 'n8n-nodes-base.code', 2, { mode, language: 'javaScript', jsCode });
const ifCond = (name, expr) => node(name, 'n8n-nodes-base.if', 2, { conditions: { options: { caseSensitive: true, leftValue: '', typeValidation: 'loose' },
  conditions: [{ id: randomUUID(), leftValue: `={{ ${expr} }}`, rightValue: true, operator: { type: 'boolean', operation: 'true', singleValue: true } }], combinator: 'and' }, options: {} });
const http = (name, url, extraParams, timeout = 15000) => node(name, 'n8n-nodes-base.httpRequest', 4.2, { method: 'POST', url, ...extraParams,
  options: { timeout, response: { response: { fullResponse: true, neverError: true } } } });
const edgeCall = (name) => http(name, EDGE_ACTION, { authentication: 'genericCredentialType', genericAuthType: 'httpHeaderAuth', sendHeaders: true,
  specifyHeaders: 'json', jsonHeaders: '={{ JSON.stringify($json.h) }}', sendBody: true, contentType: 'raw', rawContentType: 'application/json', body: '={{ $json.raw }}' });
const cred = (type, name) => ({ [type]: { id: 'SET_ON_IMPORT', name } });

const nodes = [
  node('Edge → n8n', 'n8n-nodes-base.webhook', 2, { httpMethod: 'POST', path: WEBHOOK_PATH, authentication: 'headerAuth', responseMode: 'onReceived', options: {} },
    { webhookId: randomUUID(), credentials: cred('httpHeaderAuth', 'STAGING_WA_EDGE_TO_N8N') }),
  code('Verify & route', GLUE_ROUTE, 'runOnceForAllItems'),
  ifCond('Has request?', '!!$json.request'),
  code('Prepare request', prepareGlue('first')),
  { ...edgeCall('Call Edge action'), credentials: cred('httpHeaderAuth', 'STAGING_WA_N8N_TO_EDGE') },
  code('After action', GLUE_AFTER),
  ifCond('Needs GPT?', "$json.mode === 'gpt'"),
  { ...http('OpenAI interpret', OPENAI, { authentication: 'predefinedCredentialType', nodeCredentialType: 'openAiApi',
      sendBody: true, specifyBody: 'json', jsonBody: '={{ JSON.stringify($json.openai_body) }}' }, 20000), credentials: cred('openAiApi', 'STAGING_OPENAI_GRANJA') },
  code('Validate & map', GLUE_VALIDATE),
  ifCond('Follow-up action?', "$json.mode === 'action'"),
  code('Prepare follow-up', prepareGlue('follow')),
  { ...edgeCall('Call Edge follow-up'), credentials: cred('httpHeaderAuth', 'STAGING_WA_N8N_TO_EDGE') },
  code('Compose follow-up', GLUE_COMPOSE_FOLLOW),
  ifCond('Has message?', '!!$json.graph'),
  { ...http('Send WhatsApp', '=https://graph.facebook.com/v21.0/{{ $json.phone_number_id }}/messages', { authentication: 'genericCredentialType', genericAuthType: 'httpHeaderAuth',
      sendBody: true, specifyBody: 'json', jsonBody: '={{ JSON.stringify($json.graph) }}' }), credentials: cred('httpHeaderAuth', 'STAGING_META_GRAPH_TOKEN') },
  code('Log send', GLUE_LOG_SEND),
  node('Every 30 min', 'n8n-nodes-base.scheduleTrigger', 1.2, { rule: { interval: [{ field: 'minutes', minutesInterval: 30 }] } }),
  code('Expire request', GLUE_EXPIRE, 'runOnceForAllItems'),
];
const to = (n, i = 0) => ({ node: n, type: 'main', index: i });
const connections = {
  'Edge → n8n': { main: [[to('Verify & route')]] },
  'Verify & route': { main: [[to('Has request?')]] },
  'Has request?': { main: [[to('Prepare request')], [to('Has message?')]] },
  'Prepare request': { main: [[to('Call Edge action')]] },
  'Call Edge action': { main: [[to('After action')]] },
  'After action': { main: [[to('Needs GPT?')]] },
  'Needs GPT?': { main: [[to('OpenAI interpret')], [to('Follow-up action?')]] },
  'OpenAI interpret': { main: [[to('Validate & map')]] },
  'Validate & map': { main: [[to('Follow-up action?')]] },
  'Follow-up action?': { main: [[to('Prepare follow-up')], [to('Has message?')]] },
  'Prepare follow-up': { main: [[to('Call Edge follow-up')]] },
  'Call Edge follow-up': { main: [[to('Compose follow-up')]] },
  'Compose follow-up': { main: [[to('Has message?')]] },
  'Has message?': { main: [[to('Send WhatsApp')], []] },
  'Send WhatsApp': { main: [[to('Log send')]] },
  'Every 30 min': { main: [[to('Expire request')]] },
  'Expire request': { main: [[to('Prepare request')]] },
};
const wf = { name: 'STAGING - Gastos WhatsApp', nodes, connections, active: false,
  settings: { executionOrder: 'v1', saveManualExecutions: false, saveDataErrorExecution: 'all', saveDataSuccessExecution: 'none', executionTimeout: 90,
              callerPolicy: 'workflowsFromSameOwner' },
  tags: [], pinData: {} };

// mechanical checks: no secret material, only the allowed endpoints, no $env / require, no dangling connections
const text = JSON.stringify(wf);
if (/ycmkpnunhxluqqtecbyu|shdrztqgwpyyxclgfpdg/.test(text)) throw new Error('production / Farm ERP reference in the workflow');
if (/sb_secret_|service_role|sk-[A-Za-z0-9_-]{20,}|eyJ[A-Za-z0-9_-]{20,}/.test(text)) throw new Error('key material in the workflow');
if (/\$env|require\(/.test(text)) throw new Error('the workflow must not use $env or require() on the shared instance');
const urls = [...text.matchAll(/https:\/\/[a-z0-9.-]+/g)].map((m) => m[0]);
const allowed = [`https://${REF}.supabase.co`, 'https://graph.facebook.com', 'https://api.openai.com'];
if (!urls.every((u) => allowed.includes(u))) throw new Error('unexpected endpoint ' + [...new Set(urls)].join(','));
for (const [from, c] of Object.entries(connections)) {
  if (!nodes.some((n) => n.name === from)) throw new Error('dangling source ' + from);
  for (const t of c.main.flat()) if (!nodes.some((m) => m.name === t.node)) throw new Error('dangling ' + t.node);
}
mkdirSync(join(HERE, 'build'), { recursive: true });
const out = join(HERE, 'build', 'STAGING_wa_expense_capture.json');
writeFileSync(out, JSON.stringify(wf, null, 1));
console.log(`workflow: ${out}\nsha256: ${createHash('sha256').update(JSON.stringify(wf, null, 1)).digest('hex')}\nnodes: ${nodes.length}; model: ${conf.model}; endpoints: ${[...new Set(urls)].join(', ')}`
  + (allowPlaceholder ? '\nWARNING: dry build (placeholder catalog / model); not importable for E2E' : ''));
