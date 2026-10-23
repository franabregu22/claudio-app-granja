// ADR-025 — builds the TEMPORARY n8n evaluation workflow "TEMP - ADR025 eval v2" that runs the golden-set-v2 against the
// real model through the EXISTING n8n credential STAGING_OPENAI_GRANJA (referenced by id; n8n injects the key, it never
// leaves n8n and is never part of these files). No new key, no webhook, no schedule: Manual Trigger only.
//   Run eval (manual) → Eval requests (the exact bodies production would send, precomputed here with interpreter.js)
//   → OpenAI responses (POST https://api.openai.com/v1/responses, predefined credential openAiApi, batched)
//   → Collect (keeps only: case id, candidate, HTTP status, model output text, token usage, error type/code).
// Outputs (default ./build, or --out <dir>): eval-n8n.workflow.json (importable), eval-n8n.sdk.js (for the n8n MCP
// create_workflow_from_code), eval-n8n.manifest.json (run id, date, sha256 of every request; read by eval-n8n-judge.mjs).
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { cfg, cases, todayAR, prepare, FNV_SRC } from './eval-lib.mjs';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const oi = process.argv.indexOf('--out');
const OUT = oi > 0 ? process.argv[oi + 1] : join(HERE, 'build');
const OPENAI_CRED = { id: 'PbcX1ZgBT8eCoUxS', name: 'STAGING_OPENAI_GRANJA' };   // existing n8n credential (id only, no secret)
const OPENAI = 'https://api.openai.com/v1/responses';
const sha = (s) => createHash('sha256').update(s).digest('hex');

const today = todayAR();
const run = randomUUID();
// focused runs: --cases C01,C03 (golden ids) and/or --efforts low (candidate efforts); default = the whole golden set, every candidate
const arg = (k) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1].split(',').map((x) => x.trim()).filter(Boolean) : null; };
const onlyCases = arg('--cases'), onlyEfforts = arg('--efforts');
if (onlyCases) for (const id of onlyCases) if (!cases.some((c) => c.id === id)) throw new Error('unknown case ' + id);
const sel = onlyCases ? cases.filter((c) => onlyCases.includes(c.id)) : cases;
const cands = cfg.candidates.filter((c) => !c.deprecated && (!onlyEfforts || onlyEfforts.includes(String(c.effort))));   // deprecated: never eligible, not called
if (!cands.length) throw new Error('no candidate selected');
const requests = [], manifest = { eval: 'adr025-v2', run, today, golden: 'golden-set-v2.json', cases: sel.length, case_ids: sel.map((c) => c.id), focused: !!(onlyCases || onlyEfforts),
  candidates: [], requests: {} };
for (const cand of cands) {
  const label = `${cand.model}${cand.effort ? ' / ' + cand.effort : ''}`;
  manifest.candidates.push({ label, ...cand });
  for (const c of sel) {
    const p = prepare(c, cand, today);
    if (!p.body) continue;   // answered deterministically (preRoute): no GPT, as in production
    requests.push({ id: c.id, label, body: p.body });
    manifest.requests[`${label}|${c.id}`] = sha(JSON.stringify(p.body));
  }
}

// compact form (the n8n MCP accepts at most 300 000 chars of SDK code): the request shell (instructions, schema, model)
// is stored once per candidate and the catalog once; each request keeps only its own user message fields.
const shells = {}, cats = JSON.parse(requests[0].body.input[1].content).categorias;
const compact = requests.map((r) => {
  const u = JSON.parse(r.body.input[1].content);
  if (JSON.stringify(u.categorias) !== JSON.stringify(cats)) throw new Error('the catalog differs between requests');
  shells[r.label] ??= { ...r.body, input: [r.body.input[0], { ...r.body.input[1], content: null }] };
  return { id: r.id, label: r.label, u: { ...u, categorias: 0 } };
});
const EVAL_REQUESTS = `// ADR-025 eval v2 — synthetic golden-set requests (no real data), run ${run}
const SHELL = ${JSON.stringify(shells)};
const CATS = ${JSON.stringify(cats)};
const R = ${JSON.stringify(compact)};
return R.map((r) => { const s = SHELL[r.label];
  const content = JSON.stringify(Object.fromEntries(Object.entries(r.u).map(([k, v]) => [k, k === 'categorias' ? CATS : v])));
  return { json: { id: r.id, label: r.label, body: { ...s, input: [s.input[0], { ...s.input[1], content }] } } }; });`;
// the node must rebuild EXACTLY the bodies production would send (byte for byte)
const rebuilt = new Function(EVAL_REQUESTS)();
if (rebuilt.length !== requests.length || rebuilt.some((x, i) => JSON.stringify(x.json.body) !== JSON.stringify(requests[i].body) || x.json.id !== requests[i].id))
  throw new Error('Eval requests does not rebuild the production requests exactly');
