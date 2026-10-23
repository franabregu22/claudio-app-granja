# ADR-025 §18 — minimal bot staging + candidate migration

Una plantilla, dos builds (`node build.mjs`). Las dos difieren **solo** en `search_path`; el generador lo verifica.

| Build | Destino | Contenido |
|---|---|---|
| `build/staging/` | AppGranja (bot staging) | `00-guard` (solo DB vacía; rechaza el ERP) · `01-sim` (dobles de contrato) · `02-wa-core` (`sim` primero) · `03-seed` (datos sintéticos) · `tests` · `teardown` |
| `build/candidate/` | ERP local (y, con GO, producción) | `0101_wa_whatsapp_gateway.candidate.sql` (guarda ERP ≥ 0100 + RPC reales; **sin `sim`**; `wa.config` vacío ⇒ todo `wa_*` rechaza) · `fixtures` · `tests` |

Fuentes en `src/`. `build/SHA256SUMS` = el build revisado. El runner de AppGranja se niega si el build no coincide.

## Ejecutado (solo local)
- `bash run-candidate-local.sh`: migración candidata + fixtures + suite sobre el ERP local (0001–0100), todo en **una transacción con ROLLBACK**. Imprime una línea de residuo antes/después.
- `bash run-staging-sandbox.sh`: crea una DB local descartable que imita AppGranja reseteado. Pasos: instalar → suite (ROLLBACK) → 4 carreras de concurrencia → teardown → eliminar la DB.

## Pendiente de GO del owner (no ejecutado)
1. `../staging-adr025/03-staging-users.sh` crea los 4 usuarios Auth sintéticos.
2. `STAGING_PHONE_A=… STAGING_PHONE_B=… STAGING_PHONE_OPER=… bash appgranja-staging.sh --install`
3. El secret de la app Meta **de prueba** en el Vault de AppGranja, más la Edge Function `wa-gateway` (paso de gateway, aparte).
4. Para retirar todo: `bash appgranja-staging.sh --teardown`.

`tests.sql` es **solo local**: crea un secret de Vault de prueba si no hay ninguno.
