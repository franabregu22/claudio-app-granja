#!/usr/bin/env bash
# ADR-025 §18 — wa-gateway + n8n STAGING, owner steps on AppGranja (aplbsutpzgemexayldct) ONLY. NOT RUN without the owner's GO.
#   --catalog <phone-number-id>  DB password → n8n/staging-catalog.json (sim ids + Meta TEST Phone Number ID; non-secret)
#                        → builds n8n/build/STAGING_wa_expense_capture.json ("STAGING - Gastos WhatsApp", inactive)
#   --secrets <n8n-url>  Edge secrets (gateway user from .staging-users.json; Meta verify token, the two n8n tokens and the
#                        capability secret generated ONCE and kept in .wa-gateway-secrets.json, mode 600, never printed)
#                        → supabase secrets set. The two token values are what the owner pastes into the n8n credentials.
#   --deploy             typed phrase → supabase functions deploy wa-gateway --no-verify-jwt (checksummed source)
#   --meta-secret        DB password + Meta TEST app secret (typed) → Vault wa_meta_app_secret (create or update)
#   --verify             read-only: function status, secret names, and 4 harmless probes (all must be refused)
# Production (ycmkpnunhxluqqtecbyu) and Farm ERP (shdrztqgwpyyxclgfpdg) are refused everywhere. No service_role is used.
set -u
export MSYS_NO_PATHCONV=1
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -W)"
ROOT="$HERE/.."
REF=aplbsutpzgemexayldct
HOST=aws-0-us-east-2.pooler.supabase.com
CLIENT=supabase_db_Claudio_app_Granja
USERS="$ROOT/../staging-adr025/.staging-users.json"
SECRETS="$ROOT/.wa-gateway-secrets.json"
FN_URL="https://$REF.supabase.co/functions/v1/wa-gateway"
MODE="${1:-}"
exec > >(tee -a "$HERE/wa-gateway-staging-output.txt") 2>&1
echo "######## run $(date '+%Y-%m-%d %H:%M:%S') — wa-gateway staging, mode ${MODE:-none}"
stop() { echo "STOP: $*"; unset PGPASSWORD; echo "== done (STOPPED)"; exit 2; }
case "$REF" in ycmkpnunhxluqqtecbyu|shdrztqgwpyyxclgfpdg) stop "forbidden project";; esac
case "$MODE" in --catalog|--secrets|--deploy|--meta-secret|--verify) ;; *) echo "usage: $0 --catalog <phone-number-id> | --secrets <n8n-inbound-url> | --deploy | --meta-secret | --verify"; exit 2;; esac

