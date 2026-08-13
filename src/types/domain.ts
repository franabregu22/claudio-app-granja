export type Categoria = 'xl' | 'n1' | 'n2' | 'n3' | 'docena';
export type PedidoEstado = 'pendiente' | 'entregado' | 'cancelado';
export type MetodoPago = 'efectivo' | 'transferencia' | 'tarjeta' | 'mercadopago' | 'otro' | 'cheque' | 'echeq';
export type Rol = 'dueño' | 'repartidor' | 'colaborador';
export type ProductoCategoria = 'huevos' | 'cereales' | 'alimento' | 'subproducto' | 'otro';

// Legacy: mantener por compatibilidad temporal
export interface Lineas {
  xl: number;
  n1: number;
  n2: number;
  n3: number;
  docena: number;
}

export interface Precios {
  xl: number;
  n1: number;
  n2: number;
  n3: number;
  docena: number;
}

// New: Generic products structure
export interface Producto {
  id: string;
  nombre: string;
  categoria: ProductoCategoria;
  precio_actual: number;
  unidad: string;
  activo: boolean;
  creado_en: string;
  actualizado_en: string;
}

export interface LineaPedido {
  producto_id: string;
  producto_nombre: string;
  cantidad: number;
  precio_unitario: number;
  subtotal: number;
}

export type ClienteCategoria = 'particular' | 'comercio' | 'distribuidor' | 'feria municipal';

export interface Cliente {
  id: string;
  nombre: string;
  categoria: ClienteCategoria;
  activo: boolean;
  notas?: string;
  created_at: string;
}

export interface Pedido {
  id: number;
  cliente_id: string;
  cliente_nombre: string;
  // Support both old (Lineas object) and new (LineaPedido array) structures
  lineas?: Lineas | LineaPedido[];
  precios_snapshot?: Precios;
  lineas_generic?: LineaPedido[];
  monto_total: number;
  observaciones?: string;
  estado: PedidoEstado;
  rectificado: boolean;
  fecha_pedido?: string; // legacy
  fecha_operacion: string;
  fecha_pago?: string;
  creado_por: string | null;
  entregado_por: string | null;
  entregado_en: string | null;
  creado_en: string;
  actualizado_en: string;
}

export interface Pago {
  id: string;
  cliente_id: string;
  monto: number;
  metodo_pago: MetodoPago;
  fecha_pago: string;
  notas?: string;
  creado_en: string;
}

export interface ClienteSaldo {
  cliente_id: string;
  cliente_nombre: string;
  totalPedidos: number;
  totalPagado: number;
  saldo: number;
  pedidos: Pedido[];
  pagos: Pago[];
}

export interface Perfil {
  id: string;
  nombre: string | null;
  rol: Rol;
  created_at: string;
}

export interface Produccion {
  id: string;
  fecha: string;
  galpon: string;
  huevos_sanos_mediodia: number;
  huevos_cachados_mediodia: number;
  huevos_sanos_tarde: number;
  huevos_cachados_tarde: number;
  mortandad: number;
  observaciones?: string;
  creado_por: string | null;
  creado_en: string;
  actualizado_en: string;
}

export interface User {
  id: string;
  email?: string;
}

// Caja (Finanzas)
export type MovimientoTipo = 'ingreso' | 'egreso';
export type FormaPago = 'efectivo' | 'mercadopago' | 'echeq' | 'cheque';
export type MovimientoEstado = 'pendiente' | 'confirmado' | 'cancelado';
export type ChequeEstado = 'emitido' | 'cobrado' | 'rechazado' | 'cancelado';

export interface MovimientoCaja {
  id: number;
  tipo: MovimientoTipo;
  concepto: string;
  monto: number;
  forma_pago: FormaPago;
  fecha_operacion: string;
  fecha_pago: string;
  estado: MovimientoEstado;
  cuenta_origen?: string;
  cuenta_destino?: string;
  vinculado_a?: string; // 'pedido', 'pago', 'ninguno'
  vinculado_id?: number;
  notas?: string;
  creado_por: string | null;
  creado_en: string;
  actualizado_en: string;
}

export interface Cheque {
  id: number;
  numero: string;
  banco: string;
  monto: number;
  fecha_emision: string;
  fecha_vencimiento: string;
  girador: string;
  estado: ChequeEstado;
  movimiento_caja_id?: number;
  notas?: string;
  creado_por: string | null;
  creado_en: string;
  actualizado_en: string;
}

export interface Comision {
  id: number;
  concepto: string;
  monto: number;
  porcentaje?: number;
  base_monto?: number;
  fecha_operacion: string;
  estado: MovimientoEstado;
  movimiento_caja_id?: number;
  notas?: string;
  creado_por: string | null;
  creado_en: string;
  actualizado_en: string;
}
