/**
 * Verification profile ADR018_POST_0084 — the exact database state after target migrations 0001…0084
 * (… payout destination private storage 0083, payout own-account match 0084). ADR018_POST_0077 … _0083 keep their
 * meaning and are not changed. Differences from ADR018_POST_0083: ledger 84 with the 0084 row; table
 * financial_account_identifier (RLS with ONE policy — service_role SELECT —, SELECT for service_role only; seeded with
 * exactly the active configuration CBUs); definer fin_mp_payout_matches (STABLE, read-only, EXECUTE authenticated only);
 * everything else as POST_0083; the deployment check.
 *
 * Read-only: one SELECT returning a JSON document, evaluated here. Never prints a bank identifier and never reads report
 * content.
 *
 * Checks: A ledger 80 / last 0080 · B the 0078, 0079 and 0080 ledger rows equal the repository files (name + full sha256) ·
 * C the three MP report functions (capture, NORMAL ingestion, back-fill), single overloads; VALIDATION capture body
 * unchanged since 0080; NORMAL ingestion = 0081 · D SECURITY DEFINER inventory (app-definers.json + 8 ADR-018 + the
 * hosted-platform definer) ·
 * E/F EXECUTE matrix (all three MP report functions: service_role only, no PUBLIC) · G bucket private / 10 MB /
 * pdf + csv, one ADMIN SELECT policy · H Mercado Pago database surface: the 29 pre-0079 mp_* functions unchanged (same
 * fingerprints as ADR018_POST_0078) + exactly one new mp_* function (mp_register_report_backfill); mp_register_delivery
 * still refuses report_backfill; mp_v4_verified() false; one cutover boundary · I exactly two cron jobs (worker + daily report), both commands fingerprinted · J coverage view
 * fin_mp_report_activity (security_invoker, ADMIN filter, SELECT for authenticated only) · K the 0073–0077 objects ·
 * L the scheduler log: immutable trigger, the two SELECT policies, the recording function body · M the payout destination
 * storage (table, privacy, trigger, function body) · N the own-account identifiers (seed, privacy) and the read-only
 * match function (body, volatility, privileges).
 *
 * `deploymentCheck` (the 0084 deploy): the latest stored MP configuration has the 16 columns (PAYOUT_BANK_ACCOUNT_NUMBER
 * included); the three corpus payouts resolve, by the same rule as fin_mp_payout_matches (single destination, exact
 * active CBU), to 181533509871 → BNA, 183527567414 → BNA, 183984533002 → no own account; one mp/ object per MP file.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export const NAME = 'ADR018_POST_0084';
export const THROUGH = '0084';
const MIGRATIONS = ['0078_fin_mp_release_report_validation.sql', '0079_fin_mp_release_report_normal.sql', '0080_fin_mp_release_report_empty_days.sql',
  '0081_fin_mp_report_daily_support.sql', '0082_mp_report_daily_schedule.sql',
  '0083_fin_mp_payout_destination.sql', '0084_fin_mp_payout_own_account_match.sql'];

const FIN_TABLES = ['fin_import_run', 'fin_import_run_line', 'fin_mp_payout_destination', 'fin_mp_report_schedule_log', 'fin_statement_account_config', 'fin_statement_cutover', 'fin_statement_line', 'fin_statement_match'];
const SIG = '(uuid,text,text,text,text,text,bigint,date,date,jsonb,text,jsonb)';
const CAPTURE = `fin_capture_mp_release_report${SIG}`;
const INGEST = `fin_ingest_mp_release_report${SIG}`;
const BACKFILL = 'mp_register_report_backfill(uuid)';
const SCHEDULE = 'fin_record_mp_report_schedule(date,text,uuid,text,text,jsonb)';
const DESTINATIONS = 'fin_record_mp_payout_destinations(uuid,jsonb)';
const MATCHES = 'fin_mp_payout_matches(uuid)';
const ADR018_DEFINERS = [
  CAPTURE, INGEST, BACKFILL, SCHEDULE, DESTINATIONS, MATCHES,
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
  'fin_record_mp_report_schedule': 'false|false|true',
  'fin_record_mp_payout_destinations': 'false|false|true',
  'fin_mp_payout_matches': 'false|true|false',
  'fin_import_bank_statement': 'false|false|true',
  'fin_match_statement_line': 'false|true|false',
  'fin_resolve_statement_cutover': 'false|true|false',
  'fin_reverse_statement_match': 'false|true|false',
};
const TABLE_GRANTS = [
  'fin_import_run:authenticated:SELECT', 'fin_import_run:service_role:SELECT', 'fin_import_run_line:authenticated:SELECT',
  'fin_mp_payout_destination:service_role:SELECT',
  'fin_mp_report_activity:authenticated:SELECT',
  'fin_mp_report_schedule_log:authenticated:SELECT', 'fin_mp_report_schedule_log:service_role:SELECT',
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
// report function bodies (md5, CR removed): capture (VALIDATION) as in 0080; NORMAL ingestion as in 0081 (actor NULL
// accepted for the scheduler); the SECURITY INVOKER helper fin_mp_control_row_valid as in 0080; the 0081 recording function
const CAPTURE_BODY_MD5 = 'ba537f978db607841cbf1e7aeaa6ebcd';
const INGEST_BODY_MD5 = '676607433dcb030dcd4204afc80cb131';
const SCHEDULE_BODY_MD5 = 'a206b99d8ecce4f8a93bc6552007f23a';
const DESTINATION_BODY_MD5 = '6b1e6019a2e12ef16791c469d2a166c9';
const MATCHES_BODY_MD5 = 'b2e6df1cca0147a65449b54ae0f6ee82';
const CORPUS = '181533509871:BNA,183527567414:BNA,183984533002:NO_OWN_ACCOUNT_MATCH';
const SCHEDULE_POLICIES = ['fin_mp_schedule_admin_select:SELECT:public', 'fin_mp_schedule_service_select:SELECT:public'];
const CONTROL_HELPER = 'fin_mp_control_row_valid(jsonb)|false|i|postgres|falsefalsefalse|7c64e11a5036e1e4095eefdc0ed54491';
const CRON = ['mp_release_report_daily|0 10,14 * * *|true', 'mp_worker_every_minute|* * * * *|true'];
// the worker command as created by 0056 (md5 of the command text, CR removed)
const WORKER_COMMAND_MD5 = '9ce0ffaec511840d4ffd4bf95a68744f';

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
  'ledger_new', (SELECT coalesce(json_agg(filename || '|' || sha256 ORDER BY version), '[]') FROM migration_ledger.applied WHERE version IN ('0078', '0079', '0080', '0081', '0082', '0083', '0084')),
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
  'ingest_body', (SELECT md5(replace(prosrc, E'\\r', '')) FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname = 'fin_ingest_mp_release_report'),
  'control_helper', (SELECT coalesce(json_agg(p.oid::regprocedure::text || '|' || prosecdef || '|' || provolatile::text || '|' || pg_get_userbyid(proowner) || '|'
                       || has_function_privilege('anon', p.oid, 'EXECUTE') || has_function_privilege('authenticated', p.oid, 'EXECUTE')
                       || has_function_privilege('service_role', p.oid, 'EXECUTE') || '|' || md5(replace(prosrc, E'\\r', ''))), '[]')
                     FROM pg_proc p WHERE pronamespace = 'public'::regnamespace AND proname = 'fin_mp_control_row_valid'),
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
  'schedule_body', (SELECT md5(replace(prosrc, E'\\r', '')) FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname = 'fin_record_mp_report_schedule'),
  'schedule_immutable', (SELECT count(*) FROM pg_trigger WHERE tgrelid = to_regclass('public.fin_mp_report_schedule_log') AND NOT tgisinternal
                          AND tgname = 'trg_fin_mp_report_schedule_log_immutable' AND tgfoid = 'fin_evidence_immutable_guard'::regproc),
  'schedule_policies', (SELECT coalesce(json_agg(policyname || ':' || cmd || ':' || array_to_string(roles, ',') ORDER BY policyname), '[]')
                         FROM pg_policies WHERE schemaname = 'public' AND tablename = 'fin_mp_report_schedule_log'),
  'dest_rls', (SELECT relrowsecurity FROM pg_class WHERE oid = to_regclass('public.fin_mp_payout_destination')),
  'dest_policies', (SELECT coalesce(json_agg(policyname || ':' || cmd || ':' || coalesce(qual, '') ORDER BY policyname), '[]') FROM pg_policies
                     WHERE schemaname = 'public' AND tablename = 'fin_mp_payout_destination'),
  'dest_privileges', (SELECT has_table_privilege('anon', 'public.fin_mp_payout_destination', 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE') || ':'
                        || has_table_privilege('authenticated', 'public.fin_mp_payout_destination', 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE') || ':'
                        || has_table_privilege('service_role', 'public.fin_mp_payout_destination', 'SELECT') || ':'
                        || has_table_privilege('service_role', 'public.fin_mp_payout_destination', 'INSERT,UPDATE,DELETE,TRUNCATE')),
  'dest_immutable', (SELECT count(*) FROM pg_trigger WHERE tgrelid = to_regclass('public.fin_mp_payout_destination') AND NOT tgisinternal
                      AND tgname = 'trg_fin_mp_payout_destination_immutable' AND tgfoid = 'fin_evidence_immutable_guard'::regproc),
  'dest_body', (SELECT md5(replace(prosrc, E'\\r', '')) FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname = 'fin_record_mp_payout_destinations'),
  'identifier_table', (to_regclass('public.financial_account_identifier') IS NOT NULL),
  'fai_rls', (SELECT relrowsecurity FROM pg_class WHERE oid = to_regclass('public.financial_account_identifier')),
  'fai_policies', (SELECT coalesce(json_agg(policyname || ':' || cmd || ':' || coalesce(qual, '') ORDER BY policyname), '[]') FROM pg_policies
                    WHERE schemaname = 'public' AND tablename = 'financial_account_identifier'),
  'fai_privileges', (SELECT has_table_privilege('anon', 'public.financial_account_identifier', 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE') || ':'
                       || has_table_privilege('authenticated', 'public.financial_account_identifier', 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE') || ':'
                       || has_table_privilege('service_role', 'public.financial_account_identifier', 'SELECT') || ':'
                       || has_table_privilege('service_role', 'public.financial_account_identifier', 'INSERT,UPDATE,DELETE,TRUNCATE')),
  'fai_seed', (SELECT coalesce(json_agg(a.nombre || ':' || i.identifier_type || ':' || i.is_primary || ':' || i.active || ':'
                    || EXISTS (SELECT 1 FROM fin_statement_account_config c WHERE c.activo AND c.financial_account_id = i.financial_account_id AND c.expected_cbu::text = i.normalized_value)
                    ORDER BY a.nombre), '[]')
                 FROM financial_account_identifier i JOIN financial_account a ON a.id = i.financial_account_id),
  'matches_fn', (SELECT provolatile::text || ':' || md5(replace(prosrc, E'\\r', '')) FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname = 'fin_mp_payout_matches'),
  'mp_v4', (SELECT mp_v4_verified()),
  'mp_boundary', (SELECT count(*) FROM mp_cutover_boundary),
  'cron', (SELECT coalesce(json_agg(jobname || '|' || schedule || '|' || active ORDER BY jobname), '[]') FROM cron.job),
  'cron_commands', (SELECT coalesce(json_object_agg(jobname, md5(replace(command, E'\\r', ''))), '{}') FROM cron.job),
  'cron_owner', (SELECT coalesce(json_agg(DISTINCT username || '@' || database), '[]') FROM cron.job),
  'evidence', json_build_object(
      'mp_runs', (SELECT count(*) FROM fin_import_run WHERE source_kind = 'MP_RELEASE_REPORT'),
      'mp_validated', (SELECT count(*) FROM fin_import_run WHERE source_kind = 'MP_RELEASE_REPORT' AND mode = 'VALIDATION' AND status = 'VALIDATED'),
      'mp_normal_runs', (SELECT count(*) FROM fin_import_run WHERE source_kind = 'MP_RELEASE_REPORT' AND mode = 'NORMAL'),
      'mp_files', (SELECT count(DISTINCT file_sha256) FROM fin_import_run WHERE source_kind = 'MP_RELEASE_REPORT'),
      'mp_objects', (SELECT count(*) FROM storage.objects WHERE bucket_id = 'financial-statements' AND name LIKE 'mp/%'),
      'csv_sources', (SELECT count(*) FROM mp_source_record WHERE source_type = 'csv_import'),
      'report_backfills', (SELECT count(*) FROM mp_webhook_delivery WHERE origin = 'report_backfill'),
      'corpus', (WITH per AS (SELECT d.source_id, array_agg(DISTINCT d.normalized_value) AS v FROM fin_mp_payout_destination d
                               WHERE d.description = 'payout' AND d.source_id IN ('181533509871', '183527567414', '183984533002') GROUP BY 1)
                 SELECT string_agg(per.source_id || ':' || CASE WHEN cardinality(per.v) > 1 THEN 'DESTINATION_CONFLICT'
                          ELSE coalesce((SELECT a.nombre FROM financial_account_identifier i JOIN financial_account a ON a.id = i.financial_account_id
                                          WHERE i.active AND i.identifier_type IN ('CBU', 'CVU') AND i.normalized_value = per.v[1] LIMIT 1), 'NO_OWN_ACCOUNT_MATCH') END, ',' ORDER BY per.source_id)
                   FROM per),
      'destination_rows', (SELECT count(*) FROM fin_mp_payout_destination),
      'latest_config_columns', (SELECT jsonb_array_length(source_meta -> 'config' -> 'columns') FROM fin_import_run
                                 WHERE source_kind = 'MP_RELEASE_REPORT' AND source_meta ? 'config' ORDER BY created_at DESC LIMIT 1),
      'latest_config_has_destination', (SELECT (source_meta -> 'config' -> 'columns') ? 'PAYOUT_BANK_ACCOUNT_NUMBER' FROM fin_import_run
                                         WHERE source_kind = 'MP_RELEASE_REPORT' AND source_meta ? 'config' ORDER BY created_at DESC LIMIT 1),
      'files_with_destination_header', (SELECT count(*) FROM fin_import_run WHERE source_kind = 'MP_RELEASE_REPORT'
                                         AND (source_meta -> 'file' -> 'header') ? 'PAYOUT_BANK_ACCOUNT_NUMBER'))
)::text;`;
}

/** Evaluates the JSON result. Returns [{ label, ok, detail }]; details never contain bank identifiers or report content. */
export function evaluate(s, { repo, expectedLedger, deploymentCheck }) {
  const appDefiners = JSON.parse(readFileSync(join(repo, 'scripts', 'phase31', 'app-definers.json'), 'utf8')).identities.concat(ADR018_DEFINERS).sort();
  const out = [];
  const check = (label, ok, detail = '') => out.push({ label, ok: !!ok, detail });
  check(`A ledger ${expectedLedger} rows, last ${THROUGH}`, s.ledger_count === expectedLedger && s.ledger_max === THROUGH, `${s.ledger_count} / ${s.ledger_max}`);
  const want = MIGRATIONS.map((f) => `${f}|${shaOf(repo, f)}`);
  check('B ledger 0078 … 0084 = repository files (name + full sha256)', JSON.stringify(s.ledger_new) === JSON.stringify(want),
    s.ledger_new.map((x) => x.slice(0, 60)).join(' '));
  check('C capture / NORMAL ingestion / back-fill exist, single overloads', JSON.stringify(s.report_identities) === JSON.stringify([CAPTURE, INGEST, BACKFILL].sort()),
    s.report_identities.join(' '));
  check('C capture body = 0080, NORMAL ingestion body = 0081', s.capture_body === CAPTURE_BODY_MD5 && s.ingest_body === INGEST_BODY_MD5,
    `${s.capture_body} ${s.ingest_body}`);
  check('C helper fin_mp_control_row_valid(jsonb): INVOKER, IMMUTABLE, owner postgres, no application EXECUTE, body as in 0080',
    JSON.stringify(s.control_helper) === JSON.stringify([CONTROL_HELPER]), JSON.stringify(s.control_helper));
  const app = s.definers.filter((d) => !PLATFORM_DEFINERS.includes(d)).sort();
  const platform = s.definers.filter((d) => PLATFORM_DEFINERS.includes(d));
  check(`D SECURITY DEFINER: exactly the ${appDefiners.length} application identities (+ ${platform.length} hosted-platform; raw ${s.definers.length})`,
    JSON.stringify(app) === JSON.stringify(appDefiners),
    `missing=[${appDefiners.filter((d) => !app.includes(d)).join(' ')}] extra=[${app.filter((d) => !appDefiners.includes(d)).join(' ')}]`);
  check('E no application definer executable by anon', s.anon_definers === 0, String(s.anon_definers));
  check('F ADR-018 functions: definer, owner postgres, search_path=public, EXECUTE matrix (MP report functions: service_role only)',
    s.fin_function_overloads === 10 && Object.entries(EXEC).every(([f, m]) => s.fin_functions[f] === `true|postgres|true|${m}`), JSON.stringify(s.fin_functions));
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
  check('I exactly two cron jobs: mp_release_report_daily (0 10,14 * * *) + mp_worker_every_minute (* * * * *), both active, owner postgres@postgres',
    JSON.stringify(s.cron) === JSON.stringify(CRON) && JSON.stringify(s.cron_owner) === JSON.stringify(['postgres@postgres']), s.cron.join(' '));
  const dailyCmd = (() => { const f = readFileSync(join(repo, 'supabase', 'target-migrations', '0082_mp_report_daily_schedule.sql'), 'utf8').replace(/\r/g, '');
    const m = /\$job\$([\s\S]*?)\$job\$/.exec(f); return m ? createHash('md5').update(m[1]).digest('hex') : 'none'; })();
  check('I daily job command = the 0082 file; worker command unchanged since 0056',
    s.cron_commands?.mp_release_report_daily === dailyCmd && s.cron_commands?.mp_worker_every_minute === WORKER_COMMAND_MD5,
    `daily=${s.cron_commands?.mp_release_report_daily} want=${dailyCmd} worker=${s.cron_commands?.mp_worker_every_minute}`);
  check('J views: fin_statement_line_status + fin_mp_report_activity, security_invoker, ADMIN filter',
    JSON.stringify(s.views) === JSON.stringify(['fin_mp_report_activity:security_invoker=true', 'fin_statement_line_status:security_invoker=true'])
      && s.activity_admin_filter === true, `${s.views.join(' ')} admin=${s.activity_admin_filter}`);
  check(`K ${FIN_TABLES.length} ADR-018 tables`, JSON.stringify(s.fin_tables) === JSON.stringify(FIN_TABLES), s.fin_tables.join(','));
  check('K 0077 guard present (resolve: conflict + account lock; match: account share lock)',
    s.guard_0077?.fin_resolve_statement_cutover === 'true|true|false' && s.guard_0077?.fin_match_statement_line === 'false|false|true', JSON.stringify(s.guard_0077));
  check('K table / view grants exact (SELECT only; anon none)', JSON.stringify(s.table_grants) === JSON.stringify(TABLE_GRANTS), s.table_grants.join(' '));
  check('K RLS on every ADR-018 table', s.rls_missing === 0, String(s.rls_missing));
  check('K exactly 2 active configurations, equal to the approved 0074 values', s.config_active === 2 && s.config_exact === true,
    `active=${s.config_active} exact=${s.config_exact}`);
  check('L scheduler log: immutable trigger, ADMIN + service_role SELECT policies; recording function body as in 0081',
    s.schedule_immutable === 1 && JSON.stringify(s.schedule_policies) === JSON.stringify(SCHEDULE_POLICIES) && s.schedule_body === SCHEDULE_BODY_MD5,
    `immutable=${s.schedule_immutable} policies=${s.schedule_policies.join(' ')} body=${s.schedule_body}`);
  check('M fin_mp_payout_destination: RLS on, ONE policy (service_role SELECT), no access for anon / authenticated (ADMIN included), service_role SELECT only, immutable',
    s.dest_rls === true && JSON.stringify(s.dest_policies) === JSON.stringify(["fin_mp_payout_destination_service_select:SELECT:(auth.role() = 'service_role'::text)"])
      && s.dest_privileges === 'false:false:true:false' && s.dest_immutable === 1,
    `rls=${s.dest_rls} policies=${JSON.stringify(s.dest_policies)} privileges=${s.dest_privileges} immutable=${s.dest_immutable}`);
  check('M fin_record_mp_payout_destinations body as in 0083', s.dest_body === DESTINATION_BODY_MD5, `body=${s.dest_body}`);
  check('N financial_account_identifier: RLS on, ONE policy (service_role SELECT), no access for anon / authenticated (ADMIN included), service_role SELECT only',
    s.identifier_table === true && s.fai_rls === true && s.fai_privileges === 'false:false:true:false'
      && JSON.stringify(s.fai_policies) === JSON.stringify(["financial_account_identifier_service_select:SELECT:(auth.role() = 'service_role'::text)"]),
    `rls=${s.fai_rls} policies=${JSON.stringify(s.fai_policies)} privileges=${s.fai_privileges}`);
  check('N seed = exactly the active configuration CBUs (BNA, Patagonia), primary, active', JSON.stringify(s.fai_seed) === JSON.stringify(['BNA:CBU:true:true:true', 'Patagonia:CBU:true:true:true']),
    JSON.stringify(s.fai_seed));
  check('N fin_mp_payout_matches: STABLE, body as in 0084', s.matches_fn === `s:${MATCHES_BODY_MD5}`, String(s.matches_fn));
  if (deploymentCheck) {
    const e = s.evidence;
    check('DEPLOYMENT CHECK: latest stored MP config = 16 columns with PAYOUT_BANK_ACCOUNT_NUMBER; corpus 05/10 → BNA, 10/10 → BNA, 13/10 → no own account; one mp/ object per MP file',
      e.latest_config_columns === 16 && e.latest_config_has_destination === true && e.corpus === CORPUS && e.mp_objects === e.mp_files,
      JSON.stringify({ ...e, corpus: e.corpus }));
  }
  return out;
}
