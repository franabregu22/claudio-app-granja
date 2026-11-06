import { useState } from 'react';
import { errorMessage } from '../../target/messages';
import { INSTRUMENT_ACTIONS, INSTRUMENT_TYPES, type InstrumentEstado, type InstrumentRow, type InstrumentType } from '../../target/treasury';
import { formatearFechaLocal, getTodayDate } from '../../utils/dateUtils';
import { formatoPesos } from '../pedidos/helpers';
import { useFinancialAccounts } from '../pedidos/useCommercial';
import { campo, etiqueta, Modal } from './Modal';
import { BloqueoMp, useEsCuentaMp } from './MovimientoMp';
import { useAllInstrumentDateChanges, useClients, useInstrumentAction, useInstruments, usePrecutCandidates, useSuppliers, useTreasuryMutations, type InstrumentAction } from './useTreasury';
import { Comprobantes } from './Comprobantes';
import { useDocumentLinks } from './useInvoicePayments';
import { DetalleCorreccionesFecha, EtiquetaFechaCorregida, FechaPagoChequeModal, type ChequeFecha } from './FechaPagoCheque';

export const ESTADO: Record<InstrumentEstado, { texto: string; clase: string }> = {
  RECEIVED: { texto: 'En cartera', clase: 'bg-amber-100 text-amber-900' },
  DEPOSITED: { texto: 'Depositado', clase: 'bg-blue-100 text-blue-800' },
  CLEARED: { texto: 'Acreditado', clase: 'bg-green-100 text-green-800' },
  ENDORSED: { texto: 'Endosado', clase: 'bg-purple-100 text-purple-800' },
  ISSUED: { texto: 'Emitido', clase: 'bg-amber-100 text-amber-900' },
  DEBITED: { texto: 'Debitado', clase: 'bg-green-100 text-green-800' },
  REJECTED: { texto: 'Rechazado', clase: 'bg-red-100 text-red-800' },
  CANCELLED: { texto: 'Anulado', clase: 'bg-stone-200 text-stone-700' },
};
export const ACCION: Record<InstrumentAction, string> = {
  deposit: 'Depositar', clear: 'Acreditar', endorse: 'Endosar', reject: 'Rechazar', debit: 'Marcar debitado', cancel: 'Anular',
};
export const TIPO: Record<InstrumentType, string> = { CHEQUE: 'Cheque', ECHEQ: 'eCheq' };
/** Actions whose contract requires a reason (reject_cheque / reject_supplier_instrument / cancel_supplier_instrument). */
const REQUIERE_MOTIVO: InstrumentAction[] = ['reject', 'cancel'];

/**
 * Cheques y eCheqs (F27-D). State is read from financial_instrument; every transition is its contract RPC
 * (receive / deposit / clear / endorse / reject for received ones; issue / debit / cancel / reject for issued ones).
 * The buttons offered per state mirror the contract (UX only; the RPC re-checks and answers INVALID_STATE).
 */
