import test from 'node:test';
import assert from 'node:assert/strict';
import { argentinaDate, argentinaPeriod, moneyCents, summarizeLedger, collectPages, shiftDate } from '../src/lib/mercadopago-calculations.ts';

test('el cierre argentino incluye 02:59:59.999 UTC del día siguiente y excluye 03:00', () => {
  const {start,endExclusive}=argentinaPeriod('2026-09-11','2026-09-11');
  assert.equal(new Date(start).toISOString(),'2026-09-11T03:00:00.000Z');
  assert.equal(new Date(endExclusive).toISOString(),'2026-09-12T03:00:00.000Z');
  const dates=['2026-09-11T02:59:59.999Z','2026-09-11T03:00:00Z','2026-09-12T02:59:59.999Z','2026-09-12T03:00:00Z'];
  assert.deepEqual(dates.map(d=>new Date(d)>=new Date(start)&&new Date(d)<new Date(endExclusive)),[false,true,true,false]);
  assert.equal(argentinaDate(new Date('2026-09-12T02:30:00Z')),'2026-09-11');
});
test('los períodos validan fechas y cruzan años y febrero correctamente', () => {
  assert.equal(shiftDate('2024-02-28',1),'2024-02-29');
  assert.equal(shiftDate('2026-12-31',1),'2027-01-01');
  assert.throws(()=>argentinaPeriod('2026-09-12','2026-09-11'));
  assert.throws(()=>argentinaPeriod('2026-02-30','2026-03-01'));
});
test('el neto incluye transferencias y no cuenta rendimientos dos veces', () => {
  const result=summarizeLedger([{balance_impact:'100.10',category:'income'},{balance_impact:'-20.05',category:'transfer'}, {balance_impact:'5.01',category:'transfer'}, {balance_impact:'0.03',category:'interest_income'},{balance_impact:'-1.02',category:'expense'}]);
  assert.deepEqual(result,{balance:84.07,ingresos:105.11,egresos:21.07,rendimientos:0.03,total_movimientos:5});
  assert.equal(moneyCents(result.balance),moneyCents(result.ingresos)+moneyCents(result.rendimientos)-moneyCents(result.egresos));
  assert.equal(moneyCents('-0.03'),-3);
  assert.throws(()=>moneyCents('invalid'));
  assert.throws(()=>moneyCents('0.001'));
});
test('lee más de mil registros aunque el servidor devuelva páginas más pequeñas', async () => {
  const all=Array.from({length:1201},(_,id)=>({id}));
  const result=await collectPages(async (from,to)=>({data:all.slice(from,Math.min(to+1,from+200)),error:null,count:all.length}));
  assert.deepEqual(result,all);
});
test('no presenta totales parciales cuando cambian los datos o falla una página', async () => {
  await assert.rejects(collectPages(async from=>({data:from?[]:[{id:1}],error:null,count:2})),/todos/);
  await assert.rejects(collectPages(async from=>({data:[{id:1}],error:null,count:from?3:2})),/cambiaron/);
  await assert.rejects(collectPages(async ()=>({data:null,error:{message:'network failed'},count:null})),/network/);
});
