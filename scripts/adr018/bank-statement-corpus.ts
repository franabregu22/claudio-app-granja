/**
 * ADR-018 — PRODUCTION parser regression over the real local corpus (never versioned; K-3). Deno.
 *
 * Runs supabase/functions/_shared/bank-statement (pinned npm:unpdf@1.8.1) on the given statements and checks what
 * fin_import_bank_statement would check, plus cross-statement properties:
 *   counts, balance chains (opening + Σ = every printed balance, last = closing), TRANSPORTE, coverage,
 *   continuity (closing → next opening), re-download parity (same period ⇒ identical fingerprints),
 *   Patagonia transfer-detail association, JS reference ↔ PostgreSQL fin_norm_description / fin_statement_fingerprint,
 *   and optionally field-for-field equality with a frozen oracle (G-1 / G-2 analysis JSON).
 * Expected identifiers are read from fin_statement_account_config in the local target database.
 *
 *   TEST_DATABASE_URL="postgresql://postgres:postgres@127.0.0.1:54322/postgres" deno run --node-modules-dir=none \
 *     --allow-read --allow-env --allow-run=docker scripts/adr018/bank-statement-corpus.ts \
 *     --bna <dir|file> … --patagonia <dir|file> … [--oracle-bna <json>] [--oracle-patagonia <json>] \
 *     [--expect-bna-lines 314] [--expect-patagonia-lines 6]
 */
import {
  type ControlRow, type EconomicRow, type FormatCode, type ParsedStatement, parseStatementPdf, type StatementAccountConfig,
} from '../../supabase/functions/_shared/bank-statement/index.ts';
import { referenceFingerprint, referenceNormDescription } from '../../supabase/functions/_shared/bank-statement/normalize.ts';

const args = Deno.args;
const multi = (n: string) => args.flatMap((a, i) => (a === `--${n}` ? [args[i + 1]] : []));
const opt = (n: string) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : undefined; };

// local test database only (same rule as scripts/test-env/guard.mjs)
const url = new URL(Deno.env.get('TEST_DATABASE_URL') ?? 'postgresql://x@invalid:1/x');
if (!['127.0.0.1', 'localhost'].includes(url.hostname) || url.port !== '54322') { console.error('  TEST_DATABASE_URL must be the local test database'); Deno.exit(2); }
const run = async (cmd: string[], input?: string) => {
  const p = new Deno.Command('docker', { args: cmd, stdin: input ? 'piped' : 'null', stdout: 'piped', stderr: 'piped' }).spawn();
  if (input) { const w = p.stdin.getWriter(); await w.write(new TextEncoder().encode(input)); await w.close(); }
  const o = await p.output();
  return { ok: o.success, out: new TextDecoder().decode(o.stdout).trim(), err: new TextDecoder().decode(o.stderr) };
};
const container = (await run(['ps', '--filter', 'name=supabase_db', '--format', '{{.Names}}'])).out.split('\n').filter(Boolean)[0];
if (!container || !(await run(['port', container, '5432/tcp'])).out.includes(':54322')) { console.error('  no local supabase_db container'); Deno.exit(2); }
const psql = async (sql: string) => {
  const r = await run(['exec', '-i', container, 'psql', '-U', 'postgres', '-d', 'postgres', '-t', '-A', '-q', '-v', 'ON_ERROR_STOP=1', '-f', '-'], sql);
  if (!r.ok) throw new Error(r.err);
  return r.out;
};
const configs: StatementAccountConfig[] = JSON.parse(await psql(`SELECT coalesce(json_agg(json_build_object('format_code', format_code,
  'expected_account_number', expected_account_number, 'expected_cbu', expected_cbu, 'expected_extra', expected_extra)), '[]')
  FROM fin_statement_account_config WHERE activo;`));
const CFG = new Map(configs.map((c) => [c.format_code, c]));

let pass = 0; let fail = 0;
const check = (label: string, ok: boolean, detail?: unknown) => {
  if (ok) { pass += 1; console.log(`    OK   ${label}`); } else { fail += 1; console.log(`    MAL  ${label}${detail !== undefined ? ` :: ${detail}` : ''}`); }
};
const files = (inputs: string[]) => inputs.flatMap((p) => {
  if (Deno.statSync(p).isDirectory) return [...Deno.readDirSync(p)].filter((e) => e.isFile && e.name.toLowerCase().endsWith('.pdf')).map((e) => `${p}/${e.name}`).sort();
  return [p];
});
const cents = (c: string) => BigInt(c.replace('.', ''));
const fromCents = (n: bigint) => { const neg = n < 0n; const a = (neg ? -n : n).toString().padStart(3, '0'); return `${neg ? '-' : ''}${a.slice(0, -2)}.${a.slice(-2)}`; };
const last2 = (p: string) => p.replace(/\\/g, '/').split('/').slice(-2).join('/');
const num = (v: unknown) => (v === null || v === undefined ? '' : Number(v).toFixed(2));

