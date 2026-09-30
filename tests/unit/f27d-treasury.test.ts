import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  attachmentPath, createPurchaseWithAttachments, MAX_ATTACHMENT_BYTES, PURCHASE_ATTACHMENT_BUCKET, validateAttachments,
} from '../../src/target/attachments';
import { TargetDbError } from '../../src/target/db';
import {
  INSTRUMENT_ACTIONS, SUPPLIER_PAYMENT_METHODS, issueSupplierInstrument, listLedgerBalances, listPnlMonths, paySupplier, receiveCheque,
  rectifyPurchase, transferBetweenAccounts,
} from '../../src/target/treasury';

/** PostgREST-shaped stub recording every read / rpc, answering from a queue. */
function stub(results: { data: unknown; error: unknown }[] = []) {
  const calls: { kind: string; table?: string; fn?: string; args?: unknown; filters?: unknown[] }[] = [];
  const next = () => results.shift() ?? { data: [], error: null };
  const client = {
    from(table: string) {
      const filters: unknown[] = [];
      const q: any = {
        select: () => q, eq: (...a: unknown[]) => { filters.push(['eq', ...a]); return q; }, order: () => q, limit: () => q,
        then: (res: (v: unknown) => void) => { calls.push({ kind: 'select', table, filters }); res(next()); },
      };
      return q;
    },
    rpc: async (fn: string, args: unknown) => { calls.push({ kind: 'rpc', fn, args }); return next(); },
  };
  return { client: client as never, calls };
}

