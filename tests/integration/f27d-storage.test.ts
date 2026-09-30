/**
 * F27-D / ADR-008 Storage perimeter (migration 0058) against the guarded LOCAL stack only.
 *
 * Two layers:
 *   1. RLS perimeter (always runs): the Storage service executes its object queries as the caller's database role
 *      (`authenticated` / `anon`) with the caller's JWT claims, so the policies of 0058 are the access authority.
 *      These tests run the same queries as those roles, with simulated claims, directly in the local database.
 *   2. Storage API (runs only when the local Storage service answers): MIME allowlist, 10 MB limit, signed / public
 *      URLs and real uploads. The service is enforced by the Storage server, not by SQL. When the service is not
 *      running (the Supabase CLI that starts it is blocked on this workstation), the layer is reported as SKIPPED.
 *
 *   TEST_DATABASE_URL="postgresql://postgres:postgres@127.0.0.1:54322/postgres" npm run test:integration
 */
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { assertNoProductionCredentials, assertSafeDestructiveTarget } from '../../scripts/test-env/guard.mjs';
import { attachmentPath, attachmentSignedUrl, MAX_ATTACHMENT_BYTES, PURCHASE_ATTACHMENT_BUCKET } from '../../src/target/attachments';

const LOCAL_URL = 'http://127.0.0.1:54321';
assertNoProductionCredentials(process.env);
assertSafeDestructiveTarget(process.env.TEST_DATABASE_URL);

function localKeys(): { anon: string; service: string } {
  const c = (spawnSync('docker', ['ps', '--filter', 'name=supabase_edge_runtime', '--format', '{{.Names}}'], { encoding: 'utf8' }).stdout || '')
    .trim().split('\n')[0];
  if (!c) throw new Error('local edge-runtime container not running');
  const env = (spawnSync('docker', ['inspect', c, '--format', '{{range .Config.Env}}{{println .}}{{end}}'], { encoding: 'utf8' }).stdout || '')
    .split(/\r?\n/);
  const get = (k: string) => (env.find((l) => l.startsWith(`${k}=`)) ?? '').slice(k.length + 1);
  const keys = { anon: get('SUPABASE_ANON_KEY'), service: get('SUPABASE_SERVICE_ROLE_KEY') };
  for (const [want, jwt] of [['anon', keys.anon], ['service_role', keys.service]] as const) {
    const payload = JSON.parse(Buffer.from(jwt.split('.')[1] ?? '', 'base64url').toString() || '{}');
    if (payload.iss !== 'supabase-demo' || payload.role !== want) throw new Error(`not a local demo ${want} key`);
  }
  return keys;
}
function psql(sql: string): { ok: boolean; out: string; err: string } {
  const c = (spawnSync('docker', ['ps', '--filter', 'name=supabase_db', '--format', '{{.Names}}'], { encoding: 'utf8' }).stdout || '').trim().split('\n')[0];
  const r = spawnSync('docker', ['exec', '-i', c, 'psql', '-U', 'postgres', '-d', 'postgres', '-t', '-A', '-q', '-v', 'ON_ERROR_STOP=1', '-f', '-'],
    { encoding: 'utf8', input: sql });
  return { ok: r.status === 0, out: (r.stdout || '').trim(), err: r.stderr || '' };
}
function owner(sql: string): string {
  const r = psql(sql);
  if (!r.ok) throw new Error(r.err);
  return r.out;
}
/** Run `body` as the database role the Storage service would use for this caller, in one committed transaction. */
function as(who: 'ADMIN' | 'OPERATOR' | 'NO_PROFILE' | 'anon', body: string) {
  const uid = who === 'anon' ? null : who === 'NO_PROFILE' ? noProfileId : users[who].id;
  const claims = uid ? JSON.stringify({ sub: uid, role: 'authenticated' }) : JSON.stringify({ role: 'anon' });
  return psql(`BEGIN;
SET LOCAL ROLE ${uid ? 'authenticated' : 'anon'};
SET LOCAL "request.jwt.claims" = '${claims}';
SET LOCAL storage.allow_delete_query = 'true';
${body}
COMMIT;`);
}

const keys = localKeys();
const opts = { auth: { persistSession: false, autoRefreshToken: false } };
const service = createClient(LOCAL_URL, keys.service, opts);
const anon = createClient(LOCAL_URL, keys.anon, opts);
const run = randomUUID().slice(0, 8);
const B = PURCHASE_ATTACHMENT_BUCKET;
const PROBE = `f27d-probe-${run}`;   // an unrelated private bucket with no policy of its own
const noProfileId = randomUUID();     // an authenticated identity without an active target profile
const password = `F27ds-${randomUUID()}`;
const users: Record<'ADMIN' | 'OPERATOR', { email: string; id?: string; client?: SupabaseClient }> = {
  ADMIN: { email: `f27ds-admin-${run}@example.invalid` },
  OPERATOR: { email: `f27ds-operator-${run}@example.invalid` },
};
const count = (who: Parameters<typeof as>[0], where: string) => {
  const r = as(who, `SELECT count(*) FROM storage.objects WHERE ${where};`);
  if (!r.ok) throw new Error(r.err);
  return Number(r.out);
};
const affected = (who: Parameters<typeof as>[0], stmt: string) => {
  const r = as(who, `WITH x AS (${stmt} RETURNING 1) SELECT count(*) FROM x;`);
  return r.ok ? Number(r.out) : `ERROR ${r.err.split('\n')[0]}`;
};

