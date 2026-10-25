#!/usr/bin/env bash
# ADR-025 — wa-gateway + n8n PRODUCTION, owner steps on granja-santo-tomas-v1 (ycmkpnunhxluqqtecbyu) ONLY. Each mode is an independent
# step; NONE is run without the owner's GO. AppGranja (aplbsutpzgemexayldct) and Farm ERP (shdrztqgwpyyxclgfpdg) are refused everywhere.
#   A  --gateway-user          Supabase secret key (typed, never stored) → Auth user wa-gateway (no ERP profile), random password kept
#                              in ~/granja-private/wa-gateway-prod-user.json (mode 600)
#      --config-disabled       DB password → wa.config row with enabled = FALSE (the bot stays OFF; no sender is mapped)
#      --secrets <n8n-url>     Edge secrets generated ONCE (~/granja-private/wa-gateway-prod-secrets.json, never equal to staging's)
#                              → supabase secrets set. The two token values are what the owner pastes into the PROD_* n8n credentials.
#   B  --deploy                typed phrase → supabase functions deploy wa-gateway (production/ build, checksummed)
#      --verify                read-only: function, secret names, harmless probes, DB state (bot OFF, senders, Vault secret present)
#   D  --meta-secret           DB password + PRODUCTION Meta app secret (typed) → Vault wa_meta_app_secret
#      --graph-token           PRODUCTION permanent system-user token (typed) → Edge secret WA_META_GRAPH_TOKEN (receipts: the
#                              Edge downloads the photo / PDF from Meta). The same token goes into the n8n credential PROD_META_GRAPH_TOKEN.
#      --catalog <pnid> <true|false>   n8n/production-catalog.json (Phone Number ID, ar_strip_9) → build PROD - Gastos WhatsApp (inactive)
#   E  --sender <+E164> <erp-email>    DB password → wa.sender: that phone → that ACTIVE ADMIN profile
#   F  --enable | --disable    typed phrase → wa.config.enabled (enable: only with config, a sender, the Vault secret and the function)
# No service_role in the function; the secret key of step A is used once by curl (stdin config) and never stored or printed.
set -u
export MSYS_NO_PATHCONV=1
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -W)"
ROOT="$HERE/.."
REF=ycmkpnunhxluqqtecbyu
HOST=aws-0-sa-east-1.pooler.supabase.com
CLIENT=supabase_db_Claudio_app_Granja
PRIV="$HOME/granja-private"
USERF="$PRIV/wa-gateway-prod-user.json"
SECRETS="$PRIV/wa-gateway-prod-secrets.json"
STAGING_SECRETS="$ROOT/.wa-gateway-secrets.json"
FN_URL="https://$REF.supabase.co/functions/v1/wa-gateway"
GW_EMAIL=wa-gateway@granja-santo-tomas.invalid
MODE="${1:-}"
exec > >(tee -a "$HERE/wa-gateway-production-output.txt") 2>&1
echo "######## run $(date '+%Y-%m-%d %H:%M:%S') — wa-gateway PRODUCTION, mode ${MODE:-none}"
stop() { echo "STOP: $*"; unset PGPASSWORD SKEY; echo "== done (STOPPED)"; exit 2; }
case "$REF" in aplbsutpzgemexayldct|shdrztqgwpyyxclgfpdg) stop "forbidden project";; esac
case "$MODE" in --gateway-user|--config-disabled|--secrets|--deploy|--verify|--meta-secret|--graph-token|--catalog|--sender|--enable|--disable) ;;
  *) echo "usage: $0 --gateway-user | --config-disabled | --secrets <n8n-url> | --deploy | --verify | --meta-secret | --graph-token | --catalog <pnid> <true|false> | --sender <+E164> <erp-email> | --enable | --disable"; exit 2;; esac

