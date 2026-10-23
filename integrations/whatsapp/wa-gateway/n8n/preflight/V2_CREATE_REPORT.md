# ADR-025 — v2 creada en n8n (2026-10-22, vía MCP n8n-railway)

- v2: `STAGING - Gastos WhatsApp v2` — ID `dHVBoiFpgszCxpEf`, versionId `9885bfd8-e2e5-4d43-b901-5d73772d0510`, INACTIVA (activeVersionId null), 18 nodos.
- Fuente: `build/STAGING_wa_expense_capture.merged.json` sha256 `eb6b8869…2b929` → SDK `v2.sdk2.js` (verificado local: 0 diffs, 20 conexiones) → validate_workflow PASS → create_workflow_from_code.
- v1 `n2N9KmrfiOyHhBRl` activa, versionId `410283c6…` sin cambios (updatedAt 12:00:59Z).
- Export de lo creado: `created.dHVBoiFpgszCxpEf.json`.

Verificación sobre lo creado: V-1..V-10 PASS (nodos/parámetros idénticos al JSON revisado, credenciales por id existente incl. OpenAI
`STAGING_OPENAI_GRANJA` PbcX1ZgBT8eCoUxS, gpt-5.6-luna/none, webhook POST adr025-staging-gastos-whatsapp headerAuth, webhookId propio
5b2ece6d… ≠ v1 c3d2563b…, sin secretos). V-11: availableInMCP=true (n8n lo fuerza en workflows creados por MCP; update_workflow no expone
ese ajuste) → desactivar en la UI: Workflow settings → "Available in MCP" off. Resto de settings OK.
