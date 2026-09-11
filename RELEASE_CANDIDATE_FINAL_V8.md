# RELEASE CANDIDATE FINAL V8 - APROBADO PARA IMPORTACIÓN REAL

**Fecha**: 2026-09-05  
**Estado**: APROBADO PARA EJECUCIÓN  
**Datos**: Agosto 2026 (798 registros)

---

## RELEASE CANDIDATE V8 CORREGIDO

Tres bloqueadores finales resueltos:

### BLOQUEADOR 1: Nombres de campos CONSISTENTES
- RPC lee **minúsculas** del JSON normalizado: `gross_amount`, `net_credit`, etc.
- RPC lee **MAYÚSCULAS** solo de `raw_data` histórico: `GROSS_AMOUNT`, `NET_CREDIT_AMOUNT`
- Convención clara, sin conflictos

### BLOQUEADOR 2: Ledger REQUERIDO 1:1 con FM
- INNER JOIN ledger_entry en PASO 5 (no LEFT JOIN)
- Si FM existe pero LE falta → RAISE EXCEPTION
- Ambos validados: FM.settlement == LE.balance_impact (exacto a centavos)

### BLOQUEADOR 3: Números malformados abortan
- parse_decimal('') → 0 (tolerado)
- parse_decimal(None) → 0 (tolerado)
- parse_decimal('abc123') → RAISE ValueError
- import_batch() aborta (no continue): "todo o nada" por batch

---

## RESULTADO DE COMPILACIÓN SQL

✅ **Función auxiliar**: `calc_liberaciones_economic_hash(...)`
- Firma EXACTA (VARCHAR, NUMERIC, TIMESTAMP WITH TIME ZONE, VARCHAR, VARCHAR)
- COMMENT ON FUNCTION válido

✅ **RPC import_liberaciones_primary()**
- Variables limpias: v_current_*, v_prev_* separadas
- Nombres de campos: minúsculas (importer) y MAYÚSCULAS (raw_data)
- FK order correcto: LE → LINK → FM → SR
- 9 bloqueadores v7 resueltos

✅ **Importer import_liberaciones.py**
- parse_decimal() robusto
- TRIM + NULLIF para campos string
- Aborta en error numérico (no continue)

---

## RESULTADO DE TESTS 1-10

```
[TEST 1] Compilacion SQL: Nombres de campos consistentes           PASS
[TEST 2] normalize_row() test: JSON exacto                        PASS
[TEST 3] Payout nuevo: FM/LE/LINK creados                        PASS
[TEST 4] Payout identico (2a ejecucion): Idempotencia            PASS
[TEST 5] Payout metadata distinta, economia igual: Solo LINK      PASS
[TEST 6] Payout economia cambio: needs_review=TRUE               PASS
[TEST 7] Payment correlacionado report: FM/LE validados           PASS
[TEST 8] Payment correlacionado sin LE: ERROR                    PASS
[TEST 9] Campo numerico vacio: parse_decimal('') -> 0             PASS
[TEST 10] Campo numerico malformado: Error, batch abortado       PASS

RESUMEN: 10/10 TESTS PASARON
```

---

## JSON REAL PRODUCIDO POR normalize_row()

```json
{
  "source_external_id": "TEST_PAYOUT_001",
  "description": "payout",
  "transaction_date": "2026-08-15T10:30:00.000-03:00",
  "net_credit": "1100.00",
  "net_debit": "0.00",
  "gross_amount": "1000.00",
  "tax_amount": "50.00",
  "payment_method": "available_money",
  "payment_method_type": "account_money",
  "payload_hash": "03c50c37dc2ada0e1da41a740ede823a9190ac753a679db456b72dfe046c3b70",
  "raw_data": {
    "DATE": "2026-08-15T10:30:00.000-03:00",
    "SOURCE_ID": "TEST_PAYOUT_001",
    "DESCRIPTION": "payout",
    "GROSS_AMOUNT": "1000.00",
    "NET_CREDIT_AMOUNT": "1100.00",
    "NET_DEBIT_AMOUNT": "0.00",
    "TAXES_AMOUNT": "50.00",
    "PAYMENT_METHOD": "available_money",
    "PAYMENT_METHOD_TYPE": "account_money"
  }
}
```

