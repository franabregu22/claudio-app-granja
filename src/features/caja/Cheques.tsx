import { useState } from 'react';
import { errorMessage } from '../../target/messages';
import { INSTRUMENT_ACTIONS, INSTRUMENT_TYPES, type InstrumentEstado, type InstrumentRow, type InstrumentType } from '../../target/treasury';
import { formatearFechaLocal, getTodayDate } from '../../utils/dateUtils';
import { formatoPesos } from '../pedidos/helpers';
import { useFinancialAccounts } from '../pedidos/useCommercial';
import { campo, etiqueta, Modal } from './Modal';
import { useClients, useInstrumentAction, useInstruments, useSuppliers, useTreasuryMutations, type InstrumentAction } from './useTreasury';

const ESTADO: Record<InstrumentEstado, { texto: string; clase: string }> = {
  RECEIVED: { texto: 'En cartera', clase: 'bg-amber-100 text-amber-900' },
  DEPOSITED: { texto: 'Depositado', clase: 'bg-blue-100 text-blue-800' },
  CLEARED: { texto: 'Acreditado', clase: 'bg-green-100 text-green-800' },
  ENDORSED: { texto: 'Endosado', clase: 'bg-purple-100 text-purple-800' },
  ISSUED: { texto: 'Emitido', clase: 'bg-amber-100 text-amber-900' },
  DEBITED: { texto: 'Debitado', clase: 'bg-green-100 text-green-800' },
  REJECTED: { texto: 'Rechazado', clase: 'bg-red-100 text-red-800' },
  CANCELLED: { texto: 'Anulado', clase: 'bg-stone-200 text-stone-700' },
};
const ACCION: Record<InstrumentAction, string> = {
  deposit: 'Depositar', clear: 'Acreditar', endorse: 'Endosar', reject: 'Rechazar', debit: 'Marcar debitado', cancel: 'Anular',
};
const TIPO: Record<InstrumentType, string> = { CHEQUE: 'Cheque', ECHEQ: 'eCheq' };
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

  if (instrumentos.isLoading) return <p className="text-sm text-gray-500">Cargando cheques...</p>;
  if (instrumentos.error) return <p className="text-sm text-red-700">{errorMessage(instrumentos.error)}</p>;
  const recibidos = (instrumentos.data ?? []).filter((i) => i.direction === 'RECEIVED');
  const emitidos = (instrumentos.data ?? []).filter((i) => i.direction === 'ISSUED');

  const fila = (i: InstrumentRow) => (
    <div key={i.id} className="bg-white rounded-lg border border-[#E4DCC8] p-3 text-sm">
      <div className="flex items-center justify-between gap-2">
        <span>
          <span className="font-semibold text-amber-900">{TIPO[i.instrument_type]} {i.cheque_number ?? ''}</span>
          <span className="text-[#8A7A5C]"> · {i.direction === 'RECEIVED' ? i.cliente_nombre : i.supplier_nombre}</span>
          {i.endosado_nombre && <span className="text-[#8A7A5C]"> → {i.endosado_nombre}</span>}
          {i.maturity_date && <span className="text-[#8A7A5C]"> · vence {formatearFechaLocal(i.maturity_date)}</span>}
        </span>
        <span className="flex items-center gap-2">
          <span className="font-bold">{formatoPesos(i.amount)}</span>
          <span className={`text-xs px-2 py-0.5 rounded ${ESTADO[i.estado].clase}`}>{ESTADO[i.estado].texto}</span>
        </span>
      </div>
      {INSTRUMENT_ACTIONS[i.estado].length > 0 && (
        <div className="flex flex-wrap gap-2 mt-2">
          {INSTRUMENT_ACTIONS[i.estado].map((a) => (
            <button key={a} onClick={() => setAccion({ action: a, inst: i })}
              className={`text-xs px-2 py-1 rounded ${a === 'reject' || a === 'cancel' ? 'bg-red-50 text-red-700 hover:bg-red-100' : 'bg-amber-100 text-amber-900 hover:bg-amber-200'}`}>
              {ACCION[a]}
            </button>
          ))}
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
        <p className="text-xs text-[#8A7A5C] mb-2">Se emiten desde Cuentas a pagar → Pagar → Cheque / eCheq.</p>
        {emitidos.length === 0 ? <p className="text-sm text-[#8A7A5C]">No hay cheques emitidos.</p> : <div className="space-y-2">{emitidos.map(fila)}</div>}
      </section>
      {recibiendo && <RecibirChequeModal onClose={() => setRecibiendo(false)} />}
      {accion && <AccionModal action={accion.action} inst={accion.inst} onClose={() => setAccion(null)} />}
    </div>
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
      <label className={etiqueta}>Vencimiento
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

function AccionModal({ action, inst, onClose }: { action: InstrumentAction; inst: InstrumentRow; onClose: () => void }) {
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

  return (
    <Modal titulo={`${ACCION[action]} — ${TIPO[inst.instrument_type]} ${inst.cheque_number ?? ''} (${formatoPesos(inst.amount)})`} onClose={onClose}
      puedeGuardar={puede} guardando={mutacion.isPending} error={mutacion.error} textoGuardar={ACCION[action]}
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
