/**
 * Verification profile ADR018_POST_0079 — the exact database state after target migrations 0001…0079
 * (ADR-018 bank branch 0073–0077, MP release report VALIDATION 0078, MP NORMAL ingestion + report back-fill + coverage
 * view 0079). ADR018_POST_0077 / ADR018_POST_0078 keep their meaning and are not changed.
 *
 * Read-only: one SELECT returning a JSON document, evaluated here. Never prints a bank identifier and never reads report
 * content.
 *
 * Checks: A ledger 79 / last 0079 · B the 0078 and 0079 ledger rows equal the repository files (name + full sha256) ·
 * C the three MP report functions (capture, NORMAL ingestion, back-fill), single overloads; VALIDATION capture body
 * unchanged since 0078 · D SECURITY DEFINER inventory (app-definers.json + 7 ADR-018 + the hosted-platform definer) ·
 * E/F EXECUTE matrix (all three MP report functions: service_role only, no PUBLIC) · G bucket private / 10 MB /
 * pdf + csv, one ADMIN SELECT policy · H Mercado Pago database surface: the 29 pre-0079 mp_* functions unchanged (same
 * fingerprints as ADR018_POST_0078) + exactly one new mp_* function (mp_register_report_backfill); mp_register_delivery
 * still refuses report_backfill; mp_v4_verified() false; one cutover boundary · I exactly one cron job · J coverage view
 * fin_mp_report_activity (security_invoker, ADMIN filter, SELECT for authenticated only) · K the 0073–0077 objects.
 *
 * `deploymentCheck` (the 0079 deploy only, before the first real NORMAL run) additionally requires: zero NORMAL MP runs,
 * zero csv_import sources, zero report back-fills, and the G-4 VALIDATION evidence preserved (at least one VALIDATED MP
 * run, every MP run in VALIDATION mode, as many mp/ objects as distinct MP files).
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export const NAME = 'ADR018_POST_0079';
export const THROUGH = '0079';
const MIGRATIONS = ['0078_fin_mp_release_report_validation.sql', '0079_fin_mp_release_report_normal.sql'];

const FIN_TABLES = ['fin_import_run', 'fin_import_run_line', 'fin_statement_account_config', 'fin_statement_cutover', 'fin_statement_line', 'fin_statement_match'];
const SIG = '(uuid,text,text,text,text,text,bigint,date,date,jsonb,text,jsonb)';
const CAPTURE = `fin_capture_mp_release_report${SIG}`;
const INGEST = `fin_ingest_mp_release_report${SIG}`;
const BACKFILL = 'mp_register_report_backfill(uuid)';
const ADR018_DEFINERS = [
  CAPTURE, INGEST, BACKFILL,
  'fin_import_bank_statement(uuid,uuid,text,text,text,text,text,bigint,date,date,jsonb,uuid,text,jsonb)',
  'fin_match_statement_line(bigint,bigint,text)',
  'fin_resolve_statement_cutover(uuid,bigint,numeric,text,text)',
  'fin_reverse_statement_match(bigint,text)',
];
// the single hosted-platform definer accepted in public (Supabase "automatic RLS"; see provision-target.mjs)
const PLATFORM_DEFINERS = ['rls_auto_enable()'];
const EXEC = {   // anon | authenticated | service_role
  'fin_capture_mp_release_report': 'false|false|true',
  'fin_ingest_mp_release_report': 'false|false|true',
  'mp_register_report_backfill': 'false|false|true',
  'fin_import_bank_statement': 'false|false|true',
  'fin_match_statement_line': 'false|true|false',
  'fin_resolve_statement_cutover': 'false|true|false',
  'fin_reverse_statement_match': 'false|true|false',
};
const TABLE_GRANTS = [
  'fin_import_run:authenticated:SELECT', 'fin_import_run:service_role:SELECT', 'fin_import_run_line:authenticated:SELECT',
  'fin_mp_report_activity:authenticated:SELECT',
  'fin_statement_account_config:authenticated:SELECT', 'fin_statement_account_config:service_role:SELECT',
  'fin_statement_cutover:authenticated:SELECT', 'fin_statement_line:authenticated:SELECT', 'fin_statement_line_status:authenticated:SELECT',
  'fin_statement_match:authenticated:SELECT',
];
const BUCKET = 'financial-statements:false:10485760:application/pdf,text/csv';
// Mercado Pago database surface. The 29 functions that existed before 0079 keep EXACTLY the ADR018_POST_0078 fingerprints
// (bodies with CR removed — 0042 / 0046 were applied from CRLF bytes in production —, owner, settings, EXECUTE matrix);
// 0079 adds one mp_* function, mp_register_report_backfill, fingerprinted on its own.
const MP_PRE_0079 = 29;
const MP_BODY_FINGERPRINT_0078 = 'abc5c7066bcfbcd53ad42704a0b33472';
const MP_EXEC_FINGERPRINT_0078 = '8cea14fdbec23b0c69792f7db74319ec';
const BACKFILL_BODY_MD5 = '20861686d3620b2ebf0341ffc36e06d6';
// fin_capture_mp_release_report (VALIDATION, 0078): body md5 (CR removed) — must not change with NORMAL mode
const CAPTURE_BODY_MD5 = 'e680b9679cc9b465e97ed4ed6d731f16';
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

/** sha256 of a migration file text, computed exactly as the runners do (utf8 text). */
const shaOf = (repo, f) => createHash('sha256').update(readFileSync(join(repo, 'supabase', 'target-migrations', f), 'utf8')).digest('hex');
const MP_FP = (where) => `SELECT md5(string_agg(p.oid::regprocedure::text || ':' || prosecdef || ':' || pg_get_userbyid(proowner) || ':'
                     || coalesce(array_to_string(proconfig, ','), '') || ':' || md5(replace(prosrc, E'\\r', '')), ',' ORDER BY p.oid::regprocedure::text))
                   FROM pg_proc p WHERE pronamespace = 'public'::regnamespace AND ${where}`;
