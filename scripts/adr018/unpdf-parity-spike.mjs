#!/usr/bin/env node
/**
 * ADR-018 §7.5 — unpdf PARITY SPIKE (gate before the production bank-statement parsers). LOCAL ONLY.
 *
 * Extracts real official statements with unpdf (PDF.js text content: string, transform, width — no OCR),
 * reconstructs rows / columns deterministically and applies the frozen adapter contracts
 * BNA_MONTHLY_PDF_V1 (§7.2) and PATAGONIA_STATEMENT_PDF_V1 (§7.3). It then checks:
 *   - per statement: detection signals, expected identifiers (read from fin_statement_account_config in the local
 *     target database — never hard-coded), balance chains, period bounds, control rows;
 *   - across statements: closing → next opening continuity, re-download parity (same period, different bytes ⇒
 *     identical fingerprints);
 *   - normalization / fingerprint parity: the non-authoritative JS reference vs PostgreSQL fin_norm_description /
 *     fin_statement_fingerprint, byte for byte;
 *   - optionally, field-for-field equality with a frozen oracle (JSON produced by the G-1 / G-2 analysis);
 *   - fail-closed behaviour (truncated / non-PDF / over limits / unrecognised / wrong adapter).
 *
 * Real PDFs are read from the given directories only; nothing is copied or written into the repository.
 * The unpdf package is loaded from --unpdf (an isolated install), so the repository's runtime is untouched.
 *
 * Usage:
 *   TEST_DATABASE_URL="postgresql://postgres:postgres@127.0.0.1:54322/postgres" \
 *   node scripts/adr018/unpdf-parity-spike.mjs --unpdf <dir containing node_modules/unpdf> \
 *     --bna <dir-or-file> [--bna <...>] --patagonia <dir-or-file> [--patagonia <...>] \
 *     [--oracle-bna <json>] [--oracle-patagonia <json>] [--expect-bna-lines 314] [--expect-patagonia-lines 6] \
 *     [--failure-samples <non-statement pdf>] [--report <json out>]
 */

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { assertTestTarget } from '../test-env/guard.mjs';

// ── arguments ────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const opt = (name) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : undefined; };
const multi = (name) => args.flatMap((a, i) => (a === `--${name}` ? [args[i + 1]] : []));
const UNPDF_DIR = opt('unpdf');
if (!UNPDF_DIR) { console.error('  --unpdf <dir> is required (an isolated install of the pinned unpdf)'); process.exit(2); }
const LIMITS = { maxBytes: 10 * 1024 * 1024, maxPages: 20, timeoutMs: 10_000 };   // ADR-018 §7.5 initial operational limits

const { getDocumentProxy, getResolvedPDFJS } = await import(pathToFileURL(resolve(UNPDF_DIR, 'node_modules', 'unpdf', 'dist', 'index.mjs')).href);
const UNPDF_VERSION = JSON.parse(readFileSync(resolve(UNPDF_DIR, 'node_modules', 'unpdf', 'package.json'), 'utf8')).version;

const pdfFiles = (inputs) => inputs.flatMap((p) => (statSync(p).isDirectory()
  ? readdirSync(p).filter((f) => f.toLowerCase().endsWith('.pdf')).sort().map((f) => join(p, f)) : [p]));

// ── canonical helpers (ADR-018 §7.1; the JS norm is a non-authoritative reference) ─
const AMOUNT = /^\$?(\d{1,3}(?:\.\d{3})*,\d{2})(-?)$/;
const toCanonical = (s) => {
  const m = AMOUNT.exec(s);
  if (!m) return null;
  const v = m[1].replace(/\./g, '').replace(',', '.');
  return (m[2] === '-' && Number(v) !== 0 ? '-' : '') + v.replace(/^0+(?=\d)/, '');
};
const cents = (c) => BigInt(c.replace('.', ''));
const fromCents = (n) => { const neg = n < 0n; const a = (neg ? -n : n).toString().padStart(3, '0'); return `${neg ? '-' : ''}${a.slice(0, -2)}.${a.slice(-2)}`; };
function jsNorm(s) {
  const v = s.normalize('NFKD');
  if (/[\x00-\x08\x0E-\x1F\x7F]/.test(v)) throw new Error('DESCRIPTION_CONTROL_CHAR');
  return v.replace(/[^\x00-\x7F]/g, '').replace(/[a-z]/g, (c) => c.toUpperCase()).replace(/[\t\n\v\f\r ]+/g, ' ').replace(/^ +| +$/g, '');
}
function jsFingerprint(format, l) {
  const parts = format === 'BNA_MONTHLY_PDF_V1'
    ? [l.value_date, l.description_norm, l.bank_reference, l.signed_amount, l.running_balance]
    : [l.value_date, l.description_norm, l.bank_reference, l.fecha_valor ?? '', l.signed_amount, l.running_balance ?? ''];
  return createHash('sha256').update(parts.join('\x1f'), 'utf8').digest('hex');
}
const iso = (d) => { const [dd, mm, yy] = d.split('/'); return `${yy.length === 2 ? `20${yy}` : yy}-${mm}-${dd.padStart(2, '0')}`; };

