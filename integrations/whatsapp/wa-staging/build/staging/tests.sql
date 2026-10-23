-- ============================================================================
-- ADR-025 — authorization / signature / draft / idempotency / MP suite. Runs INSIDE a transaction the runner rolls back.
-- PostgREST is simulated exactly as the repo tests do: SET LOCAL ROLE <api role> + request.jwt.claims.
-- psql variables: admin_a admin_b oper gw phone_a phone_b phone_oper. sim, public, pg_temp selects sim doubles or the real RPCs.
-- Output: one "PASS name" / "FAIL name :: got …" NOTICE per test and a final "SUMMARY|passed|failed".
-- ============================================================================
SET LOCAL search_path = sim, public, pg_temp;
SELECT set_config('wa.t_admin_a', :'admin_a', true), set_config('wa.t_admin_b', :'admin_b', true), set_config('wa.t_oper', :'oper', true),
       set_config('wa.t_gw', :'gw', true), set_config('wa.t_phone_a', :'phone_a', true), set_config('wa.t_phone_b', :'phone_b', true),
       set_config('wa.t_phone_oper', :'phone_oper', true), set_config('wa.t_secret', 'local-test-meta-secret-adr025', true) \g /dev/null
SELECT vault.create_secret('local-test-meta-secret-adr025', 'wa_meta_app_secret') WHERE NOT EXISTS (SELECT 1 FROM vault.secrets WHERE name = 'wa_meta_app_secret') \g /dev/null

CREATE TEMP TABLE t_result (n SERIAL, name TEXT, ok BOOLEAN, got TEXT);
CREATE TEMP TABLE t_state (k TEXT PRIMARY KEY, v TEXT);
CREATE TEMP SEQUENCE t_wamid;
CREATE FUNCTION pg_temp.v(k TEXT) RETURNS TEXT LANGUAGE sql AS $f$ SELECT current_setting('wa.t_' || k) $f$;
CREATE FUNCTION pg_temp.put(k TEXT, v TEXT) RETURNS TEXT LANGUAGE sql AS $f$
  INSERT INTO t_state VALUES (k, v) ON CONFLICT (k) DO UPDATE SET v = EXCLUDED.v RETURNING v $f$;
CREATE FUNCTION pg_temp.get(k TEXT) RETURNS TEXT LANGUAGE sql AS $f$ SELECT v FROM t_state WHERE t_state.k = get.k $f$;
CREATE FUNCTION pg_temp.expect(p_name TEXT, p_got TEXT, p_like TEXT) RETURNS VOID LANGUAGE plpgsql AS $f$
BEGIN
  INSERT INTO t_result (name, ok, got) VALUES (p_name, p_got IS NOT NULL AND p_got LIKE p_like, p_got);
  IF p_got IS NOT NULL AND p_got LIKE p_like THEN RAISE NOTICE 'PASS %', p_name;
  ELSE RAISE NOTICE 'FAIL % :: got [%] expected like [%]', p_name, left(p_got, 400), p_like; END IF;
END $f$;
-- one API call as <role>/<uid>; p_forged_sub also sets the legacy claim (a forging attempt)
CREATE FUNCTION pg_temp.as_(p_role TEXT, p_uid TEXT, p_sql TEXT, p_forged_sub TEXT DEFAULT NULL) RETURNS TEXT LANGUAGE plpgsql AS $f$
DECLARE v TEXT; ok BOOLEAN := false; msg TEXT;
BEGIN
  BEGIN
    EXECUTE format('SET LOCAL ROLE %I', p_role);
    PERFORM set_config('request.jwt.claims', CASE WHEN p_uid IS NULL THEN json_build_object('role', p_role)::text
                                                  ELSE json_build_object('sub', p_uid, 'role', p_role)::text END, true);
    PERFORM set_config('request.jwt.claim.sub', coalesce(p_forged_sub, ''), true);
    EXECUTE p_sql INTO v;
    ok := true;
    RESET ROLE;
  EXCEPTION WHEN others THEN GET STACKED DIAGNOSTICS msg = MESSAGE_TEXT; RESET ROLE;
  END;
  PERFORM set_config('request.jwt.claims', '', true); PERFORM set_config('request.jwt.claim.sub', '', true);
  RETURN CASE WHEN ok THEN 'OK:' || coalesce(v, 'null') ELSE 'ERR:' || msg END;
END $f$;
CREATE FUNCTION pg_temp.gw(p_sql TEXT) RETURNS TEXT LANGUAGE sql AS $f$ SELECT pg_temp.as_('authenticated', pg_temp.v('gw'), p_sql) $f$;
CREATE FUNCTION pg_temp.j(t TEXT) RETURNS JSONB LANGUAGE sql AS $f$ SELECT CASE WHEN t LIKE 'OK:{%' THEN substr(t, 4)::jsonb END $f$;
-- Meta envelope (one message) and its signature over the exact bytes
CREATE FUNCTION pg_temp.body(p_wamid TEXT, p_phone TEXT, p_ts BIGINT, p_text TEXT, p_button TEXT) RETURNS TEXT LANGUAGE sql AS $f$
  SELECT jsonb_build_object('object', 'whatsapp_business_account', 'entry', jsonb_build_array(jsonb_build_object('id', '0', 'changes', jsonb_build_array(
    jsonb_build_object('field', 'messages', 'value', jsonb_build_object('messaging_product', 'whatsapp', 'messages', jsonb_build_array(
      CASE WHEN p_button IS NULL
        THEN jsonb_build_object('from', ltrim(p_phone, '+'), 'id', p_wamid, 'timestamp', p_ts::text, 'type', 'text', 'text', jsonb_build_object('body', p_text))
        ELSE jsonb_build_object('from', ltrim(p_phone, '+'), 'id', p_wamid, 'timestamp', p_ts::text, 'type', 'interactive',
               'interactive', jsonb_build_object('type', 'button_reply', 'button_reply', jsonb_build_object('id', p_button, 'title', 'Sí'))) END)))))))::text $f$;
CREATE FUNCTION pg_temp.sig(p_raw TEXT) RETURNS TEXT LANGUAGE sql AS $f$
  SELECT 'sha256=' || encode(extensions.hmac(convert_to(p_raw, 'UTF8'), convert_to(pg_temp.v('secret'), 'UTF8'), 'sha256'), 'hex') $f$;
CREATE FUNCTION pg_temp.ingest(p_raw TEXT, p_sig TEXT) RETURNS TEXT LANGUAGE sql AS $f$
  SELECT pg_temp.gw(format('SELECT public.wa_ingest(%L, %L)::text', encode(convert_to(p_raw, 'UTF8'), 'base64'), p_sig)) $f$;
