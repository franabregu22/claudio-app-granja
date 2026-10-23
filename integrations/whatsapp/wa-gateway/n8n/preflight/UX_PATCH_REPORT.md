# ADR-025 — UX + referencias de duplicados en V2 (2026-10-22, MCP)
Pre: V2 activa b63ca4dd (= logsend-post), Log send con fix, 6 nodos objetivo = base revisada (ux-pre.json).
6 update_workflow (1 nodo c/u: Verify & route, Prepare request, Prepare follow-up, Compose follow-up, Validate & map, After action)
→ borrador a9644024; ux-check: 18/18 nodos = v2-ux-patched.json; solo jsCode de los 6 cambió (ux-draft.json).
publish a9644024 → activa. Post (ux-post.json): solo esos 6 nodos; Log send, credenciales, conexiones, settings, webhook
(POST adr025-staging-gastos-whatsapp headerAuth, webhookId 5b2ece6d), nodo OpenAI y gpt-5.6-luna/none sin cambios; sin token → 403.
Regresión workflow.test.mjs contra copia de la versión publicada: 12/12 PASS.
Rollback: publish_workflow dHVBoiFpgszCxpEf versionId b63ca4dd-5b94-454b-8244-eaeebec493f9 (Log send fix, sin UX). Compatible con la
base actual (ignora "duplicates"). Anterior a ese: 9885bfd8-e2e5-4d43-b901-5d73772d0510.
