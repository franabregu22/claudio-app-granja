import test from 'node:test';
import assert from 'node:assert/strict';
import { releaseIdentityIndex, classifyReleaseIdentity } from '../netlify/functions/lib/mp-release-identity.ts';

test('una observación con otra hora no duplica la misma referencia', () => {
  const index=releaseIdentityIndex([{id:8958,external_reference:null,settlement_amount:77532,mp_movement_source_link:[{mp_source_record:{source_external_id:'178284169630'}},{mp_source_record:{source_external_id:'178284169630'}}]}]);
  assert.equal(classifyReleaseIdentity(index,'178284169630','payment',7753200),'duplicate');
  assert.equal(classifyReleaseIdentity(index,'178284169630','payment',7753201),'conflict');
  assert.equal(classifyReleaseIdentity(index,'178284169630','reserve_for_payment',-7753200),'raw');
  assert.equal(classifyReleaseIdentity(index,'another-id','payment',7753200),'new');
});
test('dos movimientos para la misma referencia requieren revisión', () => {
  const index=releaseIdentityIndex([{id:1,external_reference:'same',settlement_amount:10},{id:2,external_reference:'same',settlement_amount:10}]);
  assert.equal(classifyReleaseIdentity(index,'same','payment',1000),'conflict');
});
