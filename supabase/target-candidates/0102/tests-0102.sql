-- ============================================================================
-- 0102 UNCLASSIFIED EXPENSES — fixtures + suite. Runs INSIDE one transaction that the runner rolls back (nothing persists).
-- PostgREST is simulated as the repo tests do: SET LOCAL ROLE <api role> + request.jwt.claims.
-- psql variables: admin_a admin_b oper nobody. Output: "PASS name" / "FAIL name :: got …" NOTICEs and "SUMMARY|passed|failed".
-- Controls of the owner GO (A … I) are named in the test ids.
-- ============================================================================
SET LOCAL search_path = public, pg_temp;
SELECT set_config('t.admin_a', :'admin_a', true), set_config('t.admin_b', :'admin_b', true), set_config('t.oper', :'oper', true),
       set_config('t.nobody', :'nobody', true) \g /dev/null

-- ── fixtures (synthetic) ─────────────────────────────────────────────────────
INSERT INTO perfiles (id, email, rol_type) VALUES
  (:'admin_a', 'erp0102-admin-a@test.local', 'ADMIN'), (:'admin_b', 'erp0102-admin-b@test.local', 'ADMIN'), (:'oper', 'erp0102-oper@test.local', 'OPERATOR');
INSERT INTO expense_category (id, nombre, pnl_cost_class, group_id) VALUES
  ('bbbbbbbb-0102-0000-0000-0000000000c1', 'Gasoil 0102', 'DIRECT',   (SELECT id FROM expense_category_group WHERE nombre = 'Combustible')),
  ('bbbbbbbb-0102-0000-0000-0000000000c2', 'Nafta 0102',  'INDIRECT', (SELECT id FROM expense_category_group WHERE nombre = 'Combustible')),
  ('bbbbbbbb-0102-0000-0000-0000000000c3', 'Retiro 0102', 'INDIRECT', (SELECT id FROM expense_category_group WHERE kind = 'OWNER_WITHDRAWAL' LIMIT 1));
INSERT INTO expense_category (id, nombre, pnl_cost_class, group_id, activo) VALUES
  ('bbbbbbbb-0102-0000-0000-0000000000c4', 'Inactiva 0102', 'INDIRECT', (SELECT id FROM expense_category_group WHERE nombre = 'Combustible'), false);
-- an ACTIVE subcategory inside an INACTIVE category (owner decision: not classifiable, same rule as the bot)
INSERT INTO expense_category_group (id, nombre, kind, activo) VALUES ('bbbbbbbb-0102-0000-0000-0000000000e1', 'Grupo inactivo 0102', 'EXPENSE', false);
INSERT INTO expense_category (id, nombre, pnl_cost_class, group_id) VALUES
  ('bbbbbbbb-0102-0000-0000-0000000000c5', 'Sub de grupo inactivo 0102', 'INDIRECT', 'bbbbbbbb-0102-0000-0000-0000000000e1');
-- an ADR-021 provisional Mercado Pago outflow (the WhatsApp MP case must reuse it, never duplicate it)
DO $$
DECLARE v_src UUID; v_mv BIGINT;
BEGIN
  INSERT INTO mp_source_record (source_type, external_id, event_data, occurred_at, occurred_date)
  VALUES ('csv_import', '940000102001:payment:D', jsonb_build_object('SOURCE_ID', '940000102001', 'DESCRIPTION', 'payment', 'NET_CREDIT_AMOUNT', '0.00',
          'NET_DEBIT_AMOUNT', '8000.00'), '2026-10-20T10:00:00-03:00', '2026-10-20') RETURNING id INTO v_src;
  INSERT INTO mp_financial_movement (mp_source_record_id, movement_kind, gross_amount, fee_amount, tax_amount, net_amount, occurred_date)
  VALUES (v_src, 'outbound', -8000.00, 0, 0, -8000.00, '2026-10-20') RETURNING id INTO v_mv;
  INSERT INTO mp_transition_identity (resource_type, resource_id, transition, transition_ref, claimed_by_source_id, mp_financial_movement_id)
  VALUES ('report', '940000102001:payment:D', 'OUTBOUND', '', v_src, v_mv);
  IF mp_pending_outflow_post('940000102001', NULL, current_setting('t.admin_a')::uuid) <> 'POSTED' THEN RAISE EXCEPTION 'fixture: MP outflow not posted'; END IF;
END $$;
-- bank statements: an active cut per bank (anchored on an existing line) and one POST-cut line each (−12 000 Patagonia, −9 000 BNA)
DO $$
DECLARE v_pat UUID := (SELECT id FROM financial_account WHERE nombre = 'Patagonia'); v_bna UUID := (SELECT id FROM financial_account WHERE nombre = 'BNA');
        v_anchor BIGINT; v_run UUID; v_old fin_import_run%ROWTYPE; v_line BIGINT;
BEGIN
  SELECT id INTO v_anchor FROM fin_statement_line WHERE financial_account_id = v_pat ORDER BY value_date, id LIMIT 1;
  INSERT INTO fin_statement_cutover (financial_account_id, opening_balance, cutoff_statement_line_id, resolved_by, evidence_note)
  VALUES (v_pat, 0, v_anchor, current_setting('t.admin_a')::uuid, 'test 0102');
  INSERT INTO fin_statement_line (financial_account_id, value_date, description_raw, description_norm, signed_amount, fingerprint, first_run_id)
  VALUES (v_pat, '2026-10-21', 'TRANSFERENCIA 0102', 'transferencia 0102', -12000, encode(sha256('0102-pat'::bytea), 'hex'),
          (SELECT first_run_id FROM fin_statement_line WHERE id = v_anchor)) RETURNING id INTO v_line;
  PERFORM set_config('t.line_pat', v_line::text, true);

  SELECT l.id INTO v_anchor FROM fin_statement_line l JOIN fin_import_run_line a ON a.statement_line_id = l.id AND a.run_id = l.first_run_id
   WHERE l.financial_account_id = v_bna ORDER BY a.statement_position DESC LIMIT 1;
  INSERT INTO fin_statement_cutover (financial_account_id, opening_balance, cutoff_statement_line_id, resolved_by, evidence_note)
  VALUES (v_bna, 0, v_anchor, current_setting('t.admin_a')::uuid, 'test 0102');
  SELECT * INTO v_old FROM fin_import_run WHERE id = (SELECT first_run_id FROM fin_statement_line WHERE id = v_anchor);
  INSERT INTO fin_import_run (source_kind, mode, financial_account_id, format_code, parser_version, file_sha256, storage_path, file_name, byte_size,
         coverage_from, coverage_to, status, rows_total, lines_new, source_meta, created_by)
  VALUES (v_old.source_kind, v_old.mode, v_bna, v_old.format_code, v_old.parser_version, encode(sha256('0102-bna-run'::bytea), 'hex'),
          'test/0102.pdf', '0102.pdf', 1, '2026-10-01', '2026-10-31', 'PARSED', 1, 1, '{}'::jsonb, current_setting('t.admin_a')::uuid) RETURNING id INTO v_run;
  INSERT INTO fin_statement_line (financial_account_id, value_date, description_raw, description_norm, signed_amount, fingerprint, first_run_id)
  VALUES (v_bna, '2026-10-21', 'TRANSFERENCIA 0102', 'transferencia 0102', -9000, encode(sha256('0102-bna'::bytea), 'hex'), v_run) RETURNING id INTO v_line;
  INSERT INTO fin_import_run_line (run_id, row_number, source_kind, mode, raw_row, outcome, statement_line_id, statement_position)
  VALUES (v_run, 1, 'BANK_STATEMENT', 'NORMAL', '{}'::jsonb, 'NEW', v_line, 1);
  PERFORM set_config('t.line_bna', v_line::text, true);
