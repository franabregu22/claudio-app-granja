# ETAPA 4: TEST DE IDEMPOTENCIA - INSTRUCCIONES

## ⚠️ SEGURIDAD PRIMERO

Este test debe ejecutarse EXCLUSIVAMENTE en un entorno STAGING o DEVELOPMENT.

**NUNCA en producción.**

## Archivos generados

1. **`supabase/migrations/004_mp_new_architecture.sql`**
   - Migración con las 5 tablas nuevas

2. **`scripts/import_mp_report.sql`**
   - SQL con 716 source records + financial movements + ledger entries
   - Generado por `import_mp_report.py` (ya ejecutado)

3. **`scripts/test_idempotence.sql`**
   - Script de validación completo
   - Incluye: verificaciones, idempotencia, versionado

## Flujo de test (para ejecutar en tu entorno seguro)

### Paso A: Preparar ambiente

1. Conectarte a tu Supabase staging/development
2. O alternativamente, usar PostgreSQL local si lo tienes

### Paso B: Ejecutar test

```bash
# Opción 1: PostgreSQL local
psql -d tu_db_staging -f supabase/migrations/004_mp_new_architecture.sql
psql -d tu_db_staging -f scripts/import_mp_report.sql
psql -d tu_db_staging -f scripts/test_idempotence.sql > test_results.txt

# Opción 2: Supabase (si tienes CLI)
supabase db pull --staging  # Usar staging, no main
supabase functions deploy  # Si aplica
# Luego ejecutar los SQL en Supabase Studio SQL editor
```

## Qué esperar

### Primera importación:
- 716 source records ✓
- 716 financial movements ✓
- 716 movement links ✓
- 716 ledger entries ✓
- 0 unclassified movimientos ✓
- 543 payment_in, 127 transfer_in, 26 payment_out, 20 yield ✓
- SETTLEMENT_NET_AMOUNT total = $10,780,612.05 ✓
- Rendimientos total = $38,896.48 ✓

### Segunda importación (idempotencia):
- 0 nuevos source records
- 0 nuevos financial movements
- Mismos totales que antes

### Validaciones:
- 0 duplicados en source records
- 0 duplicados en financial movements
- 0 orphaned ledger entries
- 0 movimientos sin source link
- 0 unclassified movimientos

## Cambios desde análisis anterior

✅ Regla agregada para `digital_currency/consumer_credits → payment_in`
✅ Ahora 543 payment_in (era 542, más el digital_currency)
✅ 0 unclassified (era 1)

## IMPORTANTE: No ejecutes en producción

Esta es una versión de test. Úsala SOLO en:
- Supabase staging branch
- PostgreSQL local
- Entorno Docker aislado
- Cualquier ambiente descartable

NO en la base de datos de producción.

## Próximos pasos (después del test)

Una vez que este test pase:
- ETAPA 5: Opening balance + saldo calculado
- ETAPA 6: UI
- ETAPA 7+: Automatización

