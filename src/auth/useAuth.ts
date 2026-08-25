import { useContext } from 'react';
import { AuthContext, type AuthContextType } from './AuthProvider';

export function useAuth(): AuthContextType {
  const context = useContext(AuthContext);
  if (context === undefined) {
    // Return a default context to avoid throwing in render
    return {
      user: null,
      rol: null,
      loading: true,
      signOut: async () => {},
    };
  }
  return context;
}
