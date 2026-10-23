// ADR-025 — compare the CURRENT workflow exported from n8n (UI: ⋯ → Download) with the new build, and produce a merged
// workflow that keeps everything made in the UI. Writes nothing in n8n.
//   node n8n/compare-merge.mjs <export.json>
//   → report on stdout + n8n/build/STAGING_wa_expense_capture.merged.json (inactive, name "STAGING - Gastos WhatsApp v2")
// Rules: nodes in both → keep the export's id, credentials, position and NON-code parameters (UI changes are
// preserved and listed); Code nodes and connections → new build; new nodes → added (credentials copied from the
// matching existing node when possible, otherwise reported for selection in the UI); unknown UI-added nodes → STOP.
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const [, , exportPath] = process.argv;
if (!exportPath) { console.log('usage: node n8n/compare-merge.mjs <export.json>'); process.exit(2); }
const E = JSON.parse(readFileSync(exportPath, 'utf8'));
const N = JSON.parse(readFileSync(new URL('./build/STAGING_wa_expense_capture.json', import.meta.url), 'utf8'));
const stop = (m) => { console.log('STOP: ' + m); process.exit(2); };
if (E.name !== 'STAGING - Gastos WhatsApp') stop(`the export is "${E.name}", not "STAGING - Gastos WhatsApp"`);
const sha = (s) => createHash('sha256').update(String(s)).digest('hex').slice(0, 12);
const byName = (wf) => Object.fromEntries(wf.nodes.map((n) => [n.name, n]));
const en = byName(E), nn = byName(N);
const V1_ONLY = new Set(['Compose reply']);            // replaced by "After action" / "Compose follow-up" in stage 1
const report = [];
const canon = (v) => Array.isArray(v) ? v.map(canon) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon(v[k])])) : v;
const stable = (o) => JSON.stringify(canon(o));

const unknown = Object.keys(en).filter((k) => !nn[k] && !V1_ONLY.has(k));
if (unknown.length) stop(`nodes added in the UI that the new build does not know: ${unknown.join(', ')} — review them before merging`);
const webhook = E.nodes.find((n) => n.type === 'n8n-nodes-base.webhook');
if (!webhook || webhook.parameters.path !== nn['Edge → n8n'].parameters.path) stop('the export does not use the staging webhook path');

const nodes = N.nodes.map((n) => {
  const old = en[n.name];
  if (!old) {
    const copy = { ...n };
    const sibling = { 'Call Edge follow-up': 'Call Edge action' }[n.name];
    if (n.credentials && sibling && en[sibling]?.credentials) { copy.credentials = en[sibling].credentials; report.push(`ADD  ${n.name} (credentials copied from "${sibling}")`); }
    else if (n.credentials) report.push(`ADD  ${n.name} — SELECT credential "${Object.values(n.credentials)[0].name}" in the UI after import`);
    else report.push(`ADD  ${n.name}`);
    return copy;
  }
  if (old.type !== n.type) stop(`node "${n.name}" changed type in the UI (${old.type})`);
  // v2 is imported as a NEW workflow: same webhook PATH (the Edge keeps calling the same URL), but its own webhookId, so the
  // two workflows never share a webhook identity; n8n itself refuses to activate two workflows with the same path + method.
  const merged = { ...n, id: old.id, position: old.position, ...(old.credentials ? { credentials: old.credentials } : {}) };
  if (n.webhookId) report.push(`WEBHOOK ${n.name}: path kept (${old.parameters.path}); new webhookId for v2 (export id not reused)`);
  if (n.type === 'n8n-nodes-base.code') {
    report.push(`CODE ${n.name}: ${sha(old.parameters.jsCode)} → ${sha(n.parameters.jsCode)} (new build)`);
    return merged;
  }
  merged.parameters = old.parameters;                                    // UI parameters win for non-code nodes
  if (old.typeVersion !== n.typeVersion) report.push(`KEEP ${n.name}: typeVersion ${old.typeVersion} (build ${n.typeVersion})`);
  merged.typeVersion = old.typeVersion;
  if (stable(old.parameters) !== stable(n.parameters)) {
    const keys = [...new Set([...Object.keys(old.parameters), ...Object.keys(n.parameters)])].filter((k) => stable(old.parameters[k] ?? null) !== stable(n.parameters[k] ?? null));
    report.push(`KEEP ${n.name}: UI parameters preserved; differs from build in [${keys.join(', ')}]`);
  } else report.push(`SAME ${n.name}`);
  return merged;
});
for (const k of Object.keys(en)) if (V1_ONLY.has(k)) report.push(`DROP ${k} (stage 0 node, replaced)`);
const settings = { ...E.settings, saveDataSuccessExecution: 'none', saveManualExecutions: false, callerPolicy: 'workflowsFromSameOwner',
  executionTimeout: Math.max(Number(E.settings?.executionTimeout || 0), N.settings.executionTimeout) };
for (const k of ['saveDataSuccessExecution', 'saveManualExecutions', 'callerPolicy', 'executionTimeout']) if (E.settings?.[k] !== settings[k]) report.push(`SET  settings.${k}: ${E.settings?.[k]} → ${settings[k]}`);
const out = { name: 'STAGING - Gastos WhatsApp v2', nodes, connections: N.connections, active: false, settings, tags: E.tags || [], pinData: {} };
const path = new URL('./build/STAGING_wa_expense_capture.merged.json', import.meta.url);
writeFileSync(path, JSON.stringify(out, null, 1));
console.log(report.join('\n'));
console.log(`merged: ${path.pathname.replace(/^\/([A-Z]:)/, '$1')} (inactive; import as a NEW workflow — the current one stays untouched as rollback)`);