// ── extraction: unpdf → words with positions → rows ─────────────────────────
class Reject extends Error { constructor(code, detail = '') { super(`${code}${detail ? `: ${detail}` : ''}`); this.code = code; } }

async function extract(bytes) {
  if (bytes.length > LIMITS.maxBytes) throw new Reject('FILE_TOO_LARGE', String(bytes.length));
  if (Buffer.from(bytes.subarray(0, 5)).toString('latin1') !== '%PDF-') throw new Reject('NOT_A_PDF');
  const t0 = performance.now();
  const work = (async () => {
    const doc = await getDocumentProxy(new Uint8Array(bytes));
    if (doc.numPages > LIMITS.maxPages) throw new Reject('TOO_MANY_PAGES', String(doc.numPages));
    const pages = [];
    for (let n = 1; n <= doc.numPages; n += 1) {
      const page = await doc.getPage(n);
      const vp = page.getViewport({ scale: 1 });
      const tc = await page.getTextContent();
      const items = tc.items.filter((it) => 'str' in it && it.str.trim() !== '')
        .map((it) => ({ str: it.str, x: it.transform[4], top: vp.height - it.transform[5], w: it.width }));
      pages.push({ n, items });
    }
    return pages;
  })();
  let timer;
  const timeout = new Promise((_, rej) => { timer = setTimeout(() => rej(new Reject('EXTRACTION_TIMEOUT')), LIMITS.timeoutMs); });
  try {
    const pages = await Promise.race([work, timeout]);
    if (pages.every((p) => p.items.length === 0)) throw new Reject('TEXT_NOT_EXTRACTABLE');
    return { pages, extractMs: performance.now() - t0 };
  } catch (e) {
    if (e instanceof Reject) throw e;
    throw new Reject('INVALID_PDF', e.message.slice(0, 120));
  } finally { clearTimeout(timer); }
}

// split each text item into words; both banks print in a monospaced font, so a word's box is its character span
// times the item's own advance per character (width / length) — deterministic and independent of the file
function rowsOf(page) {
  const words = [];
  for (const it of page.items) {
    const cw = it.w / it.str.length;
    for (const m of it.str.matchAll(/\S+/g)) {
      words.push({ text: m[0], x0: it.x + m.index * cw, x1: it.x + (m.index + m[0].length) * cw, top: it.top });
    }
  }
  words.sort((a, b) => a.top - b.top || a.x0 - b.x0);
  const rows = [];
  for (const w of words) {
    const r = rows.length ? rows[rows.length - 1] : null;
    if (r && Math.abs(w.top - r.top) <= 1.5) r.words.push(w); else rows.push({ top: w.top, words: [w] });
  }
  for (const r of rows) { r.words.sort((a, b) => a.x0 - b.x0); r.text = r.words.map((w) => w.text).join(' '); }
  return rows;
}
const nearest = (x1, cols) => cols.reduce((best, c) => (Math.abs(x1 - c.x1) < Math.abs(x1 - best.x1) ? c : best));
const findHeader = (rows, names) => {
  for (const r of rows) {
    const idx = []; let k = 0;
    for (const w of r.words) if (k < names.length && w.text === names[k]) { idx.push(w); k += 1; }
    if (k === names.length) return { row: r, cols: idx };
  }
  return null;
};

