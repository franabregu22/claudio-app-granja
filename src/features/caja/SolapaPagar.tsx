import { Cheques } from './Cheques';
import { Fletes } from './Compras';
import { CuentasAPagar } from './CuentasAPagar';
import { PendientesPagar } from './PendientesPagar';

export type SubPagar = 'pendientes' | 'proveedores' | 'instrumentos';
/** The current screens, kept reachable while the prototype is reviewed (caja-mejoras-v2). */
const ACTUALES: { id: SubPagar; label: string }[] = [
  { id: 'proveedores', label: 'Proveedores' },
  { id: 'instrumentos', label: 'Cheques' },
];

/**
 * Caja → Cuentas a pagar (caja-mejoras-v2, 0121): ONE list of every pending due item on real data (single payments, instalments, own
 * cheques / eCheqs) filtered by supplier, type and the summary cards; each row opens its expense. The 0120
 * screens — Proveedores (accounts, debt, advances, cheques and freight) and Cheques — stay under "Vista actual" while the new list is
 * reviewed.
 */
export function SolapaPagar({ sub, onSub }: { sub: SubPagar; onSub: (s: SubPagar) => void }) {
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-end gap-2 text-xs text-[#8A7A5C]" role="tablist" aria-label="Secciones de cuentas a pagar">
        {sub !== 'pendientes' && <button role="tab" aria-selected={false} onClick={() => onSub('pendientes')} className="mr-auto text-sm text-[#A8552E] hover:underline">← Volver a pendientes</button>}
        Vista actual:
        {ACTUALES.map((s) => (
          <button key={s.id} role="tab" aria-selected={sub === s.id} onClick={() => onSub(s.id)}
            className={`whitespace-nowrap px-2 py-0.5 rounded-full border ${sub === s.id ? 'bg-amber-100 text-amber-900 border-amber-300' : 'bg-white text-[#6B5D45] border-[#E4DCC8] hover:bg-stone-50'}`}>
            {s.label}
          </button>
        ))}
      </div>
      {sub === 'pendientes' && <PendientesPagar />}
      {sub === 'proveedores' && <><CuentasAPagar /><Fletes /></>}
      {sub === 'instrumentos' && <Cheques />}
    </div>
  );
}
