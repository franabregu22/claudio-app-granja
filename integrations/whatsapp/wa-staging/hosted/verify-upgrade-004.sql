-- ADR-025 — READ-ONLY verification after upgrade-004 (psql -v pre='<accounting snapshot before>'). Changes nothing.
-- Output: check|<group>|<name>|<value>|PASS|FAIL.
BEGIN READ ONLY;
WITH c AS (
  SELECT 'OBJETOS' g, 'D-1 / D-3 rule functions' n, ((to_regprocedure('wa.selectable_categories()') IS NOT NULL) AND (to_regprocedure('wa.category_check(uuid, boolean)') IS NOT NULL)
         AND (to_regprocedure('wa.selectable_accounts()') IS NOT NULL) AND (to_regprocedure('wa.account_check(uuid, text, boolean)') IS NOT NULL))::text v, 'true' w
  UNION ALL SELECT 'OBJETOS', 'unclassified: wa.dispatch_unclassified + sim double + sim pending table',
         ((to_regprocedure('wa.dispatch_unclassified(wa.draft, text, bigint)') IS NOT NULL) AND (to_regclass('sim.expense_pending_classification') IS NOT NULL)
          AND (to_regprocedure('sim.register_unclassified_expense(date, numeric, varchar, uuid, sim.payment_method, varchar, varchar, varchar, jsonb, text)') IS NOT NULL))::text, 'true'
  UNION ALL SELECT 'OBJETOS', 'wa_confirm knows the UNCLASSIFIED button', (pg_get_functiondef('public.wa_confirm(bigint,uuid,integer)'::regprocedure) LIKE '%UNCLASSIFIED:%')::text, 'true'
  UNION ALL SELECT 'VISTA', 'fin_mp_whatsapp_notes: security_barrier + exactly 4 columns + owner postgres',
         ((SELECT array_to_string(reloptions, ',') || '|' || pg_get_userbyid(relowner) FROM pg_class WHERE oid = 'public.fin_mp_whatsapp_notes'::regclass)
          || '|' || (SELECT string_agg(attname, ',' ORDER BY attnum) FROM pg_attribute WHERE attrelid = 'public.fin_mp_whatsapp_notes'::regclass AND attnum > 0 AND NOT attisdropped)),
         'security_barrier=true|postgres|source_id,draft_short_code,concept,confirmed_at'
  UNION ALL SELECT 'VISTA', 'fin_mp_whatsapp_notes privileges (authenticated SELECT only)',
         (has_table_privilege('authenticated', 'public.fin_mp_whatsapp_notes', 'SELECT') AND NOT has_table_privilege('anon', 'public.fin_mp_whatsapp_notes', 'SELECT')
          AND NOT has_table_privilege('service_role', 'public.fin_mp_whatsapp_notes', 'SELECT') AND NOT has_table_privilege('authenticated', 'public.fin_mp_whatsapp_notes', 'INSERT'))::text, 'true'
  UNION ALL SELECT 'API', 'public wa_* = 8, SECURITY DEFINER, authenticated only',
         (SELECT count(*)::text FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname LIKE 'wa\_%' AND p.prosecdef
            AND has_function_privilege('authenticated', p.oid, 'EXECUTE') AND NOT has_function_privilege('anon', p.oid, 'EXECUTE')
            AND NOT has_function_privilege('service_role', p.oid, 'EXECUTE')), '8'
  UNION ALL SELECT 'API', 'no wa.* / sim.* function executable by an API role',
         (SELECT count(*)::text FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname IN ('wa', 'sim')
            AND (has_function_privilege('authenticated', p.oid, 'EXECUTE') OR has_function_privilege('anon', p.oid, 'EXECUTE') OR has_function_privilege('service_role', p.oid, 'EXECUTE'))), '0'
  UNION ALL SELECT 'COMPAT_V2', 'catalog the published V2 reads: accounts Caja chica→CASH, BNA→TRANSFER, Mercado Pago→MERCADOPAGO',
         (SELECT string_agg(nombre || '>' || method, ',' ORDER BY nombre) FROM wa.selectable_accounts() WHERE nombre IN ('Caja chica', 'BNA', 'Mercado Pago')),
         'BNA>TRANSFER,Caja chica>CASH,Mercado Pago>MERCADOPAGO'
  UNION ALL SELECT 'COMPAT_V2', 'selectable subcategories (live catalog) not empty', ((SELECT count(*) FROM wa.selectable_categories()) > 0)::text, 'true'
  UNION ALL SELECT 'SIN_CAMBIOS', 'accounting snapshot unchanged by the upgrade',
         'purchases=' || (SELECT count(*) FROM sim.purchases) || '|sum=' || (SELECT coalesce(sum(amount_total), 0) FROM sim.purchases)
         || '|mp_pending=' || (SELECT count(*) FROM sim.mp_pending_outflow) || '|confirmations=' || (SELECT count(*) FROM wa.confirmation), :'pre'
  UNION ALL SELECT 'SIN_CAMBIOS', 'no pending expense registered by the upgrade', (SELECT count(*)::text FROM sim.expense_pending_classification), '0'
)
SELECT 'check|' || g || '|' || n || '|' || v || '|' || CASE WHEN v = w THEN 'PASS' ELSE 'FAIL' END FROM c;
ROLLBACK;