// ── BNA_MONTHLY_PDF_V1 (§7.2) ────────────────────────────────────────────────
function parseBna(pages, cfg) {
  const allRows = pages.map((p) => ({ page: p.n, rows: rowsOf(p) }));
  const text = allRows.flatMap((p) => p.rows.map((r) => r.text)).join('\n');
  for (const sig of ['BANCO DE LA', 'NACION ARGENTINA', 'RESUMEN DE CUENTA', 'CUENTA CORRIENTE - PESOS', '<--- FIN DE RESUMEN']) {
    if (!text.includes(sig)) throw new Reject('FORMAT_NOT_RECOGNISED', `missing ${sig}`);
  }
  const per = /PERIODO: (\d{2}\/\d{2}\/\d{4}) AL (\d{2}\/\d{2}\/\d{4})/.exec(text);
  if (!per) throw new Reject('FORMAT_NOT_RECOGNISED', 'PERIODO');
  const cbus = [...new Set(text.match(/\b\d{22}\b/g) || [])];
  if (cbus.length !== 1 || cbus[0] !== cfg.expected_cbu) throw new Reject('ACCOUNT_MISMATCH', 'CBU');
  if (!new RegExp(`\\b${cfg.expected_account_number}\\b`).test(text)) throw new Reject('ACCOUNT_MISMATCH', 'account number');
  const from = iso(per[1]); const to = iso(per[2]);
  let opening = null; let closing = null; const lines = []; const controls = []; const transports = [];
  let headerPages = 0;
  // the economic table ends at SALDO FINAL; what follows is the statement totals block (TOTAL … lines and their
  // continuation lines, e.g. "- INTERESES $ …", "REINTEGRO GRAV. LEY 25413 …") — control, never economic
  let totalsBlock = false;
  for (const { page, rows } of allRows) {
    const h = findHeader(rows, ['FECHA', 'MOVIMIENTOS', 'COMPROB.', 'DEBITOS', 'CREDITOS', 'SALDO']);
    if (!h) continue;
    headerPages += 1;
    const [, MOV, COMP, DEB, CRED, SAL] = h.cols;
    const amountCols = [{ k: 'debit', x1: DEB.x1 }, { k: 'credit', x1: CRED.x1 }, { k: 'balance', x1: SAL.x1 }];
    for (const r of rows.filter((x) => x.top > h.row.top + 1)) {
      const w0 = r.words[0];
      const control = /^(SALDO ANTERIOR|SALDO FINAL|TRANSPORTE)\b/.exec(r.words.filter((w) => w.x0 < MOV.x1 + 60).map((w) => w.text).join(' '));
      const dateLed = /^\d{2}\/\d{2}\/\d{2}$/.test(w0.text) && w0.x1 < MOV.x0;
      if (totalsBlock) {
        if (dateLed) throw new Reject('UNCLASSIFIABLE_ROW', `economic-looking row after SALDO FINAL, page ${page}: ${r.text}`);
        if (r.words.some((w) => AMOUNT.test(w.text))) controls.push({ type: 'TOTALS_BLOCK', page });
        continue;
      }
      if (dateLed) {
        const desc = []; const comp = []; const amt = {}; const extra = [];
        for (const w of r.words.slice(1)) {
          if (w.text === '$') continue;
          if (AMOUNT.test(w.text) && w.x1 > COMP.x1 + 10) {
            const c = nearest(w.x1, amountCols).k;
            if (amt[c] !== undefined) extra.push(w.text); else amt[c] = toCanonical(w.text);
          } else if (w.x1 <= COMP.x1 + 10 && w.x1 > COMP.x0) comp.push(w.text);
          else if (w.x1 <= COMP.x0) desc.push(w.text);
          else extra.push(w.text);
        }
        if (extra.length || comp.length > 1 || amt.balance === undefined || (amt.debit === undefined) === (amt.credit === undefined)) {
          throw new Reject('UNCLASSIFIABLE_ROW', `page ${page}: ${r.text}`);
        }
        const signed = amt.credit !== undefined ? amt.credit : `-${amt.debit}`;
        if (/^-?0\.00$/.test(signed) || signed.startsWith('--')) throw new Reject('UNCLASSIFIABLE_ROW', `amount ${r.text}`);
        lines.push({ value_date: iso(w0.text), description_raw: desc.join(' '), bank_reference: comp.join(''), fecha_valor: null,
          signed_amount: signed, running_balance: amt.balance, page, statement_position: lines.length + 1 });
      } else if (control) {
        const a = r.words.filter((w) => AMOUNT.test(w.text)).map((w) => toCanonical(w.text));
        controls.push({ type: control[1], balance: a[a.length - 1] ?? null, page });
        if (control[1] === 'SALDO ANTERIOR') opening = a[a.length - 1];
        if (control[1] === 'SALDO FINAL') { closing = a[a.length - 1]; totalsBlock = true; }
        if (control[1] === 'TRANSPORTE') transports.push({ balance: a[a.length - 1], after: lines.length });
      } else if (/^TOTAL\b/.test(r.text)) {
        controls.push({ type: 'TOTAL', page });
      } else if (r.words.some((w) => AMOUNT.test(w.text) && w.x1 > COMP.x1 + 10)) {
        throw new Reject('UNCLASSIFIABLE_ROW', `page ${page}: ${r.text}`);
      }
    }
  }
  if (!headerPages) throw new Reject('FORMAT_NOT_RECOGNISED', 'column header');
  if (opening === null || closing === null) throw new Reject('FORMAT_NOT_RECOGNISED', 'SALDO ANTERIOR / SALDO FINAL');
  // chain, transports, period
  let bal = cents(opening);
  lines.forEach((l, i) => {
    bal += cents(l.signed_amount);
    if (fromCents(bal) !== l.running_balance) throw new Reject('BALANCE_CHAIN_MISMATCH', `line ${i + 1}`);
    if (!(l.value_date > from && l.value_date <= to)) throw new Reject('DATE_OUTSIDE_COVERAGE', l.value_date);
  });
  if (fromCents(bal) !== closing) throw new Reject('CLOSING_BALANCE_MISMATCH');
  for (const t of transports) {
    const at = t.after === 0 ? opening : lines[t.after - 1].running_balance;
    if (t.balance !== at) throw new Reject('TRANSPORTE_MISMATCH');
  }
  return { format: 'BNA_MONTHLY_PDF_V1', period: { from, to }, opening, closing, lines, controls, details: [] };
}

