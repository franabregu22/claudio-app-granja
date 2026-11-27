import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { diferenciaFacturaA, editarFacturaA, facturaADesdeLineas, FISCAL_VACIO, fiscalDeGasto, recalcularFacturaA, totalFacturaA, type FiscalForm } from '../../src/target/fiscal';
import { TARGET_RPCS } from '../../src/target/db';
import { estadoPartes, partesInput, PARTE_VACIA, sumaPartes } from '../../src/target/alimento';
import { registrarGasto } from '../../src/target/expenses';

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
  it('Nuevo gasto (owner 2026-11-26): a Factura A is lines (neto + IVA rate), the IVA per rate, the total computed; no invoice number', () => {
    const una = facturaADesdeLineas([{ neto: '1000', alicuota: '21' }], []);
    expect(una).toMatchObject({ tipo: 'INVOICE_A', neto: '1000.00', componentes: [{ tax_kind: 'IVA', alicuota: '21', importe: '210.00' }] });
    expect(totalFacturaA(una)).toBe(1210);
    // two ingredients, two rates, a perception: IVA per rate on the neto of that rate
    const dos = facturaADesdeLineas([{ neto: '659549.15', alicuota: '10.5' }, { neto: '501395.20', alicuota: '21' }, { neto: '', alicuota: '21' }],
      [{ tax_kind: 'IIBB', base: '', alicuota: '', importe: '1000' }, { tax_kind: 'PERCEPTION', base: '', alicuota: '', importe: '' }]);
    expect(dos.neto).toBe('1160944.35');
    expect(dos.componentes).toEqual([
      { tax_kind: 'IVA', base: '', alicuota: '10.5', importe: '69252.66' }, { tax_kind: 'IVA', base: '', alicuota: '21', importe: '105292.99' },
      { tax_kind: 'IIBB', base: '', alicuota: '', importe: '1000' }]);
    expect(totalFacturaA(dos)).toBe(1336490);
    // same rate on two rows: one IVA on their sum
    expect(facturaADesdeLineas([{ neto: '100.10', alicuota: '21' }, { neto: '100.10', alicuota: '21' }], []).componentes).toEqual([{ tax_kind: 'IVA', base: '', alicuota: '21', importe: '42.04' }]);
    expect(totalFacturaA(facturaADesdeLineas([{ neto: '', alicuota: '21' }], []))).toBeNull();
    expect(fiscalDeGasto(dos, 1336490, '2026-11-26')).toMatchObject({ documentType: 'INVOICE_A', netAmount: 1160944.35, totalAmount: 1336490 });
    expect(sumaPartes([{ cat: 'a', kg: '1', monto: '659549.15' }, { cat: 'b', kg: '1', monto: '501395.20' }, { cat: '', kg: '', monto: '' }])).toBe(1160944.35);
    const c = SRC('features/caja/Compras.tsx');
    expect(c).toContain('const totalNum = facturaA ? totalFacturaA(fiscalForm) ?? 0 : Number(total);');
    expect(c).toContain('const fiscalForm = facturaA ? facturaADesdeLineas(lineasA, otrosA) : comprobante.fiscal;');
    expect(c).toContain('conArchivos conNumero={false} total={String(totalNum)} sinImportes />');
    expect(c).toContain('<legend className={etiqueta}>Importe</legend>');
    expect(c).toContain('Importe neto (sin IVA)');
    expect(c).toContain('— calculado</span>');
    expect(SRC('features/production/alimento/Insumos.tsx')).toContain('conIva={facturaA}');
  });
  it('the forms use it: Nuevo gasto and Editar gasto', () => {
    expect(SRC('features/caja/Compras.tsx')).toContain('fiscalDeGasto(fiscalForm, totalNum, fecha)');
    expect(SRC('features/caja/EditarGasto.tsx')).toContain('fiscalDeGasto(comprobante.fiscal, Number(total), fecha)');
  });
});

