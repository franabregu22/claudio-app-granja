/**
 * Verification profile ADR018_POST_0077 — the exact database state after target migrations 0001…0077
 * (ADR-018: financial statement tables, privileges / storage / config seed, functions, status view, cut-vs-match guard).
 *
 * Read-only: one SELECT returning a JSON document, evaluated here. Never prints a bank identifier: the two configured
 * accounts are compared server-side against the literal values of migration 0074 (set equality) and only a boolean
 * comes back.
 *
 * `deploymentCheck` (initial technical deploy only) additionally requires ZERO evidence rows (runs, lines, appearances,
 * matches, cuts). It is a deployment gate, not a schema invariant: once real statements are imported it must not be used.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export const NAME = 'ADR018_POST_0077';
export const THROUGH = '0077';

const FIN_TABLES = ['fin_import_run', 'fin_import_run_line', 'fin_statement_account_config', 'fin_statement_cutover', 'fin_statement_line', 'fin_statement_match'];
const FIN_DEFINERS = [
  'fin_import_bank_statement(uuid,uuid,text,text,text,text,text,bigint,date,date,jsonb,uuid,text,jsonb)',
  'fin_match_statement_line(bigint,bigint,text)',
  'fin_resolve_statement_cutover(uuid,bigint,numeric,text,text)',
  'fin_reverse_statement_match(bigint,text)',
];
// the single hosted-platform definer accepted in public (Supabase "automatic RLS"; see provision-target.mjs)
const PLATFORM_DEFINERS = ['rls_auto_enable()'];
const EXEC = {   // anon | authenticated | service_role
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
const BUCKET = 'financial-statements:false:10485760:application/pdf';

const lit = (s) => `'${String(s).replace(/'/g, "''")}'`;

/** The two approved (K-1) configuration rows, read from migration 0074 itself — never typed elsewhere. */
function approvedConfigs(repo) {
  const sql = readFileSync(join(repo, 'supabase', 'target-migrations', '0074_fin_statement_privileges_storage.sql'), 'utf8');
  const re = /SELECT id, '([A-Z0-9_]+)', '([^']+)', '([^']+)', '([^']*)'::jsonb\s+FROM financial_account WHERE nombre = '([^']+)' AND account_type = 'BANK_ACCOUNT'/g;
  const rows = [...sql.matchAll(re)].map((m) => ({ format: m[1], account: m[2], cbu: m[3], extra: m[4], nombre: m[5] }));
  if (rows.length !== 2) throw new Error(`profile ${NAME}: expected 2 configuration rows in 0074, found ${rows.length}`);
  return rows;
}

export function buildSql(repo) {
  const cfg = approvedConfigs(repo);
  const values = cfg.map((r) => `(${lit(r.nombre)}, ${lit(r.format)}, ${lit(r.account)}, ${lit(r.cbu)}, ${lit(r.extra)}::jsonb)`).join(', ');
  return `SELECT json_build_object(
  'ledger_count', (SELECT count(*) FROM migration_ledger.applied),
  'ledger_max', (SELECT max(version) FROM migration_ledger.applied),
  'fin_tables', (SELECT coalesce(json_agg(table_name ORDER BY table_name), '[]') FROM information_schema.tables
                  WHERE table_schema = 'public' AND table_type = 'BASE TABLE' AND table_name LIKE 'fin\\_%'),
  'view', to_regclass('public.fin_statement_line_status') IS NOT NULL,
  'definers', (SELECT coalesce(json_agg(p.oid::regprocedure::text ORDER BY 1), '[]') FROM pg_proc p WHERE pronamespace = 'public'::regnamespace AND prosecdef),
  'anon_definers', (SELECT count(*) FROM pg_proc p WHERE pronamespace = 'public'::regnamespace AND prosecdef
                     AND p.oid::regprocedure::text <> ALL (ARRAY[${PLATFORM_DEFINERS.map(lit).join(', ')}]::text[])
                     AND has_function_privilege('anon', p.oid, 'EXECUTE')),
  'fin_functions', (SELECT coalesce(json_object_agg(proname, prosecdef || '|' || pg_get_userbyid(proowner) || '|'
                        || has_function_privilege('anon', p.oid, 'EXECUTE') || '|' || has_function_privilege('authenticated', p.oid, 'EXECUTE')
                        || '|' || has_function_privilege('service_role', p.oid, 'EXECUTE')), '{}')
                     FROM pg_proc p WHERE pronamespace = 'public'::regnamespace AND proname IN (${Object.keys(EXEC).map(lit).join(', ')})),
  'fin_function_overloads', (SELECT count(*) FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname IN (${Object.keys(EXEC).map(lit).join(', ')})),
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
  'evidence', json_build_object('runs', (SELECT count(*) FROM fin_import_run), 'lines', (SELECT count(*) FROM fin_statement_line),
                                'appearances', (SELECT count(*) FROM fin_import_run_line), 'matches', (SELECT count(*) FROM fin_statement_match),
                                'cuts', (SELECT count(*) FROM fin_statement_cutover))
)::text;`;
}

/** Evaluates the JSON result. Returns [{ label, ok, detail }]; details never contain bank identifiers. */
export function evaluate(s, { repo, expectedLedger, deploymentCheck }) {
  const appDefiners = JSON.parse(readFileSync(join(repo, 'scripts', 'phase31', 'app-definers.json'), 'utf8')).identities.concat(FIN_DEFINERS).sort();
  const out = [];
  const check = (label, ok, detail = '') => out.push({ label, ok: !!ok, detail });
  check(`ledger ${expectedLedger} rows, last ${THROUGH}`, s.ledger_count === expectedLedger && s.ledger_max === THROUGH, `${s.ledger_count} / ${s.ledger_max}`);
  check('6 ADR-018 tables', JSON.stringify(s.fin_tables) === JSON.stringify(FIN_TABLES), s.fin_tables.join(','));
  check('view fin_statement_line_status', s.view === true);
  const app = s.definers.filter((d) => !PLATFORM_DEFINERS.includes(d)).sort();
  const platform = s.definers.filter((d) => PLATFORM_DEFINERS.includes(d));
  check(`SECURITY DEFINER: exactly the ${appDefiners.length} application identities (+ ${platform.length} hosted-platform; raw ${s.definers.length})`,
    JSON.stringify(app) === JSON.stringify(appDefiners),
    `missing=[${appDefiners.filter((d) => !app.includes(d)).join(' ')}] extra=[${app.filter((d) => !appDefiners.includes(d)).join(' ')}]`);
  check('no application definer executable by anon', s.anon_definers === 0, String(s.anon_definers));
  check('ADR-018 functions: definer, owner postgres, EXECUTE matrix', s.fin_function_overloads === 4
    && Object.entries(EXEC).every(([f, m]) => s.fin_functions[f] === `true|postgres|${m}`), JSON.stringify(s.fin_functions));
  check('0077 guard present (resolve: conflict + account lock; match: account share lock)',
    s.guard_0077?.fin_resolve_statement_cutover === 'true|true|false' && s.guard_0077?.fin_match_statement_line === 'false|false|true', JSON.stringify(s.guard_0077));
  check('table grants exact (SELECT only; anon none)', JSON.stringify(s.table_grants) === JSON.stringify(TABLE_GRANTS), s.table_grants.join(' '));
  check('RLS on every ADR-018 table', s.rls_missing === 0, String(s.rls_missing));
  check('exactly 2 active configurations, equal to the approved 0074 values', s.config_active === 2 && s.config_exact === true,
    `active=${s.config_active} exact=${s.config_exact}`);
  check('bucket financial-statements private, 10 MB, application/pdf', JSON.stringify(s.bucket) === JSON.stringify([BUCKET]), s.bucket.join(' '));
  check('exactly one bucket policy: ADMIN SELECT for authenticated', JSON.stringify(s.bucket_policies) === JSON.stringify(['financial_statements_admin_select:SELECT:authenticated:true']),
    s.bucket_policies.join(' '));
  if (deploymentCheck) {
    const e = s.evidence;
    check('DEPLOYMENT CHECK: zero evidence rows (runs, lines, appearances, matches, cuts)',
      e.runs === 0 && e.lines === 0 && e.appearances === 0 && e.matches === 0 && e.cuts === 0, JSON.stringify(e));
  }
  return out;
}