// ── PATAGONIA_STATEMENT_PDF_V1 (§7.3) ────────────────────────────────────────
function parsePatagonia(pages, cfg) {
  const allRows = pages.map((p) => ({ page: p.n, rows: rowsOf(p) }));
  const text = allRows.flatMap((p) => p.rows.map((r) => r.text)).join('\n');
  if (!/bancopatagonia/i.test(text)) throw new Reject('FORMAT_NOT_RECOGNISED', 'Banco Patagonia');
  const est = /ESTADO DE CUENTAS UNIFICADO CLIENTE N\S*: (\d+) AL (\d{2}\/\d{2}\/\d{2})/.exec(text);
  const acc = /CUENTA CORRIENTE EN PESOS (\d+) SUBCTA (\d+) SUC (\d+) CBU: (\d{8}) (\d{14})/.exec(text);
  if (!est || !acc) throw new Reject('FORMAT_NOT_RECOGNISED', 'header');
  const extra = cfg.expected_extra || {};
  if (acc[1] !== cfg.expected_account_number || acc[4] + acc[5] !== cfg.expected_cbu
      || (extra.subcta !== undefined && acc[2] !== extra.subcta) || (extra.suc !== undefined && acc[3] !== extra.suc)) {
    throw new Reject('ACCOUNT_MISMATCH');
  }
  const accountSections = (text.match(/CUENTA CORRIENTE EN PESOS \d+/g) || []).length;
  if (accountSections !== 1) throw new Reject('UNSUPPORTED_STRUCTURE', 'account sections');
  let opening = null; let openingDate = null; let closing = null; const lines = []; const controls = []; const details = [];
  let movHeaders = 0;
  for (const { page, rows } of allRows) {
    const h = findHeader(rows, ['FECHA', 'CONCEPTO', 'REFER.', 'FECHA', 'VALOR', 'DEBITOS', 'CREDITOS', 'SALDO']);
    if (h) {
      movHeaders += 1;
      const [, CON, REF, FV, VAL, DEB, CRED, SAL] = h.cols;
      const amountCols = [{ k: 'debit', x1: DEB.x1 }, { k: 'credit', x1: CRED.x1 }, { k: 'balance', x1: SAL.x1 }];
      let ended = false;
      for (const r of rows.filter((x) => x.top > h.row.top + 1)) {
        if (ended) break;
        const w0 = r.words[0];
        if (!/^\d{1,2}\/\d{2}\/\d{2}$/.test(w0.text) || w0.x1 >= CON.x0) continue;
        const rest = r.words.slice(1);
        const label = rest.filter((w) => w.x1 < REF.x0).map((w) => w.text).join(' ');
        if (label === 'SALDO ANTERIOR' || label === 'SALDO ACTUAL') {
          const a = rest.filter((w) => AMOUNT.test(w.text)).map((w) => toCanonical(w.text));
          controls.push({ type: label, balance: a[a.length - 1] ?? null, page });
          if (label === 'SALDO ANTERIOR') { opening = a[a.length - 1]; openingDate = w0.text === '0/00/00' ? null : iso(w0.text); }
          else { closing = a[a.length - 1]; ended = true; }
          continue;
        }
        const desc = []; const ref = []; const fv = []; const amt = {}; const bad = [];
        for (const w of rest) {
          if (AMOUNT.test(w.text) && w.x0 > VAL.x1) {
            const c = nearest(w.x1, amountCols).k;
            if (amt[c] !== undefined) bad.push(w.text); else amt[c] = toCanonical(w.text);
          } else if (w.x1 < REF.x0) desc.push(w.text);
          else if (w.x0 >= REF.x0 - 2 && w.x1 < FV.x0) ref.push(w.text);
          else if (w.x0 >= FV.x0 - 5 && w.x1 <= VAL.x1 + 10 && /^\d{1,2}\/\d{2}\/\d{2}$/.test(w.text)) fv.push(w.text);
          else bad.push(w.text);
        }
        if (bad.length || fv.length > 1 || (amt.debit === undefined) === (amt.credit === undefined)) {
          throw new Reject('UNCLASSIFIABLE_ROW', `page ${page}: ${r.text}`);
        }
        lines.push({ value_date: iso(w0.text), description_raw: desc.join(' '), bank_reference: ref.join(' '),
          fecha_valor: fv.length ? iso(fv[0]) : null, signed_amount: amt.credit !== undefined ? amt.credit : `-${amt.debit}`,
          running_balance: amt.balance ?? null, page, statement_position: lines.length + 1 });
      }
      if (!ended) throw new Reject('UNSUPPORTED_STRUCTURE', 'movement table continues past the page');
    }
    const d = findHeader(rows, ['FECHA', 'NOMBRE', 'ORIG', 'DOC.ORIG.', 'SERVICIO', 'REFERENCIA', 'CBU', 'ORIGEN', 'BANCO', 'SUC', 'IMP.ORIGINAL']);
    if (d) {
      const [, NOM, , DOC, , , , , , , IMP] = d.cols;
      for (const r of rows.filter((x) => x.top > d.row.top + 1)) {
        const w0 = r.words[0];
        if (!/^\d{1,2}\/\d{2}\/\d{2}$/.test(w0.text) || w0.x1 >= NOM.x0) { if (r.words.length && /^_+$/.test(w0.text)) break; continue; }
        const imp = r.words.filter((w) => AMOUNT.test(w.text) && Math.abs(w.x1 - IMP.x1) < 15);
        details.push({ date: iso(w0.text), imp_original: imp.length === 1 ? toCanonical(imp[0].text) : null,
          nombre_orig: r.words.filter((w) => w.x0 >= NOM.x0 - 3 && w.x1 < DOC.x0).map((w) => w.text).join(' '), raw: r.text, page });
      }
    }
  }
  if (movHeaders !== 1) throw new Reject(movHeaders ? 'UNSUPPORTED_STRUCTURE' : 'FORMAT_NOT_RECOGNISED', 'movement header count');
  if (opening === null || closing === null) throw new Reject('FORMAT_NOT_RECOGNISED', 'SALDO ANTERIOR / SALDO ACTUAL');
  let bal = cents(opening);
  for (const l of lines) {
    bal += cents(l.signed_amount);
    if (l.running_balance !== null && fromCents(bal) !== l.running_balance) throw new Reject('BALANCE_CHAIN_MISMATCH');
  }
  if (fromCents(bal) !== closing) throw new Reject('CLOSING_BALANCE_MISMATCH');
  // TRANSFERENCIAS RECIBIDAS: same date, IMP.ORIGINAL = positive signed amount, exactly one candidate each way
  for (const d of details) {
    const cands = lines.filter((l) => l.value_date === d.date && d.imp_original !== null && l.signed_amount === d.imp_original);
    const rivals = details.filter((o) => o.date === d.date && o.imp_original === d.imp_original);
    d.association = cands.length === 1 && rivals.length === 1 ? 'MATCHED' : 'TRANSFER_DETAIL_UNMATCHED';
  }
  return { format: 'PATAGONIA_STATEMENT_PDF_V1', period: { from: openingDate, to: iso(est[2]) }, opening, closing, lines, controls, details };
}

