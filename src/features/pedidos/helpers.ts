import { CATEGORIAS } from '../../constants/categorias';
import type { Lineas, Precios, LineaPedido, Producto } from '../../types/domain';

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

export function formatoPesos(n: number | null | undefined): string {
  const num = Number(n) || 0;
  if (isNaN(num)) return '$0';
  return num.toLocaleString('es-AR', {
    style: 'currency',
    currency: 'ARS',
    maximumFractionDigits: 0,
  });
}

export function resumenLineas(lineas: Lineas | LineaPedido[] | any): string {
  // Handle new generic structure
  if (Array.isArray(lineas)) {
    return (lineas as LineaPedido[])
      .filter((l) => l && l.cantidad > 0)
      .map((l) => `${l.cantidad} ${l.producto_nombre}`)
      .join(' · ');
  }

  // Handle old structure (object with categorias)
  if (!lineas) return '';
  return CATEGORIAS.filter((c) => (lineas as any)[c.id] > 0)
    .map((c) => `${(lineas as any)[c.id]} ${c.label}`)
    .join(' · ');
}

export function formatoPedidoId(id: number): string {
  return String(id).padStart(3, '0');
}

// Generic helpers for new LineaPedido structure
export function lineasGenericasVacias(): LineaPedido[] {
  return [];
}

export function totalUnidadesGeneric(lineas: LineaPedido[]): number {
  if (!lineas || !Array.isArray(lineas)) return 0;
  return lineas.reduce((acc, linea) => {
    if (!linea) return acc;
    const cantidad = typeof linea.cantidad === 'string' ? Number(linea.cantidad) : linea.cantidad || 0;
    return acc + (isNaN(cantidad) ? 0 : cantidad);
  }, 0);
}

export function totalPedidoGeneric(lineas: LineaPedido[]): number {
  if (!lineas || !Array.isArray(lineas)) return 0;
  console.log('totalPedidoGeneric recibió:', JSON.stringify(lineas, null, 2));
  const result = lineas.reduce((acc, linea) => {
    if (!linea) return acc;
    const subtotal = typeof linea.subtotal === 'string' ? Number(linea.subtotal) : linea.subtotal || 0;
    console.log(`Línea ${linea.producto_nombre}: subtotal=${subtotal}, acc=${acc}`);
    return acc + (isNaN(subtotal) ? 0 : subtotal);
  }, 0);
  console.log('totalPedidoGeneric resultado:', result);
  return result;
}

export function resumenLineasGeneric(lineas: LineaPedido[]): string {
  return lineas
    .filter((l) => l.cantidad > 0)
    .map((l) => `${l.cantidad} ${l.producto_nombre}`)
    .join(' · ');
}

export function agregarLineaPedido(
  lineas: LineaPedido[],
  producto: Producto,
  cantidad: number
): LineaPedido[] {
  const existente = lineas.find((l) => l.producto_id === producto.id);

  if (existente) {
    return lineas.map((l) =>
      l.producto_id === producto.id
        ? {
            ...l,
            cantidad,
            subtotal: cantidad * existente.precio_unitario,
          }
        : l
    );
  }

  // Initialize with precio_unitario = 0 (user will enter it manually)
  return [
    ...lineas,
    {
      producto_id: producto.id,
      producto_nombre: producto.nombre,
      cantidad,
      precio_unitario: 0,
      subtotal: 0,
    },
  ];
}

export function removerLineaPedido(
  lineas: LineaPedido[],
  producto_id: string
): LineaPedido[] {
  return lineas.filter((l) => l.producto_id !== producto_id);
}
