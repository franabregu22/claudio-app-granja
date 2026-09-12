// Updates derived balances and records sourced observations. Never changes movements.
import fs from 'node:fs';
import crypto from 'node:crypto';
import { argentinaDate, moneyCents } from '../src/lib/mercadopago-calculations.ts';
const folder='outputs/mp-reconciliation';
const snapshot=JSON.parse(fs.readFileSync(`${folder}/database-snapshot.json`,'utf8'));
const env={};
for(const line of fs.readFileSync('.env.local','utf8').split(/\r?\n/)){
  const m=line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
  if(m)env[m[1]]=m[2].trim().replace(/^['"]|['"]$/g,'');
}
const account=snapshot.account;
if(account!==1054315166)throw new Error('Unexpected account');
const headers={apikey:env.SUPABASE_SERVICE_ROLE_KEY,Authorization:`Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,'Content-Type':'application/json',Prefer:'return=representation,count=exact'};
async function request(path,method='GET',body){
  const response=await fetch(`${env.VITE_SUPABASE_URL}/rest/v1/${path}`,{method,headers,body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(30000)});
  if(!response.ok)throw new Error(`HTTP ${response.status}: ${await response.text()}`);
  return {data:await response.json(),count:Number(response.headers.get('content-range')?.split('/')[1])};
}
async function all(table){
  const result=[];let expected;
  for(;;){const page=await request(`${table}?select=*&account_id=eq.${account}&order=id&limit=500&offset=${result.length}`);
    if(!Number.isFinite(page.count)||(expected!==undefined&&expected!==page.count))throw new Error('Count changed');
    expected=page.count;result.push(...page.data);if(result.length===expected)return result;if(!page.data.length)throw new Error('Incomplete query');}
}
const liveLedger=await all('ledger_entry');
const ledgerDays=new Map(liveLedger.map(l=>[l.id,argentinaDate(new Date(l.occurred_at))]));
const digest=rows=>crypto.createHash('sha256').update(JSON.stringify(rows.map(l=>[l.id,l.financial_movement_id,l.balance_impact,l.occurred_at,l.recorded_at]).sort((a,b)=>a[0]-b[0]))).digest('hex');
if(digest(liveLedger)!==digest(snapshot.data.ledger))throw new Error('Ledger changed since source reconciliation. Repeat audit first.');
const balances=await all('account_balance');
const oldConfigurations=balances.filter(b=>b.opening_balance!==null||b.opening_balance_date!==null);
if(oldConfigurations.some(b=>b.opening_balance!==0||b.opening_balance_date!=='2026-02-01'))throw new Error('Conflicting opening configuration');
const opening=fs.readFileSync('data/mercadopago/Liberaciones1.csv','utf8').split(/\r?\n/)[1].replace(/"/g,'').split(';');
if(opening[0]!=='2026-02-01T00:00:00.000-03:00'||opening[1]!==''||opening[12]!=='0.00')throw new Error('Opening CSV control does not match');
const totalAt=date=>liveLedger.filter(l=>ledgerDays.get(l.id)<=date).reduce((n,l)=>n+moneyCents(l.balance_impact),0)/100;
if(totalAt('2026-08-31')!==71362.9)throw new Error('August control no longer matches');
const changes=[];
const first=[...balances].sort((a,b)=>a.balance_date.localeCompare(b.balance_date))[0];
for(const b of balances){
  const patch={};const recalculated=totalAt(b.balance_date);
  if(moneyCents(recalculated)!==moneyCents(b.calculated_balance)){
    const late=liveLedger.filter(l=>ledgerDays.get(l.id)<=b.balance_date&&new Date(l.recorded_at)>new Date(b.last_synced_at)).reduce((n,l)=>n+moneyCents(l.balance_impact),0);
    if(moneyCents(b.calculated_balance)+late!==moneyCents(recalculated))throw new Error(`Unexplained cache difference: ${b.balance_date}`);
    patch.calculated_balance=recalculated;
  }
  if(b.id===first.id&&oldConfigurations.length===0)Object.assign(patch,{opening_balance:0,opening_balance_date:'2026-02-01',opening_balance_source:'Liberaciones1.csv: opening control 2026-02-01T00:00:00-03:00',opening_balance_set_at:new Date().toISOString()});
  if(b.balance_date==='2026-08-31'||b.balance_date==='2026-09-11'){
    const observed=b.balance_date==='2026-08-31'?71362.9:471337.67;
    if(b.observed_balance_mp!==null&&moneyCents(b.observed_balance_mp)!==moneyCents(observed))throw new Error('Existing observation differs');
    if(b.observed_balance_mp===null||b.variance!== (moneyCents(observed)-moneyCents(recalculated))/100)Object.assign(patch,{observed_balance_mp:observed,variance:(moneyCents(observed)-moneyCents(recalculated))/100,variance_note:b.balance_date==='2026-08-31'?'CSV Liberaciones3: cierre 31/08 Argentina. Coincide con movimientos.':'Usuario: cierre 11/09 Argentina. Diferencia pendiente de explicar con reporte de septiembre.'});
  }
  if(Object.keys(patch).length){patch.last_synced_at=new Date().toISOString();changes.push({id:b.id,date:b.balance_date,before:b,patch});}
}
const references=[{date:'2026-08-31',amount:71362.9,detail:'Liberaciones3.csv: BALANCE_AMOUNT al cierre del 31/08/2026, Argentina (UTC-3).'}, {date:'2026-09-11',amount:471337.67,detail:'Saldo de cierre del 11/09/2026 informado por el usuario; Argentina (UTC-3), corte exclusivo 12/09 03:00 UTC.'}];
const plan={created_at:new Date().toISOString(),account,ledger_digest:digest(liveLedger),changes,references};
fs.writeFileSync(`${folder}/repair-plan.json`,JSON.stringify(plan,null,2));
console.log(JSON.stringify({mode:process.argv.includes('--apply')?'apply':'preview',changes:changes.map(c=>({date:c.date,patch:c.patch})),references},null,2));
if(!process.argv.includes('--apply'))process.exit(0);
fs.writeFileSync(`${folder}/balance-backup-${Date.now()}.json`,JSON.stringify(balances,null,2));
for(const c of changes){
  const query=new URLSearchParams({id:`eq.${c.id}`,account_id:`eq.${account}`,calculated_balance:`eq.${c.before.calculated_balance}`,last_synced_at:c.before.last_synced_at===null?'is.null':`eq.${c.before.last_synced_at}`});
  const updated=await request(`account_balance?${query}`,'PATCH',c.patch);
  if(updated.data.length!==1)throw new Error(`Concurrent change: ${c.date}. Prior completed changes are preserved; rerun audit.`);
}
const existing=await all('reconciliation_snapshot');
for(const ref of references){
  if(existing.some(s=>s.balance_date===ref.date&&moneyCents(s.observed_balance)===moneyCents(ref.amount)))continue;
  if(existing.some(s=>s.balance_date===ref.date))throw new Error('Different snapshot already exists');
  await request('reconciliation_snapshot','POST',{account_id:account,balance_date:ref.date,observed_balance:ref.amount,observed_at:new Date().toISOString(),source_method:'manual',source_detail:ref.detail,notes:'Referencia registrada para conciliación. No es un ajuste ni altera los movimientos.'});
}
const final=await all('account_balance');
for(const b of final){if(moneyCents(b.calculated_balance)!==moneyCents(totalAt(b.balance_date)))throw new Error(`Balance still differs: ${b.balance_date}`);}
if(digest(await all('ledger_entry'))!==digest(liveLedger))throw new Error('Ledger changed during repair. Re-run audit.');
fs.writeFileSync(`${folder}/repair-result.json`,JSON.stringify({completed_at:new Date().toISOString(),changed:changes.length,verified_daily_balances:final.length,ledger_unchanged:true,remaining_difference:114113.75},null,2));
console.log('Verified all daily caches; movements unchanged. September difference remains visible.');
