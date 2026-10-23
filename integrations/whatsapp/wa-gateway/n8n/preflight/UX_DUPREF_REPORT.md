# ADR-025 — UX de correcciones + referencias de duplicados (LOCAL, 2026-10-22). Nada alojado.
DB (wa-staging/src → build): wa.duplicate_refs(p, viewer) — mismo criterio que wa.duplicate_hint (total igual, fecha ±2 días, is_current),
máx 3; detalles (código W-, categoría, concepto 40c de un gasto WhatsApp) solo si el viewer es ADMIN activo y mapeado; si no, solo
fecha/total/same_category. Sin ids/actores/teléfonos. wa_propose / wa_correct devuelven además "duplicates" (possible_duplicates intacto).
Upgrade alojable: build/staging/upgrade-003-duplicate-refs.sql (guard + función + CREATE OR REPLACE propose/correct + privilegios).
n8n: logic.js (encabezado ✏️ de corrección, campos marcados, ⚠ misma categoría / ℹ otra, pie y texto FAILED nuevos; fallback si la base
no manda "duplicates"), interpreter.js (decide → changes {field, from, to}; ayuda nueva), build-workflow.mjs (Validate & map pasa changes).
Cambios alojables en V2: ux-dupref.update-ops.json (jsCode de 6 Code nodes; nada más) → copia v2-ux-patched.json.
Tests: staging sandbox 85/0 (76 + 9 D-*), candidate ERP local 85/0 sin residuo, logic 7/7, interpreter 12/12, workflow 12/12 (build y
copia parcheada de V2; contra V2 alojada actual WF-12 falla como corresponde), Edge 14/14 (sin cambios).