-- a fresh, correctly signed message → its inbound id (the full result stays in t_state 'last')
CREATE FUNCTION pg_temp.msg(p_phone TEXT, p_text TEXT, p_button TEXT DEFAULT NULL, p_age INTERVAL DEFAULT '0') RETURNS BIGINT LANGUAGE plpgsql AS $f$
DECLARE raw TEXT := pg_temp.body('wamid.T' || txid_current() || '.' || nextval('t_wamid'), p_phone, extract(epoch FROM now() - p_age)::bigint, p_text, p_button); r TEXT;
BEGIN
  r := pg_temp.ingest(raw, pg_temp.sig(raw)); PERFORM pg_temp.put('last', r); PERFORM pg_temp.put('last_raw', raw);
  RETURN (pg_temp.j(r) -> 'messages' -> 0 ->> 'inbound_id')::bigint;
END $f$;
CREATE FUNCTION pg_temp.btn(p_phone TEXT, p_draft TEXT, p_ver INT) RETURNS BIGINT LANGUAGE sql AS $f$
  SELECT pg_temp.msg(p_phone, NULL, 'CONFIRM:' || p_draft || ':' || p_ver) $f$;
CREATE FUNCTION pg_temp.propose(p_inb BIGINT, p_type TEXT, p_payload JSONB) RETURNS TEXT LANGUAGE sql AS $f$
  SELECT pg_temp.gw(format('SELECT public.wa_propose(%s, %L, %L::jsonb)::text', p_inb, p_type, p_payload)) $f$;
CREATE FUNCTION pg_temp.correct(p_inb BIGINT, p_draft TEXT, p_ver INT, p_payload JSONB) RETURNS TEXT LANGUAGE sql AS $f$
  SELECT pg_temp.gw(format('SELECT public.wa_correct(%s, %L::uuid, %s, %L::jsonb)::text', p_inb, p_draft, p_ver, p_payload)) $f$;
CREATE FUNCTION pg_temp.cancel(p_inb BIGINT, p_draft TEXT, p_ver INT) RETURNS TEXT LANGUAGE sql AS $f$
  SELECT pg_temp.gw(format('SELECT public.wa_cancel(%s, %L::uuid, %s)::text', p_inb, p_draft, p_ver)) $f$;
CREATE FUNCTION pg_temp.link(p_inb BIGINT, p_draft TEXT, p_ver INT, p_source TEXT) RETURNS TEXT LANGUAGE sql AS $f$
  SELECT pg_temp.gw(format('SELECT public.wa_link_mp(%s, %L::uuid, %s, %L)::text', p_inb, p_draft, p_ver, p_source)) $f$;
-- confirm, also reporting the identity seen by the caller AFTER the call (delegation must not leak)
CREATE FUNCTION pg_temp.confirm(p_inb BIGINT, p_draft TEXT, p_ver INT) RETURNS TEXT LANGUAGE sql AS $f$
  SELECT pg_temp.gw(format('SELECT public.wa_confirm(%s, %L::uuid, %s)::text || ''|uid='' || auth.uid()', p_inb, p_draft, p_ver)) $f$;
CREATE FUNCTION pg_temp.did(r TEXT) RETURNS TEXT LANGUAGE sql AS $f$ SELECT pg_temp.j(r) ->> 'draft_id' $f$;
CREATE FUNCTION pg_temp.cash(p_total NUMERIC, p_concept TEXT DEFAULT 'Prueba WhatsApp') RETURNS JSONB LANGUAGE sql AS $f$
  SELECT jsonb_build_object('date', '2026-10-20', 'total', p_total, 'category_id', 'aaaaaaaa-0025-0000-0000-0000000000c1', 'nature', 'OPERATING',
         'concept', p_concept, 'account_id', (SELECT id FROM financial_account WHERE nombre = 'Caja chica'), 'method', 'CASH') $f$;
CREATE FUNCTION pg_temp.mp(p_total NUMERIC) RETURNS JSONB LANGUAGE sql AS $f$
  SELECT pg_temp.cash(p_total, 'Pago MP') || jsonb_build_object('account_id', (SELECT id FROM financial_account WHERE nombre = 'Mercado Pago'), 'method', 'MERCADOPAGO') $f$;
CREATE FUNCTION pg_temp.vat(p_number TEXT) RETURNS JSONB LANGUAGE sql AS $f$
  SELECT jsonb_build_object('date', '2026-10-20', 'total', 1210, 'fiscal', jsonb_build_object('document_type', 'INVOICE_A', 'document_date', '2026-10-20',
         'fiscal_period', '2026-10-01', 'net_amount', 1000, 'total_amount', 1210, 'external_number', p_number, 'issuer_tax_id', '30712345679', 'issuer_name', 'Emisor WA',
         'components', jsonb_build_array(jsonb_build_object('tax_kind', 'IVA', 'direction', 'CREDITO', 'base_amount', 1000, 'rate_applied', 21, 'tax_amount', 210)))) $f$;
CREATE FUNCTION pg_temp.cnt(p_sql TEXT) RETURNS TEXT LANGUAGE plpgsql AS $f$ DECLARE v TEXT; BEGIN EXECUTE p_sql INTO v; RETURN v; END $f$;
-- volatile readers: a subquery in the SAME statement as an API call would not see what that call wrote
CREATE FUNCTION pg_temp.state(p_draft TEXT) RETURNS TEXT LANGUAGE plpgsql AS $f$ BEGIN RETURN (SELECT state FROM wa.draft WHERE id = p_draft::uuid); END $f$;
CREATE FUNCTION pg_temp.dpur() RETURNS TEXT LANGUAGE plpgsql AS $f$ BEGIN RETURN (SELECT (count(*) - (SELECT purchases FROM t_snap))::text FROM purchases); END $f$;
CREATE FUNCTION pg_temp.dfis() RETURNS TEXT LANGUAGE plpgsql AS $f$ BEGIN RETURN (SELECT (count(*) - (SELECT fiscal FROM t_snap))::text FROM fiscal_document); END $f$;
-- the pending-outflow view as an ADMIN identity (claims only: in staging the view lives in a schema the API cannot reach)
CREATE FUNCTION pg_temp.pending_as(p_uid TEXT, p_source TEXT) RETURNS TEXT LANGUAGE plpgsql AS $f$
DECLARE v TEXT;
BEGIN
  PERFORM set_config('request.jwt.claims', json_build_object('sub', p_uid, 'role', 'authenticated')::text, true);
  SELECT count(*)::text INTO v FROM fin_mp_pending_classification WHERE source_id = p_source;
  PERFORM set_config('request.jwt.claims', '', true);
  RETURN v;
