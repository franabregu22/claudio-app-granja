/**
 * Verification profile ADR025_POST_0105 — the exact database state after target migrations 0001…0105
 * (0105: fin_mp_pending_classification redefined for performance only — same columns, criteria, ADMIN rule, security_invoker,
 * owner and grants; the historical identity is computed apart so the join uses mp_historical_row_identity_key).
 *
 * The whole 0001…0104 state is verified by ADR025_POST_0104 itself. The only object 0105 changes is that view's text: the earlier
 * profiles pin its md5 (X ADR-021 / X ADR-023), so the 0105 md5 is checked here and translated back to the 0095 md5 before they
 * evaluate; everything else they check is untouched. A (ledger length / last version) is replaced.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as prev from './adr025-post-0104.mjs';

export const NAME = 'ADR025_POST_0105';
export const THROUGH = '0105';
const MIGRATION = '0105_mp_pending_classification_performance.sql';
const VIEW_0095 = 'ebe8a0be6bb42c088c66cb6ed12f91d3';   // fin_mp_pending_classification as defined by 0095
const VIEW_0105 = '401d71b0046a233dee028bc8fbdedda0';   // the same view as redefined by 0105
const SUMMARY = '833651b7b070fbaebe5f26e0d5556666';     // fin_mp_pending_summary (unchanged since 0095)
const ACL = '{postgres=arwdDxtm/postgres,authenticated=r/postgres}';

const shaOf = (repo, f) => createHash('sha256').update(readFileSync(join(repo, 'supabase', 'target-migrations', f), 'utf8')).digest('hex');

export function innerJson(sql) {
  const m = /^SELECT ([\s\S]*)::text;$/.exec(sql.trim());
  if (!m) throw new Error(`profile ${NAME}: unexpected query shape of the previous profile`);
  return m[1];
}

export function buildSql(repo) {
  return `SELECT json_build_object('prev', ${innerJson(prev.buildSql(repo))},
  'a0105', json_build_object(
    'ledger', (SELECT filename || '|' || sha256 FROM migration_ledger.applied WHERE version = '0105'),
    'views', (SELECT json_object_agg(c.relname, md5(pg_get_viewdef(c.oid)) || ':' || (c.reloptions @> ARRAY['security_invoker=true']) || ':' || pg_get_userbyid(c.relowner) || ':' || coalesce(c.relacl::text, 'NULL') ORDER BY c.relname)
               FROM pg_class c WHERE c.relnamespace = 'public'::regnamespace AND c.relname IN ('fin_mp_pending_classification', 'fin_mp_pending_summary')),
    'columns', (SELECT string_agg(attname || ':' || format_type(atttypid, atttypmod), ',' ORDER BY attnum) FROM pg_attribute
                 WHERE attrelid = 'public.fin_mp_pending_classification'::regclass AND attnum > 0 AND NOT attisdropped))
)::text;`;
}

/** Evaluates the JSON result. Returns [{ label, ok, detail }]. */
export function evaluate(s, ctx) {
  const a = s.a0105 ?? {};
  // the earlier profiles pin the 0095 text of the view: give them that md5 back (only that value; checked exactly below)
  const inner = JSON.parse(JSON.stringify(s.prev).split(VIEW_0105).join(VIEW_0095));
  const base = inner.prev.prev.prev;
  const out = prev.evaluate(inner, ctx).filter((c) => !c.label.startsWith('A ledger '));
  const check = (label, ok, detail = '') => out.push({ label, ok: !!ok, detail });
  out.unshift({ label: `A ledger ${ctx.expectedLedger} rows, last ${THROUGH}`, ok: base.ledger_count === ctx.expectedLedger && base.ledger_max === THROUGH,
    detail: `${base.ledger_count} / ${base.ledger_max}` });
  check('0105 ledger row = repository file (name + full sha256)', a.ledger === `${MIGRATION}|${shaOf(ctx.repo, MIGRATION)}`, String(a.ledger).slice(0, 60));
  check('0105 fin_mp_pending_classification: the 0105 definition, security_invoker, owner postgres, SELECT for authenticated only; fin_mp_pending_summary unchanged',
    JSON.stringify(a.views) === JSON.stringify({ fin_mp_pending_classification: `${VIEW_0105}:true:postgres:${ACL}`, fin_mp_pending_summary: `${SUMMARY}:true:postgres:${ACL}` }),
    JSON.stringify(a.views));
  check('0105 fin_mp_pending_classification columns unchanged (names, types, order)',
    a.columns === 'pending_key:text,source_id:text,kind:text,direction:text,business_date:date,occurred_at:timestamp with time zone,amount:numeric(15,2),economic_amount:numeric,charges_amount:numeric,account_name:text,description:text,status:text,already_posted:boolean,financial_operation_id:bigint,is_historical:boolean,destination_status:text,destination_last4:text,matched_account_name:text',
    String(a.columns));
  return out;
}
