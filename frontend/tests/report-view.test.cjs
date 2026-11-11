const test=require('node:test'),assert=require('node:assert/strict');
const {normalizeTask}=require('../lib/report-view.cjs');
test('OpenRouter in progress with result={} never reaches frames.filter',()=>{
 for(const result of [undefined,null,{}, {frames:null}, {frames:'bad'}]){
  const task=normalizeTask({provider:'openrouter',status:'processing',result});
  assert.equal(task.result,undefined);
  assert.deepEqual(task.result?.frames?.filter(f=>f.id)||[],[]);
 }
});
test('legacy and malformed report fields cannot crash the results view',()=>{
 const task=normalizeTask({status:'done',result:{summary:'Отчёт',frames:[null,{id:'s0',timestamp:null},{id:'p0',timestamp:1}],observations:{},readings:[null],objects:[{},null],plate_comparison:{variants:null}}});
 assert.equal(task.result.frames.length,2);assert.equal(task.result.frames[0].timestamp,null);
 assert.deepEqual(task.result.observations,[]);assert.deepEqual(task.result.plate_comparison.variants,[]);
 assert.deepEqual(normalizeTask({status:'done',result:{}}).result.frames,[]);
});