END $f$;
CREATE FUNCTION pg_temp.actor(p_key TEXT) RETURNS TEXT LANGUAGE plpgsql AS $f$ BEGIN RETURN (SELECT created_by::text FROM purchases WHERE idempotency_key = p_key); END $f$;
CREATE TEMP TABLE t_snap AS SELECT (SELECT count(*) FROM purchases) AS purchases, (SELECT count(*) FROM fiscal_document) AS fiscal;

-- ── A. API surface and authorization ─────────────────────────────────────────
SELECT pg_temp.expect('A-1 anon calling wa_* is refused', pg_temp.as_('anon', NULL, 'SELECT public.wa_expire()::text'), 'ERR:permission denied%');
SELECT pg_temp.expect('A-2 an ADMIN calling wa_* directly is refused', pg_temp.as_('authenticated', pg_temp.v('admin_a'), 'SELECT public.wa_expire()::text'), 'ERR:FORBIDDEN%');
SELECT pg_temp.expect('A-3 an OPERATOR calling wa_* is refused', pg_temp.as_('authenticated', pg_temp.v('oper'), 'SELECT public.wa_expire()::text'), 'ERR:FORBIDDEN%');
SELECT pg_temp.expect('A-4 a forged legacy sub claim cannot pass the gateway gate',
  pg_temp.as_('authenticated', pg_temp.v('gw'), 'SELECT public.wa_expire()::text', pg_temp.v('admin_b')), 'ERR:FORBIDDEN%');
SELECT pg_temp.expect('A-5 the gateway cannot call the accounting RPC itself',
  pg_temp.gw(format('SELECT register_casual_purchase(p_economic_date := %L, p_amount_net := 1, p_amount_total := 1, p_expense_category_id := %L, p_concept := %L, p_nature := %L, p_paid_from_account_id := %L, p_payment_method := %L, p_idempotency_key := %L)::text',
    '2026-10-20', 'aaaaaaaa-0025-0000-0000-0000000000c1', 'x', 'OPERATING', (SELECT id FROM financial_account WHERE nombre = 'Caja chica'), 'CASH', 'GW-DIRECT')), 'ERR:%');
SELECT pg_temp.expect('A-6 the gateway cannot read the wa tables', pg_temp.gw('SELECT count(*)::text FROM wa.draft'), 'ERR:permission denied for schema wa');
SELECT pg_temp.expect('A-7 the gateway cannot read Vault', pg_temp.gw('SELECT count(*)::text FROM vault.decrypted_secrets'), 'ERR:permission denied%');
SELECT pg_temp.expect('A-8 privileges: wa.* helpers callable by no API role; public.wa_* = 8 SECURITY DEFINER, authenticated only; none for PUBLIC',
  (SELECT count(*) FILTER (WHERE n.nspname = 'wa' AND (has_function_privilege('authenticated', p.oid, 'EXECUTE') OR has_function_privilege('anon', p.oid, 'EXECUTE')
                                                      OR has_function_privilege('service_role', p.oid, 'EXECUTE')))
          || '|' || count(*) FILTER (WHERE n.nspname = 'public' AND p.prosecdef AND has_function_privilege('authenticated', p.oid, 'EXECUTE')
                                     AND NOT has_function_privilege('anon', p.oid, 'EXECUTE') AND NOT has_function_privilege('service_role', p.oid, 'EXECUTE'))
          || '|' || count(*) FILTER (WHERE EXISTS (SELECT 1 FROM aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a WHERE a.grantee = 0 AND a.privilege_type = 'EXECUTE'))
     FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'wa' OR (n.nspname = 'public' AND p.proname LIKE 'wa\_%')), '0|8|0');
SELECT pg_temp.expect('A-9 check Q: no callable SECURITY DEFINER function of public / wa is executable by PUBLIC',
  (SELECT count(*)::text FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname IN ('public', 'wa') AND p.prosecdef AND p.prorettype NOT IN ('trigger'::regtype, 'event_trigger'::regtype)
      AND EXISTS (SELECT 1 FROM aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a WHERE a.grantee = 0 AND a.privilege_type = 'EXECUTE')), '0');
UPDATE wa.config SET enabled = false;
SELECT pg_temp.expect('A-10 master switch off: the gateway itself is refused', pg_temp.gw('SELECT public.wa_expire()::text'), 'ERR:FORBIDDEN%');
UPDATE wa.config SET enabled = true;

-- ── I. ingest: signature over the exact bytes, deduplication, sender authorization ──
SELECT pg_temp.put('mA1', pg_temp.msg(pg_temp.v('phone_a'), 'gasté 1500 en insumos')::text);
SELECT pg_temp.expect('I-1 valid signature, mapped ADMIN → ACCEPTED', pg_temp.get('last'), 'OK:%"outcome": "ACCEPTED"%');
SELECT pg_temp.expect('I-2 wrong signature → WA_BAD_SIGNATURE', pg_temp.ingest(pg_temp.body('wamid.BAD1', pg_temp.v('phone_a'), extract(epoch FROM now())::bigint, 'x', NULL), 'sha256=' || repeat('0', 64)), 'OK:%WA_BAD_SIGNATURE%');
SELECT pg_temp.expect('I-3 re-serialized body with the original signature → WA_BAD_SIGNATURE',
  pg_temp.ingest(replace(pg_temp.get('last_raw'), ', ', ','), pg_temp.sig(pg_temp.get('last_raw'))), 'OK:%WA_BAD_SIGNATURE%');
SELECT pg_temp.expect('I-4 malformed signature header → WA_BAD_SIGNATURE', pg_temp.ingest(pg_temp.get('last_raw'), 'md5=abc'), 'OK:%WA_BAD_SIGNATURE%');
SELECT pg_temp.expect('I-5 replayed delivery → duplicate, still one row',
  pg_temp.ingest(pg_temp.get('last_raw'), pg_temp.sig(pg_temp.get('last_raw'))) || '|' || (SELECT count(*) FROM wa.inbound_message WHERE id = pg_temp.get('mA1')::bigint), 'OK:%"duplicate": true%|1');
