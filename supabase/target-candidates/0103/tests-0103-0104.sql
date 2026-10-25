-- ADR-025 stage 4 — receipts (0103) + invoice payments with own instruments (0104). Runs AFTER the candidate suite (its fixtures and
-- pg_temp helpers), inside the same rolled-back transaction. Focus: one payment / one IVA / one movement, server-set files.
CREATE TEMP TABLE t_base AS SELECT coalesce(max(n), 0) AS n FROM t_result;
-- setup: the previous suite leaves open drafts (one open draft per sender); close them so each test starts clean (rolled back anyway)
UPDATE wa.draft SET state = 'CANCELLED', updated_at = now() WHERE state IN ('DRAFT', 'WAITING_MP', 'FAILED');
-- a photo / PDF message (image or document) with an optional caption
CREATE FUNCTION pg_temp.mmsg(p_phone TEXT, p_kind TEXT, p_caption TEXT, p_mime TEXT) RETURNS BIGINT LANGUAGE plpgsql AS $f$
DECLARE w TEXT := 'wamid.M' || txid_current() || '.' || nextval('t_wamid'); raw TEXT; r TEXT;
BEGIN
  raw := jsonb_build_object('object', 'whatsapp_business_account', 'entry', jsonb_build_array(jsonb_build_object('id', '0', 'changes', jsonb_build_array(
    jsonb_build_object('field', 'messages', 'value', jsonb_build_object('messaging_product', 'whatsapp', 'messages', jsonb_build_array(
      jsonb_build_object('from', ltrim(p_phone, '+'), 'id', w, 'timestamp', extract(epoch FROM now())::bigint::text, 'type', p_kind,
        p_kind, jsonb_strip_nulls(jsonb_build_object('id', 'media-' || w, 'mime_type', p_mime, 'caption', p_caption,
                                                      'filename', CASE WHEN p_kind = 'document' THEN 'factura.pdf' END))))))))))::text;
  r := pg_temp.ingest(raw, pg_temp.sig(raw)); PERFORM pg_temp.put('mlast', r);
  RETURN (pg_temp.j(r) -> 'messages' -> 0 ->> 'inbound_id')::bigint;
END $f$;
CREATE FUNCTION pg_temp.store(p_inb BIGINT, p_sha TEXT, p_mime TEXT DEFAULT 'image/jpeg') RETURNS TEXT LANGUAGE sql AS $f$
  SELECT pg_temp.gw(format('SELECT public.wa_store_media(%s, %L, %L, 123456)::text', p_inb, p_sha, p_mime)) $f$;
CREATE FUNCTION pg_temp.sha(p TEXT) RETURNS TEXT LANGUAGE sql AS $f$ SELECT encode(extensions.digest(convert_to(p, 'UTF8'), 'sha256'), 'hex') $f$;
CREATE FUNCTION pg_temp.ops() RETURNS BIGINT LANGUAGE plpgsql AS $f$ BEGIN RETURN (SELECT count(*) FROM financial_operation); END $f$;
-- volatile readers (a subquery in the SAME statement as an API call would not see what that call wrote)
CREATE FUNCTION pg_temp.npur() RETURNS BIGINT LANGUAGE plpgsql AS $f$ BEGIN RETURN (SELECT count(*) FROM purchases); END $f$;
CREATE FUNCTION pg_temp.nfis() RETURNS BIGINT LANGUAGE plpgsql AS $f$ BEGIN RETURN (SELECT count(*) FROM fiscal_document); END $f$;
CREATE FUNCTION pg_temp.links(p_doc TEXT) RETURNS TEXT LANGUAGE plpgsql AS $f$ BEGIN
  RETURN (SELECT coalesce(string_agg(target_kind, ',' ORDER BY target_kind), '-') FROM document_link WHERE document_file_id = p_doc::uuid); END $f$;
CREATE FUNCTION pg_temp.adm(p_sql TEXT) RETURNS TEXT LANGUAGE sql AS $f$ SELECT pg_temp.as_('authenticated', pg_temp.v('admin_a'), p_sql) $f$;
CREATE FUNCTION pg_temp.ubutton(p_phone TEXT, p_draft TEXT, p_ver INT) RETURNS BIGINT LANGUAGE sql AS $f$
  SELECT pg_temp.msg(p_phone, NULL, 'UNCLASSIFIED:' || p_draft || ':' || p_ver) $f$;

