import { useQuery } from '@tanstack/react-query';
import { supabase } from '../../lib/supabase';
import { listCashOpenings } from '../../target/cashOpening';

/** 0140: the cash openings recorded (one per cash account). */
export const useAperturasCaja = () => useQuery({ queryKey: ['treasury', 'cash-opening'], queryFn: () => listCashOpenings(supabase) });