SELECT pg_temp.put('mX', pg_temp.msg('+5491100000000', 'hola')::text);
SELECT pg_temp.expect('I-6 unknown phone → UNAUTHORIZED_SENDER', pg_temp.get('last'), 'OK:%"outcome": "UNAUTHORIZED_SENDER"%');
SELECT pg_temp.expect('I-7 a message of an unauthorized sender cannot create a draft', pg_temp.propose(pg_temp.get('mX')::bigint, 'CASUAL_EXPENSE', pg_temp.cash(10)), 'ERR:WA_MESSAGE_NOT_ACCEPTED%');
SELECT pg_temp.msg(pg_temp.v('phone_oper'), 'gasto');
SELECT pg_temp.expect('I-8 OPERATOR phone (mapped) → UNAUTHORIZED_SENDER', pg_temp.get('last'), 'OK:%"outcome": "UNAUTHORIZED_SENDER"%');
SELECT pg_temp.msg(pg_temp.v('phone_a'), 'viejo', NULL, '25 hours');
SELECT pg_temp.expect('I-9 message older than 24 h → STALE', pg_temp.get('last'), 'OK:%"outcome": "STALE"%');
UPDATE wa.sender SET activo = false WHERE phone_e164 = pg_temp.v('phone_b');
SELECT pg_temp.msg(pg_temp.v('phone_b'), 'gasto');
SELECT pg_temp.expect('I-10 inactive mapping → UNAUTHORIZED_SENDER', pg_temp.get('last'), 'OK:%"outcome": "UNAUTHORIZED_SENDER"%');
UPDATE wa.sender SET activo = true WHERE phone_e164 = pg_temp.v('phone_b');

-- ── D. drafts, ownership, versions, explicit confirmation, delegated identity, idempotency ──
SELECT pg_temp.put('rA', pg_temp.propose(pg_temp.get('mA1')::bigint, 'CASUAL_EXPENSE', pg_temp.cash(1500)));
SELECT pg_temp.put('dA', pg_temp.did(pg_temp.get('rA')));
SELECT pg_temp.expect('D-1 proposal → DRAFT v1 owned by the sender', pg_temp.get('rA') || '|' || (SELECT owner_perfil_id FROM wa.draft WHERE id = pg_temp.get('dA')::uuid),
  'OK:%"state": "DRAFT"%"version": 1%|' || pg_temp.v('admin_a'));
SELECT pg_temp.expect('D-2 the same message again → replay of the same draft', pg_temp.propose(pg_temp.get('mA1')::bigint, 'CASUAL_EXPENSE', pg_temp.cash(1500)),
  'OK:%"replay": true%"draft_id": "' || pg_temp.get('dA') || '"%');
SELECT pg_temp.expect('D-3 a second open draft of the same sender is refused', pg_temp.propose(pg_temp.msg(pg_temp.v('phone_a'), 'otro'), 'CASUAL_EXPENSE', pg_temp.cash(200)), 'ERR:WA_OPEN_DRAFT_EXISTS%');
SELECT pg_temp.expect('D-4 fiscal-reserved subcategory is refused', pg_temp.propose(pg_temp.msg(pg_temp.v('phone_b'), 'iva'), 'CASUAL_EXPENSE',
  pg_temp.cash(10) || jsonb_build_object('category_id', (SELECT id FROM expense_category WHERE fiscal_reserved ORDER BY id LIMIT 1))), 'ERR:WA_INVALID_PAYLOAD%');
SELECT pg_temp.expect('D-5 owner-withdrawal subcategory is refused', pg_temp.propose(pg_temp.msg(pg_temp.v('phone_b'), 'retiro'), 'CASUAL_EXPENSE',
  pg_temp.cash(10) || jsonb_build_object('category_id', (SELECT c.id FROM expense_category c JOIN expense_category_group g ON g.id = c.group_id
                                                         WHERE g.kind = 'OWNER_WITHDRAWAL' AND c.activo ORDER BY c.id LIMIT 1))), 'ERR:WA_INVALID_PAYLOAD%');
SELECT pg_temp.expect('D-6 a message already used cannot drive another action', pg_temp.confirm(pg_temp.get('mA1')::bigint, pg_temp.get('dA'), 1), 'ERR:WA_MESSAGE_ALREADY_USED%');
SELECT pg_temp.expect('D-7 admin B cannot correct A''s draft', pg_temp.correct(pg_temp.msg(pg_temp.v('phone_b'), 'corrijo'), pg_temp.get('dA'), 1, pg_temp.cash(1600)), 'ERR:WA_NOT_DRAFT_OWNER%');
SELECT pg_temp.expect('D-8 correction on a stale version is refused', pg_temp.correct(pg_temp.msg(pg_temp.v('phone_a'), 'corrijo'), pg_temp.get('dA'), 7, pg_temp.cash(1600)), 'ERR:WA_VERSION_CHANGED%');
SELECT pg_temp.expect('D-9 correction → v2', pg_temp.correct(pg_temp.msg(pg_temp.v('phone_a'), 'eran 1600'), pg_temp.get('dA'), 1, pg_temp.cash(1600)), 'OK:%"version": 2%');
SELECT pg_temp.expect('D-10 the v1 button cannot confirm v2', pg_temp.confirm(pg_temp.btn(pg_temp.v('phone_a'), pg_temp.get('dA'), 1), pg_temp.get('dA'), 2), 'ERR:WA_CONFIRMATION_NOT_EXPLICIT%');
SELECT pg_temp.expect('D-11 confirming an old version is refused', pg_temp.confirm(pg_temp.btn(pg_temp.v('phone_a'), pg_temp.get('dA'), 1), pg_temp.get('dA'), 1), 'ERR:WA_VERSION_CHANGED%');
SELECT pg_temp.expect('D-12 a typed "SI" is not a confirmation', pg_temp.confirm(pg_temp.msg(pg_temp.v('phone_a'), 'SI'), pg_temp.get('dA'), 2), 'ERR:WA_CONFIRMATION_NOT_EXPLICIT%');
SELECT pg_temp.expect('D-13 admin B pressing A''s button is refused', pg_temp.confirm(pg_temp.btn(pg_temp.v('phone_b'), pg_temp.get('dA'), 2), pg_temp.get('dA'), 2), 'ERR:WA_NOT_DRAFT_OWNER%');
SELECT pg_temp.expect('D-14 the gateway still sees no purchase before confirmation', pg_temp.dpur(), '0');
SELECT pg_temp.put('mAc', pg_temp.btn(pg_temp.v('phone_a'), pg_temp.get('dA'), 2)::text);
SELECT pg_temp.expect('D-15 explicit v2 button by the owner → CONFIRMED; caller identity restored afterwards',
  pg_temp.confirm(pg_temp.get('mAc')::bigint, pg_temp.get('dA'), 2), 'OK:%"state": "CONFIRMED"%|uid=' || pg_temp.v('gw'));
SELECT pg_temp.expect('D-16 actor of the purchase = the draft owner (never the gateway); idempotency key WA:<draft>:v2',
  pg_temp.actor('WA:' || pg_temp.get('dA') || ':v2'), pg_temp.v('admin_a'));
SELECT pg_temp.expect('D-17 accounting audit performed by the owner', (SELECT count(*)::text FROM audit_events WHERE performed_by = pg_temp.v('admin_a')::uuid
  AND reason LIKE 'WhatsApp W-% v2'), '1');