END $$;

-- ── helpers ─────────────────────────────────────────────────────────────────
CREATE TEMP TABLE t_result (n SERIAL, name TEXT, ok BOOLEAN, got TEXT);
CREATE TEMP TABLE t_state (k TEXT PRIMARY KEY, v TEXT);
CREATE FUNCTION pg_temp.v(k TEXT) RETURNS TEXT LANGUAGE sql AS $f$ SELECT current_setting('t.' || k) $f$;
CREATE FUNCTION pg_temp.put(k TEXT, v TEXT) RETURNS TEXT LANGUAGE sql AS $f$
  INSERT INTO t_state VALUES (k, v) ON CONFLICT (k) DO UPDATE SET v = EXCLUDED.v RETURNING v $f$;
CREATE FUNCTION pg_temp.get(k TEXT) RETURNS TEXT LANGUAGE sql AS $f$ SELECT v FROM t_state WHERE t_state.k = get.k $f$;
CREATE FUNCTION pg_temp.expect(p_name TEXT, p_got TEXT, p_like TEXT) RETURNS VOID LANGUAGE plpgsql AS $f$
BEGIN
  INSERT INTO t_result (name, ok, got) VALUES (p_name, p_got IS NOT NULL AND p_got LIKE p_like, p_got);
  IF p_got IS NOT NULL AND p_got LIKE p_like THEN RAISE NOTICE 'PASS %', p_name;
  ELSE RAISE NOTICE 'FAIL % :: got [%] expected like [%]', p_name, left(p_got, 400), p_like; END IF;
END $f$;
-- one API call as <role>/<uid> (a subtransaction: a failure rolls back only that call)
CREATE FUNCTION pg_temp.as_(p_role TEXT, p_uid TEXT, p_sql TEXT) RETURNS TEXT LANGUAGE plpgsql AS $f$
DECLARE v TEXT; ok BOOLEAN := false; msg TEXT;
BEGIN
  BEGIN
    EXECUTE format('SET LOCAL ROLE %I', p_role);
    PERFORM set_config('request.jwt.claims', CASE WHEN p_uid IS NULL THEN json_build_object('role', p_role)::text
                                                  ELSE json_build_object('sub', p_uid, 'role', p_role)::text END, true);
    EXECUTE p_sql INTO v;
    ok := true;
    RESET ROLE;
  EXCEPTION WHEN others THEN GET STACKED DIAGNOSTICS msg = MESSAGE_TEXT; RESET ROLE;
  END;
  PERFORM set_config('request.jwt.claims', '', true);
  RETURN CASE WHEN ok THEN 'OK:' || coalesce(v, 'null') ELSE 'ERR:' || msg END;
END $f$;
CREATE FUNCTION pg_temp.adm(p_sql TEXT) RETURNS TEXT LANGUAGE sql AS $f$ SELECT pg_temp.as_('authenticated', pg_temp.v('admin_a'), p_sql) $f$;
CREATE FUNCTION pg_temp.adm_b(p_sql TEXT) RETURNS TEXT LANGUAGE sql AS $f$ SELECT pg_temp.as_('authenticated', pg_temp.v('admin_b'), p_sql) $f$;
CREATE FUNCTION pg_temp.j(t TEXT) RETURNS JSONB LANGUAGE sql AS $f$ SELECT CASE WHEN t LIKE 'OK:{%' THEN substr(t, 4)::jsonb END $f$;
CREATE FUNCTION pg_temp.acc(p_name TEXT) RETURNS UUID LANGUAGE sql AS $f$ SELECT id FROM financial_account WHERE nombre = p_name $f$;
-- register / classify through the API (as ADMIN A / B)
CREATE FUNCTION pg_temp.reg(p_date TEXT, p_amount NUMERIC, p_account TEXT, p_method TEXT, p_key TEXT, p_concept TEXT DEFAULT 'combustible',
                            p_who TEXT DEFAULT 'admin_a') RETURNS TEXT LANGUAGE sql AS $f$
  SELECT pg_temp.as_('authenticated', pg_temp.v(p_who), format(
    'SELECT register_unclassified_expense(%L::date, %s, %L, %L::uuid, %L::payment_method, %L, NULL, ''WHATSAPP'', %L::jsonb)::text',
    p_date, p_amount, p_concept, pg_temp.acc(p_account), p_method, p_key, jsonb_build_object('draft_short_code', 'W-0102', 'inbound_id', 102))) $f$;
CREATE FUNCTION pg_temp.cls(p_pending TEXT, p_cat TEXT, p_who TEXT DEFAULT 'admin_b', p_nature TEXT DEFAULT 'OPERATING') RETURNS TEXT LANGUAGE sql AS $f$
  SELECT pg_temp.as_('authenticated', pg_temp.v(p_who), format(
    'SELECT classify_pending_expense(%s, %L::uuid, %L::purchase_nature, NULL, NULL, ''clasificado en test'')::text', p_pending, p_cat, p_nature)) $f$;
CREATE FUNCTION pg_temp.pid(r TEXT) RETURNS TEXT LANGUAGE sql AS $f$ SELECT pg_temp.j(r) ->> 'pending_id' $f$;
-- volatile readers (a subquery in the same statement as an API call would not see what it wrote)
CREATE FUNCTION pg_temp.q(p_sql TEXT) RETURNS TEXT LANGUAGE plpgsql AS $f$ DECLARE v TEXT; BEGIN EXECUTE p_sql INTO v; RETURN v; END $f$;
CREATE FUNCTION pg_temp.bal(p_account TEXT) RETURNS NUMERIC LANGUAGE plpgsql AS $f$
BEGIN RETURN (SELECT coalesce(sum(signed_amount), 0) FROM financial_posting WHERE financial_account_id = pg_temp.acc(p_account)); END $f$;
CREATE FUNCTION pg_temp.counts() RETURNS TEXT LANGUAGE plpgsql AS $f$
BEGIN RETURN (SELECT count(*) FROM financial_operation) || '|' || (SELECT count(*) FROM financial_posting) || '|' || (SELECT count(*) FROM purchases)
           || '|' || (SELECT count(*) FROM expense_pending_classification) || '|' || (SELECT count(*) FROM expense_pending_resolution); END $f$;
