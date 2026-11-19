/**
 * Verification profile ADR025_POST_0134 — the exact database state after target migrations 0001…0134 (erp-mejoras):
 *   0134 WhatsApp conversation memory: wa.inbound_message.bot_reply / bot_reply_at (+ CHECK), index wa_inbound_sender_recent,
 *        public.wa_note_reply (new entry point, DEFINER, EXECUTE authenticated only) and public.wa_context re-created with the same
 *        identity (0102 body + «history»). Nothing written.
 *
 * The whole 0001…0133 state is verified by ADR025_POST_0133; before evaluating it the new entry point is taken out (the earlier
 * profiles pin the DEFINER identity list and the exact public.wa_* list) and the re-created wa_context body is translated back to
 * the one the earlier profiles pinned (0102). The 0134 objects are checked here exactly. A is replaced.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as prev from './adr025-post-0133.mjs';

export const NAME = 'ADR025_POST_0134';
export const THROUGH = '0134';
const MIGRATION = '0134_wa_memoria_conversacion.sql';
const NEW_MARKERS = ['wa_note_reply'];
/** re-created function → the migration whose body the earlier profiles pinned */
const OLD_BODY = { wa_context: '0102_wa_whatsapp_gateway.sql' };
const OWN = 'true|postgres|search_path=public, pg_temp|falsetruefalse';