SELECT pg_temp.expect('D-18 wa.confirmation: owner, version, inbound, key, payload hash',
  (SELECT perfil_id || '|' || version || '|' || (inbound_id = pg_temp.get('mAc')::bigint) || '|' || idempotency_key || '|' || length(payload_sha256) FROM wa.confirmation WHERE draft_id = pg_temp.get('dA')::uuid),
  pg_temp.v('admin_a') || '|2|true|WA:' || pg_temp.get('dA') || ':v2|64');
SELECT pg_temp.expect('D-19 retry of the same confirmation message → replay', pg_temp.confirm(pg_temp.get('mAc')::bigint, pg_temp.get('dA'), 2), 'OK:%"replay": true%');
SELECT pg_temp.expect('D-20 a second "SÍ" (new message) → already confirmed, no new purchase',
  pg_temp.confirm(pg_temp.btn(pg_temp.v('phone_a'), pg_temp.get('dA'), 2), pg_temp.get('dA'), 2) || '|' || pg_temp.dpur(),
  'OK:%"already_confirmed": true%|1');
SELECT pg_temp.expect('D-21 gateway audit: CONFIRM by the gateway user for the owner',
  (SELECT count(*)::text FROM wa.audit_event WHERE action = 'CONFIRM' AND outcome = 'CONFIRMED' AND actor_perfil_id = pg_temp.v('admin_a')::uuid
     AND gateway_uid = pg_temp.v('gw')::uuid AND draft_id = pg_temp.get('dA')::uuid), '1');

-- ── C. cancellation, expiry, failure, owner revoked; financial delta 0 ──
SELECT pg_temp.put('dB', pg_temp.did(pg_temp.propose(pg_temp.msg(pg_temp.v('phone_b'), 'gasto 300'), 'CASUAL_EXPENSE', pg_temp.cash(300))));
SELECT pg_temp.expect('C-1 owner cancels', pg_temp.cancel(pg_temp.msg(pg_temp.v('phone_b'), 'cancelar'), pg_temp.get('dB'), 1), 'OK:%"state": "CANCELLED"%');
SELECT pg_temp.expect('C-2 a cancelled draft cannot be confirmed', pg_temp.confirm(pg_temp.btn(pg_temp.v('phone_b'), pg_temp.get('dB'), 1), pg_temp.get('dB'), 1), 'ERR:WA_DRAFT_NOT_CONFIRMABLE%');
SELECT pg_temp.put('dB2', pg_temp.did(pg_temp.propose(pg_temp.msg(pg_temp.v('phone_b'), 'gasto 400'), 'CASUAL_EXPENSE', pg_temp.cash(400))));
UPDATE wa.draft SET expires_at = now() - interval '1 second' WHERE id = pg_temp.get('dB2')::uuid;
SELECT pg_temp.expect('C-3 confirming after expiry → WA_DRAFT_EXPIRED, state EXPIRED',
  pg_temp.confirm(pg_temp.btn(pg_temp.v('phone_b'), pg_temp.get('dB2'), 1), pg_temp.get('dB2'), 1) || '|' || pg_temp.state(pg_temp.get('dB2')),
  'OK:%WA_DRAFT_EXPIRED%|EXPIRED');
SELECT pg_temp.put('dB3', pg_temp.did(pg_temp.propose(pg_temp.msg(pg_temp.v('phone_b'), 'gasto 450'), 'CASUAL_EXPENSE', pg_temp.cash(450))));
UPDATE wa.draft SET expires_at = now() - interval '1 second' WHERE id = pg_temp.get('dB3')::uuid;
SELECT pg_temp.expect('C-4 the expiry sweep expires due drafts', pg_temp.gw('SELECT public.wa_expire()::text') || '|' || pg_temp.state(pg_temp.get('dB3')),
  'OK:%"expired": 1%|EXPIRED');
SELECT pg_temp.put('dV1', pg_temp.did(pg_temp.propose(pg_temp.msg(pg_temp.v('phone_b'), 'factura'), 'VAT_ONLY_DOCUMENT', pg_temp.vat('0001-00000025'))));
SELECT pg_temp.expect('C-5 VAT-only document confirmed through register_fiscal_document',
  pg_temp.confirm(pg_temp.btn(pg_temp.v('phone_b'), pg_temp.get('dV1'), 1), pg_temp.get('dV1'), 1), 'OK:%"state": "CONFIRMED"%fiscal_document_id%');
SELECT pg_temp.put('dV2', pg_temp.did(pg_temp.propose(pg_temp.msg(pg_temp.v('phone_b'), 'misma factura'), 'VAT_ONLY_DOCUMENT', pg_temp.vat('0001-00000025'))));
SELECT pg_temp.expect('C-6 accounting refusal → FAILED with its error; caller identity restored; nothing recorded',
  pg_temp.confirm(pg_temp.btn(pg_temp.v('phone_b'), pg_temp.get('dV2'), 1), pg_temp.get('dV2'), 1) || '|' || pg_temp.state(pg_temp.get('dV2'))
    || '|' || pg_temp.dfis(),
  'OK:%"ok": false%DUPLICATE_FISCAL_DOCUMENT%|uid=' || pg_temp.v('gw') || '|FAILED|1');
SELECT pg_temp.expect('C-7 a FAILED draft is correctable → DRAFT v2, then confirmable',
  pg_temp.correct(pg_temp.msg(pg_temp.v('phone_b'), 'es la 26'), pg_temp.get('dV2'), 1, pg_temp.vat('0001-00000026')) || '|'
    || pg_temp.confirm(pg_temp.btn(pg_temp.v('phone_b'), pg_temp.get('dV2'), 2), pg_temp.get('dV2'), 2), 'OK:%"state": "DRAFT"%"version": 2%|OK:%"state": "CONFIRMED"%');
SELECT pg_temp.put('dA2', pg_temp.did(pg_temp.propose(pg_temp.msg(pg_temp.v('phone_a'), 'gasto 50'), 'CASUAL_EXPENSE', pg_temp.cash(50))));
SELECT pg_temp.put('mA2c', pg_temp.btn(pg_temp.v('phone_a'), pg_temp.get('dA2'), 1)::text);
UPDATE perfiles SET activo = false WHERE id = pg_temp.v('admin_a')::uuid;
SELECT pg_temp.expect('C-8 owner deactivated between the button and the confirmation → refused', pg_temp.confirm(pg_temp.get('mA2c')::bigint, pg_temp.get('dA2'), 1), 'ERR:WA_OWNER_NOT_AUTHORIZED%');
UPDATE perfiles SET activo = true WHERE id = pg_temp.v('admin_a')::uuid;
SELECT pg_temp.cancel(pg_temp.msg(pg_temp.v('phone_a'), 'cancelar'), pg_temp.get('dA2'), 1);
SELECT pg_temp.expect('C-9 financial delta of cancelled / expired / failed drafts = 0 (only D-15 bought; fiscal: C-5 + C-7)',
  pg_temp.dpur() || '|' || pg_temp.dfis(), '1|2');