describe('F27-D treasury data layer', () => {
  it('account / supplier balance = the latest closing balance of report_balance_period for that ledger (no recomputation)', async () => {
    const { client, calls } = stub([{ data: [
      { entity_id: 'a1', entity_name: 'Caja', period: '2026-08-01', closing_balance: 900 },
      { entity_id: 'a1', entity_name: 'Caja', period: '2026-09-01', closing_balance: 400 },
      { entity_id: 'a2', entity_name: 'Banco', period: '2026-07-01', closing_balance: -50 },
    ], error: null }]);
    expect(await listLedgerBalances(client, 'ACCOUNT')).toEqual([
      { entity_id: 'a2', entity_name: 'Banco', balance: -50, period: '2026-07-01' },
      { entity_id: 'a1', entity_name: 'Caja', balance: 400, period: '2026-09-01' },
    ]);
    expect(calls[0]).toMatchObject({ table: 'report_balance_period', filters: [['eq', 'ledger', 'ACCOUNT']] });
  });

  it('Tendencia meses reads pnl_summary columns as reported, oldest first', async () => {
    const { client, calls } = stub([{ data: [
      { period: '2026-09-01', ventas_netas_devengadas: 10, resultado_operativo: 2, resultado_post_inversiones: 1 },
      { period: '2026-08-01', ventas_netas_devengadas: 8, resultado_operativo: -1, resultado_post_inversiones: -3 },
    ], error: null }]);
    expect((await listPnlMonths(client)).map((m) => [m.period, m.resultado_operativo])).toEqual([['2026-08-01', -1], ['2026-09-01', 2]]);
    expect(calls[0].table).toBe('pnl_summary');
  });

  it('transfer and supplier payment send exactly the contract arguments (blank reason → null)', async () => {
    const { client, calls } = stub([{ data: {}, error: null }, { data: {}, error: null }]);
    await transferBetweenAccounts(client, { sourceAccountId: 's', destAccountId: 'd', amount: 10, effectiveDate: '2026-09-30', externalRef: 'TRF-1', reason: ' ' });
    await paySupplier(client, { supplierId: 'p', amount: 5, effectiveDate: '2026-09-30', method: 'TRANSFER', accountId: 'a', externalRef: 'PAG-1', reason: 'x' });
    expect(calls).toEqual([
      { kind: 'rpc', fn: 'transfer_between_accounts', args: {
        p_source_account_id: 's', p_dest_account_id: 'd', p_amount: 10, p_effective_date: '2026-09-30', p_external_ref: 'TRF-1', p_reason: null } },
      { kind: 'rpc', fn: 'pay_supplier', args: {
        p_supplier_id: 'p', p_amount: 5, p_effective_date: '2026-09-30', p_payment_method: 'TRANSFER', p_financial_account_id: 'a', p_external_ref: 'PAG-1', p_reason: 'x' } },
    ]);
  });

  it('cheque payments are not a pay_supplier method: they are issued instruments', async () => {
    expect([...SUPPLIER_PAYMENT_METHODS]).toEqual(['CASH', 'TRANSFER', 'MERCADOPAGO']);
    const { client, calls } = stub([{ data: {}, error: null }]);
    await issueSupplierInstrument(client, {
      supplierId: 'p', type: 'ECHEQ', chequeNumber: '1', amount: 3, maturityDate: '2026-10-30', issuedDate: '2026-09-30', bankAccountId: 'b', externalRef: 'EMI-1',
    });
    expect(calls[0]).toMatchObject({ fn: 'issue_supplier_instrument', args: { p_instrument_type: 'ECHEQ', p_bank_account_id: 'b', p_external_ref: 'EMI-1' } });
  });

  it('rectify_purchase sends the contract line fields only (the subtotal is generated)', async () => {
    const { client, calls } = stub([{ data: {}, error: null }]);
    await rectifyPurchase(client, { purchaseId: 'pu', amountNet: 8, amountTotal: 9, reason: 'r', lines: [
      { producto_id: null, feed_ingredient_id: 'fi', descripcion: 'maíz', cantidad: 2, unit_type: 'KG', precio_unitario: 4, subtotal: 8 } as never,
    ] });
    expect(calls[0]).toEqual({ kind: 'rpc', fn: 'rectify_purchase', args: {
      p_purchase_id: 'pu', p_new_amount_net: 8, p_new_amount_total: 9, p_reason: 'r',
      p_new_lines: [{ producto_id: null, feed_ingredient_id: 'fi', descripcion: 'maíz', cantidad: 2, unit_type: 'KG', precio_unitario: 4 }],
    } });
  });

  it('receiving a cheque is receive_cheque with the receipt id as idempotency key', async () => {
    const { client, calls } = stub([{ data: {}, error: null }]);
    await receiveCheque(client, { clienteId: 'c', type: 'CHEQUE', chequeNumber: 'N', amount: 7, maturityDate: '2026-10-01', receivedAt: 'T', receiptId: 'CHQ-1' });
    expect(calls[0]).toMatchObject({ fn: 'receive_cheque', args: { p_cliente_id: 'c', p_receipt_id: 'CHQ-1', p_reason: null } });
  });

  it('the offered lifecycle actions mirror the contract states (0016 / 0018); terminal states offer none', () => {
    expect(INSTRUMENT_ACTIONS.RECEIVED).toEqual(['deposit', 'endorse', 'reject']);
    expect(INSTRUMENT_ACTIONS.DEPOSITED).toEqual(['clear', 'reject']);
    expect(INSTRUMENT_ACTIONS.ISSUED).toEqual(['debit', 'cancel', 'reject']);
    expect(INSTRUMENT_ACTIONS.DEBITED).toEqual(['reject']);
    expect(INSTRUMENT_ACTIONS.REJECTED).toEqual([]);
    expect(INSTRUMENT_ACTIONS.CANCELLED).toEqual([]);
  });
});

