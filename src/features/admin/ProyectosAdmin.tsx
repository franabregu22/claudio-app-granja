import { PROJECT_STATUSES, type ProjectStatus } from '../../target/masters';
import { MasterEditor } from './MasterEditor';

const LABEL: Record<ProjectStatus, string> = { ACTIVE: 'Activo', PAUSED: 'Pausado', CLOSED: 'Cerrado' };

/** Target `projects` (ADMIN master). Its lifecycle is the `status` column (no activo flag, no deletion). */
export function ProyectosAdmin() {
  return (
    <MasterEditor
      table="projects"
      title="Proyectos"
      activeKey={null}
      fields={[
        { key: 'nombre', label: 'Nombre', required: true, placeholder: 'Nombre del proyecto' },
        { key: 'descripcion', label: 'Descripción', placeholder: 'Descripción (opcional)' },
        { key: 'status', label: 'Estado', type: 'select', options: PROJECT_STATUSES.map((s) => ({ value: s, label: LABEL[s] })) },
      ]}
    />
  );
}
