# Importador de Mercado Pago - Account Money Reports

## 🎯 Objetivo

Importar todos los Account Money Reports históricos desde 2026-01-01 hasta hoy, en un paso único, sin generar archivos SQL enormes ni chunks manuales.

---

## 📋 Características

✅ Detecta automáticamente todos los CSVs en `data/mercadopago/`  
✅ Valida estructura flexible (columnas mínimas + nuevas permitidas)  
✅ Deduplicación automática por (source_type, source_external_id, payload_hash)  
✅ Permite períodos superpuestos sin duplicar movimientos  
✅ Preserva RAW completo en JSONB  
✅ Inserts por lotes (NO SQL gigantes)  
✅ **Idempotente**: seguro ejecutar múltiples veces  
✅ Transaccional en medida de lo posible  
✅ Resumen detallado al finalizar  

---

## ⚙️ Configuración (ONE-TIME)

### 1️⃣ Crear `.env.local`

En la **raíz del proyecto** (al lado de `package.json`), crea un archivo llamado:

```
.env.local
```

**NO lo commitees.** Ya está en `.gitignore`.

### 2️⃣ Completar credenciales

Obtén tus credenciales de Supabase:

#### 🔗 SUPABASE_URL

1. Ve a https://app.supabase.com/
2. Selecciona tu proyecto
3. **Settings** → **API**
4. Busca **"Project URL"**
5. Cópialo (formato: `https://xxxxx.supabase.co`)

#### 🔑 SUPABASE_SERVICE_ROLE_KEY

⚠️ **ADVERTENCIA**: Esta clave da acceso TOTAL a tu BD. NUNCA la compartas.

1. Ve a https://app.supabase.com/
2. Selecciona tu proyecto
3. **Settings** → **API**
4. Busca **"service_role"** (arriba de "anon")
5. Haz clic en **"Reveal"**
6. Cópialo

### 3️⃣ Contenido de `.env.local`

Pega esto en el archivo (reemplaza valores):

```
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_SERVICE_ROLE_KEY=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...
ACCOUNT_ID=1054315166
LOG_LEVEL=INFO
```

**Ejemplo real (SIN la clave real):**

```
SUPABASE_URL=https://abc123def.supabase.co
SUPABASE_SERVICE_ROLE_KEY=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImFiYzEyM2RlZiIsInJvbGUiOiJzZXJ2aWNlX3JvbGUifQ...
ACCOUNT_ID=1054315166
LOG_LEVEL=INFO
```

---

## 🚀 Cómo usar

### 0️⃣ Instalar dependencias (si es necesario)

```bash
python -m pip install supabase requests python-dotenv
```

O si usas `pip3`:

```bash
pip3 install supabase requests python-dotenv
```

### 1️⃣ Colocar CSVs

Descarga tus Account Money Reports de Mercado Pago y colócalos en:

```
data/mercadopago/
```

**Ejemplo:**

```
data/mercadopago/
  ├── Reporte_movimientos_mercadopago-manual-2026-01-01_a_2026-01-31.csv
  ├── Reporte_movimientos_mercadopago-manual-2026-02-01_a_2026-02-28.csv
  ├── Reporte_movimientos_mercadopago-manual-2026-03-01_a_2026-03-31.csv
  ├── ...
  └── Reporte_movimientos_mercadopago-manual-2026-09-01_a_2026-09-04.csv
```

### 2️⃣ Ejecutar importador

```bash
python scripts/import_mp_reports.py
```

O con `python3`:

```bash
python3 scripts/import_mp_reports.py
```

### 3️⃣ Revisar salida

El script mostrará:

```
================================================================================
  IMPORTADOR DE ACCOUNT MONEY REPORTS - MERCADO PAGO
================================================================================
[2026-09-04 14:30:15] INFO     Encontrados 9 archivos CSV
  • Reporte_movimientos_mercadopago-manual-2026-01-01_a_2026-01-31.csv
  • Reporte_movimientos_mercadopago-manual-2026-02-01_a_2026-02-28.csv
  ...

📄 Procesando: Reporte_movimientos_mercadopago-manual-2026-01-01_a_2026-01-31.csv
  ✓ Estructura válida (234 filas)
  Insertando 234 source records...
  Insertando 234 financial movements...
  ✓ Reporte_movimientos_mercadopago-manual-2026-01-01_a_2026-01-31.csv importado exitosamente

...

================================================================================
  RESUMEN DE IMPORTACIÓN
================================================================================

📁 ARCHIVOS:
  Encontrados:  9
  Procesados:   9
  Con error:    0

📊 DATOS:
  Filas leídas: 2145

📝 SOURCE RECORDS:
  Nuevos:       2145
  Ya existían:  0

💰 FINANCIAL MOVEMENTS:
  Nuevos:       2145
  Ya existían:  0

📋 LEDGER ENTRIES:
  Nuevos:       0
  Ya existían:  0

🏷 CLASIFICACIÓN:
  payment_in             1876
  payment_out              45
  transfer_in              58
  transfer_out             32
  yield                    20
  unclassified             14

💹 TOTALES FINANCIEROS:
  Rendimientos:       $12,345.67
  Impuestos:          -$8,234.56
  Balance Impact:     $10,780,612.05

================================================================================

✅ IMPORTACIÓN COMPLETADA
```

