/** Caja in five tabs (frontend only): moved, not removed; every existing screen keeps exactly one door and no money rule changes. */
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = (f: string) => readFileSync(resolve(__dirname, '../../src', f), 'utf8');
const app = SRC('features/caja/CajaApp.tsx');
const mov = SRC('features/caja/Movimientos.tsx');
const pr = SRC('features/caja/PorResolver.tsx');
const pagar = SRC('features/caja/SolapaPagar.tsx');
const trf = SRC('features/caja/Transferencias.tsx');

describe('Caja — the five tabs', () => {
  it('exactly five main tabs, Movimientos first and by default', () => {
    const labels = [...app.matchAll(/\{ id: '\w+', label: '([^']+)' \}/g)].map((m) => m[1]);
    expect(labels).toEqual(['Movimientos', 'Transferencias', 'Cuentas a pagar', 'Calendario', 'Extractos']);
    expect(app).toMatch(/useState<Vista>\('movimientos'\)/);
  });
  it('the ADMIN guard comes before any tab and Retiro de socios stays in Más acciones', () => {
    expect(app.indexOf("if (rol !== 'ADMIN')")).toBeLessThan(app.indexOf('<Movimientos />'));
    expect(app).toMatch(/<EventoGestionModal tipo="RETIRO"/);
  });
  it('every old screen has one door: the five tabs, Por resolver or Cuentas corrientes', () => {
    for (const [src, tag] of [
      [app, '<Movimientos />'], [app, '<Transferencias />'], [app, '<SolapaPagar '], [app, '<CalendarioPagos '], [app, '<ExtractosBancarios />'],
      [pr, '<PendientesClasificar />'], [pr, '<GastosSinClasificar '], [pr, '<EntradasSinVincular />'],
      [pagar, '<CuentasAPagar />'], [pagar, '<GastosAPagar '], [pagar, '<Compras />'], [pagar, '<PagosFacturas />'], [pagar, '<Cheques />'],
      [SRC('features/cobros/CobrosApp.tsx'), '<CobrosClientes />'],
    ] as const) expect(src.split(tag).length - 1, tag).toBe(1);
  });
  it('the calendar still reaches the allocation screen and Gastos sin clasificar still reaches the Mercado Pago list', () => {
    expect(app).toMatch(/setSubPagar\('pagosfactura'\); setVista\('pagar'\)/);
    expect(pr).toMatch(/onVerPendientesMp=\{\(\) => onPanel\('pendientes'\)\}/);
  });
  it('the tab badge counts what needs action: unclassified expenses and current Mercado Pago outflows, never optional inflows', () => {
    expect(app).toMatch(/sinClasificar \+ \(mp\.data\?\.PENDING_CURRENT\.count \?\? 0\)/);
    expect(app).not.toMatch(/UNLINKED/);
  });
});

describe('Caja — no money rule moved with the screens', () => {
  it('Movimientos reads balances from report_balance_period, computes nothing and writes nothing', () => {
    expect(mov).toMatch(/useLedgerBalances\('ACCOUNT'\)/);
    for (const s of [mov, pr, pagar, app]) expect(s).not.toMatch(/\.rpc\(|callRpc|\.insert\(|\.update\(|\.delete\(|\.mutate\(|reduce\(/);
  });
  it('declared collections and unpaid obligations have no place in Movimientos', () => {
    expect(mov).not.toMatch(/customerCollections|CobrosClientes|usePayables|GastosAPagar|listCustomerCollections/);
  });
  it('Transferencias keeps its idempotency keys, the Mercado Pago routes and the tax retry', () => {
    expect(trf).toMatch(/`TRF-\$\{crypto\.randomUUID\(\)\}`/);
    expect(trf).toMatch(/`IDC-\$\{crypto\.randomUUID\(\)\}`/);
    expect(trf).toMatch(/confirmarRetiro\.mutate\(movimientoMp/);
    expect(trf).toMatch(/ownTransfer\.mutate\(\{ paymentId: movimientoMp/);
    expect(trf).toMatch(/transferOperationId: operacionId/);
  });
  it('not started here: Registrar desde extracto and the paused payer names', () => {
    const caja = readdirSync(resolve(__dirname, '../../src/features/caja')).filter((f) => f.endsWith('.tsx')).map((f) => SRC(`features/caja/${f}`)).join('\n');
    expect(caja).not.toMatch(/Registrar desde extracto|fin_book_statement_lines|PAYER_NAME/);
  });
  it('the messages point to the new place of each list', () => {
    const m = SRC('target/messages.ts');
    expect(m.split('Caja → Movimientos → Por resolver → Pendientes de clasificar').length - 1).toBe(3);
    expect(m).toContain('Caja → Movimientos → Por resolver → Gastos sin clasificar');
    expect(m).toContain('Caja → Cuentas a pagar → Cheques → Recibir cheque');
  });
});