-- ── M. Mercado Pago: WAITING_MP, cap, linking to the real outflow, classified once ──
SELECT pg_temp.put('rM1', pg_temp.propose(pg_temp.msg(pg_temp.v('phone_a'), 'pagué 1000 por MP'), 'CASUAL_EXPENSE', pg_temp.mp(1000)));
SELECT pg_temp.put('dM1', pg_temp.did(pg_temp.get('rM1')));
SELECT pg_temp.expect('M-1 MP-paid expense without SOURCE_ID → WAITING_MP (72 h)', pg_temp.get('rM1') || '|' ||
  (SELECT round(extract(epoch FROM expires_at - created_at) / 3600)::text FROM wa.draft WHERE id = pg_temp.get('dM1')::uuid), 'OK:%"state": "WAITING_MP"%|72');
SELECT pg_temp.put('dA3', pg_temp.did(pg_temp.propose(pg_temp.msg(pg_temp.v('phone_a'), 'gasto 60'), 'CASUAL_EXPENSE', pg_temp.cash(60))));
SELECT pg_temp.expect('M-2 WAITING_MP does not block a new DRAFT', pg_temp.state(pg_temp.get('dA3')), 'DRAFT');
SELECT pg_temp.expect('M-3 a WAITING_MP draft cannot be confirmed', pg_temp.confirm(pg_temp.btn(pg_temp.v('phone_a'), pg_temp.get('dM1'), 1), pg_temp.get('dM1'), 1), 'ERR:WA_WAITING_MP%');
SELECT pg_temp.expect('M-4 linking while another draft is open is refused', pg_temp.link(pg_temp.msg(pg_temp.v('phone_a'), 'es el 25001'), pg_temp.get('dM1'), 1, '930000025001'), 'ERR:WA_OPEN_DRAFT_EXISTS%');
SELECT pg_temp.cancel(pg_temp.msg(pg_temp.v('phone_a'), 'cancelar'), pg_temp.get('dA3'), 1);
SELECT pg_temp.put('dM' || i, pg_temp.did(pg_temp.propose(pg_temp.msg(pg_temp.v('phone_a'), 'mp ' || i), 'CASUAL_EXPENSE', pg_temp.mp(1000)))) FROM generate_series(2, 5) i;
SELECT pg_temp.expect('M-5 a 6th WAITING_MP draft is refused (cap 5)', pg_temp.propose(pg_temp.msg(pg_temp.v('phone_a'), 'mp 6'), 'CASUAL_EXPENSE', pg_temp.mp(1000)), 'ERR:WA_WAITING_MP_LIMIT%');
SELECT pg_temp.expect('M-6 linking to an outflow of another amount is refused', pg_temp.link(pg_temp.msg(pg_temp.v('phone_a'), 'es el 25002'), pg_temp.get('dM1'), 1, '930000025002'), 'ERR:WA_MP_OUTFLOW_NOT_MATCHING%');
SELECT pg_temp.expect('M-7 admin B cannot link A''s draft', pg_temp.link(pg_temp.msg(pg_temp.v('phone_b'), 'es el 25001'), pg_temp.get('dM1'), 1, '930000025001'), 'ERR:WA_NOT_DRAFT_OWNER%');
SELECT pg_temp.expect('M-8 linking to the matching pending outflow → DRAFT v2 with the SOURCE_ID',
  pg_temp.link(pg_temp.msg(pg_temp.v('phone_a'), 'es el 25001'), pg_temp.get('dM1'), 1, '930000025001'), 'OK:%"state": "DRAFT"%"mp_source_id": "930000025001"%"version": 2%');
SELECT pg_temp.expect('M-9 the same outflow cannot be linked to a second draft', pg_temp.link(pg_temp.msg(pg_temp.v('phone_a'), 'es el 25001'), pg_temp.get('dM2'), 1, '930000025001'), 'ERR:WA_MP_OUTFLOW_TAKEN%');
SELECT pg_temp.expect('M-10 confirmation → the real casual purchase anchored to the SOURCE_ID, by the owner',
  pg_temp.confirm(pg_temp.btn(pg_temp.v('phone_a'), pg_temp.get('dM1'), 2), pg_temp.get('dM1'), 2) || '|' ||
  pg_temp.actor('WA:' || pg_temp.get('dM1') || ':v2'), 'OK:%"state": "CONFIRMED"%|' || pg_temp.v('admin_a'));
SELECT pg_temp.expect('M-11 the outflow is no longer pending (as the owner)',
  pg_temp.pending_as(pg_temp.v('admin_a'), '930000025001'), '0');
SELECT pg_temp.expect('M-12 exactly one provisional release for the outflow (real ERP only; doubles: classified once)',
  pg_temp.cnt(CASE WHEN to_regclass('public.mp_pending_outflow_resolution') IS NOT NULL AND to_regnamespace('sim') IS NULL
    THEN 'SELECT count(*)::text FROM public.mp_pending_outflow_resolution r JOIN public.mp_pending_outflow p ON p.id = r.pending_id WHERE p.source_id = ''930000025001'''
    ELSE 'SELECT count(*)::text FROM purchases WHERE idempotency_key LIKE ''WA:%'' AND paid_operation_id IS NOT NULL AND expense_category_id = ''aaaaaaaa-0025-0000-0000-0000000000c1'' AND amount_total = 1000' END), '1');
SELECT pg_temp.expect('M-13 a classified outflow cannot be linked again', pg_temp.link(pg_temp.msg(pg_temp.v('phone_a'), 'es el 25001'), pg_temp.get('dM2'), 1, '930000025001'), 'ERR:WA_MP_OUTFLOW_%');

-- ── S. supplier purchases (credit and with invoice) ──
SELECT pg_temp.put('dS1', pg_temp.did(pg_temp.propose(pg_temp.msg(pg_temp.v('phone_b'), 'compra proveedor'), 'SUPPLIER_CREDIT_PURCHASE',
  jsonb_build_object('date', '2026-10-20', 'total', 5000, 'category_id', 'aaaaaaaa-0025-0000-0000-0000000000c1', 'nature', 'OPERATING',
                     'supplier_id', 'aaaaaaaa-0025-0000-0000-0000000000a1', 'invoice_number', 'R-0001-00000077'))));
