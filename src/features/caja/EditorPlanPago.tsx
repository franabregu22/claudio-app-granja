import { useState } from 'react';
import { Trash2 } from 'lucide-react';
import { repartirCuotas, type ChequeInput } from '../../target/paymentPlan';
import { repartirEnCuotas } from '../fiscal/cuotas';
import { getTodayDate } from '../../utils/dateUtils';
import { formatoPesos } from '../pedidos/helpers';
import { useFinancialAccounts } from '../pedidos/useCommercial';
import { campo, etiqueta } from './Modal';
import { NumeroInput } from '../../components/NumeroInput';

export type FormaPago = 'UNICO' | 'CUOTAS' | 'CHEQUES';
interface ChequeForm { tipo: 'CHEQUE' | 'ECHEQ'; numero: string; fecha: string; importe: string; cuenta: string }
export interface PlanPago {
  forma: FormaPago;
  /** UNICO / CUOTAS: the items for set_payment_plan (0121); empty when UNICO has no date (nothing to plan: one due item, as before). */
  items: { due_date: string | null; amount: number }[];
  /** CHEQUES: own cheques / eCheqs for issue_purchase_instruments (a supplier is required). */
  cheques: ChequeInput[];
  valido: boolean;
  editor: React.ReactNode;
}

/**
 * "¿Cómo lo vas a pagar?" (caja-mejoras-v2): one payment (optional date), informal instalments (count, first date, frequency, each one
 * editable) or own cheques / eCheqs (only with a supplier). Shared by Nuevo gasto and Cuentas a pagar → Cambiar forma de pago.
 * It only builds the input; the backend checks again that the items add up to what is open.
 */
