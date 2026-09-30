import { errorMessage } from '../../target/messages';
import { formatoPesos } from '../pedidos/helpers';
import { usePnlMonths } from '../caja/useTreasury';

const MESES = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
const etiquetaMes = (period: string) => `${MESES[Number(period.slice(5, 7)) - 1]}-${period.slice(2, 4)}`.toUpperCase();

/**
 * Tendencia meses (P27-D2): presentation only over pnl_summary. Each value is the view's column as reported for the
 * period (accrued net sales, operating result, result after investments); no margin, cash flow or balance is derived.
 */
export function TendenciaMeses() {
  const meses = usePnlMonths();
  if (meses.isLoading) return <p className="text-sm text-gray-500">Cargando tendencia...</p>;
  if (meses.error) return <p className="text-sm text-red-700">{errorMessage(meses.error)}</p>;
  const filas = meses.data ?? [];
  if (filas.length === 0) return <p className="text-sm text-[#8A7A5C]">Todavía no hay períodos en el estado de resultados.</p>;

  const escala = Math.max(1, ...filas.flatMap((m) => [Math.abs(m.ventas_netas_devengadas), Math.abs(m.resultado_operativo)]));
  const barra = (v: number, color: string) => (
    <div className="h-2 bg-stone-100 rounded"><div className={`h-2 rounded ${v < 0 ? 'bg-red-500' : color}`} style={{ width: `${(Math.abs(v) / escala) * 100}%` }} /></div>
  );

  return (
    <div className="bg-white rounded-lg border border-[#E4DCC8] p-4 space-y-3">
      {filas.map((m) => (
        <div key={m.period} className="text-xs">
          <div className="flex items-center justify-between mb-1">
            <span className="font-semibold text-[#2C2419] w-16">{etiquetaMes(m.period)}</span>
            <span className="text-[#8A7A5C]">Ventas {formatoPesos(m.ventas_netas_devengadas)}</span>
            <span className={m.resultado_operativo < 0 ? 'text-red-700' : 'text-green-700'}>Resultado operativo {formatoPesos(m.resultado_operativo)}</span>
            <span className={`hidden md:inline ${m.resultado_post_inversiones < 0 ? 'text-red-700' : 'text-[#2C2419]'}`}>
              Post inversiones {formatoPesos(m.resultado_post_inversiones)}
            </span>
          </div>
          {barra(m.ventas_netas_devengadas, 'bg-amber-500')}
          <div className="mt-1">{barra(m.resultado_operativo, 'bg-green-600')}</div>
        </div>
      ))}
      <p className="text-xs text-[#8A7A5C]">Valores del estado de resultados (devengado), últimos {filas.length} períodos.</p>
    </div>
  );
}
