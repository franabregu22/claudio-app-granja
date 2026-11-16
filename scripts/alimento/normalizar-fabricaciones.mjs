#!/usr/bin/env node
/**
 * Alimento Balanceado — normaliza el historial de fabricaciones del owner (planilla «Producción») para la carga
 * inicial. SOLO LEE el CSV de origen y escribe un CSV normalizado; no toca ninguna base.
 *
 * Decisiones del owner (2026-11-16):
 *   - Nombres: Fase I → «Ponedoras - Fase I», Fase I G03 → «Ponedoras - Fase I G03», Pre inicio → «Ponedoras - Pre Inicio»,
 *     Recria → «Ponedoras - Recria». Catálogo además: «Ponedoras - Pre postura» (sin fabricaciones todavía).
 *   - Filas «Stock final» (cierres viejos): se ignoran; el stock se contabiliza desde ahora.
 *   - Responsable «Santi / Fran» → «Santi». No hay duplicados: dos filas iguales son dos lotes. 110 kg es correcto.
 *   - Responsable → usuario: se resuelve al cargar (el CSV guarda el nombre, no el email).
 *   - Sin hora: la fabricación se registra por día (la columna Hora del origen se descarta).
 *
 * Uso: node scripts/alimento/normalizar-fabricaciones.mjs <origen.csv> <salida.csv>
 */
import { readFileSync, writeFileSync } from 'node:fs';

export const RECETAS = {
  'Fase I': 'Ponedoras - Fase I', 'Fase I G03': 'Ponedoras - Fase I G03', 'Pre inicio': 'Ponedoras - Pre Inicio', Recria: 'Ponedoras - Recria',
};
export const CATALOGO = [...Object.values(RECETAS), 'Ponedoras - Pre postura'];
const RESPONSABLE = { Andres: 'Andres', Fran: 'Fran', Santi: 'Santi', 'Santi / Fran': 'Santi' };

/** Devuelve { filas, ignoradas, errores } a partir del texto CSV de origen. */
export function normalizar(texto) {
  const [, ...lineas] = texto.trim().split(/\r?\n/);
  const filas = []; const ignoradas = []; const errores = [];
  lineas.forEach((l, i) => {
    const fila = i + 2;
    const [fecha, hora, tipo, kg, resp, ...obs] = l.split(',');
    if (fecha.trim().toLowerCase() === 'stock final') { ignoradas.push({ fila, motivo: 'stock final (cierre viejo)' }); return; }
    const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(fecha.trim());
    const receta = RECETAS[tipo.trim()];
    const kilos = Number(kg);
    const responsable = RESPONSABLE[resp.trim()];
    const problemas = [!m && `fecha «${fecha}»`, !receta && `receta «${tipo}»`, !(kilos > 0) && `kg «${kg}»`, !responsable && `responsable «${resp}»`,
      hora.trim() && !/^\d{2}:\d{2}$/.test(hora.trim()) && `hora «${hora}»`].filter(Boolean);
    if (problemas.length) { errores.push({ fila, problemas }); return; }
    filas.push({ fila_origen: fila, fecha: `${m[3]}-${m[2]}-${m[1]}`, receta, kg: kilos, responsable, comentario: obs.join(',').trim() });
  });
  filas.sort((a, b) => a.fecha.localeCompare(b.fecha) || a.fila_origen - b.fila_origen);
  return { filas, ignoradas, errores };
}

const csv = (v) => (/[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));

if (import.meta.url === `file:///${process.argv[1]?.replace(/\\/g, '/')}` || process.argv[1]?.endsWith('normalizar-fabricaciones.mjs')) {
  const [origen, salida] = process.argv.slice(2);
  if (!origen || !salida) { console.error('Uso: normalizar-fabricaciones.mjs <origen.csv> <salida.csv>'); process.exit(2); }
  const { filas, ignoradas, errores } = normalizar(readFileSync(origen, 'utf8'));
  const cols = ['fila_origen', 'fecha', 'receta', 'kg', 'responsable', 'comentario'];
  writeFileSync(salida, [cols.join(','), ...filas.map((f) => cols.map((c) => csv(f[c])).join(','))].join('\n') + '\n');
  const porReceta = {};
  for (const f of filas) { porReceta[f.receta] ??= { registros: 0, kg: 0 }; porReceta[f.receta].registros++; porReceta[f.receta].kg += f.kg; }
  console.log(JSON.stringify({ fabricaciones: filas.length, kg: filas.reduce((t, f) => t + f.kg, 0), porReceta, ignoradas, errores, catalogo: CATALOGO }, null, 1));
  if (errores.length) process.exit(1);
}
