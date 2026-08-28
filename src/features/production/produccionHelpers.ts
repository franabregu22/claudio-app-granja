import type { Produccion, Lote } from '../../types/domain';

export interface MetricasHoy {
  huevos_totales: number;
  mortandad_total: number;
  postura_promedio: number;
  variacion_vs_ayer: number;
}

export interface MetricasPeriodo {
  huevos_totales: number;
  mortandad_total: number;
  promedio_diario: number;
  variacion_vs_periodo_anterior: number;
  dias: number;
}

export interface PosturaPorGalpon {
  galpon: string;
  postura: number;
  huevos_totales: number;
  mortandad: number;
  lote_id?: string;
}

export interface Alerta {
  tipo: 'mortandad' | 'postura' | 'produccion';
  galpon: string;
  mensaje: string;
  severidad: 'warning' | 'error';
}

// Calcular aves actuales de un lote en una fecha específica
export function calcularAvesActuales(
  lote: Lote,
  producciones: Produccion[],
  hastaFecha: string
): number {
  const mortandadAcumulada = producciones
    .filter((p) => p.lote_id === lote.id && p.fecha <= hastaFecha)
    .reduce((acc, p) => acc + (p.mortandad || 0), 0);

  return Math.max(0, lote.aves_iniciales_postura - mortandadAcumulada);
}

// Calcular postura (huevos / aves_actuales)
export function calcularPostura(huevos: number, aves_actuales: number): number {
  if (aves_actuales === 0) return 0;
  return (huevos / aves_actuales) * 100;
}

// Obtener producción de un día específico
export function obtenerProduccionDia(
  producciones: Produccion[],
  fecha: string,
  galpon?: string
): Produccion[] {
  return producciones.filter(
    (p) => p.fecha === fecha && (!galpon || p.galpon === galpon)
  );
}

// Calcular huevos totales de un día
export function calcularHuevosDia(prod: Produccion[]): number {
  return prod.reduce((acc, p) => {
    const huevos = (p.huevos_totales_mediodia || 0) +
      (p.huevos_cachados_mediodia || 0) +
      (p.huevos_totales_tarde || 0) +
      (p.huevos_cachados_tarde || 0);
    return acc + huevos;
  }, 0);
}

// Calcular mortandad total de un día
export function calcularMortandadDia(prod: Produccion[]): number {
  return prod.reduce((acc, p) => acc + (p.mortandad || 0), 0);
}

// Métricas de HOY
export function calcularMetricasHoy(
  producciones: Produccion[],
  lotes: Lote[],
  hoy: string,
  ayer: string
): MetricasHoy {
  const prodHoy = obtenerProduccionDia(producciones, hoy);
  const prodAyer = obtenerProduccionDia(producciones, ayer);

  const huevos_hoy = calcularHuevosDia(prodHoy);
  const huevos_ayer = calcularHuevosDia(prodAyer);
  const mortandad_hoy = calcularMortandadDia(prodHoy);

  // Postura promedio de hoy
  let postura_promedio = 0;
  if (prodHoy.length > 0) {
    const posturas = prodHoy.map((p) => {
      const lote = lotes.find((l) => l.id === p.lote_id);
      if (!lote) return 0;
      const aves_actuales = calcularAvesActuales(lote, producciones, hoy);
      const huevos = (p.huevos_totales_mediodia || 0) +
        (p.huevos_cachados_mediodia || 0) +
        (p.huevos_totales_tarde || 0) +
        (p.huevos_cachados_tarde || 0);
      return calcularPostura(huevos, aves_actuales);
    });
    postura_promedio = posturas.reduce((a, b) => a + b, 0) / posturas.length;
  }

  const variacion = huevos_ayer > 0 ? ((huevos_hoy - huevos_ayer) / huevos_ayer) * 100 : 0;

  return {
    huevos_totales: huevos_hoy,
    mortandad_total: mortandad_hoy,
    postura_promedio,
    variacion_vs_ayer: variacion,
  };
}