// only what the judge needs leaves this node: no headers, no request body, nothing else from OpenAI's answer
const COLLECT = `const fnv = ${FNV_SRC};
const req = $('Eval requests').all();
const res = $input.all();
if (req.length !== res.length) throw new Error('eval: ' + res.length + ' answers for ' + req.length + ' requests');
const keep = (b) => (b && typeof b === 'object') ? {
  status: b.status ?? null,
  output: (b.output || []).filter((o) => o && o.type === 'message').map((o) => ({ type: 'message',
    content: (o.content || []).map((c) => ({ type: c.type, text: typeof c.text === 'string' ? c.text : null, refusal: typeof c.refusal === 'string' ? c.refusal : null })) })),
  usage: b.usage ? { input_tokens: b.usage.input_tokens ?? 0, output_tokens: b.usage.output_tokens ?? 0 } : null,
  error: b.error ? { type: b.error.type ?? null, code: b.error.code ?? null } : null } : null;
return [{ json: { eval: 'adr025-v2', run: ${JSON.stringify(run)}, results: res.map((r, i) => ({ id: req[i].json.id, label: req[i].json.label, fp: fnv(JSON.stringify(req[i].json.body)),
  statusCode: r.json.statusCode ?? 0, body: keep(r.json.body) })) } }];`;

const N = [
  { name: 'Run eval', type: 'n8n-nodes-base.manualTrigger', typeVersion: 1, parameters: {} },
  { name: 'Eval requests', type: 'n8n-nodes-base.code', typeVersion: 2, parameters: { mode: 'runOnceForAllItems', language: 'javaScript', jsCode: EVAL_REQUESTS } },
  { name: 'OpenAI responses', type: 'n8n-nodes-base.httpRequest', typeVersion: 4.2,
    parameters: { method: 'POST', url: OPENAI, authentication: 'predefinedCredentialType', nodeCredentialType: 'openAiApi',
      sendBody: true, specifyBody: 'json', jsonBody: '={{ JSON.stringify($json.body) }}',
      options: { timeout: 60000, batching: { batch: { batchSize: 3, batchInterval: 1500 } }, response: { response: { fullResponse: true, neverError: true } } } },
    credentials: { openAiApi: OPENAI_CRED } },
  { name: 'Collect', type: 'n8n-nodes-base.code', typeVersion: 2, parameters: { mode: 'runOnceForAllItems', language: 'javaScript', jsCode: COLLECT } },
].map((n, i) => ({ id: randomUUID(), ...n, position: [240 * i, 300] }));
const chain = N.map((n) => n.name);
const connections = Object.fromEntries(chain.slice(0, -1).map((s, i) => [s, { main: [[{ node: chain[i + 1], type: 'main', index: 0 }]] }]));
const NAME = `TEMP - ADR025 eval v2${manifest.focused ? ' focalizada' : ''} (archivar al terminar)`;
const settings = { executionOrder: 'v1', saveManualExecutions: true, saveDataSuccessExecution: 'all', saveDataErrorExecution: 'all', executionTimeout: 900,
                   callerPolicy: 'workflowsFromSameOwner' };
const wf = { name: NAME, nodes: N, connections, active: false, settings, tags: [], pinData: {} };

// mechanical checks: no key material, OpenAI is the only endpoint, the credential is referenced by id, no $env / require
const text = JSON.stringify(wf);
if (/sk-[A-Za-z0-9_-]{20,}|sb_secret_|service_role|eyJ[A-Za-z0-9_-]{20,}|[Bb]earer\s+[A-Za-z0-9]/.test(text)) throw new Error('key material in the workflow');
if (/\$env|require\(|ycmkpnunhxluqqtecbyu|aplbsutpzgemexayldct|graph\.facebook/.test(text)) throw new Error('forbidden reference in the workflow');
const urls = [...new Set([...text.matchAll(/https?:\/\/[a-z0-9.-]+/g)].map((m) => m[0]))];
if (urls.join() !== 'https://api.openai.com') throw new Error('unexpected endpoint ' + urls.join(','));
if (/@[a-z0-9-]+\.[a-z]{2,}/i.test(text)) throw new Error('an e-mail address in the workflow');

const sdk = ["import { workflow, node, trigger } from '@n8n/workflow-sdk';", '',
  ...N.map((n, i) => `const n${i} = ${n.type.endsWith('Trigger') ? 'trigger' : 'node'}({ type: ${JSON.stringify(n.type)}, version: ${n.typeVersion}, config: { name: ${JSON.stringify(n.name)}, `
    + `position: ${JSON.stringify(n.position)}, parameters: ${JSON.stringify(n.parameters)}${n.credentials ? ', credentials: ' + JSON.stringify(n.credentials) : ''} } });`),
  '', `export default workflow('', ${JSON.stringify(NAME)}, { settings: ${JSON.stringify(settings)} })`,
  ...N.slice(0, -1).map((_, i) => `  .add(n${i}.output(0).to(n${i + 1}.input(0)))`), ';'].join('\n');

mkdirSync(OUT, { recursive: true });
manifest.workflow_sha256 = sha(JSON.stringify(wf, null, 1));
writeFileSync(join(OUT, 'eval-n8n.workflow.json'), JSON.stringify(wf, null, 1));
writeFileSync(join(OUT, 'eval-n8n.sdk.js'), sdk);
writeFileSync(join(OUT, 'eval-n8n.manifest.json'), JSON.stringify(manifest, null, 1));
console.log(`eval workflow: ${join(OUT, 'eval-n8n.workflow.json')}\nrun ${run} · date ${today} · ${requests.length} OpenAI calls (${cands.map((c) => c.model + '/' + c.effort).join(', ')}) `
  + `· ${sel.length * cands.length - requests.length} answered without GPT · cases ${sel.length} · endpoint ${urls.join()} · credential ${OPENAI_CRED.name} (by id)\nsdk: ${sdk.length} chars · workflow sha256 ${manifest.workflow_sha256}`);
