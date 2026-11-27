import { useState } from 'react';
import { Cheques } from './Cheques';
import { CuentasAPagar } from './CuentasAPagar';
import { Anulados, PendientesPagar } from './PendientesPagar';

type Vista = 'pendientes' | 'proveedores' | 'emitidos' | 'anulados';
const SOLAPAS: { id: 'pendientes' | 'proveedores'; label: string }[] = [{ id: 'pendientes', label: 'Vencimientos' }, { id: 'proveedores', label: 'Proveedores' }];

/**
 * Caja → Cuentas a pagar (caja-mejoras-v2, 0121): ONE list of every pending due item on real data (single payments, instalments, own
 * cheques / eCheqs) filtered by supplier, type and the summary cards; each row opens its expense.
 * Owner 2026-11-27: the supplier current accounts are a fixed tab next to the due items (it was a card easy to miss), and each due item
 * of a supplier opens that supplier's account directly. The issued cheques and the annulled expenses still open from their cards.
 */
export function SolapaPagar() {
  const [vista, setVista] = useState<Vista>('pendientes');
  const [proveedor, setProveedor] = useState<string | null>(null);
  const ir = (v: Vista, id: string | null = null) => { setProveedor(id); setVista(v); };
  return (
    <div className="space-y-3">
      <div role="tablist" aria-label="Cuentas a pagar" className="inline-flex rounded-lg border border-[#E4DCC8] bg-white p-0.5 text-sm">
        {SOLAPAS.map((s) => {
          const activa = vista === s.id || (s.id === 'pendientes' && (vista === 'emitidos' || vista === 'anulados'));
          return (
            <button key={s.id} type="button" role="tab" aria-selected={activa} onClick={() => ir(s.id)}
              className={`px-4 py-1.5 rounded-md font-medium ${activa ? 'bg-amber-600 text-white' : 'text-[#6B5D45] hover:bg-amber-50'}`}>{s.label}</button>
          );
        })}
      </div>
      {vista === 'pendientes' && <PendientesPagar onProveedor={(id) => ir('proveedores', id)} onCheques={() => ir('emitidos')} onAnulados={() => ir('anulados')} />}
      {vista === 'proveedores' && <CuentasAPagar inicial={proveedor} />}
      {(vista === 'emitidos' || vista === 'anulados') && (
        <div className="space-y-4">
          <button type="button" onClick={() => ir('pendientes')} className="text-sm text-[#A8552E] hover:underline">← Volver a vencimientos</button>
          {vista === 'anulados' ? <Anulados /> : <Cheques />}
        </div>
      )}
    </div>
  );
}
