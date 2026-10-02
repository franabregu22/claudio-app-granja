/**
 * PHASE 31 — cutover configuration contract (ADR-017 / D-PC-7 / clean-cutover scope).
 *
 * The real configuration holds owner-validated business values (cutover instant, opening balances,
 * category classes, population, operator assignments). It holds NO secret: the target connection comes
 * from the environment (CUTOVER_TARGET_DB_URL) and is never written to a file.
 * The real file lives OUTSIDE the repository (see PHASE_31_CUTOVER_RUNBOOK_V1.md §S1-1); the committed
 * CUTOVER_CONFIG_TEMPLATE.json is refused by the gates (REQUIRES_FINAL_CUTOVER_VALUE placeholders).
 *
 * cutoverGateFailures() returns every refusal; an empty list is required to run any cutover command.
 * The first block is the Phase 26 runner's gate list, carried verbatim (28 refusals on the rehearsal
 * config); the second block is the Phase 31 contract.
 */
export const MONEY_RE = /^-?[0-9]{1,13}(\.[0-9]{1,2})?$/;
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const TS_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}:\d{2})$/;
export const ACCOUNTS = ['BNA', 'Caja chica', 'Mercado Pago', 'Patagonia'];
export const TIMEZONE = 'America/Argentina/Buenos_Aires';

const TOP_KEYS = ['config_id', 'config_version', 'mode_allowed', 'description', 'source', 'target', 'import_batch', 'cutover_boundary', 'clients',
  'suppliers', 'instruments', 'treasury', 'population', 'flocks', 'users', 'auth', 'products', 'expense_categories', 'evidence_only_sources',
  'partially_used_sources', 'explicit_exclusions_inside_evidence', 'impuesto_cheque', 'cutover_gates'];
const SECTION_KEYS = {
  source: ['snapshot_id', 'snapshot_dir', 'manifest_sha256', 'legacy_copy_container', 'legacy_copy_database', 'source_system', 'notes'],
  target: ['kind', 'expected_host', 'expected_ref', 'forbidden_hosts', 'forbidden_refs', 'psql_client_container', 'staging_schema', 'notes'],
  cutover_boundary: ['cutover_at', 'timezone', 'evidence_ref', 'notes'],
  clients: ['migrate_master', 'opening_balance_method', 'evidence_ref', 'opening_balances', 'historical_pedidos_migrated', 'historical_pagos_migrated', 'notes'],
  treasury: ['account_map', 'opening_balance_method', 'evidence_ref', 'opening_balances', 'notes'],
  suppliers: ['opening_balances', 'outstanding_obligations', 'evidence_ref', 'notes'],
  instruments: ['open_instruments', 'excluded_test_rows', 'evidence_ref', 'notes'],
  population: ['method', 'owner_acceptance_ref', 'expected', 'expected_totals', 'counts', 'evidence_ref', 'rule', 'write_path', 'notes'],
  users: ['role_map', 'email_policy', 'migration_actor', 'operator_assignments', 'notes'],
  auth: ['required_identity_provider', 'allowed_extra_user_ids', 'evidence_ref', 'notes'],
  expense_categories: ['migrate_master', 'nombre_from', 'description_from', 'class_policy', 'class_map', 'class_map_evidence_ref', 'notes'],
};
const isObj = (o) => o !== null && typeof o === 'object' && !Array.isArray(o);
const ref = (v) => typeof v === 'string' && v.trim() !== '';

/** Phase 26 gate list — verbatim from scripts/phase26/migrate-clean-cutover.mjs cutoverGateFailures(). */
export function phase26GateFailures(cfg) {
  const f = [];
  const walk = (o, path) => {
    if (o && typeof o === 'object') for (const [k, v] of Object.entries(o)) {
      if (k === 'REHEARSAL_ONLY' && v === true) f.push(`REHEARSAL_ONLY=true at ${path || '(root)'}`);
      if (k === 'REQUIRES_FINAL_CUTOVER_VALUE' && v === true) f.push(`REQUIRES_FINAL_CUTOVER_VALUE=true at ${path}`);
      walk(v, path ? `${path}.${k}` : k);
    }
  };
  walk(cfg, '');
  if (cfg.mode_allowed !== 'CUTOVER') f.push('config.mode_allowed is not CUTOVER');
  if (cfg.users?.email_policy?.mode !== 'REAL') f.push('users.email_policy is not REAL (synthetic @example.invalid emails)');
  if (JSON.stringify(cfg).includes('@example.invalid')) f.push('@example.invalid present in config');
  if (cfg.clients?.opening_balance_method !== 'OWNER_VALIDATED' || !cfg.clients?.evidence_ref) f.push('client balances not OWNER_VALIDATED with evidence');
  if (cfg.treasury?.opening_balance_method !== 'OWNER_VALIDATED' || !cfg.treasury?.evidence_ref) f.push('treasury balances not OWNER_VALIDATED with evidence');
  if (cfg.population?.method === 'P-a' && !cfg.population?.owner_acceptance_ref) f.push('population P-a without owner acceptance reference');
  if (cfg.population?.method === 'P-b' && !cfg.population?.counts) f.push('population P-b without physical counts');
  if (cfg.cutover_boundary?.rehearsal_boundary_date) f.push('cutover boundary is still the rehearsal boundary');
  const ec = cfg.expense_categories || {};
  if (ec.class_policy === 'REHEARSAL_ALL_INDIRECT') f.push('expense_categories.class_policy is the REHEARSAL_ALL_INDIRECT placeholder');
  if (ec.class_policy !== 'OWNER_MAPPED' || !ec.class_map_evidence_ref || !ec.class_map || typeof ec.class_map !== 'object')
    f.push('expense_categories lack an OWNER_MAPPED DIRECT/INDIRECT class_map with evidence reference');
  else if (Object.values(ec.class_map).some((v) => !['DIRECT', 'INDIRECT'].includes(v)))
    f.push('expense_categories.class_map has a value other than DIRECT/INDIRECT');
  return f;
}

