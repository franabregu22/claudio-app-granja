/** 0123 (caja-mejoras-v2): Cartera de cheques on real data — in from Cuentas corrientes, out by deposit / credit or endorsement against a due item. */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = (f: string) => readFileSync(resolve(__dirname, '../../src', f), 'utf8');

describe('Cartera de cheques (0123)', () => {
  it('is a Caja tab on real data; the prototypes are gone', () => {
    const app = SRC('features/caja/CajaApp.tsx');
    expect(app).toContain("{vista === 'cartera' && <CarteraCheques />}");
    expect(app).not.toMatch(/semillaDemo|Demo/);
    for (const f of ['CuentasAPagarDemo.tsx', 'CarteraChequesDemo.tsx', 'pagarDemo.ts', 'flujoDemo.ts'])
      expect(existsSync(resolve(__dirname, '../../src/features/caja', f)), f).toBe(false);
  });
  it('in portfolio: deposit (existing action) or endorse against ONE due item of a supplier; deposited: credited / rejected', () => {
    const c = SRC('features/caja/CarteraCheques.tsx');
    expect(c).toContain("setAccion({ action: 'deposit', inst: x })");
    expect(c).toContain("setAccion({ action: 'clear', inst: x })");
    expect(c).toContain("setAccion({ action: 'reject', inst: x })");
    expect(c).toContain('endorse.mutateAsync({ instrumentId: cheque.id, purchaseId: r.purchase_id!, itemId: r.item_id');
    expect(c).toContain("r.supplier_id && r.obligation_kind === 'FACTURA' && !esChequeFila(r)");   // never a pending expense without supplier
    expect(c).not.toMatch(/\.insert\(|\.update\(|\.delete\(|\.rpc\(/);
    expect(SRC('target/db.ts')).toContain("'endorse_cheque_to_payable'");
  });
  it('client cheques come in from Cuentas corrientes → Registrar cobro → Cheque / eCheq (receive_cheque); no "Recibir cheque" in Caja', () => {
    const cobro = SRC('features/cobros/RegistroPagoModal.tsx');
    expect(cobro).toContain("[['CUENTA', 'Dinero en cuenta'], ['CHEQUE', 'Cheque / eCheq']]");
    expect(cobro).toContain('receiveCheque.mutate({ clienteId: cliente.cliente_id, type: chTipo');
    const cheques = SRC('features/caja/Cheques.tsx');
    expect(cheques).not.toMatch(/Recibir cheque|RecibirChequeModal/);
    expect(SRC('target/messages.ts')).toContain('Cuentas corrientes → Registrar cobro → Cheque / eCheq');
  });
});
