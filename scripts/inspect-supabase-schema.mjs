import fs from 'node:fs';

const env = {};
for (const line of fs.readFileSync('.env.local', 'utf8').split(/\r?\n/)) {
  const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
  if (match) env[match[1]] = match[2].trim().replace(/^['"]|['"]$/g, '');
}
const url = env.VITE_SUPABASE_URL;
const response = await fetch(`${url}/rest/v1/`, {
  headers: {
    apikey: env.SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
    Accept: 'application/openapi+json',
  },
  signal: AbortSignal.timeout(20000),
});
if (!response.ok) throw new Error(`Schema request HTTP ${response.status}`);
const schema = await response.json();
const tables = Object.entries(schema.definitions ?? {}).map(([name, def]) => ({
  name,
  required: def.required ?? [],
  columns: Object.entries(def.properties ?? {}).map(([name, col]) => ({
    name, type: col.format ?? col.type, description: col.description, default: col.default, enum: col.enum,
  })),
}));
const functions = Object.keys(schema.paths ?? {}).filter(p => p.startsWith('/rpc/')).map(p => p.slice(5));
fs.writeFileSync('supabase-schema-review.json', JSON.stringify({tables, functions}, null, 2));
console.log(JSON.stringify({status: response.status, tables, functions}));
