# ADR-025 — Log send patch on V2 (2026-10-22, MCP)
Pre-write: hosted V2 = reviewed 9885bfd8 (no node/connection/settings/webhook/credential change; Log send old code). logsend-pre.json
update_workflow (1 op: updateNodeParameters "Log send" jsCode) → draft b63ca4dd; compare vs pre: only Log send.jsCode, = log-send-fix.jsCode.js
publish_workflow b63ca4dd → active, activeVersionId b63ca4dd. Re-read (logsend-post.json): same compare PASS; webhook POST
adr025-staging-gastos-whatsapp headerAuth webhookId 5b2ece6d unchanged; probe without token 403.
workflow.test.mjs against published V2 copy: 11/11 PASS (WF-11: 401/400/500 → execution fails, no private data; 2xx unchanged).
deploy/SHA256SUMS: build-workflow.mjs hash updated (backup SHA256SUMS.bak-pre-logsend). Edge not deployed.
Rollback: publish_workflow dHVBoiFpgszCxpEf versionId 9885bfd8-e2e5-4d43-b901-5d73772d0510.