// the Storage service is not part of every local stack (it is started by the Supabase CLI)
const STORAGE_UP = await fetch(`${LOCAL_URL}/storage/v1/bucket`, { headers: { apikey: keys.service, Authorization: `Bearer ${keys.service}` } })
  .then((r) => r.status === 200).catch(() => false);

beforeAll(async () => {
  for (const [role, u] of Object.entries(users)) {
    const { data, error } = await service.auth.admin.createUser({ email: u.email, password, email_confirm: true });
    if (error) throw error;
    u.id = data.user!.id;
    owner(`INSERT INTO perfiles (id, email, rol_type, activo) VALUES ('${u.id}', '${u.email}', '${role}', true);`);
    const client = createClient(LOCAL_URL, keys.anon, opts);
    const s = await client.auth.signInWithPassword({ email: u.email, password });
    if (s.error) throw s.error;
    u.client = client;
  }
  owner(`INSERT INTO storage.buckets (id, name, public) VALUES ('${PROBE}', '${PROBE}', false);
INSERT INTO storage.objects (bucket_id, name) VALUES ('${PROBE}', 'probe/seed.pdf');`);
});

afterAll(async () => {
  const mine = `(name LIKE '${users.ADMIN.id}/%' OR name LIKE '${users.OPERATOR.id}/%' OR name LIKE 'probe/%')`;
  if (STORAGE_UP) {   // through the API, so stored files are removed too
    const names = owner(`SELECT string_agg(name, E'\\n') FROM storage.objects WHERE bucket_id = '${B}' AND ${mine};`).split('\n').filter(Boolean);
    if (names.length) await service.storage.from(B).remove(names);
  }
  owner(`BEGIN;
SET LOCAL storage.allow_delete_query = 'true';
DELETE FROM storage.objects WHERE (bucket_id = '${B}' AND ${mine}) OR bucket_id = '${PROBE}';
DELETE FROM storage.buckets WHERE id = '${PROBE}';
COMMIT;`);
  const ids = Object.values(users).map((u) => u.id).filter(Boolean);
  if (ids.length) owner(`DELETE FROM perfiles WHERE id IN (${ids.map((i) => `'${i}'`).join(',')});`);
  for (const u of Object.values(users)) if (u.id) await service.auth.admin.deleteUser(u.id);
});

describe('ADR-008 bucket configuration (migration 0058)', () => {
  it('the bucket exists, is private, has the 10 MB limit and the MIME allowlist', () => {
    expect(owner(`SELECT public || '|' || file_size_limit || '|' || array_to_string(allowed_mime_types, ',') FROM storage.buckets WHERE id = '${B}';`))
      .toBe(`false|${MAX_ATTACHMENT_BYTES}|application/pdf,image/jpeg,image/png,image/webp`);
  });

  it('exactly three storage policies exist: all for authenticated, confined to this bucket, ADMIN via current_app_role(); none for UPDATE or anon', () => {
    const rows = owner(`SELECT tablename || '|' || policyname || '|' || cmd || '|' || array_to_string(roles, ',') || '|' ||
      (coalesce(qual, '') || coalesce(with_check, '') LIKE '%purchase-attachments%' AND coalesce(qual, '') || coalesce(with_check, '') LIKE '%current_app_role()%ADMIN%')
      FROM pg_policies WHERE schemaname = 'storage' ORDER BY policyname;`).split('\n');
    expect(rows).toEqual([
      'objects|purchase_attachments_admin_delete|DELETE|authenticated|true',
      'objects|purchase_attachments_admin_insert|INSERT|authenticated|true',
      'objects|purchase_attachments_admin_select|SELECT|authenticated|true',
    ]);
  });
});