LINE=$(supabase projects list -o json 2>/dev/null | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{const j=JSON.parse(d.slice(d.search(/[\[{]/)));const p=j.find(x=>(x.ref||x.id)==='$REF');console.log(p?[p.ref||p.id,p.name,p.region,p.status].join('|'):'')}catch{console.log('')}})")
echo "control plane: ${LINE:-not found}"
[ "$LINE" = "$REF|granja-santo-tomas-v1|sa-east-1|ACTIVE_HEALTHY" ] || stop "$REF is not granja-santo-tomas-v1 / sa-east-1 / ACTIVE_HEALTHY"
(cd "$ROOT" && sha256sum -c deploy/SHA256SUMS --quiet) || stop "sources differ from the reviewed deploy/SHA256SUMS"
(cd "$ROOT/production" && sha256sum -c SHA256SUMS --quiet) || stop "the production build differs from production/SHA256SUMS (run node build-production.mjs and review)"
mkdir -p "$PRIV"

psqlc() { docker exec -i -e PGHOST -e PGPORT -e PGUSER -e PGPASSWORD -e PGDATABASE -e PGSSLMODE -e WA_META_SECRET -e V1 -e V2 "$CLIENT" psql -X -q -t -A "$@" 2>&1 | tr -d '\r' | sed 's/^psql:<stdin>:[0-9]*: //'; }
dbpass() {
  echo "Pegá la contraseña de la BASE de PRODUCCIÓN con Shift+Insert (no se ve) y Enter:"
  read -rs PGPASSWORD; echo; PGPASSWORD=$(printf '%s' "$PGPASSWORD" | tr -d '\r\n'); [ -n "$PGPASSWORD" ] || stop "empty password"
  export PGPASSWORD PGHOST="$HOST" PGPORT=5432 PGUSER="postgres.$REF" PGDATABASE=postgres PGSSLMODE=require
  FP=$(psqlc -c "SELECT (SELECT count(*) || '/' || max(version) FROM migration_ledger.applied) || '|' || (to_regclass('public.perfiles') IS NOT NULL) || '|' || (to_regnamespace('wa') IS NOT NULL) || '|' || (to_regnamespace('sim') IS NULL)" | grep '|')
  echo "database fingerprint (ledger|perfiles|wa|no_sim): ${FP:-unavailable}"
  [[ "$FP" =~ ^[0-9]+/01[0-9][0-9]\|true\|true\|true$ ]] && [ "${FP%%/*}" -ge 102 ] || stop "not the production ERP at 0102 or later (or authentication failed)"
}
state() { psqlc -c "SELECT 'config=' || coalesce((SELECT CASE WHEN enabled THEN 'ENABLED' ELSE 'disabled' END FROM wa.config), 'none')
   || ' senders=' || (SELECT count(*) FROM wa.sender WHERE activo) || ' vault_secret=' || EXISTS (SELECT 1 FROM vault.secrets WHERE name = 'wa_meta_app_secret')
   || ' gateway_has_profile=' || coalesce((SELECT EXISTS (SELECT 1 FROM perfiles p WHERE p.id = c.gateway_user_id)::text FROM wa.config c), '-')" | grep '^config='; }
phrase() { echo "Escribí exactamente: $1"; read -r C < /dev/tty; [ "$(printf '%s' "$C" | tr -d '\r')" = "$1" ] || stop "confirmation phrase mismatch"; }

case "$MODE" in
--gateway-user)
  [ -f "$USERF" ] && stop "$USERF already exists: the gateway user was created before (never create a second one)"
  dbpass
  [ "$(psqlc -c "SELECT count(*) FROM auth.users WHERE email = '$GW_EMAIL'" | grep -E '^[0-9]+$')" = 0 ] || stop "an Auth user $GW_EMAIL already exists"
  echo "Pegá la clave SECRETA de Supabase de PRODUCCIÓN (Settings → API keys; no se ve, no se guarda) y Enter:"
  read -rs SKEY; echo; SKEY=$(printf '%s' "$SKEY" | tr -d '\r\n'); [ -n "$SKEY" ] || stop "empty key"
  phrase "CREATE GATEWAY USER $REF"
  umask 077
  PW=$(node -e "process.stdout.write(require('crypto').randomBytes(32).toString('hex'))")
  R=$(printf 'url = "https://%s.supabase.co/auth/v1/admin/users"\nrequest = "POST"\nheader = "apikey: %s"\nheader = "Authorization: Bearer %s"\nheader = "Content-Type: application/json"\ndata = "{\\"email\\":\\"%s\\",\\"password\\":\\"%s\\",\\"email_confirm\\":true}"\nsilent\n' \
      "$REF" "$SKEY" "$SKEY" "$GW_EMAIL" "$PW" | curl -w '\n%{http_code}' -K -)
  unset SKEY
  CODE=$(printf '%s' "$R" | tail -1); UID_=$(printf '%s' "$R" | sed '$d' | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{process.stdout.write(JSON.parse(d).id||'')}catch{}})")
  [ "$CODE" = 200 ] && [[ "$UID_" =~ ^[0-9a-f-]{36}$ ]] || stop "Auth admin API answered HTTP $CODE (no user id)"
  printf '{"email":"%s","password":"%s","user_id":"%s"}\n' "$GW_EMAIL" "$PW" "$UID_" > "$USERF"; chmod 600 "$USERF"; unset PW
  echo "gateway user created: id ${UID_:0:8}… · credentials in $USERF (mode 600, not printed)"
  psqlc -c "SELECT 'check|gateway exists=' || EXISTS (SELECT 1 FROM auth.users WHERE id = '$UID_') || ' confirmed=' || EXISTS (SELECT 1 FROM auth.users WHERE id = '$UID_' AND email_confirmed_at IS NOT NULL)
     || ' erp_profile=' || EXISTS (SELECT 1 FROM perfiles WHERE id = '$UID_')" | grep '^check|'
  ;;
