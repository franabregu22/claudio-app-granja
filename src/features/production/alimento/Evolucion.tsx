import { CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { etiquetaMes } from './format';

/** Categorical palette validated for CVD and contrast on white (5 slots); a 6th+ series falls back to gray. */
const PALETA = ['#B4532A', '#1F72B8', '#6B8E23', '#8E44AD', '#00897B'];

/** `colorIndex` is fixed per feed type (its position in the full list), so a filter never repaints a recipe. */
export interface Serie { id: string; nombre: string; colorIndex: number; valores: (number | null)[] }

/** Monthly evolution: one 2px line per feed type, tooltip with every type of the month, legend below. */
export function Evolucion({ meses, series, formato, dominio }: { meses: string[]; series: Serie[]; formato: (n: number) => string; dominio?: [number, number] }) {
  const datos = meses.map((m, i) => ({ mes: etiquetaMes(m), ...Object.fromEntries(series.map((s) => [s.id, s.valores[i]])) }));
  return (
    <div className="bg-white rounded-lg border border-amber-200 p-2 mb-2 h-56">
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={datos} margin={{ top: 8, right: 16, bottom: 0, left: 8 }}>
          <CartesianGrid stroke="#F1EBDD" vertical={false} />
          <XAxis dataKey="mes" tick={{ fontSize: 12, fill: '#6B5D45' }} axisLine={{ stroke: '#E4DCC8' }} tickLine={false} />
          <YAxis tick={{ fontSize: 11, fill: '#6B5D45' }} axisLine={false} tickLine={false} width={72} domain={dominio ?? [0, 'auto']} allowDataOverflow={!!dominio}
            tickFormatter={(v: number) => formato(v)} />
          <Tooltip formatter={(v) => (typeof v === 'number' ? formato(v) : '—')} contentStyle={{ fontSize: 12, borderColor: '#E4DCC8', borderRadius: 8 }} />
          {series.length > 1 && <Legend wrapperStyle={{ fontSize: 12 }} iconType="plainline" />}
          {series.map((s) => (
            <Line key={s.id} type="monotone" dataKey={s.id} name={s.nombre} stroke={PALETA[s.colorIndex] ?? '#8A7A5C'} strokeWidth={2}
              dot={{ r: 4, strokeWidth: 2, fill: '#fff' }} activeDot={{ r: 5 }} connectNulls={false} isAnimationActive={false} />
          ))}
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
