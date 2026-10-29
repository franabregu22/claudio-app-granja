/** Lote 2A — nombre y apellido de usuarios (0109): frontend side. The SQL side is scripts/target-db/profile_names.test.mjs. */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createClient } from '@supabase/supabase-js';
import { describe, expect, it, vi } from 'vitest';
import { listAllocationHistory } from '../../src/target/customerCollections';
import { TARGET_RPCS } from '../../src/target/db';
import { errorMessage } from '../../src/target/messages';
import {
  listProfileDisplayNames, profileDisplayName, responsableName, RESPONSABLE_NO_DISPONIBLE, setProfileName,
} from '../../src/target/masters';
import { listOrders } from '../../src/target/commercial';

vi.mock('../../src/lib/supabase', () => ({ supabase: {} }));
const SRC = (f: string) => readFileSync(resolve(__dirname, '../../src', f), 'utf8');
function fetchStub(body: unknown) {
  const seen: URL[] = [];
  const client = createClient('http://127.0.0.1:54321', 'anon-key', { auth: { persistSession: false }, global: { fetch: (async (input: RequestInfo | URL) => {
    seen.push(new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url));
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch } });
  return { client, seen };
}

describe('Lote 2A — names', () => {
  it('display name: "Nombre Apellido", either alone, nothing → null', () => {
    expect(profileDisplayName({ nombre: 'María José', apellido: 'Gómez' })).toBe('María José Gómez');
    expect(profileDisplayName({ nombre: 'Ana', apellido: null })).toBe('Ana');
    expect(profileDisplayName({ nombre: null, apellido: 'Ruiz' })).toBe('Ruiz');
    expect(profileDisplayName({ nombre: ' ', apellido: null })).toBeNull();
    expect(profileDisplayName(null)).toBeNull();
  });
  it('responsible: the stored id by name, else "No disponible" — never the id or an e-mail', () => {
    const names = new Map([['u1', 'Fran Abregú']]);
    expect(responsableName('u1', names)).toBe('Fran Abregú');
    expect(responsableName('u2', names)).toBe(RESPONSABLE_NO_DISPONIBLE);
    expect(responsableName(null, names)).toBe('No disponible');
  });
  it('names are read with id / nombre / apellido only (no e-mail, role or state), only profiles that have one', async () => {
    const { client, seen } = fetchStub([{ id: 'u1', nombre: 'Fran', apellido: 'Abregú' }, { id: 'u2', nombre: ' ', apellido: null }]);
    const m = await listProfileDisplayNames(client);
    expect([...m.entries()]).toEqual([['u1', 'Fran Abregú']]);
    expect(seen[0].pathname).toBe('/rest/v1/perfiles');
    expect(seen[0].searchParams.get('select')).toBe('id,nombre,apellido');
    expect(seen[0].searchParams.get('or')).toBe('(nombre.not.is.null,apellido.not.is.null)');
  });
  it('orders embed the responsible / rectifier name, never the e-mail', async () => {
    const { client, seen } = fetchStub([]);
    await listOrders(client, ['DELIVERED']);
    const select = seen[0].searchParams.get('select') ?? '';
    expect(select).toContain('entrego:perfiles!pedidos_delivered_by_fkey(nombre,apellido)');
    expect(select).toContain('pedido_lineas(*,perfiles(nombre,apellido))');
    expect(select).not.toMatch(/email/);
  });
  it('MP allocation reversals carry who recorded them', async () => {
    const { client, seen } = fetchStub([]);
    await listAllocationHistory(client, ['a1']);
    expect(seen[0].searchParams.get('select')).toContain('created_by');
  });
});

describe('Lote 2A — set_profile_name', () => {
  it('contract inputs only, allow-listed, readable refusals', async () => {
    const calls: { fn: string; args: unknown }[] = [];
    const client = { rpc: async (fn: string, args: unknown) => { calls.push({ fn, args }); return { data: {}, error: null }; } } as never;
    await setProfileName(client, { profileId: 'u1', nombre: 'Fran', apellido: 'Abregú' });
    expect(calls).toEqual([{ fn: 'set_profile_name', args: { p_profile_id: 'u1', p_nombre: 'Fran', p_apellido: 'Abregú' } }]);
    expect(TARGET_RPCS).toContain('set_profile_name');
    for (const code of ['NAME_TOO_LONG', 'INVALID_NAME', 'PROFILE_NOT_FOUND']) expect(errorMessage({ message: `${code}: x` })).not.toMatch(new RegExp(code));
  });
});

describe('Lote 2A — screens', () => {
  it('Cuentas corrientes: deliveries by name; collections, annulments / rectifications and MP reversals by the stored ids', () => {
    expect(SRC('features/cobros/ListaSaldosClientes.tsx')).toMatch(/p\.entregado_por_nombre \?\? RESPONSABLE_NO_DISPONIBLE/);
    const t = SRC('features/cobros/TablaCobros.tsx');
    expect(t).toMatch(/<Persona id=\{p\.registered_by\} names=\{nombres\} \/>/);
    expect(t).toMatch(/<Persona id=\{p\.reversal_by\} names=\{nombres\} \/>/);
    expect(t).toMatch(/<Persona id=\{r\.created_by\} names=\{nombres\} \/>/);
    for (const f of ['features/cobros/TablaCobros.tsx', 'features/cobros/ListaSaldosClientes.tsx', 'features/pedidos/PedidosApp.tsx']) {
      expect(SRC(f), f).not.toMatch(/email/i);
    }
  });
  it('Pedidos: "Entregado por" and "rectificó" by name, "No disponible" otherwise', () => {
    const t = SRC('features/pedidos/PedidosApp.tsx');
    expect(t).toMatch(/p\.entregado_por_nombre \?\? RESPONSABLE_NO_DISPONIBLE/);
    expect(t).toMatch(/rectificó \{r\.by_name \?\? RESPONSABLE_NO_DISPONIBLE\}/);
  });
  it('Admin → Usuarios edits only nombre / apellido (no role, state or authentication)', () => {
    const t = SRC('features/admin/UsuariosAdmin.tsx');
    expect(t).toMatch(/guardar\.mutate\(\{ profileId: perfil\.id, nombre, apellido \}\)/);
    expect(t).not.toMatch(/rol_type:|activo:|auth\.|signUp|updateUser/);
    expect(SRC('features/admin/AdminApp.tsx')).toMatch(/\{ id: 'user', label: 'Usuarios' \}/);
  });
});