// ── database: configuration and PostgreSQL parity ────────────────────────────
const target = assertTestTarget(process.env.TEST_DATABASE_URL);
const docker = (a, input) => spawnSync('docker', a, { encoding: 'utf8', input, maxBuffer: 64 * 1024 * 1024 });
const container = (docker(['ps', '--filter', 'name=supabase_db', '--format', '{{.Names}}']).stdout || '').trim().split('\n').filter(Boolean)[0];
if (!container || !(docker(['port', container, '5432/tcp']).stdout || '').includes(`:${target.port}`)) {
  console.error('  no local supabase_db container on the guarded port'); process.exit(2);
}
const psql = (sql) => {
  const r = docker(['exec', '-i', container, 'psql', '-U', 'postgres', '-d', 'postgres', '-t', '-A', '-q', '-v', 'ON_ERROR_STOP=1', '-f', '-'], sql);
  if (r.status !== 0) throw new Error(r.stderr);
  return r.stdout.trim();
};
const CONFIG = Object.fromEntries(JSON.parse(psql(`SELECT coalesce(json_agg(json_build_object('format', format_code,
  'expected_account_number', expected_account_number, 'expected_cbu', expected_cbu, 'expected_extra', expected_extra)), '[]')
  FROM fin_statement_account_config WHERE activo;`)).map((c) => [c.format, c]));
const PARSERS = { BNA_MONTHLY_PDF_V1: parseBna, PATAGONIA_STATEMENT_PDF_V1: parsePatagonia };

// ── run ──────────────────────────────────────────────────────────────────────
let pass = 0; let fail = 0;
const check = (label, ok, detail) => {
  if (ok) { pass += 1; console.log(`    OK   ${label}`); } else { fail += 1; console.log(`    MAL  ${label}${detail !== undefined ? ` :: ${detail}` : ''}`); }
};
const report = { unpdf: UNPDF_VERSION, pdfjs: (await getResolvedPDFJS()).version, node: process.version, limits: LIMITS, statements: [], failures: [] };