CREATE FUNCTION pg_temp.delta(p_before TEXT) RETURNS TEXT LANGUAGE plpgsql AS $f$
DECLARE a TEXT[] := string_to_array(p_before, '|'); b TEXT[] := string_to_array(pg_temp.counts(), '|');
BEGIN RETURN 'ops+' || (b[1]::int - a[1]::int) || ' postings+' || (b[2]::int - a[2]::int) || ' purchases+' || (b[3]::int - a[3]::int)
           || ' pending+' || (b[4]::int - a[4]::int) || ' resolutions+' || (b[5]::int - a[5]::int); END $f$;
-- the P&L as ADMIN (views filter on current_app_role())
CREATE FUNCTION pg_temp.pnl(p_period TEXT, p_col TEXT) RETURNS TEXT LANGUAGE plpgsql AS $f$
DECLARE v TEXT;
BEGIN
  PERFORM set_config('request.jwt.claims', json_build_object('sub', pg_temp.v('admin_a'), 'role', 'authenticated')::text, true);
  EXECUTE format('SELECT coalesce((SELECT %I FROM pnl_summary WHERE period = %L::date), 0)::text', p_col, p_period) INTO v;
  PERFORM set_config('request.jwt.claims', '', true);
  RETURN v;
END $f$;
-- force the deferred integrity triggers now (as at COMMIT); then back to deferred
CREATE FUNCTION pg_temp.commit_check() RETURNS TEXT LANGUAGE plpgsql AS $f$
DECLARE msg TEXT;
BEGIN
  BEGIN SET CONSTRAINTS ALL IMMEDIATE; SET CONSTRAINTS ALL DEFERRED; RETURN 'OK';
  EXCEPTION WHEN others THEN GET STACKED DIAGNOSTICS msg = MESSAGE_TEXT; SET CONSTRAINTS ALL DEFERRED; RETURN 'ERR:' || msg; END;
END $f$;

SELECT pg_temp.expect('fixtures: integrity of the pre-existing ERP data under the new deferred triggers', pg_temp.commit_check(), 'OK');

-- ── 0. schema, privileges, RLS ───────────────────────────────────────────────
SELECT pg_temp.expect('S-1 RPCs: SECURITY DEFINER, owner postgres; guard functions not executable by API roles',
  (SELECT string_agg(p.proname || ':' || p.prosecdef || ':' || pg_get_userbyid(p.proowner), ',' ORDER BY p.proname) FROM pg_proc p
    WHERE p.proname IN ('register_unclassified_expense', 'classify_pending_expense', 'expense_pending_integrity', 'expense_pending_close_guard')),
  'classify_pending_expense:true:postgres,expense_pending_close_guard:true:postgres,expense_pending_integrity:true:postgres,register_unclassified_expense:true:postgres');
SELECT pg_temp.expect('S-2 EXECUTE: authenticated yes; anon / service_role / PUBLIC no',
  (SELECT string_agg(r || '=' || has_function_privilege(r, 'register_unclassified_expense(date,numeric,character varying,uuid,payment_method,character varying,character varying,character varying,jsonb,text)', 'EXECUTE')
          || '/' || has_function_privilege(r, 'classify_pending_expense(bigint,uuid,purchase_nature,character varying,character varying,text)', 'EXECUTE')
          || '/' || has_function_privilege(r, 'expense_pending_check(bigint)', 'EXECUTE'), ',' ORDER BY r)
     FROM unnest(ARRAY['anon', 'authenticated', 'service_role']) r),
  'anon=false/false/false,authenticated=true/true/false,service_role=false/false/false');
SELECT pg_temp.expect('S-3 tables: RLS on, SELECT-only for authenticated, no write grant to any API role',
  (SELECT string_agg(c.relname || ':' || c.relrowsecurity || ':' || has_table_privilege('authenticated', c.oid, 'SELECT') || ':'
          || (has_table_privilege('authenticated', c.oid, 'INSERT') OR has_table_privilege('authenticated', c.oid, 'UPDATE') OR has_table_privilege('service_role', c.oid, 'INSERT')
              OR has_table_privilege('anon', c.oid, 'SELECT')), ',' ORDER BY c.relname)
     FROM pg_class c WHERE c.relname IN ('expense_pending_classification', 'expense_pending_resolution')),
  'expense_pending_classification:true:true:false,expense_pending_resolution:true:true:false');

-- ── A + B + C: Caja chica — register, balances, P&L, classify ────────────────
SELECT pg_temp.put('before', pg_temp.counts()), pg_temp.put('caja0', pg_temp.bal('Caja chica')::text),
       pg_temp.put('total0', pg_temp.pnl('2026-10-01', 'resultado_post_inversiones')), pg_temp.put('op0', pg_temp.pnl('2026-10-01', 'resultado_operativo')) \g /dev/null
SELECT pg_temp.put('r1', pg_temp.reg('2026-10-20', 35000, 'Caja chica', 'CASH', 'WA:test-0102-caja')) \g /dev/null
SELECT pg_temp.expect('B-1 register (Caja chica 35 000): status SIN_CLASIFICAR, not replayed', pg_temp.get('r1'), 'OK:{%"status": "SIN_CLASIFICAR"%"replayed": false%');
SELECT pg_temp.expect('B-2 exactly ONE operation and ONE posting; no purchase; one pending', pg_temp.delta(pg_temp.get('before')),
  'ops+1 postings+1 purchases+0 pending+1 resolutions+0');
SELECT pg_temp.put('p1', pg_temp.pid(pg_temp.get('r1'))), pg_temp.put('op1', pg_temp.j(pg_temp.get('r1')) ->> 'payment_operation_id') \g /dev/null
SELECT pg_temp.expect('B-3 the operation: PURCHASE_PAYMENT EXPENSE-PENDING:<id>; the posting: −35 000 on Caja chica on 2026-10-20',
  pg_temp.q(format('SELECT o.operation_type || ''|'' || (o.external_ref = ''EXPENSE-PENDING:'' || %s) || ''|'' || p.signed_amount || ''|'' || (p.financial_account_id = %L::uuid) || ''|'' || p.effective_date
                      FROM financial_operation o JOIN financial_posting p ON p.financial_operation_id = o.id WHERE o.id = %s',
                   pg_temp.get('p1'), pg_temp.acc('Caja chica'), pg_temp.get('op1'))),
  'PURCHASE_PAYMENT|true|-35000.00|true|2026-10-20');
SELECT pg_temp.expect('B-4 Caja chica balance −35 000 immediately', (pg_temp.bal('Caja chica') - pg_temp.get('caja0')::numeric)::text, '-35000.00');
SELECT pg_temp.expect('A-1 report_balance_period (ACCOUNT ledger) includes the outflow in 2026-10',
  pg_temp.adm(format('SELECT (decreases <= -35000)::text FROM report_balance_period WHERE ledger = ''ACCOUNT'' AND entity_id = %L::uuid AND period = ''2026-10-01''', pg_temp.acc('Caja chica'))), 'OK:true');
