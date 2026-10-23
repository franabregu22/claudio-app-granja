-- ADR-025 §18.4 — LOCAL ERP fixtures for the candidate suite (inside the rolled-back transaction; never committed).
-- psql variables: admin_a admin_b oper gw phone_a phone_b phone_oper (same names as the staging seed).
SET LOCAL search_path = public, pg_temp;
SELECT set_config('wa.fx_admin_a', :'admin_a', true) \g /dev/null
INSERT INTO perfiles (id, email, rol_type) VALUES
  (:'admin_a', 'wa-admin-a@test.local', 'ADMIN'), (:'admin_b', 'wa-admin-b@test.local', 'ADMIN'), (:'oper', 'wa-oper@test.local', 'OPERATOR');
INSERT INTO suppliers (id, nombre) VALUES ('aaaaaaaa-0025-0000-0000-0000000000a1', 'Proveedor ADR-025');
INSERT INTO expense_category (id, nombre, pnl_cost_class, group_id)
VALUES ('aaaaaaaa-0025-0000-0000-0000000000c1', 'Categoría ADR-025', 'INDIRECT', (SELECT id FROM expense_category_group WHERE nombre = 'Otros'));
-- ADR-021 provisional outflows (OUTBOUND, report rows), posted by the real mp_pending_outflow_post: 1,000.00 and 2,500.00 on 2026-10-20
DO $$
DECLARE r RECORD; v_src UUID; v_mv BIGINT;
BEGIN
  FOR r IN SELECT * FROM (VALUES ('930000025001', -1000.00, -6.00), ('930000025002', -2500.00, -15.00)) x(sid, gross, tax) LOOP
    INSERT INTO mp_source_record (source_type, external_id, event_data, occurred_at, occurred_date)
    VALUES ('csv_import', r.sid || ':payment:D', jsonb_build_object('SOURCE_ID', r.sid, 'DESCRIPTION', 'payment', 'NET_CREDIT_AMOUNT', '0.00',
            'NET_DEBIT_AMOUNT', to_char(-(r.gross + r.tax), 'FM999999990.00')), '2026-10-20T10:00:00-03:00', '2026-10-20')
    RETURNING id INTO v_src;
    INSERT INTO mp_financial_movement (mp_source_record_id, movement_kind, gross_amount, fee_amount, tax_amount, net_amount, occurred_date)
    VALUES (v_src, 'outbound', r.gross, 0, r.tax, r.gross + r.tax, '2026-10-20') RETURNING id INTO v_mv;
    INSERT INTO mp_transition_identity (resource_type, resource_id, transition, transition_ref, claimed_by_source_id, mp_financial_movement_id)
    VALUES ('report', r.sid || ':payment:D', 'OUTBOUND', '', v_src, v_mv);
    IF mp_pending_outflow_post(r.sid, NULL, current_setting('wa.fx_admin_a')::uuid) <> 'POSTED' THEN RAISE EXCEPTION 'fixture: outflow % not posted', r.sid; END IF;
  END LOOP;
END $$;
INSERT INTO wa.sender (phone_e164, perfil_id) VALUES (:'phone_a', :'admin_a'), (:'phone_b', :'admin_b'), (:'phone_oper', :'oper');
INSERT INTO wa.config (gateway_user_id, enabled) VALUES (:'gw', true);
