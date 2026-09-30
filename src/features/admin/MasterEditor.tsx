import { useState } from 'react';
import { ChevronDown, Pencil, Plus } from 'lucide-react';
import type { MasterTable } from '../../target/masters';
import { errorMessage } from '../../target/messages';
import { useMasterList, useMasterMutations } from './useMasters';

export interface FieldDef {
  key: string;
  label: string;
  type?: 'text' | 'number' | 'select';
  options?: readonly { value: string; label: string }[];
  required?: boolean;
  /** false: set on creation only (e.g. an account type once postings may exist). */
  editable?: boolean;
  placeholder?: string;
}

interface Props {
  table: MasterTable;
  title: string;
  fields: FieldDef[];
  /** Soft-deactivation column; masters are never deleted. */
  activeKey?: 'activo' | null;
}

type Row = { id: string } & Record<string, unknown>;

const emptyForm = (fields: FieldDef[]) =>
  Object.fromEntries(fields.map((f) => [f.key, f.type === 'select' ? (f.options?.[0]?.value ?? '') : '']));

function toValues(fields: FieldDef[], form: Record<string, string>, only?: (f: FieldDef) => boolean) {
  return Object.fromEntries(fields.filter((f) => !only || only(f)).map((f) => {
    const raw = form[f.key] ?? '';
    return [f.key, f.type === 'number' ? (raw.trim() === '' ? null : Number(raw)) : raw];
  }));
}

function display(f: FieldDef, value: unknown): string {
  if (value === null || value === undefined || value === '') return '';
  if (f.type === 'select') return f.options?.find((o) => o.value === value)?.label ?? String(value);
  return String(value);
}

