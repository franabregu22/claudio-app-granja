import { createContext, useEffect, useState, type ReactNode } from 'react';
import { supabase } from '../lib/supabase';
import type { User, Rol } from '../types/domain';

export interface AuthContextType {
  user: User | null;
  rol: Rol | null;
  loading: boolean;
  signOut: () => Promise<void>;
}

export const AuthContext = createContext<AuthContextType | undefined>(undefined);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [rol, setRol] = useState<Rol | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function initAuth() {
      try {
        const { data: sessionData } = await supabase.auth.getSession();
        const session = sessionData?.session;

        if (session?.user) {
          setUser({
            id: session.user.id,
            email: session.user.email,
          });

          const { data: perfilData } = await supabase
            .from('perfiles')
            .select('rol')
            .eq('id', session.user.id)
            .single();

          if (perfilData) {
            setRol(perfilData.rol);
          }
        }
      } catch (error) {
        console.error('Error initializing auth:', error);
      } finally {
        setLoading(false);
      }
    }

    initAuth();

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange(async (_event, session) => {
      if (session?.user) {
        setUser({
          id: session.user.id,
          email: session.user.email,
        });

        const { data: perfilData } = await supabase
          .from('perfiles')
          .select('rol')
          .eq('id', session.user.id)
          .single();

        if (perfilData) {
          setRol(perfilData.rol);
        }
      } else {
        setUser(null);
        setRol(null);
      }
    });

    return () => {
      subscription?.unsubscribe();
    };
  }, []);

  const handleSignOut = async () => {
    await supabase.auth.signOut();
    setUser(null);
    setRol(null);
  };

  return (
    <AuthContext.Provider value={{ user, rol, loading, signOut: handleSignOut }}>
      {children}
    </AuthContext.Provider>
  );
}
