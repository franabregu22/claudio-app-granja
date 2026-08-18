import { useState } from 'react';
import { z } from 'zod';
import { supabase } from '../lib/supabase';
import { loginSchema } from '../validation/schemas';
import { useFormValidation } from '../hooks/useFormValidation';

export function LoginScreen() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  const { isSubmitting, generalError, handleSubmit } = useFormValidation({
    schema: loginSchema,
    onSubmit: async (data) => {
      const { error: authError } = await supabase.auth.signInWithPassword({
        email: data.email,
        password: data.password,
      });

      if (authError) {
        throw new Error(authError.message);
      }
    },
  });

  const handleLoginSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setFieldErrors({});

    const result = loginSchema.safeParse({ email, password });
    if (!result.success) {
      const errors: Record<string, string> = {};
      const zodError = result.error as any;
      zodError.errors?.forEach((err: any) => {
        errors[err.path[0] as string] = err.message;
      });
      setFieldErrors(errors);
      return;
    }

    await handleSubmit({ email, password });
  }

  return (
    <div className="min-h-screen bg-stone-100 flex items-center justify-center p-4">
      <div className="w-full max-w-sm bg-[#FAF6EE] rounded-2xl shadow-lg p-8">
        <div className="text-center mb-8">
          <p className="text-xs font-semibold tracking-wide text-[#A8552E] uppercase">
            Granja Santo Tomás
          </p>
          <h1 className="text-2xl font-bold text-[#2C2419] mt-2">Pedidos</h1>
        </div>

        <form onSubmit={handleLoginSubmit} className="space-y-4">
          <div>
            <label className="block text-xs font-semibold text-[#6B5D45] uppercase tracking-wide mb-2">
              Correo electrónico
            </label>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className={`w-full border rounded-lg px-3 py-2.5 bg-white text-[#2C2419] placeholder:text-[#B3A484] ${
                fieldErrors.email ? 'border-red-500' : 'border-[#D8CDB0]'
              }`}
              placeholder="tu@email.com"
              disabled={isSubmitting}
              required
            />
            {fieldErrors.email && (
              <p className="text-red-600 text-xs mt-1">{fieldErrors.email}</p>
            )}
          </div>

          <div>
            <label className="block text-xs font-semibold text-[#6B5D45] uppercase tracking-wide mb-2">
              Contraseña
            </label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className={`w-full border rounded-lg px-3 py-2.5 bg-white text-[#2C2419] placeholder:text-[#B3A484] ${
                fieldErrors.password ? 'border-red-500' : 'border-[#D8CDB0]'
              }`}
              placeholder="••••••••"
              disabled={isSubmitting}
              required
            />
            {fieldErrors.password && (
              <p className="text-red-600 text-xs mt-1">{fieldErrors.password}</p>
            )}
          </div>

          {generalError && (
            <div className="bg-[#FCE4E4] border border-[#E4B0B0] text-[#A32D2D] text-sm px-3 py-2 rounded-lg">
              {generalError}
            </div>
          )}

          <button
            type="submit"
            disabled={isSubmitting}
            className="w-full bg-[#A8552E] hover:bg-[#8B4426] disabled:bg-[#D8CDB0] text-white font-semibold py-3 rounded-lg transition-colors disabled:text-[#A89878]"
          >
            {isSubmitting ? 'Iniciando sesión...' : 'Iniciar sesión'}
          </button>
        </form>

        <p className="text-xs text-[#8A7A5C] text-center mt-6">
          Contacta al dueño si necesitas una cuenta nueva
        </p>
      </div>
    </div>
  );
}
