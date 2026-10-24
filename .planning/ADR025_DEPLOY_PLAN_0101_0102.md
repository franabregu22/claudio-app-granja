# ADR-025 — Production apply of 0101 + 0102 (PLAN ONLY — nothing executed)

Target: `granja-santo-tomas-v1` · ref `ycmkpnunhxluqqtecbyu` · sa-east-1. **Forbidden:** `aplbsutpzgemexayldct` (AppGranja staging),
`shdrztqgwpyyxclgfpdg` (Farm ERP / legacy). Database only: no Edge, no n8n, no Meta, no frontend in this plan.

| Migration | sha256[0..12] | Content |
|---|---|---|
| `0101_unclassified_expenses.sql` | `0b525fd0b365` | unclassified expenses (pending tables, 2 RPCs, integrity / close guards, P&L bucket) |
| `0102_wa_whatsapp_gateway.sql` | `b51c8dc21d72` | WhatsApp gateway schema `wa` + 8 `public.wa_*`; **bot OFF** (`wa.config` / `wa.sender` empty) |

0102 depends on 0101: its guard aborts (`CANDIDATE_GUARD: migration 0101 … is not applied`) on a database without 0101, and on a
database with a `wa` or `sim` schema. Production stays at 0100 until the owner GO.

## A. Deployment trees (two commits, one tree per step)

The runner refuses any local migration beyond `--to`. Each step therefore runs from its own clean tree:

| Step | Commit content | Tree |
|---|---|---|
| 1 (0101) | 0101 migration (renamed from the candidate) + `ADR025_POST_0101` profile + runner registration + runner test range | clone of `264f6d9` |
| 2 (0102) | 0102 migration + `build.mjs` / guard / runners + `ADR025_POST_0102` profile | clone of the commit that adds this plan |

Each tree:
1. clean clone of the commit, `core.autocrlf=false`;
2. 0042 and 0046 converted LF→CRLF, bytes only (production ledger: 0042 `c98b9ef24aeb…`, 0046 `0fee172d057b…`; `git diff --ignore-cr-at-eol` empty);
3. not staged, not committed (same rule as `ADR018_DEPLOY_PLAN_V1.md` §E);
4. `sha256sum supabase/target-migrations/0101_*.sql supabase/target-migrations/0102_*.sql` equals the table above.

A plain LF tree aborts with `LEDGER_SHA_MISMATCH` on 0042: that is correct, not a reason to touch the ledger.

**Common setup** (owner shell, tree root; password typed privately, never pasted into chat):
```bash
export PGHOST=aws-0-sa-east-1.pooler.supabase.com PGPORT=5432 PGUSER=postgres.ycmkpnunhxluqqtecbyu PGDATABASE=postgres PGSSLMODE=require
read -rs PGPASSWORD && export PGPASSWORD
REF=ycmkpnunhxluqqtecbyu; LEGACY_REFS=aplbsutpzgemexayldct,shdrztqgwpyyxclgfpdg
export MIGRATION_TARGET_DB_URL="postgresql://$PGUSER:$(node -e 'process.stdout.write(encodeURIComponent(process.env.PGPASSWORD))')@$PGHOST:$PGPORT/$PGDATABASE?sslmode=require"
INC() { node scripts/target-db/apply-incremental.mjs --from "$1" --to "$2" --client supabase_db_Claudio_app_Granja \
  --production --expected-project-ref $REF --forbidden-refs $LEGACY_REFS --confirm-project $REF --confirm-from "$1" --confirm-to "$2" "${@:3}"; }
```
Never run `supabase link` / `supabase db push`, nor any `supabase` command without `--project-ref $REF`.

## B. Gate 1 — preflight (read-only)

1. **Identity + parity:** `bash integrations/whatsapp/production/b4-parity-readonly.sh`. Expected: control plane
   `ycmkpnunhxluqqtecbyu|granja-santo-tomas-v1|sa-east-1|ACTIVE_HEALTHY`; database fingerprint `true|true|true|true`;
   groups 1–8 as recorded at B-4 (A-1 "4 ADMIN" is the known owner item, not a schema blocker); `8_SIN_WA` PASS.
2. **Migration state** (tree 1): `INC 0100 0101 --dry-run`. Expected:
   - 0001…0100 `VERIFIED_APPLIED`, every sha256 verified (ledger 100 rows, last 0100);
   - `0101  0b525fd0b365  PENDING`; `DRY-RUN OK`, no SQL executed.
3. **Objects absent** (one read-only query):
```sql
SELECT to_regnamespace('wa') IS NULL AS no_wa, to_regnamespace('sim') IS NULL AS no_sim,
       to_regclass('public.expense_pending_classification') IS NULL AS no_pending,
       to_regproc('public.register_unclassified_expense') IS NULL AS no_rpc,
       (SELECT count(*) FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND prosecdef
          AND proname <> 'rls_auto_enable') AS app_definers;
```
   Expected: `t | t | t | t | 94` (the POST_0100 application set; after 0101: 98; after 0102: 106 — measured on the local rehearsal).