SELECT pg_temp.expect('C-1 P&L: GASTOS_SIN_CLASIFICAR −35 000; resultado operativo and final total −35 000',
  pg_temp.pnl('2026-10-01', 'gastos_sin_clasificar') || '|' || (pg_temp.pnl('2026-10-01', 'resultado_operativo')::numeric - pg_temp.get('op0')::numeric)
  || '|' || (pg_temp.pnl('2026-10-01', 'resultado_post_inversiones')::numeric - pg_temp.get('total0')::numeric), '-35000.00|-35000.00|-35000.00');
SELECT pg_temp.expect('I-1 ERP list (ADMIN via API): SIN_CLASIFICAR with account, amount, origin',
  pg_temp.adm(format('SELECT status || ''|'' || account_name || ''|'' || amount || ''|'' || origin || ''|'' || (origin_ref ->> ''draft_short_code'') FROM fin_expense_pending_classification WHERE pending_id = %s', pg_temp.get('p1'))),
  'OK:SIN_CLASIFICAR|Caja chica|35000.00|WHATSAPP|W-0102');
SELECT pg_temp.expect('A-2 deferred integrity holds for a registered pending (as at COMMIT)', pg_temp.commit_check(), 'OK');

-- A: every public view still works with a PURCHASE_PAYMENT that has no purchase (as ADMIN)
DO $$
DECLARE r RECORD; n INT := 0; bad TEXT := '';
BEGIN
  PERFORM set_config('request.jwt.claims', json_build_object('sub', current_setting('t.admin_a'), 'role', 'authenticated')::text, true);
  FOR r IN SELECT viewname FROM pg_views WHERE schemaname = 'public' ORDER BY 1 LOOP
    BEGIN EXECUTE format('SELECT count(*) FROM public.%I', r.viewname); n := n + 1;
    EXCEPTION WHEN others THEN bad := bad || r.viewname || ':' || SQLERRM || ';'; END;
  END LOOP;
  PERFORM set_config('request.jwt.claims', '', true);
  PERFORM pg_temp.expect('A-3 every public view answers with an unclassified payment present (' || n || ' views)', coalesce(nullif(bad, ''), 'none'), 'none');
END $$;
SELECT pg_temp.expect('A-4 the MP pending-classification totals are not affected by a non-MP pending',
  (SELECT pending_count || '|' || outgoing FROM mp_pending_classification_totals('2026-10-20', '2026-10-20')), '1|-8000.00');

-- B / C: classification
SELECT pg_temp.put('before', pg_temp.counts()) \g /dev/null
SELECT pg_temp.put('c1', pg_temp.cls(pg_temp.get('p1'), 'bbbbbbbb-0102-0000-0000-0000000000c1')) \g /dev/null
SELECT pg_temp.expect('B-5 classify (ADMIN B, Gasoil 0102): CLASIFICADO', pg_temp.get('c1'), 'OK:{%"status": "CLASIFICADO"%"replayed": false%');
SELECT pg_temp.expect('B-6 classification writes ONLY the purchase + resolution: no operation, no posting', pg_temp.delta(pg_temp.get('before')),
  'ops+0 postings+0 purchases+1 pending+0 resolutions+1');