async function runSet(format, inputs) {
  const out = [];
  for (const f of pdfFiles(inputs)) {
    const bytes = readFileSync(f);
    const sha = createHash('sha256').update(bytes).digest('hex');
    try {
      const { pages, extractMs } = await extract(bytes);
      const t1 = performance.now();
      const st = PARSERS[format](pages, CONFIG[format]);
      const parseMs = performance.now() - t1;
      for (const l of st.lines) {
        l.description_norm = jsNorm(l.description_raw);
        l.fingerprint = jsFingerprint(format, l);
      }
      out.push({ file: f, name: basename(f), sha, bytes: bytes.length, pages: pages.length, extractMs, parseMs, ...st });
    } catch (e) {
      out.push({ file: f, name: basename(f), sha, bytes: bytes.length, error: e.code || 'ERROR', detail: e.message });
    }
  }
  return out;
}

function continuity(sts, keyFrom, keyTo) {
  const uniq = [...new Map(sts.map((s) => [`${s.period.from}|${s.period.to}`, s])).values()]
    .sort((a, b) => (a.period.to < b.period.to ? -1 : 1));
  const gaps = [];
  for (let i = 1; i < uniq.length; i += 1) {
    if (uniq[i - 1].closing !== uniq[i].opening || (keyFrom && uniq[i - 1].period.to !== uniq[i].period.from)) {
      gaps.push(`${uniq[i - 1].period.to}: ${uniq[i - 1].closing} → ${uniq[i].opening}`);
    }
  }
  return { periods: uniq.length, gaps, chain: uniq.map((s) => s.closing), first: uniq[0]?.opening };
}

function redownloads(sts) {
  const byPeriod = new Map();
  for (const s of sts) {
    const k = `${s.period.from}|${s.period.to}`;
    if (!byPeriod.has(k)) byPeriod.set(k, []);
    byPeriod.get(k).push(s);
  }
  let groups = 0; const diffs = [];
  for (const [k, list] of byPeriod) {
    if (list.length < 2) continue;
    groups += 1;
    const ref = list[0].lines.map((l) => l.fingerprint).join(',');
    for (const s of list.slice(1)) if (s.lines.map((l) => l.fingerprint).join(',') !== ref) diffs.push(`${k} ${s.name}`);
  }
  const distinctBytes = sts.length - new Set(sts.map((s) => s.sha)).size;
  return { groups, files: [...byPeriod.values()].filter((l) => l.length > 1).reduce((n, l) => n + l.length - 1, 0), diffs, sameBytesFiles: distinctBytes };
}

function pgParity(format, lines) {
  if (!lines.length) return { checked: 0, bad: [] };
  const vals = lines.map((l, i) => `(${i}, convert_from(decode('${Buffer.from(l.description_raw, 'utf8').toString('hex')}', 'hex'), 'UTF8'), '${l.value_date}'::date,
    '${l.bank_reference.replace(/'/g, "''")}', ${l.fecha_valor ? `'${l.fecha_valor}'::date` : 'NULL::date'}, ${l.signed_amount}::numeric, ${l.running_balance === null ? 'NULL::numeric' : `${l.running_balance}::numeric`})`).join(',\n');
  const out = psql(`SELECT string_agg(i || '|' || encode(convert_to(n, 'UTF8'), 'hex') || '|' || fin_statement_fingerprint('${format}', d, n, r, fv, a, b), E'\\n' ORDER BY i)
    FROM (SELECT i, fin_norm_description(raw) n, d, r, fv, a, b FROM (VALUES ${vals}) v(i, raw, d, r, fv, a, b)) x;`);
  const bad = [];
  for (const row of out.split('\n')) {
    const [i, nHex, fp] = row.split('|');
    const l = lines[Number(i)];
    if (Buffer.from(l.description_norm, 'utf8').toString('hex') !== nHex || l.fingerprint !== fp) bad.push(`${l.value_date} ${l.description_raw}`);
  }
  return { checked: lines.length, bad };
}

function oracleCompare(sts, oraclePath, keyOf) {
  const oracle = JSON.parse(readFileSync(oraclePath, 'utf8'));
  const last2 = (p) => p.replace(/\\/g, '/').split('/').slice(-2).join('/');   // folder + file: two folders hold "Estado de Cuenta (1).pdf"
  const byKey = new Map(oracle.map((o) => [last2(o.file), o]));
  const diffs = []; let compared = 0;
  for (const s of sts) {
    const o = byKey.get(last2(s.file)) ?? byKey.get(s.name);   // an oracle path may hold the file name only
    if (!o) { diffs.push(`no oracle for ${s.name}`); continue; }
    const want = o.lines.map(keyOf); const got = s.lines.map(keyOf);
    compared += got.length;
    if (want.length !== got.length) { diffs.push(`${s.name}: ${got.length} lines vs oracle ${want.length}`); continue; }
    want.forEach((w, i) => { if (w !== got[i]) diffs.push(`${s.name} #${i + 1}: ${got[i]} ≠ ${w}`); });
  }
  return { compared, diffs };
}
const num = (v) => (v === null || v === undefined ? '' : Number(v).toFixed(2));
const oracleKey = (l) => [l.value_date, jsNorm(l.description_raw), l.bank_reference, num(l.signed_amount), num(l.running_balance), l.fecha_valor ?? ''].join('|');