describe('0138 — una factura con varios insumos', () => {
  it('the RPC is in the allow-list and Alimento → Compras offers the split', () => {
    expect(TARGET_RPCS as readonly string[]).toContain('set_feed_purchase_parts');
    const c = SRC('features/production/alimento/Compras.tsx');
    expect(c).toContain("import { KgModal } from './Insumos';");
    expect(c).toMatch(/key=\{clave\(c\)\}/);   // one row per ingredient
    const i = SRC('features/production/alimento/Insumos.tsx');
    expect(i).toContain('Esta factura trae varios insumos');
    expect(i).toContain('m.parts.mutateAsync');
  });
});

describe('Insumos desde Caja (owner 2026-11-26): una factura con varios insumos sigue siendo un gasto', () => {
  const P = (cat: string, kg: string, monto: string) => ({ cat, kg, monto });
  it('the rows add up to the cost basis to the cent, two or more, each ingredient once', () => {
    expect(estadoPartes([P('maiz', '1000', '600'), P('soja', '500', '400')], 1000)).toEqual({ resta: 0, repetida: false, ok: true });
    // owner 2026-11-26: up to $1 of difference is accepted and adjusted in the last ingredient (the backend gets the exact sum)
    expect(estadoPartes([P('maiz', '1000', '600'), P('soja', '500', '399.01')], 1000)).toMatchObject({ resta: 99, ok: true });
    expect(estadoPartes([P('maiz', '1000', '600'), P('soja', '500', '401')], 1000)).toMatchObject({ resta: -100, ok: true });
    expect(estadoPartes([P('maiz', '1000', '600'), P('soja', '500', '398.99')], 1000)).toMatchObject({ resta: 101, ok: false });
    expect(estadoPartes([P('maiz', '1000', '600'), P('soja', '500', '401.01')], 1000)).toMatchObject({ resta: -101, ok: false });
    expect(estadoPartes([P('maiz', '1000', '1000.50'), P('soja', '500', '0')], 1000).ok).toBe(false);   // the last one would go negative
    expect(partesInput([P('maiz', '1000', '600'), P('soja', '500', '399.01')], 1000)).toEqual([
      { categoryId: 'maiz', kg: 1000, amount: 600 }, { categoryId: 'soja', kg: 500, amount: 400 }]);
    expect(partesInput([P('maiz', '1000', '600.10'), P('soja', '500', '400.60')], 1000).map((x) => x.amount)).toEqual([600.1, 399.9]);
    expect(estadoPartes([P('maiz', '1000', '600'), P('maiz', '500', '400')], 1000)).toMatchObject({ repetida: true, ok: false });
    expect(estadoPartes([P('maiz', '1000', '1000')], 1000).ok).toBe(false);
    expect(estadoPartes([P('maiz', '0', '600'), P('soja', '500', '400')], 1000).ok).toBe(false);
    expect(estadoPartes([P('maiz', '1000', '600'), { ...PARTE_VACIA }], 1000).ok).toBe(false);
    expect(estadoPartes([P('maiz', '1000', '2073016.53'), P('soja', '1', '0.01')], 2073016.54).ok).toBe(true);   // float-safe
    expect(partesInput([P('maiz', '1000.5', '600.25'), P('soja', '1', '0')], 600.25)).toEqual([{ categoryId: 'maiz', kg: 1000.5, amount: 600.25 }, { categoryId: 'soja', kg: 1, amount: 0 }]);
  });
  it('Nuevo gasto: feed ingredients only, ADMIN only; the split / kg saved on the purchase after it is registered', () => {
    const i = SRC('features/production/alimento/Insumos.tsx');
    // shown from the CATEGORY of the ingredients, before any subcategory (owner 2026-11-26)
    expect(i).toContain("? lista.some((c) => c.id === categoriaId && !!c.feed_ingredient_id)");
    expect(i).toContain(": grupoId !== '' && lista.some((c) => c.group_id === grupoId && !!c.feed_ingredient_id));");
    expect(SRC('features/caja/Compras.tsx')).toContain('const insumos = useInsumosDelGasto(categoriaId, grupoActual);');
    expect(SRC('features/caja/SelectorCategoria.tsx')).toContain("onGrupo?.(e.target.value); onSubcategoria('');");
    const c = SRC('features/caja/Compras.tsx');
    expect(c).toContain('if (purchaseId) await insumos.guardar(purchaseId, insumosForm, baseInsumos);');
    expect(c).toContain('{insumos.activo && <BloqueInsumosGasto');
    expect(c).toContain('const baseInsumos = facturaA ? (variosInsumos ? sumaPartes(insumosForm.partes) : fiscalDatos ? fiscalDatos.netAmount : null)');
    // with several ingredients the subcategory above is hidden and follows the first ingredient of the grid
    expect(c).toContain("subcategoriaFija={variosInsumos ? 'Los insumos de la factura, abajo (el gasto queda con el primero).' : undefined}");
    expect(c).toContain('if (primero && primero !== categoriaId) elegirSub(primero);');
    expect(c).toContain('<BloqueInsumosGasto value={insumosForm} onChange={cambiarInsumos}');
    // the optional fields say so
    expect(c).toContain('Proveedor (opcional)');
    expect(c).toContain('Nº de factura (opcional)');
    expect(SRC('features/caja/Etiquetas.tsx')).toContain('Etiqueta (opcional)');
    expect(i).toContain('Kilos comprados (opcional)');
    // every amount says whether it is with or without IVA (owner 2026-11-26)
    expect(c).toContain('Importe total (con IVA: el total de la factura)');
    expect(c).toContain('Neto gravado (sin IVA)');
    expect(i).toContain("{facturaA ? 'Neto (sin IVA)' : 'Importe total'}");
  });
  it('Todas las operaciones: the row shows every ingredient and «⋯» opens the Kilos window', () => {
    const c = SRC('features/caja/TodasLasOperaciones.tsx');
    expect(c).toContain("filasCompra.map((c) => nombreSub.get(c.expense_category_id) ?? c.ingredient_nombre).join(' + ')");
    expect(c).toContain("{celda('categoria', insumos ?? r.subcategory");
    expect(c).toContain("<KgModal filas={panel.filas}");   // owner 2026-11-27: «⋯» menu → Kilos de los insumos
  });
  it('an expense without supplier paid from cash / bank returns its purchase id too (the kg are set on it)', async () => {
    const calls: string[] = [];
    const client = { rpc: async (fn: string) => { calls.push(fn); return { data: fn === 'register_pending_expense' ? { payable_id: 'P1', purchase_id: 'U1' } : { financial_operation_id: 8 }, error: null }; } };
    const r = await registrarGasto(client as never, { concept: 'Maíz', supplierId: null, amountTotal: 100, fecha: '2026-11-20', categoryId: 'c', nature: 'OPERATING',
      estado: 'PAGADO', medio: 'CASH', accountId: 'a', fechaPago: '2026-11-21', invoiceNumber: null, fiscal: null, cuitEmisor: null, nombreEmisor: null,
      idempotencyKey: 'k', userId: 'u', files: [] } as never, []);
    expect(r).toMatchObject({ purchase_id: 'U1', financial_operation_id: 8 });
    expect(calls[0]).toBe('register_pending_expense');
  });
});

