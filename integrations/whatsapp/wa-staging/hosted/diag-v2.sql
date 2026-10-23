-- ADR-025 — READ-ONLY diagnosis of the first V2 message. psql variable: since (timestamptz). No phone / token / secret printed.
\set ON_ERROR_STOP 1
BEGIN READ ONLY;
SELECT 'inbound|' || m.id || '|' || to_char(m.received_at AT TIME ZONE 'America/Argentina/Buenos_Aires', 'HH24:MI:SS') || '|' || m.kind || '|' || m.outcome
       || '|used=' || coalesce(m.used_action, '-') || '|draft=' || coalesce((SELECT d.short_code FROM wa.draft d WHERE d.id = m.used_draft_id), '-')
       || '|text=' || coalesce(left(m.text_body, 60), '-') || '|btn=' || coalesce(left(m.button_payload, 12), '-')
  FROM wa.inbound_message m WHERE m.received_at >= :'since'::timestamptz ORDER BY m.id;
SELECT 'audit|' || e.id || '|' || to_char(e.at AT TIME ZONE 'America/Argentina/Buenos_Aires', 'HH24:MI:SS') || '|' || e.action || '|' || e.outcome
       || '|inbound=' || coalesce(e.inbound_id::text, '-') || '|draft=' || coalesce((SELECT d.short_code FROM wa.draft d WHERE d.id = e.draft_id), '-')
       || '|v' || coalesce(e.version::text, '-') || '|' || coalesce(left(e.detail::text, 120), '')
  FROM wa.audit_event e WHERE e.at >= :'since'::timestamptz ORDER BY e.id;
SELECT 'draft|' || d.short_code || '|' || d.state || '|v' || d.version || '|total=' || coalesce(d.payload ->> 'total', '-') || '|concept=' || coalesce(left(d.payload ->> 'concept', 40), '-')
       || '|method=' || coalesce(d.payload ->> 'method', '-') || '|created ' || to_char(d.created_at AT TIME ZONE 'America/Argentina/Buenos_Aires', 'DD/MM HH24:MI')
  FROM wa.draft d WHERE d.created_at >= :'since'::timestamptz OR d.short_code = 'W-0009' OR d.state IN ('DRAFT', 'WAITING_MP', 'FAILED') ORDER BY d.short_code;
SELECT 'info|last inbound overall: ' || coalesce((SELECT to_char(max(received_at) AT TIME ZONE 'America/Argentina/Buenos_Aires', 'DD/MM HH24:MI:SS') FROM wa.inbound_message), '-')
       || ' · last audit: ' || coalesce((SELECT to_char(max(at) AT TIME ZONE 'America/Argentina/Buenos_Aires', 'DD/MM HH24:MI:SS') || ' ' || (SELECT action || ':' || outcome FROM wa.audit_event ORDER BY id DESC LIMIT 1) FROM wa.audit_event), '-');
ROLLBACK;
