import { useState, useEffect } from 'react';
import './index.css';
import { useAuth } from './auth/useAuth';
import { LoginScreen } from './auth/LoginScreen';
import { PedidosApp } from './features/pedidos/PedidosApp';
import { CobrosApp } from './features/cobros/CobrosApp';
import { CajaApp } from './features/caja/CajaApp';
import { AdminApp } from './features/admin/AdminApp';
import { ProductionApp } from './features/production/ProductionApp';
import { LogOut, ShoppingCart, DollarSign, Wallet, BarChart3, Settings, Menu, X } from 'lucide-react';

type Tab = 'pedidos' | 'cobros' | 'caja' | 'admin' | 'produccion';

function App() {
  const { user, rol, loading, signOut } = useAuth();
  const [tab, setTab] = useState<Tab>('pedidos');
  const [isMobile, setIsMobile] = useState(window.innerWidth < 768);
  const [sidebarOpen, setSidebarOpen] = useState(window.innerWidth >= 768);

  useEffect(() => {
    const handleResize = () => {
      const mobile = window.innerWidth < 768;
      setIsMobile(mobile);
      if (mobile) setSidebarOpen(false);
      else setSidebarOpen(true);
    };

    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

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

  const modules = [
    ...(rol === 'dueño' || rol === 'colaborador' ? [
      { id: 'produccion' as Tab, label: 'Producción', icon: BarChart3 }
    ] : []),
    ...(rol === 'dueño' ? [
      { id: 'pedidos' as Tab, label: 'Pedidos', icon: ShoppingCart },
      { id: 'cobros' as Tab, label: 'Cuentas a Cobrar', icon: DollarSign },
      { id: 'caja' as Tab, label: 'Caja & Finanzas', icon: Wallet },
      { id: 'admin' as Tab, label: 'Admin', icon: Settings }
    ] : [])
  ];

  // Si el tab actual no está disponible, ir al primer módulo disponible
  const isTabAvailable = modules.some(m => m.id === tab);
  const currentTab = isTabAvailable ? tab : (modules[0]?.id || 'pedidos');

  return (
    <div className="min-h-screen bg-stone-100 flex">
      {/* Sidebar */}
      <div
        className={`bg-[#2C2419] text-white flex flex-col transition-all duration-300 ease-in-out overflow-hidden ${
          sidebarOpen ? 'w-64' : 'w-0'
        } ${isMobile ? 'fixed h-full z-40' : 'relative'}`}
      >
        {/* Logo */}
        <div className="p-6 border-b border-[#4A4338]">
          <p className="text-xs font-semibold tracking-wide text-[#D4AF37] uppercase mb-1">
            Granja Santo Tomás
          </p>
          <p className="text-lg font-bold">Gestión</p>
        </div>

        {/* Menu */}
        <nav className="flex-1 overflow-y-auto py-4">
          {modules.map((mod) => {
            const Icon = mod.icon;
            return (
              <button
                key={mod.id}
                onClick={() => {
                  setTab(mod.id);
                  if (isMobile) setSidebarOpen(false);
                }}
                className={`w-full flex items-center gap-3 px-4 py-3 transition-colors ${
                  currentTab === mod.id
                    ? 'bg-[#A8552E] text-white border-r-4 border-[#D4AF37]'
                    : 'text-[#B8A89F] hover:text-white hover:bg-[#3A3430]'
                }`}
              >
                <Icon className="w-5 h-5" />
                <span className="text-sm font-medium">{mod.label}</span>
              </button>
            );
          })}
        </nav>

        {/* User Info & Logout */}
        <div className="border-t border-[#4A4338] p-4 space-y-3">
          <div className="text-xs">
            <p className="text-[#D4AF37] font-semibold mb-1">{user.email}</p>
            <span className="inline-block text-[10px] bg-[#A8552E] text-white px-2 py-1 rounded">
              {rol === 'dueño' ? 'Administrador' : 'Usuario'}
            </span>
          </div>
          <button
            onClick={signOut}
            className="w-full flex items-center justify-center gap-2 text-sm text-[#B8A89F] hover:text-white hover:bg-[#3A3430] px-3 py-2 rounded transition-colors"
          >
            <LogOut className="w-4 h-4" />
            Cerrar sesión
          </button>
        </div>
      </div>

      {/* Mobile overlay */}
      {isMobile && sidebarOpen && (
        <div
          className="fixed inset-0 bg-black/10 z-30"
          onClick={() => setSidebarOpen(false)}
        />
      )}

      {/* Main Content */}
      <div className={`flex-1 min-h-screen flex flex-col ${isMobile && sidebarOpen ? 'z-20 relative pointer-events-none' : ''}`}>
        {/* Mobile header with toggle */}
        <div className="md:hidden bg-white border-b border-gray-200 px-4 py-3 flex items-center gap-3">
          <button
            onClick={() => setSidebarOpen(!sidebarOpen)}
            className="text-[#2C2419] hover:bg-gray-100 p-2 rounded"
          >
            {sidebarOpen ? <X className="w-5 h-5" /> : <Menu className="w-5 h-5" />}
          </button>
          <p className="text-sm font-semibold text-[#2C2419]">Granja Santo Tomás</p>
        </div>

        {/* Content */}
        <div className="flex-1">
          {currentTab === 'produccion' && <ProductionApp />}
          {currentTab === 'pedidos' && <PedidosApp />}
          {currentTab === 'cobros' && <CobrosApp />}
          {currentTab === 'caja' && <CajaApp />}
          {currentTab === 'admin' && <AdminApp />}
        </div>
      </div>
    </div>
  );
}

export default App;
