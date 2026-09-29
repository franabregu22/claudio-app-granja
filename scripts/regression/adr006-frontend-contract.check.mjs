#!/usr/bin/env node
/**
 * ADR-006 Step 14 — mechanical check of the Phase 27 MP frontend contract (read-only, local only).
 *
 *   TEST_DATABASE_URL="postgresql://postgres:postgres@127.0.0.1:54322/postgres" \
 *     node scripts/regression/adr006-frontend-contract.check.mjs
 *
 * Parses the machine-readable block (§10) of
 * .planning/implementation-design/ADR006_PHASE27_MP_FRONTEND_CONTRACT_V1.md and checks it against the
 * live catalog of the FROZEN backend: every read comes from a Step-10 view and names real columns; every
 * action is an authorized ADMIN RPC with its exact signature; no direct table write; no
 * register_collection / RPC 41 / service-only path; exactly the three D-14-1 identifier lookups (C3 / C7 / S7,
 * SELECT only, minimal allow-listed columns, exact predicates) and no other mp_* read; the axis labels cover exactly the states and reasons
 * the view can emit and follow ADR-006 §6.4; no client-attribution state is a work item.
 * Writes nothing.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { assertSafeDestructiveTarget, assertNoProductionCredentials } from '../test-env/guard.mjs';

const REPO = resolve(import.meta.dirname, '..', '..');
const DOC = readFileSync(join(REPO, '.planning', 'implementation-design', 'ADR006_PHASE27_MP_FRONTEND_CONTRACT_V1.md'), 'utf8');
const VIEWS = ['report_mp_receipt_status', 'report_mp_delivery_health', 'report_mp_report_exceptions'];
// ADR006_IMPLEMENTATION_ORDER_V1 step 14: C1–C7 / R1 / R2 / S5 / S6 / S7 (C2 is service-only: never a UI action)
const AUTHORIZED = { C1: 'mp_allocate_to_client', C3: 'mp_reverse_client_allocation', C4: 'mp_flag_for_attribution', C5: 'mp_clear_attribution_flag',
  C6: 'mp_map_payer_to_client', C7: 'mp_unmap_payer', R1: 'mp_resolve_match', R2: 'mp_normalize_report_fallback', S5: 'mp_requeue_config_blocked',
  S6: 'mp_request_refetch', S7: 'mp_resolve_chargeback_signal' };
const SERVICE_ONLY = ['mp_register_delivery', 'mp_claim_deliveries', 'mp_delivery_transition', 'mp_ingest_api_snapshot', 'mp_normalize_source',
  'mp_apply_transition', 'mp_auto_allocate', 'mp_check_report_coverage', 'mp_record_balance_check'];
const AXIS_B_FORBIDDEN = /pendiente|conciliad|sin conciliar|error/i;

let pass = 0;
let fail = 0;
const failures = [];
function check(label, cond, detail = '') {
  if (cond) { pass += 1; console.log(`    OK   ${label}`); } else { fail += 1; failures.push(label); console.log(`    MAL  ${label} :: ${detail}`); }
}
function resolveBin(name, candidates) {
  const onPath = spawnSync(name, ['--version'], { encoding: 'utf8' });
  if (!onPath.error && onPath.status === 0) return name;
  for (const c of candidates) if (existsSync(c)) return c;
  throw new Error(`${name} not found`);
}
const DOCKER = resolveBin('docker', [resolve(process.env.LOCALAPPDATA ?? '', 'Programs', 'DockerDesktop', 'resources', 'bin', 'docker.exe')]);
assertNoProductionCredentials(process.env);
assertSafeDestructiveTarget(process.env.TEST_DATABASE_URL);
const container = (spawnSync(DOCKER, ['ps', '--filter', 'name=supabase_db', '--format', '{{.Names}}'], { encoding: 'utf8' }).stdout || '').trim().split('\n').filter(Boolean)[0];
function owner(s) {
  const r = spawnSync(DOCKER, ['exec', '-i', container, 'psql', '-U', 'postgres', '-d', 'postgres', '-t', '-A', '-q', '-v', 'ON_ERROR_STOP=1', '-f', '-'], { encoding: 'utf8', input: s });
  if (r.status !== 0) throw new Error(r.stderr);
  return (r.stdout || '').trim();
}

const block = /```json\n([\s\S]*?)\n```/.exec(DOC.replace(/\r\n/g, '\n'));
let C = null;
try { C = JSON.parse(block[1]); } catch (e) { C = null; }
check('K-0 the contract carries a parseable machine-readable block (§10)', C && C.contract === 'ADR006_PHASE27_MP_FRONTEND_CONTRACT_V1');
if (!C) process.exit(1);

// reads
const cols = JSON.parse(owner(`SELECT json_object_agg(table_name, cols)::text FROM (SELECT table_name, json_agg(column_name::text) cols
  FROM information_schema.columns WHERE table_schema = 'public' AND table_name IN (${VIEWS.map((v) => `'${v}'`).join(',')}) GROUP BY table_name) x;`));
const reads = Object.entries(C.reads);
check('K-1 every MP screen reads only a Step-10 view (report_mp_receipt_status / report_mp_delivery_health / report_mp_report_exceptions)',
  reads.length > 0 && reads.every(([, r]) => VIEWS.includes(r.view)), reads.filter(([, r]) => !VIEWS.includes(r.view)).map(([s, r]) => `${s}:${r.view}`).join());
const badFields = reads.flatMap(([s, r]) => r.fields.filter((f) => !(cols[r.view] ?? []).includes(f)).map((f) => `${s}.${f}`));
check('K-2 every consumed field exists in its view (the frozen 0055 columns)', badFields.length === 0, badFields.join(', '));
check('K-3 no screen reads an MP table or report_mp_movement_status', reads.every(([, r]) => !C.forbidden_reads.includes(r.view))
  && ['report_mp_movement_status', 'mp_client_allocation', 'mp_payer_client_map', 'mp_webhook_delivery', 'mp_report_match', 'mp_transition_identity',
    'mp_source_record', 'mp_financial_movement', 'mp_reconciliation', 'mp_attribution_flag'].every((t) => C.forbidden_reads.includes(t)));

// actions
const sig = JSON.parse(owner(`SELECT json_object_agg(p.proname, json_build_object('args', pg_get_function_identity_arguments(p.oid),
  'auth', has_function_privilege('authenticated', p.oid, 'EXECUTE'), 'definer', p.prosecdef)) FROM pg_proc p
  WHERE p.pronamespace = 'public'::regnamespace AND p.proname IN (${[...Object.values(AUTHORIZED), ...SERVICE_ONLY, 'register_collection', 'mp_reconcile_movement'].map((n) => `'${n}'`).join(',')});`));
const wrongMap = C.actions.filter((a) => AUTHORIZED[a.id] !== a.rpc).map((a) => `${a.id}→${a.rpc}`);
check('K-4 every action maps to the authorized RPC of its contract id (C1, C3–C7, R1, R2, S5–S7)', wrongMap.length === 0, wrongMap.join(', '));
const badSig = C.actions.filter((a) => !sig[a.rpc] || sig[a.rpc].args !== a.args || sig[a.rpc].auth !== true || sig[a.rpc].definer !== true)
  .map((a) => `${a.rpc}: ${JSON.stringify(sig[a.rpc])}`);
check('K-5 every action RPC exists with the exact signature, is SECURITY DEFINER and executable by authenticated (ADMIN checked in-body)', badSig.length === 0, badSig.join(' | '));
check('K-6 the contract offers every authorized ADMIN action (completeness)', Object.keys(AUTHORIZED).every((id) => C.actions.some((a) => a.id === id)));
check('K-7 no action is register_collection, RPC 41 or a service-only RPC; those are listed as forbidden; the service-only RPCs are indeed not executable by authenticated',
  C.actions.every((a) => !C.forbidden_rpcs.includes(a.rpc)) && ['register_collection', 'mp_reconcile_movement', ...SERVICE_ONLY].every((r) => C.forbidden_rpcs.includes(r))
    && SERVICE_ONLY.every((r) => sig[r] && sig[r].auth === false) && !/register_collection/.test(JSON.stringify(C.actions)));
check('K-8 no direct table write: table_writes is empty and every action is an RPC', Array.isArray(C.table_writes) && C.table_writes.length === 0
  && C.actions.every((a) => typeof a.rpc === 'string' && a.rpc.startsWith('mp_')));
check('K-9 R2 is disabled while V-4 is unverified (mp_v4_verified() = false)', C.actions.find((a) => a.id === 'R2')?.availability === 'DISABLED_UNTIL_STEP_19'
  && owner('SELECT mp_v4_verified();') === 'f');

// D-14-1 identifier lookups (owner decision, option (a))
const EXPECTED_LOOKUPS = {
  'L-C3': { for_action: 'C3', table: 'mp_client_allocation', columns: ['id', 'cliente_id', 'amount', 'mode', 'effective_date'],
    predicate: { mp_financial_movement_id: ':selected_receipt', origin: 'ALLOCATION' }, rpc_param: 'p_allocation_id' },
  'L-C7': { for_action: 'C7', table: 'mp_payer_client_map', columns: ['id', 'mp_payer_id', 'cliente_id', 'created_at'],
    predicate: { activo: true }, rpc_param: 'p_mapping_id' },
  'L-S7': { for_action: 'S7', table: 'mp_webhook_delivery', columns: ['id', 'resource_id', 'received_at'],
    predicate: { topic_class: 'chargeback', status: 'SIGNAL_RECORDED', signal_resolution: null }, rpc_param: 'p_delivery_id' },
};
const SENSITIVE = /payload|manifest|body|header|signature|sha|key|token|secret|evidence|reason|lease|x_request|claim/i;
const L = C.lookups ?? [];
check('L-1 the three Step-10 views are the only state sources, and every screen read is one of them',
  JSON.stringify([...(C.state_sources ?? [])].sort()) === JSON.stringify([...VIEWS].sort()) && reads.every(([, r]) => C.state_sources.includes(r.view)));
check('L-2 exactly three lookup exceptions exist: L-C3 → mp_client_allocation, L-C7 → mp_payer_client_map, L-S7 → mp_webhook_delivery, one per action C3 / C7 / S7',
  L.length === 3 && L.every((l) => EXPECTED_LOOKUPS[l.id] && EXPECTED_LOOKUPS[l.id].table === l.table && EXPECTED_LOOKUPS[l.id].for_action === l.for_action),
  JSON.stringify(L.map((l) => `${l.id}:${l.table}:${l.for_action}`)));
check('L-3 every lookup is SELECT only', L.every((l) => l.operation === 'SELECT'));
const tcols = JSON.parse(owner(`SELECT json_object_agg(table_name, cols)::text FROM (SELECT table_name, json_agg(column_name::text) cols FROM information_schema.columns
  WHERE table_schema = 'public' AND table_name IN ('mp_client_allocation','mp_payer_client_map','mp_webhook_delivery') GROUP BY table_name) x;`));
check('L-4 lookup columns are explicitly allow-listed, minimal (exactly the approved set) and exist; predicate columns exist',
  L.every((l) => JSON.stringify(l.columns) === JSON.stringify(EXPECTED_LOOKUPS[l.id].columns) && l.columns.every((c) => tcols[l.table].includes(c))
    && Object.keys(l.predicate).every((c) => tcols[l.table].includes(c))), JSON.stringify(L.map((l) => l.columns)));
const s7 = L.find((l) => l.id === 'L-S7');
check('L-5 the S7 predicate is exactly the unresolved chargeback-signal predicate (topic_class chargeback, status SIGNAL_RECORDED, signal_resolution IS NULL)',
  s7 && JSON.stringify(s7.predicate) === JSON.stringify(EXPECTED_LOOKUPS['L-S7'].predicate)
    && JSON.stringify(L.find((l) => l.id === 'L-C3').predicate) === JSON.stringify(EXPECTED_LOOKUPS['L-C3'].predicate)
    && JSON.stringify(L.find((l) => l.id === 'L-C7').predicate) === JSON.stringify(EXPECTED_LOOKUPS['L-C7'].predicate));
check('L-6 no lookup exposes a raw / payload / manifest / header / signature / key / token / secret / evidence / reason field',
  L.every((l) => l.columns.every((c) => !SENSITIVE.test(c))), L.flatMap((l) => l.columns.filter((c) => SENSITIVE.test(c))).join());
const referenced = [...new Set([...reads.map(([, r]) => r.view), ...L.map((l) => l.table)].filter((t) => /^mp_|^report_mp_movement_status$/.test(t)))];
check('L-7 no other mp_* read is authorized: the only mp_* tables referenced are the three lookup tables; report_mp_movement_status stays forbidden',
  JSON.stringify(referenced.sort()) === JSON.stringify(['mp_client_allocation', 'mp_payer_client_map', 'mp_webhook_delivery'])
    && C.forbidden_reads.includes('report_mp_movement_status') && reads.every(([, r]) => !/^mp_/.test(r.view)), referenced.join());
check('L-8 each lookup yields exactly the identifier parameter of its action RPC',
  L.every((l) => l.rpc_param === EXPECTED_LOOKUPS[l.id].rpc_param && (sig[AUTHORIZED[l.for_action]]?.args ?? '').startsWith(`${l.rpc_param} uuid`)));
check('L-9 no grant or policy is needed: the ADMIN (authenticated) already holds SELECT on the three tables, under the unchanged Step-9 ACL (SELECT only)',
  owner(`SELECT string_agg(c.relname || ':' || a.privilege_type, ',' ORDER BY c.relname, a.privilege_type) FROM pg_class c, aclexplode(c.relacl) a
    WHERE c.relname IN ('mp_client_allocation','mp_payer_client_map','mp_webhook_delivery') AND a.grantee = 'authenticated'::regrole;`)
    === 'mp_client_allocation:SELECT,mp_payer_client_map:SELECT,mp_webhook_delivery:SELECT');
check('L-10 C3, C7 and S7 are ACTIVE; every other authorized action is unchanged (R2 disabled until Step 19)',
  ['C1', 'C3', 'C4', 'C5', 'C6', 'C7', 'R1', 'S5', 'S6', 'S7'].every((id) => C.actions.find((a) => a.id === id)?.availability === 'ACTIVE')
    && C.actions.length === 11);

// labels
const def = owner(`SELECT pg_get_viewdef('report_mp_receipt_status'::regclass, true);`);
const aStates = [...new Set([...def.matchAll(/THEN '(NORMALIZED|POSTED|REPORT_CONFIRMED|REVIEW_REQUIRED)'|ELSE '(NORMALIZED)'/g)].map((m) => m[1] ?? m[2]))].sort();
const reasons = [...new Set([...def.matchAll(/THEN '([A-Z_]+)'::text\s+ELSE NULL/g)].map((m) => m[1]))].sort();
const bStates = [...new Set([...def.matchAll(/'(CLIENT_[A-Z_]+)'/g)].map((m) => m[1]))].sort();
check('K-10 axis A labels cover exactly the states the view emits', JSON.stringify(Object.keys(C.axis_a_labels).sort()) === JSON.stringify(aStates), `${Object.keys(C.axis_a_labels)} vs ${aStates}`);
check('K-11 review-reason labels cover exactly the reasons the view emits', reasons.length > 0 && JSON.stringify(Object.keys(C.review_reason_labels).sort()) === JSON.stringify(reasons),
  `${Object.keys(C.review_reason_labels)} vs ${reasons}`);
check('K-12 axis B labels cover exactly the four attribution states, with the §6.4 wording (Sin cliente asignado / Asignación parcial / Cliente asignado)',
  JSON.stringify(Object.keys(C.axis_b_labels).sort()) === JSON.stringify(bStates) && bStates.length === 4
    && C.axis_b_labels.CLIENT_UNASSIGNED === 'Sin cliente asignado' && C.axis_b_labels.CLIENT_PARTIAL === 'Asignación parcial'
    && C.axis_b_labels.CLIENT_ASSIGNED === 'Cliente asignado' && /solicitad/i.test(C.axis_b_labels.CLIENT_RESOLUTION_REQUESTED), JSON.stringify(C.axis_b_labels));
check('K-13 no axis B label uses pendiente / conciliado / no conciliado / sin conciliar / error', Object.values(C.axis_b_labels).every((l) => !AXIS_B_FORBIDDEN.test(l)));
const clientUnassignedRow = DOC.split(/\r?\n/).find((l) => l.startsWith('| `CLIENT_UNASSIGNED` |')) ?? '';
check('K-14 the human-readable axis B table matches the block and marks CLIENT_UNASSIGNED as not a work item', clientUnassignedRow.includes('Sin cliente asignado')
  && /\|\s*no\s*\|\s*$/.test(clientUnassignedRow) && !AXIS_B_FORBIDDEN.test(clientUnassignedRow.replace(/no\s*\|\s*$/, '')));

// work items
const wi = C.work_items;
check('K-15 work items are exactly: axis A REVIEW_REQUIRED, axis B CLIENT_RESOLUTION_REQUESTED, open report exceptions, health review_required',
  wi.length === 4 && wi.some((w) => w.where.axis_a_state === 'REVIEW_REQUIRED') && wi.some((w) => w.where.axis_b_state === 'CLIENT_RESOLUTION_REQUESTED')
    && wi.some((w) => w.view === 'report_mp_report_exceptions') && wi.some((w) => w.where.review_required === true));
check('K-16 no client-attribution state other than CLIENT_RESOLUTION_REQUESTED produces a work item (CLIENT_UNASSIGNED / PARTIAL / ASSIGNED never)',
  !/CLIENT_(UNASSIGNED|PARTIAL|ASSIGNED)/.test(JSON.stringify(wi)));
check('K-17 no "pending identification balance" is defined anywhere in the block', !/pendiente de identificar|pending.identification|unidentified_balance/i.test(block[1]));

console.log(`\n  ══ ADR-006 FRONTEND CONTRACT (STEP 14) RESULT: ${pass} passed, ${fail} failed ══\n`);
if (fail) console.log(failures.map((f) => `   - ${f}`).join('\n'));
process.exit(fail === 0 ? 0 : 1);
