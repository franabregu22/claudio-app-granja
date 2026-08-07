import { useState } from 'react';
import { supabase } from '../lib/supabase';

export function LoginScreen() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  async function handleLogin(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    setLoading(true);

    try {
      const { error: authError } = await supabase.auth.signInWithPassword({
        email,
        password,
      });

      if (authError) {
        setError(authError.message);
      }
    } catch (err) {
      setError('Error al iniciar sesión. Intenta de nuevo.');
    } finally {
      setLoading(false);
    }
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

        <form onSubmit={handleLogin} className="space-y-4">
          <div>
            <label className="block text-xs font-semibold text-[#6B5D45] uppercase tracking-wide mb-2">
              Correo electrónico
            </label>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="w-full border border-[#D8CDB0] rounded-lg px-3 py-2.5 bg-white text-[#2C2419] placeholder:text-[#B3A484]"
              placeholder="tu@email.com"
              disabled={loading}
              required
            />
          </div>

          <div>
            <label className="block text-xs font-semibold text-[#6B5D45] uppercase tracking-wide mb-2">
              Contraseña
            </label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="w-full border border-[#D8CDB0] rounded-lg px-3 py-2.5 bg-white text-[#2C2419] placeholder:text-[#B3A484]"
              placeholder="••••••••"
              disabled={loading}
              required
            />
          </div>

          {error && (
            <div className="bg-[#FCE4E4] border border-[#E4B0B0] text-[#A32D2D] text-sm px-3 py-2 rounded-lg">
              {error}
            </div>
          )}

          <button
            type="submit"
            disabled={loading}
            className="w-full bg-[#A8552E] hover:bg-[#8B4426] disabled:bg-[#D8CDB0] text-white font-semibold py-3 rounded-lg transition-colors disabled:text-[#A89878]"
          >
            {loading ? 'Iniciando sesión...' : 'Iniciar sesión'}
          </button>
        </form>

        <p className="text-xs text-[#8A7A5C] text-center mt-6">
          Contacta al dueño si necesitas una cuenta nueva
        </p>
      </div>
    </div>
  );
}
