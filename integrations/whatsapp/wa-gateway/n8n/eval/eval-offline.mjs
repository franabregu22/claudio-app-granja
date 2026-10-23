// ADR-025 — OFFLINE harness test of the v2 evaluation (deterministic; no network, no key, no cost).
// A local server on 127.0.0.1 answers each case with its `ideal` interpretation (golden-set-v2.json), translating the
// subcategory NAME to the code the request offered. It proves that the harness, the production pipeline (preRoute →
// buildRequest → parseResponse → decide) and the judge agree on every expected outcome. It says NOTHING about the model.
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { idealAnswer } from './eval-lib.mjs';

const HERE = new URL('.', import.meta.url);
const server = createServer((req, res) => {
  let body = ''; req.on('data', (c) => (body += c)).on('end', () => {
    if (req.method === 'GET' && req.url.startsWith('/v1/models/')) { res.writeHead(/luna/.test(req.url) ? 200 : 404); return res.end('{}'); }
    const a = idealAnswer(JSON.parse(body), process.env.EVAL_SABOTAGE === '1');
    if (!a) { res.writeHead(500); return res.end('{}'); }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(a));
  });
});
server.listen(0, '127.0.0.1', () => {
  const port = server.address().port;
  const child = spawn(process.execPath, [fileURLToPath(new URL('./eval-models.mjs', HERE))],
    { env: { ...process.env, OPENAI_API_KEY: 'offline-harness', EVAL_BASE_URL: `http://127.0.0.1:${port}` }, stdio: 'inherit' });
  child.on('exit', (code) => { server.close(); process.exitCode = code; });
});
