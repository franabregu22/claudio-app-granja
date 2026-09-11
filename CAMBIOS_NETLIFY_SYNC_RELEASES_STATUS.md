# CAMBIOS EXACTOS: sync-mercadopago-releases-status.ts

**Ubicación:** `netlify/functions/sync-mercadopago-releases-status.ts`

**Cambios totales:** 4 puntos de actualización

---

## 1) IGNORAR OPENING/CLOSING (sin SOURCE_ID)

**Ubicación:** Línea 370 (dentro del loop de categorización)

**Antes:**
```typescript
for (const mov of movements) {
  const desc = mov.description.toLowerCase();
  const isDuplicate = duplicatesInSupabase.includes(mov);

  // Skip RAW_ONLY (reserves) - don't create FM for these
  if (desc === "reserve_for_payment" || desc === "reserve_for_payout") {
    rawOnlyCount++;
    if (isDuplicate) {
      rawOnlyDuplicate++;
    } else {
      rawOnlyNew++;
    }
    continue;
  }
  // ...
}
```

**Después:**
```typescript
for (const mov of movements) {
  const desc = mov.description.toLowerCase();
  const isDuplicate = duplicatesInSupabase.includes(mov);

  // Ignore control rows (opening/closing without SOURCE_ID)
  if (!mov.source_id || mov.source_id.trim() === "") {
    console.log(`[STATUS-REPORT] Ignoring control row without SOURCE_ID: ${desc}`);
    continue;
  }

  // Skip RAW_ONLY (reserves) - don't create FM for these
  if (desc === "reserve_for_payment" || desc === "reserve_for_payout") {
    rawOnlyCount++;
    if (isDuplicate) {
      rawOnlyDuplicate++;
    } else {
      rawOnlyNew++;
    }
    continue;
  }
  // ...
}
```

---

## 2) CONVERTIR CENTAVOS → PESOS ANTES DE ENVIAR A RPC

**Ubicación:** Nueva función helper + construcción de p_input_rows

**Agregar nueva función (después de la función `centsToCurrency`):**

```typescript
function buildInputRowForRPC(
  movement: ParsedMovement,
  reportId: string
): Record<string, string> {
  // Convert cents back to currency for RPC consumption
  const creditPesos = (parseInt(movement.net_credit_amount, 10) / 100).toFixed(2);
  const debitPesos = (parseInt(movement.net_debit_amount, 10) / 100).toFixed(2);
  const grossPesos = (parseInt(movement.gross_amount, 10) / 100).toFixed(2);
  const feePesos = (parseInt(movement.mp_fee_amount, 10) / 100).toFixed(2);
  const taxesPesos = (parseInt(movement.taxes_amount, 10) / 100).toFixed(2);

  return {
    DATE: movement.date,
    SOURCE_ID: movement.source_id,
    DESCRIPTION: movement.description,
    NET_CREDIT_AMOUNT: creditPesos,
    NET_DEBIT_AMOUNT: debitPesos,
    GROSS_AMOUNT: grossPesos,
    MP_FEE_AMOUNT: feePesos,
    TAXES_AMOUNT: taxesPesos,
    PAYMENT_METHOD: movement.payment_method,
    _payload_hash: movement.payload_hash,
    _report_id: reportId
  };
}
```

**Construcción de array para RPC (nueva sección después del loop de categorización):**

```typescript
// Build p_input_rows array for RPC import
// Include: classifiable movements + reserves (RAW-only)
const rpcInputRows = [];
for (const mov of movements) {
  const desc = mov.description.toLowerCase();

  // Skip opening/closing control rows (no SOURCE_ID)
  if (!mov.source_id || mov.source_id.trim() === "") {
    continue;
  }

  // Skip duplicates in Supabase (already imported)
  if (duplicatesInSupabase.includes(mov)) {
    continue;
  }

  // Include: classifiable movements + reserves
  if (
    desc === "payment" ||
    desc === "payout" ||
    desc === "asset_management" ||
    desc === "reserve_for_payment" ||
    desc === "reserve_for_payout"
  ) {
    rpcInputRows.push(buildInputRowForRPC(mov, reportId));
  } else {
    // Block unknown descriptions
    console.warn(
      `[STATUS-REPORT] WARNING: Unknown description '${desc}' for SOURCE_ID ${mov.source_id}. ` +
      `Will NOT be imported. Must review and classify manually.`
    );
  }
}

console.log(`[STATUS-REPORT] RPC input rows ready: ${rpcInputRows.length} rows (classifiable + reserves)`);
```

---

## 3) ENVIAR RESERVES A RPC (como RAW-only)

**Ubicación:** Lógica ya incluida en paso 2

**Validación:** 
- Reserves (reserve_for_payment, reserve_for_payout) están en `buildInputRowForRPC()`
- Serán procesadas por import_v2 con `v_is_raw_only = TRUE`
- Crearán SR pero NO FM/LE
- No impactan ledger

---

## 4) BLOQUEAR/REPORTAR UNKNOWN

**Ubicación:** Paso 2, bucle de construcción de RPC input

**Validación:**
```typescript
} else {
  // Block unknown descriptions
  console.warn(
    `[STATUS-REPORT] WARNING: Unknown description '${desc}' for SOURCE_ID ${mov.source_id}. ` +
    `Will NOT be imported. Must review and classify manually.`
  );
}
```

**Resultado:**
- Unknown descriptions NO se incluyen en `rpcInputRows`
- Se loguean como WARNING
- DRY RUN sigue reportando `unclassified_ambiguous` count
- Pero import NUNCA los procesa

---

## RESUMEN DE CAMBIOS

| Aspecto | Antes | Después |
|--------|-------|---------|
| **Control rows (opening/closing)** | Procesadas | Ignoradas (continue) |
| **Centavos vs Pesos** | Centavos (17277) | Pesos (172.77) |
| **Reserves** | Solo en counter | Incluidas en RPC como RAW-only |
| **Unknown** | Silenciosos en contador | Bloqueados + WARNING log |
| **p_input_rows** | N/A (no existe) | Nuevo: con centavos→pesos convertidos |

---

## VALIDACIÓN

Después de aplicar cambios:
1. DRY RUN debe reportar 6 movimientos contables (no 8)
2. DRY RUN debe reportar 2 reserves como raw_only
3. DRY RUN debe reportar 0 unknown (ninguno si reporte limpio)
4. RPC recibirá: 6 movimientos + 2 reserves = 8 rows
5. import_v2 procesará:
   - 6 movements → 6 FM + 6 LE + 6 SR
   - 2 reserves → 2 SR (RAW-only, no FM/LE)
   - Resultado: 8 SR, 6 FM, 6 LE, 6 links

---

## NOTAS

- buildInputRowForRPC() es helper para conversión clara
- Control rows se ignoran ANTES de cualquier lógica
- Reserves fluyen como RAW-only (no silenciosos)
- Unknown bloqueados = no desaparecen datos, requieren review manual