-- R-1 a photo with a caption: caption, MIME and the media id are kept; the gateway stores the original once
SELECT pg_temp.put('i1', pg_temp.mmsg(pg_temp.v('phone_a'), 'image', 'Gasté esto en gasoil', 'image/jpeg')::text);
SELECT pg_temp.expect('R-1 photo + caption ingested: caption / MIME returned to the gateway',
  (pg_temp.j(pg_temp.get('mlast')) -> 'messages' -> 0 ->> 'caption') || '|' || (pg_temp.j(pg_temp.get('mlast')) -> 'messages' -> 0 ->> 'media_mime'),
  'Gasté esto en gasoil|image/jpeg');
SELECT pg_temp.put('s1', pg_temp.store(pg_temp.get('i1')::bigint, pg_temp.sha('ticket-gasoil')));
SELECT pg_temp.put('doc1', pg_temp.j(pg_temp.get('s1')) ->> 'document_file_id');
SELECT pg_temp.expect('R-2 stored as wa/<sha256>.jpg, origin WHATSAPP, received by the sender; the same bytes again = the SAME document',
  (pg_temp.j(pg_temp.get('s1')) ->> 'storage_path') || '|' || pg_temp.cnt(format('SELECT origin || ''='' || (received_by = %L::uuid) FROM document_file WHERE id = %L::uuid', pg_temp.v('admin_a'), pg_temp.get('doc1')))
  || '|' || (pg_temp.j(pg_temp.store(pg_temp.mmsg(pg_temp.v('phone_a'), 'image', NULL, 'image/jpeg'), pg_temp.sha('ticket-gasoil'))) ->> 'document_file_id' = pg_temp.get('doc1')),
  'wa/' || pg_temp.sha('ticket-gasoil') || '.jpg|WHATSAPP=true|true');
SELECT pg_temp.expect('R-3 a text message can not register media', pg_temp.store(pg_temp.msg(pg_temp.v('phone_a'), 'hola'), pg_temp.sha('x')), 'ERR:WA_MEDIA_NOT_ACCEPTED%');
SELECT pg_temp.expect('R-3b a non-gateway caller (ADMIN) can not register media', pg_temp.adm(format('SELECT public.wa_store_media(%s, %L, ''image/jpeg'', 10)::text', pg_temp.get('i1'), pg_temp.sha('y'))), 'ERR:FORBIDDEN%');

-- R-4 / R-5 a cash expense with the receipt: ONE purchase, ONE payment, the file attached once; client "attachments" ignored
CREATE TEMP TABLE t_r AS SELECT pg_temp.ops() AS ops, (SELECT count(*) FROM purchases) AS pur, (SELECT count(*) FROM fiscal_document) AS fis;
SELECT pg_temp.put('r5', pg_temp.propose(pg_temp.get('i1')::bigint, 'CASUAL_EXPENSE', pg_temp.cash(4321, 'Gasoil') || jsonb_build_object(
  'document_file_id', pg_temp.get('doc1'), 'receipt', jsonb_build_object('document_type', 'TICKET', 'total', 4321, 'issuer_name', 'YPF'),
  'attachments', jsonb_build_array(jsonb_build_object('storage_path', 'evil/other.pdf', 'file_name', 'x', 'content_type', 'application/pdf', 'byte_size', 1)))));
SELECT pg_temp.expect('R-4 the proposal keeps the file reference and drops client attachments',
  (pg_temp.j(pg_temp.get('r5')) -> 'payload' ? 'document_file_id')::text || '|' || (pg_temp.j(pg_temp.get('r5')) -> 'payload' ? 'attachments')::text, 'true|false');
