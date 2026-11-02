/** Lote 3C — Caja → Movimientos: balances as cards (frontend only: same balance source, same account detail); the transfer is its own tab. */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = (f: string) => readFileSync(resolve(__dirname, '../../src', f), 'utf8');
const S = SRC('features/caja/Movimientos.tsx');
const TRF = SRC('features/caja/Transferencias.tsx');

describe('Lote 3C — Saldos de Caja', () => {
  it('accounts are cards in a responsive grid (2 columns on mobile, 4 on desktop) with name, type and the ERP balance', () => {
    expect(S).toMatch(/<div className="grid grid-cols-2 lg:grid-cols-4 gap-3" aria-label="Cuentas">/);
    expect(S).toMatch(/\{x\.nombre\}<\/p>/);
    expect(S).toMatch(/\{TIPO\[x\.account_type\] \?\? x\.account_type\}/);
    expect(S).toMatch(/formatoPesos\(s\.balance\)/);
    expect(S).toMatch(/Sin movimientos/);
  });
  it('the balance source is unchanged (report_balance_period through useLedgerBalances; nothing computed here)', () => {
    expect(S).toMatch(/useLedgerBalances\('ACCOUNT'\)/);
    expect(S).not.toMatch(/reduce\(|\.rpc\(|callRpc/);
  });
  it('a selected card opens its existing movements below the grid; the transfer, its history and the bank tax live in Transferencias', () => {
    expect(S).toMatch(/onClick=\{\(\) => \{ setAbierta\(activa \? null : x\.id\); setPanel\(null\); \}\} aria-expanded=\{activa\}/);
    expect(S.indexOf('aria-label="Cuentas"')).toBeLessThan(S.indexOf('<CuentaDetalle key={c.id}'));
    expect(TRF).toMatch(/Transferir entre cuentas/);
    expect(TRF).toMatch(/<TransferenciaModal onClose=/);
    expect(TRF).toMatch(/<HistorialTransferencias \/>/);
    expect(TRF).toMatch(/<ImpuestoPorPeriodo \/>/);
  });
  it('no pending-classification banner over the balances; the lists stay reachable under Por resolver', () => {
    expect(S).not.toMatch(/TarjetaPendientes|usePendingSummary|from '\.\/PendientesClasificar'/);
    expect(S).toMatch(/<TarjetasPorResolver panel=\{panel\}/);
    expect(SRC('features/caja/PendientesClasificar.tsx')).not.toMatch(/export function TarjetaPendientes/);
  });
});
