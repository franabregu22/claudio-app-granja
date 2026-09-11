import { Filter } from 'lucide-react';

interface TypeFilterProps {
  selectedTypes: string[];
  onTypesChange: (types: string[]) => void;
}

const types = [
  { id: 'payment_in', label: 'Cobros' },
  { id: 'payment_out', label: 'Pagos' },
  { id: 'yield', label: 'Rendimientos' },
  { id: 'transfer_in', label: 'Transferencias recibidas' },
  { id: 'transfer_out', label: 'Transferencias enviadas' },
];

export function TypeFilter({ selectedTypes, onTypesChange }: TypeFilterProps) {
  const toggle = (typeId: string) => {
    if (selectedTypes.includes(typeId)) {
      onTypesChange(selectedTypes.filter(t => t !== typeId));
    } else {
      onTypesChange([...selectedTypes, typeId]);
    }
  };

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <Filter className="w-5 h-5 text-[#A8552E]" />
        <p className="text-xs font-semibold text-[#8A6A2E] uppercase tracking-wide">
          Filtrar por tipo
        </p>
      </div>

      <div className="flex flex-wrap gap-2">
        {types.map((type) => (
          <button
            key={type.id}
            onClick={() => toggle(type.id)}
            className={`px-3 py-2 rounded text-sm font-medium transition-colors ${
              selectedTypes.includes(type.id)
                ? 'bg-[#A8552E] text-white'
                : 'bg-white text-[#2C2419] border border-[#E4DCC8] hover:border-[#A8552E]'
            }`}
          >
            {type.label}
          </button>
        ))}
      </div>
    </div>
  );
}
