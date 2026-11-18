/** 0132 (owner 2026-11-18): short concepts — the Mercado Pago outflow to classify no longer carries its SOURCE_ID in the concept;
 *  the cell reads it from the row's own key first (the old long concept stays a fallback). */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const src = (f: string) => readFileSync(resolve(__dirname, '../../src', f), 'utf8');

describe('0132 — Mercado Pago outflow classified from its cell', () => {
  it('the SOURCE_ID comes from mp_source_id first, then the old concept', () => {
    expect(src('features/caja/EdicionEnFila.tsx')).toMatch(/const delConcepto = r\.mp_source_id \?\? \/\\\(\(\\d\{6,20\}\)\[,\)\]\/\.exec\(r\.concepto\)/);
  });
  it('the row type carries the optional key', () => {
    expect(src('target/operations.ts')).toMatch(/mp_source_id\?: string \| null;/);
  });
});
