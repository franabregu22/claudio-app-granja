/**
 * Verification profile ADR025_POST_0102 — the exact database state after target migrations 0001…0102
 * (0102, ADR-025: WhatsApp expense gateway — schema wa owned by postgres with no API privilege, its 7 tables RLS-enabled and
 * unreachable from the API, its 18 internal functions INVOKER with no API EXECUTE; the 8 entry points public.wa_* SECURITY
 * DEFINER, owner postgres, search_path = public, pg_temp, EXECUTE authenticated only; the ADMIN-only owner-rights view
 * fin_mp_whatsapp_notes; NO staging-only schema sim; wa.config and wa.sender EMPTY → every public.wa_* call is refused: the
 * bot is OFF after this migration and stays OFF until the owner enables it).
 *
 * The whole 0001…0101 state is verified by ADR025_POST_0101 itself (unchanged). Only A (ledger length / last version → 0102)
 * is replaced, and the eight 0102 entry points are checked here and removed before the 0101 exact SECURITY DEFINER set check; the
 * grant of the view fin_mp_whatsapp_notes (a fin_% relation) is checked here and removed before the K exact grant check.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as prev from './adr025-post-0101.mjs';

export const NAME = 'ADR025_POST_0102';
export const THROUGH = '0102';
const MIGRATION = '0102_wa_whatsapp_gateway.sql';
const OWN = 'true|postgres|search_path=public, pg_temp|falsetruefalse';
// identity | DEFINER | owner | proconfig | EXECUTE anon / authenticated / service_role | body md5
const ENTRY_POINTS = [
  `wa_cancel(bigint,uuid,integer)|${OWN}|36b00d25cbd361972c93dd3263245d5e`,
  `wa_confirm(bigint,uuid,integer)|${OWN}|5d31e67a126625c54c959eca05f707bc`,
  `wa_context(bigint)|${OWN}|6a63e948aa988fd6d9e50c2b01e6833d`,
  `wa_correct(bigint,uuid,integer,jsonb)|${OWN}|0977093fb29d607f0ed6bae3e32c4b35`,
  `wa_expire()|${OWN}|b6418417e9847010f9b55a2e0f0dcb25`,
  `wa_ingest(text,text)|${OWN}|8e2b79e15826faa39a4c14618d4093d5`,
  `wa_link_mp(bigint,uuid,integer,text)|${OWN}|3565711316fe4bc8b3ff1d17dd214b82`,
  `wa_propose(bigint,text,jsonb)|${OWN}|53fb017c29cbb6662a40e1a3be93f8fa`,
];
const DEFINERS_0102 = ENTRY_POINTS.map((e) => e.split('|')[0]);
const PRIVATE = '{postgres=arwdDxtm/postgres}';
const SEQ = '{postgres=rwU/postgres}';
const WA_RELATIONS = [
  `audit_event:r:true:${PRIVATE}`, `audit_event_id_seq:S:false:${SEQ}`, `config:r:true:${PRIVATE}`, `confirmation:r:true:${PRIVATE}`,
  `draft:r:true:${PRIVATE}`, `draft_code_seq:S:false:${SEQ}`, `draft_version:r:true:${PRIVATE}`, `inbound_message:r:true:${PRIVATE}`,
  `inbound_message_id_seq:S:false:${SEQ}`, `sender:r:true:${PRIVATE}`,
];
const WA_FUNCTIONS = '18|0|0|postgres|651d781647b0e696b5a213523aed0420';   // count | DEFINER | API EXECUTE | owners | fingerprint
const NOTES_VIEW = 'fin_mp_whatsapp_notes:460e8027415dcabd00190382610aa3b7:{security_barrier=true}:postgres:{postgres=arwdDxtm/postgres,authenticated=r/postgres}';

const shaOf = (repo, f) => createHash('sha256').update(readFileSync(join(repo, 'supabase', 'target-migrations', f), 'utf8')).digest('hex');

export function buildSql(repo) {
  return `SELECT json_build_object('prev', ${prev.innerJson(prev.buildSql(repo))},
  'a0102', json_build_object(
    'ledger', (SELECT filename || '|' || sha256 FROM migration_ledger.applied WHERE version = '0102'),
    'entry_points', (SELECT coalesce(json_agg(p.oid::regprocedure::text || '|' || prosecdef || '|' || pg_get_userbyid(proowner) || '|' || coalesce(array_to_string(proconfig, ','), '') || '|'
                       || has_function_privilege('anon', p.oid, 'EXECUTE') || has_function_privilege('authenticated', p.oid, 'EXECUTE') || has_function_privilege('service_role', p.oid, 'EXECUTE')
                       || '|' || md5(replace(prosrc, E'\\r', '')) ORDER BY p.oid::regprocedure::text), '[]')
                     FROM pg_proc p WHERE pronamespace = 'public'::regnamespace AND proname LIKE 'wa\\_%'),
    'wa_schema', (SELECT pg_get_userbyid(nspowner) || '|' || coalesce(nspacl::text, 'NULL') || '|' || has_schema_privilege('anon', oid, 'USAGE')
                    || has_schema_privilege('authenticated', oid, 'USAGE') || has_schema_privilege('service_role', oid, 'USAGE') FROM pg_namespace WHERE nspname = 'wa'),
    'wa_relations', (SELECT coalesce(json_agg(c.relname || ':' || c.relkind::text || ':' || c.relrowsecurity || ':' || coalesce(c.relacl::text, 'NULL') ORDER BY c.relname), '[]')
                      FROM pg_class c WHERE c.relnamespace = to_regnamespace('wa') AND c.relkind IN ('r', 'v', 'm', 'S', 'p', 'f')),
    'wa_functions', (SELECT count(*) || '|' || count(*) FILTER (WHERE prosecdef) || '|'
                       || count(*) FILTER (WHERE has_function_privilege('anon', p.oid, 'EXECUTE') OR has_function_privilege('authenticated', p.oid, 'EXECUTE') OR has_function_privilege('service_role', p.oid, 'EXECUTE'))
                       || '|' || coalesce(string_agg(DISTINCT pg_get_userbyid(proowner), ','), '') || '|'
                       || coalesce(md5(string_agg(p.oid::regprocedure::text || ':' || prosecdef || ':' || coalesce(array_to_string(proconfig, ','), '') || ':' || md5(replace(prosrc, E'\\r', '')), ',' ORDER BY p.oid::regprocedure::text)), '')
                      FROM pg_proc p WHERE pronamespace = to_regnamespace('wa')),
    'notes_view', (SELECT c.relname || ':' || md5(pg_get_viewdef(c.oid)) || ':' || coalesce(c.reloptions::text, '-') || ':' || pg_get_userbyid(c.relowner) || ':' || coalesce(c.relacl::text, 'NULL')
                    FROM pg_class c WHERE c.oid = to_regclass('public.fin_mp_whatsapp_notes')),
    'bot', (SELECT 'config=' || (SELECT count(*) FROM wa.config) || '|sender=' || (SELECT count(*) FROM wa.sender)),
    'activity', (SELECT 'draft=' || (SELECT count(*) FROM wa.draft) || '|inbound=' || (SELECT count(*) FROM wa.inbound_message) || '|confirmation=' || (SELECT count(*) FROM wa.confirmation)),
    'sim_absent', (to_regnamespace('sim') IS NULL))
)::text;`;
}

/** Evaluates the JSON result. Returns [{ label, ok, detail }]. */
export function evaluate(s, ctx) {
  const p = s.prev;
  const a = s.a0102 ?? {};
  const inner = { ...p, prev: { ...p.prev, definers: p.prev.definers.filter((d) => !DEFINERS_0102.includes(d)),
    table_grants: p.prev.table_grants.filter((g) => !g.startsWith('fin_mp_whatsapp_notes:')) } };
  const out = prev.evaluate(inner, ctx).filter((c) => !c.label.startsWith('A ledger '));
  const check = (label, ok, detail = '') => out.push({ label, ok: !!ok, detail });
  out.unshift({ label: `A ledger ${ctx.expectedLedger} rows, last ${THROUGH}`, ok: p.prev.ledger_count === ctx.expectedLedger && p.prev.ledger_max === THROUGH,
    detail: `${p.prev.ledger_count} / ${p.prev.ledger_max}` });
  check('0102 ledger row = repository file (name + full sha256)', a.ledger === `${MIGRATION}|${shaOf(ctx.repo, MIGRATION)}`, String(a.ledger).slice(0, 60));
  check('0102 SECURITY DEFINER: exactly +8 (the public.wa_* entry points; the rest of D is the 0101 set)',
    DEFINERS_0102.every((d) => p.prev.definers.includes(d)), `missing=[${DEFINERS_0102.filter((d) => !p.prev.definers.includes(d)).join(' ')}]`);
  check('0102 entry points: exactly the 8 public.wa_*, DEFINER, owner postgres, search_path = public, pg_temp, EXECUTE authenticated only (not anon, not service_role), bodies as in 0102',
    JSON.stringify(a.entry_points) === JSON.stringify(ENTRY_POINTS), JSON.stringify(a.entry_points));
  check('0102 schema wa: owner postgres, no privilege for PUBLIC / anon / authenticated / service_role',
    a.wa_schema === 'postgres|{postgres=UC/postgres}|falsefalsefalse', String(a.wa_schema));
  check('0102 wa relations: the 7 tables RLS-enabled, the 3 sequences; postgres-only privileges (unreachable from the API)',
    JSON.stringify(a.wa_relations) === JSON.stringify(WA_RELATIONS), JSON.stringify(a.wa_relations));
  check('0102 wa functions: 18, all INVOKER, no API EXECUTE, owner postgres, bodies as in 0102', a.wa_functions === WA_FUNCTIONS, String(a.wa_functions));
  check('0102 grants on fin_mp_whatsapp_notes: SELECT for authenticated only', JSON.stringify(p.prev.table_grants.filter((g) => g.startsWith('fin_mp_whatsapp_notes:'))) === JSON.stringify(['fin_mp_whatsapp_notes:authenticated:SELECT']),
    p.prev.table_grants.filter((g) => g.startsWith('fin_mp_whatsapp_notes:')).join(' '));
  check('0102 fin_mp_whatsapp_notes: owner rights + security_barrier, ADMIN filter in the definition, SELECT for authenticated only',
    a.notes_view === NOTES_VIEW, String(a.notes_view));
  check('0102 BOT OFF: wa.config and wa.sender empty (every public.wa_* call is refused until the owner enables it)', a.bot === 'config=0|sender=0', String(a.bot));
  check('0102 no staging-only schema sim', a.sim_absent === true, String(a.sim_absent));
  if (ctx.deploymentCheck) check('DEPLOYMENT CHECK 0102: no WhatsApp draft, inbound message or confirmation yet', a.activity === 'draft=0|inbound=0|confirmation=0', String(a.activity));
  return out;
}