SELECT pg_temp.put('d5', pg_temp.did(pg_temp.get('r5')));
SELECT pg_temp.expect('R-5 confirmed: +1 purchase, +1 operation, 0 fiscal; the purchase has exactly the receipt; links PURCHASE; AI reading stored once',
  left(pg_temp.confirm(pg_temp.btn(pg_temp.v('phone_a'), pg_temp.get('d5'), 1), pg_temp.get('d5'), 1), 10)
  || '|' || (pg_temp.npur() - (SELECT pur FROM t_r)) || '|' || (pg_temp.ops() - (SELECT ops FROM t_r)) || '|' || (pg_temp.nfis() - (SELECT fis FROM t_r))
  || '|' || pg_temp.cnt(format('SELECT string_agg(a.storage_path, '','') FROM purchase_attachment a JOIN purchases p ON p.id = a.purchase_id WHERE p.idempotency_key = %L', 'WA:' || pg_temp.get('d5') || ':v1'))
  || '|' || pg_temp.links(pg_temp.get('doc1')) || '|' || pg_temp.cnt(format('SELECT extraction ->> ''issuer_name'' FROM document_file WHERE id = %L::uuid', pg_temp.get('doc1'))),
  'OK:{"ok": |1|1|0|wa/' || pg_temp.sha('ticket-gasoil') || '.jpg|PURCHASE|YPF');
SELECT pg_temp.expect('R-7 the same receipt can not open a second draft once used',
  left(pg_temp.propose(pg_temp.msg(pg_temp.v('phone_a'), 'otra vez'), 'CASUAL_EXPENSE', pg_temp.cash(4321, 'Gasoil') || jsonb_build_object('document_file_id', pg_temp.get('doc1'))), 60),
  'ERR:WA_DOCUMENT_ALREADY_USED: W-%');

-- R-6 only a photo: the draft keeps the reading, the concept is asked; it can not be confirmed until the concept is told
SELECT pg_temp.put('i6', pg_temp.mmsg(pg_temp.v('phone_a'), 'image', NULL, 'image/png')::text);
SELECT pg_temp.put('doc6', pg_temp.j(pg_temp.store(pg_temp.get('i6')::bigint, pg_temp.sha('ticket-sin-concepto'), 'image/png')) ->> 'document_file_id');
SELECT pg_temp.put('r6', pg_temp.propose(pg_temp.get('i6')::bigint, 'CASUAL_EXPENSE', (pg_temp.cash(777) - 'concept') || jsonb_build_object('concept_pending', true, 'document_file_id', pg_temp.get('doc6'))));
SELECT pg_temp.put('d6', pg_temp.did(pg_temp.get('r6')));
SELECT pg_temp.expect('R-6 receipt without concept: concept_pending, not confirmable (WA_CONCEPT_REQUIRED), nothing recorded',
  (pg_temp.j(pg_temp.get('r6')) -> 'payload' ->> 'concept_pending') || '|' || coalesce(pg_temp.j(pg_temp.get('r6')) -> 'payload' ->> 'concept', '-')
  || '|' || left(pg_temp.confirm(pg_temp.btn(pg_temp.v('phone_a'), pg_temp.get('d6'), 1), pg_temp.get('d6'), 1), 23) || '|' || pg_temp.state(pg_temp.get('d6')),
  'true|-|ERR:WA_CONCEPT_REQUIRED|DRAFT');
SELECT pg_temp.expect('R-6b the concept answered → concept_pending gone → confirmed once',
  (SELECT (j -> 'payload' ? 'concept_pending')::text || '|' || (j -> 'payload' ->> 'concept') FROM (SELECT pg_temp.j(pg_temp.correct(pg_temp.msg(pg_temp.v('phone_a'), 'alambre'), pg_temp.get('d6'), 1,
     (pg_temp.cash(777, 'Alambre') - 'concept_pending') || jsonb_build_object('concept', 'Alambre', 'document_file_id', pg_temp.get('doc6')))) AS j) x)
  || '|' || left(pg_temp.confirm(pg_temp.btn(pg_temp.v('phone_a'), pg_temp.get('d6'), 2), pg_temp.get('d6'), 2), 10),
  'false|Alambre|OK:{"ok": ');