--config-disabled)
  [ -f "$USERF" ] || stop "run --gateway-user first"
  UID_=$(node -e "process.stdout.write(JSON.parse(require('fs').readFileSync(process.argv[1],'utf8')).user_id)" "$USERF")
  [[ "$UID_" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$ ]] || stop "the user file has no valid user id"
  dbpass
  R=$(psqlc -c "SELECT (SELECT count(*) FROM wa.config) || '|' || EXISTS (SELECT 1 FROM auth.users WHERE id = '$UID_') || '|' || EXISTS (SELECT 1 FROM perfiles WHERE id = '$UID_')" | grep '|')
  [ "$R" = "0|true|false" ] || stop "precondition (config rows | gateway exists | gateway has an ERP profile) = $R, expected 0|true|false"
  phrase "CONFIGURE WA DISABLED $REF"
  psqlc -c "INSERT INTO wa.config (gateway_user_id, enabled) VALUES ('$UID_', false)" | grep -E 'ERROR' && stop "insert failed"
  echo "state: $(state)"
  ;;
--secrets)
  N8N_URL="${2:-}"
  [[ "$N8N_URL" =~ ^https://[A-Za-z0-9.-]+/webhook/adr025-prod-gastos-whatsapp$ ]] || stop "n8n URL must be https://<n8n-host>/webhook/adr025-prod-gastos-whatsapp"
  case "$N8N_URL" in *aplbsutpzgemexayldct*|*shdrztqgwpyyxclgfpdg*|*staging*) stop "staging reference in the n8n URL";; esac
  [ -f "$USERF" ] || stop "run --gateway-user first"
  phrase "SET EDGE SECRETS $REF"
  umask 077
  node - "$USERF" "$SECRETS" "$STAGING_SECRETS" "$N8N_URL" "$PRIV/.edge-prod-secrets.env" <<'JS' || stop "secrets file not prepared"
const fs = require('fs'); const crypto = require('crypto');
const [userF, secretsPath, stagingPath, n8nUrl, envPath] = process.argv.slice(2);
const gw = JSON.parse(fs.readFileSync(userF, 'utf8'));
let s = {}; try { s = JSON.parse(fs.readFileSync(secretsPath, 'utf8')); } catch {}
const gen = () => crypto.randomBytes(32).toString('hex');
s = { WA_META_VERIFY_TOKEN: s.WA_META_VERIFY_TOKEN || gen(), WA_EDGE_TO_N8N_TOKEN: s.WA_EDGE_TO_N8N_TOKEN || gen(),
      WA_N8N_TO_EDGE_TOKEN: s.WA_N8N_TO_EDGE_TOKEN || gen(), WA_CAPABILITY_SECRET: s.WA_CAPABILITY_SECRET || gen() };
let st = {}; try { st = JSON.parse(fs.readFileSync(stagingPath, 'utf8')); } catch {}
if (Object.keys(s).some((k) => st[k] && st[k] === s[k])) { console.log('STOP: a production secret equals a staging secret'); process.exit(2); }
fs.writeFileSync(secretsPath, JSON.stringify(s, null, 1), { mode: 0o600 });
fs.writeFileSync(envPath, [`WA_GATEWAY_EMAIL=${gw.email}`, `WA_GATEWAY_PASSWORD=${gw.password}`, `WA_N8N_INBOUND_URL=${n8nUrl}`,
  ...Object.entries(s).map(([k, v]) => `${k}=${v}`)].join('\n') + '\n', { mode: 0o600 });
console.log('production secrets prepared (values not printed; distinct from staging). n8n: PROD_WA_EDGE_TO_N8N = Header Auth x-wa-token /'
  + ' WA_EDGE_TO_N8N_TOKEN; PROD_WA_N8N_TO_EDGE = Header Auth x-wa-token / WA_N8N_TO_EDGE_TOKEN (values in ' + secretsPath + '). WA_CAPABILITY_SECRET never leaves the Edge.');
JS
  supabase secrets set --project-ref "$REF" --env-file "$PRIV/.edge-prod-secrets.env" >/dev/null 2>&1; RC=$?
  rm -f "$PRIV/.edge-prod-secrets.env"
  [ $RC = 0 ] || stop "supabase secrets set failed"
  supabase secrets list --project-ref "$REF" -o json 2>/dev/null | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const n=JSON.parse(d.slice(d.search(/[\[{]/))).map(s=>s.name).filter(n=>n.startsWith('WA_')).sort();console.log('edge WA_ secret names: '+n.join(','))})"
  ;;
--deploy)
  phrase "DEPLOY WA-GATEWAY $REF"
  (cd "$ROOT/production" && supabase functions deploy wa-gateway --project-ref "$REF" --workdir . --no-verify-jwt --use-api 2>&1 | grep -viE "token|key") || stop "deploy failed"
  supabase functions list --project-ref "$REF" -o json 2>/dev/null | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const f=JSON.parse(d.slice(d.search(/[\[{]/))).map(f=>f.slug+':'+f.status+':verify_jwt='+f.verify_jwt);console.log('functions: '+f.join(','))})"
  ;;