// Métricas de SEMANA
export function calcularMetricasSemana(
  producciones: Produccion[],
  lotes: Lote[],
  inicioSemanaActual: string,
  inicioSemanaPasada: string,
  finSemanaActual: string,
  finSemanaPasada: string
): { actual: MetricasPeriodo; pasada: MetricasPeriodo } {
  const prodActual = producciones.filter(
    (p) => p.fecha >= inicioSemanaActual && p.fecha <= finSemanaActual
  );
  const prodPasada = producciones.filter(
    (p) => p.fecha >= inicioSemanaPasada && p.fecha <= finSemanaPasada
  );

  const huevos_actual = calcularHuevosDia(prodActual);
  const huevos_pasada = calcularHuevosDia(prodPasada);
  const mortandad_actual = calcularMortandadDia(prodActual);
  const mortandad_pasada = calcularMortandadDia(prodPasada);

  const dias_actual = new Set(prodActual.map((p) => p.fecha)).size || 1;
  const dias_pasada = new Set(prodPasada.map((p) => p.fecha)).size || 1;

  const variacion =
    huevos_pasada > 0 ? ((huevos_actual - huevos_pasada) / huevos_pasada) * 100 : 0;

  return {
    actual: {
      huevos_totales: huevos_actual,
      mortandad_total: mortandad_actual,
      promedio_diario: Math.round(huevos_actual / dias_actual),
      variacion_vs_periodo_anterior: variacion,
      dias: dias_actual,
    },
    pasada: {
      huevos_totales: huevos_pasada,
      mortandad_total: mortandad_pasada,
      promedio_diario: Math.round(huevos_pasada / dias_pasada),
      variacion_vs_periodo_anterior: 0,
      dias: dias_pasada,
    },
  };
}

// Métricas de MES
export function calcularMetricasMes(
  producciones: Produccion[],
  inicioMesActual: string,
  inicioMesPasado: string,
  finMesActual: string,
  finMesPasado: string
): { actual: MetricasPeriodo; pasado: MetricasPeriodo } {
  const prodActual = producciones.filter(
    (p) => p.fecha >= inicioMesActual && p.fecha <= finMesActual
  );
  const prodPasada = producciones.filter(
    (p) => p.fecha >= inicioMesPasado && p.fecha <= finMesPasado
  );

  const huevos_actual = calcularHuevosDia(prodActual);
  const huevos_pasada = calcularHuevosDia(prodPasada);
  const mortandad_actual = calcularMortandadDia(prodActual);
  const mortandad_pasada = calcularMortandadDia(prodPasada);

  const dias_actual = new Set(prodActual.map((p) => p.fecha)).size || 1;
  const dias_pasada = new Set(prodPasada.map((p) => p.fecha)).size || 1;

  const variacion =
    huevos_pasada > 0 ? ((huevos_actual - huevos_pasada) / huevos_pasada) * 100 : 0;

  return {
    actual: {
      huevos_totales: huevos_actual,
      mortandad_total: mortandad_actual,
      promedio_diario: Math.round(huevos_actual / dias_actual),
      variacion_vs_periodo_anterior: variacion,
      dias: dias_actual,
    },
    pasado: {
      huevos_totales: huevos_pasada,
      mortandad_total: mortandad_pasada,
      promedio_diario: Math.round(huevos_pasada / dias_pasada),
      variacion_vs_periodo_anterior: 0,
      dias: dias_pasada,
    },
  };
}

// Postura por galpón
export function calcularPosturaPorGalpon(
  producciones: Produccion[],
  lotes: Lote[],
  fecha: string
): PosturaPorGalpon[] {
  const galpones = Array.from(new Set(producciones.map((p) => p.galpon)));

  return galpones.map((galpon) => {
    const prod = obtenerProduccionDia(producciones, fecha, galpon);
    const huevos = calcularHuevosDia(prod);
    const mortandad = calcularMortandadDia(prod);

    // Obtener lote activo del galpón
    const lote = lotes.find(
      (l) =>
        l.galpon === galpon &&
        !l.fecha_salida &&
        l.fecha_entrada <= fecha &&
        l.estado === 'Activo'
    );

    const aves_actuales = lote
      ? calcularAvesActuales(lote, producciones, fecha)
      : 0;
    const postura = calcularPostura(huevos, aves_actuales);

    return {
      galpon,
      postura: Math.round(postura * 10) / 10,
      huevos_totales: huevos,
      mortandad,
      lote_id: lote?.lote_id,
    };
  });
}

