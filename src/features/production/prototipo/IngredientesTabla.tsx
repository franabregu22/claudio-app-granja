import { kgLinea, lineasDe, pctLinea, SECCIONES, type Linea } from './datos';
import { Tabla, td, tdR, thL, thR } from './ui';

/**
 * Ingredientes de una receta en sus dos secciones (Premezcla con 3 decimales, Macronutrientes). `columnaKg` es el
 * título de la columna de kg; `otra` agrega una segunda columna de kg (p. ej. el batch nuevo), alineada por índice.
 */
export function IngredientesTabla({ lineas, batchKg, nombre, columnaKg, otra }: {
  lineas: Linea[]; batchKg: number; nombre: (id: string) => string; columnaKg: string; otra?: { titulo: string; lineas: Linea[] };
}) {
  return (
    <Tabla cabecera={<><th className={thL}>Ingrediente</th><th className={thR}>%</th><th className={thR}>{columnaKg}</th>{otra && <th className={thR}>{otra.titulo}</th>}</>}>
      {SECCIONES.flatMap((s) => {
        const ls = lineasDe(lineas, s.id);
        const subtotal = ls.reduce((t, l) => t + l.kg, 0);
        return [
          <tr key={s.id} className="bg-[#FAF6EE]">
            <td className={`${td} text-xs font-semibold uppercase tracking-wide text-[#8A6A2E]`} colSpan={2}>{s.label}</td>
            <td className={`${tdR} text-xs text-gray-600`}>{ls.length ? kgLinea(subtotal, s.id) : '—'}</td>
            {otra && <td className={tdR} />}
          </tr>,
          ...ls.map((l) => (
            <tr key={`${s.id}-${l.ingredienteId}`}>
              <td className={`${td} pl-6`}>{nombre(l.ingredienteId)}</td>
              <td className={tdR}>{pctLinea(l.kg, batchKg, s.id)}</td>
              <td className={`${tdR} tabular-nums`}>{kgLinea(l.kg, s.id)}</td>
              {otra && <td className={`${tdR} tabular-nums`}>{kgLinea(otra.lineas[lineas.indexOf(l)].kg, s.id)}</td>}
            </tr>
          )),
          ...(ls.length === 0 ? [<tr key={`${s.id}-vacio`}><td className={`${td} pl-6 text-gray-400`} colSpan={otra ? 4 : 3}>Sin ingredientes</td></tr>] : []),
        ];
      })}
    </Tabla>
  );
}