**STOP** on any deviation: different ref / name / region, `LEDGER_*`, `FILES`, `PROJECT`, `CONFIRM`, `LOCK_BUSY`, any object present.

## C. Gate 2 — backup and recovery point

- Dashboard → Database → Backups: confirm today's daily backup / PITR for `$REF` and record its timestamp.
- Private schema snapshot (owner machine, never committed):
  `docker exec -i -e PGHOST -e PGPORT -e PGUSER -e PGPASSWORD -e PGDATABASE -e PGSSLMODE supabase_db_Claudio_app_Granja pg_dump --schema-only -n public > ~/granja-private/adr025-pre-0101-schema.sql`
- Recovery model: there is no down migration (immutable ledger).
  - A failing migration rolls back with its own ledger row (one transaction per file).
  - Once applied, 0101 / 0102 stay installed and inert. With `wa.config` empty, every `public.wa_*` call is refused; no ERP screen calls 0101 until the frontend is deployed.
  - An urgent disable is a forward migration: `REVOKE EXECUTE … FROM authenticated` on the new RPCs. The data is kept.
  - PITR to the recorded timestamp is the last resort. It is an owner decision, because it also discards every production write made after that point.

## D. Gate 3 — apply 0101 → verify (owner GO, tree 1)

```bash
INC 0100 0101 --dry-run                                    # immediately before: still exactly 0100, 0101 PENDING
INC 0100 0101 --verify-profile ADR025_POST_0101 --deployment-check
```
Expected:
- `0101  0b525fd0b365  APPLIED`;
- `starting ledger: 100 · ending ledger: 101`;
- every profile line `OK`, including `DEPLOYMENT CHECK 0101: no unclassified expense and no resolution yet`;
- `RESULT: APPLIED 0100→0101`.

**Note:** `--deployment-check` also runs the ADR-018 deployment check of POST_0100. If that check fails only on ADR-018 evidence that grew after the 0100 deploy, rerun without `--deployment-check` and record it. Any other `MAL` → STOP.

Re-run `INC 0100 0101 --verify-profile ADR025_POST_0101`. It must return `NO-OP` with the profile PASS.

## E. Gate 4 — apply 0102 → verify (owner GO, tree 2)

```bash
INC 0101 0102 --dry-run                                    # 0001…0101 VERIFIED_APPLIED, 0102 b51c8dc21d72 PENDING
INC 0101 0102 --verify-profile ADR025_POST_0102 --deployment-check
```
Expected:
- `0102  b51c8dc21d72  APPLIED`;
- ledger 101 → 102;
- every line `OK`, including:
  - `0102 BOT OFF: wa.config and wa.sender empty`;
  - `0102 no staging-only schema sim`;
  - `0102 schema wa: … no privilege for PUBLIC / anon / authenticated / service_role`;
  - the 8 `public.wa_*` with EXECUTE for authenticated only;
- `RESULT: APPLIED 0101→0102`.

Re-run → `NO-OP`.

## F. After the apply

- The bot is **OFF**. Enabling it (inserting the gateway user into `wa.config`, mapping the senders in `wa.sender`, deploying the Edge function, pointing n8n and Meta at production) is a **separate owner GO**. That GO is not part of this plan.
- `b4-parity-readonly.sh` again. Expected: unchanged groups, except that the `wa` schema now exists. `8_SIN_WA` (Edge function) stays PASS.

## G. STOP rules (every gate)

STOP on any of these:
- a sha256 different from the table;
- a ledger that is not exactly 100 (Gate 3) or 101 (Gate 4);
- any `MAL` line;
- any `FAILED`, `LOCK_BUSY` or `lock_timeout`;
- a different project identity.

After a STOP:
- do not retry blindly;
- do not edit an applied file (a fix is a new migration);
- do not rewrite the ledger;
- do not use `--force` alternatives.

## H. Local rehearsal evidence (2026-10-24, exact binary clone of the local ERP at 0100)

| Step | Result |
|---|---|
| `ADR018_POST_0100 --verify-only` on the clone (baseline) | NO-OP, 47 OK / 0 MAL |
| dry-run 0100→0101 | 0101 PENDING, nothing written |
| apply 0100→0101 + `ADR025_POST_0101` | APPLIED, 56 OK / 0 MAL; re-run NO-OP |
| dry-run 0101→0102 | 0102 PENDING |
| apply 0101→0102 + `ADR025_POST_0102` | APPLIED, 66 OK / 0 MAL; re-run NO-OP |
| `--to 0101` with 0102 present | refused (`FILES`) |
| 0102 on a database without 0101 (rolled-back transaction) | refused (`CANDIDATE_GUARD`) |
