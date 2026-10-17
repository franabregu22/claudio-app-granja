/**
 * ADR-024 — frontend: Categoría → Subcategoría → Naturaleza (pre-filled, editable), reserved subcategories never offered,
 * the socios of a withdrawal, the category tree, the fiscal-only VAT document helpers and the safe payer title.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { TARGET_READ_TABLES, DIRECT_WRITES } from '../../src/target/db';
import {
  categoryPath, categoryTree, defaultNatureOf, isSelectable, NATURE_LABEL, selectableGroups, selectableSubcategories, socios,
} from '../../src/target/expenseCategories';
import { cuitOrNull, documentNumber, SOLO_IVA_NOTE } from '../../src/target/fiscal';
import type { ExpenseCategoryGroupRow, ExpenseCategoryRow } from '../../src/target/masters';
import { inflowTitle } from '../../src/target/pendingClassification';

const SRC = (f: string) => readFileSync(resolve(__dirname, '../../src', f), 'utf8');
const G = (id: string, nombre: string, display_order: number, kind: ExpenseCategoryGroupRow['kind'] = 'EXPENSE', activo = true): ExpenseCategoryGroupRow =>
  ({ id, nombre, display_order, kind, activo });
const S = (id: string, nombre: string, group_id: string, default_nature: ExpenseCategoryRow['default_nature'] = 'OPERATING', extra: Partial<ExpenseCategoryRow> = {}): ExpenseCategoryRow =>
  ({ id, nombre, group_id, default_nature, description: null, activo: true, pnl_cost_class: 'INDIRECT', fiscal_reserved: false, ...extra });
const GROUPS = [G('comb', 'Combustible', 5), G('ret', 'Retiros de socios', 4, 'OWNER_WITHDRAWAL'), G('imp', 'Impuestos y tasas', 9), G('rec', 'Recria', 13), G('vac', 'Vacía', 20)];
const SUBS = [
  S('gasoil', 'Gasoil', 'comb'), S('nafta', 'Nafta', 'comb'), S('santi', 'Santi', 'ret', null), S('fran', 'Fran', 'ret', null),
  S('iva', 'IVA', 'imp', null, { activo: false, fiscal_reserved: true }), S('mono', 'Monotributo', 'imp'), S('pollitas', 'Pollitas BB', 'rec', 'INVESTMENT'),
  S('vieja', 'Vieja', 'vac', 'OPERATING', { activo: false }),
];

describe('ADR-024 — category → subcategory', () => {
  it('G: a category lists only its selectable subcategories; withdrawal socios, fiscal-reserved and inactive ones are never offered', () => {
    expect(selectableGroups(GROUPS, SUBS).map((g) => g.nombre)).toEqual(['Combustible', 'Impuestos y tasas', 'Recria']);
    expect(selectableSubcategories(GROUPS, SUBS, 'comb').map((s) => s.nombre)).toEqual(['Gasoil', 'Nafta']);
    expect(selectableSubcategories(GROUPS, SUBS, 'imp').map((s) => s.nombre)).toEqual(['Monotributo']);
    expect(selectableSubcategories(GROUPS, SUBS, 'ret')).toEqual([]);
    expect([isSelectable(SUBS[2], GROUPS), isSelectable(SUBS[4], GROUPS)]).toEqual([false, false]);
  });
  it('H: choosing a subcategory pre-fills its default nature (Pollitas BB → Inversión); an unknown one falls back to Operativa', () => {
    expect([defaultNatureOf(SUBS, 'pollitas'), defaultNatureOf(SUBS, 'gasoil'), defaultNatureOf(SUBS, 'nope')]).toEqual(['INVESTMENT', 'OPERATING', 'OPERATING']);
    expect(NATURE_LABEL).toEqual({ OPERATING: 'Operativa', REINVESTMENT: 'Reinversión', INVESTMENT: 'Inversión' });
  });
  it('I / J: the nature stays editable per operation in every form (the selector never writes the master)', () => {
    const sel = SRC('features/caja/SelectorCategoria.tsx');
    expect(sel).toMatch(/onNaturaleza\(defaultNatureOf\(s, id\)\)/);
    expect(sel).toMatch(/aria-label="Naturaleza"/);
    expect(sel).not.toMatch(/pnl_cost_class|'DIRECT'|'INDIRECT'|createMaster|updateMaster/);
    expect(SRC('features/caja/Compras.tsx')).toMatch(/<SelectorCategoria subcategoriaId=\{categoriaId\} onSubcategoria=\{setCategoriaId\} naturaleza=\{naturaleza\} onNaturaleza=\{setNaturaleza\}/);
    expect(SRC('features/caja/CuentaDetalle.tsx')).toMatch(/<SelectorCategoria compacto campo=\{SELECT_CLS\} subcategoriaId=\{categoria\} onSubcategoria=\{setCategoria\} naturaleza=\{naturaleza\} onNaturaleza=\{setNaturaleza\} \/>/);
  });
  it('M: the socios of a Retiro de socios; the withdrawal form sends the optional socio', () => {
    expect(socios(GROUPS, SUBS).map((s) => s.nombre)).toEqual(['Fran', 'Santi']);
    const m = SRC('features/finanzas/EventoGestionModal.tsx');
    expect(m).toMatch(/socioCategoryId: tipo === 'RETIRO' && !compensaId \? socioId \|\| null : null/);
    expect(m).toMatch(/Socio \(opcional\)/);
  });
  it('the administration tree and paths; the group table is an ADMIN direct write (audited by the database)', () => {
    expect(categoryTree(GROUPS, SUBS).map((t) => `${t.group.nombre}:${t.subs.map((s) => s.nombre).join('+')}`))
      .toEqual(['Retiros de socios:Fran+Santi', 'Combustible:Gasoil+Nafta', 'Impuestos y tasas:Monotributo+IVA', 'Recria:Pollitas BB', 'Vacía:Vieja']);
    expect(categoryPath(GROUPS, SUBS, 'gasoil')).toBe('Combustible › Gasoil');
    expect(TARGET_READ_TABLES).toContain('expense_category_group');
    expect(DIRECT_WRITES.expense_category_group).toEqual(['insert', 'update']);
    const a = SRC('features/admin/CategoriasAdmin.tsx');
    expect(a).toMatch(/Crear categoría/);
    expect(a).toMatch(/aria-label="Mover a la categoría"/);
    expect(a).toMatch(/aria-label="Naturaleza por defecto"/);
    expect(a).not.toMatch(/pnl_cost_class|Clase de costo|'delete'/);
  });
});

describe('ADR-024 — fiscal-only VAT credit and safe payer display', () => {
  it('Solo crédito fiscal IVA: explicit note, issuer by CUIT, punto de venta + número', () => {
    expect(SOLO_IVA_NOTE).toMatch(/no mueve dinero/);
    expect([documentNumber('1', '4321'), documentNumber('', '4321'), documentNumber('A12', 'X'), documentNumber(' ', ' ')]).toEqual(['0001-00004321', '4321', 'A12-X', null]);
    expect([cuitOrNull('20-12345678-6'), cuitOrNull('123'), cuitOrNull('201234567860')]).toEqual(['20123456786', null, null]);
    const f = SRC('features/fiscal/FiscalApp.tsx');
    expect(f).toMatch(/Cargar como «Solo crédito fiscal IVA»/);
    expect(f).toMatch(/issuerTaxId: porCuit \? cuitOrNull\(cuit\) : null/);
  });
  it('the payer title: bank holder / cardholder name, else the type; never email or document', () => {
    expect(inflowTitle({ payer_display_name: 'Juan Pérez', inflow_subtype: 'DEBIN' })).toBe('Juan Pérez');
    expect(inflowTitle({ payer_display_name: null, inflow_subtype: 'CVU' })).toBe('Transferencia (CVU)');
    const e = SRC('features/caja/EntradasSinVincular.tsx');
    expect(e).toMatch(/Recordar este pagador/);
    expect(e).toMatch(/Cliente asociado: /);
    expect(e).toMatch(/>Ignorar</);
    const cols = /const UNLINKED_COLUMNS = [^;]*;/.exec(SRC('target/pendingClassification.ts'))?.[0] ?? '';
    expect(cols).toMatch(/payer_id, payer_display_name, mapped_client_id, mapped_client_name/);
    expect(cols).not.toMatch(/email|identification|event_data|raw_row|phone/);
  });
});
