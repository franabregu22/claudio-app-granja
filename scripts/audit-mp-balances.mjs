import fs from 'node:fs';
const env = {};
for (const line of fs.readFileSync('.env.local', 'utf8').split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
  if (m) env[m[1]] = m[2].trim().replace(/^['"]|['"]$/g, '');
}
const account = Number(env.ACCOUNT_ID || 1054315166);
const headers = {apikey: env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`, Prefer:'count=exact'};
async function rows(table, select, filter=true, order='id') {
  const out=[]; let expected;
  for (;;) {
    const query = new URLSearchParams({select,order,offset:String(out.length),limit:'500'});
    if (filter) query.set('account_id', `eq.${account}`);
    const res=await fetch(`${env.VITE_SUPABASE_URL}/rest/v1/${table}?${query}`,{headers,signal:AbortSignal.timeout(30000)});
    if (!res.ok) throw new Error(`${table}: HTTP ${res.status} ${await res.text()}`);
    const total=Number(res.headers.get('content-range')?.split('/')[1]);
    if (!Number.isFinite(total)) throw new Error(`Missing exact count for ${table}`);
    if (expected!==undefined && expected!==total) throw new Error(`Table changed during audit: ${table}`);
    expected=total;
    const page=await res.json(); out.push(...page);
    if (out.length===total) break;
    if (!page.length || out.length>total) throw new Error(`Incomplete pagination: ${table}`);
  }
  return out;
}
const queries={
  movements:['mp_financial_movement','id,account_id,movement_class,settlement_amount,transaction_date,settlement_date,needs_review,economic_hash,normalized_at,external_reference'],
  ledger:['ledger_entry','id,account_id,financial_movement_id,balance_impact,category,occurred_at,recorded_at'],
  balances:['account_balance','*'],
  reconciliation_summary:['v_monthly_reconciliation_summary','*'],
  reconciliations:['monthly_reconciliation','*'],
  snapshots:['reconciliation_snapshot','id,account_id,balance_date,observed_balance,observed_at,source_method,source_detail,supersedes_snapshot_id'],
  flows:['period_flow_observation','id,account_id,period_start,period_end,observed_net,observed_at,source_method,source_detail,supersedes_observation_id'],
  coverage:['v_period_coverage_status','*',true,'period_start'],
  links:['mp_movement_source_link','id,financial_movement_id,source_record_id,is_primary',false],
  sources:['mp_source_record','id,account_id,source_type,source_external_id,processing_status,economic_row_fp,cross_source_fp,release_date:raw_data->>DATE,release_description:raw_data->>DESCRIPTION,release_credit:raw_data->>NET_CREDIT_AMOUNT,release_debit:raw_data->>NET_DEBIT_AMOUNT,release_balance:raw_data->>BALANCE_AMOUNT',false],
};
const data={};
const optional_errors=[];
const results=await Promise.allSettled(Object.entries(queries).map(async ([name,args])=>{try {data[name]=await rows(...args); console.log(`${name}: ${data[name].length} rows checked`);}catch(error){if(name==='reconciliation_summary'){optional_errors.push(error.message);data[name]=[];}else throw error;}}));
const errors=results.filter(r=>r.status==='rejected').map(r=>r.reason.message);
if(errors.length) throw new Error(errors.join('\n'));
if (process.argv.includes('--snapshot')) {
  fs.mkdirSync('outputs/mp-reconciliation', {recursive:true});
  fs.writeFileSync('outputs/mp-reconciliation/database-snapshot.json', JSON.stringify({checked_at:new Date().toISOString(),account,data}));
}
const cents=v=>Math.round(Number(v||0)*100), money=v=>v/100;
const day=v=>new Date(new Date(v).getTime()-3*3600000).toISOString().slice(0,10);
const sum=arr=>arr.reduce((n,r)=>n+cents(r.balance_impact),0);
const byId=new Map(data.movements.map(m=>[m.id,m]));
const groups=new Map();
for(const l of data.ledger){if(!groups.has(l.financial_movement_id))groups.set(l.financial_movement_id,[]);groups.get(l.financial_movement_id).push(l);}
const monthly={};
for(const l of data.ledger){const month=day(l.occurred_at).slice(0,7); const m=monthly[month]??={entries:0,net:0,positive:0,negative:0,categories:{}};m.entries++;const c=cents(l.balance_impact);m.net+=c;if(c>0)m.positive+=c;else m.negative+=c;m.categories[l.category]=(m.categories[l.category]||0)+c;}
for(const m of Object.values(monthly)){for(const k of ['net','positive','negative'])m[k]=money(m[k]);for(const k in m.categories)m.categories[k]=money(m.categories[k]);}
const configs=data.balances.filter(b=>b.opening_balance!==null&&b.opening_balance_date!==null);
const uniqueConfigs=[...new Map(configs.map(b=>[`${b.opening_balance_date}|${b.opening_balance}`,{date:b.opening_balance_date,amount:b.opening_balance}])).values()];
const opening=uniqueConfigs.length===1?uniqueConfigs[0]:null;
function at(date){return !opening||date<opening.date?null:money(cents(opening.amount)+sum(data.ledger.filter(l=>day(l.occurred_at)>=opening.date&&day(l.occurred_at)<=date)));}
const replaced=new Set(data.snapshots.map(s=>s.supersedes_snapshot_id).filter(Boolean));
const checkpoints=data.snapshots.map(s=>({...s,current:!replaced.has(s.id),recalculated:at(s.balance_date),observed_minus_recalculated:at(s.balance_date)===null?null:money(cents(s.observed_balance)-cents(at(s.balance_date)))}));
const replacedFlows=new Set(data.flows.map(s=>s.supersedes_observation_id).filter(Boolean));
const flows=data.flows.map(f=>{const calculated=money(sum(data.ledger.filter(l=>day(l.occurred_at)>=f.period_start&&day(l.occurred_at)<=f.period_end)));return {...f,current:!replacedFlows.has(f.id),calculated,observed_minus_calculated:money(cents(f.observed_net)-cents(calculated))};});
const sourceIds=new Map(data.sources.map(s=>[s.id,s]));
const ownLinks=data.links.filter(l=>byId.has(l.financial_movement_id));
const linksByMovement=new Map(),linksBySource=new Map();
for(const l of ownLinks){if(!linksByMovement.has(l.financial_movement_id))linksByMovement.set(l.financial_movement_id,[]);linksByMovement.get(l.financial_movement_id).push(l);if(!linksBySource.has(l.source_record_id))linksBySource.set(l.source_record_id,new Set());linksBySource.get(l.source_record_id).add(l.financial_movement_id);}
const hashGroups=new Map();for(const m of data.movements){if(!m.economic_hash)continue;if(!hashGroups.has(m.economic_hash))hashGroups.set(m.economic_hash,[]);hashGroups.get(m.economic_hash).push(m.id);}
const report={checked_at:new Date().toISOString(),account,counts:Object.fromEntries(Object.entries(data).map(([k,v])=>[k,v.length])),opening_configs:uniqueConfigs,ledger_dates:{first:data.ledger.map(l=>day(l.occurred_at)).sort()[0],last:data.ledger.map(l=>day(l.occurred_at)).sort().at(-1)},monthly:Object.fromEntries(Object.entries(monthly).sort()),last_calculated_balance:at(data.ledger.map(l=>day(l.occurred_at)).sort().at(-1)),snapshots:checkpoints,flow_comparisons:flows,stored_balances:data.balances.map(b=>({...b,recalculated:at(b.balance_date),stored_minus_recalculated:at(b.balance_date)===null?null:money(cents(b.calculated_balance)-cents(at(b.balance_date)))})),coverage:data.coverage,reconciliations:data.reconciliations,integrity:{movements_without_ledger:data.movements.filter(m=>!groups.has(m.id)).map(m=>m.id),ledger_without_movement:data.ledger.filter(l=>!byId.has(l.financial_movement_id)),multiple_ledger:[...groups].filter(([id,ls])=>ls.length!==1).map(([id,ls])=>({id,count:ls.length})),amount_mismatches:data.ledger.filter(l=>byId.has(l.financial_movement_id)&&cents(l.balance_impact)!==cents(byId.get(l.financial_movement_id).settlement_amount)),date_mismatches:data.ledger.filter(l=>byId.has(l.financial_movement_id)&&day(l.occurred_at)!==day(byId.get(l.financial_movement_id).transaction_date)),needs_review:data.movements.filter(m=>m.needs_review),movements_without_source:data.movements.filter(m=>!linksByMovement.has(m.id)).map(m=>m.id),source_linked_multiple_movements:[...linksBySource].filter(([id,ids])=>ids.size>1).map(([id,ids])=>({source_record_id:id,movement_ids:[...ids]})),missing_source_records:ownLinks.filter(l=>!sourceIds.has(l.source_record_id)),duplicate_economic_hash_candidates:[...hashGroups.values()].filter(ids=>ids.length>1)}};
report.query_errors=optional_errors;
report.zero_opening_diagnostic=data.balances.map(b=>{const net=money(sum(data.ledger.filter(l=>day(l.occurred_at)<=b.balance_date)));return {date:b.balance_date,stored:b.calculated_balance,net_from_first_loaded_movement:net,difference:money(cents(b.calculated_balance)-cents(net))};}).sort((a,b)=>a.date.localeCompare(b.date));
report.latest_day_entries=data.ledger.filter(l=>day(l.occurred_at)===report.ledger_dates.last).length;
fs.writeFileSync('mercadopago-balance-audit.json',JSON.stringify(report,null,2));
console.log(JSON.stringify({...report,zero_opening_diagnostic:report.zero_opening_diagnostic.slice(-8),stored_balances:report.stored_balances.filter(b=>b.opening_balance!==null||b.observed_balance_mp!==null||Math.abs(b.stored_minus_recalculated||0)>0.01).slice(-12),integrity:Object.fromEntries(Object.entries(report.integrity).map(([k,v])=>[k,{count:v.length,examples:v.slice(0,8)}]))},null,2));
