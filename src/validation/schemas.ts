import { z } from 'zod';

// ===== AUTH =====
export const loginSchema = z.object({
  email: z.string().email('Email inválido').trim().toLowerCase(),
  password: z.string().min(3, 'Min 3 caracteres').max(128, 'Max 128 caracteres'),
});
export type LoginInput = z.infer<typeof loginSchema>;

// ===== CLIENTES =====
export const clienteSchema = z.object({
  nombre: z
    .string()
    .min(2, 'Min 2 caracteres')
    .max(100, 'Max 100 caracteres')
    .trim()
    .regex(/^[a-zA-Z0-9\s\-áéíóúñ\.]+$/, 'Solo letras, números, guiones y puntos'),
  activo: z.boolean().optional().default(true),
  notas: z
    .string()
    .max(500, 'Max 500 caracteres')
    .trim()
    .optional(),
});
export type ClienteInput = z.infer<typeof clienteSchema>;

// ===== MOVIMIENTOS CAJA =====
export const movimientoCajaSchema = z.object({
  tipo: z.enum(['ingreso', 'egreso'] as const),
  concepto: z
    .string()
    .min(2, 'Min 2 caracteres')
    .max(200, 'Max 200 caracteres')
    .trim()
    .regex(/^[a-zA-Z0-9\s\-áéíóúñ\.\,\:\(\)]+$/, 'Caracteres no permitidos'),
  monto: z
    .number()
    .positive('Monto debe ser > 0')
    .max(999999999.99, 'Monto muy grande'),
  forma_pago: z.enum(['efectivo', 'mercadopago', 'transferencia'] as const),
  fecha_operacion: z
    .string()
    .date('Fecha inválida')
    .refine((date) => new Date(date) <= new Date(), 'No se permiten fechas futuras'),
  fecha_pago: z
    .string()
    .date('Fecha inválida')
    .refine((date) => new Date(date) <= new Date(), 'No se permiten fechas futuras'),
  categoria: z
    .string()
    .max(50)
    .trim()
    .optional(),
  subcategoria: z
    .string()
    .max(50)
    .trim()
    .optional(),
  impuesto_cheque: z.number().min(0).optional(),
  naturaleza_gasto: z
    .enum(['gasto_operativo', 'reinversion_operativa', 'inversion', 'distribucion_ganancias', 'ajuste_contable'] as const)
    .optional(),
  es_facturada: z.boolean().optional(),
  alicuota_iva: z.number().min(0).max(100).optional(),
  monto_iva: z.number().min(0).optional(),
  url_factura: z.string().url('URL inválida').optional().or(z.literal('')),
  notas: z
    .string()
    .max(500, 'Max 500 caracteres')
    .trim()
    .optional(),
  aplica_impuesto_cheque: z.boolean().optional(),
});
export type MovimientoCajaInput = z.infer<typeof movimientoCajaSchema>;

// ===== CHEQUES =====
export const chequeSchema = z.object({
  numero: z
    .string()
    .min(6, 'Min 6 caracteres')
    .max(20, 'Max 20 caracteres')
    .trim()
    .regex(/^[0-9\-]+$/, 'Solo números y guiones'),
  banco: z
    .string()
    .min(2, 'Min 2 caracteres')
    .max(100, 'Max 100 caracteres')
    .trim()
    .regex(/^[a-zA-Z0-9\s\-áéíóúñ\.]+$/, 'Caracteres no permitidos'),
  monto: z.number().positive('Monto debe ser > 0').max(999999999.99),
  fecha_emision: z.string().date('Fecha inválida'),
  fecha_vencimiento: z.string().date('Fecha inválida'),
  girador: z
    .string()
    .min(2, 'Min 2 caracteres')
    .max(100, 'Max 100 caracteres')
    .trim()
    .regex(/^[a-zA-Z0-9\s\-áéíóúñ\.]+$/, 'Caracteres no permitidos'),
  notas: z
    .string()
    .max(500, 'Max 500 caracteres')
    .trim()
    .optional(),
});
export type ChequeInput = z.infer<typeof chequeSchema>;