describe('Todas las operaciones — vincular gasto y pago de Mercado Pago (owner 2026-11-25, 0139)', () => {
  it('from either row (the backend candidates, up to $1 apart), the rounding shown, settle_purchase_mp; a banner of what is left', () => {
    const c = SRC('features/caja/TodasLasOperaciones.tsx');
    expect(c).toContain("if (g.status === 'PENDIENTE_VINCULACION_MP') for (const k of g.candidates ?? [])");
    expect(c).toContain('pares={clasificableEnFila(r) ? paresDeSalida(r) : paresDeGasto(r)}');
    expect(c).toContain("{r.row_kind === 'MP_PENDIENTE' ? 'Vincular con salida ›' : 'Vincular con gasto ›'}");
    expect(c).toContain('vincular.mutate({ purchaseId: p.gasto.purchase_id, sourceId: p.salida.source_id, idempotencyKey: clave');
    expect(c).toContain('se suma al costo de este gasto');
    expect(c).toContain('Por revisar:');
    expect(SRC('features/caja/Movimientos.tsx')).toContain("onResolver={() => setPendiente('MP_CLASIFICAR')}");
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

describe('0140 — corte de Mercado Pago (01/12/2026) y saldo inicial de caja por conteo (owner 2026-11-25)', () => {
  it('Resultados says what is not classified (and opens Caja on Pendientes de clasificar); the cash count lives on the cash card', () => {
    const fin = SRC('features/finanzas/FinanzasApp.tsx');
    expect(fin).toContain('no aparecen en este estado de resultados');
    expect(fin).toContain('quedaron cerradas sin detalle (corte)');
    expect(SRC('App.tsx')).toContain("guardarEstado('caja.porResolver', 'MP_CLASIFICAR'); setTab('caja');");
    expect(SRC('features/caja/Movimientos.tsx')).toContain("useEstadoGuardado<PendingFilter | null>('caja.porResolver', null)");
    const conteo = SRC('features/caja/ConteoCaja.tsx');
    expect(conteo).toContain('registerCashOpening(supabase');
    expect(conteo).toContain('fuera del estado de resultados');
    expect(SRC('target/cashOpening.ts')).toContain("export const MP_CORTE = '2026-12-01';");
    expect(TARGET_RPCS as readonly string[]).toEqual(expect.arrayContaining(['register_cash_opening', 'fin_account_balance_on']));
  });
});

describe('0141 — quitar un flete asignado (owner 2026-11-26)', () => {
  it('the RPC and the allocations are allow-listed; the Flete cell opens «Quitar»; Vincular flete explains the split', async () => {
    expect(TARGET_RPCS as readonly string[]).toContain('unallocate_feed_freight');
    const calls: { fn: string; args: unknown }[] = [];
    const client = { rpc: async (fn: string, args: unknown) => { calls.push({ fn, args }); return { data: { released: 60000, remaining: 255000 }, error: null }; } };
    const { unallocateFeedFreight } = await import('../../src/target/alimento');
    await unallocateFeedFreight(client as never, { freightPurchaseId: 'F', purchaseId: 'P', reason: '  monto mal puesto ' });
    expect(calls).toEqual([{ fn: 'unallocate_feed_freight', args: { p_freight_purchase_id: 'F', p_purchase_id: 'P', p_reason: 'monto mal puesto' } }]);
    const c = SRC('features/production/alimento/Compras.tsx');
    expect(c).toContain('onClick={() => setFleteDe(c.purchase_root_id)}');
    expect(c).toContain("reason: motivo.trim() || 'Flete mal asignado'");
    expect(c).toContain('Si el flete trajo varias compras, tildalas todas antes de vincular.');
    expect(c).toContain('del flete sin asignar, para otras compras.');
    expect(SRC('target/db.ts')).toContain("'feed_freight_allocation',");
  });
});

describe('0142 — anular un gasto que espera su movimiento de Mercado Pago (owner 2026-11-26)', () => {
  it('the alert lists the ones with no outflow to link, with «Ver» and «Anular (duplicado)» (annul_expense)', () => {
    const c = SRC('features/caja/TodasLasOperaciones.tsx');
    expect(c).toContain("const sinPar = (gastosMp.data ?? []).filter((g) => g.status === 'PENDIENTE_VINCULACION_MP' && (g.candidates ?? []).length === 0);");
    expect(c).toContain('onClick={() => onFocus(`MP_PENDIENTE:${g.purchase_root_id}`)}');
    expect(c).toContain('Anular (duplicado)');
    expect(c).toContain("anular.mutate({ purchaseId: g.purchase_id, reason: motivo.trim() || 'Duplicado: la salida de Mercado Pago ya se clasificó como gasto', idempotencyKey: clave }");
  });
});

