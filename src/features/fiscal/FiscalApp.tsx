import { useState } from 'react';
import { useAuth } from '../../auth/useAuth';
import {
  FISCAL_DIRECTIONS, FISCAL_DOCUMENT_TYPES, TAX_KINDS, firstOfMonth, type ComponentInput, type FiscalDirection, type FiscalDocumentType,
  type InstallmentInput, type ObligationRow, type TaxKind,
} from '../../target/fiscal';
import { errorMessage } from '../../target/messages';
import { getTodayDate } from '../../utils/dateUtils';
import { campo, etiqueta, Modal } from '../caja/Modal';
import { useClients, useSuppliers } from '../caja/useTreasury';
import { formatoPesos } from '../pedidos/helpers';
import { useFinancialAccounts } from '../pedidos/useCommercial';
import { useFiscalDocuments, useFiscalMutations, useObligations } from '../feria/useFeriaFiscal';

const TIPO: Record<FiscalDocumentType, string> = {
  INVOICE_A: 'Factura A', INVOICE_B: 'Factura B', INVOICE_C: 'Factura C', CREDIT_NOTE: 'Nota de crédito', DEBIT_NOTE: 'Nota de débito', RECEIPT: 'Recibo', OTHER: 'Otro',
};
const DIRECCION: Record<FiscalDirection, string> = { DEBITO: 'Débito fiscal (venta)', CREDITO: 'Crédito fiscal (compra)' };
const ESTADO: Record<ObligationRow['status'], string> = { PENDING: 'Pendiente', PARTIALLY_PAID: 'Pago parcial', PAID: 'Pagada', CANCELLED: 'Anulada' };

/**
 * Fiscal (F27-F, ADMIN). Records fiscal documents with their tax components, tax obligations (optionally in
 * installments) and obligation payments, through the fiscal RPCs only. The target does not issue documents to
 * AFIP / ARCA: nothing here contacts an external fiscal service. Periods, duplicates, installment totals,
 * overpayment and statuses are the backend's rules.
 */
