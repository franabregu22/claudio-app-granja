-- ADR-025 — READ-ONLY accounting snapshot of the bot staging (same expression as SIN_CAMBIOS in verify-upgrade-004.sql).
BEGIN READ ONLY;
SELECT 'acct|purchases=' || (SELECT count(*) FROM sim.purchases) || '|sum=' || (SELECT coalesce(sum(amount_total), 0) FROM sim.purchases)
       || '|mp_pending=' || (SELECT count(*) FROM sim.mp_pending_outflow) || '|confirmations=' || (SELECT count(*) FROM wa.confirmation);
ROLLBACK;
