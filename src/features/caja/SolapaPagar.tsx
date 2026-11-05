import { Cheques } from './Cheques';
import { CuentasAPagar } from './CuentasAPagar';
import { Gastos } from './Gastos';

export type SubPagar = 'gastos' | 'proveedores' | 'instrumentos';
const SUBVISTAS: { id: SubPagar; label: string }[] = [
  { id: 'gastos', label: 'Gastos' },
  { id: 'proveedores', label: 'Proveedores' },
  { id: 'instrumentos', label: 'Cheques' },
];

/**
 * Caja → Cuentas a pagar in three sections: Gastos (invoices, pending expenses and purchases in one list, with their payments and
 * eCheqs — what were Gastos pendientes, Compras y fletes and Facturas), Proveedores (accounts, uncovered debt, advances, pending and
 * debited cheques) and Cheques (issue, debit, rejection, cancellation and reconciliation). Each section is the existing screen.
 */
export function SolapaPagar({ sub, onSub }: { sub: SubPagar; onSub: (s: SubPagar) => void }) {
  return (
    <div className="space-y-4">
      <div className="flex gap-2 overflow-x-auto" role="tablist" aria-label="Secciones de cuentas a pagar">
        {SUBVISTAS.map((s) => (
          <button key={s.id} role="tab" aria-selected={sub === s.id} onClick={() => onSub(s.id)}
            className={`whitespace-nowrap px-3 py-1 rounded-full text-sm font-medium ${sub === s.id ? 'bg-amber-100 text-amber-900 border border-amber-300' : 'bg-white text-[#6B5D45] border border-[#E4DCC8] hover:bg-stone-50'}`}>
            {s.label}
          </button>
        ))}
      </div>
      {sub === 'gastos' && <Gastos />}
      {sub === 'proveedores' && <CuentasAPagar />}
      {sub === 'instrumentos' && <Cheques />}
    </div>
  );
}
