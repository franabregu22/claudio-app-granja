#!/usr/bin/env bash
# ADR-025 — READ-ONLY Meta diagnosis: which apps are subscribed to the TEST WABA (GET only; no POST / DELETE).
# The token is typed privately, sent in the Authorization header (never in the URL), never printed or stored.
set -u
WABA=1142110388255398
EDGE="https://aplbsutpzgemexayldct.supabase.co/functions/v1/wa-gateway"
echo "Pegá el token temporal de la app de PRUEBA de Meta (no se ve) y Enter:"
read -rs TOKEN; echo; TOKEN=$(printf '%s' "$TOKEN" | tr -d '\r\n')
[ -n "$TOKEN" ] || { echo "STOP: empty token"; exit 2; }
RESP=$(curl -s -w '\n%{http_code}' -H "Authorization: Bearer $TOKEN" "https://graph.facebook.com/v25.0/$WABA/subscribed_apps")
unset TOKEN
CODE=$(printf '%s' "$RESP" | tail -1); BODY=$(printf '%s' "$RESP" | sed '$d')
echo "HTTP $CODE"
printf '%s' "$BODY" | EDGE="$EDGE" node -e "
let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{
  let j; try { j = JSON.parse(d); } catch { console.log('WABA SUBSCRIPTION: UNKNOWN (non-JSON response)'); return; }
  if (j.error) { console.log('WABA SUBSCRIPTION: UNKNOWN — Graph error code=' + j.error.code + ' type=' + j.error.type + ' msg=' + String(j.error.message).slice(0, 160)); return; }
  const apps = j.data || [];
  console.log('subscribed apps: ' + apps.length);
  for (const a of apps) {
    const x = a.whatsapp_business_api_data || a;
    const o = a.override_callback_uri || x.override_callback_uri;
    console.log('  app id=' + (x.id || '?') + ' name=\"' + (x.name || '?') + '\"' + (o ? ' override_callback_uri=' + o + (o.startsWith(process.env.EDGE) ? ' (wa-gateway)' : ' (NOT wa-gateway)') : ' override_callback_uri=none (uses the app-level webhook)'));
  }
  const bot = apps.find((a) => /n8n bot nuevo/i.test(String((a.whatsapp_business_api_data || a).name)));
  console.log('WABA SUBSCRIPTION: ' + (apps.length === 0 ? 'MISSING' : bot ? 'PASS (N8N BOT Nuevo)' : 'MISSING for N8N BOT Nuevo (other apps subscribed)'));
});"
