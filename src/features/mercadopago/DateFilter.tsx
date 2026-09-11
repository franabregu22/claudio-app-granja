import { Calendar } from 'lucide-react';

type DateRange = 'current_month' | 'last_month' | 'last_30' | 'custom';

interface DateFilterProps {
  dateRange: DateRange;
  onDateRangeChange: (range: DateRange) => void;
  customStart: string;
  customEnd: string;
  onCustomStartChange: (date: string) => void;
  onCustomEndChange: (date: string) => void;
}

export function DateFilter({
  dateRange,
  onDateRangeChange,
  customStart,
  customEnd,
  onCustomStartChange,
  onCustomEndChange,
}: DateFilterProps) {
  const buttonClass = (isActive: boolean) =>
    `px-4 py-2 rounded font-medium text-sm transition-colors ${
      isActive
        ? 'bg-[#A8552E] text-white'
        : 'bg-white text-[#2C2419] border border-[#E4DCC8] hover:border-[#A8552E]'
    }`;

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2 mb-3">
        <Calendar className="w-5 h-5 text-[#A8552E]" />
        <p className="text-xs font-semibold text-[#8A6A2E] uppercase tracking-wide">
          Período
        </p>
      </div>

      <div className="flex flex-wrap gap-2">
        <button
          onClick={() => onDateRangeChange('current_month')}
          className={buttonClass(dateRange === 'current_month')}
        >
          Este mes
        </button>
        <button
          onClick={() => onDateRangeChange('last_month')}
          className={buttonClass(dateRange === 'last_month')}
        >
          Mes anterior
        </button>
        <button
          onClick={() => onDateRangeChange('last_30')}
          className={buttonClass(dateRange === 'last_30')}
        >
          Últimos 30 días
        </button>
        <button
          onClick={() => onDateRangeChange('custom')}
          className={buttonClass(dateRange === 'custom')}
        >
          Personalizado
        </button>
      </div>

      {dateRange === 'custom' && (
        <div className="flex flex-col md:flex-row gap-4 mt-4 p-4 bg-white rounded-lg border border-[#E4DCC8]">
          <div className="flex-1">
            <label className="block text-xs font-semibold text-[#8A6A2E] mb-2">
              Desde
            </label>
            <input
              type="date"
              value={customStart}
              onChange={(e) => onCustomStartChange(e.target.value)}
              className="w-full px-3 py-2 border border-[#E4DCC8] rounded focus:outline-none focus:border-[#A8552E]"
            />
          </div>
          <div className="flex-1">
            <label className="block text-xs font-semibold text-[#8A6A2E] mb-2">
              Hasta
            </label>
            <input
              type="date"
              value={customEnd}
              onChange={(e) => onCustomEndChange(e.target.value)}
              className="w-full px-3 py-2 border border-[#E4DCC8] rounded focus:outline-none focus:border-[#A8552E]"
            />
          </div>
        </div>
      )}
    </div>
  );
}
