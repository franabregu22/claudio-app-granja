#!/usr/bin/env bash
# ADR-025 — interpreter model evaluation (owner). Calls ONLY https://api.openai.com with the key of the STAGING OpenAI
# project, typed privately; the key lives only in this process' environment and is never printed or stored.
set -u
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
echo "Pegá la API key del proyecto OpenAI 'Granja Santo Tomas - V2' (la de STAGING_OPENAI_GRANJA; no se ve) y Enter:"
read -rs K; echo; K=$(printf '%s' "$K" | tr -d '\r\n'); [ -n "$K" ] || { echo "STOP: empty key"; exit 2; }
OPENAI_API_KEY="$K" node "$HERE/eval-models.mjs" 2>&1 | tee "$HERE/eval-output.txt"
RC=${PIPESTATUS[0]}
unset K
echo "== done (rc=$RC; output also in eval-output.txt — contains no key and no personal data)"
