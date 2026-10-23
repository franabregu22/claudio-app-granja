#!/usr/bin/env bash
# ADR-025 — subscribe ONLY the app "N8N BOT Nuevo" to the TEST WABA (Meta). NOT RUN without the owner's GO.
#   1 token check (GET /debug_token): valid, belongs to "N8N BOT Nuevo", has whatsapp_business_management (+ messaging),
#     and — when the token carries granular scopes — that management scope covers this WABA
#   2 GET subscribed_apps (before): the existing subscriptions are recorded; if ours is already there → no POST
#   3 typed phrase with the app id → POST /subscribed_apps WITHOUT body (no override_callback_uri; nothing deleted)
#   4 GET subscribed_apps (after): ours present without override, every previous subscription still present
# The token is typed privately and travels only inside curl's stdin config (never in argv, URL logs, files or output).
# Supabase, Railway and production are not touched.
set -u
WABA=1142110388255398
APP_NAME="N8N BOT Nuevo"
G=https://graph.facebook.com/v25.0
stop() { echo "STOP: $*"; unset TOKEN; echo "== done (STOPPED)"; exit 2; }
echo "######## $(date '+%Y-%m-%d %H:%M:%S') — subscribe '$APP_NAME' to WABA $WABA"
echo "Pegá el token de la app de PRUEBA '$APP_NAME' (no se ve) y Enter:"
read -rs TOKEN; echo; TOKEN=$(printf '%s' "$TOKEN" | tr -d '\r\n'); [ -n "$TOKEN" ] || stop "empty token"
[[ "$TOKEN" =~ ^[A-Za-z0-9_|.-]+$ ]] || stop "unexpected characters in the token"
# graph METHOD PATH  → prints "<http code>\n<body>"; the token is read by curl from its stdin config
graph() {
  printf 'url = "%s%s"\nrequest = "%s"\nheader = "Authorization: Bearer %s"\nsilent\n' "$G" "$2" "$1" "$TOKEN" | curl -w '\n%{http_code}' -K -
}
jsonfield() { node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const L=d.split('\n');const code=L.pop();let j={};try{j=JSON.parse(L.join('\n'))}catch{};process.stdout.write(code+'\n'+JSON.stringify(j))})"; }

echo "== 1 token check"
DBG=$(printf 'url = "%s/debug_token?input_token=%s"\nheader = "Authorization: Bearer %s"\nsilent\n' "$G" "$TOKEN" "$TOKEN" | curl -w '\n%{http_code}' -K - | jsonfield)
CHECK=$(printf '%s' "$DBG" | WABA=$WABA APP="$APP_NAME" node -e "
let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{
  const i=d.indexOf('\n'); const code=d.slice(0,i); const j=JSON.parse(d.slice(i+1)); const x=j.data||{};
  if (code!=='200'||!j.data) { console.log('FAIL|debug_token HTTP '+code+' '+(j.error?('code='+j.error.code+' '+String(j.error.message).slice(0,120)):'')); return; }
  const scopes=x.scopes||[]; const g=(x.granular_scopes||[]).find(s=>s.scope==='whatsapp_business_management');
  const covers=!g||!g.target_ids||g.target_ids.includes(process.env.WABA);
  const exp=x.expires_at?new Date(x.expires_at*1000).toISOString():'never';
  const problems=[];
  if (!x.is_valid) problems.push('token not valid');
  if (x.application!==process.env.APP) problems.push('token belongs to \"'+x.application+'\", not \"'+process.env.APP+'\"');
  if (!scopes.includes('whatsapp_business_management')) problems.push('missing whatsapp_business_management');
  if (!covers) problems.push('whatsapp_business_management does not cover WABA '+process.env.WABA);
  console.log((problems.length?'FAIL':'PASS')+'|app=\"'+x.application+'\" app_id='+x.app_id+' type='+x.type+' valid='+x.is_valid+' expires='+exp
    +' management='+scopes.includes('whatsapp_business_management')+' messaging='+scopes.includes('whatsapp_business_messaging')+' covers_waba='+covers
    +(problems.length?' :: '+problems.join('; '):''));
});")
echo "token: ${CHECK#*|}"
case "$CHECK" in PASS\|*) ;; *) stop "token check failed";; esac
APP_ID=$(printf '%s' "$CHECK" | sed -n 's/.* app_id=\([0-9]*\) .*/\1/p'); [ -n "$APP_ID" ] || stop "app id not read"

summarize() { node -e "
let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{
  const i=d.indexOf('\n'); const code=d.slice(0,i); const j=JSON.parse(d.slice(i+1));
  if (code!=='200'||!j.data) { console.log('ERR|HTTP '+code+' '+(j.error?('code='+j.error.code+' '+String(j.error.message).slice(0,120)):'')); return; }
  console.log('OK|'+j.data.map(a=>{const x=a.whatsapp_business_api_data||a;const o=a.override_callback_uri||x.override_callback_uri;return (x.id||'?')+'='+(x.name||'?')+(o?'[override]':'')}).join(';'));
});"; }

echo "== 2 subscriptions BEFORE"
BEFORE=$(graph GET "/$WABA/subscribed_apps" | jsonfield | summarize)
echo "before: ${BEFORE#*|}"
case "$BEFORE" in OK\|*) ;; *) stop "could not read subscriptions";; esac
if printf '%s' "$BEFORE" | grep -q "$APP_ID="; then
  echo "'$APP_NAME' ($APP_ID) is already subscribed — no POST needed"
  RESULT_AFTER="$BEFORE"
else
  echo "== 3 POST (subscribes ONLY the token's app; no override_callback_uri; existing subscriptions untouched)"
  echo "Escribí exactamente: SUBSCRIBE $APP_ID TO $WABA"
  read -r C; [ "$C" = "SUBSCRIBE $APP_ID TO $WABA" ] || stop "confirmation phrase mismatch"
  POST=$(graph POST "/$WABA/subscribed_apps" | jsonfield)
  echo "post: HTTP $(printf '%s' "$POST" | head -1) $(printf '%s' "$POST" | tail -n +2 | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const j=JSON.parse(d);console.log(j.error?('error code='+j.error.code+' '+String(j.error.message).slice(0,120)):'success='+j.success)})")"
  echo "== 4 subscriptions AFTER"
  RESULT_AFTER=$(graph GET "/$WABA/subscribed_apps" | jsonfield | summarize)
  echo "after: ${RESULT_AFTER#*|}"
fi
unset TOKEN
VERDICT=PASS
printf '%s' "$RESULT_AFTER" | grep -q "^OK|" || VERDICT=FAIL
printf '%s' "$RESULT_AFTER" | grep -qE "(^OK\||;)$APP_ID=[^;]*" || VERDICT=FAIL
printf '%s' "$RESULT_AFTER" | grep -qE "$APP_ID=[^;]*\[override\]" && VERDICT=FAIL
for prev in $(printf '%s' "${BEFORE#*|}" | tr ';' '\n' | cut -d= -f1); do
  printf '%s' "$RESULT_AFTER" | grep -q "$prev=" || { echo "previous subscription $prev missing after the POST"; VERDICT=FAIL; }
done
echo "WABA SUBSCRIPTION: $VERDICT"
echo "== done"
