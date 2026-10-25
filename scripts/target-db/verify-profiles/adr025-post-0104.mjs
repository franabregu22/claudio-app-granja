/**
 * Verification profile ADR025_POST_0104 — the exact database state after target migrations 0001…0104
 * (0103, ADR-025 stage 4: WhatsApp receipts — document_file / document_link (RLS, ADMIN SELECT, immutable), the ADMIN view
 * fin_document_links, the PRIVATE bucket wa-media (10 MB, PDF / JPEG / PNG / WebP) with a gateway-only INSERT and an ADMIN /
 * gateway SELECT policy, wa.inbound_message caption / media columns, the wrapped entry points wa_ingest / wa_propose /
 * wa_correct / wa_confirm (their 0102 bodies moved to wa.*_0102, no API EXECUTE), the new entry points wa_store_media,
 * wa_media_writer, wa_media_reader, the confirmation / carry triggers;
 * 0104: own cheques / eCheqs paying ONE invoice — purchase_payment_allocation (RLS, ADMIN SELECT, immutable),
 * financial_instrument.replaces_instrument_id, the ADMIN RPCs register_erp_document / issue_purchase_instruments /
 * allocate_purchase_payment / attach_instrument_document and the security_invoker views fin_purchase_payment_status,
 * fin_purchase_payment_detail, fin_scheduled_payments). The bot stays OFF (wa.config / wa.sender empty: checked by 0102).
 *
 * The whole 0001…0102 state is verified by ADR025_POST_0102 itself. Removed from it before evaluating, and checked here
 * exactly instead: the ledger length (A), the seven new SECURITY DEFINER identities (D), the grants of the four new fin_%
 * views (K), the new 0103 trigger on expense_pending_resolution (0101 trigger set), the public.wa_* entry points and the
 * wa function set (0102: bodies changed by the wrappers).
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as prev from './adr025-post-0102.mjs';

export const NAME = 'ADR025_POST_0104';
export const THROUGH = '0104';
const MIGRATIONS = ['0103_documents_whatsapp_receipts.sql', '0104_purchase_payments_instruments.sql'];
const OWN = 'true|postgres|search_path=public, pg_temp|falsetruefalse';
const ADM = 'true|postgres|search_path=public|falsetruefalse';
// identity | DEFINER | owner | proconfig | EXECUTE anon / authenticated / service_role | body md5
const ENTRY_POINTS = [
  `wa_cancel(bigint,uuid,integer)|${OWN}|36b00d25cbd361972c93dd3263245d5e`,
  `wa_confirm(bigint,uuid,integer)|${OWN}|09df6b315f67a877e152eec62c75cc4a`,
  `wa_context(bigint)|${OWN}|6a63e948aa988fd6d9e50c2b01e6833d`,
  `wa_correct(bigint,uuid,integer,jsonb)|${OWN}|76c629119fff7226a38b5c8f87daaa56`,
  `wa_expire()|${OWN}|b6418417e9847010f9b55a2e0f0dcb25`,
  `wa_ingest(text,text)|${OWN}|8fb4ebbf3f2ca3b469010da5dc7ec3d9`,
  `wa_link_mp(bigint,uuid,integer,text)|${OWN}|3565711316fe4bc8b3ff1d17dd214b82`,
  `wa_media_reader()|${OWN}|18f422c5ae4d16d7911ecd900855d034`,
  `wa_media_writer()|${OWN}|845fb893586fb47efb8bb77b9052d005`,
  `wa_propose(bigint,text,jsonb)|${OWN}|9927007f4cad32bb1c42d7d54fa9df59`,
  `wa_store_media(bigint,text,text,bigint)|${OWN}|c39707f788d2d1faf1bafddd6b8eab3d`,
];
const FUNCTIONS_0104 = [
  `allocate_purchase_payment(uuid,bigint,numeric,character varying,text)|${ADM}|91dd0f5dcf421504437591de0a58bf64`,
  `attach_instrument_document(uuid,jsonb)|${ADM}|5b5867cf3c91adb4efe30b1a3d4d9f0c`,
  'document_file_guard()|false|postgres|search_path=public|falsefalsefalse|f091ec47dcf358cf24b1b1590435343f',
  'expense_pending_document_carry()|false|postgres|search_path=public|falsefalsefalse|99a6abb3f15372c05c36cf38622d7590',
  `issue_purchase_instruments(uuid,jsonb,character varying,text)|${ADM}|c90f3a994aaff4d9d952c9eead3c32f1`,
  'purchase_allocated_amount(uuid)|false|postgres|search_path=public|falsefalsefalse|9f51ec20aad754e5d9bc24ab362c1d76',
  // INVOKER, read by the security_invoker view fin_purchase_payment_status (the caller's RLS applies)
  'purchase_chain_root(uuid)|false|postgres|search_path=public|falsetruefalse|99645046c3b3fdb257e723a7f761b24f',
  `register_erp_document(text,text,text,bigint,text)|${ADM}|cf08f07053323e4b1a066435d5ac4c46`,
];
const NEW_DEFINERS = [
  'allocate_purchase_payment(uuid,bigint,numeric,character varying,text)', 'attach_instrument_document(uuid,jsonb)',
  'issue_purchase_instruments(uuid,jsonb,character varying,text)', 'register_erp_document(text,text,text,bigint,text)',
  'wa_media_reader()', 'wa_media_writer()', 'wa_store_media(bigint,text,text,bigint)',
];
const VIEW_ACL = 'postgres:{postgres=arwdDxtm/postgres,authenticated=r/postgres}';
const VIEWS = [
  `fin_document_links:0e3b0efb32512a5aa8ac8cde4c7f39e5:{security_invoker=true}:${VIEW_ACL}`,
  `fin_purchase_payment_detail:e8b2cac9cb524eec690c3e063f30bfde:{security_invoker=true}:${VIEW_ACL}`,
  `fin_purchase_payment_status:bf49bf77321d33371782f2928cf55d42:{security_invoker=true}:${VIEW_ACL}`,
  `fin_scheduled_payments:af7aef66070ab12471f075b507f23294:{security_invoker=true}:${VIEW_ACL}`,
];
const NEW_VIEWS = VIEWS.map((v) => v.split(':')[0]);
const TABLE_ACL = '{postgres=arwdDxtm/postgres,authenticated=r/postgres}';
const TABLES = [`document_file:true:${TABLE_ACL}`, `document_link:true:${TABLE_ACL}`, `purchase_payment_allocation:true:${TABLE_ACL}`];
const ADMIN_ONLY = "(current_app_role() = 'ADMIN'::text)";
const POLICIES = [
  `document_file:document_file_admin_select:SELECT:public:${ADMIN_ONLY}:`,
  `document_link:document_link_admin_select:SELECT:public:${ADMIN_ONLY}:`,
  'objects:wa_media_gateway_insert:INSERT:authenticated',
  'objects:wa_media_read:SELECT:authenticated',
  `purchase_payment_allocation:ppa_admin_select:SELECT:public:${ADMIN_ONLY}:`,
];
const TRIGGERS = [
  'trg_document_file_guard:document_file:O:27:falsefalse:document_file_guard',
  'trg_document_link_immutable:document_link:O:27:falsefalse:fin_evidence_immutable_guard',
  'trg_expense_pending_document_carry:expense_pending_resolution:O:5:falsefalse:expense_pending_document_carry',
  'trg_ppa_immutable:purchase_payment_allocation:O:27:falsefalse:fin_evidence_immutable_guard',
  'trg_wa_draft_document_confirmed:wa.draft:O:17:falsefalse:wa.link_confirmed_document',
];
// count | DEFINER | API EXECUTE | owners | fingerprint (the four DEFINER ones are the 0102 entry-point bodies moved to wa.*_0102)
const WA_FUNCTIONS = '27|4|0|postgres|75f7d83916e68f56bdee36df345486a6';
const WA_DEFINERS = ['wa.confirm_0102(bigint,uuid,integer)', 'wa.correct_0102(bigint,uuid,integer,jsonb)', 'wa.ingest_0102(text,text)', 'wa.propose_0102(bigint,text,jsonb)'];

const shaOf = (repo, f) => createHash('sha256').update(readFileSync(join(repo, 'supabase', 'target-migrations', f), 'utf8')).digest('hex');
const lit = (s) => `'${s.replace(/'/g, "''")}'`;
const fnRow = `p.oid::regprocedure::text || '|' || prosecdef || '|' || pg_get_userbyid(proowner) || '|' || coalesce(array_to_string(proconfig, ','), '') || '|'
  || has_function_privilege('anon', p.oid, 'EXECUTE') || has_function_privilege('authenticated', p.oid, 'EXECUTE') || has_function_privilege('service_role', p.oid, 'EXECUTE')
  || '|' || md5(replace(prosrc, E'\\r', ''))`;

export function innerJson(sql) {
  const m = /^SELECT ([\s\S]*)::text;$/.exec(sql.trim());
  if (!m) throw new Error(`profile ${NAME}: unexpected query shape of the previous profile`);
  return m[1];
}

export function buildSql(repo) {
  return `SELECT json_build_object('prev', ${innerJson(prev.buildSql(repo))},
  'a0104', json_build_object(
    'ledger', (SELECT coalesce(json_agg(filename || '|' || sha256 ORDER BY version), '[]') FROM migration_ledger.applied WHERE version IN ('0103', '0104')),
    'entry_points', (SELECT coalesce(json_agg(${fnRow} ORDER BY p.oid::regprocedure::text), '[]') FROM pg_proc p WHERE pronamespace = 'public'::regnamespace AND proname LIKE 'wa\\_%'),
    'functions', (SELECT coalesce(json_agg(${fnRow} ORDER BY p.oid::regprocedure::text), '[]') FROM pg_proc p WHERE pronamespace = 'public'::regnamespace
                    AND proname IN ('register_erp_document', 'issue_purchase_instruments', 'allocate_purchase_payment', 'attach_instrument_document', 'purchase_chain_root',
                                    'purchase_allocated_amount', 'document_file_guard', 'expense_pending_document_carry')),
    'wa_functions', (SELECT count(*) || '|' || count(*) FILTER (WHERE prosecdef) || '|'
                       || count(*) FILTER (WHERE has_function_privilege('anon', p.oid, 'EXECUTE') OR has_function_privilege('authenticated', p.oid, 'EXECUTE') OR has_function_privilege('service_role', p.oid, 'EXECUTE'))
                       || '|' || coalesce(string_agg(DISTINCT pg_get_userbyid(proowner), ','), '') || '|'
                       || coalesce(md5(string_agg(p.oid::regprocedure::text || ':' || prosecdef || ':' || coalesce(array_to_string(proconfig, ','), '') || ':' || md5(replace(prosrc, E'\\r', '')), ',' ORDER BY p.oid::regprocedure::text)), '')
                      FROM pg_proc p WHERE pronamespace = to_regnamespace('wa')),
    'wa_definers', (SELECT coalesce(json_agg(p.oid::regprocedure::text ORDER BY 1), '[]') FROM pg_proc p WHERE pronamespace = to_regnamespace('wa') AND prosecdef),
    'tables', (SELECT coalesce(json_agg(c.relname || ':' || c.relrowsecurity || ':' || coalesce(c.relacl::text, 'NULL') ORDER BY c.relname), '[]')
                FROM pg_class c WHERE c.relnamespace = 'public'::regnamespace AND c.relname IN ('document_file', 'document_link', 'purchase_payment_allocation')),
    'policies', (SELECT coalesce(json_agg(CASE WHEN schemaname = 'storage' THEN tablename || ':' || policyname || ':' || cmd || ':' || array_to_string(roles, ',')
                                               ELSE tablename || ':' || policyname || ':' || cmd || ':' || array_to_string(roles, ',') || ':' || coalesce(qual, '') || ':' || coalesce(with_check, '') END ORDER BY tablename, policyname), '[]')
                  FROM pg_policies WHERE (schemaname = 'public' AND tablename IN ('document_file', 'document_link', 'purchase_payment_allocation'))
                     OR (schemaname = 'storage' AND tablename = 'objects' AND (policyname LIKE 'wa\\_media%' OR coalesce(qual, '') || coalesce(with_check, '') LIKE '%wa-media%'))),
    'storage_policy_bodies', (SELECT coalesce(json_agg(policyname || ':' || md5(coalesce(qual, '') || '|' || coalesce(with_check, '')) ORDER BY policyname), '[]')
                               FROM pg_policies WHERE schemaname = 'storage' AND policyname LIKE 'wa\\_media%'),
    'views', (SELECT coalesce(json_agg(c.relname || ':' || md5(pg_get_viewdef(c.oid)) || ':' || coalesce(c.reloptions::text, '-') || ':' || pg_get_userbyid(c.relowner) || ':' || coalesce(c.relacl::text, 'NULL') ORDER BY c.relname), '[]')
               FROM pg_class c WHERE c.relnamespace = 'public'::regnamespace AND c.relname IN (${NEW_VIEWS.map(lit).join(', ')})),
    'bucket', (SELECT id || '|' || public || '|' || file_size_limit || '|' || array_to_string(allowed_mime_types, ',') FROM storage.buckets WHERE id = 'wa-media'),
    'triggers', (SELECT coalesce(json_agg(tgname || ':' || tgrelid::regclass || ':' || tgenabled::text || ':' || tgtype || ':' || tgdeferrable || tginitdeferred || ':' || tgfoid::regproc ORDER BY tgname), '[]')
                  FROM pg_trigger WHERE NOT tgisinternal AND tgname IN (${TRIGGERS.map((t) => lit(t.split(':')[0])).join(', ')})),
    'columns', (SELECT string_agg(column_name || ':' || data_type, ',' ORDER BY column_name) FROM information_schema.columns
                 WHERE (table_schema = 'wa' AND table_name = 'inbound_message' AND column_name IN ('caption', 'media_mime', 'media_file_name'))
                    OR (table_schema = 'public' AND table_name = 'financial_instrument' AND column_name = 'replaces_instrument_id')),
    'activity', (SELECT 'document_file=' || (SELECT count(*) FROM document_file) || '|document_link=' || (SELECT count(*) FROM document_link)
                   || '|allocation=' || (SELECT count(*) FROM purchase_payment_allocation) || '|wa_media=' || (SELECT count(*) FROM storage.objects WHERE bucket_id = 'wa-media')))
)::text;`;
}

/** Evaluates the JSON result. Returns [{ label, ok, detail }]. */
export function evaluate(s, ctx) {
  const a = s.a0104 ?? {};
  // the 0100-level state, the 0101 additions, the 0102 additions, as served to the earlier profiles minus what 0103 / 0104 add
  const base = s.prev.prev.prev;
  const inner = {
    ...s.prev,
    prev: { ...s.prev.prev,
      prev: { ...base, definers: base.definers.filter((d) => !NEW_DEFINERS.includes(d)), table_grants: base.table_grants.filter((g) => !NEW_VIEWS.includes(g.split(':')[0])) },
      a0101: { ...s.prev.prev.a0101, triggers: s.prev.prev.a0101.triggers.filter((t) => !t.startsWith('trg_expense_pending_document_carry:')) } },
  };
  const replaced = ['A ledger ', '0102 entry points:', '0102 wa functions:'];
  const out = prev.evaluate(inner, ctx).filter((c) => !replaced.some((r) => c.label.startsWith(r)));
  const check = (label, ok, detail = '') => out.push({ label, ok: !!ok, detail });
  out.unshift({ label: `A ledger ${ctx.expectedLedger} rows, last ${THROUGH}`, ok: base.ledger_count === ctx.expectedLedger && base.ledger_max === THROUGH,
    detail: `${base.ledger_count} / ${base.ledger_max}` });
  check('0103 / 0104 ledger rows = repository files (name + full sha256)',
    JSON.stringify(a.ledger) === JSON.stringify(MIGRATIONS.map((f) => `${f}|${shaOf(ctx.repo, f)}`)), JSON.stringify(a.ledger).slice(0, 120));
  check('0104 SECURITY DEFINER: exactly +7 (register_erp_document, issue_purchase_instruments, allocate_purchase_payment, attach_instrument_document, wa_store_media, wa_media_writer, wa_media_reader)',
    NEW_DEFINERS.every((d) => base.definers.includes(d)), `missing=[${NEW_DEFINERS.filter((d) => !base.definers.includes(d)).join(' ')}]`);
  check('0103 entry points: exactly the 11 public.wa_*, DEFINER, owner postgres, search_path = public, pg_temp, EXECUTE authenticated only, bodies as in 0103 (wa_cancel / wa_context / wa_expire / wa_link_mp as in 0102)',
    JSON.stringify(a.entry_points) === JSON.stringify(ENTRY_POINTS), JSON.stringify(a.entry_points));
  check('0103 wa functions: 27, no API EXECUTE, owner postgres; the only DEFINER ones are the four 0102 entry-point bodies moved to wa.*_0102',
    a.wa_functions === WA_FUNCTIONS && JSON.stringify(a.wa_definers) === JSON.stringify(WA_DEFINERS), `${a.wa_functions} ${JSON.stringify(a.wa_definers)}`);
  check('0104 functions: the four ADMIN RPCs DEFINER (EXECUTE authenticated only), the helpers INVOKER with no API EXECUTE (purchase_chain_root: authenticated, read by the invoker view), bodies as in 0103 / 0104',
    JSON.stringify(a.functions) === JSON.stringify(FUNCTIONS_0104), JSON.stringify(a.functions));
  check('0103 / 0104 tables document_file, document_link, purchase_payment_allocation: RLS on, SELECT for authenticated only',
    JSON.stringify(a.tables) === JSON.stringify(TABLES), JSON.stringify(a.tables));
  check('0103 / 0104 policies: one ADMIN SELECT per table; wa-media: exactly the gateway INSERT and the reader SELECT (no UPDATE / DELETE)',
    JSON.stringify(a.policies) === JSON.stringify(POLICIES), JSON.stringify(a.policies));
  check('0103 wa-media policy bodies: the bucket CASE + wa_media_writer() + key wa/<sha256>.<ext> / wa_media_reader()',
    Array.isArray(a.storage_policy_bodies) && a.storage_policy_bodies.length === 2, JSON.stringify(a.storage_policy_bodies));
  check('0103 bucket wa-media: private, 10 MB, PDF / JPEG / PNG / WebP', a.bucket === 'wa-media|false|10485760|application/pdf,image/jpeg,image/png,image/webp', String(a.bucket));
  check('0103 / 0104 views: security_invoker, owner postgres, SELECT for authenticated only, definitions as in 0103 / 0104',
    JSON.stringify(a.views) === JSON.stringify(VIEWS), JSON.stringify(a.views));
  check('0103 / 0104 grants of the new fin_% views: SELECT for authenticated only',
    JSON.stringify(s.prev.prev.prev.table_grants.filter((g) => NEW_VIEWS.includes(g.split(':')[0]))) === JSON.stringify(NEW_VIEWS.map((v) => `${v}:authenticated:SELECT`).sort()),
    s.prev.prev.prev.table_grants.filter((g) => NEW_VIEWS.includes(g.split(':')[0])).join(' '));
  check('0103 / 0104 triggers: document guards, the confirmation link on wa.draft, the carry on expense_pending_resolution, the allocation guard',
    JSON.stringify(a.triggers) === JSON.stringify(TRIGGERS), JSON.stringify(a.triggers));
  check('0103 / 0104 columns: wa.inbound_message caption / media_file_name / media_mime; financial_instrument.replaces_instrument_id',
    a.columns === 'caption:text,media_file_name:text,media_mime:text,replaces_instrument_id:uuid', String(a.columns));
  if (ctx.deploymentCheck) check('DEPLOYMENT CHECK 0104: no document, link, allocation or wa-media object yet', a.activity === 'document_file=0|document_link=0|allocation=0|wa_media=0', String(a.activity));
  return out;
}
