import { useState } from 'react';
import './index.css';
import { useAuth } from './auth/useAuth';
import { LoginScreen } from './auth/LoginScreen';
import { PedidosApp } from './features/pedidos/PedidosApp';
import { CobrosApp } from './features/cobros/CobrosApp';

type Tab = 'pedidos' | 'cobros';

function App() {
  const { user, rol, loading, signOut } = useAuth();
  const [tab, setTab] = useState<Tab>('pedidos');

  if (loading) {
    return (
      <div className="min-h-screen bg-stone-100 flex items-center justify-center">
        <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-[#A8552E]"></div>
      </div>
    );
  }

  if (!user) {
    return <LoginScreen />;
  }

  return (
    <div className="min-h-screen bg-stone-100 flex flex-col">
      <div className="bg-[#FAF6EE] border-b border-[#E4DCC8] px-5 py-3 flex items-center justify-between">
        <div className="text-sm font-medium text-[#2C2419]">
          {user.email} {rol === 'dueño' && <span className="text-xs ml-2 bg-[#FCEFD4] text-[#8A5A0B] px-2 py-1 rounded-full">Dueño</span>}
        </div>
        <button
          onClick={signOut}
          className="text-sm text-[#A8552E] hover:text-[#8B4426] font-medium"
        >
          Cerrar sesión
        </button>
      </div>

      {rol === 'dueño' && (
        <div className="bg-[#FAF6EE] border-b border-[#E4DCC8] flex gap-4 px-5">
          <button
            onClick={() => setTab('pedidos')}
            className={`px-4 py-3 font-medium border-b-2 transition ${
              tab === 'pedidos'
                ? 'text-[#78350f] border-[#B45309]'
                : 'text-[#A8886A] border-transparent hover:text-[#78350f]'
            }`}
          >
            Pedidos
          </button>
          <button
            onClick={() => setTab('cobros')}
            className={`px-4 py-3 font-medium border-b-2 transition ${
              tab === 'cobros'
                ? 'text-[#78350f] border-[#B45309]'
                : 'text-[#A8886A] border-transparent hover:text-[#78350f]'
            }`}
          >
            Cobros
          </button>
        </div>
      )}

      <div className="flex-1">
        {tab === 'pedidos' ? <PedidosApp /> : <CobrosApp />}
      </div>
    </div>
  );
}

export default App;
