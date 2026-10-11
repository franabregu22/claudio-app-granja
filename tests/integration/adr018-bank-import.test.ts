/**
 * ADR-018 bank statement import UI — local end-to-end through the frontend data layer (src/target/bankStatements.ts)
 * and supabase-js, against the real Edge Function fin-statement-import, PostgREST (RLS) and Storage.
 *
 * It writes immutable rows (fin_import_run, fin_statement_line) and Storage evidence, so it runs ONLY on a disposable
 * local project and is skipped otherwise:
 *   FIN_E2E_PROJECT=granja_fresh_0073 TEST_DATABASE_URL="postgresql://postgres:postgres@127.0.0.1:54322/postgres" \
 *     npx vitest run tests/integration/adr018-bank-import.test.ts
 * SYNTHETIC statements only (scripts/adr018/fixtures), rendered to PDF.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { beforeAll, describe, expect, it } from 'vitest';
import { assertNoProductionCredentials, assertSafeDestructiveTarget } from '../../scripts/test-env/guard.mjs';
import { buildPdf } from '../../scripts/adr018/synthetic-pdf';
import {
  canReprocess, importStatement, type ImportRun, listImportRuns, listStatementAccounts, reprocessRun,
} from '../../src/target/bankStatements';
import { TargetDbError } from '../../src/target/db';

const PROJECT = process.env.FIN_E2E_PROJECT ?? '';
const ENABLED = PROJECT !== '' && PROJECT !== 'Claudio_app_Granja';
const LOCAL_URL = 'http://127.0.0.1:54321';

describe.skipIf(!ENABLED)('ADR-018 bank import UI data layer — local E2E (disposable project)', () => {
  const docker = (args: string[], input?: string) => spawnSync('docker', args, { encoding: 'utf8', input });
  const DB = `supabase_db_${PROJECT}`;
  const EDGE = `supabase_edge_runtime_${PROJECT}`;
  const psql = (sql: string) => {
    const r = docker(['exec', '-i', DB, 'psql', '-U', 'postgres', '-d', 'postgres', '-t', '-A', '-q', '-v', 'ON_ERROR_STOP=1', '-f', '-'], sql);
    if (r.status !== 0) throw new Error(r.stderr);
    return (r.stdout || '').trim();
  };
  type Fixture = { name: string; format: string; config: { expected_account_number: string; expected_cbu: string; expected_extra: Record<string, string> };
    pages: { n: number; items: { str: string; x: number; top: number; w: number }[] }[]; expect: { lines: unknown[] } };
  const FIXTURES: Fixture[] = JSON.parse(readFileSync(resolve(__dirname, '../../scripts/adr018/fixtures/unpdf-synthetic-statements.json'), 'utf8')).fixtures;
  const BNA = FIXTURES.find((f) => f.name === 'bna-synthetic')!;
  const PAT = FIXTURES.find((f) => f.name === 'patagonia-synthetic')!;
  const BNA_PDF = buildPdf(BNA.pages);
  const PAT_PDF = buildPdf(PAT.pages);
  const file = (bytes: Uint8Array, name: string) => new File([bytes as Uint8Array<ArrayBuffer>], name, { type: 'application/pdf' });
  const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
  const tag = randomUUID().slice(0, 8);
  const keys = { anon: '', service: '' };
  const acc = { bna: '', pat: '' };
  const users: Record<'ADMIN' | 'OPERATOR', { id: string; client: SupabaseClient }> = {} as never;
  const opts = { auth: { persistSession: false, autoRefreshToken: false } };
  const admin = () => users.ADMIN.client;

  beforeAll(async () => {
    assertNoProductionCredentials(process.env);
    assertSafeDestructiveTarget(process.env.TEST_DATABASE_URL);
    const running = (docker(['ps', '--format', '{{.Names}}']).stdout || '').split(/\r?\n/);
    if (!running.includes(DB) || !running.includes(EDGE) || running.some((n) => n.endsWith('_Claudio_app_Granja'))) {
      throw new Error(`the disposable project ${PROJECT} must be the only local stack running`);
    }
    const env = (docker(['inspect', EDGE, '--format', '{{range .Config.Env}}{{println .}}{{end}}']).stdout || '').split(/\r?\n/);
    const get = (k: string) => (env.find((l) => l.startsWith(`${k}=`)) ?? '').slice(k.length + 1);
    keys.anon = get('SUPABASE_ANON_KEY');
    keys.service = get('SUPABASE_SERVICE_ROLE_KEY');
    for (const [want, jwt] of [['anon', keys.anon], ['service_role', keys.service]] as const) {
      const payload = JSON.parse(Buffer.from(jwt.split('.')[1] ?? '', 'base64url').toString() || '{}');
      if (payload.iss !== 'supabase-demo' || payload.role !== want) throw new Error(`not a local demo ${want} key`);
    }
    const account = (name: string, f: Fixture) => psql(`WITH a AS (INSERT INTO financial_account (nombre, account_type) VALUES ('${name}', 'BANK_ACCOUNT') RETURNING id)
      INSERT INTO fin_statement_account_config (financial_account_id, format_code, expected_account_number, expected_cbu, expected_extra)
      SELECT id, '${f.format}', '${f.config.expected_account_number}', '${f.config.expected_cbu}', '${JSON.stringify(f.config.expected_extra)}'::jsonb FROM a
      RETURNING financial_account_id;`);
    acc.bna = account(`BNA sintético ${tag}`, BNA);
    acc.pat = account(`Patagonia sintético ${tag}`, PAT);
    const service = createClient(LOCAL_URL, keys.service, opts);
    for (const role of ['ADMIN', 'OPERATOR'] as const) {
      const email = `adr018-ui-${role.toLowerCase()}-${tag}@example.invalid`;
      const password = `Adr018-${randomUUID()}`;
      const { data, error } = await service.auth.admin.createUser({ email, password, email_confirm: true });
      if (error) throw error;
      psql(`INSERT INTO perfiles (id, email, rol_type, activo) VALUES ('${data.user!.id}', '${email}', '${role}', true);`);
      const client = createClient(LOCAL_URL, keys.anon, opts);
      const s = await client.auth.signInWithPassword({ email, password });
      if (s.error) throw s.error;
      users[role] = { id: data.user!.id, client };
    }
  });

  const findRun = async (id: string) => (await listImportRuns(admin())).find((r) => r.id === id) as ImportRun;

  it('ADMIN sees the configured bank accounts (id and name only)', async () => {
    const accounts = await listStatementAccounts(admin());
    expect(accounts).toEqual(expect.arrayContaining([{ id: acc.bna, nombre: `BNA sintético ${tag}` }, { id: acc.pat, nombre: `Patagonia sintético ${tag}` }]));
    for (const a of accounts) expect(Object.keys(a).sort()).toEqual(['id', 'nombre']);
  });

  it('OPERATOR: no history rows (RLS), no accounts, and the Edge refuses the import', async () => {
    expect(await listImportRuns(users.OPERATOR.client)).toEqual([]);
    expect(await listStatementAccounts(users.OPERATOR.client)).toEqual([]);
    const err = await importStatement(users.OPERATOR.client, { accountId: acc.bna, file: file(BNA_PDF, 'bna.pdf') }).catch((e) => e);
    expect(err).toBeInstanceOf(TargetDbError);
    expect(err.code).toBe('ADMIN_REQUIRED');
  });

  it('BNA: PARSED, first in the history; the same file again is a replay (same run, nothing duplicated)', async () => {
    const r = await importStatement(admin(), { accountId: acc.bna, file: file(BNA_PDF, 'bna-agosto.pdf') });
    expect([r.status, r.replayed, r.financial_account_id, r.file_sha256]).toEqual(['PARSED', false, acc.bna, sha(BNA_PDF)]);
    expect(r.counters.lines_new).toBe(BNA.expect.lines.length);
    const history = await listImportRuns(admin());
    expect(history[0]).toMatchObject({ id: r.run_id, status: 'PARSED', cuenta: `BNA sintético ${tag}`, file_name: 'bna-agosto.pdf' });
    const again = await importStatement(admin(), { accountId: acc.bna, file: file(BNA_PDF, 'otro-nombre.pdf') });
    expect([again.run_id, again.replayed, again.status]).toEqual([r.run_id, true, 'PARSED']);
    expect((await listImportRuns(admin())).filter((x) => x.financial_account_id === acc.bna)).toHaveLength(1);
  });

  it('Patagonia: PARSED', async () => {
    const r = await importStatement(admin(), { accountId: acc.pat, file: file(PAT_PDF, 'patagonia-septiembre.pdf') });
    expect([r.status, r.format_code]).toEqual(['PARSED', 'PATAGONIA_STATEMENT_PDF_V1']);
    expect((await findRun(r.run_id)).file_name).toBe('patagonia-septiembre.pdf');
  });

  it('a file the account adapter rejects → REJECTED run (HTTP 200), offered for reprocess; reprocess with the same parser replays it', async () => {
    const r = await importStatement(admin(), { accountId: acc.bna, file: file(PAT_PDF, 'equivocado.pdf') });
    expect(r.status).toBe('REJECTED');
    expect(r.reject_reason).toMatch(/^[A-Z_]+: /);
    const history = await listImportRuns(admin());
    const rejected = history.find((x) => x.id === r.run_id)!;
    expect(canReprocess(rejected, history)).toBe(true);
    const again = await reprocessRun(admin(), r.run_id);
    expect([again.run_id, again.replayed, again.status]).toEqual([r.run_id, true, 'REJECTED']);
    expect((await listImportRuns(admin())).filter((x) => x.file_sha256 === sha(PAT_PDF) && x.financial_account_id === acc.bna)).toHaveLength(1);
  });

  it('reprocess of a run rejected by an older parser version → new PARSED run chained to it; both stay in the history', async () => {
    // an older attempt as the Edge would have stored it (evidence + RPC as service role, both local-only)
    const bytes = new Uint8Array([...BNA_PDF, ...new TextEncoder().encode(`% older-${tag}\n`)]);
    const h = sha(bytes);
    const path = `bank/${acc.bna}/${h}.pdf`;
    const service = createClient(LOCAL_URL, keys.service, opts);
    const up = await service.storage.from('financial-statements').upload(path, bytes, { contentType: 'application/pdf', upsert: false });
    expect(up.error).toBeNull();
    const { data: seeded, error } = await service.rpc('fin_import_bank_statement', {
      p_actor: users.ADMIN.id, p_account_id: acc.bna, p_parser_version: 'BNA_MONTHLY_PDF_V1/0.0.1 e2e-old', p_format_code: 'BNA_MONTHLY_PDF_V1',
      p_file_sha256: h, p_storage_path: path, p_file_name: 'bna-reemitido.pdf', p_byte_size: bytes.length, p_coverage_from: null, p_coverage_to: null,
      p_source_meta: null, p_previous_run_id: null, p_reject_reason: 'UNCLASSIFIABLE_ROW: e2e older parser', p_rows: null,
    });
    expect(error).toBeNull();
    const oldId = (seeded as { run_id: string }).run_id;
    const before = await listImportRuns(admin());
    expect(canReprocess(before.find((x) => x.id === oldId)!, before)).toBe(true);

    const r = await reprocessRun(admin(), oldId);
    expect([r.status, r.replayed, r.file_sha256]).toEqual(['PARSED', false, h]);
    const after = await listImportRuns(admin());
    const fresh = after.find((x) => x.id === r.run_id)!;
    const old = after.find((x) => x.id === oldId)!;
    expect([fresh.previous_run_id, fresh.file_name, fresh.status]).toEqual([oldId, 'bna-reemitido.pdf', 'PARSED']);
    expect(old.status).toBe('REJECTED');
    expect(canReprocess(old, after)).toBe(false);
    expect(after.findIndex((x) => x.id === r.run_id)).toBeLessThan(after.findIndex((x) => x.id === oldId));   // created_at DESC
  });
});
