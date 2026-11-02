import { Cheques } from './Cheques';
import { Compras } from './Compras';
import { CuentasAPagar } from './CuentasAPagar';
import { GastosAPagar, usePayables } from './GastosAPagar';
import { PagosFacturas } from './PagosFacturas';

export type SubPagar = 'proveedores' | 'gastos' | 'compras' | 'pagosfactura' | 'instrumentos';
const SUBVISTAS: { id: SubPagar; label: string }[] = [
  { id: 'proveedores', label: 'Proveedores' },
  { id: 'gastos', label: 'Gastos pendientes' },
  { id: 'compras', label: 'Compras y fletes' },
  { id: 'pagosfactura', label: 'Facturas' },
  { id: 'instrumentos', label: 'Cheques' },
];

/** Caja → Cuentas a pagar: what we owe and how it is paid. Each section is the existing screen, with its own forms and actions. */
export function SolapaPagar({ sub, onSub }: { sub: SubPagar; onSub: (s: SubPagar) => void }) {
  const gastos = usePayables(true);
  const pendientes = gastos.data?.length ?? 0;
  return (
    <div className="space-y-4">
      <div className="flex gap-2 overflow-x-auto" role="tablist" aria-label="Secciones de cuentas a pagar">
        {SUBVISTAS.map((s) => (
          <button key={s.id} role="tab" aria-selected={sub === s.id} onClick={() => onSub(s.id)}
            className={`whitespace-nowrap px-3 py-1 rounded-full text-sm font-medium ${sub === s.id ? 'bg-amber-100 text-amber-900 border border-amber-300' : 'bg-white text-[#6B5D45] border border-[#E4DCC8] hover:bg-stone-50'}`}>
            {s.label}{s.id === 'gastos' && pendientes > 0 ? ` (${pendientes})` : ''}
          </button>
        ))}
      </div>
      {sub === 'proveedores' && <CuentasAPagar />}
      {sub === 'gastos' && <GastosAPagar titulo="Gastos pendientes" />}
      {sub === 'compras' && <Compras />}
      {sub === 'pagosfactura' && <PagosFacturas />}
      {sub === 'instrumentos' && <Cheques />}
    </div>
  );
}
