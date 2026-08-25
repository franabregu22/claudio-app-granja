import type { Pedido } from '../../types/domain';

export interface MetricasPeriodoPedidos {
  pedidos_despachados: number;
  total_huevos: number;
  promedio_pedido: number;
  monto_total: number;
  despachos_por_presentacion: {
    xl: number;
    n1: number;
    n2: number;
    n3: number;
    docena: number;
  };
  dias_con_despachos: number;
}

function extraerLineas(lineas: any): Array<{ nombreProducto: string; cantidad: number }> {
  if (!lineas) return [];

  // Si es un array de LineaPedido (nuevo formato)
  if (Array.isArray(lineas)) {
    return lineas
      .map((l) => ({
        nombreProducto: l.producto_nombre || '',
        cantidad: parseInt(l.cantidad) || 0,
      }))
      .filter((l) => l.nombreProducto); // Solo incluir líneas con nombre
  }

  // Si es un objeto Lineas (viejo formato)
  if (typeof lineas === 'object' && !Array.isArray(lineas)) {
    const resultado = [];
    const mapeo: { [key: string]: string } = {
      xl: 'XL - Extra grande',
      n1: 'N1 - Grande',
      n2: 'N2 - Mediano',
      n3: 'N3 - Chico',
      docena: 'Docena',
    };

    for (const [key, cantidad] of Object.entries(lineas)) {
      if (mapeo[key]) {
        resultado.push({
          nombreProducto: mapeo[key],
          cantidad: (cantidad as number) || 0,
        });
      }
    }
    return resultado;
  }

  return [];
}

function calcularHuevosPorLinea(nombreProducto: string, cantidad: number): number {
  // Mapeo de presentación a huevos por maple/docena
  // Los nombres en la BD son: "XL - Extra grande", "N1 - Grande", "N2 - Mediano", "N3 - Chico", "Docena"

  const nombre = nombreProducto.toUpperCase();

  if (nombre.includes('XL')) {
    return 20 * cantidad;
  } else if (nombre.includes('N1')) {
    return 30 * cantidad;
  } else if (nombre.includes('N2')) {
    return 30 * cantidad;
  } else if (nombre.includes('N3')) {
    return 30 * cantidad;
  } else if (nombre.includes('DOCENA')) {
    return 12 * cantidad;
  }

  return 0; // Productos que no son huevos (ej: Alimento balanceado)
}

export function calcularMetricasPeriodoPedidos(
  pedidos: Pedido[],
  fechaInicio: string,
  fechaFin: string
): MetricasPeriodoPedidos {
  const pedidosDelPeriodo = pedidos.filter((p) => {
    if (p.estado === 'cancelado') return false;

    // Usar fecha_operacion (fecha de carga) para los cálculos, no entregado_en
    const fechaPedido = p.fecha_operacion || p.fecha_pedido;
    if (!fechaPedido) return false;

    // Comparar fechas
    return fechaPedido >= fechaInicio && fechaPedido <= fechaFin;
  });

  const despachos_por_presentacion = {
    xl: 0,
    n1: 0,
    n2: 0,
    n3: 0,
    docena: 0,
  };

  let total_huevos = 0;
  let monto_total = 0;

  pedidosDelPeriodo.forEach((pedido) => {
    monto_total += pedido.monto_total || 0;

    const lineas = extraerLineas(pedido.lineas);
    lineas.forEach((linea) => {
      const cantidad = typeof linea.cantidad === 'string' ? parseInt(linea.cantidad) : linea.cantidad;
      const huevos = calcularHuevosPorLinea(linea.nombreProducto, cantidad);
      total_huevos += huevos;

      const nombre = linea.nombreProducto.toUpperCase();
      if (nombre.includes('XL')) {
        despachos_por_presentacion.xl += cantidad;
      } else if (nombre.includes('N1')) {
        despachos_por_presentacion.n1 += cantidad;
      } else if (nombre.includes('N2')) {
        despachos_por_presentacion.n2 += cantidad;
      } else if (nombre.includes('N3')) {
        despachos_por_presentacion.n3 += cantidad;
      } else if (nombre.includes('DOCENA')) {
        despachos_por_presentacion.docena += cantidad;
      }
    });
  });

  const diasConDespachos = new Set(
    pedidosDelPeriodo
      .map((p) => p.fecha_operacion || p.fecha_pedido)
      .filter(Boolean)
  ).size;

  return {
    pedidos_despachados: pedidosDelPeriodo.length,
    total_huevos,
    promedio_pedido: pedidosDelPeriodo.length > 0 ? monto_total / pedidosDelPeriodo.length : 0,
    monto_total,
    despachos_por_presentacion,
    dias_con_despachos: diasConDespachos,
  };
}

