import { CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { etiquetaMes, MESES } from './datos';

/** Color fijo por receta (sigue a la entidad, no al orden). Paleta validada (CVD y contraste sobre blanco). */
const COLOR: Record<string, string> = { postura: '#B4532A', recria: '#1F72B8', prepostura: '#6B8E23' };
const colorReceta = (id: string) => COLOR[id] ?? '#8A7A5C';

export interface Serie { id: string; nombre: string; valores: (number | null)[] }

/** Evolución mensual: una línea por tipo (2px, marcadores), tooltip con todos los tipos del mes, leyenda abajo. */
export function Evolucion({ series, formato, dominio }: { series: Serie[]; formato: (n: number) => string; dominio?: [number, number] }) {
  const datos = MESES.map((m, i) => ({ mes: etiquetaMes(m), ...Object.fromEntries(series.map((s) => [s.id, s.valores[i]])) }));
  return (
    <div className="bg-white rounded-lg border border-amber-200 p-2 mb-2 h-56">
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={datos} margin={{ top: 8, right: 16, bottom: 0, left: 8 }}>
          <CartesianGrid stroke="#F1EBDD" vertical={false} />
          <XAxis dataKey="mes" tick={{ fontSize: 12, fill: '#6B5D45' }} axisLine={{ stroke: '#E4DCC8' }} tickLine={false} />
          <YAxis tick={{ fontSize: 11, fill: '#6B5D45' }} axisLine={false} tickLine={false} width={72} domain={dominio ?? [0, 'auto']} tickFormatter={(v: number) => formato(v)} />
          <Tooltip formatter={(v) => (typeof v === 'number' ? formato(v) : '—')} contentStyle={{ fontSize: 12, borderColor: '#E4DCC8', borderRadius: 8 }} />
          {series.length > 1 && <Legend wrapperStyle={{ fontSize: 12 }} iconType="plainline" />}
          {series.map((s) => (
            <Line key={s.id} type="monotone" dataKey={s.id} name={s.nombre} stroke={colorReceta(s.id)} strokeWidth={2}
              dot={{ r: 4, strokeWidth: 2, fill: '#fff' }} activeDot={{ r: 5 }} connectNulls={false} isAnimationActive={false} />
          ))}
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
