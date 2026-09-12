export interface ExistingReleaseMovement {
  id: number;
  external_reference: string | null;
  settlement_amount: number;
  mp_movement_source_link?: { mp_source_record: { source_external_id: string } | null }[];
}

// A source can have several observations with different timestamps. That alone
// must not create another economic event. Reserve rows remain raw observations.
export function releaseIdentityIndex(movements: ExistingReleaseMovement[]) {
  const index = new Map<string, Map<number, number>>();
  for (const movement of movements) {
    const refs = new Set([movement.external_reference, ...(movement.mp_movement_source_link || []).map(link => link.mp_source_record?.source_external_id)].filter((value): value is string => Boolean(value)));
    for (const ref of refs) {
      if (!index.has(ref)) index.set(ref, new Map());
      index.get(ref)!.set(movement.id, Math.round(Number(movement.settlement_amount) * 100));
    }
  }
  return index;
}

export function classifyReleaseIdentity(index: Map<string, Map<number, number>>, sourceId: string, description: string, impactCents: number): 'raw' | 'new' | 'duplicate' | 'conflict' {
  if (description.startsWith('reserve_for_')) return 'raw';
  const existing = index.get(sourceId);
  if (!existing) return 'new';
  // Different amounts or multiple economic events need review, not silent skipping.
  if (existing.size !== 1 || [...existing.values()][0] !== impactCents) return 'conflict';
  return 'duplicate';
}