describe('ADR-008 RLS perimeter (the queries the Storage service runs as the caller)', () => {
  const key = () => `${users.ADMIN.id}/${run}-a.pdf`;

  it('ADMIN creates an object under its own folder and reads it', () => {
    expect(as('ADMIN', `INSERT INTO storage.objects (bucket_id, name) VALUES ('${B}', '${key()}');`).ok).toBe(true);
    expect(count('ADMIN', `bucket_id = '${B}' AND name = '${key()}'`)).toBe(1);
  });

  it('OPERATOR and anon cannot read, create or delete; a user without an active profile is refused', () => {
    expect(count('OPERATOR', `bucket_id = '${B}'`)).toBe(0);
    expect(count('anon', `bucket_id = '${B}'`)).toBe(0);
    expect(as('OPERATOR', `INSERT INTO storage.objects (bucket_id, name) VALUES ('${B}', '${users.OPERATOR.id}/${run}.pdf');`).ok).toBe(false);
    expect(as('anon', `INSERT INTO storage.objects (bucket_id, name) VALUES ('${B}', 'probe/${run}.pdf');`).ok).toBe(false);
    expect(affected('OPERATOR', `DELETE FROM storage.objects WHERE bucket_id = '${B}' AND name = '${key()}'`)).toBe(0);
    expect(affected('anon', `DELETE FROM storage.objects WHERE bucket_id = '${B}' AND name = '${key()}'`)).toBe(0);
    expect(as('NO_PROFILE', `SELECT count(*) FROM storage.objects WHERE bucket_id = '${B}';`).ok).toBe(false);
    expect(count('ADMIN', `bucket_id = '${B}' AND name = '${key()}'`)).toBe(1);
  });

  it('ADMIN cannot write outside its own folder, and no one can update (overwrite / move) an object', () => {
    expect(as('ADMIN', `INSERT INTO storage.objects (bucket_id, name) VALUES ('${B}', '${users.OPERATOR.id}/${run}.pdf');`).ok).toBe(false);
    expect(affected('ADMIN', `UPDATE storage.objects SET name = '${users.ADMIN.id}/moved.pdf' WHERE bucket_id = '${B}' AND name = '${key()}'`)).toBe(0);
  });

  it('ADMIN deletes the object', () => {
    expect(affected('ADMIN', `DELETE FROM storage.objects WHERE bucket_id = '${B}' AND name = '${key()}'`)).toBe(1);
    expect(count('ADMIN', `bucket_id = '${B}' AND name = '${key()}'`)).toBe(0);
  });

  it('the policies do not reach another bucket: closed to ADMIN / OPERATOR / anon, and no error for a user without a profile', () => {
    for (const who of ['ADMIN', 'OPERATOR', 'anon', 'NO_PROFILE'] as const) {
      expect(count(who, `bucket_id = '${PROBE}'`), who).toBe(0);
      expect(as(who, `INSERT INTO storage.objects (bucket_id, name) VALUES ('${PROBE}', 'probe/${who}.pdf');`).ok, who).toBe(false);
    }
    expect(Number(owner(`SELECT count(*) FROM storage.objects WHERE bucket_id = '${PROBE}';`))).toBe(1);
  });
});

describe.skipIf(!STORAGE_UP)('ADR-008 Storage API (requires the local Storage service)', () => {
  const admin = () => users.ADMIN.client!;
  const operator = () => users.OPERATOR.client!;
  const pdf = (bytes = 64) => new Blob([new Uint8Array(bytes).fill(37)], { type: 'application/pdf' });
  const bucket = (c: SupabaseClient) => c.storage.from(B);
  let path = '';

  it('ADMIN uploads, downloads, gets a short-lived signed link and deletes; OPERATOR / anon get nothing; the public URL gives no access', async () => {
    path = attachmentPath(users.ADMIN.id!, 'application/pdf');
    expect((await bucket(admin()).upload(path, pdf(), { contentType: 'application/pdf', upsert: false })).error).toBeNull();
    expect((await bucket(admin()).download(path)).data?.size).toBe(64);
    expect((await fetch(await attachmentSignedUrl(admin(), path))).status).toBe(200);
    expect((await bucket(operator()).upload(attachmentPath(users.OPERATOR.id!, 'application/pdf'), pdf(), { contentType: 'application/pdf' })).error).not.toBeNull();
    expect((await bucket(operator()).download(path)).error).not.toBeNull();
    expect((await bucket(anon).download(path)).error).not.toBeNull();
    expect((await fetch(bucket(anon).getPublicUrl(path).data.publicUrl)).status).not.toBe(200);
    expect((await bucket(admin()).remove([path])).error).toBeNull();
  });

  it('unsupported MIME types and objects over 10 MB are rejected; the allowed image types are accepted', async () => {
    for (const type of ['text/plain', 'text/html', 'application/x-msdownload', 'application/octet-stream']) {
      expect((await bucket(admin()).upload(`${users.ADMIN.id}/${randomUUID()}.bin`, new Blob(['MZ'], { type }), { contentType: type })).error, type).not.toBeNull();
    }
    const big = new Blob([new Uint8Array(MAX_ATTACHMENT_BYTES + 1)], { type: 'application/pdf' });
    expect((await bucket(admin()).upload(attachmentPath(users.ADMIN.id!, 'application/pdf'), big, { contentType: 'application/pdf' })).error).not.toBeNull();
    for (const type of ['image/jpeg', 'image/png', 'image/webp']) {
      expect((await bucket(admin()).upload(attachmentPath(users.ADMIN.id!, type), new Blob([new Uint8Array(16)], { type }), { contentType: type })).error, type).toBeNull();
    }
  });
});
