// ADR-025 — STAGE 2 preflight (local, read-only towards every service): the exported published workflow vs the new build.
//   node n8n/stage2-preflight.mjs <export.json>
// 1. runs compare-merge (writes n8n/build/STAGING_wa_expense_capture.merged.json, the v2 to import — inactive)
// 2. checks P-1..P-10 on the export and on the merged v2; prints STAGE2 PREFLIGHT: PASS / FAIL. Nothing is sent anywhere.
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const [, , exportPath] = process.argv;
if (!exportPath) { console.log('usage: node n8n/stage2-preflight.mjs <export.json>'); process.exit(2); }
const here = (p) => fileURLToPath(new URL(p, import.meta.url));
let mergeOut;
try { mergeOut = execFileSync(process.execPath, [here('./compare-merge.mjs'), exportPath], { encoding: 'utf8' }); }
catch (e) { console.log(String(e.stdout || e.message)); console.log('STAGE2 PREFLIGHT: FAIL (compare-merge stopped)'); process.exit(1); }
console.log('== compare-merge report\n' + mergeOut.trim());
const E = JSON.parse(readFileSync(exportPath, 'utf8'));
const M = JSON.parse(readFileSync(here('./build/STAGING_wa_expense_capture.merged.json'), 'utf8'));
const conf = JSON.parse(readFileSync(here('./interpreter-config.json'), 'utf8'));
const by = (wf) => Object.fromEntries(wf.nodes.map((n) => [n.name, n]));
const en = by(E), mn = by(M);
const ALLOWED_CREDS = ['STAGING_WA_EDGE_TO_N8N', 'STAGING_WA_N8N_TO_EDGE', 'STAGING_META_GRAPH_TOKEN', 'STAGING_OPENAI_GRANJA'];
const checks = [];
const check = (id, name, ok, detail = '') => checks.push({ id, name, ok, detail });

// P-1 existing credentials preserved exactly (id + name) on every node that already had them
const lost = Object.values(en).filter((n) => n.credentials && mn[n.name] && JSON.stringify(mn[n.name].credentials) !== JSON.stringify(n.credentials)).map((n) => n.name);
check('P-1', 'existing credentials preserved (id + name)', lost.length === 0, lost.join(', '));
// P-2 only the 4 STAGING credentials are referenced; every one has an id except the OpenAI node (selected in the UI)
const credRefs = M.nodes.filter((n) => n.credentials).flatMap((n) => Object.values(n.credentials).map((c) => ({ node: n.name, ...c })));
const badNames = credRefs.filter((c) => !ALLOWED_CREDS.includes(c.name));
const noId = credRefs.filter((c) => (!c.id || c.id === 'SET_ON_IMPORT') && c.name !== 'STAGING_OPENAI_GRANJA');
check('P-2', 'only STAGING credentials; ids carried for all but the OpenAI node', badNames.length === 0 && noId.length === 0,
  [...badNames.map((c) => `${c.node}:${c.name}`), ...noId.map((c) => `no id: ${c.node}`)].join(', '));
// P-3 OpenAI node: Responses API, predefined credential STAGING_OPENAI_GRANJA (openAiApi), POST JSON, timeout >= 20 s
const o = mn['OpenAI interpret'];
const oc = o && Object.entries(o.credentials || {})[0];
check('P-3', 'OpenAI node uses STAGING_OPENAI_GRANJA via predefined openAiApi credential, POST /v1/responses, JSON body, timeout >= 20 s',
  !!o && o.parameters.url === 'https://api.openai.com/v1/responses' && o.parameters.method === 'POST' && o.parameters.authentication === 'predefinedCredentialType'
  && o.parameters.nodeCredentialType === 'openAiApi' && oc?.[0] === 'openAiApi' && oc?.[1].name === 'STAGING_OPENAI_GRANJA'
  && o.parameters.specifyBody === 'json' && Number(o.parameters.options?.timeout) >= 20000, o ? '' : 'node missing');
// P-4 compatibility: every (node type, typeVersion) of v2 already runs in this n8n instance (present in the export)
const known = new Set(E.nodes.map((n) => `${n.type}@${n.typeVersion}`));
const unknown = [...new Set(M.nodes.map((n) => `${n.type}@${n.typeVersion}`))].filter((k) => !known.has(k));
check('P-4', 'all node types / versions of v2 already run in this instance (incl. HTTP Request for OpenAI)', unknown.length === 0, unknown.join(', '));
// P-5 the chosen model is embedded (and only it)
const after = mn['After action']?.parameters.jsCode || '';
check('P-5', `model ${conf.model} / effort ${conf.reasoning_effort} embedded`, after.includes(`"model":"${conf.model}"`) && after.includes(`"effort":${JSON.stringify(conf.reasoning_effort)}`) && conf.model !== 'PENDING_EVAL');
// P-6 no secret material in the export nor in v2 (keys, JWTs, 64-hex tokens, bearer values, full phones)
const scan = (wf) => { const t = JSON.stringify(wf); return [[/sk-[A-Za-z0-9_-]{16,}/, 'openai key'], [/eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}/, 'jwt'], [/sb_(secret|publishable)_[A-Za-z0-9_-]+/, 'supabase key'],
  [/(?<![0-9a-f])[0-9a-f]{64}(?![0-9a-f])/, '64-hex token'], [/Bearer [A-Za-z0-9._-]{16,}/, 'bearer value'], [/\+?549?[0-9]{10}(?![0-9])/, 'phone number'],
  [/ycmkpnunhxluqqtecbyu|shdrztqgwpyyxclgfpdg/, 'production / Farm ERP ref'], [/\$env|require\(/, '$env / require']].filter(([re]) => re.test(t)).map(([, w]) => w); };
