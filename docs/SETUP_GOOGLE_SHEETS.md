# Conectar Google Sheets con Supabase

## Setup rápido (5 minutos)

### 1. Crear Google Sheet
- Abre Google Sheets: https://sheets.google.com
- Nuevo documento
- Renombra a "Granja Santo Tomás - Dashboard"

### 2. Agregar el script
- Menú **Extensiones → Apps Script**
- Borra el código por defecto
- Copia todo el contenido de `supabase-sheets-script.gs`
- Reemplaza:
  - `SUPABASE_URL` = tu URL de Supabase (ej: `https://xxxx.supabase.co`)
  - `SUPABASE_KEY` = tu **anon key** de Supabase (panel → Settings → API)
- **Guarda** (Ctrl+S)

### 3. Usar las funciones
En cualquier celda de tu Sheet:

```
=SUPABASE_CLIENTES()          → Tabla de clientes
=SUPABASE_PRECIOS()           → Tabla de precios
=SUPABASE_PEDIDOS()           → Últimos 50 pedidos
=SUPABASE_PAGOS()             → Últimos 100 pagos
```

### 4. Actualizar desde menú
- Menú **Supabase** (aparece en tu Sheet)
- Botones para refrescar cada tabla

---

## Cargar datos previos desde CSV

### Opción A: Interfaz web de Supabase (Recomendado)

1. Abre Supabase console
2. Tabla `clientes`:
   - Click en ⋮ (arriba a la derecha) → "Import data"
   - Sube `data/clientes.csv`
   - Elige "Insert" (no reemplaces)

3. Tabla `precios_actuales`:
   - Primero borra las filas existentes (o reemplaza)
   - Click en ⋮ → "Import data"
   - Sube `data/precios.csv`

### Opción B: SQL directo

```sql
-- Limpiar y cargar clientes
TRUNCATE TABLE public.clientes CASCADE;

INSERT INTO public.clientes (nombre, activo)
VALUES
  ('Juan García', true),
  ('María López', true),
  ('Carlos Pérez', true),
  ('Ana Martínez', true),
  ('Roberto Silva', true),
  ('Patricia Gómez', true),
  ('Fernando López', true),
  ('Claudia Ruiz', true),
  ('Diego Morales', true),
  ('Elena Fernández', true);

-- Actualizar precios
UPDATE public.precios_actuales SET precio = 5000 WHERE categoria = 'xl';
UPDATE public.precios_actuales SET precio = 4500 WHERE categoria = 'n1';
UPDATE public.precios_actuales SET precio = 3800 WHERE categoria = 'n2';
UPDATE public.precios_actuales SET precio = 3200 WHERE categoria = 'n3';
UPDATE public.precios_actuales SET precio = 1200 WHERE categoria = 'docena';
```

---

## Funciones disponibles

| Función | Uso | Ejemplo |
|---------|-----|---------|
| `SUPABASE_CLIENTES()` | Lee todos los clientes | `=SUPABASE_CLIENTES()` |
| `SUPABASE_PRECIOS()` | Lee precios actuales | `=SUPABASE_PRECIOS()` |
| `SUPABASE_PEDIDOS()` | Lee últimos 50 pedidos | `=SUPABASE_PEDIDOS()` |
| `SUPABASE_PAGOS()` | Lee últimos 100 pagos | `=SUPABASE_PAGOS()` |
| `SUPABASE_CREAR_CLIENTE(nombre)` | Crea cliente nuevo | `=SUPABASE_CREAR_CLIENTE("Juan")` |
| `SUPABASE_ACTUALIZAR_PRECIO(cat, precio)` | Actualiza precio | `=SUPABASE_ACTUALIZAR_PRECIO("XL", 5500)` |

---

## Troubleshooting

**Error: "Unauthorized"**
- Verifica que copiaste la **anon key** correcta (no la service role key)
- Revisa que URL y KEY están sin espacios

**Error: "CORS"**
- Asegúrate que Supabase permite requests desde Google Sheets
- Esto debería funcionar por defecto, pero si no: Settings → Security → Add google.com a whitelist

**Función devuelve error**
- Abre Developer Tools (Ctrl+Shift+J en Apps Script)
- Busca el error exacto
- Revisa la respuesta de Supabase

---

## Próximos pasos

- Agregar más clientes directamente en Sheets
- Actualizar precios desde Sheets
- Ver pedidos y pagos en tiempo real
- Hacer reportes/dashboards con los datos
