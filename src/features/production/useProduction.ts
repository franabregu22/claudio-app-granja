import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '../../lib/supabase';
import { listClassificationDays, listGrades, listSessions, rectifyClassification, registerClassification } from '../../target/classification';
import {
  assignFlockFeed, listConsumptionIntervals, listFeedTypes, listFlockFeed, listFormulaComposition, listFormulaVersions, listManufacturing, listProfileNames, publishFormulaVersion, rectifyFeedManufacturing,
  registerFeedInventoryCount, registerFeedManufacturing, registerFeedMovement,
} from '../../target/feed';
import {
  listFlockDays, listFlockOptions, listMortalityEvents, rectifyDailyProduction, rectifyMortality, registerCountAdjustment,
  registerDailyProduction, registerMortality,
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
export const useMortalityEvents = (flockId: string, date: string, enabled: boolean) =>
  useQuery({ queryKey: [...PRODUCTION, 'mortality', flockId, date], queryFn: () => listMortalityEvents(supabase, flockId, date), enabled });

export function useProductionMutations() {
  return {
    register: useWrite(registerDailyProduction, [PRODUCTION]),
    rectify: useWrite(rectifyDailyProduction, [PRODUCTION]),
    mortality: useWrite(registerMortality, [PRODUCTION]),
    rectifyMortality: useWrite(rectifyMortality, [PRODUCTION]),
    countAdjustment: useWrite(registerCountAdjustment, [PRODUCTION]),
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
