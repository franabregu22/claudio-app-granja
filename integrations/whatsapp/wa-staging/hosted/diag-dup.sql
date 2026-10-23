-- ADR-025 — READ-ONLY: which recorded purchase triggers the duplicate hint of W-0011 (wa.duplicate_hint: current sim purchases, same total, date ±2 days).
\set ON_ERROR_STOP 1
BEGIN READ ONLY;
WITH d AS (SELECT * FROM wa.draft WHERE short_code = 'W-0011')
SELECT 'draft|' || d.short_code || '|' || d.state || '|v' || d.version || '|total=' || (d.payload ->> 'total') || '|date=' || (d.payload ->> 'date')
       || '|hint_now=' || wa.duplicate_hint(d.payload) FROM d;
SELECT 'version|W-0011|v' || v.version || '|total=' || (v.payload ->> 'total') || '|date=' || (v.payload ->> 'date') || '|hint=' || wa.duplicate_hint(v.payload)
  FROM wa.draft_version v JOIN wa.draft d ON d.id = v.draft_id WHERE d.short_code = 'W-0011' ORDER BY v.version;
WITH d AS (SELECT * FROM wa.draft WHERE short_code = 'W-0011')
SELECT 'match|' || coalesce((SELECT w.short_code FROM wa.confirmation c JOIN wa.draft w ON w.id = c.draft_id WHERE c.idempotency_key = x.idempotency_key), 'no-WA')
       || '|total=' || x.amount_total || '|date=' || x.economic_date || '|cat=' || coalesce(cat.nombre, '-') || '|concept=' || coalesce(left(x.concept, 40), '-')
       || '|current=' || x.is_current || '|same_category=' || (x.expense_category_id::text = d.payload ->> 'category_id')
  FROM sim.purchases x CROSS JOIN d LEFT JOIN sim.expense_category cat ON cat.id = x.expense_category_id
 WHERE x.is_current AND x.amount_total = (d.payload ->> 'total')::numeric
   AND x.economic_date BETWEEN (d.payload ->> 'date')::date - 2 AND (d.payload ->> 'date')::date + 2;
SELECT 'info|sim purchases total=' || count(*) || ' current=' || count(*) FILTER (WHERE is_current) FROM sim.purchases;
ROLLBACK;
