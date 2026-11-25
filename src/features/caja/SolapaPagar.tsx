import { useState } from 'react';
import { Cheques } from './Cheques';
import { CuentasAPagar } from './CuentasAPagar';
import { Anulados, PendientesPagar } from './PendientesPagar';

/**
 * Caja → Cuentas a pagar (caja-mejoras-v2, 0121): ONE list of every pending due item on real data (single payments, instalments, own
 * cheques / eCheqs) filtered by supplier, type and the summary cards; each row opens its expense.
 * Owner 2026-11-24: no «Ver también» strip — the supplier accounts (debt, advances, ficha) and the issued cheques (annul, reject, replace;
 * kept «por las dudas») open from their cards next to the totals, with a way back. Owner 2026-11-25: the annulled expenses too.
 */
export function SolapaPagar() {
  const [vista, setVista] = useState<'pendientes' | 'proveedores' | 'emitidos' | 'anulados'>('pendientes');
  if (vista === 'pendientes') return <PendientesPagar onProveedores={() => setVista('proveedores')} onCheques={() => setVista('emitidos')} onAnulados={() => setVista('anulados')} />;
  return (
    <div className="space-y-4">
      <button type="button" onClick={() => setVista('pendientes')} className="text-sm text-[#A8552E] hover:underline">← Volver a pendientes</button>
      {vista === 'proveedores' ? <CuentasAPagar /> : vista === 'anulados' ? <Anulados /> : <Cheques />}
    </div>
  );
}
