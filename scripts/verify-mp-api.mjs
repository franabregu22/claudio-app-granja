// Read-only integration checks using the actual frontend API implementation.
import fs from 'node:fs';
import ts from 'typescript';
import { pathToFileURL } from 'node:url';
import { createClient } from '@supabase/supabase-js';
const env={};
for(const line of fs.readFileSync('.env.local','utf8').split(/\r?\n/)){const m=line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);if(m)env[m[1]]=m[2].trim().replace(/^['"]|['"]$/g,'');}
globalThis.__mpAuditClient=createClient(env.VITE_SUPABASE_URL,env.SUPABASE_SERVICE_ROLE_KEY,{auth:{persistSession:false,autoRefreshToken:false}});
let source=fs.readFileSync('src/api/mercadopago.ts','utf8');
source=source.replace("import { supabase } from '../lib/supabase';",'const supabase = globalThis.__mpAuditClient;');
source=source.replace("'../lib/mercadopago-calculations'",JSON.stringify(pathToFileURL(`${process.cwd()}/src/lib/mercadopago-calculations.ts`).href));
const compiled=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2023}}).outputText;
const api=await import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`);
const checks=[];
for(const [start,end,count,net] of [['2026-08-01','2026-08-31',726,-124203.24],['2026-09-01','2026-09-11',170,399974.77],['2026-02-01','2026-09-11',4348,471337.67]]){
  const result=await api.getMPPeriod(start,end);
  if(result.movements.length!==count||result.summary.balance!==net)throw new Error(`Unexpected result for ${start}: ${JSON.stringify(result.summary)}`);
  checks.push({start,end,movements:result.movements.length,net:result.summary.balance,passed:true});
}
for(const [date,calculated,observed,difference] of [['2026-08-31',71362.9,71362.9,0],['2026-09-11',471337.67,471337.67,0]]){
  const result=await api.getMPClosingBalance(date);
  if(result.calculated!==calculated||result.observed!==observed||result.difference!==difference)throw new Error(`Unexpected balance: ${JSON.stringify(result)}`);
  checks.push({...result,passed:true});
}
fs.writeFileSync('outputs/mp-reconciliation/api-verification.json',JSON.stringify({verified_at:new Date().toISOString(),checks},null,2));
console.log(JSON.stringify(checks,null,2));
