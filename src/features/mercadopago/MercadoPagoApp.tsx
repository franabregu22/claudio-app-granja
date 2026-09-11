import { useEffect, useState } from 'react';
import { useAuth } from '../../auth/useAuth';
import { getMPSummary, getMPMovements } from '../../api/mercadopago';
import type { MPMovement, MPSummary } from '../../api/mercadopago';
import { SummaryCards } from './SummaryCards';
import { DateFilter } from './DateFilter';
import { MovementsTable } from './MovementsTable';
import { TypeFilter } from './TypeFilter';

type DateRange = 'current_month' | 'last_month' | 'last_30' | 'custom';

export function MercadoPagoApp() {
  const { rol } = useAuth();
  const [loading, setLoading] = useState(true);
  const [summary, setSummary] = useState<MPSummary | null>(null);
  const [movements, setMovements] = useState<MPMovement[]>([]);
  const [dateRange, setDateRange] = useState<DateRange>('current_month');
  const [customStart, setCustomStart] = useState('');
  const [customEnd, setCustomEnd] = useState('');
  const [selectedTypes, setSelectedTypes] = useState<string[]>([]);

  const getDateRanges = () => {
    const today = new Date();
    const currentYear = today.getFullYear();
    const currentMonth = today.getMonth();

    switch (dateRange) {
      case 'current_month': {
        const start = new Date(currentYear, currentMonth, 1);
        const end = today;
        return {
          start: start.toISOString().split('T')[0],
          end: end.toISOString().split('T')[0],
        };
      }
      case 'last_month': {
        const start = new Date(currentYear, currentMonth - 1, 1);
        const end = new Date(currentYear, currentMonth, 0);
        return {
          start: start.toISOString().split('T')[0],
          end: end.toISOString().split('T')[0],
        };
      }
      case 'last_30': {
        const start = new Date(today);
        start.setDate(start.getDate() - 30);
        return {
          start: start.toISOString().split('T')[0],
          end: today.toISOString().split('T')[0],
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
          start: new Date(currentYear, currentMonth, 1).toISOString().split('T')[0],
          end: today.toISOString().split('T')[0],
        };
    }
  };

  const fetchData = async () => {
    setLoading(true);
    try {
      const { start, end } = getDateRanges();
      const [summaryData, movementsData] = await Promise.all([
        getMPSummary(start, end),
        getMPMovements(start, end, selectedTypes.length > 0 ? selectedTypes : undefined),
      ]);
      setSummary(summaryData);
      setMovements(movementsData);
    } catch (error) {
      console.error('Error fetching MercadoPago data:', error);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchData();
  }, [dateRange, customStart, customEnd, selectedTypes]);

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
          {/* Summary Cards */}
          {summary && <SummaryCards summary={summary} loading={loading} />}

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
              Movimientos ({movements.length})
            </p>
            <MovementsTable movements={movements} loading={loading} />
          </div>
        </div>
      </div>
    </div>
  );
}
