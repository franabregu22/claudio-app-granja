-- ============================================================================
-- ADR-006 STEP 13 — CURRENT-TARGET CLEAN-CUTOVER VALIDATION (read-only, repeatable)
--
-- Derived mechanically from the historical Phase 26 validator
-- scripts/phase26/validate-clean-cutover.sql (never modified), per ADR006_TEST_MATRIX_V1 CT-3:
--   C01  ledger = the number of migration files present (psql variable :expected_migrations,
--        derived at run time by scripts/regression/clean-cutover-current-target.mjs; not hard-coded)
--   C16  extended with the six ADR-006 tables (mp_webhook_delivery, mp_transition_identity, mp_report_match, mp_client_allocation, mp_payer_client_map, mp_attribution_flag) = 0 rows
-- Every other check (C02–C24) and the canonical DIGEST query are identical to the historical file.
-- Emits CHECK|<id>|PASS or FAIL|<detail> and DIGEST|<table>|<md5>|<rows>, exactly as Phase 26.
-- ============================================================================

WITH e AS (SELECT (SELECT value FROM phase26_migration.expected WHERE key = 'counts') AS c,
                  (SELECT value FROM phase26_migration.expected WHERE key = 'population') AS pop,
                  (SELECT value FROM phase26_migration.expected WHERE key = 'product_types') AS pt,
                  (SELECT value #>> '{}' FROM phase26_migration.expected WHERE key = 'import_batch') AS batch,
                  (SELECT value FROM phase26_migration.expected WHERE key = 'category_classes') AS cc),
lin AS (SELECT * FROM phase26_migration.lineage),
mig_users AS (SELECT p.* FROM perfiles p JOIN lin ON lin.target_entity = 'perfiles' AND lin.target_key = p.id::text),
chk(id, ok, detail) AS (
  SELECT 'C01_migrations_applied', (SELECT count(*) FROM migration_ledger.applied) = :expected_migrations,
         'ledger=' || (SELECT count(*) FROM migration_ledger.applied) || ' migration_files=' || :expected_migrations
  UNION ALL SELECT 'C02_single_import_batch',
         (SELECT count(DISTINCT import_batch) FROM lin) = 1 AND (SELECT min(import_batch) FROM lin) = (SELECT batch FROM e),
         'batches=' || (SELECT count(DISTINCT import_batch) FROM lin)
  UNION ALL SELECT 'C03_users_and_roles',
         (SELECT count(*) FROM mig_users) = ((SELECT c FROM e)->>'users')::int
     AND (SELECT count(*) FROM mig_users WHERE rol_type = 'ADMIN') = ((SELECT c FROM e)->>'admins')::int
     AND (SELECT count(*) FROM mig_users WHERE rol_type = 'OPERATOR') = ((SELECT c FROM e)->>'operators')::int
     AND (SELECT count(*) FROM perfiles) = (SELECT count(*) FROM mig_users),
         'users=' || (SELECT count(*) FROM mig_users) || ' perfiles=' || (SELECT count(*) FROM perfiles)
  UNION ALL SELECT 'C04_rehearsal_synthetic_emails',
         (SELECT count(*) FROM mig_users WHERE email LIKE '%@example.invalid') = (SELECT count(*) FROM mig_users),
         'synthetic=' || (SELECT count(*) FROM mig_users WHERE email LIKE '%@example.invalid') || ' (rehearsal marker; cutover gate refuses these)'
  UNION ALL SELECT 'C05_clients',
         (SELECT count(*) FROM clients c JOIN lin ON lin.target_entity = 'clients' AND lin.target_key = c.id::text) = ((SELECT c FROM e)->>'clients')::int
     AND (SELECT count(*) FROM clients) = ((SELECT c FROM e)->>'clients')::int + 1
     AND EXISTS (SELECT 1 FROM clients WHERE nombre = 'CONSUMIDOR FINAL'),
         'clients=' || (SELECT count(*) FROM clients) || ' (migrated + seeded CONSUMIDOR FINAL)'
  UNION ALL SELECT 'C06_products_and_types',
         (SELECT count(*) FROM products) = ((SELECT c FROM e)->>'products')::int
     AND NOT EXISTS (SELECT 1 FROM products p WHERE p.product_type::text IS DISTINCT FROM (SELECT pt FROM e)->>(p.id::text)),
         'products=' || (SELECT count(*) FROM products)
  UNION ALL SELECT 'C07_expense_categories',
         (SELECT count(*) FROM expense_category) = ((SELECT c FROM e)->>'categories')::int
     AND (SELECT count(*) FROM expense_category x JOIN lin ON lin.target_entity = 'expense_category' AND lin.target_key = x.id::text)
           = ((SELECT c FROM e)->>'categories')::int
     AND NOT EXISTS (SELECT 1 FROM expense_category WHERE pnl_cost_class IS NULL)
     AND (SELECT count(*) FROM jsonb_object_keys((SELECT cc FROM e)->'by_id')) = ((SELECT c FROM e)->>'categories')::int
     AND NOT EXISTS (SELECT 1 FROM expense_category x
                      WHERE x.pnl_cost_class::text IS DISTINCT FROM (SELECT cc FROM e)->'by_id'->>(x.id::text))
     AND ((SELECT cc FROM e)->>'policy' <> 'REHEARSAL_ALL_INDIRECT'
          OR ((SELECT cc FROM e)->>'rehearsal_class' = 'INDIRECT'
              AND NOT EXISTS (SELECT 1 FROM expense_category WHERE pnl_cost_class <> 'INDIRECT'))),
         'categories=' || (SELECT count(*) FROM expense_category) || ' policy=' || coalesce((SELECT cc FROM e)->>'policy', 'NULL')
         || ' ' || coalesce((SELECT string_agg(pnl_cost_class || '=' || n, ',' ORDER BY pnl_cost_class)
                               FROM (SELECT pnl_cost_class::text, count(*) n FROM expense_category GROUP BY 1) z), 'none')
  UNION ALL SELECT 'C08_sheds_flocks_active',
         (SELECT count(*) FROM sheds) = ((SELECT c FROM e)->>'sheds')::int
     AND (SELECT count(*) FROM flocks) = ((SELECT c FROM e)->>'flocks')::int
     AND (SELECT count(*) FROM flocks WHERE estado = 'ACTIVE') = ((SELECT c FROM e)->>'active_flocks')::int
     AND NOT EXISTS (SELECT 1 FROM flocks WHERE estado = 'ACTIVE' GROUP BY shed_id HAVING count(*) > 1),
         'sheds=' || (SELECT count(*) FROM sheds) || ' flocks=' || (SELECT count(*) FROM flocks) || ' active=' || (SELECT count(*) FROM flocks WHERE estado = 'ACTIVE')
  UNION ALL SELECT 'C09_population_arithmetic',
         NOT EXISTS (SELECT 1 FROM flocks f
                      WHERE f.initial_population + coalesce((SELECT sum(delta) FROM population_events pe WHERE pe.flock_id = f.id AND pe.is_current), 0)
                            IS DISTINCT FROM ((SELECT pop FROM e)->(f.id::text)->>'population')::bigint
                         OR f.initial_population IS DISTINCT FROM ((SELECT pop FROM e)->(f.id::text)->>'initial')::bigint),
         (SELECT string_agg(f.id::text || '=' || (f.initial_population + coalesce((SELECT sum(delta) FROM population_events pe
                  WHERE pe.flock_id = f.id AND pe.is_current), 0)), ' ' ORDER BY f.id) FROM flocks f)
  UNION ALL SELECT 'C10_population_non_negative',
         NOT EXISTS (SELECT 1 FROM flocks f WHERE f.initial_population + coalesce((SELECT sum(delta) FROM population_events pe
                      WHERE pe.flock_id = f.id AND pe.is_current), 0) < 0), 'min population >= 0'
  UNION ALL SELECT 'C11_population_events_scope',
         (SELECT count(*) FROM population_events) = ((SELECT c FROM e)->>'events')::int
     AND NOT EXISTS (SELECT 1 FROM population_events WHERE event_type <> 'MORTALITY' OR NOT is_current OR version_seq <> 0
                                                       OR reason NOT LIKE 'legacy:producciones:% ' || (SELECT batch FROM e))
     AND NOT EXISTS (SELECT 1 FROM population_events WHERE event_type = 'MORTALITY' AND is_current GROUP BY flock_id, event_date HAVING count(*) > 1),
         'events=' || (SELECT count(*) FROM population_events)
  UNION ALL SELECT 'C12_operator_assignments',
         (SELECT count(*) FROM operator_assignments) = ((SELECT c FROM e)->>'assignments')::int
     AND NOT EXISTS (SELECT 1 FROM operator_assignments a JOIN perfiles p ON p.id = a.operator_id WHERE p.rol_type <> 'OPERATOR' OR NOT a.activo)
     AND NOT EXISTS (SELECT 1 FROM operator_assignments a JOIN flocks f ON f.id = a.flock_id WHERE f.estado <> 'ACTIVE'),
         'assignments=' || (SELECT count(*) FROM operator_assignments)
  UNION ALL SELECT 'C13_zero_client_openings_and_history',
         (SELECT count(*) FROM client_ledger) = 0, 'client_ledger=' || (SELECT count(*) FROM client_ledger)
  UNION ALL SELECT 'C14_zero_treasury_postings',
         (SELECT count(*) FROM financial_operation) = 0 AND (SELECT count(*) FROM financial_posting) = 0,
         'operations=' || (SELECT count(*) FROM financial_operation) || ' postings=' || (SELECT count(*) FROM financial_posting)
  UNION ALL SELECT 'C15_no_suppliers_instruments',
         (SELECT count(*) FROM suppliers) + (SELECT count(*) FROM supplier_ledger) + (SELECT count(*) FROM financial_instrument)
       + (SELECT count(*) FROM financial_instrument_event) = 0, 'supplier/instrument rows = 0'
  UNION ALL SELECT 'C16_no_history_loaded',
         (SELECT count(*) FROM pedidos) + (SELECT count(*) FROM pedido_lineas) + (SELECT count(*) FROM collections)
       + (SELECT count(*) FROM daily_production) + (SELECT count(*) FROM price_history)
       + (SELECT count(*) FROM mp_source_record) + (SELECT count(*) FROM mp_financial_movement) + (SELECT count(*) FROM mp_reconciliation)
       + (SELECT count(*) FROM purchases) + (SELECT count(*) FROM purchase_line) + (SELECT count(*) FROM freight)
       + (SELECT count(*) FROM sales_session) + (SELECT count(*) FROM feed_manufacturing) + (SELECT count(*) FROM feed_movement)
       + (SELECT count(*) FROM classification) + (SELECT count(*) FROM fiscal_document) + (SELECT count(*) FROM management_event)
       + (SELECT count(*) FROM mp_webhook_delivery) + (SELECT count(*) FROM mp_transition_identity) + (SELECT count(*) FROM mp_report_match) + (SELECT count(*) FROM mp_client_allocation) + (SELECT count(*) FROM mp_payer_client_map) + (SELECT count(*) FROM mp_attribution_flag) = 0,
         'historical/operational fact rows = 0; ADR-006 ' || 'mp_webhook_delivery=' || (SELECT count(*) FROM mp_webhook_delivery) || ' ' || 'mp_transition_identity=' || (SELECT count(*) FROM mp_transition_identity) || ' ' || 'mp_report_match=' || (SELECT count(*) FROM mp_report_match) || ' ' || 'mp_client_allocation=' || (SELECT count(*) FROM mp_client_allocation) || ' ' || 'mp_payer_client_map=' || (SELECT count(*) FROM mp_payer_client_map) || ' ' || 'mp_attribution_flag=' || (SELECT count(*) FROM mp_attribution_flag)
  UNION ALL SELECT 'C17_seeded_accounts_untouched',
         (SELECT count(*) FROM financial_account) = 4
     AND (SELECT string_agg(nombre, ',' ORDER BY nombre) FROM financial_account) = 'BNA,Caja chica,Mercado Pago,Patagonia',
         'accounts=' || (SELECT string_agg(nombre, ',' ORDER BY nombre) FROM financial_account)
  UNION ALL SELECT 'C18_lineage_cardinality',
         (SELECT count(*) FROM lin) = ((SELECT c FROM e)->>'lineage')::int
     AND NOT EXISTS (SELECT 1 FROM lin GROUP BY source_system, source_entity, source_id, import_batch HAVING count(*) > 1)
     AND NOT EXISTS (SELECT 1 FROM lin GROUP BY import_batch, target_entity, target_key HAVING count(*) > 1),
         'lineage=' || (SELECT count(*) FROM lin)
  UNION ALL SELECT 'C19_migration_audit_attribution',
         (SELECT count(*) FROM audit_events WHERE action = 'MIGRATION_LOAD')
           = ((SELECT c FROM e)->>'users')::int + ((SELECT c FROM e)->>'clients')::int + ((SELECT c FROM e)->>'products')::int
           + ((SELECT c FROM e)->>'categories')::int + ((SELECT c FROM e)->>'flocks')::int
     AND (SELECT count(*) FROM audit_events WHERE action = 'MORTALITY') = ((SELECT c FROM e)->>'events')::int,
         'MIGRATION_LOAD=' || (SELECT count(*) FROM audit_events WHERE action = 'MIGRATION_LOAD')
         || ' MORTALITY=' || (SELECT count(*) FROM audit_events WHERE action = 'MORTALITY')
  UNION ALL SELECT 'C20_periods_open_for_events',
         NOT EXISTS (SELECT 1 FROM population_events pe LEFT JOIN management_period m ON m.periodo_fecha = date_trunc('month', pe.event_date)::date
                      WHERE m.status IS DISTINCT FROM 'OPEN'), 'every event month is an OPEN period'
  UNION ALL SELECT 'C21_lineage_key_contract',
         (SELECT string_agg(a.attname, ',' ORDER BY k.ord) FROM pg_constraint pc
            CROSS JOIN LATERAL unnest(pc.conkey) WITH ORDINALITY k(attnum, ord)
            JOIN pg_attribute a ON a.attrelid = pc.conrelid AND a.attnum = k.attnum
           WHERE pc.conrelid = 'phase26_migration.lineage'::regclass AND pc.contype = 'p')
           = 'source_system,source_entity,source_id,import_batch'
     AND EXISTS (SELECT 1 FROM pg_constraint pc WHERE pc.conrelid = 'phase26_migration.lineage'::regclass AND pc.contype = 'u'
                   AND (SELECT string_agg(a.attname, ',' ORDER BY k.ord) FROM unnest(pc.conkey) WITH ORDINALITY k(attnum, ord)
                          JOIN pg_attribute a ON a.attrelid = pc.conrelid AND a.attnum = k.attnum) = 'import_batch,target_entity,target_key'),
         'PK (source_system, source_entity, source_id, import_batch); UNIQUE (import_batch, target_entity, target_key)'
  UNION ALL SELECT 'C22_run_log_deterministic',
         (SELECT count(*) FROM phase26_migration.run_log) = 2
     AND (SELECT string_agg(command, ',' ORDER BY command) FROM phase26_migration.run_log) = 'load-masters,load-population'
     AND NOT EXISTS (SELECT 1 FROM phase26_migration.run_log r
                      WHERE r.import_batch IS DISTINCT FROM (SELECT batch FROM e)
                         OR r.config_sha256 IS DISTINCT FROM (SELECT value->>'config_sha256' FROM phase26_migration.expected WHERE key = 'plan')
                         OR r.plan_sha256   IS DISTINCT FROM (SELECT value->>'plan_sha256'   FROM phase26_migration.expected WHERE key = 'plan')),
         'run_log=' || (SELECT count(*) FROM phase26_migration.run_log) || ' (one row per command for this batch/config/plan)'
  UNION ALL SELECT 'C23_expectations_complete',
         (SELECT string_agg(key, ',' ORDER BY key) FROM phase26_migration.expected) = 'category_classes,counts,import_batch,plan,population,product_types',
         'expected=' || (SELECT string_agg(key, ',' ORDER BY key) FROM phase26_migration.expected)
  UNION ALL SELECT 'C24_mortality_audit_matches_event',
         (SELECT count(*) FROM audit_events a JOIN population_events pe ON pe.id::text = a.entity_id
           WHERE a.action = 'MORTALITY' AND a.entity_type = 'population_events'
             AND a.after_values = jsonb_build_object('flock_id', pe.flock_id, 'event_date', pe.event_date, 'deaths', -pe.delta)
             AND a.reason IS NOT DISTINCT FROM pe.reason AND a.performed_by IS NOT DISTINCT FROM pe.created_by)
           = (SELECT count(*) FROM audit_events WHERE action = 'MORTALITY'),
         'every MORTALITY audit resolves to its population event (flock, date, deaths, reason, actor)'
)
SELECT 'CHECK', id, CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END, detail FROM chk ORDER BY id;

-- ---------------------------------------------------------------------------
-- Canonical state digest (no timestamps, no bigserial ids, no seed-random ids)
-- ---------------------------------------------------------------------------
SELECT 'DIGEST', t, md5(coalesce(string_agg(r, E'\n' ORDER BY r), '')), count(*) FROM (
  SELECT 'perfiles' AS t, concat_ws('|', id, email, rol_type, activo) AS r FROM perfiles
  UNION ALL SELECT 'clients', concat_ws('|', CASE WHEN nombre = 'CONSUMIDOR FINAL' THEN 'seed' ELSE id::text END, nombre, activo) FROM clients
  UNION ALL SELECT 'products', concat_ws('|', id, nombre, product_type, unit_type, activo) FROM products
  UNION ALL SELECT 'expense_category', concat_ws('|', id, nombre, description, activo, pnl_cost_class) FROM expense_category
  UNION ALL SELECT 'sheds', concat_ws('|', id, nombre, capacidad, activo) FROM sheds
  UNION ALL SELECT 'flocks', concat_ws('|', id, shed_id, estado, genetics_line, birth_date, entry_date, initial_population, exit_date, created_by) FROM flocks
  UNION ALL SELECT 'operator_assignments', concat_ws('|', id, operator_id, flock_id, activo, assigned_by) FROM operator_assignments
  UNION ALL SELECT 'population_events', concat_ws('|', flock_id, event_type, delta, event_date, is_current, version_seq, reason, created_by) FROM population_events
  -- audit: id and performed_at are generated and excluded. For MORTALITY, entity_id is the BIGSERIAL
  -- population_events.id; it is replaced by that event's business key (flock|date|type|version), so the
  -- link is kept (C24 proves it) without depending on sequence values. after_values holds only
  -- flock_id, event_date and deaths (0024 register_mortality) and is kept verbatim.
  UNION ALL SELECT 'audit_events', concat_ws('|', a.entity_type,
                     CASE WHEN a.action = 'MORTALITY'
                          THEN coalesce((SELECT concat_ws('#', pe.flock_id, pe.event_date, pe.event_type, pe.version_seq)
                                           FROM population_events pe WHERE pe.id::text = a.entity_id), 'UNRESOLVED')
                          ELSE a.entity_id END,
                     a.action, a.before_values, a.after_values, a.reason, a.performed_by) FROM audit_events a
  UNION ALL SELECT 'financial_account', concat_ws('|', nombre, account_type, activo) FROM financial_account
  UNION ALL SELECT 'lineage', concat_ws('|', source_system, source_entity, source_id, import_batch, target_entity, target_key) FROM phase26_migration.lineage
  UNION ALL SELECT 'expected', concat_ws('|', key, value) FROM phase26_migration.expected
  -- run_log: `at` is a wall-clock timestamp and is excluded; the row identity is deterministic
  UNION ALL SELECT 'run_log', concat_ws('|', command, import_batch, config_sha256, plan_sha256) FROM phase26_migration.run_log
) x GROUP BY t ORDER BY t;
