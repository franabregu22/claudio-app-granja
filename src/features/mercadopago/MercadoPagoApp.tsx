import { useCallback, useEffect, useState } from 'react';
import { useAuth } from '../../auth/useAuth';
import { getMPPeriod, getMPClosingBalance } from '../../api/mercadopago';
import type { MPMovement, MPSummary, MPClosingBalance } from '../../api/mercadopago';
import { argentinaDate, shiftDate } from '../../lib/mercadopago-calculations';
import { SummaryCards } from './SummaryCards';
import { DateFilter } from './DateFilter';
import { MovementsTable } from './MovementsTable';
import { TypeFilter } from './TypeFilter';

type DateRange = 'current_month' | 'last_month' | 'last_30' | 'custom';

export function MercadoPagoApp() {
  const { rol } = useAuth();
  const [loading, setLoading] = useState(true);
  const [summary, setSummary] = useState<MPSummary | null>(null);
  const [closing, setClosing] = useState<MPClosingBalance | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [movements, setMovements] = useState<MPMovement[]>([]);
  const [dateRange, setDateRange] = useState<DateRange>('current_month');
  const [customStart, setCustomStart] = useState('');
  const [customEnd, setCustomEnd] = useState('');
  const [selectedTypes, setSelectedTypes] = useState<string[]>([]);

  const getDateRanges = useCallback(() => {
    const today = argentinaDate();
    const firstOfMonth = `${today.slice(0, 7)}-01`;

    switch (dateRange) {
      case 'current_month': {
        return {
          start: firstOfMonth,
          end: today,
        };
      }
      case 'last_month': {
        const end = shiftDate(firstOfMonth, -1);
        return {
          start: `${end.slice(0, 7)}-01`,
          end,
        };
      }
      case 'last_30': {
        return {
          start: shiftDate(today, -29),
          end: today,
        };
      }
      case 'custom': {
        return {
          start: customStart,
          end: customEnd,
        };
      }
      default:
        return {
          start: firstOfMonth,
          end: today,
        };
    }
  }, [dateRange, customStart, customEnd]);

  useEffect(() => {
    if (rol !== 'dueño') return;
    let cancelled = false;
    const fetchData = async () => {
    setLoading(true);
    setErrorMessage(null);
    setSummary(null);
    setClosing(null);
    setMovements([]);
    try {
      const { start, end } = getDateRanges();
      if (!start || !end) { setErrorMessage('Elegí las dos fechas del período.'); return; }
      const [periodData, closingData] = await Promise.all([
        getMPPeriod(start, end),
        getMPClosingBalance(end),
      ]);
      if (cancelled) return;
      setSummary(periodData.summary);
      setMovements(periodData.movements);
      setClosing(closingData);
    } catch (error) {
      if (!cancelled) setErrorMessage(error instanceof Error ? error.message : 'No se pudo consultar Mercado Pago.');
    } finally {
      if (!cancelled) setLoading(false);
    }
  };
    fetchData();
    return () => { cancelled = true; };
  }, [getDateRanges, rol]);

  const visibleMovements = selectedTypes.length ? movements.filter(m => selectedTypes.includes(m.movement_class)) : movements;
  const currency = (amount: number | null) => amount === null ? 'Sin referencia' : new Intl.NumberFormat('es-AR', { style: 'currency', currency: 'ARS' }).format(amount);

  if (rol !== 'dueño') {
    return (
      <div className="min-h-screen bg-stone-100 flex items-center justify-center">
        <div className="bg-white p-8 rounded-lg text-center max-w-sm mx-4">
          <p className="text-lg font-semibold text-gray-800">Acceso restringido</p>
          <p className="text-gray-600 mt-2">Solo el dueño puede acceder a Mercado Pago.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-stone-100 flex justify-center relative">
      <div className="w-full max-w-6xl bg-[#FAF6EE] min-h-screen flex flex-col">
        {/* Header */}
        <header className="px-4 md:px-6 pt-6 pb-4 border-b border-[#E4DCC8]">
          <p className="text-xs font-semibold tracking-wide text-[#A8552E] uppercase">
            Granja Santo Tomás
          </p>
          <h1 className="text-2xl font-bold text-[#2C2419] mt-1">Mercado Pago</h1>
        </header>

        {/* Contenido Principal */}
        <div className="flex-1 overflow-y-auto px-4 md:px-6 pt-6 pb-20">
          {errorMessage && <p role="alert" className="mb-4 rounded-lg border border-red-200 bg-red-50 p-4 text-red-800">{errorMessage}</p>}
          {closing && <div className="mb-5 rounded-lg border border-[#E4DCC8] bg-white p-4 text-sm text-[#2C2419]">
            <p className="font-semibold">Cierre del {closing.date.split('-').reverse().join('/')} · Hora de Argentina</p>
            <p className="mt-2">Saldo calculado: {closing.calculated === null ? 'Falta un saldo inicial respaldado' : currency(closing.calculated)}</p>
            <p className="text-xs text-gray-600">Según los movimientos cargados hasta esa fecha.</p>
            <p>Saldo observado: {currency(closing.observed)}</p>
            {closing.difference !== null && <p className={closing.difference === 0 ? 'text-green-700' : 'text-red-700'}>
              {closing.difference === 0 ? 'Los saldos coinciden.' : `Diferencia (calculado − observado): ${currency(closing.difference)}`}
            </p>}
          </div>}
          {/* Summary Cards */}
          {summary && <SummaryCards summary={summary} loading={loading} />}
          {summary && <p className="mt-2 text-xs text-gray-600">Todo el período: entradas + rendimientos − salidas = neto. Entradas y salidas incluyen transferencias. El filtro de tipo se aplica a la tabla.</p>}

          {/* Filtros */}
          <div className="mt-8 space-y-4">
            <DateFilter
              dateRange={dateRange}
              onDateRangeChange={setDateRange}
              customStart={customStart}
              customEnd={customEnd}
              onCustomStartChange={setCustomStart}
              onCustomEndChange={setCustomEnd}
            />

            <TypeFilter
              selectedTypes={selectedTypes}
              onTypesChange={setSelectedTypes}
            />
          </div>

          {/* Movimientos */}
          <div className="mt-8">
            <p className="text-xs font-semibold text-[#8A6A2E] uppercase tracking-wide mb-4">
              Movimientos ({visibleMovements.length})
            </p>
            <MovementsTable movements={visibleMovements} loading={loading} />
          </div>
        </div>
      </div>
    </div>
  );
}
