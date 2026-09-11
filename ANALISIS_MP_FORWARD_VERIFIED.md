# Análisis MP Forward: Verificado contra Documentación Oficial

**Fecha**: 2026-09-11  
**Status**: INVESTIGACIÓN EN PROGRESO - Verificando endpoints reales vs. especulación  

---

## LO QUE SABEMOS CON CERTEZA

### Fuente Histórica Comprobada

Los 4198 movimientos históricos vinieron de:
- **Archivos**: `Liberaciones1.csv`, `Liberaciones2.csv`, `Liberaciones3.csv`
- **Estructura**: Account Money Report estándar de MP
- **Campos**: DATE, SOURCE_ID, DESCRIPTION, NET_CREDIT_AMOUNT, NET_DEBIT_AMOUNT, GROSS_AMOUNT, MP_FEE_AMOUNT, TAXES_AMOUNT, etc.
- **Período**: 2026-02-01 a 2026-09-04

### Endpoint Oficial Documentado para Este Reporte

Según `.planning/MERCADOPAGO_REDESIGN_TECHNICAL_REPORT.md` (que cita documentación oficial):

| Operación | Endpoint | Método |
|-----------|----------|--------|
| Generar Account Money Report | `/v1/account/money_report` | POST |
| Obtener estado del reporte | `/v1/account/money_report/{id}` | GET |
| Descargar CSV | ❓ **NECESITA VERIFICACIÓN** | GET |

### Nota Sobre Descarga

El reporte técnico dice:
> "Reports generate but download requires dashboard access or email"

**PERO** el usuario proporcionó links a documentación oficial que dice descarga VÍA API SÍ ES POSIBLE:
- https://www.mercadopago.com.ar/developers/es/docs/links-and-debts/additional-content/reports/account-money/api

Esto contradice el documento técnico. **NECESITA verificación directa.**

---

## ENDPOINTS EN USO ACTUAL EN CÓDIGO

### Endpoint: `/v1/account/money/balance/movements`

**Estado**: USADO en `sync-mercadopago-movements.ts`

```typescript
const res = await fetch(
  `https://api.mercadopago.com/v1/account/money/balance/movements?limit=100&offset=${offset}`,
  { headers: { Authorization: `Bearer ${mpToken}` } }
);
```

**Hallazgo**: Este endpoint ESTÁ en uso en el código, pero:
- ❓ NO aparece en documentación oficial de MP proporcionada
- ❓ NO está confirmado en la especificación de Reports API
- ⚠️ Podría ser un endpoint LEGACY o NO documentado

**Riesgo**: Si MP lo depreca, se rompe la sincronización.

### Endpoints: Settlement Report (variantes)

El código prueba múltiples variantes:
- `/v1/account/settlement_report/{id}` (confirmado en docs)
- `/v1/account/settlement_report/{id}/download`
- `/v1/reports/settlement/{id}`
- etc.

---

## WEBHOOKS: Estado Actual

### Webhooks Oficialmente Soportados (según MP docs)

✅ **Confirmados en MP official docs**:
- `payment.created`
- `payment.updated`
- `payment.refunded`
- `chargeback.created`

⚠️ **Inciertos** (mencionados en código pero no confirmados en docs):
- `commission.created` (puede no estar habilitado por defecto)
- `investment_yield.created` (NO confirmado oficialmente)

**Estado actual del webhook**:
- `netlify/functions/webhook-mercadopago.ts` existe
- NO valida firma HMAC (código dice "we can skip for now if not configured")
- Guarda en `mercadopago_raw` y `mercadopago_movements` (NO en estructura limpia)

---

## PROPUESTA: Flujo Forward CONSERVADOR

### Opción A: Webhook + `/v1/account/money_report` (MÁS SEGURO)

```
FUENTE 1: Webhook
├─ Recibe eventos de payment.created, payment.updated, payment.refunded, chargeback.created
├─ Valida firma HMAC (official security)
├─ Fetch recurso completo desde MP API antes de persistir
├─ Insert a mp_source_record → mp_financial_movement → ledger_entry
└─ Latencia: < 5 segundos