---

## 🔄 Ejecución múltiple

**Puedes ejecutar el script muchas veces sin riesgo:**

1. **Primera ejecución**: Importa todos los registros
2. **Segunda ejecución**: Detecta que ya existen (por UNIQUE constraint) e ignora
3. **Tercera ejecución**: Idem
4. **Si se corta a mitad**: Vuelve a ejecutar y continúa donde quedó

**Razón**: Usa `ON CONFLICT DO NOTHING`, que es idempotente.

---

## 🔍 Deduplicación automática

### ¿Cómo previene duplicados?

Cada `mp_source_record` se identifica por:

```
UNIQUE(source_type, source_external_id, payload_hash)
```

Esto significa:
- `source_type` = 'report' (todos son del mismo reporte CSV)
- `source_external_id` = SOURCE_ID del CSV (ej: "1234567890")
- `payload_hash` = SHA256 del contenido completo

**Ejemplo:**

Si descargas 2 CSVs que se superponen en Agosto:
- CSV1: 01/08 - 15/08 (500 movimientos)
- CSV2: 10/08 - 31/08 (400 movimientos, 200 repetidos de CSV1)

Al importar:
- Primera importación: Inserta 500 + 400 = 900 registros
- Segunda importación: Detecta 200 duplicados e ignora, inserta solo 200 nuevos

**El SOURCE_ID es la clave**: Si Mercado Pago asigna el mismo SOURCE_ID a dos períodos, el payload_hash diferenciará versiones.

---

## 🚨 Manejo de errores

### CSV inválido

```
❌ CSV inválido Reporte_2026-01-01.csv: Columnas faltantes: SOURCE_ID, TRANSACTION_DATE
```

**Solución**: Verifica que sea un "Account Money Report" de Mercado Pago válido.

### Estructura incompleta

```
⚠ Fila 45: DECIMAL conversion error
```

**Solución**: Revisa esa fila en el CSV. Probablemente un formato de número incorrecto.

### Conexión rechazada

```
Batch 0: HTTP 401
```

**Causas**:
- `SUPABASE_URL` incorrecto
- `SUPABASE_SERVICE_ROLE_KEY` expirado o inválido
- `.env.local` no encontrado

**Solución**: Verifica credenciales en `.env.local`.

---

## 🔐 Seguridad

### `.env.local` está protegido

```gitignore
.env.local
```

**NUNCA lo commitees.** Si lo haces por error:
1. Regenera la SERVICE_ROLE_KEY en Supabase
2. Haz `git rm --cached .env.local`
3. Commitea la remoción

### La KEY NO se imprime

El script NUNCA logea tu `SUPABASE_SERVICE_ROLE_KEY`, solo valida que exista.

---

## 📊 Estadísticas esperadas (Agosto 2026)

Según el CSV anterior:

```
Filas leídas:       716
Rendimientos:       20
Impuestos:          ~0.6% (withholdings)
Balance Impact:     $10,780,612.05
Unclassified:       0
```

---

## ❓ Preguntas frecuentes

**P: ¿Puedo ejecutar esto en Windows / Mac / Linux?**  
R: Sí. Solo necesitas Python 3.8+

**P: ¿Qué pasa si se corta la importación?**  
R: Ejecuta de nuevo. Los duplicados se ignoran automáticamente.

**P: ¿Cuánto tarda?**  
R: Depende del volumen. ~2-5 segundos por 1000 registros.

**P: ¿Se actualiza si un movimiento cambia?**  
R: No. Pero sí se versionan (nuevo payload_hash = nuevo source_record). El financial_movement no cambia.

**P: ¿Puedo hacer esto desde Netlify?**  
R: Todavía no. Este es un paso local. Después automatizaremos.

---

## 🛠 Troubleshooting

| Error | Causa | Solución |
|-------|-------|----------|
| `.env.local not found` | Archivo no creado | Ver sección "Configuración" |
| `Credenciales incompletas` | URL o KEY vacío | Verifica `.env.local` |
| `connection refused` | URL incorrecta | Copia exacta desde Supabase |
| `401 Unauthorized` | KEY expirada | Regenera en Supabase |
| `Estructura inválida` | CSV no es Account Money Report | Descarga directamente de MP |

---

## 📞 Contacto

Si tienes dudas sobre el proceso, revisa:
- El archivo `.env.local.example` (si existe)
- Los logs de ejecución (incluyen timestamps)
- La sección INSTRUCCIONES dentro de `scripts/import_mp_reports.py`
