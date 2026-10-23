// compares two get_workflow_details dumps of V2: expect = 'same' (pre-write) or 'logsend' (only Log send jsCode may differ, = fix)
const fs = require('fs'); const [a, b, fixf, expect] = process.argv.slice(2);
const A = JSON.parse(fs.readFileSync(a, 'utf8')).workflow, B = JSON.parse(fs.readFileSync(b, 'utf8')).workflow; const fix = fs.readFileSync(fixf, 'utf8');
const by = (w) => Object.fromEntries(w.nodes.map((n) => [n.name, n]));
const a1 = by(A), b1 = by(B); const out = []; const ck = (n, ok, d = '') => out.push((ok ? 'PASS ' : 'FAIL ') + n + (d ? ' :: ' + d : ''));
const changed = Object.keys({ ...a1, ...b1 }).filter((k) => JSON.stringify(a1[k]) !== JSON.stringify(b1[k]));
ck('node set / count', Object.keys(a1).length === 18 && Object.keys(b1).length === 18 && Object.keys(a1).every((k) => b1[k]));
ck(expect === 'same' ? 'no node changed' : 'only "Log send" changed', expect === 'same' ? changed.length === 0 : changed.join() === 'Log send', changed.join());
if (expect === 'logsend') {
  const x = a1['Log send'], y = b1['Log send'];
  const strip = (n) => JSON.stringify({ ...n, parameters: { ...n.parameters, jsCode: null } });
  ck('Log send: only jsCode differs', strip(x) === strip(y));
  ck('Log send jsCode = reviewed fix', y.parameters.jsCode === fix);
}
ck('connections equal', JSON.stringify(A.connections) === JSON.stringify(B.connections));
ck('settings equal', JSON.stringify(A.settings) === JSON.stringify(B.settings), JSON.stringify(B.settings));
const wa = a1['Edge → n8n'], wb = b1['Edge → n8n'];
ck('webhook path/method/auth/credential/webhookId unchanged', JSON.stringify([wa.parameters, wa.credentials, wa.webhookId]) === JSON.stringify([wb.parameters, wb.credentials, wb.webhookId]), `${wb.parameters.httpMethod} ${wb.parameters.path} ${wb.webhookId.slice(0, 8)}…`);
ck('credentials unchanged', JSON.stringify(A.nodes.map((n) => [n.name, n.credentials || null])) === JSON.stringify(B.nodes.map((n) => [n.name, n.credentials || null])));
console.log(out.join('\n')); console.log(`A ${A.versionId} active=${A.active} activeV=${A.activeVersionId} | B ${B.versionId} active=${B.active} activeV=${B.activeVersionId}`);
process.exit(out.some((l) => l.startsWith('FAIL')) ? 1 : 0);