export function Cheques() {
  const instrumentos = useInstruments();
  const [recibiendo, setRecibiendo] = useState(false);
  const [accion, setAccion] = useState<{ action: InstrumentAction; inst: InstrumentRow } | null>(null);
  const [anteriorCorte, setAnteriorCorte] = useState<InstrumentRow | null>(null);
  const [fechaPago, setFechaPago] = useState<ChequeFecha | null>(null);
  const correcciones = useAllInstrumentDateChanges();   // 0118: corrected payment dates, visible on the row
  const docs = useDocumentLinks('FINANCIAL_INSTRUMENT', (instrumentos.data ?? []).filter((i) => i.direction === 'ISSUED').map((i) => i.id));   // ADR-025 stage 4: cheque PDFs

  if (instrumentos.isLoading) return <p className="text-sm text-gray-500">Cargando cheques...</p>;
  if (instrumentos.error) return <p className="text-sm text-red-700">{errorMessage(instrumentos.error)}</p>;
  const recibidos = (instrumentos.data ?? []).filter((i) => i.direction === 'RECEIVED');
  const emitidos = (instrumentos.data ?? []).filter((i) => i.direction === 'ISSUED');

  // 0115: a cheque debited before the bank cut stays debited (its debit is in the opening balance; a rejection would credit it back)
  const acciones = (i: InstrumentRow) => INSTRUMENT_ACTIONS[i.estado].filter((a) => !(a === 'reject' && i.precut_line_id !== null));
  const fila = (i: InstrumentRow) => (
    <div key={i.id} className="bg-white rounded-lg border border-[#E4DCC8] p-3 text-sm">
      <div className="flex items-center justify-between gap-2">
        <span>
          <span className="font-semibold text-amber-900">{TIPO[i.instrument_type]} {i.cheque_number ?? ''}</span>
          <span className="text-[#8A7A5C]"> · {i.direction === 'RECEIVED' ? i.cliente_nombre : i.supplier_nombre}</span>
          {i.endosado_nombre && <span className="text-[#8A7A5C]"> → {i.endosado_nombre}</span>}
          {i.maturity_date && <span className="text-[#8A7A5C]"> · fecha de pago {formatearFechaLocal(i.maturity_date)}</span>}
          {i.precut_line_id !== null && i.debited_date && (
            <span className="text-[#8A7A5C]"> · debitado {formatearFechaLocal(i.debited_date)}, antes del corte (línea {i.precut_line_id})</span>
          )}
          {docs.data?.get(i.id) && <span className="ml-2"><Comprobantes docs={docs.data.get(i.id)} compacto /></span>}
        </span>
        <span className="flex items-center gap-2">
          <EtiquetaFechaCorregida cambios={correcciones.data?.get(i.id)} />
          <span className="font-bold">{formatoPesos(i.amount)}</span>
          <span className={`text-xs px-2 py-0.5 rounded ${ESTADO[i.estado].clase}`}>{ESTADO[i.estado].texto}</span>
        </span>
      </div>
      <DetalleCorreccionesFecha cambios={correcciones.data?.get(i.id)} />
      {acciones(i).length > 0 && (
        <div className="flex flex-wrap items-center gap-2 mt-2">
          {acciones(i).filter((a) => a !== 'reject').map((a) => (
            <button key={a} onClick={() => setAccion({ action: a, inst: i })}
              className={`text-xs px-2 py-1 rounded ${a === 'cancel' ? 'bg-red-50 text-red-700 hover:bg-red-100' : 'bg-amber-100 text-amber-900 hover:bg-amber-200'}`}>
              {ACCION[a]}
            </button>
          ))}
          {i.direction === 'ISSUED' && i.estado === 'ISSUED' && (
            <button onClick={() => setFechaPago(chequeFecha(i))} className="text-xs px-2 py-1 rounded bg-amber-100 text-amber-900 hover:bg-amber-200">
              Cambiar fecha de pago
            </button>
          )}
          {i.direction === 'ISSUED' && i.estado === 'ISSUED' && (
            <button onClick={() => setAnteriorCorte(i)} className="text-xs px-2 py-1 rounded bg-stone-100 text-stone-800 hover:bg-stone-200">
              Debitado antes del corte
            </button>
          )}
          {acciones(i).includes('reject') && <MasAcciones onRechazar={() => setAccion({ action: 'reject', inst: i })} />}
        </div>
      )}
    </div>
  );

  return (
    <div className="space-y-6">
      <section>
        <div className="flex items-center justify-between mb-2">
          <p className="text-xs font-semibold text-[#8A6A2E] uppercase tracking-wide">Recibidos de clientes</p>
          <button onClick={() => setRecibiendo(true)} className="text-sm px-3 py-1.5 bg-amber-600 text-white rounded-lg hover:bg-amber-700">Recibir cheque</button>
        </div>
        {recibidos.length === 0 ? <p className="text-sm text-[#8A7A5C]">No hay cheques recibidos.</p> : <div className="space-y-2">{recibidos.map(fila)}</div>}
      </section>
      <section>
        <p className="text-xs font-semibold text-[#8A6A2E] uppercase tracking-wide mb-2">Emitidos a proveedores</p>
        <p className="text-xs text-[#8A7A5C] mb-2">Para pagar una factura con uno o varios cheques: Cuentas a pagar → Facturas. Sin factura: Cuentas a pagar → Proveedores → Pagar → Cheque / eCheq.</p>
        {emitidos.length === 0 ? <p className="text-sm text-[#8A7A5C]">No hay cheques emitidos.</p> : <div className="space-y-2">{emitidos.map(fila)}</div>}
      </section>
      {recibiendo && <RecibirChequeModal onClose={() => setRecibiendo(false)} />}
      {accion && <AccionModal action={accion.action} inst={accion.inst} onClose={() => setAccion(null)} />}
      {anteriorCorte && <DebitoAnteriorCorteModal inst={anteriorCorte} onClose={() => setAnteriorCorte(null)} />}
      {fechaPago && <FechaPagoChequeModal cheque={fechaPago} onClose={() => setFechaPago(null)} />}
    </div>
  );
}