console.log(`  unpdf ${report.unpdf} (PDF.js ${report.pdfjs}) on Node ${report.node}; container ${container}`);
for (const [format, inputs, label, expectLines, oraclePath] of [
  ['BNA_MONTHLY_PDF_V1', multi('bna'), 'BNA', Number(opt('expect-bna-lines') ?? NaN), opt('oracle-bna')],
  ['PATAGONIA_STATEMENT_PDF_V1', multi('patagonia'), 'PATAGONIA', Number(opt('expect-patagonia-lines') ?? NaN), opt('oracle-patagonia')],
]) {
  if (!inputs.length) continue;
  console.log(`\n  ── ${label} (${format}) ──`);
  check(`${label} configuration present in fin_statement_account_config`, !!CONFIG[format]);
  const sts = await runSet(format, inputs);
  report.statements.push(...sts.map(({ file, lines, controls, details, ...rest }) => ({ ...rest, lines: lines?.length, controls: controls?.length, details })));
  const errors = sts.filter((s) => s.error);
  check(`${label} every statement parsed (${sts.length - errors.length}/${sts.length})`, errors.length === 0, errors.map((e) => `${e.name}: ${e.detail}`).join(' | '));
  const ok = sts.filter((s) => !s.error);
  const red = redownloads(ok);
  const unique = [...new Map(ok.map((s) => [`${s.period.from}|${s.period.to}`, s])).values()];
  const total = unique.reduce((n, s) => n + s.lines.length, 0);
  check(`${label} economic lines across unique statements = ${Number.isNaN(expectLines) ? total : expectLines}`, Number.isNaN(expectLines) || total === expectLines, total);
  const cont = continuity(ok, format === 'BNA_MONTHLY_PDF_V1' || true);
  check(`${label} continuity over ${cont.periods} periods (closing → next opening, period end → next start)`, cont.gaps.length === 0, cont.gaps.join(' | '));
  console.log(`         chain: ${cont.first} → ${cont.chain.join(' → ')}`);
  check(`${label} re-download parity: ${red.files} extra copies in ${red.groups} periods, identical fingerprints`, red.diffs.length === 0, red.diffs.join(' | '));
  const allLines = unique.flatMap((s) => s.lines);
  const fpDup = allLines.length - new Set(allLines.map((l) => l.fingerprint)).size;
  check(`${label} no duplicate fingerprint across unique statements`, fpDup === 0, fpDup);
  const pg = pgParity(format, allLines);
  check(`${label} JS ↔ PostgreSQL description_norm + fingerprint byte-for-byte (${pg.checked} lines)`, pg.bad.length === 0, pg.bad.slice(0, 3).join(' | '));
  if (oraclePath) {
    const oc = oracleCompare(ok, oraclePath, oracleKey);
    check(`${label} field-for-field equal to the frozen oracle (${oc.compared} lines incl. re-downloads)`, oc.diffs.length === 0, oc.diffs.slice(0, 5).join(' | '));
    const raw = oracleCompare(ok, oraclePath, (l) => l.description_raw);
    check(`${label} description_raw identical to the oracle, before normalization (${raw.compared} lines)`, raw.diffs.length === 0, raw.diffs.slice(0, 5).join(' | '));
  }
  if (format === 'PATAGONIA_STATEMENT_PDF_V1') {
    const det = unique.flatMap((s) => s.details);
    const lineKeys = new Set(allLines.map((l) => `${l.value_date}|${l.signed_amount}`));
    check(`${label} TRANSFERENCIAS RECIBIDAS never create economic lines (${det.length} details)`, total === allLines.length && det.every((d) => d.raw));
    check(`${label} detail association: ${det.filter((d) => d.association === 'MATCHED').length} matched, ${det.filter((d) => d.association !== 'MATCHED').length} warnings`,
      det.every((d) => d.association === 'MATCHED' ? lineKeys.has(`${d.date}|${d.imp_original}`) : true));
  }
  const ex = ok.map((s) => s.extractMs); const pa = ok.map((s) => s.parseMs);
  console.log(`         size max ${Math.max(...ok.map((s) => s.bytes))} B; pages max ${Math.max(...ok.map((s) => s.pages))}; extract max ${Math.max(...ex).toFixed(0)} ms; parse max ${Math.max(...pa).toFixed(1)} ms`);
  report[label] = { statements: sts.length, unique: unique.length, lines: total, continuity: cont, redownloads: red,
    maxBytes: Math.max(...ok.map((s) => s.bytes)), maxPages: Math.max(...ok.map((s) => s.pages)), maxExtractMs: Math.max(...ex), maxParseMs: Math.max(...pa) };
}

