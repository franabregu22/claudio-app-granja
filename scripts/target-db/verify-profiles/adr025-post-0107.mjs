/**
 * Verification profile ADR025_POST_0107 — the exact database state after target migrations 0001…0107
 * (0107: purchase_casual_settlement_check(), the deferred "paid OR pending" rule of 0106, runs as its owner — SECURITY DEFINER,
 * search_path = public, pg_temp — so the commit-time check no longer depends on the caller's ERP profile; same body, same trigger).
 *
 * The whole 0001…0106 state is verified by ADR025_POST_0106. Removed from it before evaluating, and checked here exactly instead:
 * the new SECURITY DEFINER identity (D) and that function's row in the 0106 function check (translated back to its 0106 value).
 * A is replaced.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as prev from './adr025-post-0106.mjs';

export const NAME = 'ADR025_POST_0107';
export const THROUGH = '0107';
const MIGRATION = '0107_pending_expense_commit_check.sql';
const NEW_DEFINER = 'purchase_casual_settlement_check()';
const ROW_0106 = 'purchase_casual_settlement_check()|false|postgres|search_path=public|falsefalsefalse|2093295fb896b40476e18708fd586783';
const ROW_0107 = 'purchase_casual_settlement_check()|true|postgres|search_path=public, pg_temp|falsefalsefalse|2093295fb896b40476e18708fd586783';

const shaOf = (repo, f) => createHash('sha256').update(readFileSync(join(repo, 'supabase', 'target-migrations', f), 'utf8')).digest('hex');

export function buildSql(repo) {
  return `SELECT json_build_object('prev', ${prev.innerJson(prev.buildSql(repo))},
  'a0107', json_build_object(
    'ledger', (SELECT filename || '|' || sha256 FROM migration_ledger.applied WHERE version = '0107'),
    'trigger', (SELECT tgname || ':' || tgrelid::regclass || ':' || tgenabled::text || ':' || tgtype || ':' || tgdeferrable || tginitdeferred || ':' || tgfoid::regproc
                  FROM pg_trigger WHERE NOT tgisinternal AND tgname = 'trg_purchases_casual_settlement'))
)::text;`;
}

/** Evaluates the JSON result. Returns [{ label, ok, detail }]. */
export function evaluate(s, ctx) {
  const a = s.a0107 ?? {};
  // the 0106 state as POST_0106 knows it: without the 0107 definer, the function row as 0106 left it
  const inner = JSON.parse(JSON.stringify(s.prev));
  const base = inner.prev.prev.prev.prev.prev;
  base.definers = base.definers.filter((d) => d !== NEW_DEFINER);
  const fnRow = (inner.a0106?.functions ?? []).find((r) => r.startsWith(`${NEW_DEFINER}|`));
  inner.a0106.functions = (inner.a0106?.functions ?? []).map((r) => (r === ROW_0107 ? ROW_0106 : r));
  const out = prev.evaluate(inner, ctx).filter((c) => !c.label.startsWith('A ledger '));
  const check = (label, ok, detail = '') => out.push({ label, ok: !!ok, detail });
  const real = s.prev.prev.prev.prev.prev.prev;
  out.unshift({ label: `A ledger ${ctx.expectedLedger} rows, last ${THROUGH}`, ok: real.ledger_count === ctx.expectedLedger && real.ledger_max === THROUGH,
    detail: `${real.ledger_count} / ${real.ledger_max}` });
  check('0107 ledger row = repository file (name + full sha256)', a.ledger === `${MIGRATION}|${shaOf(ctx.repo, MIGRATION)}`, String(a.ledger).slice(0, 60));
  check('0107 SECURITY DEFINER: exactly +1 (purchase_casual_settlement_check)', real.definers.includes(NEW_DEFINER), real.definers.length);
  check('0107 purchase_casual_settlement_check: DEFINER, owner postgres, search_path = public, pg_temp, no EXECUTE for anon / authenticated / service_role, 0106 body',
    fnRow === ROW_0107, String(fnRow));
  check('0107 trigger unchanged: deferred to commit, on purchases, executes purchase_casual_settlement_check',
    a.trigger === 'trg_purchases_casual_settlement:purchases:O:21:truetrue:purchase_casual_settlement_check', String(a.trigger));
  return out;
}
