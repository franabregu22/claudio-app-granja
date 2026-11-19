-- rollback of upgrade-006 on AppGranja (aplbsutpzgemexayldct) — wa_context as read from THIS database before the upgrade
BEGIN;
DO $$ BEGIN IF to_regclass('migration_ledger.applied') IS NOT NULL OR to_regnamespace('sim') IS NULL THEN RAISE EXCEPTION 'ROLLBACK_GUARD: not the bot staging'; END IF; END $$;
DROP FUNCTION IF EXISTS public.wa_note_reply(bigint, text);
CREATE OR REPLACE FUNCTION public.wa_context(p_inbound_id bigint)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'sim', 'public', 'pg_temp'
AS $function$
DECLARE m wa.inbound_message; v_open JSONB; v_waiting JSONB; v_cats JSONB; v_accs JSONB;
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
  RETURN jsonb_build_object('ok', true, 'open', v_open, 'waiting', v_waiting, 'catalog', jsonb_build_object('categories', v_cats, 'accounts', v_accs));
END $function$
;
ALTER FUNCTION public.wa_context(bigint) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.wa_context(bigint) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.wa_context(bigint) TO authenticated;
DROP INDEX IF EXISTS wa.wa_inbound_sender_recent;
ALTER TABLE wa.inbound_message DROP COLUMN IF EXISTS bot_reply, DROP COLUMN IF EXISTS bot_reply_at;
COMMIT;
