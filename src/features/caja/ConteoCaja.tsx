import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '../../lib/supabase';
import { balanceOn, registerCashOpening, type CashOpening } from '../../target/cashOpening';
import { formatearFechaLocal, getTodayDate } from '../../utils/dateUtils';
import { formatoPesos } from '../pedidos/helpers';
import { campo, etiqueta, Modal } from './Modal';
import { NumeroInput } from '../../components/NumeroInput';

/** 0140: the opening of a cash account by a count — shown on its card once recorded, else the way to record it (once per account). */
export function AperturaCaja({ apertura, onRegistrar }: { apertura?: CashOpening; onRegistrar: () => void }) {
  if (apertura) return (
    <p className="mt-1 text-[11px] text-[#6B5D45]" title={`ERP ${formatoPesos(apertura.erp_balance)} · contado ${formatoPesos(apertura.counted_amount)} · diferencia ${formatoPesos(apertura.difference)} (fuera de resultados)`}>
      Saldo inicial {formatearFechaLocal(apertura.count_date)}: {formatoPesos(apertura.counted_amount)} (conteo)</p>
  );
  return (
    <span role="button" tabIndex={0} onClick={(e) => { e.stopPropagation(); onRegistrar(); }} onKeyDown={(e) => { if (e.key === 'Enter') { e.stopPropagation(); onRegistrar(); } }}
      className="mt-1 inline-block text-[11px] text-[#A8552E] hover:underline">Registrar conteo (saldo inicial)</span>
  );
}

/**
 * 0140 (owner 2026-11-25): the cash counted at the end of a day becomes the opening balance of the account. The ERP balance of that day
 * is shown; the difference is posted once as «Saldo inicial (conteo de caja)» on that date, outside the P&L. Every cash movement up to
 * that day must be recorded first (a later one would move the balance before the opening).
 */
export function ConteoCajaModal({ cuenta, onClose }: { cuenta: { id: string; nombre: string }; onClose: () => void }) {
  const qc = useQueryClient();
  const [fecha, setFecha] = useState(getTodayDate());
  const [monto, setMonto] = useState('');
  const [motivo, setMotivo] = useState('');
  const saldo = useQuery({ queryKey: ['treasury', 'balance-on', cuenta.id, fecha], queryFn: () => balanceOn(supabase, cuenta.id, fecha), enabled: fecha !== '' });
  const registrar = useMutation({
    mutationFn: () => registerCashOpening(supabase, { accountId: cuenta.id, date: fecha, counted: Number(monto), reason: motivo }),
    onSuccess: () => Promise.all([['treasury'], ['operations'], ['pnl']].map((queryKey) => qc.invalidateQueries({ queryKey }))),
  });
  const contado = Number(monto);
  const dif = saldo.data !== undefined && monto !== '' ? Math.round((contado - saldo.data) * 100) / 100 : null;
  return (
    <Modal titulo={`Conteo de caja — ${cuenta.nombre}`} onClose={onClose} textoGuardar="Registrar saldo inicial" guardando={registrar.isPending} error={registrar.error ?? saldo.error}
      puedeGuardar={fecha !== '' && monto !== '' && contado >= 0 && saldo.data !== undefined} onSubmit={() => registrar.mutate(undefined, { onSuccess: onClose })}>
      <p className="text-xs text-amber-900 bg-amber-50 border border-amber-200 rounded px-2 py-1">
        Antes de registrarlo, cargá todos los movimientos de efectivo hasta esa fecha. Se registra una sola vez por caja.</p>
      <div className="grid grid-cols-2 gap-2">
        <label className={etiqueta}>Fecha del conteo (al cierre del día)<input type="date" value={fecha} max={getTodayDate()} onChange={(e) => setFecha(e.target.value)} className={campo} /></label>
        <label className={etiqueta}>Efectivo contado<NumeroInput min="0" step="0.01" value={monto} onChange={(e) => setMonto(e.target.value)} className={campo} /></label>
      </div>
      <p className="text-sm text-[#6B5D45]">Saldo en el ERP al {fecha ? formatearFechaLocal(fecha) : '—'}: <b>{saldo.data === undefined ? '…' : formatoPesos(saldo.data)}</b></p>
      {dif !== null && (
        <p className={`text-sm ${dif === 0 ? 'text-green-700' : 'text-[#2C2419]'}`}>
          {dif === 0 ? 'Coincide con el ERP: no hace falta ajuste.' : <>Diferencia: <b>{formatoPesos(dif)}</b> — queda como «Saldo inicial (conteo de caja)», fuera del estado de resultados.</>}</p>
      )}
      <label className={etiqueta}>Nota (opcional)<input type="text" value={motivo} onChange={(e) => setMotivo(e.target.value)} maxLength={200} className={campo} placeholder="Ej.: conteo de cierre de noviembre" /></label>
    </Modal>
  );
}