-- R-8 / R-9 invoice A with IVA: ONE purchase, ONE payment, ONE fiscal document with its IVA component; totals must agree
SELECT pg_temp.put('i9', pg_temp.mmsg(pg_temp.v('phone_a'), 'document', 'repuestos tractor', 'application/pdf')::text);
SELECT pg_temp.put('doc9', pg_temp.j(pg_temp.store(pg_temp.get('i9')::bigint, pg_temp.sha('factura-a-0001'), 'application/pdf')) ->> 'document_file_id');
SELECT pg_temp.expect('R-8 an invoice whose total differs from the expense is refused',
  pg_temp.propose(pg_temp.msg(pg_temp.v('phone_a'), 'x'), 'CASUAL_WITH_INVOICE', pg_temp.cash(1200, 'Repuestos') || jsonb_build_object('fiscal', pg_temp.vat('0001-00009001') -> 'fiscal')),
  'ERR:WA_INVALID_PAYLOAD: the invoice total differs%');
DELETE FROM t_r; INSERT INTO t_r SELECT pg_temp.ops(), (SELECT count(*) FROM purchases), (SELECT count(*) FROM fiscal_document);
SELECT pg_temp.put('d9', pg_temp.did(pg_temp.propose(pg_temp.get('i9')::bigint, 'CASUAL_WITH_INVOICE',
  pg_temp.cash(1210, 'Repuestos tractor') || jsonb_build_object('fiscal', pg_temp.vat('0001-00009002') -> 'fiscal', 'document_file_id', pg_temp.get('doc9')))));
SELECT pg_temp.expect('R-9 invoice A: +1 purchase (1210, IVA not a second expense), +1 operation, +1 fiscal document with 1 IVA component; links PURCHASE + FISCAL_DOCUMENT',
  left(pg_temp.confirm(pg_temp.btn(pg_temp.v('phone_a'), pg_temp.get('d9'), 1), pg_temp.get('d9'), 1), 10)
  || '|' || (pg_temp.npur() - (SELECT pur FROM t_r)) || '|' || (pg_temp.ops() - (SELECT ops FROM t_r)) || '|' || (pg_temp.nfis() - (SELECT fis FROM t_r))
  || '|' || pg_temp.cnt('SELECT count(*) || ''='' || sum(c.tax_amount) FROM fiscal_document_component c JOIN fiscal_document f ON f.id = c.fiscal_document_id WHERE f.external_number = ''0001-00009002''')
  || '|' || pg_temp.cnt('SELECT amount_total::text FROM purchases WHERE fiscal_document_id = (SELECT id FROM fiscal_document WHERE external_number = ''0001-00009002'')')
  || '|' || pg_temp.links(pg_temp.get('doc9')),
  'OK:{"ok": |1|1|1|1=210.00|1210.00|FISCAL_DOCUMENT,PURCHASE');

-- R-10 "solo IVA": ONLY the fiscal document (credit), no purchase, no money movement; the file is kept
SELECT pg_temp.put('i10', pg_temp.mmsg(pg_temp.v('phone_a'), 'image', 'solo IVA, lo pagué con mi plata', 'image/jpeg')::text);
SELECT pg_temp.put('doc10', pg_temp.j(pg_temp.store(pg_temp.get('i10')::bigint, pg_temp.sha('factura-solo-iva'))) ->> 'document_file_id');
DELETE FROM t_r; INSERT INTO t_r SELECT pg_temp.ops(), (SELECT count(*) FROM purchases), (SELECT count(*) FROM fiscal_document);
SELECT pg_temp.put('d10', pg_temp.did(pg_temp.propose(pg_temp.get('i10')::bigint, 'VAT_ONLY_DOCUMENT', pg_temp.vat('0002-00000777') || jsonb_build_object('document_file_id', pg_temp.get('doc10')))));
SELECT pg_temp.expect('R-10 VAT only: +0 purchase, +0 operation, +1 fiscal document; link FISCAL_DOCUMENT',
  left(pg_temp.confirm(pg_temp.btn(pg_temp.v('phone_a'), pg_temp.get('d10'), 1), pg_temp.get('d10'), 1), 10)
  || '|' || (pg_temp.npur() - (SELECT pur FROM t_r)) || '|' || (pg_temp.ops() - (SELECT ops FROM t_r)) || '|' || (pg_temp.nfis() - (SELECT fis FROM t_r))
  || '|' || pg_temp.links(pg_temp.get('doc10')),
  'OK:{"ok": |0|0|1|FISCAL_DOCUMENT');