/** Cheques: offered and usable ('SI'), offered but a supplier is still missing ('REQUIERE_PROVEEDOR'), or not offered here ('NO'). */
export type ChequesPlan = 'SI' | 'REQUIERE_PROVEEDOR' | 'NO';
export function usePlanPago(total: number, { cheques: modoCheques }: { cheques: ChequesPlan }): PlanPago {
  const hoy = getTodayDate();
  const cuentas = useFinancialAccounts();
  const bancos = (cuentas.data ?? []).filter((c) => c.activo && c.account_type === 'BANK_ACCOUNT');
  const [forma, setForma] = useState<FormaPago>('UNICO');
  const [fechaUnica, setFechaUnica] = useState('');
  const [nCuotas, setNCuotas] = useState('3');
  const [primera, setPrimera] = useState(hoy);
  const [frecuencia, setFrecuencia] = useState<'MENSUAL' | 'QUINCENAL' | 'SEMANAL'>('MENSUAL');
  const [editadas, setEditadas] = useState<{ due_date: string; amount: string }[] | null>(null);
  const [cheques, setCheques] = useState<ChequeForm[]>([{ tipo: 'ECHEQ', numero: '', fecha: '', importe: '', cuenta: '' }]);
  const tot = Math.round((total || 0) * 100) / 100;
  const formaEf: FormaPago = forma === 'CHEQUES' && modoCheques === 'NO' ? 'UNICO' : forma;
  const generadas = editadas ?? (tot > 0 && Number(nCuotas) >= 2 ? repartirCuotas(tot, Number(nCuotas), primera, frecuencia).map((c) => ({ due_date: c.due_date, amount: String(c.amount) })) : []);
  const items = formaEf === 'UNICO' ? (fechaUnica ? [{ due_date: fechaUnica, amount: tot }] : [])
    : formaEf === 'CUOTAS' ? generadas.map((c) => ({ due_date: c.due_date || null, amount: Number(c.amount) })) : [];
  const chequesIn: ChequeInput[] = formaEf === 'CHEQUES' ? cheques.map((c) => ({ instrument_type: c.tipo, cheque_number: c.numero.trim(), amount: Number(c.importe),
    maturity_date: c.fecha, issued_date: hoy, bank_account_id: c.cuenta || bancos[0]?.id || '' })) : [];
  const suma = Math.round((formaEf === 'CHEQUES' ? chequesIn.reduce((s, c) => s + (c.amount || 0), 0) : items.reduce((s, x) => s + (x.amount || 0), 0)) * 100) / 100;
  const cuadra = Math.abs(suma - tot) < 0.005;
  const valido = formaEf === 'UNICO' ? true
    : formaEf === 'CUOTAS' ? items.length >= 2 && items.every((x) => x.amount > 0) && cuadra
      : modoCheques === 'SI' && chequesIn.length > 0 && chequesIn.every((c) => c.cheque_number && c.maturity_date && c.amount > 0 && c.bank_account_id) && cuadra;
  const reset = () => setEditadas(null);
  const setCheque = (i: number, k: keyof ChequeForm, v: string) => setCheques(cheques.map((c, j) => (j === i ? { ...c, [k]: v } : c)));
  const opciones: [FormaPago, string][] = modoCheques !== 'NO' ? [['UNICO', 'Un pago'], ['CUOTAS', 'En cuotas'], ['CHEQUES', 'Cheques / eCheqs']] : [['UNICO', 'Un pago'], ['CUOTAS', 'En cuotas']];

  const editor = (
    <fieldset className="space-y-2">
      <legend className={etiqueta}>¿Cómo lo vas a pagar?</legend>
      <div className={`grid ${modoCheques !== 'NO' ? 'grid-cols-3' : 'grid-cols-2'} gap-1 text-sm`} role="radiogroup" aria-label="Forma de pago">
        {opciones.map(([f, l]) => (
          <button key={f} type="button" role="radio" aria-checked={formaEf === f} onClick={() => setForma(f)}
            className={`py-1.5 rounded-lg border ${formaEf === f ? 'bg-amber-100 border-amber-400 text-amber-900 font-medium' : 'bg-white border-gray-300 text-gray-700'}`}>{l}</button>
        ))}
      </div>
      {formaEf === 'UNICO' && (
        <label className={etiqueta}>Fecha de pago <span className="font-normal text-gray-500">(opcional)</span>
          <input type="date" value={fechaUnica} onChange={(e) => setFechaUnica(e.target.value)} className={campo} />
        </label>
      )}
      {formaEf === 'CUOTAS' && (
        <div className="space-y-2">
          <div className="grid grid-cols-3 gap-2">
            <label className={etiqueta}>Cuotas<NumeroInput min="2" max="60" value={nCuotas} onChange={(e) => { setNCuotas(e.target.value); reset(); }} className={campo} /></label>
            <label className={`${etiqueta} col-span-2`}>Primera cuota<input type="date" value={primera} onChange={(e) => { setPrimera(e.target.value); reset(); }} className={campo} /></label>
          </div>
          <select value={frecuencia} onChange={(e) => { setFrecuencia(e.target.value as typeof frecuencia); reset(); }} className={campo} aria-label="Frecuencia">
            <option value="MENSUAL">Mensual</option><option value="QUINCENAL">Cada 15 días</option><option value="SEMANAL">Semanal</option>
          </select>
          {tot <= 0 ? <p className="text-xs text-amber-800">Cargá el importe total para repartir las cuotas; después podés cambiar la fecha y el importe de cada una.</p> : (
            <ul className="space-y-1">
              <li className="flex items-center gap-2 text-[11px] text-gray-500"><span className="w-6" /><span className="flex-1">Fecha de pago</span><span className="w-32 text-right">Importe</span></li>
              {generadas.map((c, i) => (
                <li key={i} className="flex items-center gap-2 text-sm">
                  <span className="w-6 text-gray-500">{i + 1}.</span>
                  <input type="date" value={c.due_date} onChange={(e) => setEditadas(generadas.map((x, j) => (j === i ? { ...x, due_date: e.target.value } : x)))} className="border border-gray-300 rounded px-2 py-1 flex-1" aria-label={`Fecha cuota ${i + 1}`} />
                  <NumeroInput step="0.01" value={c.amount} onChange={(e) => setEditadas(generadas.map((x, j) => (j === i ? { ...x, amount: e.target.value } : x)))} className="border border-gray-300 rounded px-2 py-1 w-32 text-right" aria-label={`Importe cuota ${i + 1}`} />
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      {formaEf === 'CHEQUES' && (
        <div className="space-y-2">
          {modoCheques === 'REQUIERE_PROVEEDOR' && <p className="text-xs text-red-700">Para pagar con cheques o eCheqs elegí el proveedor arriba.</p>}
          <p className="text-[11px] text-gray-500">Una fila por cheque: tipo, número, cuenta, fecha de débito e importe.</p>
          {cheques.map((c, i) => (
            <div key={i} className="grid grid-cols-6 gap-1 text-sm items-center">
              <select value={c.tipo} onChange={(e) => setCheque(i, 'tipo', e.target.value)} className="col-span-2 border border-gray-300 rounded px-1 py-1" aria-label="Tipo"><option value="ECHEQ">eCheq</option><option value="CHEQUE">Cheque</option></select>
              <input value={c.numero} onChange={(e) => setCheque(i, 'numero', e.target.value)} placeholder="Número" className="col-span-2 border border-gray-300 rounded px-2 py-1" />
              <select value={c.cuenta || bancos[0]?.id || ''} onChange={(e) => setCheque(i, 'cuenta', e.target.value)} className="col-span-2 border border-gray-300 rounded px-1 py-1" aria-label="Cuenta">{bancos.map((b) => <option key={b.id} value={b.id}>{b.nombre}</option>)}</select>
              <input type="date" value={c.fecha} onChange={(e) => setCheque(i, 'fecha', e.target.value)} className="col-span-3 border border-gray-300 rounded px-2 py-1" aria-label="Fecha de débito" title="Fecha de débito" />
              <NumeroInput step="0.01" value={c.importe} onChange={(e) => setCheque(i, 'importe', e.target.value)} placeholder="Importe" className="col-span-2 border border-gray-300 rounded px-2 py-1 text-right" />
              <button type="button" onClick={() => setCheques(cheques.filter((_, j) => j !== i))} disabled={cheques.length === 1} className="text-gray-400 hover:text-red-600 disabled:opacity-30 justify-self-center" aria-label="Quitar cheque"><Trash2 className="w-4 h-4" /></button>
            </div>
          ))}
          <div className="flex flex-wrap gap-4">
            <button type="button" onClick={() => setCheques([...cheques, { ...cheques[cheques.length - 1], numero: '', fecha: '', importe: '' }])} className="text-sm text-[#A8552E] hover:underline">+ Agregar otro cheque</button>
            {/* owner 2026-11-25: the total split to the cent (the cents left over in the last cheque) — never a $0,01 difference */}
            {tot > 0 && <button type="button" onClick={() => { const p = repartirEnCuotas(tot, cheques.length); setCheques(cheques.map((c, i) => ({ ...c, importe: p[i].toFixed(2) }))); }} className="text-sm text-[#A8552E] hover:underline">Repartir {formatoPesos(tot)} en {cheques.length === 1 ? '1 cheque' : `los ${cheques.length} cheques`}</button>}
          </div>
        </div>
      )}
      {formaEf !== 'UNICO' && tot > 0 && <p className={`text-xs ${cuadra ? 'text-green-700' : 'text-red-700'}`}>Suma {formatoPesos(suma)} de {formatoPesos(tot)}</p>}
    </fieldset>
  );
  return { forma: formaEf, items, cheques: chequesIn, valido, editor };
}
