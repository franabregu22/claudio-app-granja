-- ============================================================================
-- PHASE 31 — CUTOVER TARGET VALIDATION (read-only, repeatable; C01–C26)
--
-- Derived from the Phase 26 validator (scripts/phase26/validate-clean-cutover.sql, unchanged) for the REAL
-- cutover. Differences:
--   C01  ledger = the migration files present (psql variable :expected_migrations)
--   C04  real Auth emails: every migrated profile has its restored auth.users row with the same email;
--        no @example.invalid anywhere (replaces the rehearsal synthetic-email marker)
--   C06 / C07  read without the two ADR-016 reference rows seeded by 0070
--   C11  MORTALITY history + P-b COUNT_ADJUSTMENT rows only
--   C13 / C14  owner-validated client and treasury openings, exactly as planned, on the cutover date
--   C16  extended with the ADR-006 tables and sales_session_closing (all empty)
--   C22 / C23  three run_log commands; nine expectation keys
--   C25  the ADR-017 MP cutover boundary equals the plan
--   C26  every auth.users row is a migrated profile or an allowed extra (checked by the runner's auth preflight)
-- Emits CHECK|<id>|PASS or FAIL|<detail> and DIGEST|<table>|<md5>|<rows>. Prints no email, hash or token.
-- ============================================================================

WITH e AS (SELECT (SELECT value FROM phase26_migration.expected WHERE key = 'counts') AS c,
                  (SELECT value FROM phase26_migration.expected WHERE key = 'population') AS pop,
                  (SELECT value FROM phase26_migration.expected WHERE key = 'product_types') AS pt,
                  (SELECT value #>> '{}' FROM phase26_migration.expected WHERE key = 'import_batch') AS batch,
                  (SELECT value FROM phase26_migration.expected WHERE key = 'category_classes') AS cc,
                  (SELECT value FROM phase26_migration.expected WHERE key = 'client_openings') AS co,
                  (SELECT value FROM phase26_migration.expected WHERE key = 'treasury_openings') AS tro,
                  (SELECT value FROM phase26_migration.expected WHERE key = 'cutover') AS cut),
lin AS (SELECT * FROM phase26_migration.lineage),
mig_users AS (SELECT p.* FROM perfiles p JOIN lin ON lin.target_entity = 'perfiles' AND lin.target_key = p.id::text),
prod AS (SELECT * FROM products WHERE NOT is_system),
cat AS (SELECT * FROM expense_category WHERE nombre <> 'Gastos de Feria'),
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
  UNION ALL SELECT 'C04_real_auth_emails',
         NOT EXISTS (SELECT 1 FROM mig_users m LEFT JOIN auth.users u ON u.id = m.id WHERE u.id IS NULL OR u.email IS DISTINCT FROM m.email)
     AND (SELECT count(*) FROM perfiles WHERE email ILIKE '%@example.invalid') + (SELECT count(*) FROM auth.users WHERE email ILIKE '%@example.invalid') = 0,
         'profiles with their auth.users row and the same email=' || (SELECT count(*) FROM mig_users m JOIN auth.users u ON u.id = m.id AND u.email = m.email)
  UNION ALL SELECT 'C05_clients',
         (SELECT count(*) FROM clients c JOIN lin ON lin.target_entity = 'clients' AND lin.target_key = c.id::text) = ((SELECT c FROM e)->>'clients')::int
     AND (SELECT count(*) FROM clients) = ((SELECT c FROM e)->>'clients')::int + 1
     AND EXISTS (SELECT 1 FROM clients WHERE nombre = 'CONSUMIDOR FINAL'),
         'clients=' || (SELECT count(*) FROM clients) || ' (migrated + seeded CONSUMIDOR FINAL)'
  UNION ALL SELECT 'C06_products_and_types',
         (SELECT count(*) FROM prod) = ((SELECT c FROM e)->>'products')::int
     AND NOT EXISTS (SELECT 1 FROM prod p WHERE p.product_type::text IS DISTINCT FROM (SELECT pt FROM e)->>(p.id::text))
     AND (SELECT count(*) FROM products WHERE is_system) = 1,
         'products=' || (SELECT count(*) FROM prod) || ' (+1 ADR-016 system product)'
  UNION ALL SELECT 'C07_expense_categories',
         (SELECT count(*) FROM cat) = ((SELECT c FROM e)->>'categories')::int
     AND (SELECT count(*) FROM cat x JOIN lin ON lin.target_entity = 'expense_category' AND lin.target_key = x.id::text) = ((SELECT c FROM e)->>'categories')::int
     AND NOT EXISTS (SELECT 1 FROM expense_category WHERE pnl_cost_class IS NULL)
     AND (SELECT count(*) FROM jsonb_object_keys((SELECT cc FROM e)->'by_id')) = ((SELECT c FROM e)->>'categories')::int
     AND NOT EXISTS (SELECT 1 FROM cat x WHERE x.pnl_cost_class::text IS DISTINCT FROM (SELECT cc FROM e)->'by_id'->>(x.id::text))
     AND (SELECT cc FROM e)->>'policy' = 'OWNER_MAPPED',
         'categories=' || (SELECT count(*) FROM cat) || ' policy=' || coalesce((SELECT cc FROM e)->>'policy', 'NULL')
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
     AND (SELECT count(*) FROM population_events WHERE event_type = 'MORTALITY') = ((SELECT c FROM e)->>'mortality_events')::int
     AND (SELECT count(*) FROM population_events WHERE event_type = 'COUNT_ADJUSTMENT') = ((SELECT c FROM e)->>'adjustments')::int
     AND NOT EXISTS (SELECT 1 FROM population_events WHERE NOT is_current OR version_seq <> 0
                       OR NOT ((event_type = 'MORTALITY' AND reason LIKE 'legacy:producciones:% ' || (SELECT batch FROM e))
                            OR (event_type = 'COUNT_ADJUSTMENT' AND reason = 'phase31:physical-count ' || (SELECT batch FROM e)
                                AND event_date = ((SELECT cut FROM e)->>'cutover_date')::date)))
     AND NOT EXISTS (SELECT 1 FROM population_events WHERE event_type = 'MORTALITY' AND is_current GROUP BY flock_id, event_date HAVING count(*) > 1),
         'events=' || (SELECT count(*) FROM population_events)
  UNION ALL SELECT 'C12_operator_assignments',
         (SELECT count(*) FROM operator_assignments) = ((SELECT c FROM e)->>'assignments')::int
     AND NOT EXISTS (SELECT 1 FROM operator_assignments a JOIN perfiles p ON p.id = a.operator_id WHERE p.rol_type <> 'OPERATOR' OR NOT a.activo)
     AND NOT EXISTS (SELECT 1 FROM operator_assignments a JOIN flocks f ON f.id = a.flock_id WHERE f.estado <> 'ACTIVE'),
         'assignments=' || (SELECT count(*) FROM operator_assignments)
  UNION ALL SELECT 'C13_client_openings',
         (SELECT count(*) FROM client_ledger) = (SELECT count(*) FROM jsonb_object_keys((SELECT co FROM e)))
     AND NOT EXISTS (SELECT 1 FROM client_ledger l WHERE l.movement_type <> 'OPENING_BALANCE' OR l.source_entity_type <> 'phase31_opening'
                       OR l.effective_date <> ((SELECT cut FROM e)->>'cutover_date')::date
                       OR l.signed_amount IS DISTINCT FROM ((SELECT co FROM e)->>(l.cliente_id::text))::numeric),
         'client openings=' || (SELECT count(*) FROM client_ledger) || ' total=' || coalesce((SELECT sum(signed_amount) FROM client_ledger), 0)
  UNION ALL SELECT 'C14_treasury_openings',
         (SELECT count(*) FROM financial_operation) = (SELECT count(*) FROM jsonb_object_keys((SELECT tro FROM e)))
     AND (SELECT count(*) FROM financial_posting) = (SELECT count(*) FROM jsonb_object_keys((SELECT tro FROM e)))
     AND NOT EXISTS (SELECT 1 FROM financial_operation fo JOIN financial_posting fp ON fp.financial_operation_id = fo.id
                       JOIN financial_account a ON a.id = fp.financial_account_id
                      WHERE fo.operation_type <> 'ADJUSTMENT' OR fo.external_ref <> 'PHASE31-OPENING:' || (SELECT batch FROM e) || ':' || a.nombre
                         OR fo.effective_date <> ((SELECT cut FROM e)->>'cutover_date')::date
                         OR fp.signed_amount IS DISTINCT FROM ((SELECT tro FROM e)->>a.nombre)::numeric),
         (SELECT coalesce(string_agg(a.nombre || '=' || fp.signed_amount, ' ' ORDER BY a.nombre), 'none') FROM financial_posting fp JOIN financial_account a ON a.id = fp.financial_account_id)
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
       + (SELECT count(*) FROM mp_webhook_delivery) + (SELECT count(*) FROM mp_transition_identity) + (SELECT count(*) FROM mp_report_match)
       + (SELECT count(*) FROM mp_client_allocation) + (SELECT count(*) FROM mp_payer_client_map) + (SELECT count(*) FROM mp_attribution_flag)
       + (SELECT count(*) FROM sales_session_closing) = 0,
         'historical/operational fact rows = 0 (ADR-006 and ADR-016 tables included)'
  UNION ALL SELECT 'C17_seeded_accounts',
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
     AND (SELECT count(*) FROM audit_events WHERE action = 'MORTALITY') = ((SELECT c FROM e)->>'mortality_events')::int
     AND (SELECT count(*) FROM audit_events WHERE action = 'PHASE31_BOUNDARY') = 1,
         'MIGRATION_LOAD=' || (SELECT count(*) FROM audit_events WHERE action = 'MIGRATION_LOAD')
         || ' MORTALITY=' || (SELECT count(*) FROM audit_events WHERE action = 'MORTALITY')
  UNION ALL SELECT 'C20_periods_open',
         NOT EXISTS (SELECT 1 FROM population_events pe LEFT JOIN management_period m ON m.periodo_fecha = date_trunc('month', pe.event_date)::date
                      WHERE m.status IS DISTINCT FROM 'OPEN')
     AND EXISTS (SELECT 1 FROM management_period WHERE periodo_fecha = date_trunc('month', ((SELECT cut FROM e)->>'cutover_date')::date)::date AND status = 'OPEN'),
         'every event month and the cutover month are OPEN periods'
  UNION ALL SELECT 'C21_lineage_key_contract',
         (SELECT string_agg(a.attname, ',' ORDER BY k.ord) FROM pg_constraint pc
            CROSS JOIN LATERAL unnest(pc.conkey) WITH ORDINALITY k(attnum, ord)
            JOIN pg_attribute a ON a.attrelid = pc.conrelid AND a.attnum = k.attnum
           WHERE pc.conrelid = 'phase26_migration.lineage'::regclass AND pc.contype = 'p')
           = 'source_system,source_entity,source_id,import_batch',
         'PK (source_system, source_entity, source_id, import_batch)'
  UNION ALL SELECT 'C22_run_log_deterministic',
         (SELECT string_agg(command, ',' ORDER BY command) FROM phase26_migration.run_log) = 'load-masters,load-openings,load-population'
     AND NOT EXISTS (SELECT 1 FROM phase26_migration.run_log r
                      WHERE r.import_batch IS DISTINCT FROM (SELECT batch FROM e)
                         OR r.config_sha256 IS DISTINCT FROM (SELECT value->>'config_sha256' FROM phase26_migration.expected WHERE key = 'plan')
                         OR r.plan_sha256   IS DISTINCT FROM (SELECT value->>'plan_sha256'   FROM phase26_migration.expected WHERE key = 'plan')),
         'run_log=' || (SELECT count(*) FROM phase26_migration.run_log)
  UNION ALL SELECT 'C23_expectations_complete',
         (SELECT string_agg(key, ',' ORDER BY key) FROM phase26_migration.expected)
           = 'category_classes,client_openings,counts,cutover,import_batch,plan,population,product_types,treasury_openings',
         'expected=' || (SELECT string_agg(key, ',' ORDER BY key) FROM phase26_migration.expected)
  UNION ALL SELECT 'C24_mortality_audit_matches_event',
         (SELECT count(*) FROM audit_events a JOIN population_events pe ON pe.id::text = a.entity_id
           WHERE a.action = 'MORTALITY' AND a.entity_type = 'population_events'
             AND a.after_values = jsonb_build_object('flock_id', pe.flock_id, 'event_date', pe.event_date, 'deaths', -pe.delta)
             AND a.reason IS NOT DISTINCT FROM pe.reason AND a.performed_by IS NOT DISTINCT FROM pe.created_by)
           = (SELECT count(*) FROM audit_events WHERE action = 'MORTALITY'),
         'every MORTALITY audit resolves to its population event'
  UNION ALL SELECT 'C25_mp_cutover_boundary',
         (SELECT count(*) FROM mp_cutover_boundary) = 1
     AND (SELECT cutover_at FROM mp_cutover_boundary) = ((SELECT cut FROM e)->>'cutover_at')::timestamptz
     AND (SELECT import_batch FROM mp_cutover_boundary) = (SELECT batch FROM e),
         'boundary=' || coalesce((SELECT to_char(cutover_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') FROM mp_cutover_boundary), 'MISSING')
  UNION ALL SELECT 'C26_auth_users_are_profiles',
         (SELECT count(*) FROM auth.users u WHERE NOT EXISTS (SELECT 1 FROM perfiles p WHERE p.id = u.id))
           <= ((SELECT c FROM e)->>'allowed_extra_auth_users')::int,
         'auth.users without a profile=' || (SELECT count(*) FROM auth.users u WHERE NOT EXISTS (SELECT 1 FROM perfiles p WHERE p.id = u.id))
)
SELECT 'CHECK', id, CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END, detail FROM chk ORDER BY id;

SELECT 'DIGEST', t, md5(coalesce(string_agg(r, E'\n' ORDER BY r), '')), count(*) FROM (
  SELECT 'perfiles' AS t, concat_ws('|', id, md5(email), rol_type, activo) AS r FROM perfiles
  UNION ALL SELECT 'clients', concat_ws('|', CASE WHEN nombre = 'CONSUMIDOR FINAL' THEN 'seed' ELSE id::text END, nombre, activo) FROM clients
  UNION ALL SELECT 'products', concat_ws('|', id, nombre, product_type, unit_type, activo) FROM products WHERE NOT is_system
  UNION ALL SELECT 'expense_category', concat_ws('|', id, nombre, description, activo, pnl_cost_class) FROM expense_category WHERE nombre <> 'Gastos de Feria'
  UNION ALL SELECT 'sheds', concat_ws('|', id, nombre, capacidad, activo) FROM sheds
  UNION ALL SELECT 'flocks', concat_ws('|', id, shed_id, estado, genetics_line, birth_date, entry_date, initial_population, exit_date, created_by) FROM flocks
  UNION ALL SELECT 'operator_assignments', concat_ws('|', id, operator_id, flock_id, activo, assigned_by) FROM operator_assignments
  UNION ALL SELECT 'population_events', concat_ws('|', flock_id, event_type, delta, event_date, is_current, version_seq, reason, created_by) FROM population_events
  UNION ALL SELECT 'client_ledger', concat_ws('|', cliente_id, movement_type, signed_amount, effective_date, source_entity_type) FROM client_ledger
  UNION ALL SELECT 'treasury_openings', concat_ws('|', fo.external_ref, fo.operation_type, fo.effective_date, a.nombre, fp.signed_amount)
    FROM financial_operation fo JOIN financial_posting fp ON fp.financial_operation_id = fo.id JOIN financial_account a ON a.id = fp.financial_account_id
  UNION ALL SELECT 'mp_cutover_boundary', concat_ws('|', cutover_at, import_batch, evidence_ref) FROM mp_cutover_boundary
  UNION ALL SELECT 'lineage', concat_ws('|', source_system, source_entity, source_id, import_batch, target_entity, target_key) FROM phase26_migration.lineage
  UNION ALL SELECT 'expected', concat_ws('|', key, value) FROM phase26_migration.expected
) x GROUP BY t ORDER BY t;