export function calcularVariacionPorcentaje(actual: number, anterior: number): number {
  if (anterior === 0) return 0;
  return ((actual - anterior) / anterior) * 100;
}

export function formatearPedidoResumen(pedido: Pedido): string {
  const lineas = extraerLineas(pedido.lineas);
  if (lineas.length === 0) return '—';

  return lineas
    .filter((l) => l.cantidad > 0)
    .map((l) => `${l.nombreProducto}: ${l.cantidad}`)
    .join(' | ');
}

export interface DatosSemanaPedidos {
  semana: string; // formato "Lun 24/8", "Mar 25/8", etc - primer día de la semana
  fechaInicio: string;
  xl: number; // cantidad de huevos XL
  n1: number; // cantidad de huevos N1
  n2: number; // cantidad de huevos N2
  n3: number; // cantidad de huevos N3
  docena: number; // cantidad de huevos en docenas
}

// Obtener las últimas 6 semanas completas con datos por categoría
export function calcularUltimas6Semanas(pedidos: Pedido[]): DatosSemanaPedidos[] {
  // Obtener hoy en formato local sin problemas de zona horaria
  const hoy = new Date();
  const año = hoy.getFullYear();
  const mes = String(hoy.getMonth() + 1).padStart(2, '0');
  const día = String(hoy.getDate()).padStart(2, '0');
  const hoyStr = `${año}-${mes}-${día}`;

  const semanas: DatosSemanaPedidos[] = [];

  // Generar 6 semanas hacia atrás (41 días = 6 semanas - 1 día)
  for (let i = 5; i >= 0; i--) {
    const inicio = new Date(año, parseInt(mes) - 1, parseInt(día));
    inicio.setDate(inicio.getDate() - (i * 7 + ((inicio.getDay() + 6) % 7)));

    const fin = new Date(inicio);
    fin.setDate(fin.getDate() + 6);

    const fechaInicialStr = formatearFechaISO(inicio);
    const fechaFinalStr = formatearFechaISO(fin);

    const pedidosSemana = pedidos.filter((p) => {
      if (p.estado === 'cancelado') return false;
      const fechaPedido = p.fecha_operacion || p.fecha_pedido;
      if (!fechaPedido) return false;
      return fechaPedido >= fechaInicialStr && fechaPedido <= fechaFinalStr;
    });

    const huevosPorCategoria = {
      xl: 0,
      n1: 0,
      n2: 0,
      n3: 0,
      docena: 0,
    };

    pedidosSemana.forEach((pedido) => {
      const lineas = extraerLineas(pedido.lineas);
      lineas.forEach((linea) => {
        const cantidad = typeof linea.cantidad === 'string' ? parseInt(linea.cantidad) : linea.cantidad;
        const nombre = linea.nombreProducto.toUpperCase();
        const huevos = calcularHuevosPorLinea(linea.nombreProducto, cantidad);

        if (nombre.includes('XL')) {
          huevosPorCategoria.xl += huevos;
        } else if (nombre.includes('N1')) {
          huevosPorCategoria.n1 += huevos;
        } else if (nombre.includes('N2')) {
          huevosPorCategoria.n2 += huevos;
        } else if (nombre.includes('N3')) {
          huevosPorCategoria.n3 += huevos;
        } else if (nombre.includes('DOCENA')) {
          huevosPorCategoria.docena += huevos;
        }
      });
    });

    semanas.push({
      semana: formatearSemanaPrimерDia(inicio),
      fechaInicio: fechaInicialStr,
      ...huevosPorCategoria,
    });
  }

  return semanas;
}

function formatearFechaISO(date: Date): string {
  const año = date.getFullYear();
  const mes = String(date.getMonth() + 1).padStart(2, '0');
  const día = String(date.getDate()).padStart(2, '0');
  return `${año}-${mes}-${día}`;
}

function formatearSemanaPrimерDia(date: Date): string {
  const diasSemana = ['Dom', 'Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sab'];
  const diaSemana = diasSemana[date.getDay()];
  const día = date.getDate();
  const mes = date.getMonth() + 1;
  return `${diaSemana} ${día}/${mes}`;
}