const MP_EXEC = (where) => `SELECT md5(string_agg(p.oid::regprocedure::text || ':' || has_function_privilege('anon', p.oid, 'EXECUTE')
                     || has_function_privilege('authenticated', p.oid, 'EXECUTE') || has_function_privilege('service_role', p.oid, 'EXECUTE'), ',' ORDER BY p.oid::regprocedure::text))
                   FROM pg_proc p WHERE pronamespace = 'public'::regnamespace AND ${where}`;
const PRE_0079 = "proname LIKE 'mp\\_%' AND proname <> 'mp_register_report_backfill'";

export function buildSql(repo) {
  const cfg = approvedConfigs(repo);
  const values = cfg.map((r) => `(${lit(r.nombre)}, ${lit(r.format)}, ${lit(r.account)}, ${lit(r.cbu)}, ${lit(r.extra)}::jsonb)`).join(', ');
  return `SELECT json_build_object(
  'ledger_count', (SELECT count(*) FROM migration_ledger.applied),
  'ledger_max', (SELECT max(version) FROM migration_ledger.applied),
  'ledger_new', (SELECT coalesce(json_agg(filename || '|' || sha256 ORDER BY version), '[]') FROM migration_ledger.applied WHERE version IN ('0078', '0079')),
  'fin_tables', (SELECT coalesce(json_agg(table_name ORDER BY table_name), '[]') FROM information_schema.tables
                  WHERE table_schema = 'public' AND table_type = 'BASE TABLE' AND table_name LIKE 'fin\\_%'),
  'views', (SELECT coalesce(json_agg(c.relname || ':' || coalesce(array_to_string(c.reloptions, ','), '') ORDER BY c.relname), '[]') FROM pg_class c
             WHERE c.relnamespace = 'public'::regnamespace AND c.relkind = 'v' AND c.relname IN ('fin_statement_line_status', 'fin_mp_report_activity')),
  'activity_admin_filter', (SELECT coalesce(pg_get_viewdef(to_regclass('public.fin_mp_report_activity')) ~ 'current_app_role\\(\\).*ADMIN', false)),
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
  'report_identities', (SELECT coalesce(json_agg(p.oid::regprocedure::text ORDER BY 1), '[]') FROM pg_proc p WHERE pronamespace = 'public'::regnamespace
                         AND proname IN ('fin_capture_mp_release_report', 'fin_ingest_mp_release_report', 'mp_register_report_backfill')),
  'report_public_exec', (SELECT count(*) FROM pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
                          WHERE pronamespace = 'public'::regnamespace AND a.grantee = 0
                            AND proname IN ('fin_capture_mp_release_report', 'fin_ingest_mp_release_report', 'mp_register_report_backfill')),
  'capture_body', (SELECT md5(replace(prosrc, E'\\r', '')) FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname = 'fin_capture_mp_release_report'),
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
  'mp_pre_count', (SELECT count(*) FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND ${PRE_0079}),
  'mp_pre_body_fp', (${MP_FP(PRE_0079)}),
  'mp_pre_exec_fp', (${MP_EXEC(PRE_0079)}),
  'mp_new', (SELECT coalesce(json_agg(p.oid::regprocedure::text ORDER BY 1), '[]') FROM pg_proc p WHERE pronamespace = 'public'::regnamespace
              AND proname LIKE 'mp\\_%' AND NOT (${PRE_0079.replace("proname LIKE 'mp\\_%' AND ", '')}) ),
  'backfill_body', (SELECT md5(replace(prosrc, E'\\r', '')) FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname = 'mp_register_report_backfill'),
  'register_refuses_backfill', (SELECT prosrc ~ 'origin must be webhook or chargeback_refresh' FROM pg_proc
                                 WHERE pronamespace = 'public'::regnamespace AND proname = 'mp_register_delivery'),
  'mp_v4', (SELECT mp_v4_verified()),
  'mp_boundary', (SELECT count(*) FROM mp_cutover_boundary),
  'cron', (SELECT coalesce(json_agg(jobname || '|' || schedule || '|' || active ORDER BY jobname), '[]') FROM cron.job),
  'evidence', json_build_object(
      'mp_runs', (SELECT count(*) FROM fin_import_run WHERE source_kind = 'MP_RELEASE_REPORT'),
      'mp_validated', (SELECT count(*) FROM fin_import_run WHERE source_kind = 'MP_RELEASE_REPORT' AND mode = 'VALIDATION' AND status = 'VALIDATED'),
      'mp_normal_runs', (SELECT count(*) FROM fin_import_run WHERE source_kind = 'MP_RELEASE_REPORT' AND mode = 'NORMAL'),
      'mp_files', (SELECT count(DISTINCT file_sha256) FROM fin_import_run WHERE source_kind = 'MP_RELEASE_REPORT'),
      'mp_objects', (SELECT count(*) FROM storage.objects WHERE bucket_id = 'financial-statements' AND name LIKE 'mp/%'),
      'csv_sources', (SELECT count(*) FROM mp_source_record WHERE source_type = 'csv_import'),
      'report_backfills', (SELECT count(*) FROM mp_webhook_delivery WHERE origin = 'report_backfill'))
)::text;`;
}