SELECT pg_temp.expect('S-1 supplier credit purchase through register_purchase, by the owner',
  pg_temp.confirm(pg_temp.btn(pg_temp.v('phone_b'), pg_temp.get('dS1'), 1), pg_temp.get('dS1'), 1) || '|' ||
  pg_temp.actor('WA:' || pg_temp.get('dS1') || ':v1'), 'OK:%"state": "CONFIRMED"%|' || pg_temp.v('admin_b'));
SELECT pg_temp.put('dS2', pg_temp.did(pg_temp.propose(pg_temp.msg(pg_temp.v('phone_b'), 'factura proveedor'), 'SUPPLIER_PURCHASE_WITH_INVOICE',
  jsonb_build_object('date', '2026-10-20', 'total', 1210, 'net', 1000, 'category_id', 'aaaaaaaa-0025-0000-0000-0000000000c1', 'nature', 'OPERATING',
                     'supplier_id', 'aaaaaaaa-0025-0000-0000-0000000000a1', 'invoice_number', 'A-0001-00000078',
                     'fiscal', jsonb_build_object('document_type', 'INVOICE_A', 'fiscal_period', '2026-10-01', 'net_amount', 1000, 'total_amount', 1210,
                       'components', jsonb_build_array(jsonb_build_object('tax_kind', 'IVA', 'direction', 'CREDITO', 'base_amount', 1000, 'rate_applied', 21, 'tax_amount', 210)))))));
SELECT pg_temp.expect('S-2 supplier purchase with invoice through register_purchase_with_fiscal_document',
  pg_temp.confirm(pg_temp.btn(pg_temp.v('phone_b'), pg_temp.get('dS2'), 1), pg_temp.get('dS2'), 1), 'OK:%"state": "CONFIRMED"%fiscal_document_id%');
SELECT pg_temp.expect('S-3 totals: purchases +4 (D-15, M-10, S-1, S-2), fiscal documents +3 (C-5, C-7, S-2)',
  pg_temp.dpur() || '|' || pg_temp.dfis(), '4|3');
SELECT pg_temp.expect('S-4 every purchase made through WhatsApp has an owner ADMIN as actor (never the gateway)',
  (SELECT count(*) FILTER (WHERE created_by IN (pg_temp.v('admin_a')::uuid, pg_temp.v('admin_b')::uuid)) || '|' || count(*) FILTER (WHERE created_by = pg_temp.v('gw')::uuid)
     FROM purchases WHERE idempotency_key LIKE 'WA:%'), '4|0');
SELECT pg_temp.expect('S-5 claims after the suite are empty for the session', coalesce(nullif(current_setting('request.jwt.claims', true), ''), '-') || '|' || coalesce(auth.uid()::text, '-'), '-|-');

