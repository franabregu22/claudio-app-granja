/**
 * ADR-018 bank statement import UI — data layer, access and contract tests. The REAL supabase-js client is used with
 * a recording fetch, so the assertions are on the actual HTTP requests (PostgREST reads and the Edge Function call).
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createClient } from '@supabase/supabase-js';
import { describe, expect, it } from 'vitest';
import {
  canReprocess, canSubmitImport, IMPORT_FUNCTION, importStatement, type ImportRun, listImportRuns, listStatementAccounts, MAX_STATEMENT_BYTES,
  rejectCode, rejectMessage, reprocessRun, validateStatementFile,
} from '../../src/target/bankStatements';
import { TARGET_READ_TABLES, TargetDbError } from '../../src/target/db';
import { errorMessage } from '../../src/target/messages';
import { modulesFor, resolveModule } from '../../src/target/roles';

const URL_ = 'http://127.0.0.1:54321';
interface Seen { url: URL; method: string; headers: Headers; body: BodyInit | null | undefined }
function harness(routes: Record<string, () => Response>) {
  const seen: Seen[] = [];
  const fetchImpl = async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    seen.push({ url, method: init.method ?? 'GET', headers: new Headers(init.headers), body: init.body });
    const key = Object.keys(routes).find((k) => url.pathname.endsWith(k));
    return key ? routes[key]() : new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const client = createClient(URL_, 'anon-key', { global: { fetch: fetchImpl as typeof fetch }, auth: { persistSession: false, autoRefreshToken: false } });
  return { client, seen };
}
const json = (status: number, body: unknown) => () => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const pdfFile = (size = 2048, name = 'extracto.pdf', type = 'application/pdf') =>
  new File([new Uint8Array(size).fill(0x25)], name, { type });
const result = (over: Record<string, unknown> = {}) => ({
  run_id: 'r-1', status: 'PARSED', replayed: false, financial_account_id: 'acc-bna', file_sha256: 'a'.repeat(64),
  parser_version: 'BNA_MONTHLY_PDF_V1/1.0.0 unpdf-1.8.1', format_code: 'BNA_MONTHLY_PDF_V1',
  counters: { rows_total: 12, lines_new: 9, lines_known: 1, rows_ignored: 2, rows_invalid: 0, rows_captured: 0 }, reject_reason: null, ...over,
});
const run = (over: Partial<ImportRun>): ImportRun => ({
  id: 'r', created_at: '2026-10-11T10:00:00+00:00', financial_account_id: 'acc', cuenta: 'BNA', file_name: 'x.pdf', file_sha256: 'h1',
  source_kind: 'BANK_STATEMENT', mode: 'NORMAL', status: 'REJECTED', parser_version: 'v', reject_reason: 'UNCLASSIFIABLE_ROW: x',
  previous_run_id: null, rows_total: 0, lines_new: 0, lines_known: 0, rows_ignored: 0, rows_invalid: 0, rows_captured: 0, ...over,
});

describe('ADR-018 access: ADMIN only', () => {
  it('Caja (where Extractos bancarios lives) is an ADMIN module; OPERATOR has no link and a forced request falls back', () => {
    expect(modulesFor('ADMIN')).toContain('caja');
    expect(modulesFor('OPERATOR')).not.toContain('caja');
    expect(resolveModule('OPERATOR', 'caja')).not.toBe('caja');
    expect(resolveModule(null, 'caja')).toBeNull();
  });
  it('CajaApp denies a non-ADMIN before rendering any view, and mounts ExtractosBancarios only as its own view', () => {
    const caja = readFileSync(resolve(__dirname, '../../src/features/caja/CajaApp.tsx'), 'utf8');
    const guard = caja.indexOf("if (rol !== 'ADMIN')");
    expect(guard).toBeGreaterThan(0);
    expect(caja.indexOf('<ExtractosBancarios />')).toBeGreaterThan(guard);
    expect(caja).toMatch(/\{ id: 'extractos', label: 'Extractos bancarios' \}/);
    expect(readFileSync(resolve(__dirname, '../../src/App.tsx'), 'utf8')).not.toMatch(/ExtractosBancarios/);
  });
  it('the UI never writes fin_* tables, never touches Storage directly and holds no service key', () => {
    for (const f of ['src/target/bankStatements.ts', 'src/features/caja/ExtractosBancarios.tsx', 'src/features/caja/useBankStatements.ts']) {
      const src = readFileSync(resolve(__dirname, '../..', f), 'utf8');
      expect(src, f).not.toMatch(/\.storage\b|\.insert\(|\.update\(|\.upsert\(|\.delete\(|service_role|SERVICE_ROLE|\.rpc\(/);
      expect(src, f).not.toMatch(/expected_cbu|expected_account_number|storage_path/);
    }
    expect(TARGET_READ_TABLES).toEqual(expect.arrayContaining(['fin_import_run', 'fin_statement_account_config']));
  });
});

describe('ADR-018 import form validation (UX; the Edge Function re-validates)', () => {
  it('no account / no file / > 10 MB / not a PDF block the submit; a valid PDF enables it', () => {
    expect(canSubmitImport({ accountId: '', file: pdfFile(), pending: false })).toBe(false);
    expect(canSubmitImport({ accountId: 'acc', file: null, pending: false })).toBe(false);
    expect(canSubmitImport({ accountId: 'acc', file: pdfFile(MAX_STATEMENT_BYTES + 1), pending: false })).toBe(false);
    expect(canSubmitImport({ accountId: 'acc', file: pdfFile(10, 'foto.png', 'image/png'), pending: false })).toBe(false);
    expect(canSubmitImport({ accountId: 'acc', file: pdfFile(), pending: true })).toBe(false);   // no double submit
    expect(canSubmitImport({ accountId: 'acc', file: pdfFile(), pending: false })).toBe(true);
    expect(canSubmitImport({ accountId: 'acc', file: pdfFile(MAX_STATEMENT_BYTES), pending: false })).toBe(true);
  });
  it('validation codes map to the agreed messages', () => {
    const code = (f: Parameters<typeof validateStatementFile>[0]) => { try { validateStatementFile(f); return 'OK'; } catch (e) { return (e as TargetDbError).code; } };
    expect(code(null)).toBe('FILE_REQUIRED');
    expect(code(pdfFile(MAX_STATEMENT_BYTES + 1))).toBe('FILE_TOO_LARGE');
    expect(code(pdfFile(0))).toBe('EMPTY_FILE');
    expect(code(pdfFile(5, 'a.txt', 'text/plain'))).toBe('NOT_A_PDF');
    expect(code(pdfFile(5, 'a.PDF', ''))).toBe('OK');
    expect(errorMessage(new TargetDbError('FILE_TOO_LARGE', ''))).toBe('El archivo supera el límite permitido de 10 MB.');
    expect(errorMessage(new TargetDbError('NOT_A_PDF', ''))).toBe('El archivo seleccionado no es un PDF válido.');
  });
});

describe('ADR-018 Edge invocation contract (real supabase-js request)', () => {
  it('upload sends exactly multipart financial_account_id + one file to fin-statement-import (POST, apikey + bearer)', async () => {
    const { client, seen } = harness({ [`/functions/v1/${IMPORT_FUNCTION}`]: json(200, result()) });
    const r = await importStatement(client, { accountId: 'acc-bna', file: pdfFile() });
    expect(r.status).toBe('PARSED');
    expect(seen).toHaveLength(1);
    const req = seen[0];
    expect([req.url.pathname, req.method]).toEqual([`/functions/v1/${IMPORT_FUNCTION}`, 'POST']);
    expect(req.headers.get('apikey')).toBe('anon-key');
    expect(req.headers.get('authorization')).toMatch(/^Bearer /);
    expect(req.headers.get('content-type')).toBeNull();   // the runtime sets the multipart boundary
    expect(req.body).toBeInstanceOf(FormData);
    const form = req.body as FormData;
    expect([...form.keys()].sort()).toEqual(['file', 'financial_account_id']);
    expect(form.get('financial_account_id')).toBe('acc-bna');
    expect(form.getAll('file')).toHaveLength(1);
    expect((form.get('file') as File).name).toBe('extracto.pdf');
  });
  it('an invalid file or a missing account never reaches the network', async () => {
    const { client, seen } = harness({});
    await expect(importStatement(client, { accountId: 'acc', file: pdfFile(MAX_STATEMENT_BYTES + 1) })).rejects.toMatchObject({ code: 'FILE_TOO_LARGE' });
    await expect(importStatement(client, { accountId: '', file: pdfFile() })).rejects.toMatchObject({ code: 'ACCOUNT_REQUIRED' });
    expect(seen).toHaveLength(0);
  });
  it('PARSED, replayed and REJECTED responses are returned as sent', async () => {
    for (const body of [result(), result({ replayed: true }),
      result({ status: 'REJECTED', reject_reason: 'ACCOUNT_MISMATCH: CBU', counters: { rows_total: 0, lines_new: 0, lines_known: 0, rows_ignored: 0, rows_invalid: 0, rows_captured: 0 } })]) {
      const { client } = harness({ [`/functions/v1/${IMPORT_FUNCTION}`]: json(200, body) });
      expect(await importStatement(client, { accountId: 'acc-bna', file: pdfFile() })).toEqual(body);
    }
  });
  it('request / auth / config errors surface the Edge code and its message', async () => {
    const cases: [number, unknown, string][] = [
      [403, { error: 'ADMIN_REQUIRED' }, 'ADMIN_REQUIRED'],
      [422, { error: 'STATEMENT_CONFIG_MISSING' }, 'STATEMENT_CONFIG_MISSING'],
      [415, { error: 'NOT_A_PDF' }, 'NOT_A_PDF'],
      [401, { msg: 'Invalid JWT' }, 'NOT_AUTHENTICATED'],
      [500, { error: 'INTERNAL' }, 'INTERNAL'],
      [502, 'gateway', 'IMPORT_FAILED'],
    ];
    for (const [status, body, code] of cases) {
      const { client } = harness({ [`/functions/v1/${IMPORT_FUNCTION}`]: json(status, body) });
      const err = await importStatement(client, { accountId: 'acc', file: pdfFile() }).catch((e) => e);
      expect(err).toBeInstanceOf(TargetDbError);
      expect(err.code, String(status)).toBe(code);
      expect(errorMessage(err)).not.toMatch(/Invalid JWT|gateway/);
    }
  });
  it('reprocess sends only {action, previous_run_id} as JSON; no account / path / hash / format override', async () => {
    const { client, seen } = harness({ [`/functions/v1/${IMPORT_FUNCTION}`]: json(200, result({ run_id: 'r-2' })) });
    await reprocessRun(client, 'run-rejected');
    expect(seen[0].method).toBe('POST');
    expect(seen[0].headers.get('content-type')).toBe('application/json');
    expect(JSON.parse(String(seen[0].body))).toEqual({ action: 'reprocess', previous_run_id: 'run-rejected' });
  });
});

describe('ADR-018 reads: accounts and history', () => {
  it('accounts: active configs → active BANK_ACCOUNT ids; only id and name requested (no CBU / account number)', async () => {
    const { client, seen } = harness({
      '/rest/v1/fin_statement_account_config': json(200, [{ financial_account_id: 'acc-bna' }, { financial_account_id: 'acc-pat' }]),
      '/rest/v1/financial_account': json(200, [{ id: 'acc-bna', nombre: 'BNA' }, { id: 'acc-pat', nombre: 'Patagonia' }]),
    });
    expect(await listStatementAccounts(client)).toEqual([{ id: 'acc-bna', nombre: 'BNA' }, { id: 'acc-pat', nombre: 'Patagonia' }]);
    const [cfg, acc] = seen.map((s) => s.url.searchParams);
    expect(cfg.get('select')).toBe('financial_account_id');
    expect(cfg.get('activo')).toBe('eq.true');
    expect(acc.get('select')).toBe('id,nombre');
    expect([acc.get('activo'), acc.get('account_type'), acc.get('id')]).toEqual(['eq.true', 'eq.BANK_ACCOUNT', 'in.(acc-bna,acc-pat)']);
  });
  it('history: BANK_STATEMENT runs, created_at DESC, bounded; storage path / format never requested', async () => {
    const { client, seen } = harness({ '/rest/v1/fin_import_run': json(200, [
      { ...run({ id: 'b', created_at: '2026-10-11T12:00:00+00:00', status: 'PARSED' }), financial_account: { nombre: 'BNA' } },
      { ...run({ id: 'a' }), financial_account: null },
    ]) });
    const rows = await listImportRuns(client);
    expect(rows.map((r) => [r.id, r.cuenta, r.status])).toEqual([['b', 'BNA', 'PARSED'], ['a', '—', 'REJECTED']]);
    const q = seen[0].url.searchParams;
    expect([q.get('source_kind'), q.get('order'), q.get('limit')]).toEqual(['eq.BANK_STATEMENT', 'created_at.desc,id.desc', '50']);
    expect(q.get('select')).not.toMatch(/storage_path|format_code|source_meta|created_by/);
  });
  it('Reprocesar only for the latest REJECTED bank attempt of a file', () => {
    const rejected = run({ id: 'r1' });
    expect(canReprocess(rejected, [rejected])).toBe(true);
    expect(canReprocess(run({ id: 'p', status: 'PARSED' }), [])).toBe(false);
    expect(canReprocess(run({ id: 'm', source_kind: 'MP_RELEASE_REPORT' }), [])).toBe(false);
    const later = run({ id: 'r2', created_at: '2026-10-11T11:00:00+00:00', previous_run_id: 'r1', status: 'PARSED' });
    expect(canReprocess(rejected, [later, rejected])).toBe(false);
    const otherFile = run({ id: 'r3', created_at: '2026-10-11T11:00:00+00:00', file_sha256: 'h2' });
    expect(canReprocess(rejected, [otherFile, rejected])).toBe(true);
  });
});

describe('ADR-018 rejection messages', () => {
  it('known codes → agreed Spanish text; only the code is extracted; unknown → fallback', () => {
    const expected: Record<string, string> = {
      NOT_A_PDF: 'El archivo seleccionado no es un PDF válido.',
      INVALID_PDF: 'El PDF está dañado o no puede leerse.',
      FILE_TOO_LARGE: 'El archivo supera el límite permitido de 10 MB.',
      TOO_MANY_PAGES: 'El extracto tiene más páginas de las admitidas.',
      EXTRACTION_TIMEOUT: 'El PDF tardó demasiado en procesarse.',
      TEXT_NOT_EXTRACTABLE: 'No se pudo extraer texto del PDF.',
      FORMAT_NOT_RECOGNISED: 'El archivo no corresponde al formato esperado para esta cuenta.',
      ACCOUNT_MISMATCH: 'Los datos del extracto no coinciden con la cuenta seleccionada.',
      UNSUPPORTED_STRUCTURE: 'El banco cambió el formato del extracto o el archivo tiene una estructura no compatible.',
      UNCLASSIFIABLE_ROW: 'Hay una fila del extracto que no puede clasificarse de forma segura.',
      REISSUE_SUSPECTED: 'El extracto parece ser una reemisión con diferencias respecto de uno ya importado.',
      DUPLICATE_CONTENT_IN_STATEMENT: 'El extracto contiene movimientos duplicados que no pueden resolverse automáticamente.',
    };
    for (const [code, text] of Object.entries(expected)) expect(rejectMessage(`${code}: some detail`)).toBe(text);
    expect(rejectCode('ACCOUNT_MISMATCH: CBU')).toBe('ACCOUNT_MISMATCH');
    expect(rejectMessage('BALANCE_CHAIN_MISMATCH: row 4')).toBe('No se pudo procesar el extracto.');
    expect(rejectMessage(null)).toBe('No se pudo procesar el extracto.');
  });
});
