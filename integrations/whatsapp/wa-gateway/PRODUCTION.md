# ADR-025 — wa-gateway + n8n PRODUCCIÓN (granja-santo-tomas-v1, `ycmkpnunhxluqqtecbyu`)

El bot queda **apagado** hasta el paso F. El interruptor es `wa.config.enabled`: mientras valga `false`, las 8 entradas `public.wa_*` rechazan toda llamada con `FORBIDDEN`, incluso las del propio gateway, y no se registra nada (`production/disabled-check.sql`, 18/18).

## Qué es igual a STAGING y qué cambia

| Pieza | Fuente | Diferencia con STAGING |
|---|---|---|
| Edge `wa-gateway` | `production/` generado por `build-production.mjs` desde el handler de staging | 4 líneas de identidad: proyecto esperado = producción; AppGranja y Farm ERP rechazados. La misma suite Deno, con los refs intercambiados, da 14/14. |
| Workflow n8n | `node n8n/build-workflow.mjs --target=production` | Mismos 18 nodos, conexiones y ajustes. Cambian: nombre `PROD - Gastos WhatsApp`, ruta `adr025-prod-gastos-whatsapp`, credenciales `PROD_*`, Edge de producción, catálogo (Phone Number ID y `ar_strip_9`), y se quitan los 3 textos de simulación. Inactivo. `workflow.test.mjs`: 23/23. |
| Base | migraciones 0101 + 0102, ya aplicadas | `wa.config` con `enabled=false` (paso A). `wa.sender` vacío hasta el paso E. |

## Pasos (`bash deploy/wa-gateway-production.sh <modo>`, cada uno con GO propio)

| Paso | Modo | Requiere el número |
|---|---|---|
| A1 | `--gateway-user`: usuario Auth `wa-gateway@granja-santo-tomas.invalid`, sin perfil ERP; contraseña aleatoria en `~/granja-private/wa-gateway-prod-user.json` | no |
| A2 | `--config-disabled`: crea la fila `wa.config` con `enabled=false` | no |
| A3 | `--secrets https://<n8n>/webhook/adr025-prod-gastos-whatsapp`: secretos de la Edge, distintos de los de staging (en `~/granja-private/wa-gateway-prod-secrets.json`) | no |
| B1 | `--deploy`: despliega la Edge con `--no-verify-jwt` desde `production/` | no |
| B2 | `--verify`: solo lectura (función, nombres de secretos, sondas, estado de la base) | no |
| C | n8n: crear las credenciales `PROD_WA_EDGE_TO_N8N`, `PROD_WA_N8N_TO_EDGE`, `PROD_META_GRAPH_TOKEN` y `PROD_OPENAI_GRANJA` (clave nueva de OpenAI). Importar el workflow **inactivo** después de `--catalog`. Desactivar "Available in MCP". | importar: sí |
| D1 | Meta: alta del número en la WABA de la Granja; token permanente de usuario de sistema; app suscripta a la WABA; webhook = URL de la Edge + `WA_META_VERIFY_TOKEN`; campo `messages` | sí |
| D2 | `--meta-secret`: secreto de la app de Meta de producción → Vault `wa_meta_app_secret` | sí (app definida) |
| D3 | `--catalog <phone_number_id> <true\|false>`: genera `PROD - Gastos WhatsApp` | sí |
| E | `--sender <+549…> <email-ERP-ADMIN>`: primer teléfono autorizado | sí |
| F | `--enable`, activar el workflow y una prueba financiera real mínima. Para revertir: `--disable` y desactivar el workflow. | sí |

`--enable` solo avanza si hay config deshabilitada, al menos un remitente, el secreto en Vault, un gateway sin perfil y la función desplegada.