--verify)
  supabase functions list --project-ref "$REF" -o json 2>/dev/null | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const f=JSON.parse(d.slice(d.search(/[\[{]/))).map(f=>f.slug+':'+f.status+':verify_jwt='+f.verify_jwt);console.log('functions: '+f.join(','))})"
  supabase secrets list --project-ref "$REF" -o json 2>/dev/null | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const n=JSON.parse(d.slice(d.search(/[\[{]/))).map(s=>s.name).filter(n=>n.startsWith('WA_')).sort();console.log('edge WA_ secret names: '+n.join(','))})"
  p() { curl -s -o /dev/null -w '%{http_code}' "$@"; }
  echo "probe|meta_verify_wrong_token=$(p "$FN_URL?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=1") (expect 403; 503 = misconfigured)"
  echo "probe|webhook_without_signature=$(p -X POST -H 'content-type: application/json' --data '{}' "$FN_URL") (expect 401)"
  echo "probe|webhook_forged_signature=$(p -X POST -H 'content-type: application/json' -H "x-hub-signature-256: sha256=$(printf '0%.0s' {1..64})" --data '{"object":"whatsapp_business_account","entry":[]}' "$FN_URL") (expect 500 while the bot is OFF: wa_ingest refused by the master switch; 401 once enabled)"
  echo "probe|action_unsigned=$(p -X POST -H 'content-type: application/json' --data '{"action":"expire"}' "$FN_URL/action") (expect 401)"
  dbpass; echo "state: $(state)"
  ;;
