// hosted draft vs reviewed patched copy: per node jsCode equality; non-code fields vs the published base
const fs = require('fs'); const [draftf, patchedf, basef] = process.argv.slice(2);
const W = JSON.parse(fs.readFileSync(draftf, 'utf8')).workflow, R = JSON.parse(fs.readFileSync(patchedf, 'utf8')), B = JSON.parse(fs.readFileSync(basef, 'utf8')).workflow;
const by = (w) => Object.fromEntries(w.nodes.map((n) => [n.name, n])); const w = by(W), r = by(R), b = by(B);
for (const k of Object.keys(r)) {
  const eqR = JSON.stringify(w[k]?.parameters) === JSON.stringify(r[k].parameters), eqB = JSON.stringify(w[k]?.parameters) === JSON.stringify(b[k].parameters);
  const strip = (n) => JSON.stringify({ ...n, parameters: null });
  console.log(k.padEnd(20), eqR ? 'REVIEWED' : eqB ? 'BASE    ' : 'DIFF    ', strip(w[k]) === strip(b[k]) ? '' : 'NON-PARAM-DIFF');
  if (!eqR && !eqB && w[k]?.parameters?.jsCode) { const x = w[k].parameters.jsCode, y = r[k].parameters.jsCode; let i = 0; while (x[i] === y[i]) i++; console.log('   first diff at', i, JSON.stringify(x.slice(i - 30, i + 40)), '| expected', JSON.stringify(y.slice(i - 30, i + 40))); }
}
console.log('versionId', W.versionId, 'activeVersionId', W.activeVersionId, 'active', W.active, 'connections==base', JSON.stringify(W.connections) === JSON.stringify(B.connections), 'settings==base', JSON.stringify(W.settings) === JSON.stringify(B.settings));
