/**
 * Phase 27 acceptance fixes block 4 (ADR-012 / ADR-013) — pure frontend behaviour.
 *   - Classification lines travel as typed (quantity + unit); React never converts maples to eggs.
 *   - The session detail shows the stored entry and the backend's canonical count.
 *   - Manufacturing offers only the versions effective on the chosen date.
 *   - Formula versions / lines have no direct write path; publication is RPC 48.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { describeLine, rectifyClassification, registerClassification } from '../../src/target/classification';
import { DIRECT_WRITES, TARGET_RPCS, writeTable } from '../../src/target/db';
import { publishFormulaVersion, versionsEffectiveOn, type FormulaVersionRow } from '../../src/target/feed';

function rpcStub() {
  const calls: { fn: string; args: Record<string, unknown> }[] = [];
  const client = { rpc: async (fn: string, args: Record<string, unknown>) => { calls.push({ fn, args }); return { data: {}, error: null }; } };
  return { client: client as never, calls };
}

describe('ADR-012 classification entry units', () => {
  it('register sends quantity + unit exactly as typed (no conversion)', async () => {
    const { client, calls } = rpcStub();
    await registerClassification(client, { idempotencyKey: 'k', date: '2026-10-01', lines: [
      { classification_grade_id: 'n1', quantity: 3, unit: 'MAPLE' },
      { classification_grade_id: 'xl', quantity: 2, unit: 'MAPLE' },
      { classification_grade_id: 'sucios', quantity: 3, unit: 'UNIDAD' },
    ] });
    expect(calls[0].fn).toBe('register_classification');
    expect(calls[0].args.p_lines).toEqual([
      { classification_grade_id: 'n1', quantity: 3, unit: 'MAPLE' },
      { classification_grade_id: 'xl', quantity: 2, unit: 'MAPLE' },
      { classification_grade_id: 'sucios', quantity: 3, unit: 'UNIDAD' },
    ]);
  });

  it('rectify sends the whole session, the reason and its own idempotency key', async () => {
    const { client, calls } = rpcStub();
    await rectifyClassification(client, { idempotencyKey: 'r', classificationId: 'c1', reason: 'error', lines: [{ classification_grade_id: 'n1', quantity: 2, unit: 'MAPLE' }] });
    expect(calls[0]).toEqual({ fn: 'rectify_classification', args: {
      p_idempotency_key: 'r', p_classification_id: 'c1', p_reason: 'error', p_lines: [{ classification_grade_id: 'n1', quantity: 2, unit: 'MAPLE' }],
    } });
  });

  it('the detail shows the stored entry; the egg count in parentheses is the stored canonical value', () => {
    expect(describeLine({ entered_quantity: 3, entered_unit: 'MAPLE', quantity: 90 })).toBe('3 maples (90 huevos)');
    expect(describeLine({ entered_quantity: 1, entered_unit: 'MAPLE', quantity: 20 })).toBe('1 maple (20 huevos)');
    expect(describeLine({ entered_quantity: 2, entered_unit: 'UNIDAD', quantity: 2 })).toBe('2 unidades');
    expect(describeLine({ entered_quantity: 1, entered_unit: 'UNIDAD', quantity: 1 })).toBe('1 unidad');
  });

  it('no maple factor lives in the frontend (the conversion is the backend\'s)', () => {
    for (const f of ['src/target/classification.ts', 'src/features/production/ClasificacionApp.tsx']) {
      const src = readFileSync(f, 'utf8');
      expect(src).not.toMatch(/\*\s*(20|30)\b|\b(20|30)\s*\*/);
    }
  });
});

describe('ADR-013 formula publication and selector', () => {
  const V = (id: string, from: string, to: string | null): FormulaVersionRow => ({ id, feed_type_id: 't', version: Number(id.slice(1)), effective_from: from, effective_to: to });
  const versions = [V('v1', '2026-01-01', '2026-09-30'), V('v2', '2026-10-01', null)];

  it('the manufacturing selector returns only the version effective on the chosen date', () => {
    expect(versionsEffectiveOn(versions, '2026-09-30').map((v) => v.id)).toEqual(['v1']);
    expect(versionsEffectiveOn(versions, '2026-10-01').map((v) => v.id)).toEqual(['v2']);
    expect(versionsEffectiveOn(versions, '2025-12-31')).toEqual([]);
    expect(versionsEffectiveOn(versions, '')).toEqual([]);
  });

  it('publication is one RPC call with the whole composition', async () => {
    const { client, calls } = rpcStub();
    await publishFormulaVersion(client, { feedTypeId: 't', effectiveFrom: '2026-10-02', lines: [{ ingredientId: 'maiz', quantityKg: 60 }, { ingredientId: 'soja', quantityKg: 40 }] });
    expect(calls).toEqual([{ fn: 'publish_feed_formula_version', args: {
      p_feed_type_id: 't', p_effective_from: '2026-10-02', p_lines: [{ ingredient_id: 'maiz', quantity_kg: 60 }, { ingredient_id: 'soja', quantity_kg: 40 }], p_reason: null,
    } }]);
  });

  it('formula versions / lines have no direct write path; the two RPCs are authorized', async () => {
    expect(Object.keys(DIRECT_WRITES)).not.toContain('feed_formula_version');
    expect(Object.keys(DIRECT_WRITES)).not.toContain('feed_formula_line');
    expect(TARGET_RPCS).toContain('publish_feed_formula_version');
    expect(TARGET_RPCS).toContain('rectify_classification');
    await expect(writeTable({} as never, 'feed_formula_version' as never, 'insert' as never, {})).rejects.toMatchObject({ code: 'DIRECT_WRITE_NOT_ALLOWED' });
  });
});