--meta-secret)
  dbpass
  echo "Pegá el App Secret de la app de Meta de PRODUCCIÓN (no se ve) y Enter:"
  read -rs WA_META_SECRET; echo; WA_META_SECRET=$(printf '%s' "$WA_META_SECRET" | tr -d '\r\n'); export WA_META_SECRET
  [[ "$WA_META_SECRET" =~ ^[0-9a-f]{32}$ ]] || stop "a Meta app secret is 32 hex characters"
  R=$(printf '%s\n' '\getenv s WA_META_SECRET' "SELECT 'vault|' || CASE WHEN EXISTS (SELECT 1 FROM vault.secrets WHERE name = 'wa_meta_app_secret')
      THEN (SELECT 'updated:' || (vault.update_secret(id, :'s') IS NULL) FROM vault.secrets WHERE name = 'wa_meta_app_secret')
      ELSE 'created:' || (vault.create_secret(:'s', 'wa_meta_app_secret', 'ADR-025 Meta app secret (production)') IS NOT NULL) END;" | psqlc -f - | grep -E "^vault\||ERROR")
  unset WA_META_SECRET
  echo "${R:-vault|unavailable}"
  echo "$R" | grep -qE "^vault\|(created|updated):true$" || stop "Vault not updated"
  ;;
--graph-token)
  echo "Pegá el token PERMANENTE del usuario de sistema de Meta de PRODUCCIÓN (no se ve, no se guarda) y Enter:"
  read -rs GT; echo; GT=$(printf '%s' "$GT" | tr -d '
'); [[ "$GT" =~ ^[A-Za-z0-9_|.-]{50,}$ ]] || stop "unexpected token format"
  phrase "SET GRAPH TOKEN $REF"
  umask 077; printf 'WA_META_GRAPH_TOKEN=%s
' "$GT" > "$PRIV/.edge-graph.env"; unset GT
  supabase secrets set --project-ref "$REF" --env-file "$PRIV/.edge-graph.env" >/dev/null 2>&1; RC=$?
  rm -f "$PRIV/.edge-graph.env"
  [ $RC = 0 ] || stop "supabase secrets set failed"
  echo "WA_META_GRAPH_TOKEN set (value not printed)"
  ;;
--catalog)
  PNID="${2:-}"; STRIP="${3:-}"
  [[ "$PNID" =~ ^[0-9]{6,20}$ ]] || stop "the production Phone Number ID (digits) is required: --catalog <pnid> <true|false>"
  [[ "$STRIP" =~ ^(true|false)$ ]] || stop "ar_strip_9 must be decided explicitly: true | false"
  printf '{\n "ar_strip_9": %s,\n "phone_number_id": "%s"\n}\n' "$STRIP" "$PNID" > "$ROOT/n8n/production-catalog.json"
  (cd "$ROOT" && node n8n/build-workflow.mjs --target=production) || stop "workflow build failed"
  (cd "$ROOT" && WF_FILE="$ROOT/n8n/build/PROD_wa_expense_capture.json" node --test n8n/workflow.test.mjs 2>&1 | grep -E '^ℹ (pass|fail) ') || true
  ;;
--sender)
  PHONE="${2:-}"; EMAIL="${3:-}"
  [[ "$PHONE" =~ ^\+[1-9][0-9]{7,14}$ ]] || stop "phone in E.164: +549…"
  [[ "$EMAIL" =~ ^[^@\ ]+@[^@\ ]+$ ]] || stop "the ERP e-mail of an ADMIN profile is required"
  dbpass
  export V1="$PHONE" V2="$EMAIL"
  R=$(printf '%s\n' '\getenv ph V1' '\getenv em V2' "SELECT 'pre|' || (SELECT count(*) FROM perfiles WHERE lower(email) = lower(:'em') AND activo AND rol_type::text = 'ADMIN') || '|' || (SELECT count(*) FROM wa.sender WHERE phone_e164 = :'ph') || '|' || (SELECT count(*) FROM wa.config)" | psqlc -f - | grep '^pre|')
  [ "$R" = "pre|1|0|1" ] || stop "precondition (active ADMIN with that e-mail | phone already mapped | config row) = ${R#pre|}, expected 1|0|1"
  phrase "MAP SENDER ***${PHONE: -3} $REF"
  printf '%s\n' '\getenv ph V1' '\getenv em V2' "INSERT INTO wa.sender (phone_e164, perfil_id) SELECT :'ph', id FROM perfiles WHERE lower(email) = lower(:'em') AND activo AND rol_type::text = 'ADMIN';" | psqlc -f - | grep ERROR && stop "insert failed"
  unset V1 V2
  echo "state: $(state)"
  ;;
--enable)
  dbpass
  S=$(state); echo "state: $S"
  [[ "$S" =~ ^config=disabled\ senders=[1-9][0-9]*\ vault_secret=true\ gateway_has_profile=false$ ]] || stop "enable needs: config disabled, ≥1 sender, the Vault secret, a profile-less gateway"
  supabase functions list --project-ref "$REF" -o json 2>/dev/null | grep -q '"slug":"wa-gateway"' || stop "the wa-gateway function is not deployed"
  phrase "ENABLE WA BOT $REF"
  psqlc -c "UPDATE wa.config SET enabled = true" | grep ERROR && stop "update failed"
  echo "state: $(state)"
  ;;
--disable)
  dbpass
  phrase "DISABLE WA BOT $REF"
  psqlc -c "UPDATE wa.config SET enabled = false" | grep ERROR && stop "update failed"
  echo "state: $(state)"
  ;;
esac
unset PGPASSWORD
echo "== done ($MODE)"
