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
  const [categoria, setCategoria] = useState('');
  const [subcategoria, setSubcategoria] = useState('');
  const [categoriaAnalisis, setCategoriaAnalisis] = useState<'GASTOS_OPERATIVOS' | 'REINVERSION_OPERATIVA' | 'INVERSION' | 'OTRO'>('GASTOS_OPERATIVOS');
  const [esFacturada, setEsFacturada] = useState(false);
  const [tipoIva, setTipoIva] = useState<'21' | '10.5' | 'personalizado'>('21');
  const [alicuotaIva, setAlicuotaIva] = useState(21);
  const [montoIvaPersonalizado, setMontoIvaPersonalizado] = useState('');
  const [urlFactura, setUrlFactura] = useState('');
  const [urlFacturaDrive, setUrlFacturaDrive] = useState('');
  const [previewFactura, setPreviewFactura] = useState('');
  const [subiendo, setSubiendo] = useState(false);
  const [esCheque, setEsCheque] = useState(false);
  const [fechaPagoEstimada, setFechaPagoEstimada] = useState('');
  const [urlEcheq, setUrlEcheq] = useState('');
  const [esEnCuotas, setEsEnCuotas] = useState(false);
  const [cuotas, setCuotas] = useState<Array<{ numero: number; monto: string; fechaVencimiento: string; urlEcheq?: string }>>([]);
  const [montoCuotasTotales, setMontoCuotasTotales] = useState('');
  const [cantidadCuotas, setCantidadCuotas] = useState('');

  const categorias = tipo === 'ingreso' ? CATEGORIAS_INGRESOS : CATEGORIAS_EGRESOS;
  const categoriaActual = categorias.find((c) => c.categoria === categoria);
  const subcategorias = categoriaActual?.subcategorias || [];

  // Auto-completar categoria_analisis desde naturalezaDefault
  const mapearNaturaleza = (naturaleza?: string): 'GASTOS_OPERATIVOS' | 'REINVERSION_OPERATIVA' | 'INVERSION' | 'OTRO' => {
    switch (naturaleza) {
      case 'gasto_operativo':
        return 'GASTOS_OPERATIVOS';
      case 'reinversion_operativa':
        return 'REINVERSION_OPERATIVA';
      case 'inversion':
        return 'INVERSION';
      default:
        return 'OTRO';
    }
  };


  const montoNum = parseFloat(monto) || 0;
  const montoIva = esFacturada
    ? (tipoIva === 'personalizado' ? parseFloat(montoIvaPersonalizado) || 0 : (montoNum * alicuotaIva) / 100)
    : 0;
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

    if (esEnCuotas && cuotas.length === 0) {
      setError('Debe agregar al menos una cuota');
      return;
    }

    const montoNum = parseFloat(monto);
    if (!esEnCuotas && (!monto || isNaN(montoNum) || montoNum <= 0)) {
      setError('El monto debe ser mayor a 0');
      return;
    }

    try {
      if (!user?.id) {
        setError('Usuario no autenticado');
        return;
      }

      // Si es en cuotas, crear un movimiento por cuota
      if (esEnCuotas) {
        // Calcular IVA por cuota (si es personalizado, dividir entre cuotas)
        let ivaTotal = 0;
        if (esFacturada) {
          if (tipoIva === 'personalizado') {
            ivaTotal = parseFloat(montoIvaPersonalizado) || 0;
          } else {
            const montoTotalCuotas = cuotas.reduce((sum, c) => sum + parseFloat(c.monto), 0);
            ivaTotal = (montoTotalCuotas * alicuotaIva) / 100;
          }
        }
        const ivaPorCuota = cuotas.length > 0 ? ivaTotal / cuotas.length : 0;

        for (const cuota of cuotas) {
          const montoCuota = parseFloat(cuota.monto);
          const debeAplicarImpuesto = ['transferencia', 'mercadopago'].includes(formaPago);
          const impuestoCuota = debeAplicarImpuesto ? montoCuota * 0.006 : 0;
          const montoTotal = montoCuota + impuestoCuota;

          await crearMutation.mutateAsync({
            tipo,
            concepto: `${concepto.trim() || categoria} - Cuota ${cuota.numero}/${cuotas.length}`,
            monto: montoTotal,
            forma_pago: formaPago,
            fecha_operacion: fechaOperacion,
            fecha_pago: null,
            movimiento_estado: 'pendiente',
            categoria_tecnica: subcategoria,
            categoria_analisis: tipo === 'egreso' ? categoriaAnalisis : undefined,
            es_facturada: esFacturada,
            alicuota_iva: esFacturada && tipoIva !== 'personalizado' ? alicuotaIva : 0,
            monto_iva: esFacturada ? ivaPorCuota : 0,
            url_factura: urlFactura || urlFacturaDrive || undefined,
            es_cheque: esCheque,
            impuesto_cheque: impuestoCuota,
            fecha_pago_estimada: cuota.fechaVencimiento || null,
            url_echeq: esCheque ? cuota.urlEcheq || undefined : undefined,
            notas: notas.trim() || undefined,
          } as any);
        }
      } else {
        // Si no es en cuotas, crear un solo movimiento
        const debeAplicarImpuesto = ['transferencia', 'mercadopago'].includes(formaPago);
        const impuesto = debeAplicarImpuesto ? montoNum * 0.006 : 0;
        const montoConImpuesto = montoNum + impuesto;

        await crearMutation.mutateAsync({
          tipo,
          concepto: concepto.trim() || categoria,
          monto: montoConImpuesto,
          forma_pago: formaPago,
          fecha_operacion: fechaOperacion,
          fecha_pago: movimientoEstado === 'confirmado' ? fechaPago : null,
          movimiento_estado: movimientoEstado,
          categoria_tecnica: subcategoria,
          categoria_analisis: tipo === 'egreso' ? categoriaAnalisis : undefined,
          es_facturada: esFacturada,
          alicuota_iva: esFacturada && tipoIva !== 'personalizado' ? alicuotaIva : 0,
          monto_iva: montoIva,
          url_factura: urlFactura || urlFacturaDrive || undefined,
          es_cheque: esCheque,
          impuesto_cheque: impuesto,
          fecha_pago_estimada: movimientoEstado === 'pendiente' ? fechaPagoEstimada || null : null,
          url_echeq: esCheque ? urlEcheq || undefined : undefined,
          notas: notas.trim() || undefined,
        } as any);
      }
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

        {/* Categoría */}
        <div className="mb-4">
          <label className="block text-xs font-semibold text-[#6B5D45] uppercase tracking-wide mb-1.5">
            Categoría
          </label>
          <select
            value={categoria}
            onChange={(e) => {
              const newCategoria = e.target.value;
              setCategoria(newCategoria);
              setSubcategoria('');
              // Auto-completar categoria_analisis si es egreso
              if (tipo === 'egreso') {
                const cat = CATEGORIAS_EGRESOS.find((c) => c.categoria === newCategoria);
                if (cat?.naturalezaDefault) {
                  setCategoriaAnalisis(mapearNaturaleza(cat.naturalezaDefault));
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
              onChange={(e) => setCategoriaAnalisis(e.target.value as 'GASTOS_OPERATIVOS' | 'REINVERSION_OPERATIVA' | 'INVERSION' | 'OTRO')}
              className="w-full border border-[#D8CDB0] rounded-lg px-3 py-2.5 bg-white text-[#2C2419]"
            >
              <option value="GASTOS_OPERATIVOS">Gastos Operativos</option>
              <option value="REINVERSION_OPERATIVA">Reinversión Operativa</option>
              <option value="INVERSION">Inversión</option>
              <option value="OTRO">Otro</option>
            </select>
          </div>
        )}

        {/* Concepto (opcional) */}
        <div className="mb-4">
          <label className="block text-xs font-semibold text-[#6B5D45] uppercase tracking-wide mb-1.5">
            Detalles / Notas <span className="text-[#A89878] font-normal">(opcional)</span>
          </label>
          <input
            type="text"
            placeholder="Ej: Factura #123, Cliente X"
            value={concepto}
            onChange={(e) => setConcepto(e.target.value)}
            className="w-full border border-[#D8CDB0] rounded-lg px-3 py-2.5 bg-white text-[#2C2419]"
          />
        </div>

        {/* ¿Es en cuotas? (ANTES DEL MONTO) */}
        {tipo === 'egreso' && (
          <div className="mb-4">
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={esEnCuotas}
                onChange={(e) => {
                  setEsEnCuotas(e.target.checked);
                  if (!e.target.checked) {
                    setCuotas([]);
                    setMontoCuotasTotales('');
                    setCantidadCuotas('');
                  }
                }}
                className="w-4 h-4 rounded border-[#D8CDB0]"
              />
              <span className="text-sm font-medium text-[#2C2419]">¿Es en cuotas?</span>
            </label>
          </div>
        )}

        {/* Monto (deshabilitado si es en cuotas) */}
        {!esEnCuotas && (
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
        )}

        {/* Cuotas */}
        {esEnCuotas && (
          <div className="mb-4 p-4 bg-blue-50 border border-blue-200 rounded-lg">
            <p className="text-sm font-semibold text-[#2C2419] mb-3">Dividir en cuotas iguales</p>

            <div className="space-y-3 mb-4">
              <div>
                <label className="block text-xs font-semibold text-[#6B5D45] mb-1">
                  Monto total
                </label>
                <div className="flex items-center gap-2">
                  <span className="text-[#8A7A5C]">$</span>
                  <input
                    type="number"
                    inputMode="decimal"
                    placeholder="0"
                    value={montoCuotasTotales}
                    onChange={(e) => setMontoCuotasTotales(e.target.value)}
                    className="flex-1 border border-[#D8CDB0] rounded px-2 py-1.5 bg-white text-[#2C2419] text-sm"
                  />
                </div>
              </div>

              <div>
                <label className="block text-xs font-semibold text-[#6B5D45] mb-1">
                  Cantidad de cuotas
                </label>
                <input
                  type="number"
                  inputMode="numeric"
                  placeholder="3"
                  value={cantidadCuotas}
                  onChange={(e) => setCantidadCuotas(e.target.value)}
                  className="w-full border border-[#D8CDB0] rounded px-2 py-1.5 bg-white text-[#2C2419] text-sm"
                  min="1"
                  max="60"
                />
              </div>

              <button
                type="button"
                onClick={() => {
                  const monto = parseFloat(montoCuotasTotales);
                  const cantidad = parseInt(cantidadCuotas);

                  if (!monto || !cantidad || monto <= 0 || cantidad <= 0) {
                    setError('Completa monto total y cantidad de cuotas');
                    return;
                  }

                  const montoPorCuota = monto / cantidad;
                  const nuevasCuotas: Array<{ numero: number; monto: string; fechaVencimiento: string }> = [];

                  for (let i = 1; i <= cantidad; i++) {
                    nuevasCuotas.push({
                      numero: i,
                      monto: montoPorCuota.toFixed(2),
                      fechaVencimiento: '',
                    });
                  }

                  setCuotas(nuevasCuotas);
                  setError(null);
                }}
                className="w-full bg-blue-600 text-white text-xs font-semibold py-2 rounded hover:bg-blue-700 transition"
              >
                ✓ Dividir en cuotas
              </button>
            </div>

            {/* Tabla de cuotas con fechas y links */}
            {cuotas.length > 0 && (
              <div>
                <p className="text-xs font-semibold text-[#6B5D45] mb-2 uppercase">Ingresar datos de cuotas</p>
                <div className="overflow-x-auto">
                  <table className="w-full text-xs mb-3">
                    <thead className="bg-blue-100 border-b border-blue-200">
                      <tr>
                        <th className="text-left px-2 py-1 font-semibold">Cuota</th>
                        <th className="text-right px-2 py-1 font-semibold">Monto</th>
                        {['transferencia', 'mercadopago'].includes(formaPago) && (
                          <th className="text-right px-2 py-1 font-semibold">Imp. 0.6%</th>
                        )}
                        <th className="text-left px-2 py-1 font-semibold">Vencimiento</th>
                        {esCheque && (
                          <th className="text-left px-2 py-1 font-semibold">Link comprobante</th>
                        )}
                      </tr>
                    </thead>
                    <tbody>
                      {cuotas.map((cuota, idx) => {
                        const montoCuota = parseFloat(cuota.monto);
                        const debeAplicarImpuesto = ['transferencia', 'mercadopago'].includes(formaPago);
                        const impuestoCuota = debeAplicarImpuesto ? montoCuota * 0.006 : 0;
                        return (
                          <tr key={cuota.numero} className="border-b border-blue-100">
                            <td className="px-2 py-1">Cuota {cuota.numero}</td>
                            <td className="text-right px-2 py-1 font-semibold">${montoCuota.toFixed(2)}</td>
                            {debeAplicarImpuesto && (
                              <td className="text-right px-2 py-1 text-[#A8552E] font-semibold">${impuestoCuota.toFixed(2)}</td>
                            )}
                            <td className="px-2 py-1">
                              <input
                                type="date"
                                value={cuota.fechaVencimiento}
                                onChange={(e) => {
                                  const nuevasCuotas = [...cuotas];
                                  nuevasCuotas[idx].fechaVencimiento = e.target.value;
                                  setCuotas(nuevasCuotas);
                                }}
                                className="border border-[#D8CDB0] rounded px-1 py-0.5 bg-white text-[#2C2419] text-xs w-28"
                              />
                            </td>
                            {esCheque && (
                              <td className="px-2 py-1 min-w-64">
                                <input
                                  type="text"
                                  placeholder="https://drive.google.com/..."
                                  value={cuota.urlEcheq || ''}
                                  onChange={(e) => {
                                    const nuevasCuotas = [...cuotas];
                                    nuevasCuotas[idx].urlEcheq = e.target.value;
                                    setCuotas(nuevasCuotas);
                                  }}
                                  className="w-full border border-[#D8CDB0] rounded px-1 py-0.5 bg-white text-[#2C2419] text-xs"
                                />
                              </td>
                            )}
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
                <div className="flex justify-between items-center">
                  <p className="text-xs text-blue-700 font-semibold">
                    Total: ${cuotas.reduce((sum, c) => sum + parseFloat(c.monto), 0).toFixed(2)}
                  </p>
                  <button
                    type="button"
                    onClick={() => {
                      setCuotas([]);
                      setMontoCuotasTotales('');
                      setCantidadCuotas('');
                    }}
                    className="text-xs text-blue-600 hover:text-blue-800 font-semibold underline"
                  >
                    Limpiar
                  </button>
                </div>
              </div>
            )}
          </div>
        )}

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
                IVA
              </label>
              <select
                value={tipoIva}
                onChange={(e) => {
                  setTipoIva(e.target.value as '21' | '10.5' | 'personalizado');
                  if (e.target.value === '21') setAlicuotaIva(21);
                  if (e.target.value === '10.5') setAlicuotaIva(10.5);
                }}
                className="w-full border border-[#D8CDB0] rounded-lg px-3 py-2.5 bg-white text-[#2C2419]"
              >
                <option value="21">21%</option>
                <option value="10.5">10.5%</option>
                <option value="personalizado">Personalizado</option>
              </select>
            </div>

            {/* Monto IVA personalizado */}
            {tipoIva === 'personalizado' && (
              <div className="mb-4">
                <label className="block text-xs font-semibold text-[#6B5D45] uppercase tracking-wide mb-1.5">
                  Monto de IVA
                </label>
                <div className="flex items-center gap-2">
                  <span className="text-[#8A7A5C]">$</span>
                  <input
                    type="number"
                    inputMode="decimal"
                    placeholder="0"
                    value={montoIvaPersonalizado}
                    onChange={(e) => setMontoIvaPersonalizado(e.target.value)}
                    className="flex-1 border border-[#D8CDB0] rounded-lg px-3 py-2.5 bg-white text-[#2C2419]"
                  />
                </div>
              </div>
            )}

            {/* Upload Factura */}
            <div className="mb-4">
              <label className="block text-xs font-semibold text-[#6B5D45] uppercase tracking-wide mb-1.5">
                📷 Factura <span className="text-[#A89878] font-normal">(opcional)</span>
              </label>
              <div className="space-y-2">
                {/* Upload opción A */}
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

                {/* O pegar link de Drive */}
                <div>
                  <p className="text-xs text-[#8A7A5C] mb-1.5">O pegar link de Drive: <span className="text-[#A89878]">(opcional)</span></p>
                  <input
                    type="text"
                    placeholder="https://drive.google.com/..."
                    value={urlFacturaDrive}
                    onChange={(e) => setUrlFacturaDrive(e.target.value)}
                    className="w-full border border-[#D8CDB0] rounded-lg px-3 py-2.5 bg-white text-[#2C2419]"
                  />
                </div>
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
            onChange={(e) => {
              setFormaPago(e.target.value as FormaPago);
              if (e.target.value !== 'transferencia') {
                setEsCheque(false);
              }
            }}
            className="w-full border border-[#D8CDB0] rounded-lg px-3 py-2.5 bg-white text-[#2C2419]"
          >
            <option value="efectivo">Efectivo</option>
            <option value="mercadopago">MercadoPago</option>
            <option value="transferencia">Cuenta BNA</option>
          </select>
        </div>

        {/* ¿Es cheque? (solo para transferencia) */}
        {formaPago === 'transferencia' && tipo === 'egreso' && (
          <div className="mb-4 p-3 bg-blue-50 border border-blue-200 rounded-lg">
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={esCheque}
                onChange={(e) => setEsCheque(e.target.checked)}
                className="w-4 h-4 rounded border-[#D8CDB0]"
              />
              <span className="text-sm font-medium text-[#2C2419]">
                ¿Es cheque o echeq?
              </span>
            </label>
          </div>
        )}

        {/* Estado de pago (deshabilitado si es en cuotas) */}
        {!esEnCuotas && (
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
        )}

        {/* Fecha de pago (solo si está confirmado y NO es en cuotas) */}
        {!esEnCuotas && movimientoEstado === 'confirmado' && (
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

        {/* Fecha estimada de pago (solo si está pendiente y NO es en cuotas) */}
        {!esEnCuotas && movimientoEstado === 'pendiente' && (
          <div className="mb-4">
            <label className="block text-xs font-semibold text-[#6B5D45] uppercase tracking-wide mb-1.5">
              Fecha estimada de pago
            </label>
            <input
              type="date"
              value={fechaPagoEstimada}
              onChange={(e) => setFechaPagoEstimada(e.target.value)}
              className="w-full border border-[#D8CDB0] rounded-lg px-3 py-2.5 bg-white text-[#2C2419]"
            />
            <p className="text-xs text-[#8A7A5C] mt-1">Necesaria para el cronograma de pagos</p>
          </div>
        )}

        {/* Link comprobante echeq (solo si es cheque) */}
        {esCheque && (
          <div className="mb-4">
            <label className="block text-xs font-semibold text-[#6B5D45] uppercase tracking-wide mb-1.5">
              Link comprobante (Drive) <span className="text-[#A89878] font-normal">(opcional)</span>
            </label>
            <input
              type="text"
              placeholder="https://drive.google.com/..."
              value={urlEcheq}
              onChange={(e) => setUrlEcheq(e.target.value)}
              className="w-full border border-[#D8CDB0] rounded-lg px-3 py-2.5 bg-white text-[#2C2419]"
            />
            <p className="text-xs text-[#8A7A5C] mt-1">Enlace a la emisión del cheque/echeq</p>
          </div>
        )}

        {/* Notas */}
        <div className="mb-4">
          <label className="block text-xs font-semibold text-[#6B5D45] uppercase tracking-wide mb-1.5">
            Notas <span className="text-[#A89878] font-normal">(opcional)</span>
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
          disabled={
            crearMutation.isPending ||
            !concepto.trim() ||
            (!esEnCuotas && !monto) ||
            (esEnCuotas && cuotas.length === 0) ||
            (!esEnCuotas && movimientoEstado === 'pendiente' && !fechaPagoEstimada)
          }
          className="w-full bg-[#A8552E] disabled:bg-[#D8CDB0] disabled:text-[#A89878] text-white font-semibold py-3.5 rounded-lg active:scale-95 transition-transform"
        >
          {crearMutation.isPending ? 'Guardando...' : 'Guardar movimiento'}
        </button>
      </div>
    </div>
  </div>
  );
}
