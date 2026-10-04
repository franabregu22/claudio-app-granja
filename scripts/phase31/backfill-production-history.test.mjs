#!/usr/bin/env node
// Offline tests of the production-history plan builder (no database). Usage: node scripts/phase31/backfill-production-history.test.mjs
import { buildProductionPlan, BATCH } from './backfill-production-history.mjs';
let pass = 0; let fail = 0;
const check = (l, c, d = '') => { if (c) { pass++; console.log(`    OK   ${l}`); } else { fail++; console.log(`    MAL  ${l} :: ${String(d).slice(0, 300)}`); } };
const U = (n) => `c0de0000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const flocks = [
  { id: U(1), galpon: 'Galpón 1', entry: '2025-01-03', exit: null, code: 'G01', legacy_estado: 'Retirado', open_confirmed: true },
  { id: U(2), galpon: 'Galpón 2', entry: '2025-09-04', exit: null, code: 'G02', legacy_estado: 'Activo', open_confirmed: true },
  { id: U(3), galpon: 'Galpón 5', entry: '2025-01-01', exit: '2025-06-30', code: 'G05', legacy_estado: 'Retirado', open_confirmed: false },
];
const p = (id, fecha, galpon, tm, cm, tt, ct) => ({ id: U(100 + id), fecha, galpon, tm, cm, tt, ct });
const { rows, rejects } = buildProductionPlan([
  p(1, '2026-10-02', 'Galpón 2', 1200, 0, 1080, 0),        // mapped: 2280 / 0
  p(2, '2026-10-02', 'Galpón 1', 120, 2, 112, 3),          // mapped: 232 / 5 (override: legacy Retirado, open confirmed)
  p(3, '2026-10-02', 'Galpón 2', 1, 0, 0, 0),              // second row same flock/date
  p(4, '2026-10-02', 'Galpón 9', 1, 0, 0, 0),              // no flock
  p(5, '2026-10-01', 'Galpón 2', 0, 0, null, null),        // no egg data
  p(6, '2026-10-01', 'Galpón 1', -1, 0, 0, 0),             // negative
  p(7, '2025-03-01', 'Galpón 5', 10, 1, 10, 1),            // retired flock inside its dates → mapped
  p(8, '2025-08-01', 'Galpón 5', 10, 0, 0, 0),             // after exit → no flock
], flocks);
check('P1 totals = mediodía + tarde; broken = cachados; dirty = 0', rows[0].eggs_total === 2280 && rows[0].eggs_broken === 0 && rows[0].eggs_dirty === 0 && rows[1].eggs_total === 232 && rows[1].eggs_broken === 5, JSON.stringify(rows.slice(0, 2)));
check('P2 flock attribution by (galpon, fecha) occupancy incl. owner override and retired flock dates', rows[1].flock_id === U(1) && rows.find((r) => r.source_id === U(107))?.flock_id === U(3));
check('P3 second row for the same flock/date rejected (idempotent key = flock+date)', rejects['second row for the same flock and date']?.[0] === U(103));
check('P4 unattributable rows rejected', rejects['flock attribution = 0']?.length === 2);
check('P5 rows without egg data rejected; negative rejected', rejects['no egg data (all null / 0)']?.[0] === U(105) && rejects['negative or non-integer egg value']?.[0] === U(106));
check('P6 every row carries lineage reason with the source id and the batch', rows.every((r) => r.reason === `legacy:producciones:${r.source_id} ${BATCH}`));
check('P7 no mortality field is carried into the plan', rows.every((r) => !('mortandad' in r) && !('deaths' in r)));
console.log(`\n  ${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
