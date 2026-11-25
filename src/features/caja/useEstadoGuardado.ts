import { useEffect, useState } from 'react';

/**
 * Owner 2026-11-24: the filters of the movement list are kept when changing tab or section (the component unmounts). Kept in memory
 * for the app's life and in sessionStorage for a reload of the same browser tab; storage may be unavailable (private mode): then only
 * memory. A per-viewer convenience: never data.
 */
const memoria = new Map<string, unknown>();
const PREFIJO = 'granja:';

function leer<T>(clave: string, inicial: T): T {
  if (memoria.has(clave)) return memoria.get(clave) as T;
  try {
    const s = sessionStorage.getItem(PREFIJO + clave);
    if (s !== null) return JSON.parse(s) as T;
  } catch { /* storage unavailable or a damaged value: the initial one */ }
  return inicial;
}

/** Sets a saved value from elsewhere (e.g. Resultados opens Caja on «Pendientes de clasificar»): read when the component mounts. */
export function guardarEstado<T>(clave: string, valor: T) {
  memoria.set(clave, valor);
  try { sessionStorage.setItem(PREFIJO + clave, JSON.stringify(valor)); } catch { /* memory only */ }
}

export function useEstadoGuardado<T>(clave: string, inicial: T | (() => T), ajustar: (guardado: T) => T = (g) => g) {
  const [valor, setValor] = useState<T>(() => {
    const base = typeof inicial === 'function' ? (inicial as () => T)() : inicial;
    return ajustar(leer(clave, base));
  });
  useEffect(() => {
    memoria.set(clave, valor);
    try { sessionStorage.setItem(PREFIJO + clave, JSON.stringify(valor)); } catch { /* memory only */ }
  }, [clave, valor]);
  return [valor, setValor] as const;
}
