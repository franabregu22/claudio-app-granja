// SDK code from the reviewed merged v2 JSON; the two shared libraries (logic.js / interpreter.js blocks) are declared once.
const fs = require('fs');
const [src, out] = process.argv.slice(2);
const W = JSON.parse(fs.readFileSync(src, 'utf8'));
const OPENAI = { id: 'PbcX1ZgBT8eCoUxS', name: 'STAGING_OPENAI_GRANJA' };
const g = (n) => W.nodes.find((x) => x.name === n).parameters.jsCode;
const a = g('Verify & route'); const LIB1 = a.slice(0, a.indexOf('})();\n') + 6);
const rs = ['After action', 'Validate & map', 'Compose follow-up'].map((n) => g(n).slice(LIB1.length));
let k = 0; while (rs.every((r) => r[k] === rs[0][k])) k++;
const LIB2 = rs[0].slice(0, rs[0].lastIndexOf('})();\n', k) + 6);
const codeExpr = (c) => {
  if (!c.startsWith(LIB1)) return JSON.stringify(c);
  const r = c.slice(LIB1.length);
  return r.startsWith(LIB2) ? `LIB1 + LIB2 + ${JSON.stringify(r.slice(LIB2.length))}` : `LIB1 + ${JSON.stringify(r)}`;
};
const v = {}; const L = ["import { workflow, node, trigger } from '@n8n/workflow-sdk';", '', `const LIB1 = ${JSON.stringify(LIB1)};`, `const LIB2 = ${JSON.stringify(LIB2)};`, ''];
W.nodes.forEach((n, i) => {
  v[n.name] = 'n' + i;
  const creds = n.credentials ? JSON.parse(JSON.stringify(n.credentials)) : undefined;
  if (creds?.openAiApi) creds.openAiApi = OPENAI;
  let params = JSON.stringify(n.parameters);
  if (n.parameters.jsCode) { const { jsCode, ...rest } = n.parameters; params = `{ ...${JSON.stringify(rest)}, jsCode: ${codeExpr(jsCode)} }`; }
  const fn = /Trigger$|\.webhook$/.test(n.type) ? 'trigger' : 'node';
  L.push(`const n${i} = ${fn}({ type: ${JSON.stringify(n.type)}, version: ${n.typeVersion}, config: { name: ${JSON.stringify(n.name)}, position: ${JSON.stringify(n.position)}, parameters: ${params}${creds ? ', credentials: ' + JSON.stringify(creds) : ''} } });`);
});
const edges = [];
for (const [s, o] of Object.entries(W.connections)) (o.main || []).forEach((arr, i) => (arr || []).forEach((c) => edges.push(`${v[s]}.output(${i}).to(${v[c.node]}.input(${c.index}))`)));
L.push('', `export default workflow('', ${JSON.stringify(W.name)}, { settings: ${JSON.stringify({ ...W.settings, availableInMCP: false })} })`);
edges.forEach((e) => L.push(`  .add(${e})`)); L.push(';');
fs.writeFileSync(out, L.join('\n'));
console.log('LIB1', LIB1.length, 'LIB2', LIB2.length, 'chars', L.join('\n').length);
