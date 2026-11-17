import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '../../lib/supabase';
import { listClassificationDays, listGrades, listSessions, rectifyClassification, registerClassification } from '../../target/classification';
import {
  assignFlockFeed, listConsumptionIntervals, listFeedTypes, listFlockFeed, listFormulaComposition, listFormulaVersions, listManufacturing, listProfileNames, publishFormulaVersion, rectifyFeedManufacturing,
  registerFeedInventoryCount, registerFeedManufacturing, registerFeedMovement,
} from '../../target/feed';
import {
  editProductionDay, getFlockDay, listBirdCounts, listDayNotes, listFlockDays, listFlockDaysRange, listFlockOptions, listProductionDayEdits, listProductionDays, registerBirdCount,
  registerProductionDay, voidBirdCount,
} from '../../target/production';

const PRODUCTION = ['production'];
const CLASSIFICATION = ['classification'];
const FEED = ['feed'];

type Args<F> = F extends (client: never, ...rest: infer A) => unknown ? A : never;
function useWrite<F extends (client: never, p: never) => Promise<unknown>>(fn: F, keys: string[][]) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (p: Args<F>[0]) => (fn as unknown as (c: typeof supabase, p: Args<F>[0]) => Promise<unknown>)(supabase, p),
    onSuccess: () => Promise.all(keys.map((queryKey) => qc.invalidateQueries({ queryKey }))),
  });
}

// ── production and population ─────────────────────────────────────────────────
export const useFlockOptions = () => useQuery({ queryKey: [...PRODUCTION, 'flocks'], queryFn: () => listFlockOptions(supabase) });
export const useFlockDays = (from: string, to: string) =>
  useQuery({ queryKey: [...PRODUCTION, 'days', from, to], queryFn: () => listFlockDays(supabase, from, to) });
export const useFlockDaysRange = (from: string, to: string) =>
  useQuery({ queryKey: [...PRODUCTION, 'range', from, to], queryFn: () => listFlockDaysRange(supabase, from, to) });
export const useDayNotes = (from: string, to: string) =>
  useQuery({ queryKey: [...PRODUCTION, 'notes', from, to], queryFn: () => listDayNotes(supabase, from, to) });
export const useProductionDays = (from: string, to: string) =>
  useQuery({ queryKey: [...PRODUCTION, 'info', from, to], queryFn: () => listProductionDays(supabase, from, to) });
export const useDayEdits = (from: string, to: string) =>
  useQuery({ queryKey: [...PRODUCTION, 'edits', from, to], queryFn: () => listProductionDayEdits(supabase, from, to) });
export const useFlockDay = (flockId: string, date: string) =>
  useQuery({ queryKey: [...PRODUCTION, 'day', flockId, date], queryFn: () => getFlockDay(supabase, flockId, date), enabled: flockId !== '' && date !== '' });
export const useBirdCounts = (flockId: string) =>
  useQuery({ queryKey: [...PRODUCTION, 'counts', flockId], queryFn: () => listBirdCounts(supabase, flockId), enabled: flockId !== '' });

/** 0131: the day in one call, its edit (reason), a bird count by its total and the deletion of the last count. */
export function useProductionMutations() {
  return {
    registerDay: useWrite(registerProductionDay, [PRODUCTION]),
    editDay: useWrite(editProductionDay, [PRODUCTION]),
    count: useWrite(registerBirdCount, [PRODUCTION]),
    voidCount: useWrite(voidBirdCount, [PRODUCTION]),
  };
}

// ── classification ──────────────────────────────────────────────────────────
export const useGrades = () => useQuery({ queryKey: [...CLASSIFICATION, 'grades'], queryFn: () => listGrades(supabase) });
export const useClassificationDays = (from: string, to: string) =>
  useQuery({ queryKey: [...CLASSIFICATION, 'days', from, to], queryFn: () => listClassificationDays(supabase, from, to) });
export const useRegisterClassification = () => useWrite(registerClassification, [CLASSIFICATION]);
export const useClassificationSessions = (date: string) =>
  useQuery({ queryKey: [...CLASSIFICATION, 'sessions', date], queryFn: () => listSessions(supabase, date), enabled: date !== '' });
export const useRectifyClassification = () => useWrite(rectifyClassification, [CLASSIFICATION]);

// ── feed ────────────────────────────────────────────────────────────────────
export const useFeedTypes = () => useQuery({ queryKey: [...FEED, 'types'], queryFn: () => listFeedTypes(supabase) });
export const useFormulaVersions = () => useQuery({ queryKey: [...FEED, 'formulas'], queryFn: () => listFormulaVersions(supabase) });
export const useFormulaComposition = (versionIds: string[]) =>
  useQuery({ queryKey: [...FEED, 'composition', ...versionIds], queryFn: () => listFormulaComposition(supabase, versionIds) });
export const usePublishFormula = () => useWrite(publishFormulaVersion, [FEED]);
export const useManufacturing = (from: string, to: string) =>
  useQuery({ queryKey: [...FEED, 'manufacturing', from, to], queryFn: () => listManufacturing(supabase, from, to) });
export const useProfileNames = () => useQuery({ queryKey: ['profiles', 'names'], queryFn: () => listProfileNames(supabase) });
export const useRectifyManufacturing = () => useWrite(rectifyFeedManufacturing, [FEED]);
export const useFlockFeed = () => useQuery({ queryKey: [...FEED, 'assignments'], queryFn: () => listFlockFeed(supabase) });
export const useConsumptionIntervals = () => useQuery({ queryKey: [...FEED, 'intervals'], queryFn: () => listConsumptionIntervals(supabase) });

export function useFeedMutations() {
  return {
    manufacturing: useWrite(registerFeedManufacturing, [FEED]),
    count: useWrite(registerFeedInventoryCount, [FEED]),
    movement: useWrite(registerFeedMovement, [FEED]),
    assign: useWrite(assignFlockFeed, [FEED, PRODUCTION]),
  };
}
