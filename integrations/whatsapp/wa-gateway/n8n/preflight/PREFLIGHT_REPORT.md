# ADR-025 — STAGE 2 preflight (re-run 2026-10-22, solo lectura en n8n)

Origen: export via MCP `n8n-railway` (get_workflow_details), sin import/publish/ejecución.
- Workflow: `STAGING - Gastos WhatsApp` — ID `n2N9KmrfiOyHhBRl`
- versionId = activeVersionId = `410283c6-4281-40de-a351-e2f320b0c265`, updatedAt `2026-10-22T12:00:59.495Z`, 11 nodos

Resultado: **STAGE2 PREFLIGHT: PASS (11/11)** — salida completa en `preflight-output.txt`.

v2: `build/STAGING_wa_expense_capture.merged.json` — "STAGING - Gastos WhatsApp v2", active=false, 18 nodos,
webhook POST `adr025-staging-gastos-whatsapp` headerAuth `STAGING_WA_EDGE_TO_N8N`, webhookId propio,
credenciales: STAGING_WA_EDGE_TO_N8N, STAGING_WA_N8N_TO_EDGE, STAGING_META_GRAPH_TOKEN (ids conservados), STAGING_OPENAI_GRANJA (seleccionar en UI tras import),
modelo `gpt-5.6-luna`, reasoning.effort=none.
El merged regenerado es byte-idéntico al previo (sha256 igual).

## Vigencia
Este preflight vale mientras el workflow publicado siga en versionId `410283c6-…` y los sha256 de `fingerprints.json` coincidan.
Si cambia cualquiera de los dos, re-ejecutar: `node n8n/stage2-preflight.mjs <export.json>`.
