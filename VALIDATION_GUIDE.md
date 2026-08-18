# Guía de Validación con Zod

## ¿Qué es?
Sistema de validación exhaustiva para prevenir inyección de código malicioso en todos los formularios.

## Cómo Usar

### 1. En un formulario (ejemplo FormMovimiento.tsx)

```typescript
import { movimientoCajaSchema, type MovimientoCajaInput } from '../validation/schemas';
import { useFormValidation } from '../hooks/useFormValidation';

function FormMovimiento() {
  const [formData, setFormData] = useState<Partial<MovimientoCajaInput>>({});
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  const { handleSubmit, isSubmitting } = useFormValidation({
    schema: movimientoCajaSchema,
    onSubmit: async (data) => {
      // 'data' ya está validado y tipado
      await crearMovimiento(data);
    },
  });

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const { name, value } = e.target;
    setFormData(prev => ({ ...prev, [name]: value }));
  };

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setFieldErrors({});

    const result = movimientoCajaSchema.safeParse(formData);
    if (!result.success) {
      const errors: Record<string, string> = {};
      result.error.errors.forEach((err) => {
        errors[err.path[0] as string] = err.message;
      });
      setFieldErrors(errors);
      return;
    }

    await handleSubmit(formData);
  };

  return (
    <form onSubmit={onSubmit}>
      <input
        name="concepto"
        value={formData.concepto || ''}
        onChange={handleChange}
        className={fieldErrors.concepto ? 'border-red-500' : ''}
      />
      {fieldErrors.concepto && <span>{fieldErrors.concepto}</span>}

      {/* ... más campos */}

      <button type="submit" disabled={isSubmitting}>
        {isSubmitting ? 'Guardando...' : 'Guardar'}
      </button>
    </form>
  );
}
```

## Schemas Disponibles

| Schema | Archivo | Uso |
|--------|---------|-----|
| `loginSchema` | Auth | Login |
| `clienteSchema` | Clientes | Crear/editar cliente |
| `movimientoCajaSchema` | Caja | Crear movimiento |
| `chequeSchema` | Caja | Crear cheque |
| `comisionSchema` | Caja | Crear comisión |
| `loteSchema` | Producción | Crear lote |
| `productoSchema` | Productos | Crear/editar producto |

## Qué Protege

### ✅ **Inyección de Código**
```typescript
// ANTES (sin validación):
const concepto = userInput; // "Gasto</script><img src=x onerror=alert('xss')>"

// DESPUÉS (con validación):
// Rechaza cualquier carácter no permitido
// Máximo: concepto.max(200)
// Regex: /^[a-zA-Z0-9\s\-áéíóúñ\.\,\:\(\)]+$/
```

### ✅ **Longitud Excesiva**
```typescript
// Rechaza strings > max length
// Ej: "A".repeat(10000) será rechazado
```

### ✅ **Tipos Incorrectos**
```typescript
// Rechaza:
monto: "abc" // Esperaba number
estado: "INVALID" // Esperaba enum específico
```

### ✅ **Fechas Futuras**
```typescript
fecha_operacion: "2099-01-01" // Rechazada
// Solo acepta fechas <= hoy
```

### ✅ **Valores Negativos**
```typescript
// Rechaza montos < 0, porcentajes < 0, etc.
```

### ✅ **Caracteres Especiales Maliciosos**
```typescript
// Permitidos: letras, números, guiones, puntos
// Rechazados: <, >, &, ", ', scripts, etc.
```

## Errores Personalizados

Cada validación tiene un mensaje en español:
```
"Email inválido"
"Min 8 caracteres"
"Max 200 caracteres"
"Caracteres no permitidos"
"Solo letras, números y guiones"
```

## Próximos Pasos

1. **Aplicar a FormMovimiento.tsx**
2. **Aplicar a todos los formularios de Caja**
3. **Aplicar a formularios de Producción**
4. **Agregar rate limiting en Edge Function**
5. **Agregar logging de intentos fallidos**

## Testing

Prueba intentando injecciones maliciosas:

```javascript
// Prueba 1: XSS
concepto = "<img src=x onerror='alert(1)'>"
// Resultado: RECHAZADO ✓

// Prueba 2: SQL Injection
concepto = "'; DROP TABLE usuarios; --"
// Resultado: RECHAZADO ✓

// Prueba 3: String muy largo
concepto = "A".repeat(300)
// Resultado: RECHAZADO (max 200) ✓

// Prueba 4: Monto negativo
monto = -1000
// Resultado: RECHAZADO ✓

// Prueba 5: Fecha futura
fecha = "2099-01-01"
// Resultado: RECHAZADO ✓
```