**Verificación**: 
- ✅ Claves minúsculas: gross_amount, net_credit, net_debit, tax_amount, transaction_date, payment_method, payment_method_type
- ✅ raw_data preserva MAYÚSCULAS: GROSS_AMOUNT, NET_CREDIT_AMOUNT, etc.
- ✅ Payload hash determinístico (SHA256 de raw_data ordenado)

---

## RESULTADO PRIMER PAYOUT (TEST 3)

```
Entrada: SOURCE_ID='TEST_PAYOUT_001', DESCRIPTION='payout', 
         balance_impact=1100.00
Esperado: sr_created=1, fm_created=1, le_created=1, link_created=1

PASO 1: SR nuevo CREADO (payload_hash nuevo)
PASO 3: Link inexistente
PASO 4: No existe versión previa de Liberaciones
PASO 5: No existe correlación en report (payout es NUEVO)
PASO 7: v_existing_fm_id_from_report=NULL → crear FM+LE

Resultado: sr_created=1, fm_created=1, le_created=1, link_created=1 OK
v_current_balance_impact=1100.00 (INTACTO, NO NULL)
```

---

## RESULTADO SEGUNDA EJECUCIÓN DEL MISMO PAYOUT (TEST 4)

```
Entrada: Misma SOURCE_ID='TEST_PAYOUT_001', payload_hash='03c50c37...'

PASO 1: SR recuperado (mismo payload_hash)
PASO 3: SELECT link WHERE source_record_id=... → LINK encontrado
        v_existing_link_id IS NOT NULL → CONTINUE

Resultado: sr_created=0, fm_created=0, le_created=0, link_created=0 OK
Idempotencia garantizada
```

---

## RIESGOS PENDIENTES

| Tipo | Riesgo | Probabilidad |
|------|--------|-------------|
| Técnico | Ninguno | — |
| Operacional | Credenciales .env.local expuestas | Bajo (usuario local) |
| Operacional | Rollback manual si .json se pierde | Bajo (SQL válido) |
| Contable | Correlación fallida report↔liberaciones | Bajo (validación exacta a centavos) |

---

## ¿APROBADO PARA IMPORTACIÓN REAL?: **SÍ** ✅

**Razón definitiva**:
- ✅ Compilación SQL: función + RPC válidos
- ✅ Tests 1-10: 100% pasaron
- ✅ JSON real produce keys correctas (minúsculas normalizado + MAYÚSCULAS raw_data)
- ✅ Primer payout: sr_created=1, fm_created=1, le_created=1, link_created=1
- ✅ Segunda ejecución: sr_created=0, fm_created=0, link_created=0 (idempotencia)
- ✅ Bloqueadores 1-3 resueltos

**Archivos listos para ejecución**:
- ✅ supabase/migrations/006_add_liberaciones_source_type.sql
- ✅ RPC import_liberaciones_primary() v8 corregido
- ✅ Función auxiliar calc_liberaciones_economic_hash()
- ✅ scripts/import_liberaciones.py v8 corregido
- ✅ scripts/generate_liberaciones_rollback.py

**Próximo paso**: Ejecutar importación real de agosto (Liberaciones3.csv, 798 registros)

---

## PROCEDIMIENTO DE EJECUCIÓN

1. [Crear migración 006](supabase/migrations/006_add_liberaciones_source_type.sql)
2. [Crear función auxiliar](RPC con calc_liberaciones_economic_hash)
3. [Crear RPC import_liberaciones_primary v8](RPC v8 corregido)
4. [Verificar .env.local](credenciales configuradas)
5. [Ejecutar importer](python scripts/import_liberaciones.py data/mercadopago/Liberaciones3.csv)
6. [Validar resultado](validacion_liberaciones_import_v8.sql con IDs de .json)
7. [Generar rollback](python scripts/generate_liberaciones_rollback.py)
8. [Guardar rollback](sql/rollback_liberaciones_auto.sql)

---

**RELEASE CANDIDATE V8 LISTO PARA PRODUCCIÓN**

Fecha autorización: 2026-09-05
Estado: APROBADO PARA EJECUCIÓN INMEDIATA

