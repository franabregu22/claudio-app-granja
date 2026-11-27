import { describe, expect, it } from 'vitest';
import { monthCommitments, withPlanInstalments, type CalendarRow } from '../../src/target/paymentCalendar';
import type { PayableDueRow } from '../../src/target/paymentPlan';

const gasto = (root: string, amount: number): CalendarRow => ({
  item_kind: 'GASTO', item_id: root, purchase_root_id: root, purchase_id: `${root}-v1`, supplier_id: null, supplier_name: null, concept: 'Canon de riego',
  document_number: null, economic_date: '2026-10-10', amount_total: amount, amount, due_date: null, planned_date: null, link_status: 'CONFIRMADO',
  bank_account_name: null, linked_invoice_number: null,
});
const cuota = (root: string, seq: number, n: number, date: string, amount: number): PayableDueRow => ({
  row_key: `ITEM:${root}${seq}`, row_kind: 'CUOTA', obligation_kind: 'GASTO', purchase_root_id: root, purchase_id: `${root}-v1`, item_id: seq, seq, n_items: n,
  due_date: date, planned_date: null, item_amount: amount, amount, supplier_id: null, supplier_name: null, concept: 'Canon de riego', document_number: null,
  economic_date: '2026-10-10', amount_total: null, instrument_id: null, cheque_number: null, bank_account_name: null, link_status: null,
});

describe('payment calendar — plan instalments (owner 2026-11-27)', () => {
  it('a planned expense is shown by its open instalments, each on its date; others stay', () => {
    const rows = [gasto('a', 300), gasto('b', 50)];
    const out = withPlanInstalments(rows, [cuota('a', 2, 3, '2026-12-10', 100), cuota('a', 3, 3, '2027-01-10', 100)]);
    expect(out.map((r) => [r.purchase_root_id, r.due_date, r.amount, r.cuota?.seq ?? null])).toEqual([
      ['b', null, 50, null], ['a', '2026-12-10', 100, 2], ['a', '2027-01-10', 100, 3],
    ]);
    const dic = monthCommitments(out, '2026-12', '2026-11-27');
    expect(dic.enMes.map((r) => r.amount)).toEqual([100]);
    expect(dic.totalSinFecha).toBe(50);
  });
  it('without a plan nothing changes', () => {
    const rows = [gasto('a', 300)];
    expect(withPlanInstalments(rows, [])).toEqual(rows);
  });
});
