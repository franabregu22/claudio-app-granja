import { readdirSync, readFileSync } from 'node:fs';
import { posix, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * F27-I — final frontend authority audit over the whole of src/ (beyond the Phase 27 static gate). Comments are
 * stripped: they may name retired things to document the migration.
 */
const ROOT = resolve(__dirname, '../..');
const walk = (dir: string): string[] => readdirSync(resolve(ROOT, dir), { withFileTypes: true })
  .flatMap((e) => (e.isDirectory() ? walk(posix.join(dir, e.name)) : /\.(ts|tsx)$/.test(e.name) && !/\.d\.ts$/.test(e.name) ? [posix.join(dir, e.name)] : []));
const FILES = walk('src');
const code = (t: string) => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\s\/\/ .*$/gm, '');
const SRC = Object.fromEntries(FILES.map((f) => [f, code(readFileSync(resolve(ROOT, f), 'utf8'))]));
/** N-1: removed at cutover with the legacy Netlify MP runtime (L-1, Phase 31); nothing is retained. */
const N1_RETAINED: string[] = [];

const LEGACY_RELATIONS = ['clientes', 'productos', 'pagos', 'pago_en_caja', 'movimientos_caja', 'cheques', 'comisiones', 'facturas', 'arqueos_caja',
  'cuentas_caja', 'categorias_finanzas', 'lotes', 'producciones', 'recuentos_lote', 'precios_actuales', 'precios_historial', 'ledger_entry',
  'account_balance', 'mercadopago_raw', 'mercadopago_movements', 'sync_metadata', 'mp_financial_movement', 'marcar_pedido_entregado'];

describe('F27-I final frontend audit', () => {
  it('the Phase 27 legacy baseline is empty', () => {
    const b = JSON.parse(readFileSync(resolve(ROOT, 'scripts/regression/phase27-legacy-baseline.json'), 'utf8'));
    expect(b.files).toEqual({});
  });

  it.each(FILES.filter((f) => !N1_RETAINED.includes(f)))('%s: no legacy relation / RPC, role, sync or debug surface', (f) => {
    const t = SRC[f];
    for (const n of LEGACY_RELATIONS) expect(t).not.toMatch(new RegExp(`['"\`]${n}['"\`]`));
    expect(t).not.toMatch(/dueño|dueno|colaborador|repartidor/i);
    expect(t).not.toMatch(/sync-mercadopago|sync-settlement|netlify\/functions|MercadoPagoDebug|ipify|service_role|SERVICE_ROLE/);
    expect(t).not.toMatch(/localStorage\.(get|set)Item\([^)]*(token|secret|key|password)/i);
  });

  it('every PostgREST read, write and RPC goes through src/target (db.ts is the only caller); features never call supabase directly', () => {
    for (const [f, t] of Object.entries(SRC)) {
      if (f.startsWith('src/target/')) continue;
      expect(t, f).not.toMatch(/\.(insert|update|delete|upsert)\(|\.rpc\(|(supabase|client)\.from\(/);
    }
    for (const [f, t] of Object.entries(SRC).filter(([f]) => f.startsWith('src/target/') && f !== 'src/target/db.ts')) {
      expect(t, f).not.toMatch(/\.(insert|update|delete|upsert)\(|\.rpc\(/);
    }
  });

  it('no module is orphaned except the N-1 server-side helper', () => {
    const imported = new Set<string>();
    for (const [f, t] of Object.entries(SRC)) for (const m of t.matchAll(/(?:from|import)\s*\(?\s*['"](\.[^'"]+)['"]/g)) {
      const r = posix.normalize(posix.join(posix.dirname(f), m[1]));
      for (const ext of ['', '.ts', '.tsx', '/index.ts', '/index.tsx']) if (SRC[r + ext] !== undefined) { imported.add(r + ext); break; }
    }
    expect(FILES.filter((f) => !imported.has(f) && f !== 'src/main.tsx')).toEqual(N1_RETAINED);
  });
});
