"""Read-only reconciliation of local MP reports and the paginated database snapshot."""
import csv
import json
from pathlib import Path
from decimal import Decimal
from datetime import datetime, timezone, timedelta
from collections import Counter, defaultdict

ARG = timezone(timedelta(hours=-3))
def dec(value):
    return Decimal(str(value or '0'))
def instant(value):
    return datetime.fromisoformat(value.replace('Z', '+00:00')).astimezone(ARG)
def cents(value):
    return int(dec(value) * 100)
root = Path('outputs/mp-reconciliation')
snapshot = json.loads((root / 'database-snapshot.json').read_text())
data = snapshot['data']
ledger = data['ledger']
movements = data['movements']
reports=[]
for path in Path('data/mercadopago').glob('*.csv'):
    if path.name=='BASECSV.csv':
        continue
    content=path.read_text(encoding='utf-8-sig')
    delimiter=';' if content.splitlines()[0].count(';')>content.splitlines()[0].count(',') else ','
    rows=list(csv.DictReader(content.splitlines(),delimiter=delimiter))
    is_release='DATE' in rows[0]
    datekey='DATE' if is_release else 'TRANSACTION_DATE'
    valid=[r for r in rows if r.get(datekey) and r.get('SOURCE_ID')]
    buckets=defaultdict(lambda:{'count':0,'net':0})
    for r in valid:
        key=instant(r[datekey]).strftime('%Y-%m')+' '+r.get('DESCRIPTION',r.get('TRANSACTION_TYPE',''))
        buckets[key]['count']+=1
        amount=dec(r.get('NET_CREDIT_AMOUNT'))-dec(r.get('NET_DEBIT_AMOUNT')) if is_release else dec(r.get('SETTLEMENT_NET_AMOUNT'))
        buckets[key]['net']+=cents(amount)
    control=[{k:r[k] for k in ['DATE','BALANCE_AMOUNT'] if k in r} for r in rows if r.get('DATE') and not r.get('SOURCE_ID')]
    endpoints=[]
    if is_release:
        for month in sorted({instant(r[datekey]).strftime('%Y-%m') for r in valid}):
            monthrows=sorted([r for r in valid if instant(r[datekey]).strftime('%Y-%m')==month],key=lambda r:instant(r[datekey]))
            for label,row in [('first',monthrows[0]),('last',monthrows[-1])]:
                endpoints.append({'month':month,'position':label,'date':row['DATE'],'balance':row['BALANCE_AMOUNT'],'description':row['DESCRIPTION']})
    reports.append({'file':path.name,'rows':len(rows),'first':min(r[datekey] for r in valid),'last':max(r[datekey] for r in valid),'controls':control,'endpoints':endpoints,'by_month_type':dict(buckets)})

# Reconstruct what each daily cache could see at its last refresh.
cache=[]
for balance in data['balances']:
    if not balance.get('last_synced_at'): continue
    updated=instant(balance['last_synced_at'])
    past=[r for r in ledger if instant(r['occurred_at']).date().isoformat()<=balance['balance_date']]
    late=[r for r in past if instant(r['recorded_at'])>updated]
    net=sum(cents(r['balance_impact']) for r in past)
    cache.append({'date':balance['balance_date'],'stored':balance['calculated_balance'],'recomputed_zero_opening':net/100,'late_recorded_count':len(late),'late_recorded_net':sum(cents(r['balance_impact']) for r in late)/100,'stored_plus_late_equals_current':cents(balance['calculated_balance'])+sum(cents(r['balance_impact']) for r in late)==net,'late_movement_ids':[r['financial_movement_id'] for r in late]})
cutoff=datetime(2026,9,12,tzinfo=ARG)
before=[r for r in ledger if instant(r['occurred_at'])<cutoff]
actual=Decimal('471337.67')
out={'database_checked_at':snapshot['checked_at'],'timezone':'America/Argentina/Buenos_Aires','user_closing_reference':{'date':'2026-09-11','exclusive_cutoff':'2026-09-12T00:00:00-03:00','amount':float(actual)},'loaded_net_to_cutoff':sum(cents(r['balance_impact']) for r in before)/100,'unexplained_reference_minus_loaded_net':float(actual)-sum(cents(r['balance_impact']) for r in before)/100,'reports':reports,'cache_diagnosis':sorted(cache,key=lambda c:c['date'])}
(root/'source-reconciliation.json').write_text(json.dumps(out,ensure_ascii=False,indent=2),encoding='utf-8')
print(json.dumps({'reports':reports,'cache_last_days':out['cache_diagnosis'][-6:],'reference':out['user_closing_reference'],'unexplained':out['unexplained_reference_minus_loaded_net']},ensure_ascii=False))
