import { useState } from 'react';
import { X } from 'lucide-react';
import { useAuth } from '../../auth/useAuth';
import { PRICE_LISTS, PRODUCT_TYPES, UNIT_TYPES, type PriceList, type PriceRow, type ProductRow, type ProductType, type UnitType } from '../../target/masters';
import { errorMessage } from '../../target/messages';
import { getTodayDate } from '../../utils/dateUtils';
import { MasterEditor } from './MasterEditor';
import { useCurrentPrices, useMasterList, useSetPrice } from './useMasters';

const TYPE_LABEL: Record<ProductType, string> = { VENDIBLE: 'Vendible', INPUT: 'Insumo', BOTH: 'Vendible e insumo' };
const UNIT_LABEL: Record<UnitType, string> = { UNIT: 'Unidad', CARTON: 'Maple', KG: 'Kg', TON: 'Tonelada', LITER: 'Litro' };
const LIST_LABEL: Record<PriceList, string> = { MINORISTA: 'Minorista', MAYORISTA: 'Mayorista' };

/**
 * Target `products` + `price_history` (ADMIN masters). A price change closes the current row and appends a new
 * one, so the history is kept. The price used by an order is snapshotted on its lines, never read from here.
 */
export function PreciosAdmin() {
  const { user } = useAuth();
  const productos = useMasterList<ProductRow>('products');
  const precios = useCurrentPrices();
  const setPrice = useSetPrice();
  const [modal, setModal] = useState<{ product: ProductRow; list: PriceList; actual: PriceRow | undefined } | null>(null);
  const [nuevoPrecio, setNuevoPrecio] = useState('');
  const [vigenteDesde, setVigenteDesde] = useState(getTodayDate());

  const abrirModal = (product: ProductRow, list: PriceList, actual: PriceRow | undefined) => {
    setModal({ product, list, actual });
    setNuevoPrecio(actual ? String(actual.precio) : '');
    setVigenteDesde(getTodayDate());
    setPrice.reset();
  };
  const guardar = () => {
    if (!modal || nuevoPrecio === '' || !vigenteDesde) return;
    setPrice.mutate(
      { productId: modal.product.id, list: modal.list, precio: Number(nuevoPrecio), effectiveFrom: vigenteDesde, userId: user?.id ?? null },
      { onSuccess: () => setModal(null) },
    );
  };

  const vendibles = (productos.data ?? []).filter((p) => p.activo && p.product_type !== 'INPUT');
  const actual = (productId: string, list: PriceList) =>
    (precios.data ?? []).find((r) => r.producto_id === productId && r.price_list_type === list);

  return (
    <div>
      <MasterEditor
        table="products"
        title="Productos"
        fields={[
          { key: 'nombre', label: 'Nombre', required: true, placeholder: 'Nombre del producto' },
          { key: 'product_type', label: 'Tipo', type: 'select', options: PRODUCT_TYPES.map((t) => ({ value: t, label: TYPE_LABEL[t] })) },
          { key: 'unit_type', label: 'Unidad', type: 'select', options: UNIT_TYPES.map((u) => ({ value: u, label: UNIT_LABEL[u] })) },
        ]}
      />

      <div className="px-6 pb-6">
        <h2 className="font-semibold text-amber-900 mb-3">Precios vigentes</h2>
        {precios.isLoading ? (
          <p className="text-gray-500 text-sm">Cargando precios...</p>
        ) : precios.error ? (
          <div className="p-3 bg-red-50 border border-red-200 rounded text-sm text-red-700">{errorMessage(precios.error)}</div>
        ) : vendibles.length === 0 ? (
          <p className="text-gray-500 text-sm">No hay productos vendibles activos.</p>
        ) : (
          <div className="space-y-4">
            {vendibles.map((p) => (
              <div key={p.id} className="bg-white rounded-lg border border-amber-200 overflow-hidden">
                <div className="bg-amber-50 px-4 md:px-6 py-3 border-b border-amber-200">
                  <h3 className="font-semibold text-amber-900">{p.nombre}</h3>
                </div>
                <div className="p-4 md:p-6 grid grid-cols-2 gap-6">
                  {PRICE_LISTS.map((list) => {
                    const row = actual(p.id, list);
                    return (
                      <div key={list}>
                        <p className="text-gray-600 font-medium mb-2">{LIST_LABEL[list]}</p>
                        {row ? (
                          <>
                            <p className="text-2xl font-bold text-amber-900">${Number(row.precio).toLocaleString('es-AR')}</p>
                            <p className="text-xs text-gray-500 mt-1">Vigente desde: {row.effective_from}</p>
                          </>
                        ) : (
                          <p className="text-gray-500">Sin precio</p>
                        )}
                        <button onClick={() => abrirModal(p, list, row)}
                          className="mt-3 bg-amber-600 hover:bg-amber-700 text-white px-4 py-2 rounded text-sm font-medium">
                          {row ? 'Actualizar' : 'Definir precio'}
                        </button>
                      </div>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {modal && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center p-4 z-50">
          <div className="bg-white rounded-lg max-w-sm w-full p-6">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-xl font-bold text-amber-900">{modal.product.nombre} — {LIST_LABEL[modal.list]}</h2>
              <button onClick={() => setModal(null)} className="text-gray-400 hover:text-gray-600"><X size={24} /></button>
            </div>
            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  {modal.actual ? `Precio actual: $${Number(modal.actual.precio).toLocaleString('es-AR')}` : 'Nuevo precio'}
                </label>
                <input type="number" min={0} value={nuevoPrecio} onChange={(e) => setNuevoPrecio(e.target.value)} placeholder="Nuevo precio"
                  className="w-full border border-gray-300 rounded px-3 py-2 focus:outline-none focus:ring-2 focus:ring-amber-600" />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Vigente desde</label>
                <input type="date" value={vigenteDesde} onChange={(e) => setVigenteDesde(e.target.value)}
                  className="w-full border border-gray-300 rounded px-3 py-2 focus:outline-none focus:ring-2 focus:ring-amber-600" />
              </div>
              {setPrice.error && (
                <div className="p-3 bg-red-50 border border-red-200 rounded text-sm text-red-700">{errorMessage(setPrice.error)}</div>
              )}
              <div className="flex gap-2 pt-2">
                <button onClick={() => setModal(null)} className="flex-1 px-4 py-2 border border-gray-300 rounded text-gray-700 font-medium hover:bg-gray-50">
                  Cancelar
                </button>
                <button onClick={guardar} disabled={setPrice.isPending || nuevoPrecio === '' || !vigenteDesde}
                  className="flex-1 px-4 py-2 bg-amber-600 text-white rounded font-medium hover:bg-amber-700 disabled:opacity-50">
                  {setPrice.isPending ? 'Guardando...' : 'Guardar'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
