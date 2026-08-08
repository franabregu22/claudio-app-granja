export type Categoria = 'xl' | 'n1' | 'n2' | 'n3' | 'docena';
export type PedidoEstado = 'pendiente' | 'entregado' | 'cancelado';
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
  id: string;
  cliente_id: string;
  cliente_nombre: string;
  lineas: Lineas;
  precios_snapshot: Precios;
  estado: PedidoEstado;
  rectificado: boolean;
  fecha_pedido: string;
  creado_por: string | null;
  entregado_por: string | null;
  entregado_en: string | null;
  creado_en: string;
  actualizado_en: string;
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