// Generar alertas
export function generarAlertas(
  producciones: Produccion[],
  lotes: Lote[],
  hoy: string,
  ayer: string
): Alerta[] {
  const alertas: Alerta[] = [];
  const posturaHoy = calcularPosturaPorGalpon(producciones, lotes, hoy);
  const posturaAyer = calcularPosturaPorGalpon(producciones, lotes, ayer);
  const prodHoy = obtenerProduccionDia(producciones, hoy);

  // Alerta: Mortandad anormal (>2%)
  prodHoy.forEach((p) => {
    const lote = lotes.find((l) => l.id === p.lote_id);
    if (lote) {
      const aves_actuales = calcularAvesActuales(lote, producciones, hoy);
      const mortandad_pct = (p.mortandad / aves_actuales) * 100;
      if (mortandad_pct > 2) {
        alertas.push({
          tipo: 'mortandad',
          galpon: p.galpon,
          mensaje: `Mortandad alta: ${mortandad_pct.toFixed(1)}% (${p.mortandad} aves)`,
          severidad: mortandad_pct > 3 ? 'error' : 'warning',
        });
      }
    }
  });

  // Alerta: Caída de postura (>5%)
  posturaHoy.forEach((hoy_gal) => {
    const ayer_gal = posturaAyer.find((a) => a.galpon === hoy_gal.galpon);
    if (ayer_gal) {
      const caida = ayer_gal.postura - hoy_gal.postura;
      if (caida > 5) {
        alertas.push({
          tipo: 'postura',
          galpon: hoy_gal.galpon,
          mensaje: `Caída de postura: ${hoy_gal.postura.toFixed(1)}% (ayer: ${ayer_gal.postura.toFixed(1)}%)`,
          severidad: caida > 10 ? 'error' : 'warning',
        });
      }
    }
  });

  return alertas;
}

// Últimas 4 semanas (semana a semana)
export interface SemanaTendencia {
  semana: string;
  huevos: number;
  postura_promedio: number;
  mortandad: number;
}

export function calcularUltimas4Semanas(
  producciones: Produccion[],
  lotes: Lote[],
  hastaFecha: string
): SemanaTendencia[] {
  const semanas: SemanaTendencia[] = [];
  const fecha = new Date(hastaFecha);

  for (let i = 0; i < 4; i++) {
    const finSemana = new Date(fecha);
    finSemana.setDate(finSemana.getDate() - i * 7);

    const inicioSemana = new Date(finSemana);
    inicioSemana.setDate(inicioSemana.getDate() - 6);

    const inicio = inicioSemana.toISOString().split('T')[0];
    const fin = finSemana.toISOString().split('T')[0];

    const prod = producciones.filter((p) => p.fecha >= inicio && p.fecha <= fin);

    const huevos = calcularHuevosDia(prod);
    const mortandad = calcularMortandadDia(prod);

    let postura_promedio = 0;
    if (prod.length > 0) {
      const posturas = prod.map((p) => {
        const lote = lotes.find((l) => l.id === p.lote_id);
        if (!lote) return 0;
        const aves_actuales = calcularAvesActuales(lote, producciones, fin);
        const huevos_prod = (p.huevos_totales_mediodia || 0) +
          (p.huevos_cachados_mediodia || 0) +
          (p.huevos_totales_tarde || 0) +
          (p.huevos_cachados_tarde || 0);
        return calcularPostura(huevos_prod, aves_actuales);
      });
      postura_promedio =
        posturas.reduce((a, b) => a + b, 0) / posturas.length;
    }

    const week = `${inicioSemana.getDate()}/${inicioSemana.getMonth() + 1} - ${finSemana.getDate()}/${finSemana.getMonth() + 1}`;

    semanas.unshift({
      semana: week,
      huevos,
      postura_promedio: Math.round(postura_promedio * 10) / 10,
      mortandad,
    });
  }

  return semanas;
}
