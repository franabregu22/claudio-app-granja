import { useQuery } from '@tanstack/react-query';
import { supabase } from '../../lib/supabase';
import { listMpActivity } from '../../target/mpActivity';

export function useMpActivity(accountId: string) {
  return useQuery({ queryKey: ['mp-activity', accountId], queryFn: () => listMpActivity(supabase, accountId), enabled: accountId !== '' });
}