// ===== COMISIONES =====
export const comisionSchema = z.object({
  concepto: z
    .string()
    .min(2, 'Min 2 caracteres')
    .max(200, 'Max 200 caracteres')
    .trim()
    .regex(/^[a-zA-Z0-9\s\-áéíóúñ\.\,\:\(\)]+$/, 'Caracteres no permitidos'),
  monto: z.number().positive('Monto debe ser > 0').max(999999999.99),
  porcentaje: z.number().min(0).max(100).optional(),
  base_monto: z.number().min(0).optional(),
  fecha_operacion: z
    .string()
    .date('Fecha inválida')
    .refine((date) => new Date(date) <= new Date(), 'No se permiten fechas futuras'),
  notas: z
    .string()
    .max(500, 'Max 500 caracteres')
    .trim()
    .optional(),
});
export type ComisionInput = z.infer<typeof comisionSchema>;

// ===== LOTES =====
export const loteSchema = z.object({
  galpon: z
    .string()
    .min(1, 'Galpón requerido')
    .max(50, 'Max 50 caracteres')
    .trim()
    .regex(/^[a-zA-Z0-9\s\-]+$/, 'Solo letras, números y guiones'),
  fecha_entrada: z
    .string()
    .date('Fecha inválida')
    .refine((date) => new Date(date) <= new Date(), 'No se permiten fechas futuras'),
  aves_iniciales_postura: z
    .number()
    .positive('Debe ser > 0')
    .int('Debe ser un número entero')
    .max(999999, 'Número muy grande'),
  linea: z
    .string()
    .max(50)
    .trim()
    .optional(),
  lote_id: z
    .string()
    .max(50)
    .trim()
    .regex(/^[a-zA-Z0-9\-]+$/, 'Solo letras, números y guiones')
    .optional(),
  estado: z.enum(['Activo', 'Retirado', 'Planificado'] as const).default('Activo'),
  fecha_salida: z
    .string()
    .date('Fecha inválida')
    .refine((date) => new Date(date) <= new Date(), 'No se permiten fechas futuras')
    .optional()
    .or(z.null()),
  notas: z
    .string()
    .max(500, 'Max 500 caracteres')
    .trim()
    .optional(),
});
export type LoteInput = z.infer<typeof loteSchema>;

// ===== PRODUCTOS =====
export const productoSchema = z.object({
  nombre: z
    .string()
    .min(2, 'Min 2 caracteres')
    .max(100, 'Max 100 caracteres')
    .trim()
    .regex(/^[a-zA-Z0-9\s\-áéíóúñ\.]+$/, 'Caracteres no permitidos'),
  categoria: z
    .string()
    .min(1)
    .max(50)
    .trim()
    .regex(/^[a-zA-Z0-9\-áéíóúñ]+$/, 'Caracteres no permitidos'),
  precio_actual: z
    .number()
    .min(0)
    .max(999999999.99),
  unidad: z
    .string()
    .min(1)
    .max(20)
    .trim()
    .regex(/^[a-zA-Z]+$/, 'Solo letras'),
  activo: z.boolean().default(true),
});
export type ProductoInput = z.infer<typeof productoSchema>;

// ===== VALIDACIÓN GENÉRICA =====
export function validar<T>(schema: z.ZodSchema<T>, data: unknown): { success: true; data: T } | { success: false; errors: Record<string, string> } {
  const result = schema.safeParse(data);
  if (result.success) {
    return { success: true, data: result.data };
  }

  const errors: Record<string, string> = {};
  const zodError = result.error as any;
  zodError.errors?.forEach((error: any) => {
    const path = error.path.join('.');
    errors[path] = error.message;
  });
  return { success: false, errors };
}
