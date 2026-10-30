/** Lote 3C — Caja → Saldos as cards (frontend only: same balance source, same account detail, same transfer). */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = (f: string) => readFileSync(resolve(__dirname, '../../src', f), 'utf8');
const S = SRC('features/caja/ResumenSaldos.tsx');

describe('Lote 3C — Saldos de Caja', () => {
  it('accounts are cards in a responsive grid (1 column on mobile, 2 on desktop) with name, type and the ERP balance', () => {
    expect(S).toMatch(/<div className="grid grid-cols-1 sm:grid-cols-2 gap-3" aria-label="Cuentas">/);
    expect(S).toMatch(/\{x\.nombre\}<\/p>/);
    expect(S).toMatch(/\{TIPO\[x\.account_type\] \?\? x\.account_type\}/);
    expect(S).toMatch(/formatoPesos\(s\.balance\)/);
    expect(S).toMatch(/Sin movimientos/);
  });
  it('the balance source is unchanged (report_balance_period through useLedgerBalances; nothing computed here)', () => {
    expect(S).toMatch(/useLedgerBalances\('ACCOUNT'\)/);
    expect(S).not.toMatch(/reduce\(|\.rpc\(|callRpc/);
  });
  it('a selected card opens its existing movements below the grid; the transfer, its history and the bank tax stay', () => {
    expect(S).toMatch(/onClick=\{\(\) => setAbierta\(activa \? null : x\.id\)\} aria-expanded=\{activa\}/);
    expect(S.indexOf('aria-label="Cuentas"')).toBeLessThan(S.indexOf('<CuentaDetalle key={c.id}'));
    expect(S).toMatch(/Transferir entre cuentas/);
    expect(S).toMatch(/<TransferenciaModal onClose=/);
    expect(S).toMatch(/<HistorialTransferencias \/>/);
    expect(S).toMatch(/<ImpuestoPorPeriodo \/>/);
  });
  it('no pending-classification banner on Saldos; the pending stay in their own tabs; the other Caja tabs are kept', () => {
    expect(S).not.toMatch(/TarjetaPendientes|usePendingSummary|from '\.\/PendientesClasificar'/);
    const app = SRC('features/caja/CajaApp.tsx');
    for (const tab of ['Pendientes de clasificar', 'Entradas sin vincular', 'Gastos sin clasificar', 'Cuentas a pagar', 'Calendario de pagos', 'Pagos de facturas'])
      expect(app).toContain(`label: '${tab}'`);
    expect(SRC('features/caja/PendientesClasificar.tsx')).not.toMatch(/export function TarjetaPendientes/);
  });
});