function FieldInput({ f, value, onChange }: { f: FieldDef; value: string; onChange: (v: string) => void }) {
  const cls = 'border border-gray-300 rounded px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-amber-600 w-full';
  if (f.type === 'select') {
    return (
      <select value={value} onChange={(e) => onChange(e.target.value)} className={cls} aria-label={f.label}>
        {f.options?.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
    );
  }
  return (
    <input type={f.type === 'number' ? 'number' : 'text'} value={value} onChange={(e) => onChange(e.target.value)}
      placeholder={f.placeholder ?? f.label} aria-label={f.label} className={cls} />
  );
}

export function MasterEditor({ table, title, fields, activeKey = 'activo' }: Props) {
  const list = useMasterList<Row>(table);
  const { create, update } = useMasterMutations(table);
  const [form, setForm] = useState<Record<string, string>>(() => emptyForm(fields));
  const [editId, setEditId] = useState<string | null>(null);
  const [editForm, setEditForm] = useState<Record<string, string>>({});
  const [open, setOpen] = useState({ active: true, inactive: false });

  const requiredOk = fields.every((f) => !f.required || (form[f.key] ?? '').trim() !== '');
  const agregar = () => {
    if (!requiredOk) return;
    create.mutate(toValues(fields, form), { onSuccess: () => setForm(emptyForm(fields)) });
  };
  const empezarEdicion = (row: Row) => {
    setEditId(row.id);
    setEditForm(Object.fromEntries(fields.map((f) => [f.key, row[f.key] === null || row[f.key] === undefined ? '' : String(row[f.key])])));
  };
  const guardarEdicion = (id: string) =>
    update.mutate({ id, values: toValues(fields, editForm, (f) => f.editable !== false) }, { onSuccess: () => setEditId(null) });

  if (list.isLoading) {
    return <div className="flex items-center justify-center py-12"><p className="text-gray-500">Cargando {title.toLowerCase()}...</p></div>;
  }
  if (list.error) {
    return <div className="p-4 bg-red-50 border border-red-200 rounded text-sm text-red-700">{errorMessage(list.error)}</div>;
  }

  const rows = list.data ?? [];
  const groups = activeKey
    ? [
      { id: 'active' as const, label: 'Activos', rows: rows.filter((r) => r[activeKey] === true), tone: 'bg-green-100 hover:bg-green-200 text-green-900' },
      { id: 'inactive' as const, label: 'Inactivos', rows: rows.filter((r) => r[activeKey] !== true), tone: 'bg-gray-100 hover:bg-gray-200 text-gray-900' },
    ]
    : [{ id: 'active' as const, label: title, rows, tone: 'bg-amber-100 hover:bg-amber-200 text-amber-900' }];
  const mutationError = create.error ?? update.error;

  return (
    <div className="p-6">
      <div className="mb-8 bg-white p-4 rounded-lg border border-amber-200">
        <h2 className="font-semibold text-amber-900 mb-3">Agregar — {title}</h2>
        <div className="grid grid-cols-1 md:grid-cols-4 gap-2 items-end">
          {fields.map((f) => (
            <FieldInput key={f.key} f={f} value={form[f.key] ?? ''} onChange={(v) => setForm({ ...form, [f.key]: v })} />
          ))}
          <button onClick={agregar} disabled={create.isPending || !requiredOk}
            className="bg-amber-600 hover:bg-amber-700 text-white px-4 py-2 rounded font-medium text-sm disabled:opacity-50 flex items-center justify-center gap-1 w-full">
            <Plus size={16} />
            Agregar
          </button>
        </div>
      </div>

      {mutationError && (
        <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded text-sm text-red-700">{errorMessage(mutationError)}</div>
      )}

      {groups.map((g) => (
        <div key={g.id} className="mb-4">
          <button onClick={() => setOpen({ ...open, [g.id]: !open[g.id] })}
            className={`w-full flex items-center gap-2 p-4 rounded-lg font-semibold transition ${g.tone}`}>
            <ChevronDown size={20} className={`transition ${open[g.id] ? 'rotate-180' : ''}`} />
            {g.label} ({g.rows.length})
          </button>
          {open[g.id] && (
            <div className="mt-2 space-y-2">
              {g.rows.length === 0 ? (
                <p className="text-gray-500 text-sm p-4">Sin registros</p>
              ) : g.rows.map((row) => (
                <div key={row.id} className={`bg-white rounded border border-gray-200 overflow-hidden ${g.id === 'inactive' ? 'opacity-75' : ''}`}>
                  {editId === row.id ? (
                    <div className="p-4 grid grid-cols-1 md:grid-cols-4 gap-2 items-end">
                      {fields.map((f) => f.editable === false
                        ? <p key={f.key} className="text-sm text-gray-600 py-2">{f.label}: {display(f, row[f.key])}</p>
                        : <FieldInput key={f.key} f={f} value={editForm[f.key] ?? ''} onChange={(v) => setEditForm({ ...editForm, [f.key]: v })} />)}
                      <div className="flex gap-2">
                        <button onClick={() => guardarEdicion(row.id)} disabled={update.isPending}
                          className="flex-1 bg-amber-600 hover:bg-amber-700 text-white px-3 py-2 rounded text-sm font-medium disabled:opacity-50">Guardar</button>
                        <button onClick={() => setEditId(null)} className="flex-1 border border-gray-300 px-3 py-2 rounded text-sm">Cancelar</button>
                      </div>
                    </div>
                  ) : (
                    <div className="p-4 flex items-center justify-between gap-2">
                      <div className="flex-1 min-w-0">
                        <p className="font-medium text-gray-800">{String(row[fields[0].key] ?? '')}</p>
                        <p className="text-xs text-gray-500 truncate">
                          {fields.slice(1).map((f) => display(f, row[f.key])).filter(Boolean).join(' · ')}
                        </p>
                      </div>
                      <div className="flex items-center gap-2">
                        <button onClick={() => empezarEdicion(row)} className="text-gray-500 hover:text-gray-700 p-1" title="Editar">
                          <Pencil size={16} />
                        </button>
                        {activeKey && (
                          <button onClick={() => update.mutate({ id: row.id, values: { [activeKey]: row[activeKey] !== true } })}
                            disabled={update.isPending}
                            className={`font-medium text-sm px-2 py-1 ${row[activeKey] === true ? 'text-red-500 hover:text-red-700' : 'text-green-600 hover:text-green-700'}`}>
                            {row[activeKey] === true ? 'Desactivar' : 'Activar'}
                          </button>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
