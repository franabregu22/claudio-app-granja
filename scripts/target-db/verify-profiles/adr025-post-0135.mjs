/**
 * Verification profile ADR025_POST_0135 — the exact database state after target migrations 0001…0135 (erp-mejoras):
 *   0135 Factura A on orders + Mercado Pago débitos y créditos tax: pedidos.factura_a, fiscal_document.pedido_id (+ CHECK, unique
 *        indexes), client_cuit / tax_is_debcred_mp (INVOKER) and set_sale_invoice_number (DEFINER), deliver_order /
 *        rectify_delivered_order / fin_operation_list re-created with the same identity, report_bank_tax_period re-created with the same
 *        columns. Nothing written.
 *
 * The whole 0001…0134 state is verified by ADR025_POST_0134; before evaluating it the 0135 objects are taken out and the re-created
 * bodies are translated back to the ones the earlier profiles pinned. The 0135 objects are checked here exactly. A is replaced.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as prev from './adr025-post-0134.mjs';

export const NAME = 'ADR025_POST_0135';
export const THROUGH = '0135';
const MIGRATION = '0135_factura_a_y_debcred_mp.sql';
const NEW_MARKERS = ['set_sale_invoice_number', 'client_cuit', 'tax_is_debcred_mp', 'idx_fiscal_document_pedido', 'idx_fiscal_document_issued_number', 'chk_fiscal_document_pedido'];
/** re-created function → the migration whose body the earlier profiles pinned */
const OLD_BODY = { deliver_order: '0100_pedidos_numero_delivered_by.sql', rectify_delivered_order: '0011_commercial_rpcs.sql', fin_operation_list: '0133_retiro_socio_desde_tabla.sql' };
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
/** Walks the previous profile's result: drops every string / key naming a 0135 object, translates the re-created body back. */
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
  'a0135', json_build_object(
    'ledger', (SELECT filename || '|' || sha256 FROM migration_ledger.applied WHERE version = '0135'),
    'functions', (SELECT coalesce(json_agg(p.oid::regprocedure::text || '|' || p.prosecdef || '|' || pg_get_userbyid(p.proowner) || '|'
        || coalesce(array_to_string(p.proconfig, ','), '') || '|' || has_function_privilege('anon', p.oid, 'EXECUTE')::text
        || has_function_privilege('authenticated', p.oid, 'EXECUTE')::text || has_function_privilege('service_role', p.oid, 'EXECUTE')::text
        || '|' || md5(replace(p.prosrc, E'\\r', '')) ORDER BY p.oid::regprocedure::text), '[]')
        FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace
         AND p.proname IN ('client_cuit', 'deliver_order', 'fin_operation_list', 'rectify_delivered_order', 'set_sale_invoice_number', 'tax_is_debcred_mp')),
    'columns', (SELECT coalesce(json_agg(table_name || '.' || column_name || ':' || data_type || ':' || is_nullable || ':' || coalesce(column_default, '') ORDER BY table_name), '[]')
        FROM information_schema.columns WHERE table_schema = 'public'
         AND ((table_name = 'pedidos' AND column_name = 'factura_a') OR (table_name = 'fiscal_document' AND column_name = 'pedido_id'))),
    'constraints', (SELECT coalesce(json_agg(conname || ':' || pg_get_constraintdef(oid) ORDER BY conname), '[]')
        FROM pg_constraint WHERE conrelid = 'public.fiscal_document'::regclass AND conname IN ('chk_fiscal_document_pedido', 'fiscal_document_pedido_id_fkey')),
    'indexes', (SELECT coalesce(json_agg(pg_get_indexdef(i.indexrelid) ORDER BY pg_get_indexdef(i.indexrelid)), '[]') FROM pg_index i
        WHERE i.indexrelid IN (to_regclass('public.idx_fiscal_document_pedido'), to_regclass('public.idx_fiscal_document_issued_number'))),
    'view', (SELECT c.reloptions::text || '|' || pg_get_userbyid(c.relowner) || '|' || coalesce(c.relacl::text, '') || '|'
        || (SELECT string_agg(attname || ':' || format_type(atttypid, atttypmod), ',' ORDER BY attnum) FROM pg_attribute WHERE attrelid = c.oid AND attnum > 0)
        FROM pg_class c WHERE c.oid = to_regclass('public.report_bank_tax_period')),
    'view_reads_mp', (SELECT pg_get_viewdef('public.report_bank_tax_period'::regclass) LIKE '%tax_is_debcred_mp%'),
    'factura_a', (SELECT count(*) FROM pedidos WHERE factura_a),
    'order_invoices', (SELECT count(*) FROM fiscal_document WHERE pedido_id IS NOT NULL))
)::text;`;
}

/** Evaluates the JSON result. Returns [{ label, ok, detail }]. */
export function evaluate(s, ctx) {
  const a = s.a0135 ?? {};
  const nuevos = Object.fromEntries(Object.keys(OLD_BODY).map((fn) => [fn, bodyMd5(ctx.repo, MIGRATION, fn)]));
  const out = prev.evaluate(back(JSON.parse(JSON.stringify(s.prev)), ctx.repo, nuevos), ctx).filter((c) => !c.label.startsWith('A ledger '));
  const check = (label, ok, detail = '') => out.push({ label, ok: !!ok, detail });
  const real = find(s.prev, 'ledger_count') ?? {};
  out.unshift({ label: `A ledger ${ctx.expectedLedger} rows, last ${THROUGH}`, ok: real.ledger_count === ctx.expectedLedger && real.ledger_max === THROUGH,
    detail: `${real.ledger_count} / ${real.ledger_max}` });
  const eq = (x, y) => JSON.stringify(x) === JSON.stringify(y);
  const md = (fn) => bodyMd5(ctx.repo, MIGRATION, fn);
  const INV = 'false|postgres|search_path=public, pg_temp|falsetruefalse';
  check('0135 ledger row = repository file (name + full sha256)', a.ledger === `${MIGRATION}|${shaOf(ctx.repo, MIGRATION)}`, String(a.ledger).slice(0, 60));
  check('0135 functions: deliver_order / rectify_delivered_order / fin_operation_list re-created (0135 bodies, same rights); set_sale_invoice_number DEFINER; client_cuit / tax_is_debcred_mp INVOKER; never anon',
    eq(a.functions, [
      `client_cuit(text)|${INV}|${md('client_cuit')}`,
      `deliver_order(uuid,timestamp with time zone,text)|true|postgres|search_path=public|falsetruetrue|${md('deliver_order')}`,
      `fin_operation_list(date,date,text,uuid,boolean,text,uuid,uuid,text,uuid,text,numeric,text,text,integer,integer,uuid,boolean)|${OWN}|${md('fin_operation_list')}`,
      `rectify_delivered_order(uuid,jsonb,text)|true|postgres|search_path=public|falsetruetrue|${md('rectify_delivered_order')}`,
      `set_sale_invoice_number(uuid,text)|${OWN}|${md('set_sale_invoice_number')}`,
      `tax_is_debcred_mp(text)|${INV}|${md('tax_is_debcred_mp')}`,
    ]), JSON.stringify(a.functions).slice(0, 1200));
  check('0135 columns: pedidos.factura_a boolean NOT NULL default false; fiscal_document.pedido_id uuid nullable',
    eq(a.columns, ['fiscal_document.pedido_id:uuid:YES:', 'pedidos.factura_a:boolean:NO:false']), JSON.stringify(a.columns));
  check('0135 fiscal_document: pedido_id → pedidos (RESTRICT / CASCADE), only on an issued document with its client',
    eq(a.constraints, [
      "chk_fiscal_document_pedido:CHECK (((pedido_id IS NULL) OR ((direction = 'DEBITO'::fiscal_direction) AND (cliente_id IS NOT NULL))))",
      'fiscal_document_pedido_id_fkey:FOREIGN KEY (pedido_id) REFERENCES pedidos(id) ON UPDATE CASCADE ON DELETE RESTRICT',
    ]), JSON.stringify(a.constraints));
  check('0135 indexes: one invoice per order; an issued number unique per document type',
    eq(a.indexes, [
      "CREATE UNIQUE INDEX idx_fiscal_document_issued_number ON public.fiscal_document USING btree (document_type, external_number) WHERE ((direction = 'DEBITO'::fiscal_direction) AND (external_number IS NOT NULL))",
      'CREATE UNIQUE INDEX idx_fiscal_document_pedido ON public.fiscal_document USING btree (pedido_id) WHERE (pedido_id IS NOT NULL)',
    ]), JSON.stringify(a.indexes));
  check('0135 report_bank_tax_period: security_invoker, owner postgres, SELECT for authenticated only, the same columns, reads the Mercado Pago débitos y créditos',
    a.view === '{security_invoker=true}|postgres|{postgres=arwdDxtm/postgres,authenticated=r/postgres}|period:date,tax_kind:tax_kind,financial_account_id:uuid,account_name:text,amount_paid:numeric,charges:bigint'
      && a.view_reads_mp === true, `${a.view} reads_mp=${a.view_reads_mp}`);
  if (ctx.deploymentCheck) check('DEPLOYMENT CHECK 0135: no Factura A order and no order invoice yet', a.factura_a === 0 && a.order_invoices === 0, `${a.factura_a} / ${a.order_invoices}`);
  return out;
}