type Done = { file: string; sha: string; ms: number; st: ParsedStatement; lines: (EconomicRow & { fp: string; norm: string })[] };
console.log(`  production parser on Deno ${Deno.version.deno}; container ${container}`);

for (const [format, inputs, label, expectLines, oraclePath] of [
  ['BNA_MONTHLY_PDF_V1', multi('bna'), 'BNA', opt('expect-bna-lines'), opt('oracle-bna')],
  ['PATAGONIA_STATEMENT_PDF_V1', multi('patagonia'), 'PATAGONIA', opt('expect-patagonia-lines'), opt('oracle-patagonia')],
] as [FormatCode, string[], string, string | undefined, string | undefined][]) {
  if (!inputs.length) continue;
  console.log(`\n  ── ${label} (${format}) ──`);
  const cfg = CFG.get(format);
  check(`${label} configuration from fin_statement_account_config`, !!cfg);
  if (!cfg) continue;
  const done: Done[] = []; const errors: string[] = [];
  for (const f of files(inputs)) {
    const bytes = Deno.readFileSync(f);
    const sha = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))).map((b) => b.toString(16).padStart(2, '0')).join('');
    const t0 = performance.now();
    const r = await parseStatementPdf(bytes, cfg);
    const ms = performance.now() - t0;
    if (!r.ok) { errors.push(`${last2(f)}: ${r.reject_reason}`); continue; }
    const lines = [];
    for (const l of r.statement.rows.filter((x): x is EconomicRow => x.kind === 'ECONOMIC')) {
      lines.push({ ...l, norm: referenceNormDescription(l.description_raw), fp: await referenceFingerprint(format, l) });
    }
    done.push({ file: f, sha, ms, st: r.statement, lines });
  }
  check(`${label} every file parsed by the production parser (${done.length}/${done.length + errors.length})`, errors.length === 0, errors.join(' | '));

  // per-statement content rules (what the database re-validates)
  const chainErr: string[] = [];
  for (const d of done) {
    let bal = cents(d.st.source_meta.opening_balance);
    let idx = 0;
    for (const r of d.st.rows) {
      if (r.kind === 'ECONOMIC') {
        bal += cents(r.signed_amount); idx += 1;
        if (r.running_balance !== null && fromCents(bal) !== r.running_balance) chainErr.push(`${last2(d.file)} line ${idx}`);
        if (r.value_date > d.st.coverage_to || (d.st.coverage_from !== null && r.value_date <= d.st.coverage_from)) chainErr.push(`${last2(d.file)} coverage ${r.value_date}`);
      } else if (r.kind === 'CONTROL' && (r as ControlRow).control_type === 'TRANSPORTE' && (r as ControlRow).balance !== fromCents(bal)) {
        chainErr.push(`${last2(d.file)} TRANSPORTE`);
      }
    }
    if (fromCents(bal) !== d.st.source_meta.closing_balance) chainErr.push(`${last2(d.file)} closing`);
  }
  check(`${label} balance chains, TRANSPORTE, closing and coverage exact`, chainErr.length === 0, chainErr.slice(0, 5).join(' | '));

  const key = (d: Done) => `${d.st.coverage_from}|${d.st.coverage_to}`;
  const unique = [...new Map(done.map((d) => [key(d), d])).values()].sort((a, b) => (a.st.coverage_to < b.st.coverage_to ? -1 : 1));
  const total = unique.reduce((n, d) => n + d.lines.length, 0);
  check(`${label} economic lines across unique statements = ${expectLines ?? total}`, expectLines === undefined || total === Number(expectLines), total);
  const gaps: string[] = [];
  for (let i = 1; i < unique.length; i += 1) {
    const a = unique[i - 1].st; const b = unique[i].st;
    if (a.source_meta.closing_balance !== b.source_meta.opening_balance || a.coverage_to !== b.coverage_from) gaps.push(`${a.coverage_to}: ${a.source_meta.closing_balance} → ${b.source_meta.opening_balance}`);
  }
  check(`${label} continuity over ${unique.length} periods`, gaps.length === 0, gaps.join(' | '));
  console.log(`         chain: ${unique[0]?.st.source_meta.opening_balance} → ${unique.map((d) => d.st.source_meta.closing_balance).join(' → ')}`);
  const groups = new Map<string, Done[]>();
  for (const d of done) groups.set(key(d), [...(groups.get(key(d)) ?? []), d]);
  const red = [...groups.values()].filter((g) => g.length > 1);
  const redDiff = red.flatMap((g) => g.slice(1).filter((d) => d.lines.map((l) => l.fp).join() !== g[0].lines.map((l) => l.fp).join()).map((d) => last2(d.file)));
  check(`${label} re-download parity: ${red.reduce((n, g) => n + g.length - 1, 0)} copies in ${red.length} periods (${new Set(done.map((d) => d.sha)).size} distinct byte streams)`, redDiff.length === 0, redDiff.join(' | '));
  const all = unique.flatMap((d) => d.lines);
  check(`${label} no duplicate fingerprint across unique statements`, all.length === new Set(all.map((l) => l.fp)).size);

  // JS reference ↔ PostgreSQL (the production authority)
  const hex = (s: string) => Array.from(new TextEncoder().encode(s)).map((b) => b.toString(16).padStart(2, '0')).join('');
  const values = all.map((l, i) => `(${i}, convert_from(decode('${hex(l.description_raw)}', 'hex'), 'UTF8'), '${l.value_date}'::date, '${l.bank_reference.replace(/'/g, "''")}',
    ${l.fecha_valor ? `'${l.fecha_valor}'::date` : 'NULL::date'}, ${l.signed_amount}::numeric, ${l.running_balance === null ? 'NULL::numeric' : `${l.running_balance}::numeric`})`).join(',\n');
  const pg = (await psql(`SELECT string_agg(i || '|' || encode(convert_to(n, 'UTF8'), 'hex') || '|' || fin_statement_fingerprint('${format}', d, n, r, fv, a, b), E'\\n' ORDER BY i)
    FROM (SELECT i, fin_norm_description(raw) n, d, r, fv, a, b FROM (VALUES ${values}) v(i, raw, d, r, fv, a, b)) x;`)).split('\n');
  const pgBad = pg.filter((row) => { const [i, nh, fp] = row.split('|'); const l = all[Number(i)]; return hex(l.norm) !== nh || l.fp !== fp; });
  check(`${label} JS ↔ PostgreSQL description_norm + fingerprint byte-for-byte (${all.length} lines)`, pgBad.length === 0, pgBad.slice(0, 3).join(' | '));

  if (format === 'PATAGONIA_STATEMENT_PDF_V1') {
    const details = unique.flatMap((d) => d.st.rows.filter((r) => r.kind === 'DETAIL'));
    const matched = details.filter((d) => d.appearance_meta.detail_of_row !== undefined && !d.review_code);
    check(`${label} transfer details: ${matched.length} matched, ${details.length - matched.length} TRANSFER_DETAIL_UNMATCHED, none creating a line`,
      details.length > 0 && unique.every((d) => d.st.rows.filter((r) => r.kind === 'DETAIL').every((dt) => {
        const target = d.st.rows.find((r) => r.row_number === dt.appearance_meta.detail_of_row);
        return dt.review_code === 'TRANSFER_DETAIL_UNMATCHED' || (target?.kind === 'ECONOMIC' && target.signed_amount === dt.appearance_meta.transfer_detail?.imp_original);
      })));
  }
  if (oraclePath) {
    const oracle: { file: string; lines: Record<string, unknown>[] }[] = JSON.parse(await Deno.readTextFile(oraclePath));
    const byKey = new Map(oracle.map((o) => [last2(o.file), o]));
    const diffs: string[] = []; let compared = 0;
    const k = (l: Record<string, unknown>) => [l.value_date, l.description_raw, l.bank_reference, num(l.signed_amount), num(l.running_balance), l.fecha_valor ?? ''].join('|');
    for (const d of done) {
      const o = byKey.get(last2(d.file)) ?? byKey.get(d.file.replace(/\\/g, '/').split('/').pop() as string);
      if (!o) { diffs.push(`no oracle for ${last2(d.file)}`); continue; }
      compared += d.lines.length;
      const got = d.lines.map((l) => k(l as unknown as Record<string, unknown>)); const want = o.lines.map(k);
      if (got.join('\n') !== want.join('\n')) diffs.push(`${last2(d.file)}: ${got.length} vs ${want.length} lines or field difference`);
    }
    check(`${label} field-for-field equal to the frozen oracle incl. description_raw (${compared} lines incl. re-downloads)`, diffs.length === 0, diffs.slice(0, 5).join(' | '));
  }
  const ms = done.map((d) => d.ms);
  console.log(`         parse (extract + adapter) max ${Math.max(...ms).toFixed(0)} ms over ${done.length} files`);
}
console.log(`\n  ══ ADR-018 PRODUCTION PARSER CORPUS: ${pass} passed, ${fail} failed ══\n`);
Deno.exit(fail === 0 ? 0 : 1);