/** Storage + RPC stub for the ADR-008 upload → register_purchase sequence. */
function storageStub(o: { uploadFailsAt?: number; rpcError?: unknown; removeFails?: boolean } = {}) {
  const calls: { kind: string; bucket?: string; path?: string; paths?: string[]; fn?: string; args?: any }[] = [];
  let uploads = 0;
  const client = {
    storage: {
      from: (bucket: string) => ({
        upload: async (path: string) => {
          calls.push({ kind: 'upload', bucket, path });
          uploads += 1;
          return uploads === o.uploadFailsAt ? { data: null, error: { message: 'new row violates row-level security policy' } } : { data: { path }, error: null };
        },
        remove: async (paths: string[]) => {
          calls.push({ kind: 'remove', bucket, paths });
          return o.removeFails ? { data: null, error: { message: 'boom' } } : { data: [], error: null };
        },
      }),
    },
    rpc: async (fn: string, args: unknown) => {
      calls.push({ kind: 'rpc', fn, args });
      return o.rpcError ? { data: null, error: o.rpcError } : { data: { purchase_id: 'pu' }, error: null };
    },
  };
  return { client: client as never, calls };
}
const f = (name: string, type = 'application/pdf', size = 10) => ({ name, type, size }) as never;
const PURCHASE = {
  userId: 'u1', supplierId: 's', economicDate: '2026-09-30', amountNet: 1, amountTotal: 1, categoryId: 'c', nature: 'OPERATING' as const,
  lines: [], idempotencyKey: 'CMP-1',
};

describe('ADR-008 purchase attachments: upload → register_purchase with compensation', () => {
  it('validation happens before any request: no file, a disallowed type or an oversized file', async () => {
    for (const files of [[], [f('x.exe', 'application/x-msdownload')], [f('big.pdf', 'application/pdf', MAX_ATTACHMENT_BYTES + 1)]]) {
      const { client, calls } = storageStub();
      await expect(createPurchaseWithAttachments(client, { ...PURCHASE, files })).rejects.toBeInstanceOf(TargetDbError);
      expect(calls).toEqual([]);
    }
    expect(() => validateAttachments([])).toThrow(/ATTACHMENT_REQUIRED/);
  });

  it('the object key is generated (<user>/<uuid>.<ext>); the original name is metadata only', () => {
    expect(attachmentPath('u1', 'image/png', 'abc')).toBe('u1/abc.png');
    expect(attachmentPath('u1', 'application/pdf')).toMatch(/^u1\/[0-9a-f-]{36}\.pdf$/);
  });

  it('success: every file is uploaded to the private bucket first, then register_purchase gets their metadata', async () => {
    const { client, calls } = storageStub();
    await createPurchaseWithAttachments(client, { ...PURCHASE, files: [f('Factura Nº 1.pdf'), f('foto.jpg', 'image/jpeg', 20)] });
    expect(calls.map((c) => c.kind)).toEqual(['upload', 'upload', 'rpc']);
    expect(calls.every((c) => c.kind !== 'upload' || c.bucket === PURCHASE_ATTACHMENT_BUCKET)).toBe(true);
    const rpc = calls[2];
    expect(rpc.fn).toBe('register_purchase');
    expect(rpc.args.p_attachments).toEqual([
      { storage_path: calls[0].path, file_name: 'Factura Nº 1.pdf', content_type: 'application/pdf', byte_size: 10 },
      { storage_path: calls[1].path, file_name: 'foto.jpg', content_type: 'image/jpeg', byte_size: 20 },
    ]);
    expect(calls[0].path).not.toContain('Factura');
  });

  it('an upload failure never calls register_purchase and removes what this attempt already uploaded', async () => {
    const { client, calls } = storageStub({ uploadFailsAt: 2 });
    const err = await createPurchaseWithAttachments(client, { ...PURCHASE, files: [f('a.pdf'), f('b.pdf')] }).catch((e) => e);
    expect(err.code).toBe('ATTACHMENT_UPLOAD_FAILED');
    expect(calls.map((c) => c.kind)).toEqual(['upload', 'upload', 'remove']);
    expect(calls[2].paths).toEqual([calls[0].path]);
  });

  it('a register_purchase failure removes the uploaded objects and surfaces the ORIGINAL purchase error', async () => {
    const { client, calls } = storageStub({ rpcError: { message: 'DUPLICATE_PURCHASE' } });
    const err = await createPurchaseWithAttachments(client, { ...PURCHASE, files: [f('a.pdf')] }).catch((e) => e);
    expect(err.code).toBe('DUPLICATE_PURCHASE');
    expect(calls.map((c) => c.kind)).toEqual(['upload', 'rpc', 'remove']);
    expect(calls[2].paths).toEqual([calls[0].path]);
  });

  it('a failed cleanup is reported (object keys only) and does not hide the original error', async () => {
    const { client } = storageStub({ rpcError: { message: 'SUPPLIER_NOT_FOUND_OR_INACTIVE' }, removeFails: true });
    const reported: string[][] = [];
    const err = await createPurchaseWithAttachments(client, { ...PURCHASE, files: [f('a.pdf')], onCleanupFailure: (p) => reported.push(p) }).catch((e) => e);
    expect(err.code).toBe('SUPPLIER_NOT_FOUND_OR_INACTIVE');
    expect(reported).toHaveLength(1);
    expect(reported[0][0]).toMatch(/^u1\//);
  });

  it('attachments.ts only talks to the private bucket: no public URL, no upsert, no other bucket', () => {
    const text = readFileSync(resolve(__dirname, '../../src/target/attachments.ts'), 'utf8');
    expect(text).not.toMatch(/getPublicUrl|upsert:\s*true/);
    expect([...text.matchAll(/storage\.from\(([^)]*)\)/g)].map((m) => m[1])).toEqual(['PURCHASE_ATTACHMENT_BUCKET']);
  });
});