// ── synthetic fixtures (versioned; no real data): same reconstruction, known expected output ─────
for (const fxPath of multi('fixtures')) {
  console.log(`\n  ── synthetic fixtures ${basename(fxPath)} ──`);
  for (const fx of JSON.parse(readFileSync(fxPath, 'utf8')).fixtures) {
    try {
      const st = PARSERS[fx.format](fx.pages, fx.config);
      const pick = (l) => JSON.stringify([l.value_date, l.description_raw, l.bank_reference, l.fecha_valor ?? null, l.signed_amount, l.running_balance ?? null]);
      check(`${fx.name}: lines`, JSON.stringify(st.lines.map(pick)) === JSON.stringify(fx.expect.lines.map(pick)), JSON.stringify(st.lines.map(pick)));
      check(`${fx.name}: opening / closing / period`, st.opening === fx.expect.opening && st.closing === fx.expect.closing
        && JSON.stringify(st.period) === JSON.stringify(fx.expect.period), `${st.opening} ${st.closing} ${JSON.stringify(st.period)}`);
      if (fx.expect.details) {
        const got = st.details.map((d) => `${d.date}|${d.imp_original}|${d.association}`).join(',');
        check(`${fx.name}: transfer details (matched / TRANSFER_DETAIL_UNMATCHED)`,
          got === fx.expect.details.map((d) => `${d.date}|${d.imp_original}|${d.association}`).join(','), got);
      }
      for (const l of st.lines) { l.description_norm = jsNorm(l.description_raw); l.fingerprint = jsFingerprint(fx.format, l); }
      const pg = pgParity(fx.format, st.lines);
      check(`${fx.name}: JS ↔ PostgreSQL fingerprint parity (${pg.checked} lines)`, pg.bad.length === 0, pg.bad.join(' | '));
    } catch (e) { check(`${fx.name}: parsed`, false, e.message); }
  }
}

// ── fail-closed behaviour ────────────────────────────────────────────────────
console.log('\n  ── failure modes ──');
const sample = (k) => pdfFiles(multi(k))[0];
const expectReject = async (label, fn, codes) => {
  try { await fn(); check(label, false, 'accepted'); } catch (e) { check(`${label} → ${e.code}`, codes.includes(e.code), e.message); report.failures.push({ label, code: e.code }); }
};
const bnaPdf = sample('bna'); const patPdf = sample('patagonia');
if (bnaPdf && patPdf) {
  const b = readFileSync(bnaPdf);
  await expectReject('truncated PDF', async () => extract(b.subarray(0, Math.floor(b.length / 3))), ['INVALID_PDF', 'TEXT_NOT_EXTRACTABLE']);
  await expectReject('not a PDF', async () => extract(Buffer.from('FECHA MOVIMIENTOS COMPROB. DEBITOS CREDITOS SALDO\n')), ['NOT_A_PDF']);
  await expectReject('over the size limit (simulated: limit = file size − 1)', async () => {
    const saved = LIMITS.maxBytes; LIMITS.maxBytes = b.length - 1;
    try { await extract(b); } finally { LIMITS.maxBytes = saved; }
  }, ['FILE_TOO_LARGE']);
  await expectReject('over the page limit (simulated: limit = 1 on a 2-page statement)', async () => {
    const saved = LIMITS.maxPages; LIMITS.maxPages = 1;
    try { await extract(b); } finally { LIMITS.maxPages = saved; }
  }, ['TOO_MANY_PAGES']);
  await expectReject('BNA statement through the Patagonia adapter', async () => parsePatagonia((await extract(b)).pages, CONFIG.PATAGONIA_STATEMENT_PDF_V1), ['FORMAT_NOT_RECOGNISED']);
  await expectReject('Patagonia statement through the BNA adapter', async () => parseBna((await extract(readFileSync(patPdf))).pages, CONFIG.BNA_MONTHLY_PDF_V1), ['FORMAT_NOT_RECOGNISED']);
  await expectReject('BNA statement against another account configuration', async () => parseBna((await extract(b)).pages,
    { ...CONFIG.BNA_MONTHLY_PDF_V1, expected_cbu: '0'.repeat(22) }), ['ACCOUNT_MISMATCH']);
}
for (const f of pdfFiles(multi('failure-samples'))) {
  const bytes = readFileSync(f);
  for (const format of Object.keys(PARSERS)) {
    await expectReject(`unrelated PDF (${basename(f).slice(0, 18)}…) through ${format}`, async () => PARSERS[format]((await extract(bytes)).pages, CONFIG[format]),
      ['FORMAT_NOT_RECOGNISED', 'TEXT_NOT_EXTRACTABLE', 'INVALID_PDF', 'NOT_A_PDF']);
  }
}

if (opt('report')) writeFileSync(opt('report'), JSON.stringify(report, null, 2));
console.log(`\n  ══ ADR-018 unpdf PARITY SPIKE: ${pass} passed, ${fail} failed ══\n`);
process.exit(fail === 0 ? 0 : 1);