/** 0118: an own cheque / eCheq as the payment-date correction needs it. */
export const chequeFecha = (i: InstrumentRow): ChequeFecha => ({
  id: i.id, tipo: TIPO[i.instrument_type], numero: i.cheque_number, amount: i.amount, maturity_date: i.maturity_date, issued_date: i.issued_date,
  destinatario: i.supplier_nombre,
});

/** Secondary cheque actions: "Rechazar" (still the same contract RPC) out of the main row. */
export function MasAcciones({ onRechazar }: { onRechazar: () => void }) {
  return (
    <details className="relative text-xs">
      <summary className="cursor-pointer list-none px-2 py-1 rounded text-[#A8552E] hover:bg-amber-50">Más acciones</summary>
      <div className="absolute left-0 z-10 mt-1 bg-white border border-[#E4DCC8] rounded-lg shadow p-1 w-40">
        <button type="button" onClick={onRechazar} className="w-full text-left px-2 py-1 rounded text-red-700 hover:bg-red-50">{ACCION.reject}</button>
      </div>
    </details>
  );
}

/**
 * 0115: an own cheque the bank debited BEFORE the cut of its account. That debit is already inside the opening balance, so it is
 * marked debited on the date of its statement line without moving any balance. Only the lines the server finds (same account, exact
 * amount, same cheque number, before the anchor, unused) can be chosen; the server re-checks everything.
 */