LINE=$(supabase projects list -o json 2>/dev/null | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{const j=JSON.parse(d.slice(d.search(/[\[{]/)));const p=j.find(x=>(x.ref||x.id)==='$REF');console.log(p?[p.ref||p.id,p.name,p.region,p.status].join('|'):'')}catch{console.log('')}})")
echo "control plane: ${LINE:-not found}"
[ "$LINE" = "$REF|AppGranja|us-east-2|ACTIVE_HEALTHY" ] || stop "$REF is not AppGranja / us-east-2 / ACTIVE_HEALTHY"
(cd "$ROOT" && sha256sum -c deploy/SHA256SUMS --quiet) || stop "function / workflow sources differ from the reviewed deploy/SHA256SUMS"

dbpass() {
  echo "Pegá la contraseña de la BASE de AppGranja (no se ve) y Enter:"
  read -rs PGPASSWORD; echo; PGPASSWORD=$(printf '%s' "$PGPASSWORD" | tr -d '\r\n'); [ -n "$PGPASSWORD" ] || stop "empty password"
  export PGPASSWORD PGHOST="$HOST" PGPORT=5432 PGUSER="postgres.$REF" PGDATABASE=postgres PGSSLMODE=require
  FP=$(psqlc -c "SELECT (to_regclass('migration_ledger.applied') IS NULL) || '|' || (to_regclass('public.perfiles') IS NULL) || '|' || (to_regnamespace('wa') IS NOT NULL) || '|' || (to_regnamespace('sim') IS NOT NULL)" | grep '|')
  echo "database fingerprint (no_ledger|no_erp_perfiles|wa|sim): ${FP:-unavailable}"
  [ "$FP" = "true|true|true|true" ] || stop "not the AppGranja bot-staging database"
}
psqlc() { docker exec -i -e PGHOST -e PGPORT -e PGUSER -e PGPASSWORD -e PGDATABASE -e PGSSLMODE -e WA_META_SECRET "$CLIENT" psql -X -q -t -A "$@" 2>&1 | tr -d '\r' | sed 's/^psql:<stdin>:[0-9]*: //'; }

case "$MODE" in
--catalog)
  PNID="${2:-}"; [[ "$PNID" =~ ^[0-9]{6,20}$ ]] || stop "the Meta TEST Phone Number ID (digits) is required: --catalog <phone-number-id>"
  dbpass
  J=$(psqlc -c "SELECT json_build_object('ar_strip_9', true, 'phone_number_id', '$PNID',
      'default_category_id', (SELECT id FROM sim.expense_category WHERE nombre = 'Insumos'),
      'categories', (SELECT json_agg(json_build_object('id', c.id, 'nombre', c.nombre, 'keywords', json_build_array(lower(c.nombre), rtrim(lower(c.nombre), 's'), 'alimento')) ORDER BY c.nombre)
                       FROM sim.expense_category c JOIN sim.expense_category_group g ON g.id = c.group_id WHERE c.activo AND NOT c.fiscal_reserved AND g.kind = 'EXPENSE'),
      'accounts', json_build_object('CASH', (SELECT json_build_object('id', id, 'nombre', nombre) FROM sim.financial_account WHERE nombre = 'Caja chica' AND activo),
                                    'TRANSFER', (SELECT json_build_object('id', id, 'nombre', nombre) FROM sim.financial_account WHERE nombre = 'BNA' AND activo),
                                    'MERCADOPAGO', (SELECT json_build_object('id', id, 'nombre', nombre) FROM sim.financial_account WHERE nombre = 'Mercado Pago' AND activo)))" | grep '^{')
  [ -n "$J" ] || stop "catalog query failed"
  printf '%s\n' "$J" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>require('fs').writeFileSync(process.argv[1],JSON.stringify(JSON.parse(d),null,1)))" "$ROOT/n8n/staging-catalog.json" || stop "catalog not written"
  (cd "$ROOT" && node n8n/build-workflow.mjs) || stop "workflow build failed"
  ;;
--secrets)
  N8N_URL="${2:-}"
  [[ "$N8N_URL" =~ ^https://[A-Za-z0-9.-]+/webhook/adr025-staging-gastos-whatsapp$ ]] || stop "n8n URL must be https://<railway-n8n-host>/webhook/adr025-staging-gastos-whatsapp"
  case "$N8N_URL" in *ycmkpnunhxluqqtecbyu*|*shdrztqgwpyyxclgfpdg*) stop "forbidden reference in the n8n URL";; esac
  [ -f "$USERS" ] || stop "missing .staging-users.json"
  umask 077
  node - "$USERS" "$SECRETS" "$N8N_URL" "$ROOT/.edge-secrets.env" <<'JS' || stop "secrets file not prepared"
const fs = require('fs'); const crypto = require('crypto');
const [users, secretsPath, n8nUrl, envPath] = process.argv.slice(2);
const gw = JSON.parse(fs.readFileSync(users, 'utf8')).find((u) => u.email === 'wa-gateway@staging.invalid');
if (!gw || !gw.password) { console.log('STOP: wa-gateway password not in .staging-users.json'); process.exit(2); }
let s = {}; try { s = JSON.parse(fs.readFileSync(secretsPath, 'utf8')); } catch {}
const gen = () => crypto.randomBytes(32).toString('hex');
s = { WA_META_VERIFY_TOKEN: s.WA_META_VERIFY_TOKEN || gen(), WA_EDGE_TO_N8N_TOKEN: s.WA_EDGE_TO_N8N_TOKEN || gen(),
      WA_N8N_TO_EDGE_TOKEN: s.WA_N8N_TO_EDGE_TOKEN || gen(), WA_CAPABILITY_SECRET: s.WA_CAPABILITY_SECRET || gen() };
fs.writeFileSync(secretsPath, JSON.stringify(s, null, 1), { mode: 0o600 });
fs.writeFileSync(envPath, [`WA_GATEWAY_EMAIL=${gw.email}`, `WA_GATEWAY_PASSWORD=${gw.password}`, `WA_N8N_INBOUND_URL=${n8nUrl}`,
  ...Object.entries(s).map(([k, v]) => `${k}=${v}`)].join('\n') + '\n', { mode: 0o600 });
console.log('secrets prepared (values not printed). n8n credentials: STAGING_WA_EDGE_TO_N8N = Header Auth x-wa-token / WA_EDGE_TO_N8N_TOKEN;'
  + ' STAGING_WA_N8N_TO_EDGE = Header Auth x-wa-token / WA_N8N_TO_EDGE_TOKEN (values in .wa-gateway-secrets.json). WA_CAPABILITY_SECRET never leaves the Edge.');
JS
  echo "Escribí exactamente: SET EDGE SECRETS $REF"
  read -r C; [ "$C" = "SET EDGE SECRETS $REF" ] || { rm -f "$ROOT/.edge-secrets.env"; stop "confirmation phrase mismatch"; }
  supabase secrets set --project-ref "$REF" --env-file "$ROOT/.edge-secrets.env" >/dev/null 2>&1; RC=$?
  rm -f "$ROOT/.edge-secrets.env"
  [ $RC = 0 ] || stop "supabase secrets set failed"
  supabase secrets list --project-ref "$REF" -o json 2>/dev/null | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const n=JSON.parse(d.slice(d.search(/[\[{]/))).map(s=>s.name).filter(n=>!n.startsWith('SUPABASE_')).sort();console.log('edge secret names: '+n.join(','))})"
  ;;
--deploy)
  echo "Escribí exactamente: DEPLOY WA-GATEWAY $REF"
  read -r C; [ "$C" = "DEPLOY WA-GATEWAY $REF" ] || stop "confirmation phrase mismatch"
  (cd "$ROOT" && supabase functions deploy wa-gateway --project-ref "$REF" --workdir . --no-verify-jwt --use-api 2>&1 | grep -viE "token|key") || stop "deploy failed"
  supabase functions list --project-ref "$REF" -o json 2>/dev/null | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const f=JSON.parse(d.slice(d.search(/[\[{]/))).map(f=>f.slug+':'+f.status+':verify_jwt='+f.verify_jwt);console.log('functions: '+f.join(','))})"
  ;;
