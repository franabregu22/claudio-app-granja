const fs = require('fs'); const [f, m] = process.argv.slice(2);
const src = fs.readFileSync(f, 'utf8').replace(/^import .*$/m, '').replace('export default ', 'return ');
const nodes = [], edges = [];
const mk = (o) => { const x = { o, output: (i) => ({ to: (t) => ({ s: x, i, t }) }), input: (j) => ({ n: x, j }) }; nodes.push(x); return x; };
const workflow = (id, name, opts) => { const w = { name, opts, add: (e) => { edges.push(e); return w; } }; return w; };
const R = new Function('workflow', 'node', 'trigger', src)(workflow, mk, mk);
const M = JSON.parse(fs.readFileSync(m, 'utf8')); let bad = 0;
for (const x of nodes) { const n = M.nodes.find((y) => y.name === x.o.config.name);
  if (!n || JSON.stringify(n.parameters) !== JSON.stringify(x.o.config.parameters) || n.type !== x.o.type || n.typeVersion !== x.o.version || JSON.stringify(n.position) !== JSON.stringify(x.o.config.position)) { bad++; console.log('DIFF', x.o.config.name); } }
const ce = new Set(); for (const [s, o] of Object.entries(M.connections)) (o.main || []).forEach((a, i) => (a || []).forEach((c) => ce.add(`${s}|${i}|${c.node}|${c.index}`)));
const ge = new Set(edges.map((e) => `${e.s.o.config.name}|${e.i}|${e.t.n.o.config.name}|${e.t.j}`));
console.log('nodes', nodes.length, 'param/type/position diffs', bad, 'edges', ge.size, 'edges equal', ce.size === ge.size && [...ce].every((e) => ge.has(e)));
console.log('creds', JSON.stringify(nodes.filter((x) => x.o.config.credentials).map((x) => x.o.config.name + ':' + Object.values(x.o.config.credentials).map((c) => c.name + '/' + c.id).join())));
console.log('settings', JSON.stringify(R.opts.settings));
