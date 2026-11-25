import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { diferenciaFacturaA, editarFacturaA, FISCAL_VACIO, fiscalDeGasto, recalcularFacturaA, type FiscalForm } from '../../src/target/fiscal';
import { TARGET_RPCS } from '../../src/target/db';

const SRC = (p: string) => readFileSync(resolve(__dirname, '../../src', p), 'utf8');
const A = (p: Partial<FiscalForm>): FiscalForm => ({ ...FISCAL_VACIO, tipo: 'INVOICE_A', componentes: [{ tax_kind: 'IVA', base: '', alicuota: '21', importe: '' }], ...p });

describe('Factura del gasto (owner 2026-11-25): Factura A con neto + impuestos = total', () => {
  it('sin factura: nothing fiscal', () => {
    expect(fiscalDeGasto(FISCAL_VACIO, 1210, '2026-11-24')).toBeNull();
  });
  it('Factura A that adds up: the neto and the IVA as printed, base = amount × 100 / rate', () => {
    const f = A({ neto: '2073016.53', componentes: [{ tax_kind: 'IVA', base: '', alicuota: '21', importe: '435333.47' }] });
    expect(diferenciaFacturaA(f, 2508350)).toBe(0);
    expect(fiscalDeGasto(f, 2508350, '2026-11-24')).toEqual({
      documentType: 'INVOICE_A', fiscalPeriod: '2026-11-01', netAmount: 2073016.53, totalAmount: 2508350,
      components: [{ tax_kind: 'IVA', base_amount: 2073016.52, rate_applied: 21, tax_amount: 435333.47 }],
    });
  });
  it('two IVA rates and a perception (base / rate 0, like the WhatsApp bot)', () => {
    const f = A({ neto: '1000', periodo: '2026-10', componentes: [
      { tax_kind: 'IVA', base: '', alicuota: '21', importe: '105' }, { tax_kind: 'IVA', base: '', alicuota: '10.5', importe: '52.5' },
      { tax_kind: 'PERCEPTION', base: '', alicuota: '', importe: '30' }] });
    const r = fiscalDeGasto(f, 1187.5, '2026-11-24');
    expect(r?.fiscalPeriod).toBe('2026-10-01');
    expect(r?.components).toEqual([
      { tax_kind: 'IVA', base_amount: 500, rate_applied: 21, tax_amount: 105 }, { tax_kind: 'IVA', base_amount: 500, rate_applied: 10.5, tax_amount: 52.5 },
      { tax_kind: 'PERCEPTION', base_amount: 0, rate_applied: 0, tax_amount: 30 }]);
  });
  it('a Factura A that does not add up is not accepted (the difference in cents)', () => {
    const f = A({ neto: '1000', componentes: [{ tax_kind: 'IVA', base: '', alicuota: '21', importe: '200' }] });
    expect(diferenciaFacturaA(f, 1210)).toBe(1000);
    expect(fiscalDeGasto(f, 1210, '2026-11-24')).toBeNull();
    expect(diferenciaFacturaA(A({ neto: '' }), 1210)).toBeNull();
  });
  it('another document: neto = total, no taxes', () => {
    expect(fiscalDeGasto({ ...FISCAL_VACIO, tipo: 'INVOICE_C' }, 500, '2026-11-24'))
      .toEqual({ documentType: 'INVOICE_C', fiscalPeriod: '2026-11-01', netAmount: 500, totalAmount: 500, components: [] });
  });
  it('autocompletion (owner 2026-11-25): the neto fills the IVA, the IVA fills the neto, from the total', () => {
    const conNeto = editarFacturaA(A({}), 1210, 'NETO', '1000');
    expect([conNeto.auto, conNeto.componentes[0].importe]).toEqual(['IVA', '210.00']);
    expect(fiscalDeGasto(conNeto, 1210, '2026-11-24')?.netAmount).toBe(1000);
    const conIva = editarFacturaA(A({}), 1210, 0, '210');
    expect([conIva.auto, conIva.neto]).toEqual(['NETO', '1000.00']);
    // a perception: the computed neto discounts it; a new total recomputes it
    const conPerc = editarFacturaA({ ...conIva, componentes: [...conIva.componentes, { tax_kind: 'PERCEPTION', base: '', alicuota: '', importe: '' }] }, 1240, 1, '30');
    expect(conPerc.neto).toBe('1000.00');
    expect(recalcularFacturaA(conPerc, 1250).neto).toBe('1010.00');
    // typing the computed field makes it manual (nothing recomputed any more)
    const manual = editarFacturaA(conNeto, 1210, 0, '200');
    expect([manual.auto, manual.neto, diferenciaFacturaA(manual, 1210)]).toEqual([undefined, '1000', 1000]);
    // the fiscal period is always the month of the invoice date (no field)
    expect(SRC('features/caja/Compras.tsx')).not.toContain('Período fiscal');
  });
  it('the forms use it: Nuevo gasto and Editar gasto', () => {
    expect(SRC('features/caja/Compras.tsx')).toContain('fiscalDeGasto(comprobante.fiscal, Number(total), fecha)');
    expect(SRC('features/caja/EditarGasto.tsx')).toContain('fiscalDeGasto(comprobante.fiscal, Number(total), fecha)');
  });
});