/** Phase 31 contract: shape, types and value domains (fail closed on missing, unknown or malformed values). */
export function phase31ContractFailures(cfg) {
  const f = [];
  if (!isObj(cfg)) return ['config is not a JSON object'];
  for (const k of Object.keys(cfg)) if (!TOP_KEYS.includes(k)) f.push(`unknown top-level key ${k}`);
  for (const [s, keys] of Object.entries(SECTION_KEYS)) {
    if (!isObj(cfg[s])) { f.push(`section ${s} is missing`); continue; }
    for (const k of Object.keys(cfg[s])) if (!keys.includes(k) && k !== 'REHEARSAL_ONLY' && k !== 'REQUIRES_FINAL_CUTOVER_VALUE') f.push(`unknown key ${s}.${k}`);
  }
  if (!ref(cfg.import_batch) || !/^P31-[A-Za-z0-9-]{4,60}$/.test(cfg.import_batch)) f.push('import_batch must match P31-<id>');
  // target
  const t = cfg.target || {};
  if (!['PRODUCTION_TARGET', 'LOCAL_CUTOVER_REHEARSAL'].includes(t.kind)) f.push('target.kind must be PRODUCTION_TARGET or LOCAL_CUTOVER_REHEARSAL');
  if (!ref(t.expected_host)) f.push('target.expected_host is required');
  if (!ref(t.psql_client_container)) f.push('target.psql_client_container is required');
  if (!Array.isArray(t.forbidden_hosts)) f.push('target.forbidden_hosts must be an array');
  if (t.kind === 'PRODUCTION_TARGET' && (!Array.isArray(t.forbidden_hosts) || t.forbidden_hosts.length === 0)) f.push('PRODUCTION_TARGET requires the legacy project host in target.forbidden_hosts');
  // Session-pooler hosts are shared across projects: PRODUCTION_TARGET is identified by its project ref as well
  if (t.kind === 'PRODUCTION_TARGET' && !/^[a-z0-9]{20}$/.test(t.expected_ref || '')) f.push('PRODUCTION_TARGET requires target.expected_ref (the 20-char target project ref)');
  if (t.kind === 'PRODUCTION_TARGET' && (!Array.isArray(t.forbidden_refs) || t.forbidden_refs.length === 0 || t.forbidden_refs.some((r) => !/^[a-z0-9]{20}$/.test(r))))
    f.push('PRODUCTION_TARGET requires target.forbidden_refs (the legacy project ref)');
  if (t.kind === 'PRODUCTION_TARGET' && Array.isArray(t.forbidden_refs) && t.forbidden_refs.includes(t.expected_ref)) f.push('target.expected_ref is a forbidden (legacy) ref');
  if (t.kind === 'PRODUCTION_TARGET' && Array.isArray(t.forbidden_hosts) && t.forbidden_hosts.includes(t.expected_host)) f.push('target.expected_host is a forbidden host');
  if (t.kind === 'PRODUCTION_TARGET' && ['127.0.0.1', 'localhost'].includes(t.expected_host)) f.push('PRODUCTION_TARGET cannot be a loopback host');
  if (t.kind === 'LOCAL_CUTOVER_REHEARSAL' && !['127.0.0.1', 'localhost'].includes(t.expected_host)) f.push('LOCAL_CUTOVER_REHEARSAL must be a loopback host');
  if (t.staging_schema !== 'phase26_migration') f.push('target.staging_schema must be phase26_migration (the validated lineage schema)');
  // source
  const s = cfg.source || {};
  if (!/^[0-9a-f]{64}$/.test(s.manifest_sha256 || '')) f.push('source.manifest_sha256 must be the 64-hex manifest hash of the final snapshot');
  if (!ref(s.snapshot_dir) || !ref(s.snapshot_id) || !ref(s.legacy_copy_container) || s.source_system !== 'legacy_supabase') f.push('source snapshot fields incomplete');
  // boundary
  const b = cfg.cutover_boundary || {};
  if (!TS_RE.test(b.cutover_at || '') || Number.isNaN(Date.parse(b.cutover_at))) f.push('cutover_boundary.cutover_at must be an explicit ISO-8601 timestamp with offset');
  if (b.timezone !== TIMEZONE) f.push(`cutover_boundary.timezone must be ${TIMEZONE}`);
  if (!ref(b.evidence_ref)) f.push('cutover_boundary.evidence_ref is required');
  // clients
  const c = cfg.clients || {};
  if (!isObj(c.opening_balances)) f.push('clients.opening_balances must be an object {client uuid: "amount"}');
  else for (const [id, v] of Object.entries(c.opening_balances)) {
    if (!UUID_RE.test(id)) f.push(`clients.opening_balances key ${id} is not a uuid`);
    if (typeof v !== 'string' || !MONEY_RE.test(v)) f.push(`clients.opening_balances[${id}] must be a decimal string with at most 2 decimals`);
  }
  if (c.historical_pedidos_migrated !== false || c.historical_pagos_migrated !== false) f.push('clients: historical pedidos / pagos must not be migrated (clean cutover)');
  // treasury
  const tr = cfg.treasury || {};
  if (!isObj(tr.opening_balances)) f.push('treasury.opening_balances must be an object');
  else {
    const keys = Object.keys(tr.opening_balances).sort();
    if (JSON.stringify(keys) !== JSON.stringify(ACCOUNTS)) f.push(`treasury.opening_balances must have exactly ${ACCOUNTS.join(', ')}`);
    for (const [k, v] of Object.entries(tr.opening_balances)) if (typeof v !== 'string' || !MONEY_RE.test(v)) f.push(`treasury.opening_balances[${k}] must be a decimal string`);
  }
  // suppliers / instruments: the clean cutover carries none; the owner confirms it with evidence
  if (cfg.suppliers?.opening_balances !== 'NONE' || cfg.suppliers?.outstanding_obligations !== 'NONE' || !ref(cfg.suppliers?.evidence_ref)) f.push('suppliers must be NONE / NONE with evidence_ref');
  if (cfg.instruments?.open_instruments !== 'NONE' || !ref(cfg.instruments?.evidence_ref)) f.push('instruments.open_instruments must be NONE with evidence_ref');
  // population
  const p = cfg.population || {};
  if (!['P-a', 'P-b'].includes(p.method)) f.push('population.method must be P-a or P-b');
  if (!isObj(p.expected) || !isObj(p.expected_totals)) f.push('population.expected / expected_totals (mortality arithmetic of the final snapshot) are required');
  if (p.method === 'P-b') {
    if (!isObj(p.counts) || !ref(p.evidence_ref)) f.push('population P-b requires counts {flock uuid: integer} and evidence_ref');
    else for (const [id, n] of Object.entries(p.counts)) if (!UUID_RE.test(id) || !Number.isInteger(n) || n < 0) f.push(`population.counts[${id}] must be a non-negative integer for a flock uuid`);
  }
  // users / auth
  const u = cfg.users || {};
  if (!isObj(u.role_map)) f.push('users.role_map is required');
  const oa = u.operator_assignments;
  if (!isObj(oa) || !Array.isArray(oa.assignments)) f.push('users.operator_assignments.assignments must be an explicit [{operator_id, flock_id}] list');
  else for (const a of oa.assignments) if (!UUID_RE.test(a?.operator_id || '') || !UUID_RE.test(a?.flock_id || '')) f.push('users.operator_assignments.assignments has a malformed entry');
  const au = cfg.auth || {};
  if (au.required_identity_provider !== 'email') f.push('auth.required_identity_provider must be "email" (email + password is the only V1 login)');
  if (!Array.isArray(au.allowed_extra_user_ids) || au.allowed_extra_user_ids.some((x) => !UUID_RE.test(x))) f.push('auth.allowed_extra_user_ids must be a uuid array (may be empty)');
  if (!ref(au.evidence_ref)) f.push('auth.evidence_ref (the Auth counts export reference) is required');
  // a production run never carries synthetic evidence
  if (t.kind === 'PRODUCTION_TARGET' && /"SYNTHETIC/i.test(JSON.stringify(cfg))) f.push('PRODUCTION_TARGET config carries a SYNTHETIC evidence reference');
  return f;
}

export function cutoverGateFailures(cfg) {
  return [...phase26GateFailures(cfg), ...phase31ContractFailures(cfg)];
}

/** Business date of the cutover instant in the frozen timezone. */
export function cutoverBusinessDate(iso) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(iso));
}
