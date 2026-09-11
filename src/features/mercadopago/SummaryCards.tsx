import { TrendingUp, TrendingDown, Wallet, Zap, Activity } from 'lucide-react';
import type { MPSummary } from '../../api/mercadopago';

interface SummaryCardsProps {
  summary: MPSummary;
  loading: boolean;
}

export function SummaryCards({ summary, loading }: SummaryCardsProps) {
  const formatCurrency = (amount: number) => {
    return new Intl.NumberFormat('es-AR', {
      style: 'currency',
      currency: 'ARS',
      minimumFractionDigits: 2,
    }).format(amount);
  };

  const cards = [
    {
      label: 'Saldo registrado',
      value: summary.balance,
      icon: Wallet,
      color: 'text-blue-600',
      bgColor: 'bg-blue-50',
      borderColor: 'border-blue-200',
    },
    {
      label: 'Ingresos',
      value: summary.ingresos,
      icon: TrendingUp,
      color: 'text-green-600',
      bgColor: 'bg-green-50',
      borderColor: 'border-green-200',
    },
    {
      label: 'Egresos',
      value: summary.egresos,
      icon: TrendingDown,
      color: 'text-red-600',
      bgColor: 'bg-red-50',
      borderColor: 'border-red-200',
    },
    {
      label: 'Rendimientos',
      value: summary.rendimientos,
      icon: Zap,
      color: 'text-yellow-600',
      bgColor: 'bg-yellow-50',
      borderColor: 'border-yellow-200',
    },
    {
      label: 'Movimientos',
      value: summary.total_movimientos,
      icon: Activity,
      color: 'text-purple-600',
      bgColor: 'bg-purple-50',
      borderColor: 'border-purple-200',
      isCount: true,
    },
  ];

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-5 gap-4">
      {cards.map((card) => {
        const Icon = card.icon;
        return (
          <div
            key={card.label}
            className={`${card.bgColor} border ${card.borderColor} rounded-lg p-4 flex flex-col`}
          >
            <div className="flex items-center justify-between mb-2">
              <p className="text-xs font-semibold text-gray-700 uppercase tracking-wide">
                {card.label}
              </p>
              <Icon className={`w-5 h-5 ${card.color}`} />
            </div>
            {loading ? (
              <div className="h-8 bg-gray-200 rounded animate-pulse" />
            ) : (
              <p className={`text-lg font-bold ${card.color}`}>
                {card.isCount ? card.value : formatCurrency(card.value)}
              </p>
            )}
          </div>
        );
      })}
    </div>
  );
}