/** Evaluates the JSON result. Returns [{ label, ok, detail }]; details never contain bank identifiers or report content. */
export function evaluate(s, { repo, expectedLedger, deploymentCheck }) {
  const appDefiners = JSON.parse(readFileSync(join(repo, 'scripts', 'phase31', 'app-definers.json'), 'utf8')).identities.concat(ADR018_DEFINERS).sort();
  const out = [];
  const check = (label, ok, detail = '') => out.push({ label, ok: !!ok, detail });
  check(`A ledger ${expectedLedger} rows, last ${THROUGH}`, s.ledger_count === expectedLedger && s.ledger_max === THROUGH, `${s.ledger_count} / ${s.ledger_max}`);
  const want = MIGRATIONS.map((f) => `${f}|${shaOf(repo, f)}`);
  check('B ledger 0078 + 0079 = repository files (name + full sha256)', JSON.stringify(s.ledger_new) === JSON.stringify(want),
    s.ledger_new.map((x) => x.slice(0, 60)).join(' '));
  check('C capture / NORMAL ingestion / back-fill exist, single overloads', JSON.stringify(s.report_identities) === JSON.stringify([CAPTURE, INGEST, BACKFILL].sort()),
    s.report_identities.join(' '));
  check('C VALIDATION capture body unchanged since 0078', s.capture_body === CAPTURE_BODY_MD5, String(s.capture_body));
  const app = s.definers.filter((d) => !PLATFORM_DEFINERS.includes(d)).sort();
  const platform = s.definers.filter((d) => PLATFORM_DEFINERS.includes(d));
  check(`D SECURITY DEFINER: exactly the ${appDefiners.length} application identities (+ ${platform.length} hosted-platform; raw ${s.definers.length})`,
    JSON.stringify(app) === JSON.stringify(appDefiners),
    `missing=[${appDefiners.filter((d) => !app.includes(d)).join(' ')}] extra=[${app.filter((d) => !appDefiners.includes(d)).join(' ')}]`);
  check('E no application definer executable by anon', s.anon_definers === 0, String(s.anon_definers));
  check('F ADR-018 functions: definer, owner postgres, search_path=public, EXECUTE matrix (MP report functions: service_role only)',
    s.fin_function_overloads === 7 && Object.entries(EXEC).every(([f, m]) => s.fin_functions[f] === `true|postgres|true|${m}`), JSON.stringify(s.fin_functions));
  check('F MP report functions: no PUBLIC EXECUTE', s.report_public_exec === 0, String(s.report_public_exec));
  check('G bucket financial-statements private, 10 MB, application/pdf + text/csv', JSON.stringify(s.bucket) === JSON.stringify([BUCKET]), s.bucket.join(' '));
  check('G exactly one bucket policy: ADMIN SELECT for authenticated', JSON.stringify(s.bucket_policies) === JSON.stringify(['financial_statements_admin_select:SELECT:authenticated:true']),
    s.bucket_policies.join(' '));
  check(`H the ${MP_PRE_0079} pre-0079 Mercado Pago functions unchanged (same fingerprints as ADR018_POST_0078)`,
    s.mp_pre_count === MP_PRE_0079 && s.mp_pre_body_fp === MP_BODY_FINGERPRINT_0078 && s.mp_pre_exec_fp === MP_EXEC_FINGERPRINT_0078,
    `count=${s.mp_pre_count} body=${s.mp_pre_body_fp} exec=${s.mp_pre_exec_fp}`);
  check('H exactly one new mp_* function (mp_register_report_backfill), body as in 0079',
    JSON.stringify(s.mp_new) === JSON.stringify([BACKFILL]) && s.backfill_body === BACKFILL_BODY_MD5, `${s.mp_new.join(' ')} ${s.backfill_body}`);
  check('H mp_register_delivery still refuses report_backfill; mp_v4_verified() false; one MP cutover boundary',
    s.register_refuses_backfill === true && s.mp_v4 === false && s.mp_boundary === 1, `refuses=${s.register_refuses_backfill} v4=${s.mp_v4} boundary=${s.mp_boundary}`);
  check('I exactly one cron job (mp_worker_every_minute, every minute, active)', JSON.stringify(s.cron) === JSON.stringify(CRON), s.cron.join(' '));
  check('J views: fin_statement_line_status + fin_mp_report_activity, security_invoker, ADMIN filter',
    JSON.stringify(s.views) === JSON.stringify(['fin_mp_report_activity:security_invoker=true', 'fin_statement_line_status:security_invoker=true'])
      && s.activity_admin_filter === true, `${s.views.join(' ')} admin=${s.activity_admin_filter}`);
  check('K 6 ADR-018 tables', JSON.stringify(s.fin_tables) === JSON.stringify(FIN_TABLES), s.fin_tables.join(','));
  check('K 0077 guard present (resolve: conflict + account lock; match: account share lock)',
    s.guard_0077?.fin_resolve_statement_cutover === 'true|true|false' && s.guard_0077?.fin_match_statement_line === 'false|false|true', JSON.stringify(s.guard_0077));
  check('K table / view grants exact (SELECT only; anon none)', JSON.stringify(s.table_grants) === JSON.stringify(TABLE_GRANTS), s.table_grants.join(' '));
  check('K RLS on every ADR-018 table', s.rls_missing === 0, String(s.rls_missing));
  check('K exactly 2 active configurations, equal to the approved 0074 values', s.config_active === 2 && s.config_exact === true,
    `active=${s.config_active} exact=${s.config_exact}`);
  if (deploymentCheck) {
    const e = s.evidence;
    check('DEPLOYMENT CHECK: no NORMAL effect yet (0 NORMAL runs, 0 csv_import sources, 0 report back-fills)',
      e.mp_normal_runs === 0 && e.csv_sources === 0 && e.report_backfills === 0, JSON.stringify(e));
    check('DEPLOYMENT CHECK: G-4 VALIDATION evidence preserved (≥ 1 VALIDATED run, every MP run VALIDATION, one mp/ object per file)',
      e.mp_validated >= 1 && e.mp_runs === e.mp_validated + 0 && e.mp_objects === e.mp_files, JSON.stringify(e));
  }
  return out;
}
