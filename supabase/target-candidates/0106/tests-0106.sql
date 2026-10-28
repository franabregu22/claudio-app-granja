-- 0106 pending expenses — focused checks. Runs AFTER the candidate suite and tests-0103-0104.sql (their fixtures and pg_temp helpers),
-- inside the same rolled-back transaction. Focus: the expense in the P&L now, the money only when paid, never twice.
CREATE TEMP TABLE t_base6 AS SELECT coalesce(max(n), 0) AS n FROM t_result;
UPDATE wa.draft SET state = 'CANCELLED', updated_at = now() WHERE state IN ('DRAFT', 'WAITING_MP', 'FAILED');
CREATE FUNCTION pg_temp.posts() RETURNS BIGINT LANGUAGE plpgsql AS $f$ BEGIN RETURN (SELECT count(*) FROM financial_posting); END $f$;
CREATE FUNCTION pg_temp.bal(p_acc TEXT) RETURNS NUMERIC LANGUAGE plpgsql AS $f$ BEGIN
  RETURN (SELECT coalesce(sum(signed_amount), 0) FROM financial_posting WHERE financial_account_id = (SELECT id FROM financial_account WHERE nombre = p_acc)); END $f$;
-- the P&L and Cuentas a pagar as an ADMIN reads them (the views carry the ADMIN rule)
CREATE FUNCTION pg_temp.pnl(p_purchase TEXT) RETURNS TEXT LANGUAGE plpgsql AS $f$ BEGIN
  RETURN substr(pg_temp.adm(format('SELECT coalesce(sum(l.signed_amount), 0)::text FROM pnl_line_item l WHERE l.source_entity_type = ''purchases''
           AND l.source_entity_id IN (SELECT id::text FROM purchases WHERE purchase_chain_root(id) = %L::uuid)', p_purchase)), 4); END $f$;
CREATE FUNCTION pg_temp.pay(p_payable TEXT) RETURNS TEXT LANGUAGE plpgsql AS $f$ BEGIN
  RETURN substr(pg_temp.adm(format('SELECT status || '':'' || paid || ''/'' || pending FROM fin_expense_payables WHERE payable_id = %L::uuid', p_payable)), 4); END $f$;
CREATE FUNCTION pg_temp.payx(p_payable TEXT, p_amount NUMERIC, p_acc TEXT, p_method TEXT, p_key TEXT) RETURNS TEXT LANGUAGE sql AS $f$
  SELECT pg_temp.adm(format('SELECT public.pay_pending_expense(%L::uuid, %s, ''2026-10-25'', (SELECT id FROM financial_account WHERE nombre = %L), %L::payment_method, %L)::text',
                            p_payable, p_amount, p_acc, p_method, p_key)) $f$;
-- the commit-time rule, checked now: a casual purchase neither paid nor pending is refused
CREATE FUNCTION pg_temp.unsettled() RETURNS TEXT LANGUAGE plpgsql AS $f$ BEGIN
  BEGIN
    INSERT INTO purchases (supplier_id, economic_date, amount_net, amount_total, expense_category_id, subcategory, nature, is_current, version_seq, idempotency_key)
    VALUES (NULL, '2026-10-20', 10, 10, 'aaaaaaaa-0025-0000-0000-0000000000c1', 'sin pago', 'OPERATING', true, 0, 'T-0106-UNSETTLED');
    SET CONSTRAINTS trg_purchases_casual_settlement IMMEDIATE;
    RETURN 'accepted';
  EXCEPTION WHEN OTHERS THEN RETURN 'ERR:' || SQLERRM;
  END;
END $f$;
CREATE TEMP TABLE t_p6 AS SELECT pg_temp.ops() AS ops, pg_temp.posts() AS posts, pg_temp.npur() AS pur, pg_temp.nfis() AS fis,
                                 pg_temp.bal('Caja chica') AS caja, pg_temp.bal('BNA') AS bna;

-- PE-1 ERP: a pending expense with its invoice — the cost and the IVA now, no money
SELECT pg_temp.put('pe1', pg_temp.adm(format('SELECT public.register_pending_expense(''2026-10-20'', 1000, 1210, ''aaaaaaaa-0025-0000-0000-0000000000c1'', ''Repuestos a pagar'', ''OPERATING'', ''T-0106-PE1'', p_fiscal := %L::jsonb, p_counterparty_name := ''Taller Norte'')::text',
                                              pg_temp.vat('0001-00006001') -> 'fiscal')));
SELECT pg_temp.put('pur1', pg_temp.j(pg_temp.get('pe1')) ->> 'purchase_id');
SELECT pg_temp.put('pay1', pg_temp.j(pg_temp.get('pe1')) ->> 'payable_id');
SELECT pg_temp.expect('PE-1 registered: +1 purchase, +1 invoice (IVA once), 0 operations, 0 postings, Caja / BNA unchanged; P&L −1210 now; owed 1210 (no due date invented)',
  (pg_temp.npur() - (SELECT pur FROM t_p6)) || '|' || (pg_temp.nfis() - (SELECT fis FROM t_p6)) || '|' || (pg_temp.ops() - (SELECT ops FROM t_p6)) || '|' || (pg_temp.posts() - (SELECT posts FROM t_p6))
  || '|' || (pg_temp.bal('Caja chica') = (SELECT caja FROM t_p6) AND pg_temp.bal('BNA') = (SELECT bna FROM t_p6)) || '|' || pg_temp.pnl(pg_temp.get('pur1'))
  || '|' || pg_temp.pay(pg_temp.get('pay1')) || '|' || coalesce(pg_temp.cnt(format('SELECT due_date::text FROM expense_payable WHERE id = %L::uuid', pg_temp.get('pay1'))), 'none'),
  '1|1|0|0|true|-1210.00|PENDIENTE:0/1210.00|none');
-- PE-2 a partial payment: only the money (one posting on Caja chica), the P&L and the IVA unchanged
SELECT pg_temp.expect('PE-2 partial 400 in cash: +1 operation, +1 posting −400 on Caja chica; no purchase / invoice; P&L still −1210; PARCIAL 400/810',
  left(pg_temp.payx(pg_temp.get('pay1'), 400, 'Caja chica', 'CASH', 'T-0106-PAY1'), 3)
  || '|' || (pg_temp.ops() - (SELECT ops FROM t_p6)) || '|' || (pg_temp.posts() - (SELECT posts FROM t_p6)) || '|' || (pg_temp.bal('Caja chica') - (SELECT caja FROM t_p6))
  || '|' || (pg_temp.npur() - (SELECT pur FROM t_p6)) || '|' || (pg_temp.nfis() - (SELECT fis FROM t_p6)) || '|' || pg_temp.pnl(pg_temp.get('pur1')) || '|' || pg_temp.pay(pg_temp.get('pay1')),
  'OK:|1|1|-400.00|1|1|-1210.00|PARCIAL:400.00/810.00');
-- PE-3 refusals: above the balance, Mercado Pago, a method that does not match the account
SELECT pg_temp.expect('PE-3 above the pending balance / Mercado Pago / cash from a bank account → refused, nothing posted',
  left(pg_temp.payx(pg_temp.get('pay1'), 900, 'BNA', 'TRANSFER', 'T-0106-PAYX'), 17) || '|' || left(pg_temp.payx(pg_temp.get('pay1'), 10, 'Mercado Pago', 'TRANSFER', 'T-0106-PAYM'), 28)
  || '|' || left(pg_temp.payx(pg_temp.get('pay1'), 10, 'BNA', 'CASH', 'T-0106-PAYC'), 26) || '|' || (pg_temp.posts() - (SELECT posts FROM t_p6)),
  'ERR:OVER_PAYMENT:|ERR:PAYABLE_MP_NOT_SUPPORTED|ERR:INVALID_PAYMENT_METHOD|1');
-- PE-4 the rest by transfer: settled; the same request again is a replay (no second movement)
SELECT pg_temp.expect('PE-4 the remaining 810 from BNA → PAGADO 1210/0; BNA −810; replay → no new operation; P&L still −1210 (never twice)',
  left(pg_temp.payx(pg_temp.get('pay1'), 810, 'BNA', 'TRANSFER', 'T-0106-PAY2'), 3) || '|' || pg_temp.pay(pg_temp.get('pay1')) || '|' || (pg_temp.bal('BNA') - (SELECT bna FROM t_p6))
  || '|' || (pg_temp.j(pg_temp.payx(pg_temp.get('pay1'), 810, 'BNA', 'TRANSFER', 'T-0106-PAY2')) ->> 'replayed') || '|' || (pg_temp.ops() - (SELECT ops FROM t_p6)) || '|' || pg_temp.pnl(pg_temp.get('pur1')),
  'OK:|PAGADO:1210.00/0.00|-810.00|true|2|-1210.00');
-- PE-5 the ADR-019 invariant kept: a purchase without a supplier is paid OR pending, never neither
SELECT pg_temp.expect('PE-5 a casual purchase without payment and without obligation is refused', pg_temp.unsettled(), 'ERR:CASUAL_PURCHASE_UNSETTLED%');
-- PE-6 a rectified (re-classified) pending expense keeps its obligation and its single P&L line
SELECT pg_temp.expect('PE-6 re-classification of a pending expense: new version accepted, same obligation, P&L −1210 once',
  left(pg_temp.adm(format('SELECT public.rectify_casual_purchase_classification(%L::uuid, ''aaaaaaaa-0025-0000-0000-0000000000c1'', ''OPERATING'', ''Repuestos tractor'', NULL, ''nombre'')::text', pg_temp.get('pur1'))), 3)
  || '|' || pg_temp.pnl(pg_temp.get('pur1')) || '|' || substr(pg_temp.adm(format('SELECT concept || ''='' || status FROM fin_expense_payables WHERE payable_id = %L::uuid', pg_temp.get('pay1'))), 4),
  'OK:|-1210.00|Repuestos tractor=PAGADO');

-- PE-7 WhatsApp: "a pagar" — a casual expense with pending_payment: no method / account asked; the draft is a PENDING_EXPENSE
CREATE TEMP TABLE t_w6 AS SELECT pg_temp.ops() AS ops, pg_temp.posts() AS posts, pg_temp.npur() AS pur;
SELECT pg_temp.put('w1', pg_temp.propose(pg_temp.msg(pg_temp.v('phone_a'), 'gasoil 5000 a pagar, vence el 15/11'), 'CASUAL_EXPENSE',
  (pg_temp.cash(5000, 'Gasoil') - 'method' - 'account_id') || jsonb_build_object('pending_payment', true, 'due_date', '2026-11-15')));
SELECT pg_temp.put('wd1', pg_temp.did(pg_temp.get('w1')));
SELECT pg_temp.expect('PE-7 proposed as PENDING_EXPENSE: DRAFT, pending_payment, due 2026-11-15, no method / account / method_pending',
  pg_temp.cnt(format('SELECT type || ''|'' || state FROM wa.draft WHERE id = %L::uuid', pg_temp.get('wd1'))) || '|' || (pg_temp.j(pg_temp.get('w1')) -> 'payload' ->> 'pending_payment')
  || '|' || (pg_temp.j(pg_temp.get('w1')) -> 'payload' ->> 'due_date') || '|' || ((pg_temp.j(pg_temp.get('w1')) -> 'payload') ?| ARRAY['method', 'account_id', 'method_pending', 'account_pending'])::text,
  'PENDING_EXPENSE|DRAFT|true|2026-11-15|false');
SELECT pg_temp.expect('PE-8 confirmed: +1 purchase (P&L −5000), +1 obligation (WHATSAPP, due 2026-11-15), 0 operations, 0 postings',
  left(pg_temp.confirm(pg_temp.btn(pg_temp.v('phone_a'), pg_temp.get('wd1'), 1), pg_temp.get('wd1'), 1), 10)
  || '|' || (pg_temp.npur() - (SELECT pur FROM t_w6)) || '|' || (pg_temp.ops() - (SELECT ops FROM t_w6)) || '|' || (pg_temp.posts() - (SELECT posts FROM t_w6))
  || '|' || pg_temp.cnt(format('SELECT e.origin || ''|'' || e.due_date || ''|'' || e.amount || ''|'' || pg_temp.pnl(p.id::text) FROM expense_payable e JOIN purchases p ON p.id = e.purchase_root_id WHERE p.idempotency_key = %L', 'WA:' || pg_temp.get('wd1') || ':v1')),
  'OK:{"ok": |1|0|0|WHATSAPP|2026-11-15|5000.00|-5000.00');
-- PE-9 a correction paid ⇄ to pay follows the payload; a paid expense still needs its method (the current bot is unchanged)
SELECT pg_temp.put('w2', pg_temp.propose(pg_temp.msg(pg_temp.v('phone_a'), 'flete 3000 queda pendiente'), 'CASUAL_EXPENSE',
  (pg_temp.cash(3000, 'Flete') - 'method' - 'account_id') || jsonb_build_object('pending_payment', true)));
SELECT pg_temp.put('wd2', pg_temp.did(pg_temp.get('w2')));
SELECT pg_temp.put('w2b', pg_temp.correct(pg_temp.msg(pg_temp.v('phone_a'), 'no, ya lo pagué en efectivo'), pg_temp.get('wd2'), 1, pg_temp.cash(3000, 'Flete')));
SELECT pg_temp.put('w2c', pg_temp.correct(pg_temp.msg(pg_temp.v('phone_a'), 'mejor a pagar'), pg_temp.get('wd2'), 2,
  (pg_temp.cash(3000, 'Flete') - 'method' - 'account_id') || jsonb_build_object('pending_payment', true)));
SELECT pg_temp.expect('PE-9 PENDING → paid (CASUAL_EXPENSE with its cash method) → PENDING again (method dropped)',
  pg_temp.cnt(format('SELECT string_agg(x, '','') FROM (VALUES (%L), (%L)) v(x)', (pg_temp.j(pg_temp.get('w2b')) -> 'payload' ->> 'method'), (pg_temp.j(pg_temp.get('w2c')) -> 'payload' ->> 'pending_payment')))
  || '|' || pg_temp.cnt(format('SELECT type FROM wa.draft WHERE id = %L::uuid', pg_temp.get('wd2'))) || '|' || ((pg_temp.j(pg_temp.get('w2c')) -> 'payload') ? 'method')::text,
  'CASH,true|PENDING_EXPENSE|false');
SELECT pg_temp.expect('PE-10 a pending expense refuses a Mercado Pago outflow and a due date before the expense',
  left(pg_temp.correct(pg_temp.msg(pg_temp.v('phone_a'), 'x'), pg_temp.get('wd2'), 3, (pg_temp.cash(3000, 'Flete') - 'method' - 'account_id') || jsonb_build_object('pending_payment', true, 'mp_source_id', '123456789')), 22)
  || '|' || left(pg_temp.correct(pg_temp.msg(pg_temp.v('phone_a'), 'y'), pg_temp.get('wd2'), 3, (pg_temp.cash(3000, 'Flete') - 'method' - 'account_id') || jsonb_build_object('pending_payment', true, 'due_date', '2026-10-01')), 22),
  'ERR:WA_INVALID_PAYLOAD|ERR:WA_INVALID_PAYLOAD');
SELECT pg_temp.expect('PE-11 an OPERATOR can not register or pay a pending expense',
  left(pg_temp.as_('authenticated', pg_temp.v('oper'), format('SELECT public.pay_pending_expense(%L::uuid, 1, ''2026-10-25'', (SELECT id FROM financial_account WHERE nombre = ''BNA''), ''TRANSFER'', ''T-0106-OP'')::text', pg_temp.get('pay1'))), 13),
  'ERR:FORBIDDEN');

SELECT 'SUMMARY-0106|' || count(*) FILTER (WHERE ok) || '|' || count(*) FILTER (WHERE NOT ok) FROM t_result WHERE n > (SELECT n FROM t_base6);
