-- ADR-025 §18 — precondition of a STAGING upgrade: the installed bot staging (wa + sim), never the ERP.
DO $$ BEGIN
  IF to_regclass('migration_ledger.applied') IS NOT NULL OR to_regclass('public.perfiles') IS NOT NULL
     OR to_regnamespace('wa') IS NULL OR to_regnamespace('sim') IS NULL THEN
    RAISE EXCEPTION 'STAGING_UPGRADE_GUARD: not the installed AppGranja bot staging';
  END IF;
  RAISE NOTICE 'STAGING_UPGRADE_GUARD: PASS';
END $$;
DO $$ BEGIN IF to_regprocedure('wa.selectable_categories()') IS NULL THEN RAISE EXCEPTION 'UPGRADE_006_GUARD: upgrade-004/005 not installed'; END IF;
  IF to_regprocedure('public.wa_note_reply(bigint,text)') IS NOT NULL THEN RAISE EXCEPTION 'UPGRADE_006_GUARD: already installed'; END IF; END $$;
SET LOCAL search_path = sim, public, pg_temp;
-- STAGING build of supabase/target-migrations/0134_wa_memoria_conversacion.sql (identical except search_path)
-- ============================================================================
-- TARGET V1 — 0134 WHATSAPP: MEMORIA BREVE DE LA CONVERSACIÓN (owner 2026-11-18)
--
--   «Que el bot converse: que recuerde la operación en curso, la última pregunta que hizo y lo que le respondí.»
--   The user's side of the conversation is ALREADY stored (wa.inbound_message.text_body, one row per accepted message); only the
--   bot's answer was missing. Nothing financial changes: no draft, posting, payment, purchase, rule or validation is touched.
--   1. wa.inbound_message.bot_reply / bot_reply_at — the text the bot sent in answer to THAT message (≤ 1000 chars).
--   2. wa_note_reply(p_inbound_id, p_reply) — SECURITY DEFINER, gateway only (wa.gate), an accepted fresh message of an authorized
--      sender; writes the reply ONCE (a retry returns replay, never overwrites). It is NOT an action: it does not claim the message
--      (wa.claim_inbound), creates no draft and audits nothing financial.
--   3. wa_context (0102 body, same identity) + «history»: the sender's previous accepted messages of the last 24 hours (at most 8,
--      oldest first): text, the kind of button pressed (never its ids), the action it drove, its draft code and the bot's reply.
--      Read-only, as before.
--   SECURITY DEFINER set +1 (wa_note_reply).
-- ============================================================================

ALTER TABLE wa.inbound_message
  ADD COLUMN bot_reply    TEXT CHECK (bot_reply IS NULL OR length(bot_reply) BETWEEN 1 AND 1000),
  ADD COLUMN bot_reply_at TIMESTAMPTZ;
-- the history read of wa_context: the sender's recent messages
CREATE INDEX wa_inbound_sender_recent ON wa.inbound_message (sender_perfil_id, id DESC) WHERE outcome = 'ACCEPTED';

-- >>> wa_note_reply
CREATE FUNCTION public.wa_note_reply(p_inbound_id BIGINT, p_reply TEXT) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = sim, public, pg_temp AS $$
DECLARE m wa.inbound_message; v TEXT := left(btrim(coalesce(p_reply, '')), 1000);
BEGIN
  PERFORM wa.gate();
  SELECT * INTO m FROM wa.inbound_message WHERE id = p_inbound_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'WA_MESSAGE_NOT_FOUND'; END IF;
  IF m.outcome <> 'ACCEPTED' THEN RAISE EXCEPTION 'WA_MESSAGE_NOT_ACCEPTED: %', m.outcome; END IF;
  IF m.received_at < now() - interval '1 hour' THEN RAISE EXCEPTION 'WA_MESSAGE_TOO_OLD'; END IF;
  PERFORM wa.assert_owner(m.sender_perfil_id);
  IF v = '' THEN RAISE EXCEPTION 'WA_INVALID_PAYLOAD: reply text required'; END IF;
  IF m.bot_reply IS NOT NULL THEN RETURN jsonb_build_object('ok', true, 'replay', true); END IF;   -- once: never overwritten
  UPDATE wa.inbound_message SET bot_reply = v, bot_reply_at = now() WHERE id = p_inbound_id;
  RETURN jsonb_build_object('ok', true);
END $$;
-- <<< wa_note_reply

