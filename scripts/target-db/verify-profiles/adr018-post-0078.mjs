/**
 * Verification profile ADR018_POST_0078 — the exact database state after target migrations 0001…0078
 * (ADR-018 bank branch 0073–0077 + MP release report capture, VALIDATION mode only, 0078).
 * ADR018_POST_0077 keeps its meaning (the state before 0078) and is not changed.
 *
 * Read-only: one SELECT returning a JSON document, evaluated here. Never prints a bank identifier (the two configured
 * accounts are compared server-side against the literal values of migration 0074; only a boolean comes back) and never
 * reads report content.
 *
 * Checks: A ledger 78 / last 0078 · B the 0078 ledger row equals the repository file (name + full sha256) · C the
 * capture function, single overload · D SECURITY DEFINER inventory (app-definers.json + 5 ADR-018 + the hosted-platform
 * definer) · E/F EXECUTE matrix (capture: service_role only, no PUBLIC) · G bucket private / 10 MB / pdf + csv, one
 * ADMIN SELECT policy · H Mercado Pago database invariants unchanged (the 29 mp_* functions: bodies, owner, settings,
 * EXECUTE matrix; mp_v4_verified() false; one cutover boundary) · I exactly one cron job · J validation produced no
 * MP / financial effect (no csv_import source, no report back-fill, no MP appearance with a destination, MP runs are
 * VALIDATION only) · K the 0073–0077 objects (tables, view, grants, RLS, K-1 configuration, 0077 guard).
 *
 * `deploymentCheck` (the 0078 deploy only) additionally requires zero MP_RELEASE_REPORT runs and zero mp/ objects.
 * It must not be used once the first real validation capture exists.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export const NAME = 'ADR018_POST_0078';
export const THROUGH = '0078';
const MIGRATION_0078 = '0078_fin_mp_release_report_validation.sql';

const FIN_TABLES = ['fin_import_run', 'fin_import_run_line', 'fin_statement_account_config', 'fin_statement_cutover', 'fin_statement_line', 'fin_statement_match'];
const CAPTURE = 'fin_capture_mp_release_report(uuid,text,text,text,text,text,bigint,date,date,jsonb,text,jsonb)';
const FIN_DEFINERS = [
  CAPTURE,
  'fin_import_bank_statement(uuid,uuid,text,text,text,text,text,bigint,date,date,jsonb,uuid,text,jsonb)',
  'fin_match_statement_line(bigint,bigint,text)',
  'fin_resolve_statement_cutover(uuid,bigint,numeric,text,text)',
  'fin_reverse_statement_match(bigint,text)',
];
// the single hosted-platform definer accepted in public (Supabase "automatic RLS"; see provision-target.mjs)
const PLATFORM_DEFINERS = ['rls_auto_enable()'];
const EXEC = {   // anon | authenticated | service_role
  'fin_capture_mp_release_report': 'false|false|true',
  'fin_import_bank_statement': 'false|false|true',
  'fin_match_statement_line': 'false|true|false',
  'fin_resolve_statement_cutover': 'false|true|false',
  'fin_reverse_statement_match': 'false|true|false',
};
const TABLE_GRANTS = [
  'fin_import_run:authenticated:SELECT', 'fin_import_run:service_role:SELECT', 'fin_import_run_line:authenticated:SELECT',
  'fin_statement_account_config:authenticated:SELECT', 'fin_statement_account_config:service_role:SELECT',
  'fin_statement_cutover:authenticated:SELECT', 'fin_statement_line:authenticated:SELECT', 'fin_statement_line_status:authenticated:SELECT',
  'fin_statement_match:authenticated:SELECT',
];
const BUCKET = 'financial-statements:false:10485760:application/pdf,text/csv';
// Mercado Pago database surface after 0071 (unchanged by 0073–0078): 29 public mp_* functions. The fingerprints hash, per
// function identity, (SECURITY DEFINER, owner, settings, md5 of the body with CR removed — 0042 / 0046 were applied from CRLF
// bytes in production) and the anon / authenticated / service_role EXECUTE matrix.
const MP_FUNCTIONS = 29;
const MP_BODY_FINGERPRINT = 'abc5c7066bcfbcd53ad42704a0b33472';
const MP_EXEC_FINGERPRINT = '8cea14fdbec23b0c69792f7db74319ec';
const CRON = ['mp_worker_every_minute|* * * * *|true'];

const lit = (s) => `'${String(s).replace(/'/g, "''")}'`;

/** The two approved (K-1) configuration rows, read from migration 0074 itself — never typed elsewhere. */
function approvedConfigs(repo) {
  const sql = readFileSync(join(repo, 'supabase', 'target-migrations', '0074_fin_statement_privileges_storage.sql'), 'utf8');
  const re = /SELECT id, '([A-Z0-9_]+)', '([^']+)', '([^']+)', '([^']*)'::jsonb\s+FROM financial_account WHERE nombre = '([^']+)' AND account_type = 'BANK_ACCOUNT'/g;
  const rows = [...sql.matchAll(re)].map((m) => ({ format: m[1], account: m[2], cbu: m[3], extra: m[4], nombre: m[5] }));
  if (rows.length !== 2) throw new Error(`profile ${NAME}: expected 2 configuration rows in 0074, found ${rows.length}`);
  return rows;
}

/** sha256 of the 0078 file text, computed exactly as the runners do (utf8 text). */
const sha0078 = (repo) => createHash('sha256').update(readFileSync(join(repo, 'supabase', 'target-migrations', MIGRATION_0078), 'utf8')).digest('hex');

export function buildSql(repo) {
  const cfg = approvedConfigs(repo);
  const values = cfg.map((r) => `(${lit(r.nombre)}, ${lit(r.format)}, ${lit(r.account)}, ${lit(r.cbu)}, ${lit(r.extra)}::jsonb)`).join(', ');
  return `SELECT json_build_object(
  'ledger_count', (SELECT count(*) FROM migration_ledger.applied),
  'ledger_max', (SELECT max(version) FROM migration_ledger.applied),
  'ledger_0078', (SELECT coalesce(json_agg(filename || '|' || sha256), '[]') FROM migration_ledger.applied WHERE version = '0078'),
  'fin_tables', (SELECT coalesce(json_agg(table_name ORDER BY table_name), '[]') FROM information_schema.tables
                  WHERE table_schema = 'public' AND table_type = 'BASE TABLE' AND table_name LIKE 'fin\\_%'),
  'view', to_regclass('public.fin_statement_line_status') IS NOT NULL,
  'definers', (SELECT coalesce(json_agg(p.oid::regprocedure::text ORDER BY 1), '[]') FROM pg_proc p WHERE pronamespace = 'public'::regnamespace AND prosecdef),
  'anon_definers', (SELECT count(*) FROM pg_proc p WHERE pronamespace = 'public'::regnamespace AND prosecdef
                     AND p.oid::regprocedure::text <> ALL (ARRAY[${PLATFORM_DEFINERS.map(lit).join(', ')}]::text[])
                     AND has_function_privilege('anon', p.oid, 'EXECUTE')),
  'fin_functions', (SELECT coalesce(json_object_agg(proname, prosecdef || '|' || pg_get_userbyid(proowner) || '|'
                        || (coalesce(proconfig, '{}') @> ARRAY['search_path=public']) || '|'
                        || has_function_privilege('anon', p.oid, 'EXECUTE') || '|' || has_function_privilege('authenticated', p.oid, 'EXECUTE')
                        || '|' || has_function_privilege('service_role', p.oid, 'EXECUTE')), '{}')
                     FROM pg_proc p WHERE pronamespace = 'public'::regnamespace AND proname IN (${Object.keys(EXEC).map(lit).join(', ')})),
  'fin_function_overloads', (SELECT count(*) FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname IN (${Object.keys(EXEC).map(lit).join(', ')})),
  'capture_identity', (SELECT coalesce(json_agg(p.oid::regprocedure::text), '[]') FROM pg_proc p
                        WHERE pronamespace = 'public'::regnamespace AND proname = 'fin_capture_mp_release_report'),
  'capture_public_exec', (SELECT count(*) FROM pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
                           WHERE pronamespace = 'public'::regnamespace AND proname = 'fin_capture_mp_release_report' AND a.grantee = 0),
  'guard_0077', (SELECT json_object_agg(proname,
                    (prosrc ~ 'RAISE EXCEPTION ''CUTOVER_ACTIVE_MATCH_CONFLICT')::text || '|'
                 || (prosrc ~ 'FROM financial_account WHERE id = p_account_id FOR NO KEY UPDATE')::text || '|'
                 || (prosrc ~ 'FROM financial_account WHERE id = v_line\\.financial_account_id FOR SHARE')::text)
                 FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname IN ('fin_match_statement_line', 'fin_resolve_statement_cutover')),
  'table_grants', (SELECT coalesce(json_agg(g ORDER BY g), '[]') FROM (
                    SELECT table_name || ':' || grantee || ':' || string_agg(privilege_type, '+' ORDER BY privilege_type) AS g
                      FROM information_schema.role_table_grants
                     WHERE table_schema = 'public' AND table_name LIKE 'fin\\_%' AND grantee IN ('anon', 'authenticated', 'service_role', 'PUBLIC')
                     GROUP BY table_name, grantee) x),
  'rls_missing', (SELECT count(*) FROM pg_class c WHERE c.relnamespace = 'public'::regnamespace AND c.relkind = 'r'
                   AND c.relname LIKE 'fin\\_%' AND NOT c.relrowsecurity),
  'config_active', (SELECT count(*) FROM fin_statement_account_config WHERE activo),
  'config_exact', (WITH want(nombre, format_code, acct, cbu, extra) AS (VALUES ${values}),
                        have AS (SELECT a.nombre, c.format_code::text, c.expected_account_number::text, c.expected_cbu::text, c.expected_extra
                                   FROM fin_statement_account_config c JOIN financial_account a ON a.id = c.financial_account_id
                                  WHERE c.activo AND a.account_type = 'BANK_ACCOUNT' AND a.activo)
                   SELECT NOT EXISTS (SELECT * FROM want EXCEPT SELECT * FROM have) AND NOT EXISTS (SELECT * FROM have EXCEPT SELECT * FROM want)),
  'bucket', (SELECT coalesce(json_agg(id || ':' || public || ':' || file_size_limit || ':' || array_to_string(allowed_mime_types, ',')), '[]')
              FROM storage.buckets WHERE id = 'financial-statements'),
  'bucket_policies', (SELECT coalesce(json_agg(policyname || ':' || cmd || ':' || array_to_string(roles, ',') || ':'
                          || (qual ~ 'current_app_role\\(\\) = ''ADMIN''')::text ORDER BY policyname), '[]')
                       FROM pg_policies WHERE schemaname = 'storage' AND (qual ~ 'financial-statements' OR with_check ~ 'financial-statements')),
  'mp_functions', (SELECT count(*) FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname LIKE 'mp\\_%'),
  'mp_body_fp', (SELECT md5(string_agg(p.oid::regprocedure::text || ':' || prosecdef || ':' || pg_get_userbyid(proowner) || ':'
                     || coalesce(array_to_string(proconfig, ','), '') || ':' || md5(replace(prosrc, E'\\r', '')), ',' ORDER BY p.oid::regprocedure::text))
                   FROM pg_proc p WHERE pronamespace = 'public'::regnamespace AND proname LIKE 'mp\\_%'),
  'mp_exec_fp', (SELECT md5(string_agg(p.oid::regprocedure::text || ':' || has_function_privilege('anon', p.oid, 'EXECUTE')
                     || has_function_privilege('authenticated', p.oid, 'EXECUTE') || has_function_privilege('service_role', p.oid, 'EXECUTE'), ',' ORDER BY p.oid::regprocedure::text))
                   FROM pg_proc p WHERE pronamespace = 'public'::regnamespace AND proname LIKE 'mp\\_%'),
  'mp_v4', (SELECT mp_v4_verified()),
  'mp_boundary', (SELECT count(*) FROM mp_cutover_boundary),
  'cron', (SELECT coalesce(json_agg(jobname || '|' || schedule || '|' || active ORDER BY jobname), '[]') FROM cron.job),
  'no_effect', json_build_object(
      'csv_sources', (SELECT count(*) FROM mp_source_record WHERE source_type = 'csv_import'),
      'report_backfills', (SELECT count(*) FROM mp_webhook_delivery WHERE origin = 'report_backfill'),
      'mp_appearances_with_destination', (SELECT count(*) FROM fin_import_run_line WHERE source_kind = 'MP_RELEASE_REPORT'
                                            AND (mp_source_record_id IS NOT NULL OR statement_line_id IS NOT NULL)),
      'mp_normal_runs', (SELECT count(*) FROM fin_import_run WHERE source_kind = 'MP_RELEASE_REPORT' AND mode <> 'VALIDATION')),
  'evidence', json_build_object(
      'bank_runs', (SELECT count(*) FROM fin_import_run WHERE source_kind = 'BANK_STATEMENT'),
      'bank_appearances', (SELECT count(*) FROM fin_import_run_line WHERE source_kind = 'BANK_STATEMENT'),
      'lines', (SELECT count(*) FROM fin_statement_line), 'matches', (SELECT count(*) FROM fin_statement_match),
      'cuts', (SELECT count(*) FROM fin_statement_cutover),
      'mp_runs', (SELECT count(*) FROM fin_import_run WHERE source_kind = 'MP_RELEASE_REPORT'),
      'mp_appearances', (SELECT count(*) FROM fin_import_run_line WHERE source_kind = 'MP_RELEASE_REPORT'),
      'bank_objects', (SELECT count(*) FROM storage.objects WHERE bucket_id = 'financial-statements' AND name LIKE 'bank/%'),
      'mp_objects', (SELECT count(*) FROM storage.objects WHERE bucket_id = 'financial-statements' AND name LIKE 'mp/%'))
)::text;`;
}

/** Evaluates the JSON result. Returns [{ label, ok, detail }]; details never contain bank identifiers or report content. */
export function evaluate(s, { repo, expectedLedger, deploymentCheck }) {
  const appDefiners = JSON.parse(readFileSync(join(repo, 'scripts', 'phase31', 'app-definers.json'), 'utf8')).identities.concat(FIN_DEFINERS).sort();
  const out = [];
  const check = (label, ok, detail = '') => out.push({ label, ok: !!ok, detail });
  check(`A ledger ${expectedLedger} rows, last ${THROUGH}`, s.ledger_count === expectedLedger && s.ledger_max === THROUGH, `${s.ledger_count} / ${s.ledger_max}`);
  const want0078 = `${MIGRATION_0078}|${sha0078(repo)}`;
  check('B ledger 0078 = repository file (name + full sha256)', JSON.stringify(s.ledger_0078) === JSON.stringify([want0078]),
    `${(s.ledger_0078[0] ?? 'absent').slice(0, 60)} vs ${want0078.slice(0, 60)}`);
  check('C fin_capture_mp_release_report exists, single overload', JSON.stringify(s.capture_identity) === JSON.stringify([CAPTURE]), s.capture_identity.join(' '));
  const app = s.definers.filter((d) => !PLATFORM_DEFINERS.includes(d)).sort();
  const platform = s.definers.filter((d) => PLATFORM_DEFINERS.includes(d));
  check(`D SECURITY DEFINER: exactly the ${appDefiners.length} application identities (+ ${platform.length} hosted-platform; raw ${s.definers.length})`,
    JSON.stringify(app) === JSON.stringify(appDefiners),
    `missing=[${appDefiners.filter((d) => !app.includes(d)).join(' ')}] extra=[${app.filter((d) => !appDefiners.includes(d)).join(' ')}]`);
  check('E no application definer executable by anon', s.anon_definers === 0, String(s.anon_definers));
  check('F ADR-018 functions: definer, owner postgres, search_path=public, EXECUTE matrix (capture: service_role only)',
    s.fin_function_overloads === 5 && Object.entries(EXEC).every(([f, m]) => s.fin_functions[f] === `true|postgres|true|${m}`), JSON.stringify(s.fin_functions));
  check('F capture: no PUBLIC EXECUTE', s.capture_public_exec === 0, String(s.capture_public_exec));
  check('G bucket financial-statements private, 10 MB, application/pdf + text/csv', JSON.stringify(s.bucket) === JSON.stringify([BUCKET]), s.bucket.join(' '));
  check('G exactly one bucket policy: ADMIN SELECT for authenticated', JSON.stringify(s.bucket_policies) === JSON.stringify(['financial_statements_admin_select:SELECT:authenticated:true']),
    s.bucket_policies.join(' '));
  check(`H Mercado Pago functions unchanged (${MP_FUNCTIONS}: bodies / owner / settings / EXECUTE)`,
    s.mp_functions === MP_FUNCTIONS && s.mp_body_fp === MP_BODY_FINGERPRINT && s.mp_exec_fp === MP_EXEC_FINGERPRINT,
    `count=${s.mp_functions} body=${s.mp_body_fp} exec=${s.mp_exec_fp}`);
  check('H mp_v4_verified() false, one MP cutover boundary', s.mp_v4 === false && s.mp_boundary === 1, `v4=${s.mp_v4} boundary=${s.mp_boundary}`);
  check('I exactly one cron job (mp_worker_every_minute, every minute, active)', JSON.stringify(s.cron) === JSON.stringify(CRON), s.cron.join(' '));
  const n = s.no_effect;
  check('J no MP / financial effect from report capture (csv sources, report back-fills, MP destinations, MP NORMAL runs = 0)',
    n.csv_sources === 0 && n.report_backfills === 0 && n.mp_appearances_with_destination === 0 && n.mp_normal_runs === 0, JSON.stringify(n));
  check('K 6 ADR-018 tables + view fin_statement_line_status', JSON.stringify(s.fin_tables) === JSON.stringify(FIN_TABLES) && s.view === true, s.fin_tables.join(','));
  check('K 0077 guard present (resolve: conflict + account lock; match: account share lock)',
    s.guard_0077?.fin_resolve_statement_cutover === 'true|true|false' && s.guard_0077?.fin_match_statement_line === 'false|false|true', JSON.stringify(s.guard_0077));
  check('K table grants exact (SELECT only; anon none)', JSON.stringify(s.table_grants) === JSON.stringify(TABLE_GRANTS), s.table_grants.join(' '));
  check('K RLS on every ADR-018 table', s.rls_missing === 0, String(s.rls_missing));
  check('K exactly 2 active configurations, equal to the approved 0074 values', s.config_active === 2 && s.config_exact === true,
    `active=${s.config_active} exact=${s.config_exact}`);
  if (deploymentCheck) {
    const e = s.evidence;
    check('DEPLOYMENT CHECK: zero MP report runs, appearances and mp/ objects', e.mp_runs === 0 && e.mp_appearances === 0 && e.mp_objects === 0, JSON.stringify(e));
  }
  return out;
}
