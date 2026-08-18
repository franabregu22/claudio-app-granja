export type NaturalezaGasto = 'gasto_operativo' | 'reinversion_operativa' | 'inversion' | 'distribucion_ganancias' | 'ajuste_contable';

export interface CategoriaSubcategoria {
  categoria: string;
  subcategorias: string[];
  naturalezaDefault?: NaturalezaGasto;
}

export const CATEGORIAS_EGRESOS: CategoriaSubcategoria[] = [
  {
    categoria: 'Insumos alimento balanceado',
    subcategorias: ['Sal', 'Metionina', 'Nucleo Brower con Fitasas', 'Ciromazina', 'Conchilla', 'Maiz', 'Expeller de Soja', 'Harina de carne', 'Secuestrante Micotoxinas', 'Compras viejas', 'Carbonato de calcio'],
    naturalezaDefault: 'gasto_operativo',
  },
  {
    categoria: 'Cartones / envases',
    subcategorias: ['Manga x125U - Maples30u', 'Manga x125U - Maples20u', 'Manga x125U - Docenas'],
    naturalezaDefault: 'gasto_operativo',
  },
  {
    categoria: 'Mano de obra',
    subcategorias: ['Sueldos empleados', 'Jornales', 'Horas extra', 'Trabajos chacra'],
    naturalezaDefault: 'gasto_operativo',
  },
  {
    categoria: 'Retiros de socios',
    subcategorias: ['Santi', 'Fran', 'Padres'],
    naturalezaDefault: 'distribucion_ganancias',
  },
  {
    categoria: 'Combustible',
    subcategorias: ['Gasoil', 'Nafta'],
    naturalezaDefault: 'gasto_operativo',
  },
  {
    categoria: 'Servicios',
    subcategorias: ['Electricidad', 'Canon de riego', 'Telefonía / Internet', 'Otros servicios', 'Contador', 'Veterinario'],
    naturalezaDefault: 'gasto_operativo',
  },
  {
    categoria: 'Materiales / Repuestos',
    subcategorias: ['Repuestos', 'Herramientas', 'Materiales', 'Arreglos edilicios', 'Servicios técnicos'],
    naturalezaDefault: 'reinversion_operativa',
  },
  {
    categoria: 'Logística / Fletes',
    subcategorias: ['Flete Insumos balanceado', 'Flete Varios', 'Flete Cartones', 'Flete Guano'],
    naturalezaDefault: 'gasto_operativo',
  },
  {
    categoria: 'Impuestos y tasas',
    subcategorias: ['Monotributo', 'IVA', 'Ganancias', 'Comisiones', 'Otros impuestos'],
    naturalezaDefault: 'ajuste_contable',
  },
  {
    categoria: 'Insumos varios',
    subcategorias: ['Agua potable', 'Gas', 'Medicamentos', 'Otros', 'Chacra'],
    naturalezaDefault: 'gasto_operativo',
  },
  {
    categoria: 'Recria',
    subcategorias: ['Pollitas BB'],
    naturalezaDefault: 'inversion',
  },
  {
    categoria: 'Otros',
    subcategorias: ['Gastos no clasificados'],
    naturalezaDefault: 'gasto_operativo',
  },
];

export const CATEGORIAS_INGRESOS: CategoriaSubcategoria[] = [
  {
    categoria: 'Ventas',
    subcategorias: ['Huevos'],
  },
  {
    categoria: 'Subproductos',
    subcategorias: ['Plumas', 'Estiércol', 'Otros'],
  },
  {
    categoria: 'Otros ingresos',
    subcategorias: ['Devoluciones', 'Bonificaciones', 'Extraordinarios'],
  },
];

export const NATURALEZA_LABELS: Record<NaturalezaGasto, string> = {
  gasto_operativo: 'Gasto Operativo',
  reinversion_operativa: 'Reinversión Operativa',
  inversion: 'Inversión',
  distribucion_ganancias: 'Distribución de Ganancias',
  ajuste_contable: 'Ajuste Contable',
};
