import { CATEGORIAS } from '../../constants/categorias';
import type { Lineas, Precios } from '../../types/domain';

export function lineasVacias(): Lineas {
  return {
    xl: 0,
    n1: 0,
    n2: 0,
    n3: 0,
    docena: 0,
  };
}

export function totalUnidades(lineas: Lineas): number {
  return Object.values(lineas).reduce((a, b) => a + b, 0);
}

export function totalPedido(lineas: Lineas, precios: Precios): number {
  return CATEGORIAS.reduce(
    (acc, c) => acc + lineas[c.id] * (precios[c.id] || 0),
    0
  );
}

export function formatoPesos(n: number): string {
  return n.toLocaleString('es-AR', {
    style: 'currency',
    currency: 'ARS',
    maximumFractionDigits: 0,
  });
}

export function resumenLineas(lineas: Lineas): string {
  return CATEGORIAS.filter((c) => lineas[c.id] > 0)
    .map((c) => `${lineas[c.id]} ${c.label}`)
    .join(' · ');
}
