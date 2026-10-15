/**
 * Verification profile ADR018_POST_0090 — the exact database state after target migrations 0001…0090
 * (0090, ADR-020: Mercado Pago outbound payments classifiable — transition OUTBOUND, mp_outflow_resolve / mp_outflow_apply_charges
 * (INVOKER), register_casual_purchase / mp_classify_payout_outflow resolve payouts or outbound payments with the tax apart,
 * activity view classifies outbound rows). Derived from ADR018_POST_0089, whose text follows:
 *
 * Verification profile ADR018_POST_0089 — the exact database state after target migrations 0001…0089
 * (0089: mp_inflow_classification; mp_classify_payout_outflow (Compra / gasto: EXPENSE / SUPPLIER_PAYMENT / CASUAL_PURCHASE
 * through register_casual_purchase; Retiro de socios) and mp_classify_inflow_as_collection, both ADMIN, identifiers only;
 * fin_mp_report_activity: CLASSIFIED_OUTFLOW + appended classification columns; no pre-0079 Mercado Pago function changes).
 * Derived from ADR018_POST_0088, whose text follows:
 *
 * Verification profile ADR018_POST_0088 — the exact database state after target migrations 0001…0088
 * (0088, ADR-019: casual purchases — purchases.supplier_id nullable, counterparty_name, paid_operation_id, PURCHASE_PAYMENT;
 * fiscal_document issuer CUIT / name; register_casual_purchase + rectify_casual_purchase_classification (ADMIN); RPC 14
 * casual branch; RPC 34 delegating to fiscal_document_insert; mp_outflow_classification + mp_payout_outflow_resolve).
 * Derived from ADR018_POST_0087, whose text follows:
 *
 * Verification profile ADR018_POST_0087 — the exact database state after target migrations 0001…0087
 * (0087: mp_payout_transfer_confirmation + mp_confirm_payout_transfer (ADMIN, SOURCE_ID only): an OWN_ACCOUNT_EXACT payout
 * confirmed as ONE TRANSFER MP → own account; fin_mp_report_activity shows a confirmed payout as OWN_TRANSFER; no pre-0079
 * Mercado Pago function changes). Derived from ADR018_POST_0086, whose text follows:
 *
 * Verification profile ADR018_POST_0086 — the exact database state after target migrations 0001…0086
 * (0086: mp_inbound_reclassification + mp_reclassify_inbound_own_transfer (ADMIN) + the client-allocation guard trigger;
 * mp_is_auto_applicable no longer auto-applies account_fund + debin_transfer — the pre-0079 MP body fingerprint changes
 * by exactly that function; fin_mp_report_activity gains OWN_TRANSFER / CLASSIFY_INFLOW and counterpart_account_name).
 * Derived from ADR018_POST_0085, whose text follows:
 *
 * (0085: scheduler log accepts PENDING — task kept, no run, reason MP_TASK_PREPARING —; mp_release_report_daily at
 * '0,15,30,45 10 * * *' and mp_release_report_daily_fallback at '0 11,14 * * *' with the SAME command; worker unchanged).
 * Derived from ADR018_POST_0084, whose text follows:
 *
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

export const NAME = 'ADR018_POST_0090';
export const THROUGH = '0090';
const MIGRATIONS = ['0078_fin_mp_release_report_validation.sql', '0079_fin_mp_release_report_normal.sql', '0080_fin_mp_release_report_empty_days.sql',
  '0081_fin_mp_report_daily_support.sql', '0082_mp_report_daily_schedule.sql',
  '0083_fin_mp_payout_destination.sql', '0084_fin_mp_payout_own_account_match.sql',
  '0085_mp_report_daily_pending_retry.sql', '0086_mp_inbound_own_transfer.sql',
  '0087_mp_payout_own_transfer_confirm.sql', '0088_optional_supplier_casual_purchases.sql',
  '0089_mp_classify_inflows_outflows.sql', '0090_mp_outbound_payments.sql'];

const FIN_TABLES = ['fin_import_run', 'fin_import_run_line', 'fin_mp_payout_destination', 'fin_mp_report_schedule_log', 'fin_statement_account_config', 'fin_statement_cutover', 'fin_statement_line', 'fin_statement_match'];
const SIG = '(uuid,text,text,text,text,text,bigint,date,date,jsonb,text,jsonb)';
const CAPTURE = `fin_capture_mp_release_report${SIG}`;
const INGEST = `fin_ingest_mp_release_report${SIG}`;
const BACKFILL = 'mp_register_report_backfill(uuid)';
const SCHEDULE = 'fin_record_mp_report_schedule(date,text,uuid,text,text,jsonb)';
const DESTINATIONS = 'fin_record_mp_payout_destinations(uuid,jsonb)';
const MATCHES = 'fin_mp_payout_matches(uuid)';
const RECLASS = 'mp_reclassify_inbound_own_transfer(text,uuid,text)';
const GUARD = 'mp_own_transfer_allocation_guard()';
const CONFIRM = 'mp_confirm_payout_transfer(text)';
const CASUAL = 'register_casual_purchase(date,numeric,numeric,uuid,character varying,purchase_nature,uuid,payment_method,character varying,character varying,jsonb,jsonb,jsonb,uuid,uuid,text,text)';
const CASUAL_RECLASS = 'rectify_casual_purchase_classification(uuid,uuid,purchase_nature,character varying,character varying,text)';
const RESOLVE = 'mp_payout_outflow_resolve(text)';
const OUTFLOW = 'mp_classify_payout_outflow(text,text,uuid,uuid,purchase_nature,text,text,text)';
const INFLOW = 'mp_classify_inflow_as_collection(text,uuid)';
const ADR018_DEFINERS = [
  CAPTURE, INGEST, BACKFILL, SCHEDULE, DESTINATIONS, MATCHES, RECLASS, CONFIRM, CASUAL, CASUAL_RECLASS, OUTFLOW, INFLOW,
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
  'mp_reclassify_inbound_own_transfer': 'false|true|false',
  'mp_confirm_payout_transfer': 'false|true|false',
  'register_casual_purchase': 'false|true|false',
  'rectify_casual_purchase_classification': 'false|true|false',
  'mp_classify_payout_outflow': 'false|true|false',
  'mp_classify_inflow_as_collection': 'false|true|false',
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
// 0086 changes exactly one pre-0079 body (mp_is_auto_applicable); the EXECUTE fingerprint is unchanged
const MP_BODY_FINGERPRINT_0078 = 'da5095a42f0bc74cfdb1a071f155447b';
const AUTO_APPLICABLE_MD5 = 'a571cd9698c8d6ab067a179f807b7c17';
const RECLASS_BODY_MD5 = 'b1d5ab111e64dda2ee8f705c797cfe6f';
const GUARD_BODY_MD5 = 'a40b7337f7436cebb6c3e55c15a30831';
const ACTIVITY_VIEW_MD5 = '8a99b3dd97fb5f5dc13fa679bcf3398b';   // 0090: outbound payments classifiable
const OUTFLOW_BODY_MD5 = 'b649c077f2a675e57527ea1bd6b21a11';
const INFLOW_BODY_MD5 = '5a2f594c0b386d39bdc29001633322d7';
const CONFIRM_BODY_MD5 = '3a185bfcfc3b97baf408137787f5ab50';
const ADR019_BODIES = {"fiscal_document_insert":"false:fe337b7e4f3b375ab81378c19624d9c6","mp_payout_outflow_resolve":"false:d16aa41c51ee950b3756ffe4475c6991","rectify_casual_purchase_classification":"true:cbee92e89aeaecc37da6c625f6f6d9ca","rectify_purchase":"true:e87c030f7cead5f33fb7b2e13ffea5a3","register_casual_purchase":"true:36d1bf975d5ad718470f8a7f2dd5229c","register_fiscal_document":"true:faf694dfab743e019e9d25872b0a2e2c"};
const PAYOUT_IDS = ['181533509871', '183527567414', '183984533002'];
const RECLASS_IDS = ['182961933745', '183094247963', '184118733308'];
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
const CRON = ['mp_release_report_daily|0,15,30,45 10 * * *|true', 'mp_release_report_daily_fallback|0 11,14 * * *|true', 'mp_worker_every_minute|* * * * *|true'];
// fin_mp_report_schedule_log CHECK constraints after 0085 (md5 of 'name:definition' joined by ',' in name order)
const SCHEDULE_CHECKS_MD5 = '1558c0d9695a5181ef9846c25a586502';
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
const PRE_0079 = "proname LIKE 'mp\\_%' AND proname NOT IN ('mp_register_report_backfill', 'mp_reclassify_inbound_own_transfer', 'mp_own_transfer_allocation_guard', 'mp_confirm_payout_transfer', 'mp_payout_outflow_resolve', 'mp_classify_payout_outflow', 'mp_classify_inflow_as_collection', 'mp_outflow_resolve', 'mp_outflow_apply_charges')";

export function buildSql(repo) {
  const cfg = approvedConfigs(repo);
  const values = cfg.map((r) => `(${lit(r.nombre)}, ${lit(r.format)}, ${lit(r.account)}, ${lit(r.cbu)}, ${lit(r.extra)}::jsonb)`).join(', ');
  return `SELECT json_build_object(
  'ledger_count', (SELECT count(*) FROM migration_ledger.applied),
  'ledger_max', (SELECT max(version) FROM migration_ledger.applied),
  'ledger_new', (SELECT coalesce(json_agg(filename || '|' || sha256 ORDER BY version), '[]') FROM migration_ledger.applied WHERE version IN ('0078', '0079', '0080', '0081', '0082', '0083', '0084', '0085', '0086', '0087', '0088', '0089', '0090')),
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
  'schedule_checks', (SELECT md5(string_agg(conname || ':' || pg_get_constraintdef(oid), ',' ORDER BY conname)) FROM pg_constraint
                       WHERE conrelid = to_regclass('public.fin_mp_report_schedule_log') AND contype = 'c'),
  'mir', json_build_object(
      'rls', (SELECT relrowsecurity FROM pg_class WHERE oid = to_regclass('public.mp_inbound_reclassification')),
      'policies', (SELECT coalesce(json_agg(policyname || ':' || cmd ORDER BY policyname), '[]') FROM pg_policies WHERE schemaname = 'public' AND tablename = 'mp_inbound_reclassification'),
      'privileges', (SELECT has_table_privilege('anon', 'public.mp_inbound_reclassification', 'SELECT,INSERT,UPDATE,DELETE') || ':'
                       || has_table_privilege('authenticated', 'public.mp_inbound_reclassification', 'SELECT') || ':'
                       || has_table_privilege('authenticated', 'public.mp_inbound_reclassification', 'INSERT,UPDATE,DELETE,TRUNCATE') || ':'
                       || has_table_privilege('service_role', 'public.mp_inbound_reclassification', 'SELECT,INSERT,UPDATE,DELETE')),
      'immutable', (SELECT count(*) FROM pg_trigger WHERE tgrelid = to_regclass('public.mp_inbound_reclassification') AND NOT tgisinternal
                     AND tgfoid = 'fin_evidence_immutable_guard'::regproc),
      'alloc_guard', (SELECT count(*) FROM pg_trigger WHERE tgrelid = to_regclass('public.mp_client_allocation') AND NOT tgisinternal
                       AND tgname = 'trg_mp_client_allocation_own_transfer'),
      'reclass_body', (SELECT md5(replace(prosrc, E'\\r', '')) FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname = 'mp_reclassify_inbound_own_transfer'),
      'guard_fn', (SELECT prosecdef || ':' || has_function_privilege('authenticated', oid, 'EXECUTE') || ':' || md5(replace(prosrc, E'\\r', ''))
                    FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname = 'mp_own_transfer_allocation_guard'),
      'auto_body', (SELECT md5(replace(prosrc, E'\\r', '')) FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname = 'mp_is_auto_applicable'),
      'view', md5(pg_get_viewdef('public.fin_mp_report_activity'::regclass)),
  'ptc', json_build_object(
      'rls', (SELECT relrowsecurity FROM pg_class WHERE oid = to_regclass('public.mp_payout_transfer_confirmation')),
      'policies', (SELECT coalesce(json_agg(policyname || ':' || cmd ORDER BY policyname), '[]') FROM pg_policies WHERE schemaname = 'public' AND tablename = 'mp_payout_transfer_confirmation'),
      'privileges', (SELECT has_table_privilege('anon', 'public.mp_payout_transfer_confirmation', 'SELECT,INSERT,UPDATE,DELETE') || ':'
                       || has_table_privilege('authenticated', 'public.mp_payout_transfer_confirmation', 'SELECT') || ':'
                       || has_table_privilege('authenticated', 'public.mp_payout_transfer_confirmation', 'INSERT,UPDATE,DELETE,TRUNCATE') || ':'
                       || has_table_privilege('service_role', 'public.mp_payout_transfer_confirmation', 'SELECT,INSERT,UPDATE,DELETE')),
      'immutable', (SELECT count(*) FROM pg_trigger WHERE tgrelid = to_regclass('public.mp_payout_transfer_confirmation') AND NOT tgisinternal
                     AND tgfoid = 'fin_evidence_immutable_guard'::regproc),
      'confirm_fn', (SELECT pg_get_function_identity_arguments(oid) || ':' || md5(replace(prosrc, E'\\r', ''))
                      FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname = 'mp_confirm_payout_transfer')),
  'adr019', json_build_object(
      'bodies', (SELECT json_object_agg(proname, prosecdef || ':' || md5(replace(prosrc, E'\\r', '')) ORDER BY proname)
                  FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname IN ('register_casual_purchase', 'rectify_casual_purchase_classification',
                    'rectify_purchase', 'register_fiscal_document', 'fiscal_document_insert', 'mp_payout_outflow_resolve')),
      'helpers_exec', (SELECT string_agg(proname || '=' || has_function_privilege('authenticated', oid, 'EXECUTE') || has_function_privilege('service_role', oid, 'EXECUTE'), ',' ORDER BY proname)
                        FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname IN ('fiscal_document_insert', 'mp_payout_outflow_resolve')),
      'purchases', (SELECT string_agg(conname, ',' ORDER BY conname) FROM pg_constraint WHERE conrelid = 'public.purchases'::regclass
                     AND conname IN ('chk_purchases_counterparty', 'chk_purchases_casual_paid')),
      'supplier_nullable', (SELECT NOT attnotnull FROM pg_attribute WHERE attrelid = 'public.purchases'::regclass AND attname = 'supplier_id'),
      'indexes', (SELECT string_agg(indexname, ',' ORDER BY indexname) FROM pg_indexes WHERE schemaname = 'public'
                   AND indexname IN ('uq_purchases_paid_operation_current', 'idx_fiscal_document_issuer_number')),
      'fiscal', (SELECT string_agg(conname, ',' ORDER BY conname) FROM pg_constraint WHERE conrelid = 'public.fiscal_document'::regclass
                  AND conname IN ('chk_fiscal_counterparty', 'chk_fiscal_issuer')),
      'op_type', (SELECT 'PURCHASE_PAYMENT' = ANY (enum_range(NULL::financial_operation_type)::text[])),
      'moc', json_build_object('rls', (SELECT relrowsecurity FROM pg_class WHERE oid = to_regclass('public.mp_outflow_classification')),
               'policies', (SELECT coalesce(json_agg(policyname || ':' || cmd ORDER BY policyname), '[]') FROM pg_policies WHERE schemaname = 'public' AND tablename = 'mp_outflow_classification'),
               'privileges', has_table_privilege('anon', 'public.mp_outflow_classification', 'SELECT,INSERT,UPDATE,DELETE') || ':' || has_table_privilege('authenticated', 'public.mp_outflow_classification', 'SELECT') || ':'
                    || has_table_privilege('authenticated', 'public.mp_outflow_classification', 'INSERT,UPDATE,DELETE,TRUNCATE') || ':' || has_table_privilege('service_role', 'public.mp_outflow_classification', 'SELECT,INSERT,UPDATE,DELETE'),
               'immutable', (SELECT count(*) FROM pg_trigger WHERE tgrelid = to_regclass('public.mp_outflow_classification') AND NOT tgisinternal AND tgfoid = 'fin_evidence_immutable_guard'::regproc))),
  'adr020', json_build_object(
          'transition', (SELECT pg_get_constraintdef(oid) LIKE '%''OUTBOUND''%' FROM pg_constraint WHERE conname = 'chk_transition_kind'),
          'helpers', (SELECT json_object_agg(proname, prosecdef || ':' || has_function_privilege('authenticated', oid, 'EXECUTE') || ':' || md5(replace(prosrc, E'\\r', '')) ORDER BY proname)
                       FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname IN ('mp_outflow_resolve', 'mp_outflow_apply_charges'))),
  'cls0089', json_build_object(
      'mic', json_build_object('rls', (SELECT relrowsecurity FROM pg_class WHERE oid = to_regclass('public.mp_inflow_classification')),
               'policies', (SELECT coalesce(json_agg(policyname || ':' || cmd ORDER BY policyname), '[]') FROM pg_policies WHERE schemaname = 'public' AND tablename = 'mp_inflow_classification'),
               'privileges', has_table_privilege('anon', 'public.mp_inflow_classification', 'SELECT,INSERT,UPDATE,DELETE') || ':' || has_table_privilege('authenticated', 'public.mp_inflow_classification', 'SELECT') || ':'
                    || has_table_privilege('authenticated', 'public.mp_inflow_classification', 'INSERT,UPDATE,DELETE,TRUNCATE') || ':' || has_table_privilege('service_role', 'public.mp_inflow_classification', 'SELECT,INSERT,UPDATE,DELETE'),
               'immutable', (SELECT count(*) FROM pg_trigger WHERE tgrelid = to_regclass('public.mp_inflow_classification') AND NOT tgisinternal AND tgfoid = 'fin_evidence_immutable_guard'::regproc)),
      'fns', (SELECT json_object_agg(proname, pg_get_function_identity_arguments(oid) || ':' || md5(replace(prosrc, E'\\r', '')) ORDER BY proname)
               FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname IN ('mp_classify_payout_outflow', 'mp_classify_inflow_as_collection')))),
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
      'reclass_rows', (SELECT count(*) FROM mp_inbound_reclassification),
      'outbound_identities', (SELECT count(*) FROM mp_transition_identity WHERE transition = 'OUTBOUND'),
      'payout_confirmations', (SELECT string_agg(source_id || ':' || amount, ',' ORDER BY source_id) FROM mp_payout_transfer_confirmation),
      'inflow_classifications', (SELECT count(*) FROM mp_inflow_classification),
      'casual', (SELECT count(*) FROM purchases WHERE supplier_id IS NULL) || ':' || (SELECT count(*) FROM mp_outflow_classification) || ':'
                || (SELECT count(*) FROM fiscal_document WHERE issuer_tax_id IS NOT NULL),
      'payouts_unapplied', (SELECT string_agg(split_part(t.resource_id, ':', 1) || ':' || m.net_amount || ':' || (SELECT count(*) FROM mp_reconciliation r WHERE r.mp_financial_movement_id = m.id), ',' ORDER BY t.resource_id)
                             FROM mp_transition_identity t JOIN mp_financial_movement m ON m.id = t.mp_financial_movement_id
                            WHERE t.resource_type = 'report' AND t.transition = 'PAYOUT'
                              AND t.resource_id IN ('181533509871:payout:D', '183527567414:payout:D', '183984533002:payout:D')),
      'targets_applied', (SELECT string_agg(t.resource_id || ':' || (SELECT string_agg(o.operation_type::text, '+' ORDER BY o.id) FROM mp_reconciliation r
                              JOIN financial_operation o ON o.id = r.financial_operation_id WHERE r.mp_financial_movement_id = t.mp_financial_movement_id), ',' ORDER BY t.resource_id)
                           FROM mp_transition_identity t WHERE t.resource_type = 'payment' AND t.transition = 'APPROVAL'
                            AND t.resource_id IN ('182961933745', '183094247963', '184118733308')),
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
  check('B ledger 0078 … 0090 = repository files (name + full sha256)', JSON.stringify(s.ledger_new) === JSON.stringify(want),
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
    s.fin_function_overloads === 16 && Object.entries(EXEC).every(([f, m]) => s.fin_functions[f] === `true|postgres|true|${m}`), JSON.stringify(s.fin_functions));
  check('F MP report functions: no PUBLIC EXECUTE', s.report_public_exec === 0, String(s.report_public_exec));
  check('G bucket financial-statements private, 10 MB, application/pdf + text/csv', JSON.stringify(s.bucket) === JSON.stringify([BUCKET]), s.bucket.join(' '));
  check('G exactly one bucket policy: ADMIN SELECT for authenticated', JSON.stringify(s.bucket_policies) === JSON.stringify(['financial_statements_admin_select:SELECT:authenticated:true']),
    s.bucket_policies.join(' '));
  check(`H the ${MP_PRE_0079} pre-0079 Mercado Pago functions = POST_0078 except mp_is_auto_applicable (0086); EXECUTE matrix unchanged; 0087 / 0088 / 0089 change none`,
    s.mp_pre_count === MP_PRE_0079 && s.mp_pre_body_fp === MP_BODY_FINGERPRINT_0078 && s.mp_pre_exec_fp === MP_EXEC_FINGERPRINT_0078,
    `count=${s.mp_pre_count} body=${s.mp_pre_body_fp} exec=${s.mp_pre_exec_fp}`);
  check('H new mp_* functions: mp_register_report_backfill (0079), mp_reclassify_inbound_own_transfer + mp_own_transfer_allocation_guard (0086), mp_confirm_payout_transfer (0087), mp_payout_outflow_resolve (0088, INVOKER), mp_classify_payout_outflow + mp_classify_inflow_as_collection (0089)',
    JSON.stringify(s.mp_new) === JSON.stringify([CONFIRM, GUARD, RECLASS, BACKFILL, RESOLVE, OUTFLOW, INFLOW, 'mp_outflow_resolve(text)', 'mp_outflow_apply_charges(bigint,text,uuid,numeric,numeric,date,uuid,text)'].sort()) && s.backfill_body === BACKFILL_BODY_MD5, `${s.mp_new.join(' ')} ${s.backfill_body}`);
  check('H mp_register_delivery still refuses report_backfill; mp_v4_verified() false; one MP cutover boundary',
    s.register_refuses_backfill === true && s.mp_v4 === false && s.mp_boundary === 1, `refuses=${s.register_refuses_backfill} v4=${s.mp_v4} boundary=${s.mp_boundary}`);
  check('I exactly three cron jobs: mp_release_report_daily (0,15,30,45 10 * * *) + mp_release_report_daily_fallback (0 11,14 * * *) + mp_worker_every_minute, all active, owner postgres@postgres',
    JSON.stringify(s.cron) === JSON.stringify(CRON) && JSON.stringify(s.cron_owner) === JSON.stringify(['postgres@postgres']), s.cron.join(' '));
  const dailyCmd = (() => { const f = readFileSync(join(repo, 'supabase', 'target-migrations', '0082_mp_report_daily_schedule.sql'), 'utf8').replace(/\r/g, '');
    const m = /\$job\$([\s\S]*?)\$job\$/.exec(f); return m ? createHash('md5').update(m[1]).digest('hex') : 'none'; })();
  check('I daily job command = the 0082 file; worker command unchanged since 0056',
    s.cron_commands?.mp_release_report_daily === dailyCmd && s.cron_commands?.mp_release_report_daily_fallback === dailyCmd && s.cron_commands?.mp_worker_every_minute === WORKER_COMMAND_MD5,
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
  const m = s.mir ?? {};
  check('P mp_inbound_reclassification: RLS, ADMIN SELECT policy only, SELECT for authenticated, no write for any API role, immutable; allocation guard trigger present',
    m.rls === true && JSON.stringify(m.policies) === JSON.stringify(['mp_inbound_reclassification_admin_select:SELECT']) && m.privileges === 'false:true:false:false'
      && m.immutable === 1 && m.alloc_guard === 1, JSON.stringify(m));
  check('P bodies: reclassification RPC, INVOKER guard (no EXECUTE for authenticated), mp_is_auto_applicable as in 0086; activity view as in 0090',
    m.reclass_body === RECLASS_BODY_MD5 && m.guard_fn === `false:false:${GUARD_BODY_MD5}` && m.auto_body === AUTO_APPLICABLE_MD5 && m.view === ACTIVITY_VIEW_MD5, JSON.stringify(m));
  const c = s.mir?.ptc ?? {};   // nested in mir: the root json_build_object is at its 100-argument limit
  check('Q mp_payout_transfer_confirmation: RLS, ADMIN SELECT policy only, SELECT for authenticated, no write for any API role, immutable',
    c.rls === true && JSON.stringify(c.policies) === JSON.stringify(['mp_payout_transfer_confirmation_admin_select:SELECT']) && c.privileges === 'false:true:false:false'
      && c.immutable === 1, JSON.stringify(c));
  check('Q mp_confirm_payout_transfer: the SOURCE_ID is its only parameter; body as in 0087', c.confirm_fn === `p_source_id text:${CONFIRM_BODY_MD5}`, String(c.confirm_fn));
  const z = s.mir?.adr019 ?? {};
  check('S ADR-019 model: supplier_id nullable, casual CHECKs, one current purchase per payment, issuer form of fiscal documents, PURCHASE_PAYMENT',
    z.supplier_nullable === true && z.purchases === 'chk_purchases_casual_paid,chk_purchases_counterparty' && z.fiscal === 'chk_fiscal_counterparty,chk_fiscal_issuer'
      && z.indexes === 'idx_fiscal_document_issuer_number,uq_purchases_paid_operation_current' && z.op_type === true, JSON.stringify(z));
  check('S ADR-019 bodies as in 0088 (casual RPCs DEFINER; RPC 14 / RPC 34 redefined; helpers INVOKER, no API EXECUTE)',
    JSON.stringify(z.bodies) === JSON.stringify(ADR019_BODIES) && z.helpers_exec === 'fiscal_document_insert=falsefalse,mp_payout_outflow_resolve=falsefalse', JSON.stringify(z));
  check('S mp_outflow_classification: RLS, ADMIN SELECT policy only, SELECT for authenticated, no write for any API role, immutable',
    z.moc && z.moc.rls === true && JSON.stringify(z.moc.policies) === JSON.stringify(['mp_outflow_classification_admin_select:SELECT'])
      && z.moc.privileges === 'false:true:false:false' && z.moc.immutable === 1, JSON.stringify(z.moc));
  const k9 = s.mir?.cls0089 ?? {};
  check('T mp_inflow_classification: RLS, ADMIN SELECT policy only, SELECT for authenticated, no write for any API role, immutable',
    k9.mic && k9.mic.rls === true && JSON.stringify(k9.mic.policies) === JSON.stringify(['mp_inflow_classification_admin_select:SELECT'])
      && k9.mic.privileges === 'false:true:false:false' && k9.mic.immutable === 1, JSON.stringify(k9.mic));
  check('T classification RPCs: identifier parameters only; bodies as in 0089',
    k9.fns && k9.fns.mp_classify_payout_outflow === `p_source_id text, p_classification text, p_supplier_id uuid, p_expense_category_id uuid, p_nature purchase_nature, p_concept text, p_counterparty_name text, p_reason text:${OUTFLOW_BODY_MD5}`
      && k9.fns.mp_classify_inflow_as_collection === `p_payment_id text, p_client_id uuid:${INFLOW_BODY_MD5}`, JSON.stringify(k9.fns));
  const x0 = s.mir?.adr020 ?? {};
  check('U ADR-020: transition OUTBOUND allowed; outflow helpers INVOKER with no API EXECUTE, bodies as in 0090',
    x0.transition === true && JSON.stringify(x0.helpers) === JSON.stringify({"mp_outflow_apply_charges":"false:false:891fc7c79d3ebda03e8cab254e462044","mp_outflow_resolve":"false:false:a32e2aa5600fa54db96d04986bc96bf8"}), JSON.stringify(x0));
  check('O scheduler log accepts PENDING (task required, no run, reason MP_TASK_PREPARING); FAILED / PENDING carry a reason; success carries a run — constraints as in 0085',
    s.schedule_checks === SCHEDULE_CHECKS_MD5, String(s.schedule_checks));
  if (deploymentCheck) {
    const e = s.evidence;
    check('DEPLOYMENT CHECK: the 3 BNA → MP reclassifications in place (settlement + reversal + transfer); 05/10 + 10/10 confirmed as transfers to BNA; 13/10 classified once (casual purchase); no inflow classification, no outbound identity, no issuer document yet; MP config 16 columns; one mp/ object per MP file',
      e.reclass_rows === 3 && e.targets_applied === RECLASS_IDS.map((id) => `${id}:MP_SETTLEMENT+MP_SETTLEMENT+TRANSFER`).join(',')
        && e.payout_confirmations === '181533509871:1000000.00,183527567414:2200000.00' && e.casual === '1:1:0' && e.inflow_classifications === 0 && e.outbound_identities === 0
        && e.payouts_unapplied === '181533509871:-1000000.00:1,183527567414:-2200000.00:1,183984533002:-759702.86:1'
        && e.corpus === '181533509871:BNA,183527567414:BNA,183984533002:NO_OWN_ACCOUNT_MATCH' && e.latest_config_columns === 16
        && e.mp_objects === e.mp_files,
      JSON.stringify({ ...e, corpus: e.corpus }));
  }
  return out;
}
