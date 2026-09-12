import csv,json
from pathlib import Path
from decimal import Decimal
from datetime import datetime,timezone,timedelta
from collections import defaultdict
ARG=timezone(timedelta(hours=-3))
def ts(x): return datetime.fromisoformat(x.replace('Z','+00:00')).astimezone(ARG).isoformat()
def amount(x): return int(Decimal(str(x or '0'))*100)
d=json.loads(Path('outputs/mp-reconciliation/database-snapshot.json').read_text())['data']
events={}
def add(sid,date,desc,credit,debit,source):
    if not date.startswith('2026-09') or desc not in ('payment','payout','asset_management'):return
    value=amount(credit)-amount(debit)
    key=(sid,ts(date),desc,value)
    if key not in events:events[key]={'source_id':sid,'date':ts(date),'description':desc,'cents':value,'evidence':[]}
    events[key]['evidence'].append(source)
for r in csv.DictReader(Path('data/mercadopago/Liberaciones3.csv').read_text(encoding='utf-8-sig').splitlines(),delimiter=';'):
    add(r['SOURCE_ID'],r['DATE'],r['DESCRIPTION'],r['NET_CREDIT_AMOUNT'],r['NET_DEBIT_AMOUNT'],'Liberaciones3.csv')
for r in d['sources']:
    if r.get('release_date'):add(r['source_external_id'],r['release_date'],r['release_description'],r['release_credit'],r['release_debit'],f"mp_source_record:{r['id']}")
db=[m for m in d['movements'] if m['transaction_date'].startswith('2026-09')]
matches=[];unmatched=[];used=set()
for e in events.values():
    exact=[m for m in db if ts(m['transaction_date'])==e['date'] and amount(m['settlement_amount'])==e['cents']]
    candidates=exact or [m for m in db if m['transaction_date'][:10]==e['date'][:10] and amount(m['settlement_amount'])==e['cents'] and abs((datetime.fromisoformat(ts(m['transaction_date']))-datetime.fromisoformat(e['date'])).total_seconds())<=300]
    if candidates:
        used.update(m['id'] for m in candidates)
        matches.append({**e,'movement_ids':[m['id'] for m in candidates],'exact':bool(exact)})
    else:unmatched.append(e)
out={'source_events':len(events),'source_net':sum(e['cents'] for e in events.values())/100,'database_events':len(db),'database_net':sum(amount(m['settlement_amount']) for m in db)/100,'source_unmatched':unmatched,'multiple_matches':[m for m in matches if len(m['movement_ids'])>1],'database_unmatched':[m for m in db if m['id'] not in used],'source_implied_closing':(7136290+sum(e['cents'] for e in events.values()))/100,'matches':matches}
Path('outputs/mp-reconciliation/september-comparison.json').write_text(json.dumps(out,indent=2))
print(json.dumps({k:v for k,v in out.items() if k!='matches'},indent=2))