-- ── X. wa_context: read-only source of truth for the interpreter (owner's drafts, current version, catalog) ──
CREATE FUNCTION pg_temp.ctx(p_inb BIGINT) RETURNS TEXT LANGUAGE sql AS $f$ SELECT pg_temp.gw(format('SELECT public.wa_context(%s)::text', p_inb)) $f$;
SELECT pg_temp.put('mXa', pg_temp.msg(pg_temp.v('phone_a'), 'que tengo abierto')::text);
SELECT pg_temp.expect('X-1 anon / ADMIN / OPERATOR cannot read the context',
  pg_temp.as_('anon', NULL, format('SELECT public.wa_context(%s)::text', pg_temp.get('mXa'))) || '|'
  || pg_temp.as_('authenticated', pg_temp.v('admin_a'), format('SELECT public.wa_context(%s)::text', pg_temp.get('mXa'))) || '|'
  || pg_temp.as_('authenticated', pg_temp.v('oper'), format('SELECT public.wa_context(%s)::text', pg_temp.get('mXa'))), 'ERR:permission denied%|ERR:FORBIDDEN%|ERR:FORBIDDEN%');
SELECT pg_temp.put('dX', pg_temp.did(pg_temp.propose(pg_temp.msg(pg_temp.v('phone_b'), 'gasto 77'), 'CASUAL_EXPENSE', pg_temp.cash(77, 'Concepto original'))));
SELECT pg_temp.correct(pg_temp.msg(pg_temp.v('phone_b'), 'eran 88'), pg_temp.get('dX'), 1, pg_temp.cash(88, 'Concepto original'));
SELECT pg_temp.put('mXb', pg_temp.msg(pg_temp.v('phone_b'), 'corregi a 99')::text);
SELECT pg_temp.put('cXb', pg_temp.ctx(pg_temp.get('mXb')::bigint));
SELECT pg_temp.expect('X-2 B''s context = B''s open draft at its CURRENT version and payload (from the database)',
  (SELECT (j -> 'open' ->> 'draft_id') || '|v' || (j -> 'open' ->> 'version') || '|' || (j -> 'open' -> 'payload' ->> 'total') || '|' || (j -> 'open' -> 'payload' ->> 'concept')
     FROM (SELECT pg_temp.j(pg_temp.get('cXb')) j) x), pg_temp.get('dX') || '|v2|88|Concepto original');
SELECT pg_temp.expect('X-3 A''s context never shows B''s draft (ownership); A''s waiting MP drafts are listed',
  (SELECT coalesce(j -> 'open' ->> 'draft_id', 'none') || '|' || (j -> 'waiting' @> jsonb_build_array(jsonb_build_object('draft_id', pg_temp.get('dM3'))))
     FROM (SELECT pg_temp.j(pg_temp.ctx(pg_temp.get('mXa')::bigint)) j) x), 'none|true');
SELECT pg_temp.expect('X-4 reading the context does not consume the message: it can still drive one correction',
  pg_temp.correct(pg_temp.get('mXb')::bigint, pg_temp.get('dX'), 2, pg_temp.cash(99, 'Concepto original')), 'OK:%"version": 3%');
SELECT pg_temp.expect('X-5 a message of an unauthorized sender gets no context', pg_temp.ctx(pg_temp.get('mX')::bigint), 'ERR:WA_MESSAGE_NOT_ACCEPTED%');
SELECT pg_temp.expect('X-6 catalog: selectable categories only (no fiscal-reserved, no owner withdrawal); active accounts',
  (SELECT (j -> 'catalog' -> 'categories' @> '[{"id": "aaaaaaaa-0025-0000-0000-0000000000c1"}]')::text || '|'
          || (SELECT count(*) FROM jsonb_array_elements(j -> 'catalog' -> 'categories') c JOIN expense_category e ON e.id = (c ->> 'id')::uuid
               JOIN expense_category_group g ON g.id = e.group_id WHERE e.fiscal_reserved OR g.kind::text <> 'EXPENSE' OR NOT e.activo) || '|'
          || (jsonb_array_length(j -> 'catalog' -> 'accounts') > 0)
     FROM (SELECT pg_temp.j(pg_temp.get('cXb')) j) x), 'true|0|true');
UPDATE wa.draft SET expires_at = now() - interval '1 second' WHERE id = pg_temp.get('dX')::uuid;
SELECT pg_temp.expect('X-7 an expired draft is not offered for correction', (SELECT coalesce(pg_temp.j(pg_temp.ctx(pg_temp.msg(pg_temp.v('phone_b'), 'y ahora'))) -> 'open' ->> 'draft_id', 'none')), 'none');
UPDATE wa.inbound_message SET received_at = now() - interval '2 hours' WHERE id = pg_temp.get('mXa')::bigint;
SELECT pg_temp.expect('X-8 a message older than 1 hour gets no context', pg_temp.ctx(pg_temp.get('mXa')::bigint), 'ERR:WA_MESSAGE_TOO_OLD%');

-- ── D. duplicate references (same criterion as the hint; details only for an active mapped ADMIN viewer) ──
INSERT INTO expense_category (id, nombre, group_id, pnl_cost_class)
SELECT 'aaaaaaaa-0025-0000-0000-0000000000d9', 'Dup otra categoría', group_id, 'INDIRECT' FROM expense_category WHERE id = 'aaaaaaaa-0025-0000-0000-0000000000c1';
SELECT pg_temp.gw('SELECT public.wa_expire()::text') \g /dev/null
SELECT pg_temp.expect('D-0 B has no open draft before the duplicate scenario', (SELECT count(*)::text FROM wa.draft WHERE owner_perfil_id = pg_temp.v('admin_b')::uuid AND state IN ('DRAFT', 'CONFIRMING')), '0');
SELECT pg_temp.put('dD0', pg_temp.did(pg_temp.propose(pg_temp.msg(pg_temp.v('phone_b'), 'base dup'), 'CASUAL_EXPENSE', pg_temp.cash(4321, 'Dup base concepto'))));
SELECT pg_temp.put('cD0', pg_temp.confirm(pg_temp.btn(pg_temp.v('phone_b'), pg_temp.get('dD0'), 1), pg_temp.get('dD0'), 1));
SELECT pg_temp.put('rD1', pg_temp.propose(pg_temp.msg(pg_temp.v('phone_b'), 'otra vez'), 'CASUAL_EXPENSE', pg_temp.cash(4321, 'Otro gasto')));
SELECT pg_temp.put('dD1', pg_temp.did(pg_temp.get('rD1')));
SELECT pg_temp.expect('D-1 same total / date / category as a recorded WhatsApp purchase → hint 1 and its reference (code, category, concept, date, total)',
  (SELECT (j ->> 'possible_duplicates') || '|' || jsonb_array_length(j -> 'duplicates') || '|' || (j -> 'duplicates' -> 0 ->> 'ref' = (SELECT short_code FROM wa.draft WHERE id = pg_temp.get('dD0')::uuid))
          || '|' || (j -> 'duplicates' -> 0 ->> 'same_category') || '|' || (j -> 'duplicates' -> 0 ->> 'concept') || '|' || (j -> 'duplicates' -> 0 ->> 'date') || '|' || (j -> 'duplicates' -> 0 ->> 'total')
          || '|' || ((j -> 'duplicates' -> 0 ->> 'category') IS NOT NULL)
     FROM (SELECT pg_temp.j(pg_temp.get('rD1')) j) x), '1|1|true|true|Dup base concepto|2026-10-20|4321.00|true');
SELECT pg_temp.expect('D-2 the reference reveals no ids, actors, accounts or phones',
  (SELECT ((pg_temp.j(pg_temp.get('rD1')) -> 'duplicates')::text !~ '[0-9a-f]{8}-[0-9a-f]{4}-|\+?549|created_by|account')::text), 'true');
SELECT pg_temp.expect('D-3 correction to another amount → no hint, no references (criterion unchanged)',
  (SELECT (j ->> 'possible_duplicates') || '|' || (j -> 'duplicates')::text FROM (SELECT pg_temp.j(pg_temp.correct(pg_temp.msg(pg_temp.v('phone_b'), 'eran 4322'), pg_temp.get('dD1'), 1, pg_temp.cash(4322, 'Otro gasto'))) j) x), '0|[]');
SELECT pg_temp.expect('D-4 back to the same total in ANOTHER category → still reported (not filtered), same_category = false',
  (SELECT (j ->> 'possible_duplicates') || '|' || (j -> 'duplicates' -> 0 ->> 'same_category') || '|' || (j -> 'duplicates' -> 0 ->> 'ref' IS NOT NULL)
     FROM (SELECT pg_temp.j(pg_temp.correct(pg_temp.msg(pg_temp.v('phone_b'), 'eran 4321 y era otra cosa'), pg_temp.get('dD1'), 2,
            pg_temp.cash(4321, 'Otro gasto') || '{"category_id": "aaaaaaaa-0025-0000-0000-0000000000d9"}')) j) x), '1|false|true');
SELECT pg_temp.expect('D-5 3 days away → outside the ±2-day window: no hint, no references',
  (SELECT (j ->> 'possible_duplicates') || '|' || (j -> 'duplicates')::text FROM (SELECT pg_temp.j(pg_temp.correct(pg_temp.msg(pg_temp.v('phone_b'), 'fue el 23'), pg_temp.get('dD1'), 3,
            pg_temp.cash(4321, 'Otro gasto') || '{"date": "2026-10-23"}')) j) x), '0|[]');
SELECT pg_temp.expect('D-6 references and hint use the same criterion (count of references = min(hint, 3)) for the D-1 payload',
  (SELECT (jsonb_array_length(wa.duplicate_refs(pg_temp.cash(4321, 'x'), pg_temp.v('admin_b')::uuid)) = least(wa.duplicate_hint(pg_temp.cash(4321, 'x')), 3))::text), 'true');
SELECT pg_temp.expect('D-7 a viewer that is not an active mapped ADMIN gets only date / total / same_category (no code, category or concept)',
  (SELECT string_agg(k, ',' ORDER BY k) FROM jsonb_array_elements(wa.duplicate_refs(pg_temp.cash(4321, 'x'), pg_temp.v('oper')::uuid)) e, jsonb_object_keys(e) k), 'date,same_category,total');
SELECT pg_temp.expect('D-8 the API roles cannot call wa.duplicate_refs directly',
  pg_temp.as_('authenticated', pg_temp.v('admin_b'), format('SELECT wa.duplicate_refs(%L::jsonb, %L::uuid)::text', pg_temp.cash(4321, 'x'), pg_temp.v('admin_b'))), 'ERR:permission denied%');

SELECT 'SUMMARY|' || count(*) FILTER (WHERE ok) || '|' || count(*) FILTER (WHERE NOT ok) FROM t_result;