-- R-11 unclassified with the receipt → classified later in the ERP: the same file follows to the purchase (no copy)
SELECT pg_temp.put('i11', pg_temp.mmsg(pg_temp.v('phone_a'), 'image', 'algo', 'image/jpeg')::text);
SELECT pg_temp.put('doc11', pg_temp.j(pg_temp.store(pg_temp.get('i11')::bigint, pg_temp.sha('ticket-sin-clasif'))) ->> 'document_file_id');
SELECT pg_temp.put('d11', pg_temp.did(pg_temp.propose(pg_temp.get('i11')::bigint, 'CASUAL_EXPENSE', (pg_temp.cash(555, 'Cosas varias') - 'category_id') || jsonb_build_object('document_file_id', pg_temp.get('doc11')))));
SELECT pg_temp.put('u11', pg_temp.confirm(pg_temp.ubutton(pg_temp.v('phone_a'), pg_temp.get('d11'), 1), pg_temp.get('d11'), 1));
SELECT pg_temp.put('p11', pg_temp.cnt(format('SELECT id::text FROM expense_pending_classification WHERE idempotency_key = %L', 'WA:' || pg_temp.get('d11') || ':v1')));
SELECT pg_temp.expect('R-11 unclassified: link EXPENSE_PENDING; classified in the ERP → purchase_attachment + link PURCHASE, one file row',
  left(pg_temp.get('u11'), 10) || '|' || pg_temp.links(pg_temp.get('doc11'))
  || '|' || left(pg_temp.adm(format('SELECT public.classify_pending_expense(%s, %L::uuid, ''OPERATING'', NULL, NULL, NULL)::text', pg_temp.get('p11'), 'aaaaaaaa-0025-0000-0000-0000000000c1')), 3)
  || '|' || pg_temp.links(pg_temp.get('doc11'))
  || '|' || pg_temp.cnt(format('SELECT count(*)::text FROM purchase_attachment a JOIN expense_pending_resolution r ON r.purchase_id = a.purchase_id WHERE r.pending_id = %s', coalesce(pg_temp.get('p11'), '0')))
  || '|' || pg_temp.cnt(format('SELECT count(*)::text FROM document_file WHERE sha256 = %L', pg_temp.sha('ticket-sin-clasif'))),
  'OK:{"ok": |EXPENSE_PENDING|OK:|EXPENSE_PENDING,PURCHASE|1|1');

-- R-12 a receipt sent by A can not be recorded by B
SELECT pg_temp.put('i12', pg_temp.mmsg(pg_temp.v('phone_a'), 'image', 'x', 'image/jpeg')::text);
SELECT pg_temp.put('doc12', pg_temp.j(pg_temp.store(pg_temp.get('i12')::bigint, pg_temp.sha('ticket-de-a'))) ->> 'document_file_id');
SELECT pg_temp.put('d12', pg_temp.did(pg_temp.propose(pg_temp.msg(pg_temp.v('phone_b'), 'uso el de A'), 'CASUAL_EXPENSE', pg_temp.cash(99, 'Ajeno') || jsonb_build_object('document_file_id', pg_temp.get('doc12')))));
DELETE FROM t_r; INSERT INTO t_r SELECT pg_temp.ops(), (SELECT count(*) FROM purchases), (SELECT count(*) FROM fiscal_document);
SELECT pg_temp.expect('R-12 another user''s receipt: the confirmation is refused, nothing recorded',
  left(pg_temp.confirm(pg_temp.btn(pg_temp.v('phone_b'), pg_temp.get('d12'), 1), pg_temp.get('d12'), 1), 25)
  || '|' || (pg_temp.npur() - (SELECT pur FROM t_r)) || '|' || (pg_temp.ops() - (SELECT ops FROM t_r)),
  'ERR:WA_DOCUMENT_NOT_OWNED|0|0');