const shaOf = (repo, f) => createHash('sha256').update(readFileSync(join(repo, 'supabase', 'target-migrations', f), 'utf8')).digest('hex');
function innerJson(sql) {
  const m = /^SELECT ([\s\S]*)::text;$/.exec(sql.trim());
  if (!m) throw new Error(`profile ${NAME}: unexpected query shape of the previous profile`);
  return m[1];
}
function find(o, key) {
  if (!o || typeof o !== 'object') return null;
  if (Object.prototype.hasOwnProperty.call(o, key)) return o;
  for (const v of Object.values(o)) { const r = find(v, key); if (r) return r; }
  return null;
}
/** The md5 of a function body as pg_proc.prosrc stores it (the last definition of that name in the file). */
function bodyMd5(repo, file, fn) {
  const text = readFileSync(join(repo, 'supabase', 'target-migrations', file), 'utf8').replace(/\r/g, '');
  const re = /CREATE (?:OR REPLACE )?FUNCTION (?:public\.)?(\w+)\([\s\S]*?\bAS \$\$([\s\S]*?)\$\$;/g;
  let m; let last = 'missing';
  while ((m = re.exec(text))) if (m[1] === fn) last = createHash('md5').update(m[2]).digest('hex');
  return last;
}
/** Walks the previous profile's result: drops every string / key naming a 0134 object, translates the re-created body back. */
function back(node, repo, nuevos) {
  if (Array.isArray(node)) {
    return node.filter((x) => !(typeof x === 'string' && NEW_MARKERS.some((k) => x.includes(k)))).map((x) => back(x, repo, nuevos));
  }
  if (node && typeof node === 'object') {
    const o = {};
    for (const [k, v] of Object.entries(node)) if (!NEW_MARKERS.some((m) => k.includes(m))) o[k] = back(v, repo, nuevos);
    return o;
  }
  if (typeof node === 'string') {
    for (const [fn, md5] of Object.entries(nuevos)) {
      if (node.includes(md5) && node.includes(`${fn}(`)) return node.replace(md5, bodyMd5(repo, OLD_BODY[fn], fn));
      if (node === md5) return bodyMd5(repo, OLD_BODY[fn], fn);
    }
  }
  return node;
}

export function buildSql(repo) {
  return `SELECT json_build_object('prev', ${innerJson(prev.buildSql(repo))},
  'a0134', json_build_object(
    'ledger', (SELECT filename || '|' || sha256 FROM migration_ledger.applied WHERE version = '0134'),
    'functions', (SELECT coalesce(json_agg(p.oid::regprocedure::text || '|' || p.prosecdef || '|' || pg_get_userbyid(p.proowner) || '|'
        || coalesce(array_to_string(p.proconfig, ','), '') || '|' || has_function_privilege('anon', p.oid, 'EXECUTE')::text
        || has_function_privilege('authenticated', p.oid, 'EXECUTE')::text || has_function_privilege('service_role', p.oid, 'EXECUTE')::text
        || '|' || md5(replace(p.prosrc, E'\\r', '')) ORDER BY p.oid::regprocedure::text), '[]')
        FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname IN ('wa_context', 'wa_note_reply')),
    'columns', (SELECT coalesce(json_agg(column_name || ':' || data_type || ':' || is_nullable ORDER BY column_name), '[]')
        FROM information_schema.columns WHERE table_schema = 'wa' AND table_name = 'inbound_message' AND column_name IN ('bot_reply', 'bot_reply_at')),
    'check', (SELECT count(*) FROM pg_constraint WHERE conrelid = 'wa.inbound_message'::regclass AND contype = 'c' AND pg_get_constraintdef(oid) LIKE '%bot_reply%1000%'),
    'index', (SELECT pg_get_indexdef(i.indexrelid) FROM pg_index i WHERE i.indexrelid = to_regclass('wa.wa_inbound_sender_recent')),
    'replies', (SELECT count(*) FROM wa.inbound_message WHERE bot_reply IS NOT NULL))
)::text;`;
}

/** Evaluates the JSON result. Returns [{ label, ok, detail }]. */
export function evaluate(s, ctx) {
  const a = s.a0134 ?? {};
  const nuevos = Object.fromEntries(Object.keys(OLD_BODY).map((fn) => [fn, bodyMd5(ctx.repo, MIGRATION, fn)]));
  const out = prev.evaluate(back(JSON.parse(JSON.stringify(s.prev)), ctx.repo, nuevos), ctx).filter((c) => !c.label.startsWith('A ledger '));
  const check = (label, ok, detail = '') => out.push({ label, ok: !!ok, detail });
  const real = find(s.prev, 'ledger_count') ?? {};
  out.unshift({ label: `A ledger ${ctx.expectedLedger} rows, last ${THROUGH}`, ok: real.ledger_count === ctx.expectedLedger && real.ledger_max === THROUGH,
    detail: `${real.ledger_count} / ${real.ledger_max}` });
  const eq = (x, y) => JSON.stringify(x) === JSON.stringify(y);
  check('0134 ledger row = repository file (name + full sha256)', a.ledger === `${MIGRATION}|${shaOf(ctx.repo, MIGRATION)}`, String(a.ledger).slice(0, 60));
  check('0134 functions: wa_context (one signature, body with history) and wa_note_reply — DEFINER, owner postgres, search_path = public, pg_temp, EXECUTE authenticated only',
    eq(a.functions, [
      `wa_context(bigint)|${OWN}|${nuevos.wa_context}`,
      `wa_note_reply(bigint,text)|${OWN}|${bodyMd5(ctx.repo, MIGRATION, 'wa_note_reply')}`,
    ]), JSON.stringify(a.functions).slice(0, 400));
  check('0134 columns: wa.inbound_message bot_reply text / bot_reply_at timestamptz, nullable, with the 1–1000 CHECK',
    eq(a.columns, ['bot_reply:text:YES', 'bot_reply_at:timestamp with time zone:YES']) && a.check === 1, `${JSON.stringify(a.columns)} check=${a.check}`);
  check('0134 index wa_inbound_sender_recent (sender, id DESC) on accepted messages',
    a.index === 'CREATE INDEX wa_inbound_sender_recent ON wa.inbound_message USING btree (sender_perfil_id, id DESC) WHERE (outcome = \'ACCEPTED\'::text)', String(a.index));
  if (ctx.deploymentCheck) check('DEPLOYMENT CHECK 0134: no stored bot reply yet', a.replies === 0, String(a.replies));
  return out;
}
