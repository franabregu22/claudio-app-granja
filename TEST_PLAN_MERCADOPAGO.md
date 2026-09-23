# Test Plan: MercadoPago Integration

**Objetivo:** Validar que la integración completa funciona end-to-end  
**Responsable:** Tú  
**Plazo:** 24-27 de septiembre

---

## DÍA 1 (23 sept) — COMPLETADO ✅

- [x] Commit de MonthlyReport, mercadopago-monthly API
- [x] Commit de componente UnclassifiedMovements
- [x] Commit de scripts de validación

---

## DÍA 2 (24 sept) — VALIDACIÓN LOCAL

### Test 1: Levantar servidor local

```bash
npm run dev
```

- [ ] Aplicación levanta sin errores en consola
- [ ] DevTools: No hay 404s en red
- [ ] Puerto correcto (generalmente http://localhost:5173)

### Test 2: Navegar a MercadoPagoApp

- [ ] Clickear en "Mercado Pago" en el menú
- [ ] Esperado: Ver dashboard con Summary Cards vacías o llenas (dependiendo de datos)
- [ ] No debe haber errores de acceso negado (solo si rol=dueño)

### Test 3: Validar endpoint de validación

En DevTools Console o en nueva pestaña, llamar:

```javascript
fetch('/.netlify/functions/validate-mercadopago-integration')
  .then(r => r.json())
  .then(d => console.log(d))
```

**Esperado:**
```json
{
  "summary": {
    "total": 6,
    "passed": 6,
    "failed": 0,
    "warnings": 0,
    "ready": true
  },
  "results": [...]
}
```

- [ ] Todos los checks pasan (failed = 0)
- [ ] Query compleja OK
- [ ] Tablas existen con registros

### Test 4: Verificar datos en UI

**Sección: Summary Cards**
- [ ] ¿Aparecen números de ingresos/egresos/rendimientos?
- [ ] ¿Están en el rango esperado (no negativos ni cero si tienes movimientos)?

**Sección: Monthly Report Table**
- [ ] ¿Aparece tabla con meses?
- [ ] ¿Columnas: Mes, Ingresos, Egresos, Rendimientos, Impuesto al Cheque?
- [ ] ¿Números están en formato moneda (ARS)?
- [ ] ¿Hay fila de TOTAL?

**Sección: Clasificación Manual (UnclassifiedMovements)**
- [ ] ¿Aparece la sección?
- [ ] Si está vacía: "✅ Todos los movimientos están clasificados" ← Excelente
- [ ] Si hay movimientos sin clasificar: Mostrar cada uno con opciones de clasificación

### Test 5: Filtros de fecha y tipo

- [ ] Cambiar fecha (current_month → last_month)
- [ ] Esperado: Tabla de movimientos se actualiza
- [ ] Cambiar filtro de tipo (payment_in, yield, etc)
- [ ] Esperado: Movimientos se filtran

**Checklist Día 2:**
- [ ] Servidor levanta sin errores
- [ ] MercadoPagoApp carga
- [ ] Validación endpoint = ready: true
- [ ] Summary Cards muestran datos
- [ ] Monthly Report muestra tabla
- [ ] UnclassifiedMovements carga (vacía o con movimientos)
- [ ] Filtros funcionan

---

## DÍA 3 (25 sept) — TESTS CON DATOS SIMULADOS

### Test 6: Simular ingesta de CSV pequeño

Si tienes datos de prueba en CSV:

1. Descargar CSV pequeño de M.P. (o crear datos de prueba)
2. Ejecutar function de import (si existe endpoint)
3. Esperar a que procese

**Alternativa:** Insertar datos directamente en BD (si tienes acceso a Supabase dashboard):

```sql
INSERT INTO mp_source_record (
  source_type, source_external_id, payload_hash, raw_data, observed_at
) VALUES (
  'report', 'TEST_001', 'abc123', 
  '{"TRANSACTION_AMOUNT": 1000, "SETTLEMENT_NET_AMOUNT": 985, "TAXES_AMOUNT": -15, ...}'::jsonb,
  NOW()
);
```

### Test 7: Validar que datos fluyen correctamente

Después de insertar test data, verificar en UI:

- [ ] Aparece nuevo movimiento en tabla
- [ ] Resumen se recalcula
- [ ] Balance actualiza

### Test 8: Test de cálculos de impuestos

Para un movimiento con `settlement_amount = 1000`, `tax_amount = -15`:

- [ ] En tabla: Monthly Report → "Impuesto al Cheque" muestra 15
- [ ] Balance impact = 985 (no 1000)
- [ ] Cierre de balance refleja 985, no 1000

### Test 9: Rendimientos correctamente identificados

Insertar movimiento con:
- `PAYMENT_METHOD_TYPE = null`
- `PAYER_NAME = null`
- `TAXES_AMOUNT = 0`
- `TRANSACTION_AMOUNT > 0`

- [ ] Debe clasificarse como 'yield'
- [ ] En Monthly Report: aparece en columna "Rendimientos"
- [ ] NO aparece en "Ingresos"

**Checklist Día 3:**
- [ ] Puedes insertar datos en BD
- [ ] Movimientos aparecen en UI
- [ ] Cálculos de tax/balance correctos
- [ ] Rendimientos se clasifican bien

---

## DÍA 4-5 (26-27 sept) — DATOS REALES DE MERCADOPAGO

### Test 10: Exportar CSV real de M.P.

1. Login a MercadoPago
2. Account → Reports → "Movimientos" o "Settlements"
3. Descargar CSV de un período (ej: agosto 2026)
4. Guardar en `~/Downloads/mercadopago_report.csv`

### Test 11: Contar transacciones

```bash
wc -l mercadopago_report.csv
# Esperado: cantidad total de filas (headers + data)
```

Anota el número: **______ transacciones**

### Test 12: Cargar CSV a BD

Opción A: Si existe endpoint POST /api/mercadopago/import-report:
```bash
curl -X POST http://localhost:3000/.netlify/functions/sync-settlement-csv \
  -F "file=@mercadopago_report.csv" \
  -H "Authorization: Bearer YOUR_TOKEN"
```

Opción B: Manual en Supabase dashboard:
- Ir a SQL Editor
- Ejecutar script de import manual

### Test 13: Validar números

Después de import, ejecutar queries:

```sql
SELECT COUNT(*) FROM mp_source_record WHERE source_type='report';
SELECT COUNT(*) FROM mp_financial_movement WHERE account_id = 1054315166;
SELECT COUNT(*) FROM ledger_entry WHERE account_id = 1054315166;
```

- [ ] Todos cuentan la misma cantidad (1:1 relationship)
- [ ] Cantidad ≈ filas del CSV

### Test 14: Conciliación de balance

En UI, en sección "Cierre del [fecha]":

- [ ] Saldo calculado: $XXX,XXX.XX
- [ ] Saldo observado: $YYY,YYY.YY (ingresar manualmente si no existe)
- [ ] Si ambos existen: ¿Diferencia = 0 o muy pequeña (<$1)?

**Si no coinciden:**
1. Revisar "Movimientos sin clasificar" → ¿hay muchos unclassified?
2. Revisar si hay "Rendimientos detectados" vs "Realidad en M.P."
3. Documentar la diferencia en `account_balance.variance_note`

### Test 15: Validar webhook (si está configurado)

Si tienes webhooks automáticos:

1. Realizar movimiento pequeño en M.P.
2. Esperar 30-60 segundos
3. Ir a UI → ¿aparece el movimiento nuevo?
4. DevTools Network: ¿hay llamada a webhook?

**Checklist Días 4-5:**
- [ ] CSV descargado de M.P.
- [ ] Movimientos cargados en BD
- [ ] Conteo: mp_source_record = mp_financial_movement = ledger_entry
- [ ] Balance calculado vs observado concuerdan (o variance está documentada)
- [ ] Webhook funciona (opcional pero deseado)

---

## DÍA 6 (28 sept) — DOCUMENTACIÓN Y REFINAMIENTO

### Test 16: UI Polish

- [ ] Colores: ¿rendimientos en amarillo, impuestos en naranja?
- [ ] Responsividad: ¿funciona en mobile (celular pequeño)?
- [ ] Spinners de carga: ¿aparecen mientras se cargan datos?
- [ ] Mensajes de error: ¿son claros si algo falla?

### Test 17: Documentación

Crear o actualizar README con:

```markdown
## MercadoPago Integration

### Cómo sincronizar datos

**Opción 1: CSV Manual (Mensual)**
1. Descargar CSV desde MercadoPago account
2. Subir a app (endpoint: POST /api/import-mp-report)
3. Validar en "Cierre de balance"

**Opción 2: Webhooks (Automático)**
- Cada transacción se sincroniza automáticamente
- Verificar en DevTools si llegas movimientos nuevos

### Movimientos sin clasificar

Si un movimiento no se clasifica automáticamente:
1. Verás en sección "Clasificación Manual"
2. Elige el tipo correcto
3. Sistema actualiza automáticamente

### Conciliación

Si el saldo calculado ≠ saldo en M.P.:
1. Revisar "Movimientos sin clasificar"
2. Si están todos clasificados, ingresar "Saldo observado" manualmente
3. Sistema calcula la diferencia y la reporta

### Impuestos

- Retención estándar: ~0.6%
- Se calcula automáticamente a partir del CSV
- Se reporta en "Impuesto al Cheque" de cada mes
```

**Checklist Día 6:**
- [ ] UI se ve bien (colores, responsive)
- [ ] Mensajes de error claros
- [ ] README documentado
- [ ] Usuario entiende cómo sincronizar

---

## DÍA 7 (29 sept) — VALIDACIÓN FINAL

### Test 18: Checklist de Go-Live

- [ ] Todos los tests anteriores pasan
- [ ] Data real de M.P. se sincroniza correctamente
- [ ] Balance calculado concuerda con M.P. (±$1)
- [ ] Movimientos sin clasificar: 0 o pocos
- [ ] Webhooks funcionan (si están habilitados)
- [ ] Frontend UI responsivo y sin errores
- [ ] Documentación clara

### Test 19: Deploy a producción

```bash
git push
# Netlify redeploy automático
```

- [ ] Build pasa sin errores
- [ ] App levanta en producción
- [ ] Puedes acceder con rol=dueño

### Test 20: Smoke test en producción

- [ ] Abrir MercadoPagoApp en producción
- [ ] Verificar que datos aparecen
- [ ] Intenta clasificar un movimiento (si hay)
- [ ] Recarga página: datos persisten

**Checklist Día 7:**
- [ ] Todos los tests pasan
- [ ] Deploy en prod exitoso
- [ ] App funciona correctamente en producción

---

## RESUMEN: CHECKLIST DE ITEMS

```
DÍA 2 (24 sept):
  [ ] Servidor local levanta
  [ ] Validación endpoint = ready: true
  [ ] MercadoPagoApp se carga
  [ ] Summary Cards muestran datos
  [ ] Monthly Report tabla visible
  [ ] UnclassifiedMovements carga
  [ ] Filtros funcionan

DÍA 3 (25 sept):
  [ ] Datos de prueba insertados
  [ ] Cálculos de impuestos correctos
  [ ] Rendimientos bien identificados
  [ ] Balance se recalcula

DÍA 4-5 (26-27 sept):
  [ ] CSV de M.P. descargado
  [ ] Movimientos cargados
  [ ] Conteo coincide 1:1
  [ ] Balance concuerda (o variance documentada)
  [ ] Webhook funciona (opcional)

DÍA 6 (28 sept):
  [ ] UI se ve bien
  [ ] Documentación escrita
  [ ] Mensajes de error claros

DÍA 7 (29 sept):
  [ ] Deploy en producción
  [ ] Smoke test pasa
  [ ] Lista para usar en octubre
```

---

## NOTAS

- **Si encontrás bugs:** Crealos issues en GitHub o documentalos aquí
- **Si tienes preguntas:** Revisá [plan_implementacion_fase0.md](./MERCADOPAGO_COMPLETION.md)
- **Si algo no funciona:** Revisá logs de Netlify y Supabase Dashboard

**¿Estás listo para empezar con Día 2?** 🚀
