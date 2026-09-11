# EJECUCIÓN PASO A PASO - COPIAR/PEGAR EN SUPABASE

**Preparado:** 2026-09-11  
**Próxima acción:** Abre Supabase SQL Editor y sigue estos pasos

---

## ✓ PASO 1: TEST TRANSACCIONAL

**Archivo:** `PASO_1_COPIAR_PEGAR.sql`

**Acción:**
1. Abre https://supabase.com/projects
2. Entra a tu proyecto
3. Haz clic en **"SQL Editor"** (lado izquierdo)
4. **Copiar TODO** el contenido de `PASO_1_COPIAR_PEGAR.sql`
5. **Pega** en el editor
6. Haz clic en **"Run"** (botón azul)

**Espera:** 5-10 segundos

**Qué ver:**
- Si PASS: verás "✓ IDEMPOTENT" en la tabla de validación
- Después verás "ROLLBACK" (automático)
- Al final: sr_final, fm_final, le_final = baseline (restaurado)

**Si falla:** Copia el error y pégamelo aquí

---

## ✓ PASO 2: APLICAR MIGRATION 010

**Archivo:** `PASO_2_APLICAR_010.sql`

**Acción (SOLO si Paso 1 PASS):**
1. Vuelve a **SQL Editor**
2. **Copiar TODO** el contenido de `PASO_2_APLICAR_010.sql`
3. **Pega** en el editor (borra el SQL anterior)
4. Haz clic en **"Run"**

**Espera:** 10-15 segundos

**Qué ver:**
- Sin errores = OK
- Verás "GRANT EXECUTE" al final

**Si falla:** Copia el error y pégamelo aquí

---

## ✓ PASO 3: REPETIR TEST (PASO 1 OTRA VEZ)

**Archivo:** `PASO_1_COPIAR_PEGAR.sql` (mismo)

**Acción (SOLO si Paso 2 OK):**
1. **Copiar TODO** el contenido de `PASO_1_COPIAR_PEGAR.sql`
2. **Pega** en el editor
3. Haz clic en **"Run"**

**Espera:** 5-10 segundos

**Qué ver:**
- Mismo resultado que Paso 1
- "✓ IDEMPOTENT"
- ROLLBACK automático
- Estado restaurado

**Si falla:** Detente, reporta error

---

## ✓ PASO 4: APLICAR CAMBIOS NETLIFY

**Archivo:** `CAMBIOS_NETLIFY_SYNC_RELEASES_STATUS.md`

**Acción (SOLO si Paso 3 OK):**
1. Abre `netlify/functions/sync-mercadopago-releases-status.ts` en tu editor
2. Lee los 4 cambios en `CAMBIOS_NETLIFY_SYNC_RELEASES_STATUS.md`
3. Aplica cada cambio:
   - Cambio 1: Ignorar control rows (sin SOURCE_ID)
   - Cambio 2: Nueva función buildInputRowForRPC()
   - Cambio 3: Construir p_input_rows (centavos→pesos)
   - Cambio 4: Bloquear unknown + WARNING log

4. **Guarda** el archivo
5. Haz **commit local** (no push aún):
   ```
   git add netlify/functions/sync-mercadopago-releases-status.ts
   git commit -m "WIP: Netlify changes for migration 010"
   ```

---

## CHECKLIST FINAL

- [ ] Paso 1: Test ✓ PASS (idempotencia + rollback OK)
- [ ] Paso 2: Migration 010 aplicada (sin errores)
- [ ] Paso 3: Test repetido ✓ PASS
- [ ] Paso 4: Cambios Netlify aplicados + commit local

---

## PRÓXIMO: GIT COMMIT FINAL

Cuando termines los 4 pasos, avísame con:
```
Todos los pasos completados
```

Y haré el git commit final + push.

---

## ARCHIVOS LISTOS

- ✓ PASO_1_COPIAR_PEGAR.sql (listo para copiar/pegar)
- ✓ PASO_2_APLICAR_010.sql (listo para copiar/pegar)
- ✓ CAMBIOS_NETLIFY_SYNC_RELEASES_STATUS.md (guía con 4 cambios)
- ✓ ORDEN_EXACTA_EJECUCION.md (referencia completa)

---

**Comienza con PASO 1. Avísame cuando termines cada paso.**