FUENTE 2: Sincronización Periódica (cada 4-6 horas)
├─ POST /v1/account/money_report (generar reporte)
├─ Poll GET /v1/account/money_report/{id} hasta "completed"
├─ Descarga CSV (método: ¿API o email parsing?)
├─ Parsea CSV (mismo formato que Liberaciones1/2/3)
├─ Insert solo movimientos nuevos a mp_source_record
├─ Dedup por fingerprint (fecha + source_id + amount + description)
└─ Cobertura: 100% de movimientos que afecten saldo
```

**Ventaja**: Usa endpoint OFICIAL de Account Money Report (es lo que originalmente importamos)  
**Desventaja**: Descarga es asíncrona, no en tiempo real

### Opción B: Webhook + `/v1/account/money/balance/movements` (MÁS RÁPIDO, MENOS SEGURO)

```
FUENTE 1: Webhook (igual a Opción A)

FUENTE 2: Sync Periódica (cada 4 horas)
├─ GET /v1/account/money/balance/movements?limit=100&offset=0
├─ Fetch últimas 48-72 horas
├─ Dedup por fingerprint
├─ Insert movimientos nuevos
└─ Problema: Endpoint NO está en docs oficiales de MP
```

**Ventaja**: Sync más rápida, directa por API  
**Desventaja**: Endpoint no documentado, riesgo de deprecación, NO verificado

---

## DECISIÓN REQUERIDA: ¿Cuál Opción?

**Recomendación**: **OPCIÓN A (Account Money Report)**

**Razón**:
1. Es el mismo reporte que usamos para importar los 4198 históricos ✅
2. Endpoint está documentado oficialmente en MP ✅
3. Cubre 100% de movimientos (pagos, comisiones, impuestos, rendimientos, etc.) ✅
4. Desventaja (sincronización asíncrona) es aceptable para reportes ✅
5. NO depende de endpoint no documentado ✅

---

## SIGUIENTE PASO CRÍTICO

Antes de cualquier implementación:

**Verificar directamente en documentación oficial de MP:**

1. **¿Cómo descargar Account Money Report vía API?**
   - Link del usuario: https://www.mercadopago.com.ar/developers/es/docs/links-and-debts/additional-content/reports/account-money/api
   - ¿Es `/v1/account/money_report/{id}/download`?
   - ¿O requiere parsear email?

2. **¿Qué webhooks OFICIALES soporta MP?**
   - Confirmar: payment.created, payment.updated, payment.refunded, chargeback.created
   - ¿Existe: commission.created?
   - ¿Existe: investment_yield.created?

3. **Status del endpoint `/v1/account/money/balance/movements`:**
   - ¿Es endpoint público documentado?
   - ¿O es legacy/experimental?

---

## ARCHIVOS A CREAR/MODIFICAR (UNA VEZ DECIDIDO)

### Si Opción A (Account Money Report):

**Nuevos**:
1. `scripts/sync_account_money_report_forward.py`
   - Genera `/v1/account/money_report` (última 72h)
   - Descarga CSV (via API o email)
   - Parsea y dedup
   - Insert a estructura limpia (mp_source_record → mp_financial_movement → ledger_entry)

2. `netlify/functions/webhook-mercadopago-v2.ts`
   - Valida firma HMAC
   - Fetch recurso completo
   - Insert a estructura limpia

**Modificar**:
1. `.github/workflows/sync-mercadopago.yml` - Cambiar endpoint de sync
2. `.env.local` - Agregar WEBHOOK_SIGNATURE_SECRET

---

## ESTADO ACTUAL

- ✅ Estructura limpia (mp_source_record → mp_financial_movement → ledger_entry): validada, 4198 registros
- ✅ Webhook endpoint existe: validado, pero SIN seguridad HMAC
- ⚠️ Account Money Report API: documentada en MP, método de descarga NECESITA verificación
- ❓ `/v1/account/money/balance/movements`: usado en código, NECESITA verificar si es oficial
- ❌ Implementación forward: pendiente hasta resolver incertidumbres

**NO EJECUTAR NADA HASTA RESOLVER ESTOS 3 PUNTOS.**
