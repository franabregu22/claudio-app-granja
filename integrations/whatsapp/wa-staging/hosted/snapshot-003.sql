-- ADR-025 — READ-ONLY accounting / confirmation snapshot for upgrade-003 (same expression as SNAP in verify-upgrade-003.sql).
BEGIN READ ONLY;
SELECT 'snap|' || s FROM (SELECT 'purchases=' || (SELECT count(*) FROM sim.purchases) || '|sum=' || (SELECT coalesce(sum(amount_total), 0) FROM sim.purchases)
           || '|current=' || (SELECT count(*) FROM sim.purchases WHERE is_current) || '|fiscal=' || (SELECT count(*) FROM sim.fiscal_document)
           || '|sim_audit=' || (SELECT count(*) FROM sim.audit_events) || '|mp_pending=' || (SELECT count(*) FROM sim.mp_pending_outflow)
           || '|confirmations=' || (SELECT count(*) FROM wa.confirmation) AS s) x;
ROLLBACK;
