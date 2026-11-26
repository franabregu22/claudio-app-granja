/** Fiscal etapa 1 (owner 2026-11-26): Posición IVA with carry-over, Libro IVA rows, debits / credits tax, the Excel writer. */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { strFromU8, unzipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { debitosCreditosPorMes, desglosarFacturaB, filaLibro, posicionIva, registrarFacturaB, siguienteMes, totalesLibro, type DocumentoLibro } from '../../src/target/fiscalLibro';
import type { FiscalPeriodRow, ObligationRow } from '../../src/target/fiscal';
import { libroXlsx } from '../../src/lib/xlsx';

const P = (period: string, tax_kind: string, debit_amount: number, credit_amount: number, docs = 1): FiscalPeriodRow =>
  ({ period, tax_kind, debit_amount, credit_amount, debit_documents: debit_amount ? docs : 0, credit_documents: credit_amount ? docs : 0, period_difference: debit_amount - credit_amount });

describe('Posición IVA: month by month, the balance in favour carries, perceptions reduce', () => {
  it('a month in favour carries to the next (also across an empty month); perceptions subtract; the IVA obligation of the month', () => {
    const obl: ObligationRow = { id: 'o', tax_kind: 'IVA', fiscal_period: '2026-11-01', amount: 150, due_date: null, status: 'PENDING', installments: [] };
    const m = posicionIva([
      P('2026-08-01', 'IVA', 100, 400), P('2026-10-01', 'IVA', 500, 100), P('2026-10-01', 'PERCEPTION', 0, 30), P('2026-11-01', 'IVA', 300, 120.5),
    ], [obl]);
    expect(m.map((x) => x.period)).toEqual(['2026-08-01', '2026-09-01', '2026-10-01', '2026-11-01']);
    expect(m[0]).toMatchObject({ debito: 100, credito: 400, saldoMes: -300, arrastre: 0, aPagar: 0, aFavor: 300 });
    expect(m[1]).toMatchObject({ saldoMes: 0, arrastre: 300, aPagar: 0, aFavor: 300 });
    expect(m[2]).toMatchObject({ saldoMes: 400, arrastre: 300, percepciones: 30, aPagar: 70, aFavor: 0 });
    expect(m[3]).toMatchObject({ saldoMes: 179.5, arrastre: 0, aPagar: 179.5 });
    expect(m[3].obligacion?.id).toBe('o');
    expect(posicionIva([])).toEqual([]);
    expect(siguienteMes('2026-12-01')).toBe('2027-01-01');
  });
});

const D = (o: Partial<DocumentoLibro>): DocumentoLibro => ({
  id: 'd', document_type: 'INVOICE_A', direction: 'CREDITO', document_date: '2026-11-13', fiscal_period: '2026-11-01', external_number: '0013-00011132',
  net_amount: 1160944.35, total_amount: 1336490, contraparte: 'Biotécnicas', cuit: '30712345678', pedido_id: null,
  componentes: [
    { tax_kind: 'IVA', direction: 'CREDITO', base_amount: 659549.15, rate_applied: 10.5, tax_amount: 69252.66 },
    { tax_kind: 'IVA', direction: 'CREDITO', base_amount: 501395.2, rate_applied: 21, tax_amount: 105292.99 },
    { tax_kind: 'IIBB', direction: 'CREDITO', base_amount: 0, rate_applied: 0, tax_amount: 1000 },
  ], ...o,
});

describe('Libro IVA: one row per document', () => {
  it('IVA by rate, perceptions apart, the CUIT formatted, no warning when complete', () => {
    expect(filaLibro(D({}))).toMatchObject({ tipo: 'Factura A', cuit: '30-71234567-8', neto: 1160944.35, iva21: 105292.99, iva105: 69252.66, iva27: 0, percIibb: 1000, percIva: 0, total: 1336490, avisos: [] });
  });
  it('a credit note subtracts; warnings for a missing number or CUIT', () => {
    const nc = filaLibro(D({ document_type: 'CREDIT_NOTE', net_amount: 100, total_amount: 121, componentes: [{ tax_kind: 'IVA', direction: 'CREDITO', base_amount: 100, rate_applied: 21, tax_amount: 21 }] }));
    expect([nc.neto, nc.iva21, nc.total]).toEqual([-100, -21, -121]);
    expect(filaLibro(D({ external_number: null, cuit: null })).avisos).toEqual(['sin número', 'sin CUIT']);
    const t = totalesLibro([filaLibro(D({})), nc]);
    expect([t.neto, t.iva21, t.total]).toEqual([1160844.35, 105271.99, 1336369]);
  });
});

describe('Débitos y créditos: by month and account', () => {
  it('only that tax, summed by account, newest month first', () => {
    const m = debitosCreditosPorMes([
      { period: '2026-10-01', tax_kind: 'DEBITOS_CREDITOS', account_name: 'BNA', amount_paid: 1200.5, charges: 10 },
      { period: '2026-11-01', tax_kind: 'DEBITOS_CREDITOS', account_name: 'Mercado Pago', amount_paid: 300, charges: 40 },
      { period: '2026-11-01', tax_kind: 'DEBITOS_CREDITOS', account_name: 'BNA', amount_paid: 99.5, charges: 2 },
      { period: '2026-11-01', tax_kind: 'SELLOS', account_name: 'BNA', amount_paid: 50, charges: 1 },
    ]);
    expect(m.map((x) => [x.period, x.total])).toEqual([['2026-11-01', 399.5], ['2026-10-01', 1200.5]]);
    expect(m[0].porCuenta).toEqual([{ cuenta: 'BNA', monto: 99.5, cargos: 2 }, { cuenta: 'Mercado Pago', monto: 300, cargos: 40 }]);
  });
});

describe('Excel writer', () => {
  it('a valid .xlsx: the parts, the sheet names, strings escaped, numbers as numbers, the header bold', () => {
    const z = unzipSync(libroXlsx([{ nombre: 'Compras', filas: [['Fecha', 'Total'], ['13/11/2026 <A&B>', 1336490.5]], anchos: [12, 14] }, { nombre: 'Ventas', filas: [['Fecha']] }]));
    expect(Object.keys(z).sort()).toEqual(['[Content_Types].xml', '_rels/.rels', 'xl/_rels/workbook.xml.rels', 'xl/styles.xml', 'xl/workbook.xml', 'xl/worksheets/sheet1.xml', 'xl/worksheets/sheet2.xml']);
    expect(strFromU8(z['xl/workbook.xml'])).toContain('<sheet name="Compras" sheetId="1" r:id="rId1"/><sheet name="Ventas"');
    const h = strFromU8(z['xl/worksheets/sheet1.xml']);
    expect(h).toContain('<c r="A1" s="1" t="inlineStr"><is><t xml:space="preserve">Fecha</t></is></c>');
    expect(h).toContain('13/11/2026 &lt;A&amp;B&gt;');
    expect(h).toContain('<c r="B2" s="2"><v>1336490.5</v></c>');
  });
});

describe('the screen', () => {
  it('four tabs; Posición IVA opens the month in the Libro; obligations filtered by period', () => {
    const c = readFileSync(resolve(__dirname, '../../src/features/fiscal/FiscalApp.tsx'), 'utf8');
    expect(c).toContain("[['POSICION', 'Posición IVA'], ['FACTURAR', 'Cobros MP a facturar'], ['DEBCRED', 'Débitos y créditos'], ['LIBRO', 'Libro IVA'], ['OBLIGACIONES', 'Obligaciones y pagos']]");
    expect(c).toContain("onVerMes={(p) => { setPeriodoLibro(p); setSolapa('LIBRO'); }}");
    const s = readFileSync(resolve(__dirname, '../../src/features/fiscal/Solapas.tsx'), 'utf8');
    expect(s).toContain("{ nombre: 'Compras',");
    expect(s).toContain('Descargar facturas (ZIP)');
    expect(s).toContain('PyME: se computa el 100 %');
  });
});

describe('0143 — Factura B a consumidor final y cobros de Mercado Pago a facturar (owner 2026-11-26)', () => {
  it('the IVA is included: neto = total ÷ 1,21 to the cent, IVA = the rest', () => {
    expect(desglosarFacturaB(12100)).toEqual({ neto: 10000, iva: 2100 });
    expect(desglosarFacturaB(3046500)).toEqual({ neto: 2517768.6, iva: 528731.4 });
    const r = desglosarFacturaB(1000);
    expect(Math.round((r.neto + r.iva) * 100)).toBe(100000);
  });
  it('registers an INVOICE_B / DEBITO to the client with its IVA component and the ARCA number', async () => {
    const calls: { fn: string; args: Record<string, unknown> }[] = [];
    const client = { rpc: async (fn: string, args: Record<string, unknown>) => { calls.push({ fn, args }); return { data: { fiscal_document_id: 'd1', component_count: 1 }, error: null }; } };
    await registrarFacturaB(client as never, { fecha: '2026-11-30', periodo: '2026-11-01', puntoVenta: '2', numero: '123', total: 12100, clienteId: 'cf' });
    expect(calls[0].fn).toBe('register_fiscal_document');
    expect(calls[0].args).toMatchObject({ p_document_type: 'INVOICE_B', p_direction: 'DEBITO', p_document_date: '2026-11-30', p_fiscal_period: '2026-11-01', p_net_amount: 10000,
      p_total_amount: 12100, p_cliente_id: 'cf', p_external_number: '0002-00000123', p_components: [{ tax_kind: 'IVA', direction: 'DEBITO', base_amount: 10000, rate_applied: 21, tax_amount: 2100 }] });
  });
  it('the screens: the tab, «Facturar el mes», the Factura B form, «Adjuntar PDF», the Ganancias advance in Resultados', () => {
    const s = readFileSync(resolve(__dirname, '../../src/features/fiscal/Solapas.tsx'), 'utf8');
    expect(s).toContain('Facturar el mes');
    expect(s).toContain('Registrar Factura B (consumidor final)');
    expect(s).toContain("{k === 'numero' && libro === 'DEBITO' && <AdjuntarPdf fiscalDocumentId={f.id} />}");
    const f = readFileSync(resolve(__dirname, '../../src/features/finanzas/FinanzasApp.tsx'), 'utf8');
    expect(f).toContain('Anticipo de Ganancias (imp. débitos y créditos)');
  });
});

