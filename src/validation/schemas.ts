import { z } from 'zod';

// ===== AUTH =====
// Business forms validate through the target backend (RPC / constraint errors mapped in src/target/messages.ts).
export const loginSchema = z.object({
  email: z.string().email('Email inválido').trim().toLowerCase(),
  password: z.string().min(3, 'Min 3 caracteres').max(128, 'Max 128 caracteres'),
});
export type LoginInput = z.infer<typeof loginSchema>;
