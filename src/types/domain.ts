export type Categoria = 'xl' | 'n1' | 'n2' | 'n3' | 'docena';
export type PedidoEstado = 'pendiente' | 'entregado' | 'cancelado';
export type MetodoPago = 'efectivo' | 'transferencia' | 'tarjeta' | 'mercadopago' | 'otro';
export type Rol = 'dueño' | 'repartidor' | 'colaborador';

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

export interface Cliente {
  id: string;
  nombre: string;
  activo: boolean;
  created_at: string;
}

export interface Pedido {
  id: number;
  cliente_id: string;
  cliente_nombre: string;
  lineas: Lineas;
  precios_snapshot: Precios;
  monto_total: number;
  observaciones?: string;
  estado: PedidoEstado;
  rectificado: boolean;
  fecha_pedido: string;
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

export interface User {
  id: string;
  email?: string;
}