function DebitoAnteriorCorteModal({ inst, onClose }: { inst: InstrumentRow; onClose: () => void }) {
  const candidatos = usePrecutCandidates(inst.id);
  const { markPrecut } = useTreasuryMutations();
  const [lineaId, setLineaId] = useState<number | null>(null);
  const [notas, setNotas] = useState('');
  const [clave] = useState(() => `PRECUT-${crypto.randomUUID()}`);   // idempotency: one per opened form
  const lista = candidatos.data ?? [];
  const elegida = lista.find((c) => c.statement_line_id === lineaId) ?? (lista.length === 1 ? lista[0] : null);

  return (
    <Modal titulo={`Debitado antes del corte — ${TIPO[inst.instrument_type]} ${inst.cheque_number ?? ''} (${formatoPesos(inst.amount)})`} onClose={onClose}
      puedeGuardar={elegida !== null} guardando={markPrecut.isPending} error={markPrecut.error ?? candidatos.error} textoGuardar="Registrar débito"
      onSubmit={() => elegida && markPrecut.mutate({
        instrumentId: inst.id, statementLineId: elegida.statement_line_id, debitedDate: elegida.value_date, idempotencyKey: clave, reason: notas,
      }, { onSuccess: onClose })}>
      <p className="text-xs text-gray-600">
        Para un cheque que el banco debitó antes del corte de la cuenta: ese débito ya está dentro del saldo inicial.
        Se marca debitado en la fecha del extracto y <b>el saldo de la cuenta no cambia</b>.
      </p>
      {candidatos.isLoading ? <p className="text-sm text-gray-500">Buscando la línea del extracto...</p>
        : lista.length === 0 ? (
          <p className="text-sm text-[#8A7A5C]">
            No hay ninguna línea del extracto anterior al corte con la misma cuenta, el mismo importe y el mismo número de cheque.
            Si el banco lo debitó después del corte, usá "Marcar debitado" y conciliá la línea en Extractos.
          </p>
        ) : (
          <fieldset className="space-y-2" aria-label="Línea del extracto">
            {lista.map((c) => (
              <label key={c.statement_line_id} className="flex items-start gap-2 text-sm bg-stone-50 rounded p-2">
                <input type="radio" name="linea" checked={elegida?.statement_line_id === c.statement_line_id} onChange={() => setLineaId(c.statement_line_id)} />
                <span>
                  <span className="font-semibold">{formatearFechaLocal(c.value_date)}</span> · {c.description_raw}
                  {c.bank_reference && <span className="text-[#8A7A5C]"> · ref. {c.bank_reference}</span>}
                  <span className="block text-[#8A7A5C]">{formatoPesos(-c.signed_amount)} · línea {c.statement_line_id}</span>
                </span>
              </label>
            ))}
          </fieldset>
        )}
      <label className={etiqueta}>Notas (opcional)
        <input type="text" value={notas} onChange={(e) => setNotas(e.target.value)} className={campo} />
      </label>
    </Modal>
  );
}

function RecibirChequeModal({ onClose }: { onClose: () => void }) {
  const clientes = useClients();
  const { receiveCheque } = useTreasuryMutations();
  const [clienteId, setClienteId] = useState('');
  const [tipo, setTipo] = useState<InstrumentType>('CHEQUE');
  const [numero, setNumero] = useState('');
  const [monto, setMonto] = useState('');
  const [vencimiento, setVencimiento] = useState(getTodayDate());
  const [comprobante, setComprobante] = useState('');
  const [notas, setNotas] = useState('');
  const [claveAuto] = useState(() => `CHQ-${crypto.randomUUID()}`);   // idempotency: one per opened form
  const puede = clienteId !== '' && numero.trim() !== '' && Number(monto) > 0 && vencimiento !== '';

  return (
    <Modal titulo="Recibir cheque de cliente" onClose={onClose} puedeGuardar={puede} guardando={receiveCheque.isPending}
      error={receiveCheque.error ?? clientes.error} textoGuardar="Registrar"
      onSubmit={() => receiveCheque.mutate({
        clienteId, type: tipo, chequeNumber: numero.trim(), amount: Number(monto), maturityDate: vencimiento, receivedAt: new Date().toISOString(),
        receiptId: comprobante.trim() || claveAuto, reason: notas,
      }, { onSuccess: onClose })}>
      <label className={etiqueta}>Cliente
        <select value={clienteId} onChange={(e) => setClienteId(e.target.value)} className={campo}>
          <option value="">Elegir cliente…</option>
          {(clientes.data ?? []).map((c) => <option key={c.id} value={c.id}>{c.nombre}</option>)}
        </select>
      </label>
      <div className="grid grid-cols-2 gap-2">
        {INSTRUMENT_TYPES.map((t) => (
          <button key={t} type="button" onClick={() => setTipo(t)}
            className={`px-3 py-2 rounded-lg text-sm font-medium ${tipo === t ? 'bg-amber-600 text-white' : 'bg-stone-100 text-gray-700 hover:bg-stone-200'}`}>
            {TIPO[t]}
          </button>
        ))}
      </div>
      <label className={etiqueta}>Número
        <input type="text" value={numero} onChange={(e) => setNumero(e.target.value)} className={campo} />
      </label>
      <label className={etiqueta}>Monto
        <input type="number" min="0" step="0.01" value={monto} onChange={(e) => setMonto(e.target.value)} className={campo} />
      </label>
      <label className={etiqueta}>Fecha de pago
        <input type="date" value={vencimiento} onChange={(e) => setVencimiento(e.target.value)} className={campo} />
      </label>
      <label className={etiqueta}>Nº de recibo (opcional)
        <input type="text" value={comprobante} onChange={(e) => setComprobante(e.target.value)} className={campo} placeholder="Se genera uno si lo dejás vacío" />
      </label>
      <label className={etiqueta}>Notas (opcional)
        <input type="text" value={notas} onChange={(e) => setNotas(e.target.value)} className={campo} />
      </label>
      <p className="text-xs text-gray-500">El cheque descuenta el saldo del cliente; el dinero entra a una cuenta cuando se acredita.</p>
    </Modal>
  );
}

