// Target role (P27-D3): dueño → ADMIN, colaborador → OPERATOR, repartidor → no access. Authority: current_app_role().
import type { AppRole } from '../target/roles';

export type Rol = AppRole;

/** The signed-in Supabase Auth user as the app keeps it. Business rows are typed in src/target/*. */
export interface User {
  id: string;
  email?: string;
}