SELECT pg_temp.expect('B-7 the purchase is tied to the EXISTING payment, same amount / date, casual, current',
  pg_temp.q(format('SELECT (paid_operation_id = %s) || ''|'' || amount_total || ''|'' || economic_date || ''|'' || (supplier_id IS NULL) || ''|'' || is_current || ''|'' || subcategory
                      FROM purchases WHERE id = %L::uuid', pg_temp.get('op1'), pg_temp.j(pg_temp.get('c1')) ->> 'purchase_id')),
  'true|35000.00|2026-10-20|true|true|combustible');
SELECT pg_temp.expect('B-8 Caja chica balance unchanged by the classification', (pg_temp.bal('Caja chica') - pg_temp.get('caja0')::numeric)::text, '-35000.00');
SELECT pg_temp.expect('C-2 P&L total unchanged by classifying; GASTOS_SIN_CLASIFICAR back to 0; the cost moved to its bucket',
  pg_temp.pnl('2026-10-01', 'gastos_sin_clasificar') || '|' || (pg_temp.pnl('2026-10-01', 'resultado_post_inversiones')::numeric - pg_temp.get('total0')::numeric)
  || '|' || (pg_temp.pnl('2026-10-01', 'resultado_operativo')::numeric - pg_temp.get('op0')::numeric), '0|-35000.00|-35000.00');
SELECT pg_temp.expect('C-3 the expense appears ONCE in pnl_line_item (purchase), never as pending AND purchase',
  pg_temp.adm(format('SELECT string_agg(bucket || '':'' || signed_amount, '','') FROM pnl_line_item WHERE (source_entity_type = ''expense_pending_classification'' AND source_entity_id = %L)
                        OR (source_entity_type = ''purchases'' AND source_entity_id = %L)', pg_temp.get('p1'), pg_temp.j(pg_temp.get('c1')) ->> 'purchase_id')),
  'OK:COSTOS_DIRECTOS:-35000.00');
SELECT pg_temp.expect('I-2 ERP list: CLASIFICADO with category and classifier', pg_temp.adm(format(
  'SELECT status || ''|'' || category_name || ''|'' || (classified_by = %L::uuid) || ''|'' || (created_by = %L::uuid) FROM fin_expense_pending_classification WHERE pending_id = %s',
  pg_temp.v('admin_b'), pg_temp.v('admin_a'), pg_temp.get('p1'))), 'OK:CLASIFICADO|Gasoil 0102|true|true');
SELECT pg_temp.expect('G-1 audit: registration by ADMIN A with the WhatsApp origin; classification by ADMIN B keeping author + origin',
  pg_temp.q(format('SELECT string_agg(action || '':'' || (performed_by = CASE action WHEN ''EXPENSE_PENDING_REGISTERED'' THEN %L ELSE %L END::uuid) || '':''
     || coalesce(after_values -> ''origin_ref'' ->> ''draft_short_code'', before_values -> ''origin_ref'' ->> ''draft_short_code'') || '':''
     || coalesce((before_values ->> ''registered_by'' = %L)::text, ''-''), '','' ORDER BY id) FROM audit_events WHERE entity_type = ''expense_pending_classification'' AND entity_id = %L',
     pg_temp.v('admin_a'), pg_temp.v('admin_b'), pg_temp.v('admin_a'), pg_temp.get('p1'))),
  'EXPENSE_PENDING_REGISTERED:true:W-0102:-,EXPENSE_PENDING_CLASSIFIED:true:W-0102:true');
SELECT pg_temp.expect('A-5 deferred integrity holds after the classification', pg_temp.commit_check(), 'OK');

-- ── D: idempotency, double confirmation, conflicts, transactional failures ───
SELECT pg_temp.put('before', pg_temp.counts()) \g /dev/null
SELECT pg_temp.expect('D-1 retry / double confirmation (same key, same data): same pending, replayed, nothing written',
  pg_temp.pid(pg_temp.reg('2026-10-20', 35000, 'Caja chica', 'CASH', 'WA:test-0102-caja')) || '|' || pg_temp.delta(pg_temp.get('before')),
  pg_temp.get('p1') || '|ops+0 postings+0 purchases+0 pending+0 resolutions+0');
SELECT pg_temp.expect('D-2 same key, different amount → IDEMPOTENCY_CONFLICT', pg_temp.reg('2026-10-20', 36000, 'Caja chica', 'CASH', 'WA:test-0102-caja'), 'ERR:IDEMPOTENCY_CONFLICT%');
SELECT pg_temp.expect('D-3 classify replay (same data): replayed, nothing written',
  (pg_temp.j(pg_temp.cls(pg_temp.get('p1'), 'bbbbbbbb-0102-0000-0000-0000000000c1')) ->> 'replayed') || '|' || pg_temp.delta(pg_temp.get('before')),
  'true|ops+0 postings+0 purchases+0 pending+0 resolutions+0');
SELECT pg_temp.expect('D-4 a second, different classification → ALREADY_CLASSIFIED (no reassignment by this RPC)',
  pg_temp.cls(pg_temp.get('p1'), 'bbbbbbbb-0102-0000-0000-0000000000c2'), 'ERR:ALREADY_CLASSIFIED%');
SELECT pg_temp.expect('D-5 reclassification goes through rectify_casual_purchase_classification (ADMIN, reason): no money, P&L total unchanged',
  pg_temp.adm(format('SELECT rectify_casual_purchase_classification(%L::uuid, %L::uuid, ''OPERATING'', ''combustible'', NULL, ''corrección'')::text',
                     pg_temp.j(pg_temp.get('c1')) ->> 'purchase_id', 'bbbbbbbb-0102-0000-0000-0000000000c2')) || '|' || pg_temp.delta(pg_temp.get('before'))
  || '|' || (pg_temp.pnl('2026-10-01', 'resultado_post_inversiones')::numeric - pg_temp.get('total0')::numeric) || '|' || pg_temp.pnl('2026-10-01', 'gastos_sin_clasificar'),
  'OK:{%|ops+0 postings+0 purchases+1 pending+0 resolutions+0|-35000.00|0');
SELECT pg_temp.expect('D-6 after the reclassification: the list shows the new category; the old classification replay is refused',
  pg_temp.adm(format('SELECT status || ''|'' || category_name FROM fin_expense_pending_classification WHERE pending_id = %s', pg_temp.get('p1')))
  || '|' || left(pg_temp.cls(pg_temp.get('p1'), 'bbbbbbbb-0102-0000-0000-0000000000c1'), 24), 'OK:CLASIFICADO|Nafta 0102|ERR:ALREADY_CLASSIFIED%');
SELECT pg_temp.expect('A-6 deferred integrity holds after a reclassification (new purchase version on the same payment)', pg_temp.commit_check(), 'OK');

SELECT pg_temp.put('r2', pg_temp.reg('2026-10-21', 4000, 'Caja chica', 'CASH', 'WA:test-0102-fail')), pg_temp.put('before', pg_temp.counts()) \g /dev/null
SELECT pg_temp.put('p2', pg_temp.pid(pg_temp.get('r2'))) \g /dev/null
SELECT pg_temp.expect('D-7 failure inside the classification (owner-withdrawal category) rolls back everything: no purchase, still pending',
  left(pg_temp.cls(pg_temp.get('p2'), 'bbbbbbbb-0102-0000-0000-0000000000c3'), 28) || '|' || pg_temp.delta(pg_temp.get('before'))
  || '|' || pg_temp.adm(format('SELECT status FROM fin_expense_pending_classification WHERE pending_id = %s', pg_temp.get('p2'))),
  'ERR:CATEGORY_NOT_SELECTABLE%|ops+0 postings+0 purchases+0 pending+0 resolutions+0|OK:SIN_CLASIFICAR');
SELECT pg_temp.expect('D-8 inactive / missing category, missing nature → refused, nothing written',
  left(pg_temp.cls(pg_temp.get('p2'), 'bbbbbbbb-0102-0000-0000-0000000000c4'), 21) || '|' || left(pg_temp.cls(pg_temp.get('p2'), NULL), 21) || '|'
  || left(pg_temp.as_('authenticated', pg_temp.v('admin_b'), format('SELECT classify_pending_expense(%s, %L::uuid, NULL)::text', pg_temp.get('p2'), 'bbbbbbbb-0102-0000-0000-0000000000c1')), 19)
  || '|' || pg_temp.delta(pg_temp.get('before')),
  'ERR:CATEGORY_REQUIRED|ERR:CATEGORY_REQUIRED|ERR:NATURE_REQUIRED|ops+0 postings+0 purchases+0 pending+0 resolutions+0');
SELECT pg_temp.expect('D-8b an active subcategory of an INACTIVE category is refused (bot rule), nothing written',
  left(pg_temp.cls(pg_temp.get('p2'), 'bbbbbbbb-0102-0000-0000-0000000000c5'), 27) || '|' || pg_temp.delta(pg_temp.get('before'))
  || '|' || pg_temp.adm(format('SELECT status FROM fin_expense_pending_classification WHERE pending_id = %s', pg_temp.get('p2'))),
  'ERR:CATEGORY_GROUP_INACTIVE|ops+0 postings+0 purchases+0 pending+0 resolutions+0|OK:SIN_CLASIFICAR');
SELECT pg_temp.expect('D-9 invalid register inputs refused, nothing written (amount, concept, cheque, inactive account, reserved key, origin)',
  left(pg_temp.reg('2026-10-21', 0, 'Caja chica', 'CASH', 'WA:test-0102-x1'), 18) || '|' || left(pg_temp.reg('2026-10-21', 10.001, 'Caja chica', 'CASH', 'WA:test-0102-x2'), 18)
  || '|' || left(pg_temp.reg('2026-10-21', 100, 'Caja chica', 'CASH', 'WA:test-0102-x3', '  '), 20) || '|' || left(pg_temp.reg('2026-10-21', 100, 'Caja chica', 'CHEQUE', 'WA:test-0102-x4'), 26)
  || '|' || left(pg_temp.adm(format('SELECT register_unclassified_expense(''2026-10-21'', 100, ''x'', %L::uuid, ''CASH'', ''WA:test-0102-x5'')::text', gen_random_uuid())), 33)
  || '|' || left(pg_temp.reg('2026-10-21', 100, 'Caja chica', 'CASH', 'RECTIFY:abc'), 28) || '|' || left(pg_temp.reg('2026-10-21', 100, 'Caja chica', 'CASH', 'EXPENSE-PENDING:1'), 28)
  || '|' || left(pg_temp.adm(format('SELECT register_unclassified_expense(''2026-10-21'', 100, ''x'', %L::uuid, ''CASH'', ''WA:test-0102-x6'', NULL, ''OTRO'')::text', pg_temp.acc('Caja chica'))), 18)
  || '|' || pg_temp.delta(pg_temp.get('before')),
  'ERR:INVALID_AMOUNT|ERR:INVALID_AMOUNT|ERR:CONCEPT_REQUIRED|ERR:INVALID_PAYMENT_METHOD|ERR:ACCOUNT_NOT_FOUND_OR_INACTIVE|ERR:RESERVED_IDEMPOTENCY_KEY|ERR:RESERVED_IDEMPOTENCY_KEY|ERR:INVALID_ORIGIN|ops+0 postings+0 purchases+0 pending+0 resolutions+0');
SELECT pg_temp.expect('D-10 a key already used by a casual purchase cannot register a pending (one key = one expense)',
  pg_temp.adm(format('SELECT (register_casual_purchase(''2026-10-21'', 500, 500, ''bbbbbbbb-0102-0000-0000-0000000000c1'', ''casual'', ''OPERATING'', %L::uuid, ''CASH'', ''WA:test-0102-dup'') ->> ''replayed'')',
                     pg_temp.acc('Caja chica'))) || '|' || left(pg_temp.reg('2026-10-21', 500, 'Caja chica', 'CASH', 'WA:test-0102-dup'), 25),
  'OK:false|ERR:IDEMPOTENCY_CONFLICT%');

-- integrity triggers: what an RPC never does is refused at COMMIT (forced here with SET CONSTRAINTS IMMEDIATE inside a
-- subtransaction that is always rolled back, so the attempt leaves nothing behind)
CREATE FUNCTION pg_temp.bad(p_sql TEXT) RETURNS TEXT LANGUAGE plpgsql AS $f$
DECLARE msg TEXT;
BEGIN
  BEGIN
    EXECUTE p_sql;
    SET CONSTRAINTS ALL IMMEDIATE;
    RAISE EXCEPTION 'NO_INTEGRITY_ERROR';
  EXCEPTION WHEN others THEN GET STACKED DIAGNOSTICS msg = MESSAGE_TEXT;
  END;
  SET CONSTRAINTS ALL DEFERRED;
  RETURN 'ERR:' || msg;
END $f$;
SELECT pg_temp.expect('D-11 an EXPENSE-PENDING operation without its pending is refused at commit',
  pg_temp.bad($q$ INSERT INTO financial_operation (operation_type, effective_date, external_ref) VALUES ('PURCHASE_PAYMENT', '2026-10-21', 'EXPENSE-PENDING:999999') $q$),
  'ERR:EXPENSE_PENDING_INTEGRITY%');
SELECT pg_temp.expect('D-12 a second posting on a pending payment is refused at commit',
  pg_temp.bad(format($q$ INSERT INTO financial_posting (financial_operation_id, financial_account_id, signed_amount, effective_date) VALUES (%s, %L::uuid, -1, '2026-10-21') $q$,
                     pg_temp.j(pg_temp.get('r2')) ->> 'payment_operation_id', pg_temp.acc('Caja chica'))),
  'ERR:EXPENSE_PENDING_INTEGRITY%');
SELECT pg_temp.expect('D-13 a purchase written on a pending payment without its classification is refused at commit (no double count)',
  pg_temp.bad(format($q$ INSERT INTO purchases (supplier_id, economic_date, amount_net, amount_total, expense_category_id, subcategory, nature, paid_operation_id, is_current, version_seq, idempotency_key)
                         VALUES (NULL, '2026-10-21', 4000, 4000, 'bbbbbbbb-0102-0000-0000-0000000000c1', 'x', 'OPERATING', %s, true, 0, 'bypass-0102') $q$,
                     pg_temp.j(pg_temp.get('r2')) ->> 'payment_operation_id')),
  'ERR:EXPENSE_PENDING_INTEGRITY%');
SELECT pg_temp.expect('D-13b a pending pointing at an ordinary payment (not its own EXPENSE-PENDING operation) is refused at commit',
  pg_temp.bad(format($q$ INSERT INTO expense_pending_classification (payment_operation_id, financial_account_id, payment_method, amount, economic_date, concept, idempotency_key, origin, created_by)
                         SELECT paid_operation_id, %L::uuid, 'CASH', 500, '2026-10-21', 'x', 'bypass-0102b', 'ERP', %L::uuid FROM purchases WHERE idempotency_key = 'WA:test-0102-dup' $q$,
                     pg_temp.acc('Caja chica'), pg_temp.v('admin_a'))),
  'ERR:EXPENSE_PENDING_INTEGRITY%');
SELECT pg_temp.expect('D-14 pending and resolution rows are immutable (UPDATE / DELETE refused even for the owner)',
  pg_temp.as_('postgres', NULL, format('UPDATE expense_pending_classification SET amount = 1 WHERE id = %s RETURNING id::text', pg_temp.get('p2'))) || '|'
  || pg_temp.as_('postgres', NULL, format('DELETE FROM expense_pending_resolution WHERE pending_id = %s RETURNING id::text', pg_temp.get('p1'))),
  'ERR:FIN_EVIDENCE_IMMUTABLE%|ERR:FIN_EVIDENCE_IMMUTABLE%');
SELECT pg_temp.expect('A-7 deferred integrity holds after the refused attempts were cleaned', pg_temp.commit_check(), 'OK');

-- ── E: BNA and Patagonia — balance, statement reconciliation before and after classifying ──
SELECT pg_temp.put('pat0', pg_temp.bal('Patagonia')::text), pg_temp.put('bna0', pg_temp.bal('BNA')::text), pg_temp.put('before', pg_temp.counts()) \g /dev/null
SELECT pg_temp.put('r3', pg_temp.reg('2026-10-21', 12000, 'Patagonia', 'TRANSFER', 'WA:test-0102-pat', 'flete')),
       pg_temp.put('r4', pg_temp.reg('2026-10-21', 9000, 'BNA', 'TRANSFER', 'WA:test-0102-bna', 'veterinario')) \g /dev/null
SELECT pg_temp.expect('E-1 Patagonia −12 000 and BNA −9 000 immediately; 2 operations, 2 postings, 0 purchases',
  (pg_temp.bal('Patagonia') - pg_temp.get('pat0')::numeric) || '|' || (pg_temp.bal('BNA') - pg_temp.get('bna0')::numeric) || '|' || pg_temp.delta(pg_temp.get('before')),
  '-12000.00|-9000.00|ops+2 postings+2 purchases+0 pending+2 resolutions+0');
SELECT pg_temp.put('post_pat', pg_temp.q(format('SELECT id FROM financial_posting WHERE financial_operation_id = %s', pg_temp.j(pg_temp.get('r3')) ->> 'payment_operation_id'))),
       pg_temp.put('post_bna', pg_temp.q(format('SELECT id FROM financial_posting WHERE financial_operation_id = %s', pg_temp.j(pg_temp.get('r4')) ->> 'payment_operation_id'))) \g /dev/null
SELECT pg_temp.expect('E-2 the bank statement lines reconcile against the SAME posting while unclassified (Patagonia, BNA)',
  (pg_temp.j(pg_temp.adm(format('SELECT fin_match_statement_line(%s, %s, ''test 0102'')::text', pg_temp.v('line_pat'), pg_temp.get('post_pat')))) ->> 'replayed') || '|'
  || (pg_temp.j(pg_temp.adm(format('SELECT fin_match_statement_line(%s, %s, ''test 0102'')::text', pg_temp.v('line_bna'), pg_temp.get('post_bna')))) ->> 'replayed'),
  'false|false');
SELECT pg_temp.put('before', pg_temp.counts()) \g /dev/null
SELECT pg_temp.expect('E-3 classifying both: no new posting, balances unchanged',
  (pg_temp.j(pg_temp.cls(pg_temp.pid(pg_temp.get('r3')), 'bbbbbbbb-0102-0000-0000-0000000000c2')) ->> 'status') || '|'
  || (pg_temp.j(pg_temp.cls(pg_temp.pid(pg_temp.get('r4')), 'bbbbbbbb-0102-0000-0000-0000000000c2')) ->> 'status') || '|' || pg_temp.delta(pg_temp.get('before'))
  || '|' || (pg_temp.bal('Patagonia') - pg_temp.get('pat0')::numeric) || '|' || (pg_temp.bal('BNA') - pg_temp.get('bna0')::numeric),
  'CLASIFICADO|CLASIFICADO|ops+0 postings+0 purchases+2 pending+0 resolutions+2|-12000.00|-9000.00');
SELECT pg_temp.expect('E-4 the statement matches stay active on the same postings after classifying (MATCHED in the status view)',
  pg_temp.adm(format('SELECT string_agg(reconciliation_status || '':'' || cutover_classification, '','' ORDER BY statement_line_id) FROM fin_statement_line_status WHERE statement_line_id IN (%s, %s)', pg_temp.v('line_pat'), pg_temp.v('line_bna')))
  || '|' || pg_temp.q(format('SELECT count(*) FROM fin_statement_match WHERE financial_posting_id IN (%s, %s) AND reversed_at IS NULL', pg_temp.get('post_pat'), pg_temp.get('post_bna'))),
  'OK:MATCHED:POST_CUTOVER,MATCHED:POST_CUTOVER|2');
SELECT pg_temp.expect('E-5 a second reconciliation of the same posting is refused (no duplicated bank movement)',
  left(pg_temp.adm(format('SELECT fin_match_statement_line(%s, %s, ''x'')::text', pg_temp.v('line_pat'), pg_temp.get('post_bna'))), 40), 'ERR:%');

-- ── F: Mercado Pago — never a second outflow ─────────────────────────────────
SELECT pg_temp.put('mp0', pg_temp.bal('Mercado Pago')::text), pg_temp.put('before', pg_temp.counts()),
       pg_temp.put('mprec0', (SELECT count(*) FROM mp_reconciliation)::text) \g /dev/null
SELECT pg_temp.expect('F-1 the Mercado Pago account is refused (MP_USE_PENDING_OUTFLOW); the MERCADOPAGO method on another account too',
  left(pg_temp.reg('2026-10-20', 8000, 'Mercado Pago', 'MERCADOPAGO', 'WA:test-0102-mp'), 26) || '|' || left(pg_temp.reg('2026-10-20', 8000, 'Caja chica', 'MERCADOPAGO', 'WA:test-0102-mp2'), 26),
  'ERR:MP_USE_PENDING_OUTFLOW|ERR:MP_USE_PENDING_OUTFLOW');
SELECT pg_temp.expect('F-2 Mercado Pago balance, operations, postings and reconciliations unchanged (ADR-021 provisional is the only effect)',
  (pg_temp.bal('Mercado Pago') - pg_temp.get('mp0')::numeric) || '|' || pg_temp.delta(pg_temp.get('before')) || '|' || ((SELECT count(*) FROM mp_reconciliation) - pg_temp.get('mprec0')::int),
  '0.00|ops+0 postings+0 purchases+0 pending+0 resolutions+0|0');
SELECT pg_temp.expect('F-3 the MP outflow stays in its own pending list, classified only through its route (ADR-021)',
  pg_temp.q($q$ SELECT count(*) || '|' || coalesce(sum(amount), 0) FROM mp_pending_outflow p WHERE source_id = '940000102001'
                AND NOT EXISTS (SELECT 1 FROM mp_pending_outflow_resolution r WHERE r.pending_id = p.id) $q$), '1|-8000.00');

-- ── G: periods, permissions ──────────────────────────────────────────────────
SELECT pg_temp.put('r5', pg_temp.reg('2026-12-05', 1500, 'Caja chica', 'CASH', 'WA:test-0102-dic')) \g /dev/null
SELECT pg_temp.expect('G-2 a period with an unclassified expense cannot be closed (PENDING_EXPENSE_CLASSIFICATION)',
  pg_temp.as_('postgres', NULL, $q$ UPDATE management_period SET status = 'CLOSED', closed_at = now() WHERE periodo_fecha = '2026-12-01' RETURNING status::text $q$),
  'ERR:PENDING_EXPENSE_CLASSIFICATION%');
SELECT pg_temp.expect('G-3 classified → the period closes; then registering or classifying in it is refused (PERIOD_CLOSED)',
  (pg_temp.j(pg_temp.cls(pg_temp.pid(pg_temp.get('r5')), 'bbbbbbbb-0102-0000-0000-0000000000c1')) ->> 'status') || '|'
  || pg_temp.as_('postgres', NULL, $q$ UPDATE management_period SET status = 'CLOSED', closed_at = now() WHERE periodo_fecha = '2026-12-01' RETURNING status::text $q$)
  || '|' || left(pg_temp.reg('2026-12-06', 100, 'Caja chica', 'CASH', 'WA:test-0102-dic2'), 8),
  'CLASIFICADO|OK:CLOSED|ERR:%');
SELECT pg_temp.expect('G-4 the closed-period error is the existing one (assert_period_open)', pg_temp.reg('2026-12-06', 100, 'Caja chica', 'CASH', 'WA:test-0102-dic3'), 'ERR:%PERIOD%');
SELECT pg_temp.expect('G-5 OPERATOR: FORBIDDEN on both RPCs; the list shows 0 rows',
  left(pg_temp.reg('2026-10-21', 100, 'Caja chica', 'CASH', 'WA:test-0102-op', 'x', 'oper'), 13) || '|' || left(pg_temp.cls(pg_temp.get('p2'), 'bbbbbbbb-0102-0000-0000-0000000000c1', 'oper'), 13)
  || '|' || pg_temp.as_('authenticated', pg_temp.v('oper'), 'SELECT count(*)::text FROM fin_expense_pending_classification')
  || '|' || pg_temp.as_('authenticated', pg_temp.v('oper'), 'SELECT count(*)::text FROM expense_pending_classification'),
  'ERR:FORBIDDEN|ERR:FORBIDDEN|OK:0|OK:0');
SELECT pg_temp.expect('G-6 a JWT without an ERP profile, anon and service_role cannot register / classify',
  left(pg_temp.as_('authenticated', pg_temp.v('nobody'), format('SELECT register_unclassified_expense(''2026-10-21'', 1, ''x'', %L::uuid, ''CASH'', ''k-nobody'')::text', pg_temp.acc('Caja chica'))), 4)
  || '|' || left(pg_temp.as_('anon', NULL, format('SELECT register_unclassified_expense(''2026-10-21'', 1, ''x'', %L::uuid, ''CASH'', ''k-anon'')::text', pg_temp.acc('Caja chica'))), 22)
  || '|' || left(pg_temp.as_('service_role', NULL, format('SELECT classify_pending_expense(%s, ''bbbbbbbb-0102-0000-0000-0000000000c1'', ''OPERATING'')::text', pg_temp.get('p2'))), 22)
  || '|' || left(pg_temp.as_('anon', NULL, 'SELECT count(*)::text FROM fin_expense_pending_classification'), 22),
  'ERR:|ERR:permission denied%|ERR:permission denied%|ERR:permission denied%');
SELECT pg_temp.expect('G-7 an ADMIN cannot write the tables directly (only through the RPCs)',
  left(pg_temp.adm(format('INSERT INTO expense_pending_classification (payment_operation_id, financial_account_id, payment_method, amount, economic_date, concept, idempotency_key, origin, created_by)
     VALUES (1, %L::uuid, ''CASH'', 1, ''2026-10-21'', ''x'', ''direct'', ''ERP'', %L::uuid) RETURNING id::text', pg_temp.acc('Caja chica'), pg_temp.v('admin_a'))), 22)
  || '|' || left(pg_temp.adm(format('INSERT INTO expense_pending_resolution (pending_id, purchase_id, expense_category_id, nature, resolved_by) VALUES (%s, gen_random_uuid(), %L::uuid, ''OPERATING'', %L::uuid) RETURNING id::text',
     pg_temp.get('p2'), 'bbbbbbbb-0102-0000-0000-0000000000c1', pg_temp.v('admin_a'))), 22),
  'ERR:permission denied%|ERR:permission denied%');
SELECT pg_temp.expect('I-3 the future ERP screen: ADMIN lists only through the view/table (RLS) and classifies through the RPC',
  pg_temp.adm('SELECT count(*) FILTER (WHERE status = ''SIN_CLASIFICAR'') || ''|'' || count(*) FILTER (WHERE status = ''CLASIFICADO'') FROM fin_expense_pending_classification')
  || '|' || pg_temp.adm('SELECT count(*)::text FROM expense_pending_classification'), 'OK:1|4|OK:5');
-- ── UI: the exact contract of Caja → Gastos sin clasificar (src/target/unclassifiedExpenses.ts, PostgREST as ADMIN) ──
SELECT pg_temp.put('ui_cols', 'pending_id, status, economic_date, amount, financial_account_id, account_name, payment_method, concept, counterparty_name, origin, origin_ref, payment_operation_id, created_by, created_at, purchase_id, expense_category_id, category_name, nature, classified_by, classified_at') \g /dev/null
SELECT pg_temp.expect('UI-1 the screen columns + filters (status, dates, account, origin) answer as ADMIN; the indicator counts SIN_CLASIFICAR',
  pg_temp.adm(format('SELECT count(*)::text FROM (SELECT %s FROM fin_expense_pending_classification WHERE status = ''SIN_CLASIFICAR'' AND economic_date >= ''2026-10-01''
     AND economic_date <= ''2026-10-31'' AND financial_account_id = %L::uuid AND origin = ''WHATSAPP'' ORDER BY economic_date, pending_id LIMIT 50) x', pg_temp.get('ui_cols'), pg_temp.acc('Caja chica')))
  || '|' || pg_temp.adm('SELECT count(*)::text FROM fin_expense_pending_classification WHERE status = ''SIN_CLASIFICAR'''), 'OK:1|OK:1');
SELECT pg_temp.expect('UI-2 the screen columns are 0 rows for OPERATOR and refused for anon',
  pg_temp.as_('authenticated', pg_temp.v('oper'), format('SELECT count(*)::text FROM (SELECT %s FROM fin_expense_pending_classification) x', pg_temp.get('ui_cols')))
  || '|' || left(pg_temp.as_('anon', NULL, format('SELECT count(*)::text FROM (SELECT %s FROM fin_expense_pending_classification) x', pg_temp.get('ui_cols'))), 22),
  'OK:0|ERR:permission denied%');
SELECT pg_temp.put('before', pg_temp.counts()), pg_temp.put('cajaUI', pg_temp.bal('Caja chica')::text), pg_temp.put('totUI', pg_temp.pnl('2026-10-01', 'resultado_post_inversiones')) \g /dev/null
SELECT pg_temp.expect('UI-3 the screen call (named parameters as PostgREST sends them; concept / counterparty null = kept) classifies with no movement',
  (pg_temp.j(pg_temp.adm(format('SELECT classify_pending_expense(p_pending_id := %s, p_expense_category_id := %L::uuid, p_nature := ''OPERATING'', p_concept := NULL,
     p_counterparty_name := NULL, p_reason := NULL)::text', pg_temp.get('p2'), 'bbbbbbbb-0102-0000-0000-0000000000c2'))) ->> 'status')
  || '|' || pg_temp.delta(pg_temp.get('before')) || '|' || (pg_temp.bal('Caja chica') - pg_temp.get('cajaUI')::numeric)
  || '|' || (pg_temp.pnl('2026-10-01', 'resultado_post_inversiones')::numeric - pg_temp.get('totUI')::numeric)
  || '|' || pg_temp.adm(format('SELECT status || '':'' || concept FROM fin_expense_pending_classification WHERE pending_id = %s', pg_temp.get('p2'))),
  'CLASIFICADO|ops+0 postings+0 purchases+1 pending+0 resolutions+1|0.00|0.00|OK:CLASIFICADO:combustible');
SELECT pg_temp.expect('UI-4 the P&L line the screen shows (pnl_summary.gastos_sin_clasificar) is readable by ADMIN and 0 rows for OPERATOR',
  pg_temp.adm('SELECT count(*)::text FROM pnl_summary WHERE gastos_sin_clasificar IS NOT NULL') || '|'
  || pg_temp.as_('authenticated', pg_temp.v('oper'), 'SELECT count(*)::text FROM pnl_summary'), 'OK:_%|OK:0');
SELECT pg_temp.expect('A-8 final: deferred integrity holds for every row written by the suite', pg_temp.commit_check(), 'OK');

SELECT 'SUMMARY|' || count(*) FILTER (WHERE ok) || '|' || count(*) FILTER (WHERE NOT ok) FROM t_result;