--meta-secret)
  dbpass
  echo "Pegá el App Secret de la app de PRUEBA de Meta (no se ve) y Enter:"
  read -rs WA_META_SECRET; echo; WA_META_SECRET=$(printf '%s' "$WA_META_SECRET" | tr -d '\r\n'); export WA_META_SECRET
  [[ "$WA_META_SECRET" =~ ^[0-9a-f]{32}$ ]] || stop "a Meta app secret is 32 hex characters"
  R=$(printf '%s\n' '\getenv s WA_META_SECRET' "SELECT 'vault|' || CASE WHEN EXISTS (SELECT 1 FROM vault.secrets WHERE name = 'wa_meta_app_secret')
      THEN (SELECT 'updated:' || (vault.update_secret(id, :'s') IS NULL) FROM vault.secrets WHERE name = 'wa_meta_app_secret')
      ELSE 'created:' || (vault.create_secret(:'s', 'wa_meta_app_secret', 'ADR-025 Meta TEST app secret (staging)') IS NOT NULL) END;" | psqlc -f - | grep -E "^vault\||ERROR")
  unset WA_META_SECRET
  echo "${R:-vault|unavailable}"
  echo "$R" | grep -qE "^vault\|(created|updated):true$" || stop "Vault not updated"
  ;;
--verify)
  supabase functions list --project-ref "$REF" -o json 2>/dev/null | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const f=JSON.parse(d.slice(d.search(/[\[{]/))).map(f=>f.slug+':'+f.status+':verify_jwt='+f.verify_jwt);console.log('functions: '+f.join(','))})"
  supabase secrets list --project-ref "$REF" -o json 2>/dev/null | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const n=JSON.parse(d.slice(d.search(/[\[{]/))).map(s=>s.name).filter(n=>!n.startsWith('SUPABASE_')).sort();console.log('edge secret names: '+n.join(','))})"
  p() { curl -s -o /dev/null -w '%{http_code}' "$@"; }
  echo "probe|meta_verify_wrong_token=$(p "$FN_URL?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=1") (expect 403)"
  echo "probe|webhook_without_signature=$(p -X POST -H 'content-type: application/json' --data '{}' "$FN_URL") (expect 401)"
  echo "probe|webhook_forged_signature=$(p -X POST -H 'content-type: application/json' -H "x-hub-signature-256: sha256=$(printf '0%.0s' {1..64})" --data '{"object":"whatsapp_business_account","entry":[]}' "$FN_URL") (expect 401 once --meta-secret is done; 500 before)"
  echo "probe|action_unsigned=$(p -X POST -H 'content-type: application/json' --data '{"action":"expire"}' "$FN_URL/action") (expect 401)"
  ;;
esac
unset PGPASSWORD
echo "== done ($MODE)"