-- R-13 Mercado Pago: the waiting draft lists the matching pending outflow; linking it records NO second outflow
DO $$
DECLARE v_src UUID; v_mv BIGINT;
BEGIN
  INSERT INTO mp_source_record (source_type, external_id, event_data, occurred_at, occurred_date)
  VALUES ('csv_import', '930000025099:payment:D', jsonb_build_object('SOURCE_ID', '930000025099', 'DESCRIPTION', 'payment', 'NET_CREDIT_AMOUNT', '0.00', 'NET_DEBIT_AMOUNT', '3333.00'),
          '2026-10-21T10:00:00-03:00', '2026-10-21') RETURNING id INTO v_src;
  INSERT INTO mp_financial_movement (mp_source_record_id, movement_kind, gross_amount, fee_amount, tax_amount, net_amount, occurred_date)
  VALUES (v_src, 'outbound', -3333.00, 0, 0, -3333.00, '2026-10-21') RETURNING id INTO v_mv;
  INSERT INTO mp_transition_identity (resource_type, resource_id, transition, transition_ref, claimed_by_source_id, mp_financial_movement_id)
  VALUES ('report', '930000025099:payment:D', 'OUTBOUND', '', v_src, v_mv);
  IF mp_pending_outflow_post('930000025099', NULL, current_setting('wa.t_admin_a')::uuid) <> 'POSTED' THEN RAISE EXCEPTION 'R-13 fixture not posted'; END IF;
END $$;
SELECT pg_temp.put('r13', pg_temp.propose(pg_temp.msg(pg_temp.v('phone_a'), 'pagué con mp'), 'CASUAL_EXPENSE', pg_temp.mp(3333) || jsonb_build_object('date', '2026-10-21')));
SELECT pg_temp.expect('R-13 WAITING_MP lists the candidate (same amount and date, the wa_link_mp rule)', (pg_temp.j(pg_temp.get('r13')) ->> 'state') || '|' || (pg_temp.j(pg_temp.get('r13')) -> 'mp_candidates' -> 0 ->> 'source_id'),
  'WAITING_MP|930000025099');
DELETE FROM t_r; INSERT INTO t_r SELECT pg_temp.ops(), (SELECT count(*) FROM purchases), (SELECT count(*) FROM fiscal_document);
SELECT pg_temp.put('d13', pg_temp.did(pg_temp.get('r13')));
SELECT pg_temp.expect('R-13b linked + confirmed: the purchase settles the existing outflow — no new operation',
  left(pg_temp.link(pg_temp.msg(pg_temp.v('phone_a'), 'es ese'), pg_temp.get('d13'), 1, '930000025099'), 3)
  || '|' || left(pg_temp.confirm(pg_temp.btn(pg_temp.v('phone_a'), pg_temp.get('d13'), 2), pg_temp.get('d13'), 2), 10)
  || '|' || (pg_temp.npur() - (SELECT pur FROM t_r)),
  'OK:|OK:{"ok": |1');