describe('0138 — una factura con varios insumos', () => {
  it('the RPC is in the allow-list and Alimento → Compras offers the split', () => {
    expect(TARGET_RPCS as readonly string[]).toContain('set_feed_purchase_parts');
    const c = SRC('features/production/alimento/Compras.tsx');
    expect(c).toContain('Esta factura trae varios insumos');
    expect(c).toContain('m.parts.mutateAsync');
    expect(c).toMatch(/key=\{clave\(c\)\}/);   // one row per ingredient
  });
});

describe('Todas las operaciones — sugerencia de vinculación (owner 2026-11-25)', () => {
  it('an unclassified Mercado Pago outflow offers the pending MP expense of its amount (backend candidates) and links it with settle_purchase_mp', () => {
    const c = SRC('features/caja/TodasLasOperaciones.tsx');
    expect(c).toContain("if (g.status === 'PENDIENTE_VINCULACION_MP') for (const k of g.candidates ?? [])");
    expect(c).toContain('sugeridos={clasificableEnFila(r) && r.mp_source_id ? sugeridos.get(r.mp_source_id) : undefined}');
    expect(c).toContain('Vincular con gasto ›');
    expect(c).toContain("vincular.mutate({ purchaseId: elegido, sourceId: r.mp_source_id!, idempotencyKey: clave");
  });
});

describe('Todas las operaciones — importe de una fila pendiente (owner 2026-11-25)', () => {
  it('shows what is left and, under it, the amount recorded; an invoice covered with cheques is «En cheques · por debitar»', () => {
    const c = SRC('features/caja/TodasLasOperaciones.tsx');
    expect(c).toContain('de {formatoPesos(r.pendiente.total)} cargado');
    expect(c).toContain('En cheques · por debitar');
    expect(c).toContain('(r.pendiente as PendienteFactura).cheques_por_debitar > 0 && (r.pendiente as PendienteFactura).sin_cubrir <= 0.005');
  });
});

describe('Todas las operaciones — débito de cheque (owner 2026-11-25)', () => {
  it('the bank debit of an own cheque named after the expense it paid says «Cheque debitado»', () => {
    const c = SRC('features/caja/TodasLasOperaciones.tsx');
    expect(c).toContain("r.row_kind === 'OP' && r.detalle === 'Cheque debitado' && !/^(Cheque|eCheq) /.test(r.concepto)");
    expect(c).toContain('{chequeDebitado(r) && <span');
  });
});

describe('Cheques — repartir al centavo (owner 2026-11-25)', () => {
  it('the three cheque forms split the total exactly (the cents left over in the last cheque)', () => {
    for (const f of ['features/caja/EditorPlanPago.tsx', 'features/caja/PagosFacturas.tsx', 'features/caja/PendientesPagar.tsx']) expect(SRC(f)).toContain('repartirEnCuotas(');
  });
});
