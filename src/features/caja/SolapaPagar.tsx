import { Cheques } from './Cheques';
import { Fletes } from './Compras';
import { CuentasAPagar } from './CuentasAPagar';

export type SubPagar = 'proveedores' | 'instrumentos';
const SUBVISTAS: { id: SubPagar; label: string }[] = [
  { id: 'proveedores', label: 'Proveedores' },
  { id: 'instrumentos', label: 'Cheques' },
];

/**
 * Caja → Cuentas a pagar in two sections: Proveedores (accounts, uncovered debt, advances, pending and debited cheques, and the freight
 * registered) and Cheques (issue, debit, rejection, cancellation, payment date and reconciliation). Each section is the existing screen.
 * Gastos is no longer a section: every expense, invoice and pending payment is a row of Movimientos → Todas las operaciones, whose
 * drop-down keeps Gastos' own detail and actions (receipts, Editar / Rectificar, payments, cheques, dates, freight, history).
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
      {sub === 'proveedores' && <><CuentasAPagar /><Fletes /></>}
      {sub === 'instrumentos' && <Cheques />}
      <p className="text-xs text-[#8A7A5C]">Los gastos y facturas (pendientes, pagados y por revisar) están en Movimientos → Todas las operaciones.</p>
    </div>
  );
}
