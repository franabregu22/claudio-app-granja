import { useState } from 'react';
import { ArrowLeftRight } from 'lucide-react';
import { errorMessage } from '../../target/messages';
import { getTodayDate } from '../../utils/dateUtils';
import { formatoPesos } from '../pedidos/helpers';
import { useFinancialAccounts } from '../pedidos/useCommercial';
import { campo, etiqueta, Modal } from './Modal';
import { useLedgerBalances, useTreasuryMutations } from './useTreasury';

const TIPO: Record<string, string> = { CASH: 'Efectivo', BANK_ACCOUNT: 'Banco', EXTERNAL_SERVICE: 'Servicio externo' };

/**
 * Account balances (F27-D): the latest closing balance of each account in report_balance_period (Σ financial_posting).
 * An active account with no posting yet shows "Sin movimientos"; no balance is computed here.
 */
export function ResumenSaldos() {
  const cuentas = useFinancialAccounts();
  const saldos = useLedgerBalances('ACCOUNT');
  const [transfiriendo, setTransfiriendo] = useState(false);

  if (cuentas.isLoading || saldos.isLoading) return <p className="text-sm text-gray-500">Cargando saldos...</p>;
  const error = cuentas.error ?? saldos.error;
  if (error) return <p className="text-sm text-red-700">{errorMessage(error)}</p>;

  const porCuenta = new Map((saldos.data ?? []).map((s) => [s.entity_id, s]));
  return (
    <div className="bg-white rounded-lg border border-[#E4DCC8] p-4">
      <div className="space-y-2">
        {(cuentas.data ?? []).map((c) => {
          const s = porCuenta.get(c.id);
          return (
            <div key={c.id} className="flex items-center justify-between text-sm">
              <span className="text-[#2C2419] font-medium">{c.nombre} <span className="text-xs text-[#8A7A5C]">· {TIPO[c.account_type] ?? c.account_type}</span></span>
              {s ? <span className={`font-bold ${s.balance < 0 ? 'text-red-700' : 'text-[#2C2419]'}`}>{formatoPesos(s.balance)}</span>
                : <span className="text-xs text-[#8A7A5C]">Sin movimientos</span>}
            </div>
          );
        })}
        {(cuentas.data ?? []).length === 0 && <p className="text-sm text-[#8A7A5C]">No hay cuentas activas. Crealas en Administración.</p>}
      </div>
      <button onClick={() => setTransfiriendo(true)} disabled={(cuentas.data ?? []).length < 2}
        className="mt-4 flex items-center gap-2 text-sm px-3 py-2 bg-amber-100 text-amber-900 rounded-lg hover:bg-amber-200 disabled:opacity-50">
        <ArrowLeftRight className="w-4 h-4" /> Transferir entre cuentas
      </button>
      {transfiriendo && <TransferenciaModal onClose={() => setTransfiriendo(false)} />}
    </div>
  );
}

function TransferenciaModal({ onClose }: { onClose: () => void }) {
  const cuentas = useFinancialAccounts();
  const { transfer } = useTreasuryMutations();
  const [origen, setOrigen] = useState('');
  const [destino, setDestino] = useState('');
  const [monto, setMonto] = useState('');
  const [fecha, setFecha] = useState(getTodayDate());
  const [notas, setNotas] = useState('');
  const [clave] = useState(() => `TRF-${crypto.randomUUID()}`);   // idempotency: one per opened form
  const puede = origen !== '' && destino !== '' && Number(monto) > 0 && fecha !== '';

  return (
    <Modal titulo="Transferir entre cuentas" onClose={onClose} puedeGuardar={puede} guardando={transfer.isPending} error={transfer.error}
      textoGuardar="Transferir"
      onSubmit={() => transfer.mutate({ sourceAccountId: origen, destAccountId: destino, amount: Number(monto), effectiveDate: fecha, externalRef: clave, reason: notas },
        { onSuccess: onClose })}>
      <label className={etiqueta}>Desde
        <select value={origen} onChange={(e) => setOrigen(e.target.value)} className={campo}>
          <option value="">Elegir cuenta…</option>
          {(cuentas.data ?? []).map((a) => <option key={a.id} value={a.id}>{a.nombre}</option>)}
        </select>
      </label>
      <label className={etiqueta}>Hacia
        <select value={destino} onChange={(e) => setDestino(e.target.value)} className={campo}>
          <option value="">Elegir cuenta…</option>
          {(cuentas.data ?? []).map((a) => <option key={a.id} value={a.id}>{a.nombre}</option>)}
        </select>
      </label>
      <label className={etiqueta}>Monto
        <input type="number" min="0" step="0.01" value={monto} onChange={(e) => setMonto(e.target.value)} className={campo} />
      </label>
      <label className={etiqueta}>Fecha
        <input type="date" value={fecha} onChange={(e) => setFecha(e.target.value)} className={campo} />
      </label>
      <label className={etiqueta}>Notas (opcional)
        <input type="text" value={notas} onChange={(e) => setNotas(e.target.value)} className={campo} />
      </label>
    </Modal>
  );
}