-- ── 0104 own cheques for an invoice ─────────────────────────────────────────
SELECT pg_temp.put('pi', pg_temp.j(pg_temp.adm(format('SELECT public.register_purchase(p_supplier_id := ''aaaaaaaa-0025-0000-0000-0000000000a1'', p_economic_date := ''2026-10-20'',
  p_amount_net := 1000, p_amount_total := 1000, p_expense_category_id := ''aaaaaaaa-0025-0000-0000-0000000000c1'', p_subcategory := NULL, p_nature := ''OPERATING'',
  p_lines := ''[]'', p_attachments := ''[]'', p_idempotency_key := ''T-0104-INV-1'', p_supplier_invoice_number := ''A-0001-00000777'')::text'))) ->> 'purchase_id');
CREATE FUNCTION pg_temp.chq(p_n TEXT, p_amount NUMERIC, p_mat TEXT, p_replaces TEXT DEFAULT NULL) RETURNS JSONB LANGUAGE sql AS $f$
  SELECT jsonb_strip_nulls(jsonb_build_object('instrument_type', 'ECHEQ', 'cheque_number', p_n, 'amount', p_amount, 'maturity_date', p_mat, 'issued_date', '2026-10-20',
         'bank_account_id', (SELECT id FROM financial_account WHERE nombre = 'BNA'), 'replaces_instrument_id', p_replaces)) $f$;
CREATE FUNCTION pg_temp.bank() RETURNS TEXT LANGUAGE plpgsql AS $f$ BEGIN
  RETURN (SELECT count(*) || '/' || coalesce(sum(signed_amount), 0) FROM financial_posting WHERE financial_account_id = (SELECT id FROM financial_account WHERE nombre = 'BNA')); END $f$;
CREATE FUNCTION pg_temp.status(p TEXT) RETURNS TEXT LANGUAGE sql AS $f$
  SELECT pg_temp.adm(format('SELECT scheduled || ''|'' || debited || ''|'' || other_payments || ''|'' || pending FROM public.fin_purchase_payment_status WHERE purchase_id = %L::uuid', p)) $f$;
SELECT pg_temp.put('bank0', pg_temp.bank());
SELECT pg_temp.put('iss', pg_temp.adm(format('SELECT public.issue_purchase_instruments(%L::uuid, %L::jsonb, ''T-0104-K1'')::text', pg_temp.get('pi'),
  jsonb_build_array(pg_temp.chq('E-1', 600, '2026-11-20'), pg_temp.chq('E-2', 300, '2026-12-20')))));
SELECT pg_temp.expect('C-1 two eCheqs issued for the invoice: no bank movement; supplier debt reduced 900; status scheduled 900 / pending 100',
  left(pg_temp.get('iss'), 3) || '|' || (pg_temp.bank() = pg_temp.get('bank0'))
  || '|' || pg_temp.cnt('SELECT sum(signed_amount)::text FROM supplier_ledger WHERE supplier_id = ''aaaaaaaa-0025-0000-0000-0000000000a1'' AND source_entity_type = ''financial_instrument''')
  || '|' || pg_temp.status(pg_temp.get('pi')),
  'OK:|true|-900.00|OK:900.00|0|0|100.00');
SELECT pg_temp.expect('C-2 above the pending balance is refused; the same key replays (no new instrument)',
  left(pg_temp.adm(format('SELECT public.issue_purchase_instruments(%L::uuid, %L::jsonb, ''T-0104-K2'')::text', pg_temp.get('pi'), jsonb_build_array(pg_temp.chq('E-3', 101, '2026-12-30')))), 20)
  || '|' || (pg_temp.j(pg_temp.adm(format('SELECT public.issue_purchase_instruments(%L::uuid, %L::jsonb, ''T-0104-K1'')::text', pg_temp.get('pi'), jsonb_build_array(pg_temp.chq('E-1', 600, '2026-11-20'))))) ->> 'replayed')
  || '|' || pg_temp.cnt('SELECT count(*)::text FROM financial_instrument WHERE cheque_number IN (''E-1'', ''E-2'', ''E-3'')'),
  'ERR:OVER_ALLOCATION:|true|2');
SELECT pg_temp.put('e1', pg_temp.j(pg_temp.get('iss')) -> 'instrument_ids' ->> 0);
SELECT pg_temp.put('e2', pg_temp.j(pg_temp.get('iss')) -> 'instrument_ids' ->> 1);
SELECT pg_temp.expect('C-3 the calendar lists both scheduled eCheqs by maturity',
  pg_temp.adm(format('SELECT string_agg(cheque_number || ''@'' || maturity_date, '','' ORDER BY maturity_date) FROM public.fin_scheduled_payments WHERE purchase_root_id = %L::uuid', pg_temp.get('pi'))),
  'OK:E-1@2026-11-20,E-2@2026-12-20');
SELECT pg_temp.expect('C-4 debit of E-1 on its effective date: ONE bank posting −600 dated that day; scheduled 300 / debited 600 / pending 100',
  left(pg_temp.adm(format('SELECT public.mark_supplier_instrument_debited(%L::uuid, ''2026-10-22'')::text', pg_temp.get('e1'))), 3)
  || '|' || pg_temp.cnt(format('SELECT count(*) || ''='' || sum(signed_amount) || ''@'' || max(effective_date) FROM financial_posting WHERE financial_account_id = (SELECT id FROM financial_account WHERE nombre = ''BNA'') AND financial_operation_id IN (SELECT financial_operation_id FROM financial_instrument_event WHERE financial_instrument_id = %L::uuid)', pg_temp.get('e1')))
  || '|' || pg_temp.status(pg_temp.get('pi')),
  'OK:|1=-600.00@2026-10-22|OK:300.00|600.00|0|100.00');
SELECT pg_temp.expect('C-5 E-2 rejected → its 300 is pending again; a replacement eCheq points to it and settles it (history kept)',
  left(pg_temp.adm(format('SELECT public.cancel_supplier_instrument(%L::uuid, ''2026-10-23'', ''error de fecha'')::text', pg_temp.get('e2'))), 3)
  || '|' || pg_temp.status(pg_temp.get('pi'))
  || '|' || left(pg_temp.adm(format('SELECT public.issue_purchase_instruments(%L::uuid, %L::jsonb, ''T-0104-K3'')::text', pg_temp.get('pi'), jsonb_build_array(pg_temp.chq('E-2B', 300, '2026-12-27', pg_temp.get('e2'))))), 3)
  || '|' || pg_temp.status(pg_temp.get('pi'))
  || '|' || pg_temp.cnt(format('SELECT count(*)::text FROM financial_instrument WHERE replaces_instrument_id = %L::uuid', pg_temp.get('e2'))),
  'OK:|OK:0|600.00|0|400.00|OK:|OK:300.00|600.00|0|100.00|1');
SELECT pg_temp.put('pay', pg_temp.j(pg_temp.adm('SELECT public.pay_supplier(''aaaaaaaa-0025-0000-0000-0000000000a1'', 150, ''2026-10-24'', ''CASH'', (SELECT id FROM financial_account WHERE nombre = ''Caja chica''), ''T-0104-PAY-1'')::text')) ->> 'financial_operation_id');
SELECT pg_temp.expect('C-6 mixed payment: 100 of a 150 cash payment completes the invoice (pending 0); more than the invoice is refused',
  left(pg_temp.adm(format('SELECT public.allocate_purchase_payment(%L::uuid, %s, 100, ''T-0104-AL-1'')::text', pg_temp.get('pi'), pg_temp.get('pay'))), 3)
  || '|' || pg_temp.status(pg_temp.get('pi'))
  || '|' || left(pg_temp.adm(format('SELECT public.allocate_purchase_payment(%L::uuid, %s, 50, ''T-0104-AL-2'')::text', pg_temp.get('pi'), pg_temp.get('pay'))), 20),
  'OK:|OK:300.00|600.00|100.00|0.00|ERR:OVER_ALLOCATION:');
SELECT pg_temp.expect('C-7 the IVA / invoice is booked once: issuing / debiting cheques creates no purchase and no fiscal document',
  pg_temp.cnt('SELECT count(*)::text FROM purchases WHERE idempotency_key = ''T-0104-INV-1''') || '|' || pg_temp.cnt('SELECT count(*)::text FROM audit_events WHERE action = ''ISSUE_INSTRUMENTS'''),
  '1|2');
SELECT pg_temp.expect('C-8 an OPERATOR can not issue or allocate',
  left(pg_temp.as_('authenticated', pg_temp.v('oper'), format('SELECT public.issue_purchase_instruments(%L::uuid, %L::jsonb, ''T-0104-K9'')::text', pg_temp.get('pi'), jsonb_build_array(pg_temp.chq('E-9', 1, '2026-12-30')))), 13),
  'ERR:FORBIDDEN');

SELECT pg_temp.expect('C-9 the payment detail keeps the whole history: debited, cancelled, its replacement and the cash payment (in order)',
  pg_temp.adm(format('SELECT string_agg(coalesce(cheque_number, ''OP'') || '':'' || coalesce(estado::text, ''PAID'') || '':'' || amount || (CASE WHEN replaces_instrument_id IS NOT NULL THEN ''*'' ELSE '''' END), '','' ORDER BY created_at, allocation_id) FROM public.fin_purchase_payment_detail WHERE purchase_root_id = %L::uuid', pg_temp.get('pi'))),
  'OK:E-1:DEBITED:600.00,E-2:CANCELLED:300.00,E-2B:ISSUED:300.00*,OP:PAID:100.00');
SELECT 'SUMMARY-0103-0104|' || count(*) FILTER (WHERE ok) || '|' || count(*) FILTER (WHERE NOT ok) FROM t_result WHERE n > (SELECT n FROM t_base);
