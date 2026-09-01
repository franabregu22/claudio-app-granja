import { useState } from 'react';
import { ChevronLeft, Upload, X } from 'lucide-react';
import { useCrearMovimientoCaja } from '../../hooks/useCaja';
import { useAuth } from '../../auth/useAuth';
import { subirFactura } from '../../api/caja';
import { getTodayDate } from '../../utils/dateUtils';
import { CATEGORIAS_EGRESOS, CATEGORIAS_INGRESOS, NATURALEZA_LABELS } from '../../constants/categorias-caja';
import type { MovimientoTipo, FormaPago, NaturalezaGasto } from '../../types/domain';

interface FormMovimientoProps {
  onGuardar: () => void;
  onCancelar: () => void;
}

export function FormMovimiento({ onGuardar, onCancelar }: FormMovimientoProps) {
  const crearMutation = useCrearMovimientoCaja();
  const { user } = useAuth();
  const [error, setError] = useState<string | null>(null);

  const [tipo, setTipo] = useState<MovimientoTipo>('ingreso');
  const [concepto, setConcepto] = useState('');
  const [monto, setMonto] = useState('');
  const [formaPago, setFormaPago] = useState<FormaPago>('efectivo');
  const [fechaOperacion, setFechaOperacion] = useState(getTodayDate());
  const [fechaPago, setFechaPago] = useState(getTodayDate());
  const [movimientoEstado, setMovimientoEstado] = useState<'pendiente' | 'confirmado'>('confirmado');
  const [notas, setNotas] = useState('');
  const [aplicaImpuesto, setAplicaImpuesto] = useState(true);
  const [categoria, setCategoria] = useState('');
  const [subcategoria, setSubcategoria] = useState('');
  const [categoriaAnalisis, setCategoriaAnalisis] = useState<'GASTOS_OPERATIVOS' | 'REINVERSION_OPERATIVA' | 'INVERSION'>('GASTOS_OPERATIVOS');
  const [esFacturada, setEsFacturada] = useState(false);
  const [alicuotaIva, setAlicuotaIva] = useState(21);
  const [urlFactura, setUrlFactura] = useState('');
  const [previewFactura, setPreviewFactura] = useState('');
  const [subiendo, setSubiendo] = useState(false);

  const categorias = tipo === 'ingreso' ? CATEGORIAS_INGRESOS : CATEGORIAS_EGRESOS;
  const categoriaActual = categorias.find((c) => c.categoria === categoria);
  const subcategorias = categoriaActual?.subcategorias || [];

  const formasPagables = ['transferencia', 'mercadopago', 'cheque', 'echeq'];
  const puedeAplicarImpuesto = formasPagables.includes(formaPago);

  const montoNum = parseFloat(monto) || 0;
  const montoIva = esFacturada ? (montoNum * alicuotaIva) / 100 : 0;
  const montoNeto = montoNum - montoIva;

  async function handleSubirFactura(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;

    setSubiendo(true);
    setError(null);

    try {
      // Mostrar preview
      const reader = new FileReader();
      reader.onload = (event) => {
        setPreviewFactura(event.target?.result as string);
      };
      reader.readAsDataURL(file);

      // Subir a Supabase Storage
      const url = await subirFactura(file);
      setUrlFactura(url);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error al subir factura');
    } finally {
      setSubiendo(false);
    }
  }

  async function handleGuardar() {
    setError(null);

    if (!categoria) {
      setError('La categoría es requerida');
      return;
    }

    if (!subcategoria) {
      setError('La subcategoría es requerida');
      return;
    }

    const montoNum = parseFloat(monto);
    if (!monto || isNaN(montoNum) || montoNum <= 0) {
      setError('El monto debe ser mayor a 0');
      return;
    }

    try {
      if (!user?.id) {
        setError('Usuario no autenticado');
        return;
      }

      await crearMutation.mutateAsync({
        tipo,
        concepto: concepto.trim() || categoria,
        monto: montoNum,
        forma_pago: formaPago,
        fecha_operacion: fechaOperacion,
        fecha_pago: movimientoEstado === 'confirmado' ? fechaPago : null,
        movimiento_estado: movimientoEstado,
        categoria_tecnica: subcategoria,
        categoria_analisis: tipo === 'egreso' ? categoriaAnalisis : undefined,
        es_facturada: esFacturada,
        alicuota_iva: esFacturada ? alicuotaIva : 0,
        monto_iva: montoIva,
        url_factura: urlFactura || undefined,
        notas: notas.trim() || undefined,
        aplica_impuesto_cheque: aplicaImpuesto && puedeAplicarImpuesto,
      } as any);
      onGuardar();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error al guardar');
    }
  }

  return (
    <div className="min-h-screen bg-stone-100 flex justify-center">
      <div className="w-full max-w-2xl bg-[#FAF6EE] min-h-screen flex flex-col">
        <header className="px-5 pt-6 pb-4 border-b border-[#E4DCC8] flex items-center gap-3">
          <button
            onClick={onCancelar}
            className="w-9 h-9 flex items-center justify-center rounded-full bg-[#A8552E] text-white active:scale-95 transition-transform"
          >
            <ChevronLeft className="w-5 h-5" />
          </button>
          <h1 className="text-lg font-bold text-[#2C2419]">Nuevo movimiento</h1>
        </header>

        <div className="flex-1 overflow-y-auto px-5 pt-4 pb-32">
        {error && (
          <div className="bg-[#FCE4E4] border border-[#E4B0B0] text-[#A32D2D] text-sm px-3 py-2 rounded-lg mb-4">
            {error}
          </div>
        )}

        {/* Tipo */}
        <div className="mb-4">
          <label className="block text-xs font-semibold text-[#6B5D45] uppercase tracking-wide mb-2">
            Tipo
          </label>
          <div className="flex gap-3">
            <button
              onClick={() => setTipo('ingreso')}
              className={`flex-1 py-2.5 rounded-lg font-semibold transition-colors ${
                tipo === 'ingreso'
                  ? 'bg-green-600 text-white'
                  : 'bg-green-100 text-green-700'
              }`}
            >
              Ingreso
            </button>
            <button
              onClick={() => setTipo('egreso')}
              className={`flex-1 py-2.5 rounded-lg font-semibold transition-colors ${
                tipo === 'egreso'
                  ? 'bg-red-600 text-white'
                  : 'bg-red-100 text-red-700'
              }`}
            >
              Egreso
            </button>
          </div>
        </div>

        {/* Categoría */}
        <div className="mb-4">
          <label className="block text-xs font-semibold text-[#6B5D45] uppercase tracking-wide mb-1.5">
            Categoría
          </label>
          <select
            value={categoria}
            onChange={(e) => {
              setCategoria(e.target.value);
              setSubcategoria('');
              if (tipo === 'egreso') {
                const cat = categorias.find((c) => c.categoria === e.target.value);
                if (cat?.naturalezaDefault) {
                  setNaturalezaGasto(cat.naturalezaDefault);
                }
              }
            }}
            className="w-full border border-[#D8CDB0] rounded-lg px-3 py-2.5 bg-white text-[#2C2419]"
          >
            <option value="">Seleccionar categoría</option>
            {categorias.map((cat) => (
              <option key={cat.categoria} value={cat.categoria}>
                {cat.categoria}
              </option>
            ))}
          </select>
        </div>

        {/* Subcategoría */}
        {categoria && (
          <div className="mb-4">
            <label className="block text-xs font-semibold text-[#6B5D45] uppercase tracking-wide mb-1.5">
              Subcategoría
            </label>
            <select
              value={subcategoria}
              onChange={(e) => setSubcategoria(e.target.value)}
              className="w-full border border-[#D8CDB0] rounded-lg px-3 py-2.5 bg-white text-[#2C2419]"
            >
              <option value="">Seleccionar subcategoría</option>
              {subcategorias.map((sub) => (
                <option key={sub} value={sub}>
                  {sub}
                </option>
              ))}
            </select>
          </div>
        )}

        {/* Categoría de análisis (solo para egresos) */}
        {tipo === 'egreso' && (
          <div className="mb-4">
            <label className="block text-xs font-semibold text-[#6B5D45] uppercase tracking-wide mb-1.5">
              Clasificación analítica
            </label>
            <select
              value={categoriaAnalisis}
              onChange={(e) => setCategoriaAnalisis(e.target.value as 'GASTOS_OPERATIVOS' | 'REINVERSION_OPERATIVA' | 'INVERSION')}
              className="w-full border border-[#D8CDB0] rounded-lg px-3 py-2.5 bg-white text-[#2C2419]"
            >
              <option value="GASTOS_OPERATIVOS">Gastos Operativos</option>
              <option value="REINVERSION_OPERATIVA">Reinversión Operativa</option>
              <option value="INVERSION">Inversión</option>
            </select>
          </div>
        )}

        {/* Concepto (opcional) */}
        <div className="mb-4">
          <label className="block text-xs font-semibold text-[#6B5D45] uppercase tracking-wide mb-1.5">
            Detalles / Notas
          </label>
          <input
            type="text"
            placeholder="Ej: Factura #123, Cliente X"
            value={concepto}
            onChange={(e) => setConcepto(e.target.value)}
            className="w-full border border-[#D8CDB0] rounded-lg px-3 py-2.5 bg-white text-[#2C2419]"
          />
        </div>

        {/* Monto */}
        <div className="mb-4">
          <label className="block text-xs font-semibold text-[#6B5D45] uppercase tracking-wide mb-1.5">
            Monto
          </label>
          <div className="flex items-center gap-2">
            <span className="text-[#8A7A5C]">$</span>
            <input
              type="number"
              inputMode="decimal"
              placeholder="0"
              value={monto}
              onChange={(e) => setMonto(e.target.value)}
              className="flex-1 border border-[#D8CDB0] rounded-lg px-3 py-2.5 bg-white text-[#2C2419]"
            />
          </div>
          {esFacturada && montoNeto > 0 && (
            <div className="mt-2 text-xs text-[#8A7A5C]">
              <p>IVA {alicuotaIva}%: ${montoIva.toFixed(2)}</p>
              <p className="font-semibold">Neto: ${montoNeto.toFixed(2)}</p>
            </div>
          )}
        </div>

        {/* Factura */}
        <div className="mb-4">
          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={esFacturada}
              onChange={(e) => setEsFacturada(e.target.checked)}
              className="w-4 h-4 rounded border-[#D8CDB0]"
            />
            <span className="text-sm font-medium text-[#2C2419]">¿Tiene factura?</span>
          </label>
        </div>

        {esFacturada && (
          <>
            {/* Alícuota IVA */}
            <div className="mb-4">
              <label className="block text-xs font-semibold text-[#6B5D45] uppercase tracking-wide mb-1.5">
                Alícuota IVA
              </label>
              <select
                value={alicuotaIva}
                onChange={(e) => setAlicuotaIva(parseFloat(e.target.value))}
                className="w-full border border-[#D8CDB0] rounded-lg px-3 py-2.5 bg-white text-[#2C2419]"
              >
                <option value={0}>Sin IVA</option>
                <option value={5}>5%</option>
                <option value={10.5}>10.5%</option>
                <option value={21}>21%</option>
              </select>
            </div>

            {/* Upload Factura */}
            <div className="mb-4">
              <label className="block text-xs font-semibold text-[#6B5D45] uppercase tracking-wide mb-1.5">
                📷 Foto de factura
              </label>
              <div className="relative">
                <input
                  type="file"
                  accept="image/*"
                  capture="environment"
                  onChange={handleSubirFactura}
                  disabled={subiendo}
                  className="hidden"
                  id="factura-input"
                />
                <label
                  htmlFor="factura-input"
                  className="flex items-center justify-center gap-2 w-full border-2 border-dashed border-[#D8CDB0] rounded-lg px-3 py-4 bg-[#FAF6EE] cursor-pointer hover:bg-white transition-colors"
                >
                  <Upload className="w-5 h-5 text-[#A8552E]" />
                  <span className="text-sm text-[#2C2419] font-medium">
                    {subiendo ? 'Subiendo...' : urlFactura ? '✓ Factura cargada' : 'Subir factura'}
                  </span>
                </label>
              </div>

              {/* Preview */}
              {previewFactura && (
                <div className="mt-3 relative">
                  <img
                    src={previewFactura}
                    alt="Preview factura"
                    className="w-full rounded-lg border border-[#D8CDB0] max-h-48 object-cover"
                  />
                  <button
                    onClick={() => {
                      setPreviewFactura('');
                      setUrlFactura('');
                    }}
                    className="absolute top-1 right-1 bg-red-500 text-white p-1 rounded-full hover:bg-red-600"
                  >
                    <X className="w-4 h-4" />
                  </button>
                </div>
              )}
            </div>
          </>
        )}

        {/* Forma de pago */}
        <div className="mb-4">
          <label className="block text-xs font-semibold text-[#6B5D45] uppercase tracking-wide mb-1.5">
            Forma de pago
          </label>
          <select
            value={formaPago}
            onChange={(e) => setFormaPago(e.target.value as FormaPago)}
            className="w-full border border-[#D8CDB0] rounded-lg px-3 py-2.5 bg-white text-[#2C2419]"
          >
            <option value="efectivo">Efectivo</option>
            <option value="mercadopago">MercadoPago</option>
            <option value="cheque">Cheque</option>
            <option value="echeq">Echeq</option>
          </select>
        </div>

        {/* Fecha de operación */}
        <div className="mb-4">
          <label className="block text-xs font-semibold text-[#6B5D45] uppercase tracking-wide mb-1.5">
            Fecha de operación
          </label>
          <input
            type="date"
            value={fechaOperacion}
            onChange={(e) => setFechaOperacion(e.target.value)}
            className="w-full border border-[#D8CDB0] rounded-lg px-3 py-2.5 bg-white text-[#2C2419]"
          />
        </div>

        {/* Estado de pago */}
        <div className="mb-4">
          <label className="block text-xs font-semibold text-[#6B5D45] uppercase tracking-wide mb-2">
            Estado
          </label>
          <div className="flex gap-3">
            <button
              onClick={() => setMovimientoEstado('confirmado')}
              className={`flex-1 py-2.5 rounded-lg font-semibold transition-colors ${
                movimientoEstado === 'confirmado'
                  ? 'bg-green-600 text-white'
                  : 'bg-green-100 text-green-700'
              }`}
            >
              Confirmado
            </button>
            <button
              onClick={() => setMovimientoEstado('pendiente')}
              className={`flex-1 py-2.5 rounded-lg font-semibold transition-colors ${
                movimientoEstado === 'pendiente'
                  ? 'bg-amber-600 text-white'
                  : 'bg-amber-100 text-amber-700'
              }`}
            >
              Pendiente
            </button>
          </div>
        </div>

        {/* Fecha de pago (solo si está confirmado) */}
        {movimientoEstado === 'confirmado' && (
          <div className="mb-4">
            <label className="block text-xs font-semibold text-[#6B5D45] uppercase tracking-wide mb-1.5">
              Fecha de pago
            </label>
            <input
              type="date"
              value={fechaPago}
              onChange={(e) => setFechaPago(e.target.value)}
              className="w-full border border-[#D8CDB0] rounded-lg px-3 py-2.5 bg-white text-[#2C2419]"
            />
          </div>
        )}

        {/* Impuesto al Cheque */}
        {puedeAplicarImpuesto && (
          <div className="mb-4 p-3 bg-blue-50 border border-blue-200 rounded-lg">
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={aplicaImpuesto}
                onChange={(e) => setAplicaImpuesto(e.target.checked)}
                className="w-4 h-4 rounded border-[#D8CDB0]"
              />
              <span className="text-sm font-medium text-[#2C2419]">
                Aplicar impuesto al cheque (0.6%)
              </span>
            </label>
            {aplicaImpuesto && (
              <p className="text-xs text-blue-700 mt-2">
                Se descenderá automáticamente ${(parseFloat(monto) * 0.006 || 0).toFixed(2)} en impuesto
              </p>
            )}
          </div>
        )}

        {/* Notas */}
        <div className="mb-4">
          <label className="block text-xs font-semibold text-[#6B5D45] uppercase tracking-wide mb-1.5">
            Notas (opcional)
          </label>
          <textarea
            placeholder="Detalles adicionales"
            value={notas}
            onChange={(e) => setNotas(e.target.value)}
            className="w-full border border-[#D8CDB0] rounded-lg px-3 py-2.5 bg-white text-[#2C2419] resize-none"
            rows={2}
          />
        </div>
      </div>

      <div className="fixed bottom-0 left-0 right-0 p-5 bg-[#FAF6EE] border-t border-[#E4DCC8]">
        <button
          onClick={handleGuardar}
          disabled={crearMutation.isPending || !concepto.trim() || !monto}
          className="w-full bg-[#A8552E] disabled:bg-[#D8CDB0] disabled:text-[#A89878] text-white font-semibold py-3.5 rounded-lg active:scale-95 transition-transform"
        >
          {crearMutation.isPending ? 'Guardando...' : 'Guardar movimiento'}
        </button>
      </div>
    </div>
  </div>
  );
}
