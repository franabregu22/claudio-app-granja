# ADR-025 §18 — wa-gateway + n8n STAGING (AppGranja, instancia n8n EXISTENTE de Railway)

```
Meta (app / número de PRUEBA) ─webhook─▶ Edge wa-gateway ─(bytes originales + firma)─▶ public.wa_ingest  [HMAC Meta en la DB; secreto en Vault]
                                          │ mensaje ACEPTADO y nuevo: x-wa-token + ts + nonce + capacidad del mensaje (HMAC, 15 min)
                                          ▼
                     n8n Railway (workflow "STAGING - Gastos WhatsApp") ── interpreta el texto ──▶ POST /wa-gateway/action
                          │                                                  x-wa-token + ts + nonce de un solo uso + capacidad
                          │                                                  ▶ wa_propose / correct / cancel / link_mp / confirm / expire
                          │                                                    (usuario Auth wa-gateway; la contabilidad es sim.*)
                          └── Graph API (credencial STAGING_META_GRAPH_TOKEN) ──▶ resumen + botones Confirmar / Cancelar
```

## Por qué así en una instancia compartida

- El workflow **no usa `$env` ni `require()`**, así que **no se cambia ninguna variable de Railway**.
  - Habilitar el acceso a `$env` expondría a todos los Code nodes las variables de la instancia, incluida la clave de cifrado de n8n y la base de n8n.
- **Los secretos viven solo en tres credenciales Header Auth de n8n, que n8n guarda cifradas:**
  - `STAGING_WA_EDGE_TO_N8N`: lo valida el nodo Webhook.
  - `STAGING_WA_N8N_TO_EDGE`: lo envía el nodo HTTP a la Edge.
  - `STAGING_META_GRAPH_TOKEN`: para la Graph API.
- **El secreto HMAC de capacidad (`WA_CAPABILITY_SECRET`) nunca sale de la Edge.**
  - n8n solo puede actuar sobre un mensaje que la Edge le reenvió, dentro de los 15 minutos.
  - Aunque se filtrara un token, alguien sin una capacidad válida no puede operar sobre mensajes reales.
- **Antirrepetición, en capas:**
  1. timestamp de ±300 s en ambos sentidos;
  2. nonce de un solo uso (en n8n con static data del workflow, en la Edge en memoria);
  3. capacidad atada al `inbound_id`, con vencimiento;
  4. en la base, un mensaje maneja una sola acción y los reintentos devuelven el resultado guardado.
- **Datos de ejecución:**
  - el workflow no guarda las ejecuciones exitosas (`saveDataSuccessExecution: none`) y solo lo llaman workflows del mismo dueño;
  - n8n no registra teléfonos completos; el estado de cada remitente se guarda bajo un hash SHA-256 del teléfono.

## Archivos

| Archivo | Qué es |
|---|---|
| `supabase/functions/wa-gateway/handler.ts`, `index.ts` | La Edge Function. Usa solo PostgREST y el usuario `wa-gateway`. |
| `n8n/logic.js` | Interpretación, ruteo y respuestas, en JS puro. Se embebe tal cual en el workflow. |
| `n8n/build-workflow.mjs` | Genera `n8n/build/STAGING_wa_expense_capture.json`. Rechaza `$env`, `require`, secretos, refs prohibidos y endpoints ajenos. |
| `tests/handler.test.ts` | 13 pruebas de la Edge (`deno test --allow-read=n8n tests/handler.test.ts`). |
| `n8n/logic.test.mjs` | 7 pruebas de la lógica. |
| `n8n/workflow.test.mjs` | 5 pruebas que ejecutan los Code nodes del JSON sin `require` ni `$env`. |
| `deploy/wa-gateway-staging.sh` | Pasos del owner. Cada uno exige el control plane de AppGranja y `deploy/SHA256SUMS`. |
