# ADR-025 — cambio v1 → v2 en n8n STAGING (2026-10-22, vía MCP)
Precheck 11/11 PASS (precheck.cjs sobre pre-v1.json / pre-v2.json): V1 activa 410283c6 idéntica al export del preflight; V2 inactiva,
18 nodos idénticos a la creación verificada y al merged (sha eb6b8869), OpenAI = STAGING_OPENAI_GRANJA, gpt-5.6-luna/none,
webhook POST adr025-staging-gastos-whatsapp headerAuth igual a V1, webhookId distinto.
1. unpublish V1 n2N9KmrfiOyHhBRl → success; verificado active=false.
2. publish V2 dHVBoiFpgszCxpEf versionId 9885bfd8-e2e5-4d43-b901-5d73772d0510 → success; active=true, activeVersionId=9885bfd8, triggers 2.
3. Webhook /webhook/adr025-staging-gastos-whatsapp: sin token 403, token incorrecto 403 (registrado; auth rechaza).
Un solo workflow activo en la ruta. Rollback: no necesario. Pendiente owner: apagar "Available in MCP" en V2.