describe('F27-D migrated files carry no legacy or duplicated authority', () => {
  const SRC = resolve(__dirname, '../../src');
  const FILES = ['target/treasury.ts', 'features/caja/useTreasury.ts', 'features/caja/CajaApp.tsx', 'features/caja/ResumenSaldos.tsx',
    'features/caja/CuentasAPagar.tsx', 'features/caja/Compras.tsx', 'features/caja/Cheques.tsx', 'features/finanzas/TendenciaMeses.tsx', 'features/caja/Modal.tsx'];

  it.each(FILES)('%s: no legacy table / hook, no direct PostgREST call, no balance or cash-flow computation', (f) => {
    const text = readFileSync(resolve(SRC, f), 'utf8');
    for (const n of ['movimientos_caja', 'cheques', 'comisiones', 'facturas', 'arqueos_caja', 'cuentas_caja', 'pagos', 'pago_en_caja',
      'categorias_finanzas', 'account_balance', 'ledger_entry', 'dueño', 'colaborador', 'repartidor']) {
      expect(text).not.toMatch(new RegExp(`['"\`]${n}['"\`]`));
    }
    expect(text).not.toMatch(/(?<!Array)\.from\(/);
    expect(text).not.toMatch(/\.(insert|update|delete|upsert)\(/);
    expect(text).not.toMatch(/hooks\/use(Caja|Arqueos|Categorias|Pagos)\b|api\/(caja|arqueos|categorias|pagos)\b|agregarPagoAlaCaja|sincronizar/);
    expect(text).not.toMatch(/ingresos\s*-\s*egresos|margen|flujo/i);
  });

  it('the legacy Caja authorities are gone; the only legacy remnant is the read-only P&L source for F27-G', () => {
    for (const f of ['api/pagos.ts', 'api/arqueos.ts', 'api/categorias.ts', 'hooks/useArqueos.ts', 'hooks/useCategorias.ts', 'constants/categorias-caja.ts',
      'features/caja/ListaMovimientos.tsx', 'features/caja/FormMovimiento.tsx', 'features/caja/ModalEditarMovimiento.tsx',
      'features/caja/ModalEditarCategoria.tsx', 'features/caja/ResumenFlujoCaja.tsx', 'features/caja/ArqueoCard.tsx', 'features/caja/FormArqueo.tsx',
      'features/caja/HistorialArqueos.tsx']) {
      expect(existsSync(resolve(SRC, f)), f).toBe(false);
    }
    // api/caja.ts stayed as the read-only P&L source after F27-D and was removed in F27-G
    expect(existsSync(resolve(SRC, 'api/caja.ts'))).toBe(false);
  });
});