const se = scan({ ...E, meta: undefined }), sm = scan(M);   // meta.instanceId (n8n instance id, 64 hex) is not a secret and is not carried into v2
check('P-6', 'no secrets / phones / forbidden refs in the export nor in v2', se.length === 0 && sm.length === 0, [...se.map((w) => 'export: ' + w), ...sm.map((w) => 'v2: ' + w)].join(', '));
// P-7 webhook: same path + method + auth credential as the published one; v2 has its own webhookId; v2 inactive
const ew = E.nodes.find((n) => n.type === 'n8n-nodes-base.webhook'), mw = M.nodes.find((n) => n.type === 'n8n-nodes-base.webhook');
check('P-7', 'webhook path / method / header-auth credential kept; own webhookId; v2 inactive',
  !!ew && !!mw && mw.parameters.path === ew.parameters.path && mw.parameters.httpMethod === ew.parameters.httpMethod && mw.parameters.authentication === 'headerAuth'
  && JSON.stringify(mw.credentials) === JSON.stringify(ew.credentials) && mw.webhookId && mw.webhookId !== ew.webhookId && M.active === false,
  ew ? `path ${ew.parameters.path}` : 'no webhook in export');
// P-8 endpoints: only AppGranja Edge, Graph API, OpenAI
const urls = [...new Set([...JSON.stringify(M).matchAll(/https:\/\/[a-z0-9.-]+/g)].map((m) => m[0]))];
check('P-8', 'only endpoints: AppGranja Edge, graph.facebook.com, api.openai.com', urls.every((u) => ['https://aplbsutpzgemexayldct.supabase.co', 'https://graph.facebook.com', 'https://api.openai.com'].includes(u)), urls.join(', '));
// P-9 graph integrity: every connection target exists; every node reachable from a trigger
const reach = new Set(); const q = M.nodes.filter((n) => /webhook|scheduleTrigger/.test(n.type)).map((n) => n.name);
while (q.length) { const k = q.shift(); if (reach.has(k)) continue; reach.add(k); for (const t of (M.connections[k]?.main || []).flat()) q.push(t.node); }
const dangling = Object.values(M.connections).flatMap((c) => c.main.flat()).filter((t) => !mn[t.node]).map((t) => t.node);
const orphan = M.nodes.filter((n) => !reach.has(n.name)).map((n) => n.name);
check('P-9', 'connections valid; every node reachable from a trigger', dangling.length === 0 && orphan.length === 0, [...dangling, ...orphan].join(', '));
// P-10 execution data: no successful executions stored (no message text kept); timeout covers OpenAI + 2 Edge calls
check('P-10', 'settings: saveDataSuccessExecution=none, executionTimeout >= 90 s', M.settings.saveDataSuccessExecution === 'none' && Number(M.settings.executionTimeout) >= 90);

// P-11 data contract: every `$json.<field>` used by a non-code node is produced by EVERY Code node that feeds it (through IFs)
const preds = (name) => Object.entries(M.connections).filter(([, c]) => c.main.flat().some((t) => t.node === name)).map(([s]) => s);
const feeders = (name, seen = new Set()) => preds(name).flatMap((s) => (seen.has(s) ? [] : (seen.add(s), mn[s].type === 'n8n-nodes-base.if' ? feeders(s, seen) : [s])));
const broken = [];
for (const n of M.nodes.filter((x) => x.type !== 'n8n-nodes-base.code')) {
  const fields = [...new Set([...JSON.stringify(n.parameters).matchAll(/\$json\.([A-Za-z_][A-Za-z0-9_]*)/g)].map((m) => m[1]))];
  for (const f of fields) for (const s of feeders(n.name)) {
    if (mn[s].type === 'n8n-nodes-base.code' && !new RegExp(`\\b${f}\\b`).test(mn[s].parameters.jsCode)) broken.push(`${n.name}.${f} ← ${s}`);
  }
}
check('P-11', 'data contract: fields used by HTTP / IF nodes are produced by every feeding Code node', broken.length === 0, broken.join(', '));

console.log('\n== checks');
for (const c of checks) console.log(`${c.ok ? 'PASS' : 'FAIL'} ${c.id} ${c.name}${c.ok || !c.detail ? '' : ' :: ' + c.detail}`);
const ok = checks.every((c) => c.ok);
console.log(`\nSTAGE2 PREFLIGHT: ${ok ? 'PASS' : 'FAIL'}`);
if (ok) console.log('v2 to import (inactive): n8n/build/STAGING_wa_expense_capture.merged.json — in n8n select STAGING_OPENAI_GRANJA on "OpenAI interpret".'
  + '\nSwitch-over (stage 2, with GO): deactivate the published workflow FIRST, then activate v2 (n8n refuses two active workflows on the same path).');
process.exitCode = ok ? 0 : 1;