export function FiscalApp() {
  const { rol } = useAuth();
  const docs = useFiscalDocuments();
  const obligaciones = useObligations();
  const [modal, setModal] = useState<'documento' | 'obligacion' | ObligationRow | null>(null);

  if (rol !== 'ADMIN') {
    return (
      <div className="min-h-screen bg-stone-100 flex items-center justify-center">
        <div className="bg-white p-8 rounded-lg text-center max-w-sm mx-4">
          <p className="text-lg font-semibold text-gray-800">Acceso restringido</p>
          <p className="text-gray-600 mt-2">Solo un administrador puede gestionar la información fiscal.</p>
        </div>
      </div>
    );
  }
  const error = docs.error ?? obligaciones.error;

  return (
    <div className="min-h-screen bg-[#FAF6EE] px-4 md:px-6 pt-6 pb-20 space-y-6">
      <div>
        <p className="text-xs font-semibold tracking-wide text-[#A8552E] uppercase">Granja Santo Tomás</p>
        <h1 className="text-2xl font-bold text-[#2C2419] mt-1">Fiscal</h1>
        <p className="text-xs text-[#8A7A5C] mt-1">Registro de comprobantes e impuestos. La aplicación no emite comprobantes ante AFIP / ARCA.</p>
      </div>
      {error ? <div className="bg-red-100 border border-red-300 text-red-800 px-3 py-2 rounded text-sm">{errorMessage(error)}</div> : null}

      <section>
        <div className="flex items-center justify-between mb-2">
          <p className="text-xs font-semibold text-[#8A6A2E] uppercase tracking-wide">Obligaciones</p>
          <button onClick={() => setModal('obligacion')} className="text-sm px-3 py-1.5 bg-amber-600 text-white rounded-lg hover:bg-amber-700">Registrar obligación</button>
        </div>
        {(obligaciones.data ?? []).length === 0 ? <p className="text-sm text-[#8A7A5C]">Sin obligaciones.</p> : (
          <div className="space-y-2">
            {(obligaciones.data ?? []).map((o) => (
              <div key={o.id} className="bg-white rounded-lg border border-[#E4DCC8] p-3 text-sm flex items-center justify-between gap-2">
                <span>
                  <b className="text-amber-900">{o.tax_kind}</b> · período {o.fiscal_period.slice(0, 7)} · {formatoPesos(o.amount)}
                  {o.due_date && <> · vence {o.due_date}</>}
                  {o.installments.length > 0 && <span className="text-[#8A7A5C]"> · {o.installments.length} cuotas</span>}
                </span>
                <span className="flex items-center gap-2">
                  <span className="text-xs px-2 py-0.5 rounded bg-stone-100">{ESTADO[o.status]}</span>
                  {(o.status === 'PENDING' || o.status === 'PARTIALLY_PAID') && (
                    <button onClick={() => setModal(o)} className="text-xs px-2 py-1 rounded bg-amber-100 text-amber-900 hover:bg-amber-200">Pagar</button>
                  )}
                </span>
              </div>
            ))}
          </div>
        )}
      </section>

      <section>
        <div className="flex items-center justify-between mb-2">
          <p className="text-xs font-semibold text-[#8A6A2E] uppercase tracking-wide">Comprobantes</p>
          <button onClick={() => setModal('documento')} className="text-sm px-3 py-1.5 bg-amber-600 text-white rounded-lg hover:bg-amber-700">Registrar comprobante</button>
        </div>
        {(docs.data ?? []).length === 0 ? <p className="text-sm text-[#8A7A5C]">Sin comprobantes.</p> : (
          <div className="bg-white rounded-lg border border-amber-200 overflow-x-auto">
            <table className="w-full text-xs md:text-sm">
              <thead className="bg-amber-50 border-b border-amber-200 text-amber-900">
                <tr><th className="px-3 py-2 text-left">Fecha</th><th className="px-3 py-2 text-left">Tipo</th><th className="px-3 py-2 text-left">Número</th>
                  <th className="px-3 py-2 text-left">Contraparte</th><th className="px-3 py-2 text-right">Neto</th><th className="px-3 py-2 text-right">Total</th></tr>
              </thead>
              <tbody>
                {(docs.data ?? []).map((d) => (
                  <tr key={d.id} className="border-b border-amber-100">
                    <td className="px-3 py-2">{d.document_date}</td>
                    <td className="px-3 py-2">{TIPO[d.document_type]} · {d.direction === 'DEBITO' ? 'Débito' : 'Crédito'}</td>
                    <td className="px-3 py-2">{d.external_number ?? '—'}</td>
                    <td className="px-3 py-2">{d.contraparte ?? '—'}</td>
                    <td className="px-3 py-2 text-right">{formatoPesos(d.net_amount)}</td>
                    <td className="px-3 py-2 text-right font-semibold">{formatoPesos(d.total_amount)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {modal === 'documento' && <DocumentoModal onClose={() => setModal(null)} />}
      {modal === 'obligacion' && <ObligacionModal onClose={() => setModal(null)} />}
      {modal && typeof modal === 'object' && <PagoModal obligacion={modal} onClose={() => setModal(null)} />}
    </div>
  );
}

function DocumentoModal({ onClose }: { onClose: () => void }) {
  const { document: registrarDoc } = useFiscalMutations();
  const proveedores = useSuppliers();
  const clientes = useClients();
  const [tipo, setTipo] = useState<FiscalDocumentType>('INVOICE_A');
  const [direccion, setDireccion] = useState<FiscalDirection>('CREDITO');
  const [fecha, setFecha] = useState(getTodayDate());
  const [periodo, setPeriodo] = useState(getTodayDate().slice(0, 7));
  const [contraparteId, setContraparteId] = useState('');
  const [numero, setNumero] = useState('');
  const [neto, setNeto] = useState('');
  const [total, setTotal] = useState('');
  const [componentes, setComponentes] = useState<ComponentInput[]>([]);
  const setComp = (i: number, patch: Partial<ComponentInput>) => setComponentes((cs) => cs.map((c, j) => (j === i ? { ...c, ...patch } : c)));
  const lista = direccion === 'CREDITO' ? proveedores.data ?? [] : clientes.data ?? [];
  const puede = fecha !== '' && periodo !== '' && contraparteId !== '' && neto !== '' && Number(total) > 0;

  return (
    <Modal titulo="Registrar comprobante fiscal" onClose={onClose} puedeGuardar={puede} guardando={registrarDoc.isPending}
      error={registrarDoc.error ?? proveedores.error ?? clientes.error} textoGuardar="Registrar"
      onSubmit={() => registrarDoc.mutate({
        type: tipo, direction: direccion, date: fecha, fiscalPeriod: firstOfMonth(`${periodo}-01`), netAmount: Number(neto), totalAmount: Number(total),
        components: componentes.map((c) => ({ ...c, direction: direccion })),
        supplierId: direccion === 'CREDITO' ? contraparteId : null, clienteId: direccion === 'DEBITO' ? contraparteId : null, externalNumber: numero,
      }, { onSuccess: onClose })}>
      <div className="grid grid-cols-2 gap-2">
        <label className={etiqueta}>Tipo
          <select value={tipo} onChange={(e) => setTipo(e.target.value as FiscalDocumentType)} className={campo}>
            {FISCAL_DOCUMENT_TYPES.map((t) => <option key={t} value={t}>{TIPO[t]}</option>)}
          </select>
        </label>
        <label className={etiqueta}>Dirección
          <select value={direccion} onChange={(e) => { setDireccion(e.target.value as FiscalDirection); setContraparteId(''); }} className={campo}>
            {FISCAL_DIRECTIONS.map((d) => <option key={d} value={d}>{DIRECCION[d]}</option>)}
          </select>
        </label>
      </div>
      <label className={etiqueta}>{direccion === 'CREDITO' ? 'Proveedor' : 'Cliente'}
        <select value={contraparteId} onChange={(e) => setContraparteId(e.target.value)} className={campo}>
          <option value="">Elegir…</option>
          {lista.map((x) => <option key={x.id} value={x.id}>{x.nombre}</option>)}
        </select>
      </label>
      <div className="grid grid-cols-2 gap-2">
        <label className={etiqueta}>Fecha<input type="date" value={fecha} onChange={(e) => setFecha(e.target.value)} className={campo} /></label>
        <label className={etiqueta}>Período fiscal<input type="month" value={periodo} onChange={(e) => setPeriodo(e.target.value)} className={campo} /></label>
      </div>
      <label className={etiqueta}>Número (opcional)<input type="text" value={numero} onChange={(e) => setNumero(e.target.value)} className={campo} /></label>
      <div className="grid grid-cols-2 gap-2">
        <label className={etiqueta}>Neto<input type="number" min="0" step="0.01" value={neto} onChange={(e) => setNeto(e.target.value)} className={campo} /></label>
        <label className={etiqueta}>Total<input type="number" min="0" step="0.01" value={total} onChange={(e) => setTotal(e.target.value)} className={campo} /></label>
      </div>
      <div>
        <div className="flex items-center justify-between">
          <p className={etiqueta}>Impuestos del comprobante</p>
          <button type="button" onClick={() => setComponentes((cs) => [...cs, { tax_kind: 'IVA', direction: direccion, base_amount: 0, rate_applied: 21, tax_amount: 0 }])}
            className="text-xs text-[#A8552E] hover:underline">+ Agregar impuesto</button>
        </div>
        {componentes.map((c, i) => (
          <div key={i} className="grid grid-cols-4 gap-2 mt-2 items-end">
            <select value={c.tax_kind} onChange={(e) => setComp(i, { tax_kind: e.target.value as TaxKind })} className={campo}>
              {TAX_KINDS.map((k) => <option key={k} value={k}>{k}</option>)}
            </select>
            <label className="text-xs text-gray-600">Base<input type="number" min="0" step="0.01" value={c.base_amount} onChange={(e) => setComp(i, { base_amount: Number(e.target.value) })} className={campo} /></label>
            <label className="text-xs text-gray-600">Alícuota %<input type="number" min="0" step="0.01" value={c.rate_applied} onChange={(e) => setComp(i, { rate_applied: Number(e.target.value) })} className={campo} /></label>
            <label className="text-xs text-gray-600">Impuesto<input type="number" min="0" step="0.01" value={c.tax_amount} onChange={(e) => setComp(i, { tax_amount: Number(e.target.value) })} className={campo} /></label>
          </div>
        ))}
        <p className="text-xs text-gray-500 mt-1">Cargá el impuesto tal como figura en el comprobante.</p>
      </div>
    </Modal>
  );
}

function ObligacionModal({ onClose }: { onClose: () => void }) {
  const { obligation } = useFiscalMutations();
  const [impuesto, setImpuesto] = useState<TaxKind>('IVA');
  const [periodo, setPeriodo] = useState(getTodayDate().slice(0, 7));
  const [monto, setMonto] = useState('');
  const [vence, setVence] = useState('');
  const [cuotas, setCuotas] = useState<InstallmentInput[]>([]);
  const setCuota = (i: number, patch: Partial<InstallmentInput>) => setCuotas((cs) => cs.map((c, j) => (j === i ? { ...c, ...patch } : c)));
  const puede = periodo !== '' && Number(monto) > 0 && cuotas.every((c) => c.amount > 0 && !!c.due_date);
  return (
    <Modal titulo="Registrar obligación fiscal" onClose={onClose} puedeGuardar={puede} guardando={obligation.isPending} error={obligation.error} textoGuardar="Registrar"
      onSubmit={() => obligation.mutate({ taxKind: impuesto, fiscalPeriod: firstOfMonth(`${periodo}-01`), amount: Number(monto), dueDate: vence || null, installments: cuotas },
        { onSuccess: onClose })}>
      <div className="grid grid-cols-2 gap-2">
        <label className={etiqueta}>Impuesto
          <select value={impuesto} onChange={(e) => setImpuesto(e.target.value as TaxKind)} className={campo}>
            {TAX_KINDS.map((k) => <option key={k} value={k}>{k}</option>)}
          </select>
        </label>
        <label className={etiqueta}>Período<input type="month" value={periodo} onChange={(e) => setPeriodo(e.target.value)} className={campo} /></label>
      </div>
      <div className="grid grid-cols-2 gap-2">
        <label className={etiqueta}>Monto<input type="number" min="0" step="0.01" value={monto} onChange={(e) => setMonto(e.target.value)} className={campo} /></label>
        <label className={etiqueta}>Vencimiento (opcional)<input type="date" value={vence} onChange={(e) => setVence(e.target.value)} className={campo} /></label>
      </div>
      <div>
        <div className="flex items-center justify-between">
          <p className={etiqueta}>Cuotas (opcional)</p>
          <button type="button" onClick={() => setCuotas((cs) => [...cs, { installment_number: cs.length + 1, amount: 0, due_date: getTodayDate() }])}
            className="text-xs text-[#A8552E] hover:underline">+ Agregar cuota</button>
        </div>
        {cuotas.map((c, i) => (
          <div key={i} className="grid grid-cols-3 gap-2 mt-2 items-end">
            <p className="text-sm text-gray-700 pb-2">Cuota {c.installment_number}</p>
            <label className="text-xs text-gray-600">Monto<input type="number" min="0" step="0.01" value={c.amount} onChange={(e) => setCuota(i, { amount: Number(e.target.value) })} className={campo} /></label>
            <label className="text-xs text-gray-600">Vence<input type="date" value={c.due_date ?? ''} onChange={(e) => setCuota(i, { due_date: e.target.value })} className={campo} /></label>
          </div>
        ))}
        {cuotas.length > 0 && <p className="text-xs text-gray-500 mt-1">Las cuotas deben sumar el monto de la obligación (lo verifica el sistema).</p>}
      </div>
    </Modal>
  );
}

function PagoModal({ obligacion, onClose }: { obligacion: ObligationRow; onClose: () => void }) {
  const { pay } = useFiscalMutations();
  const cuentas = useFinancialAccounts();
  const [monto, setMonto] = useState('');
  const [fecha, setFecha] = useState(getTodayDate());
  const [cuentaId, setCuentaId] = useState('');
  const [cuotaId, setCuotaId] = useState('');
  const [clave] = useState(() => `FISC-${crypto.randomUUID()}`);   // idempotency: one per opened form
  return (
    <Modal titulo={`Pagar ${obligacion.tax_kind} ${obligacion.fiscal_period.slice(0, 7)}`} onClose={onClose}
      puedeGuardar={Number(monto) > 0 && cuentaId !== '' && fecha !== ''} guardando={pay.isPending} error={pay.error ?? cuentas.error} textoGuardar="Registrar pago"
      onSubmit={() => pay.mutate({ obligationId: obligacion.id, date: fecha, amount: Number(monto), accountId: cuentaId, idempotencyKey: clave, installmentId: cuotaId || null },
        { onSuccess: onClose })}>
      <p className="text-sm text-gray-600">Obligación {formatoPesos(obligacion.amount)} · {ESTADO[obligacion.status]}</p>
      {obligacion.installments.length > 0 && (
        <label className={etiqueta}>Cuota (opcional)
          <select value={cuotaId} onChange={(e) => setCuotaId(e.target.value)} className={campo}>
            <option value="">Sin cuota específica</option>
            {obligacion.installments.map((c) => <option key={c.id} value={c.id}>Cuota {c.installment_number} · {formatoPesos(c.amount)}{c.due_date ? ` · vence ${c.due_date}` : ''}</option>)}
          </select>
        </label>
      )}
      <label className={etiqueta}>Monto<input type="number" min="0" step="0.01" value={monto} onChange={(e) => setMonto(e.target.value)} className={campo} /></label>
      <label className={etiqueta}>Fecha del pago<input type="date" value={fecha} onChange={(e) => setFecha(e.target.value)} className={campo} /></label>
      <label className={etiqueta}>Cuenta de la que sale el dinero
        <select value={cuentaId} onChange={(e) => setCuentaId(e.target.value)} className={campo}>
          <option value="">Elegir cuenta…</option>
          {(cuentas.data ?? []).map((a) => <option key={a.id} value={a.id}>{a.nombre}</option>)}
        </select>
      </label>
    </Modal>
  );
}
