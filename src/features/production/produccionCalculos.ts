import type { Produccion, Lote, RecuentoLote } from '../../types/domain';

// ============================================================================
// CÁLCULOS BÁSICOS
// ============================================================================

export function calcularHuevosTotales(prod: Produccion): number {
  return (
    (prod.huevos_sanos_mediodia || 0) +
    (prod.huevos_cachados_mediodia || 0) +
    (prod.huevos_sanos_tarde || 0) +
    (prod.huevos_cachados_tarde || 0)
  );
}

export function calcularHuevosSanos(prod: Produccion): number {
  return (prod.huevos_sanos_mediodia || 0) + (prod.huevos_sanos_tarde || 0);
}

export function calcularHuevosCachados(prod: Produccion): number {
  return (prod.huevos_cachados_mediodia || 0) + (prod.huevos_cachados_tarde || 0);
}

export function calcularRatioCachados(huevosTotal: number, huevosCachados: number): number {
  if (huevosTotal === 0) return 0;
  return (huevosCachados / huevosTotal) * 100;
}

// ============================================================================
// CÁLCULO DE GALLINAS ACTUALES (la parte crítica)
// ============================================================================

/**
 * Obtiene el recuento más reciente anterior o igual a una fecha
 */
export function obtenerRecuentoMasReciente(
  loteId: string,
  recuentos: RecuentoLote[],
  hastaFecha: string
): RecuentoLote | null {
  return recuentos
    .filter((r) => r.lote_id === loteId && r.fecha_recuento <= hastaFecha)
    .sort((a, b) => b.fecha_recuento.localeCompare(a.fecha_recuento))[0] || null;
}

/**
 * Calcula gallinas actuales considerando recuentos esporádicos
 *
 * Si hay recuento: aves_contadas - mortandad_posterior_al_recuento
 * Si no hay recuento: aves_iniciales - mortandad_acumulada_total
 */
export function calcularGalinasActuales(
  lote: Lote,
  producciones: Produccion[],
  recuentos: RecuentoLote[],
  hastaFecha: string
): number {
  const recuentoMasReciente = obtenerRecuentoMasReciente(lote.id, recuentos, hastaFecha);

  if (recuentoMasReciente) {
    // Usar recuento como base y restar mortandad posterior
    const mortandadPostRecuento = producciones
      .filter(
        (p) =>
          p.lote_id === lote.id &&
          p.fecha > recuentoMasReciente.fecha_recuento &&
          p.fecha <= hastaFecha
      )
      .reduce((acc, p) => acc + (p.mortandad || 0), 0);

    return Math.max(0, recuentoMasReciente.aves_contadas - mortandadPostRecuento);
  } else {
    // No hay recuento, usar cálculo desde el inicio
    const mortandadAcumulada = producciones
      .filter((p) => p.lote_id === lote.id && p.fecha <= hastaFecha)
      .reduce((acc, p) => acc + (p.mortandad || 0), 0);

    return Math.max(0, lote.aves_iniciales_postura - mortandadAcumulada);
  }
}

// ============================================================================
// CÁLCULO DE POSTURA
// ============================================================================

export function calcularPostura(huevosSanos: number, galinasActuales: number): number {
  if (galinasActuales === 0) return 0;
  return (huevosSanos / galinasActuales) * 100;
}

// ============================================================================
// AGREGACIONES POR PERÍODO
// ============================================================================

export interface MetricaPeriodo {
  huevos_totales: number;
  huevos_sanos: number;
  huevos_cachados: number;
  ratio_cachados: number;
  mortandad_total: number;
  postura_promedio: number;
  dias: number;
  variacion_vs_periodo_anterior: number;
}

export interface MetricaPorGalpon {
  galpon: string;
  lote_id?: string;
  huevos_totales: number;
  huevos_sanos: number;
  huevos_cachados: number;
  mortandad: number;
  postura: number;
  galinasActuales: number;
}

export interface Alerta {
  tipo: 'postura' | 'mortandad' | 'cachados';
  galpon: string;
  mensaje: string;
  severidad: 'warning' | 'error';
}

// ============================================================================
// CÁLCULOS PRINCIPALES
// ============================================================================

