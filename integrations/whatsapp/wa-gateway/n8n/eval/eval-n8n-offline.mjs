// ADR-025 — OFFLINE test of the n8n evaluation path (no network, no n8n, no key). It builds the temporary workflow into a
// temp dir, runs ITS OWN Code nodes ("Eval requests", "Collect") locally, simulates the HTTP node with the ideal answers
// (EVAL_SABOTAGE=1 → wrong on purpose) plus response headers that must NOT survive "Collect", then runs the judge.
// It checks the mechanism only; it says NOTHING about the model.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { idealAnswer } from './eval-lib.mjs';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const dir = mkdtempSync(join(tmpdir(), 'adr025-eval-'));
execFileSync(process.execPath, [join(HERE, 'eval-n8n-build.mjs'), '--out', dir, ...process.argv.slice(2)], { stdio: 'inherit' });   // e.g. --cases C01,C03
const wf = JSON.parse(readFileSync(join(dir, 'eval-n8n.workflow.json'), 'utf8'));
const js = (n) => wf.nodes.find((x) => x.name === n).parameters.jsCode;

const reqItems = new Function(js('Eval requests'))();
const sabotage = process.env.EVAL_SABOTAGE === '1';
const httpItems = reqItems.map((r) => ({ json: { statusCode: 200, headers: { 'openai-organization': 'org-simulated', 'x-request-id': 'req-simulated' },
  body: idealAnswer(r.json.body, sabotage) } }));
const $ = (name) => ({ all: () => (name === 'Eval requests' ? reqItems : []) });
const collected = new Function('$', '$input', js('Collect'))($, { all: () => httpItems });
const out = collected[0].json;
if (JSON.stringify(out).includes('org-simulated') || JSON.stringify(out).includes('"headers"')) throw new Error('Collect leaks response headers');
if (JSON.stringify(out).includes('"input"')) throw new Error('Collect leaks the request body');
out.simulated = true;
const file = join(dir, 'execution.simulated.json');
writeFileSync(file, JSON.stringify({ data: { resultData: { runData: { Collect: [{ data: { main: [[{ json: out }]] } }] } } } }));
console.log(`simulated execution: ${reqItems.length} requests → Collect ${out.results.length} results (no headers, no request bodies)`);
try { execFileSync(process.execPath, [join(HERE, 'eval-n8n-judge.mjs'), file, '--manifest', join(dir, 'eval-n8n.manifest.json')], { stdio: 'inherit' }); }
catch (e) { process.exitCode = e.status ?? 1; }