export function AccionModal({ action, inst, onClose }: { action: InstrumentAction; inst: Pick<InstrumentRow, 'id' | 'direction' | 'instrument_type' | 'cheque_number' | 'amount'>; onClose: () => void }) {
  const mutacion = useInstrumentAction();
  const cuentas = useFinancialAccounts();
  const proveedores = useSuppliers();
  const [fecha, setFecha] = useState(getTodayDate());
  const [motivo, setMotivo] = useState('');
  const [cuentaId, setCuentaId] = useState('');
  const [proveedorId, setProveedorId] = useState('');
  const requiereMotivo = REQUIERE_MOTIVO.includes(action);
  const puede = fecha !== '' && (!requiereMotivo || motivo.trim() !== '')
    && (action !== 'clear' || cuentaId !== '') && (action !== 'endorse' || proveedorId !== '');
  const esMp = useEsCuentaMp(cuentaId) && action === 'clear';   // Meta A (0091): a cheque never clears into Mercado Pago

  return (
    <Modal titulo={`${ACCION[action]} — ${TIPO[inst.instrument_type]} ${inst.cheque_number ?? ''} (${formatoPesos(inst.amount)})`} onClose={onClose}
      puedeGuardar={puede && !esMp} guardando={mutacion.isPending} error={mutacion.error} textoGuardar={ACCION[action]}
      onSubmit={() => mutacion.mutate({
        action, instrumentId: inst.id, direction: inst.direction, date: fecha, reason: motivo, bankAccountId: cuentaId, supplierId: proveedorId,
      }, { onSuccess: onClose })}>
      <label className={etiqueta}>Fecha
        <input type="date" value={fecha} onChange={(e) => setFecha(e.target.value)} className={campo} />
      </label>
      {action === 'clear' && (
        <label className={etiqueta}>Cuenta donde se acredita
          <select value={cuentaId} onChange={(e) => setCuentaId(e.target.value)} className={campo}>
            <option value="">Elegir cuenta…</option>
            {(cuentas.data ?? []).map((a) => <option key={a.id} value={a.id}>{a.nombre}</option>)}
          </select>
        </label>
      )}
      {esMp && <BloqueoMp />}
      {action === 'endorse' && (
        <label className={etiqueta}>Proveedor al que se endosa
          <select value={proveedorId} onChange={(e) => setProveedorId(e.target.value)} className={campo}>
            <option value="">Elegir proveedor…</option>
            {(proveedores.data ?? []).map((p) => <option key={p.id} value={p.id}>{p.nombre}</option>)}
          </select>
        </label>
      )}
      <label className={etiqueta}>{requiereMotivo ? 'Motivo' : 'Notas (opcional)'}
        <input type="text" value={motivo} onChange={(e) => setMotivo(e.target.value)} className={campo} />
      </label>
    </Modal>
  );
}
