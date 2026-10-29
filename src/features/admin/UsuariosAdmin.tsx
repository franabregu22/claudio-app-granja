import { useState } from 'react';
import { profileDisplayName, type ProfileRow } from '../../target/masters';
import { errorMessage } from '../../target/messages';
import { useProfiles, useSetProfileName } from './useMasters';

const ROL: Record<ProfileRow['rol_type'], string> = { ADMIN: 'Administrador', OPERATOR: 'Operador' };

/**
 * Usuarios (Lote 2A, 0109): first / last name of each ERP profile — the name shown as the person responsible for deliveries,
 * collections and their annulments / rectifications. Only these two fields are edited (set_profile_name, ADMIN, audited);
 * role, state and authentication are not managed here. The e-mail identifies the account in this list only.
 */
export function UsuariosAdmin() {
  const perfiles = useProfiles();
  if (perfiles.isLoading) return <div className="flex items-center justify-center py-12"><p className="text-gray-500">Cargando usuarios...</p></div>;
  if (perfiles.error) return <div className="m-6 p-4 bg-red-50 border border-red-200 rounded text-sm text-red-700">{errorMessage(perfiles.error)}</div>;
  return (
    <div className="p-6 space-y-2">
      <p className="text-xs text-gray-500 mb-2">
        El nombre y apellido se muestran como responsables de entregas y cobros. Sin nombre cargado se muestra «No disponible».
      </p>
      {(perfiles.data ?? []).map((p) => <FilaUsuario key={p.id} perfil={p} />)}
    </div>
  );
}

function FilaUsuario({ perfil }: { perfil: ProfileRow }) {
  const guardar = useSetProfileName();
  const [nombre, setNombre] = useState(perfil.nombre ?? '');
  const [apellido, setApellido] = useState(perfil.apellido ?? '');
  const cambio = nombre.trim() !== (perfil.nombre ?? '') || apellido.trim() !== (perfil.apellido ?? '');
  const cls = 'border border-gray-300 rounded px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-amber-600 w-full';
  return (
    <div className={`bg-white rounded border border-gray-200 p-4 ${perfil.activo ? '' : 'opacity-75'}`}>
      <div className="flex items-baseline justify-between gap-2 mb-2">
        <p className="font-medium text-gray-800 truncate">{profileDisplayName(perfil) ?? <span className="text-gray-400 font-normal">Sin nombre</span>}</p>
        <p className="text-xs text-gray-500 shrink-0">{ROL[perfil.rol_type]}{perfil.activo ? '' : ' · inactivo'}</p>
      </div>
      <p className="text-xs text-gray-500 break-all mb-2">{perfil.email}</p>
      <div className="grid grid-cols-1 sm:grid-cols-[1fr_1fr_auto] gap-2 items-end">
        <input aria-label={`Nombre de ${perfil.email}`} placeholder="Nombre" maxLength={80} value={nombre} onChange={(e) => setNombre(e.target.value)} className={cls} />
        <input aria-label={`Apellido de ${perfil.email}`} placeholder="Apellido" maxLength={80} value={apellido} onChange={(e) => setApellido(e.target.value)} className={cls} />
        <button onClick={() => guardar.mutate({ profileId: perfil.id, nombre, apellido })} disabled={!cambio || guardar.isPending}
          className="bg-amber-600 hover:bg-amber-700 text-white px-4 py-2 rounded font-medium text-sm disabled:opacity-50">
          {guardar.isPending ? 'Guardando...' : 'Guardar'}
        </button>
      </div>
      {guardar.error && <p className="mt-2 text-sm text-red-700">{errorMessage(guardar.error)}</p>}
    </div>
  );
}