-- >>> wa_context
CREATE OR REPLACE FUNCTION public.wa_context(p_inbound_id BIGINT) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = sim, public, pg_temp AS $$
DECLARE m wa.inbound_message; v_open JSONB; v_waiting JSONB; v_cats JSONB; v_accs JSONB; v_hist JSONB;
BEGIN
  PERFORM wa.gate();
  SELECT * INTO m FROM wa.inbound_message WHERE id = p_inbound_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'WA_MESSAGE_NOT_FOUND'; END IF;
  IF m.outcome <> 'ACCEPTED' THEN RAISE EXCEPTION 'WA_MESSAGE_NOT_ACCEPTED: %', m.outcome; END IF;
  IF m.received_at < now() - interval '1 hour' THEN RAISE EXCEPTION 'WA_MESSAGE_TOO_OLD'; END IF;
  PERFORM wa.assert_owner(m.sender_perfil_id);
  SELECT jsonb_build_object('draft_id', d.id, 'short_code', d.short_code, 'state', d.state, 'version', d.version, 'payload', d.payload, 'expires_at', d.expires_at)
    INTO v_open FROM wa.draft d
   WHERE d.owner_perfil_id = m.sender_perfil_id AND d.state IN ('DRAFT', 'FAILED') AND d.expires_at > now()
   ORDER BY (d.state = 'DRAFT') DESC, d.updated_at DESC LIMIT 1;
  SELECT coalesce(jsonb_agg(jsonb_build_object('draft_id', d.id, 'short_code', d.short_code, 'version', d.version,
                                               'total', d.payload -> 'total', 'date', d.payload -> 'date') ORDER BY d.created_at), '[]'::jsonb)
    INTO v_waiting FROM wa.draft d WHERE d.owner_perfil_id = m.sender_perfil_id AND d.state = 'WAITING_MP' AND d.expires_at > now();
  -- the live ERP catalog with its hierarchy (category → subcategory); ids are what the draft and the accounting call use
  SELECT coalesce(jsonb_agg(jsonb_build_object('id', s.id, 'nombre', s.nombre, 'grupo_id', s.grupo_id, 'grupo', s.grupo) ORDER BY s.grupo, s.nombre), '[]'::jsonb)
    INTO v_cats FROM wa.selectable_categories() s;
  -- the live enabled paying accounts with the method each one serves (ids are what the draft and the accounting call use)
  SELECT coalesce(jsonb_agg(jsonb_build_object('id', s.id, 'nombre', s.nombre, 'account_type', s.account_type, 'method', s.method) ORDER BY s.method, s.nombre), '[]'::jsonb)
    INTO v_accs FROM wa.selectable_accounts() s;
  -- 0134: the short memory — the sender's previous accepted messages of the last 24 hours (≤ 8, oldest first) with the bot's reply.
  --       A button is reported by its kind (and the method it picks), never by its draft id / version.
  SELECT coalesce(jsonb_agg(jsonb_build_object('at', h.received_at, 'kind', h.kind, 'text', left(h.text_body, 1000),
                                               'button', CASE WHEN h.button_payload IS NOT NULL THEN split_part(h.button_payload, ':', 1) END,
                                               'button_method', CASE WHEN h.button_payload LIKE 'METHOD:%' THEN split_part(h.button_payload, ':', 4) END,
                                               'action', h.used_action, 'draft', d.short_code, 'bot', h.bot_reply) ORDER BY h.id), '[]'::jsonb)
    INTO v_hist
    FROM (SELECT * FROM wa.inbound_message i
           WHERE i.sender_perfil_id = m.sender_perfil_id AND i.outcome = 'ACCEPTED' AND i.id < m.id
             AND i.received_at > now() - interval '24 hours'
           ORDER BY i.id DESC LIMIT 8) h
    LEFT JOIN wa.draft d ON d.id = h.used_draft_id;
  RETURN jsonb_build_object('ok', true, 'open', v_open, 'waiting', v_waiting, 'catalog', jsonb_build_object('categories', v_cats, 'accounts', v_accs),
                            'history', v_hist);
END $$;
-- <<< wa_context

-- privileges: as every wa_* API function (0102) — owner postgres, EXECUTE only for authenticated (the gate inside decides)
ALTER FUNCTION public.wa_note_reply(BIGINT, TEXT) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.wa_note_reply(BIGINT, TEXT) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.wa_note_reply(BIGINT, TEXT) TO authenticated;
ALTER FUNCTION public.wa_context(BIGINT) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.wa_context(BIGINT) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.wa_context(BIGINT) TO authenticated;
