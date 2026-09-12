// Exact, reviewed duplicate pairs. Raw source observations are retained and linked to the surviving movement.
import fs from 'node:fs';
import crypto from 'node:crypto';
import { argentinaDate, moneyCents } from '../src/lib/mercadopago-calculations.ts';
const folder='outputs/mp-reconciliation',account=1054315166;
const pairs=[
  {remove:8927,keep:8964,ref:'1749494349584',amount:89.38},
  {remove:8928,keep:8965,ref:'176244098695',amount:-503},
  {remove:8929,keep:8966,ref:'177202973586',amount:-503},
  {remove:8935,keep:8958,ref:'178284169630',amount:77532},
  {remove:8936,keep:8959,ref:'178295460032',amount:7455},
  {remove:8937,keep:8960,ref:'178400937794',amount:7455},
  {remove:8938,keep:8961,ref:'1749829712459',amount:223.37},
  {remove:8939,keep:8962,ref:'177514804873',amount:22365},
];
const env={};for(const line of fs.readFileSync('.env.local','utf8').split(/\r?\n/)){const m=line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);if(m)env[m[1]]=m[2].trim().replace(/^['"]|['"]$/g,'');}
const headers={apikey:env.SUPABASE_SERVICE_ROLE_KEY,Authorization:`Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,'Content-Type':'application/json',Prefer:'return=representation,count=exact'};
async function request(path,method='GET',body){const r=await fetch(`${env.VITE_SUPABASE_URL}/rest/v1/${path}`,{method,headers,body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(30000)});if(!r.ok)throw new Error(`${method} HTTP ${r.status}: ${await r.text()}`);return {data:await r.json(),count:Number(r.headers.get('content-range')?.split('/')[1])};}
async function all(table,filter=true){const result=[];let expected;for(;;){const r=await request(`${table}?select=*&${filter?`account_id=eq.${account}&`:''}order=id&limit=500&offset=${result.length}`);if(!Number.isFinite(r.count)||(expected!==undefined&&expected!==r.count))throw new Error('Concurrent count change');expected=r.count;result.push(...r.data);if(result.length===expected)return result;if(!r.data.length)throw new Error('Incomplete pagination');}}
const results=await Promise.allSettled([all('mp_financial_movement'),all('ledger_entry'),all('mp_movement_source_link',false),all('mp_source_record',false),all('account_balance')]);
for(const r of results)if(r.status==='rejected')throw r.reason;
const [movements,ledger,links,sources,balances]=results.map(r=>r.value);
const byId=new Map(movements.map(m=>[m.id,m]));
const sourceById=new Map(sources.map(s=>[s.id,s]));
const removeIds=new Set(pairs.map(p=>p.remove));
const fingerprint=rows=>crypto.createHash('sha256').update(JSON.stringify(rows.map(l=>[l.id,l.financial_movement_id,l.balance_impact,l.occurred_at]).sort((a,b)=>a[0]-b[0]))).digest('hex');
for(const pair of pairs){
  const old=byId.get(pair.remove),keep=byId.get(pair.keep);
  if(!old||!keep)throw new Error('A reviewed pair is missing. Re-audit before retrying.');
  if(moneyCents(old.settlement_amount)!==moneyCents(pair.amount)||moneyCents(keep.settlement_amount)!==moneyCents(pair.amount)||old.movement_class!==keep.movement_class)throw new Error('Reviewed movement changed');
  for(const id of [pair.remove,pair.keep]){const entries=ledger.filter(l=>l.financial_movement_id===id);if(entries.length!==1||moneyCents(entries[0].balance_impact)!==moneyCents(pair.amount))throw new Error('Unexpected ledger for duplicate pair');}
  const keepLinks=links.filter(l=>l.financial_movement_id===pair.keep);
  if(!keepLinks.length||keepLinks.some(l=>sourceById.get(l.source_record_id)?.source_external_id!==pair.ref))throw new Error('Survivor source does not match reviewed reference');
  const oldLinks=links.filter(l=>l.financial_movement_id===pair.remove);
  if(oldLinks.some(l=>sourceById.get(l.source_record_id)?.source_external_id!==pair.ref))throw new Error('Old movement linked to a different operation');
  if(!oldLinks.length&&new Date(old.transaction_date).getTime()!==new Date(keep.transaction_date).getTime())throw new Error('Unlinked old record does not match exact timestamp');
}
const expectedLedger=ledger.filter(l=>!removeIds.has(l.financial_movement_id));
const throughClose=l=>new Date(l.occurred_at)<new Date('2026-09-12T00:00:00-03:00');
const before=ledger.filter(throughClose).reduce((s,l)=>s+moneyCents(l.balance_impact),0);
const after=expectedLedger.filter(throughClose).reduce((s,l)=>s+moneyCents(l.balance_impact),0);
if(after!==47133767||before-after!==11411375)throw new Error('Independent closing control failed');
const plan={account,cutoff:'2026-09-12T00:00:00-03:00',pairs,before:before/100,after:after/100,removed_net:(before-after)/100,ledger_before:fingerprint(ledger),ledger_after:fingerprint(expectedLedger)};
fs.writeFileSync(`${folder}/duplicate-consolidation-plan.json`,JSON.stringify(plan,null,2));
console.log(JSON.stringify(plan,null,2));
if(!process.argv.includes('--apply'))process.exit(0);
const backup={saved_at:new Date().toISOString(),plan,movements:movements.filter(m=>removeIds.has(m.id)||pairs.some(p=>p.keep===m.id)),ledger:ledger.filter(l=>removeIds.has(l.financial_movement_id)||pairs.some(p=>p.keep===l.financial_movement_id)),links:links.filter(l=>removeIds.has(l.financial_movement_id)||pairs.some(p=>p.keep===l.financial_movement_id)),sources:sources.filter(s=>links.some(l=>l.source_record_id===s.id&&(removeIds.has(l.financial_movement_id)||pairs.some(p=>p.keep===l.financial_movement_id)))),balances};
fs.writeFileSync(`${folder}/duplicate-backup-${Date.now()}.json`,JSON.stringify(backup,null,2));
if(fingerprint(await all('ledger_entry'))!==fingerprint(ledger))throw new Error('Ledger changed before consolidation');
for(const pair of pairs){
  const oldLinks=links.filter(l=>l.financial_movement_id===pair.remove);
  for(const link of oldLinks){
    const updated=await request(`mp_movement_source_link?id=eq.${link.id}&financial_movement_id=eq.${pair.remove}`,'PATCH',{financial_movement_id:pair.keep,is_primary:false});
    if(updated.data.length!==1)throw new Error('Source link changed during consolidation');
  }
  const source=oldLinks[0]?.source_record_id??links.find(l=>l.financial_movement_id===pair.keep).source_record_id;
  await request('mp_source_link_resolution','POST',{source_record_id:source,old_financial_movement_id:pair.remove,new_financial_movement_id:pair.keep,resolution_type:'duplicate_consolidation',notes:`Misma operación ${pair.ref}; importe y fuentes verificados. Copia local previa. Se conserva el registro de la importación más reciente.`});
}
const filter=new URLSearchParams({account_id:`eq.${account}`,id:`in.(${pairs.map(p=>p.remove).join(',')})`});
const removed=await request(`mp_financial_movement?${filter}`,'DELETE');
if(removed.data.length!==pairs.length)throw new Error('Unexpected deletion count; inspect backup and current database');
const finalLedger=await all('ledger_entry');
if(fingerprint(finalLedger)!==fingerprint(expectedLedger))throw new Error('Unexpected ledger after consolidation');
const dayById=new Map(finalLedger.map(l=>[l.id,argentinaDate(new Date(l.occurred_at))]));
let updatedBalances=0;
for(const balance of balances){
  const total=finalLedger.filter(l=>dayById.get(l.id)<=balance.balance_date).reduce((s,l)=>s+moneyCents(l.balance_impact),0)/100;
  const variance=balance.observed_balance_mp==null?null:(moneyCents(balance.observed_balance_mp)-moneyCents(total))/100;
  if(moneyCents(total)===moneyCents(balance.calculated_balance)&&variance===balance.variance)continue;
  const query=new URLSearchParams({account_id:`eq.${account}`,id:`eq.${balance.id}`,calculated_balance:`eq.${balance.calculated_balance}`});
  const patch={calculated_balance:total,variance,last_synced_at:new Date().toISOString()};
  if(balance.balance_date==='2026-09-11')patch.variance_note='Coincide con dinero disponible informado por el usuario al cierre argentino del 11/09. Ocho duplicados consolidados con evidencia y copia previa.';
  const updated=await request(`account_balance?${query}`,'PATCH',patch);
  if(updated.data.length!==1)throw new Error(`Concurrent daily balance change: ${balance.balance_date}`);
  updatedBalances++;
}
const finalMovements=await all('mp_financial_movement');
const finalBalances=await all('account_balance');
for(const b of finalBalances){const total=finalLedger.filter(l=>dayById.get(l.id)<=b.balance_date).reduce((s,l)=>s+moneyCents(l.balance_impact),0);if(total!==moneyCents(b.calculated_balance))throw new Error(`Invalid final daily balance: ${b.balance_date}`);}
if(finalMovements.length!==movements.length-8||finalLedger.length!==ledger.length-8)throw new Error('Final counts differ');
const result={completed_at:new Date().toISOString(),consolidated:8,raw_sources_preserved:(await all('mp_source_record',false)).length===sources.length,movements:finalMovements.length,ledger:finalLedger.length,updated_balances:updatedBalances,closing_balance:after/100,observed_available:471337.67,difference:0};
fs.writeFileSync(`${folder}/duplicate-consolidation-result.json`,JSON.stringify(result,null,2));
console.log(JSON.stringify(result,null,2));