export function calcularMetricasPeriodo(
  producciones: Produccion[],
  lotes: Lote[],
  recuentos: RecuentoLote[],
  fechaInicio: string,
  fechaFin: string
): MetricaPeriodo {
  const prodDelPeriodo = producciones.filter(
    (p) => p.fecha >= fechaInicio && p.fecha <= fechaFin
  );

  const huevos_totales = prodDelPeriodo.reduce((acc, p) => acc + calcularHuevosTotales(p), 0);
  const huevos_sanos = prodDelPeriodo.reduce((acc, p) => acc + calcularHuevosSanos(p), 0);
  const huevos_cachados = prodDelPeriodo.reduce((acc, p) => acc + calcularHuevosCachados(p), 0);
  const mortandad_total = prodDelPeriodo.reduce((acc, p) => acc + (p.mortandad || 0), 0);

  const dias = new Set(prodDelPeriodo.map((p) => p.fecha)).size;

  // Calcular postura promedio del período
  let postura_promedio = 0;
  if (prodDelPeriodo.length > 0 && huevos_sanos > 0) {
    // Agrupar por lote y calcular postura de cada uno
    const posturasPorLote = [...new Set(prodDelPeriodo.map((p) => p.lote_id))]
      .filter(Boolean)
      .map((loteId) => {
        const lote = lotes.find((l) => l.id === loteId);
        if (!lote) return 0;
        const galinasActuales = calcularGalinasActuales(lote, producciones, recuentos, fechaFin);
        const huevosDelLote = prodDelPeriodo
          .filter((p) => p.lote_id === loteId)
          .reduce((acc, p) => acc + calcularHuevosSanos(p), 0);
        return calcularPostura(huevosDelLote, galinasActuales);
      });

    postura_promedio = posturasPorLote.length > 0
      ? posturasPorLote.reduce((a, b) => a + b, 0) / posturasPorLote.length
      : 0;
  }

  return {
    huevos_totales,
    huevos_sanos,
    huevos_cachados,
    ratio_cachados: calcularRatioCachados(huevos_totales, huevos_cachados),
    mortandad_total,
    postura_promedio,
    dias,
    variacion_vs_periodo_anterior: 0, // Se calcula después si hay período anterior
  };
}

export function calcularMetricasPorGalpon(
  producciones: Produccion[],
  lotes: Lote[],
  recuentos: RecuentoLote[],
  fecha: string
): MetricaPorGalpon[] {
  const galpones = [...new Set(producciones.filter((p) => p.fecha === fecha).map((p) => p.galpon))];

  return galpones
    .map((galpon) => {
      const prodsDelGalpon = producciones.filter((p) => p.fecha === fecha && p.galpon === galpon);
      const lote = lotes.find((l) => l.id === prodsDelGalpon[0]?.lote_id);

      if (!lote) return null;

      const huevos_totales = prodsDelGalpon.reduce((acc, p) => acc + calcularHuevosTotales(p), 0);
      const huevos_sanos = prodsDelGalpon.reduce((acc, p) => acc + calcularHuevosSanos(p), 0);
      const huevos_cachados = prodsDelGalpon.reduce((acc, p) => acc + calcularHuevosCachados(p), 0);
      const mortandad = prodsDelGalpon.reduce((acc, p) => acc + (p.mortandad || 0), 0);
      const galinasActuales = calcularGalinasActuales(lote, producciones, recuentos, fecha);
      const postura = calcularPostura(huevos_sanos, galinasActuales);

      return {
        galpon,
        lote_id: lote.id,
        huevos_totales,
        huevos_sanos,
        huevos_cachados,
        mortandad,
        postura,
        galinasActuales,
      };
    })
    .filter(Boolean) as MetricaPorGalpon[];
}

// ============================================================================
// ALERTAS
// ============================================================================

export function generarAlertas(
  producciones: Produccion[],
  lotes: Lote[],
  recuentos: RecuentoLote[],
  fecha: string
): Alerta[] {
  const alertas: Alerta[] = [];
  const metricasPorGalpon = calcularMetricasPorGalpon(producciones, lotes, recuentos, fecha);

  metricasPorGalpon.forEach((metrica) => {
    // Alerta de postura baja
    if (metrica.postura < 80) {
      alertas.push({
        tipo: 'postura',
        galpon: metrica.galpon,
        mensaje: `Postura baja: ${metrica.postura.toFixed(1)}%`,
        severidad: metrica.postura < 70 ? 'error' : 'warning',
      });
    }

    // Alerta de mortandad alta (más de 5 aves en un día)
    if (metrica.mortandad > 5) {
      alertas.push({
        tipo: 'mortandad',
        galpon: metrica.galpon,
        mensaje: `Mortandad elevada: ${metrica.mortandad} aves`,
        severidad: metrica.mortandad > 10 ? 'error' : 'warning',
      });
    }

    // Alerta de muchos huevos cachados (>10%)
    const ratioCachados = metrica.huevos_totales > 0
      ? (metrica.huevos_cachados / metrica.huevos_totales) * 100
      : 0;
    if (ratioCachados > 10) {
      alertas.push({
        tipo: 'cachados',
        galpon: metrica.galpon,
        mensaje: `Huevos cachados alto: ${ratioCachados.toFixed(1)}%`,
        severidad: 'warning',
      });
    }
  });

  return alertas;
}

// ============================================================================
// SPARKLINE DATA (últimos 7 días)
// ============================================================================

export interface SparklineData {
  fecha: string;
  postura: number;
}

export function calcularSparklineUltimos7Dias(
  producciones: Produccion[],
  lotes: Lote[],
  recuentos: RecuentoLote[],
  hastaFecha: string
): SparklineData[] {
  const data: SparklineData[] = [];

  for (let i = 6; i >= 0; i--) {
    const fecha = new Date(hastaFecha);
    fecha.setDate(fecha.getDate() - i);
    const fechaStr = fecha.toISOString().split('T')[0];

    const metrica = calcularMetricasPeriodo(producciones, lotes, recuentos, fechaStr, fechaStr);
    data.push({
      fecha: fechaStr,
      postura: metrica.postura_promedio,
    });
  }

  return data;
}
