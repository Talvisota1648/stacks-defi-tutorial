const test = require('node:test'), assert = require('node:assert/strict');
const ts = require('typescript');
require.extensions['.ts'] = (module, filename) => module._compile(ts.transpileModule(require('fs').readFileSync(filename, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText, filename);
const { normalizeRussianPlate, processModelResult, validInput, categories } = require('../lib/analysis.ts');
const frame = (id, timestamp=0) => ({ id, timestamp, image: `data:image/jpeg;base64,${Buffer.from(id).toString('base64')}`, kind: id.startsWith('p') ? 'plate' : 'scene', width: 160, height: 40 });
const input = { mediaType: 'video', duration: 8, categories, location: '', frames: [frame('s0',1),frame('p0',1),frame('s1',3),frame('p1',3),frame('s2',5),frame('p2',5)] };
const reading = (imageId, number, readability='readable') => ({ imageId, vehicleId: 'car', number, readability });
const raw = (readings=[],findings=[]) => ({ summary: 'Проверка', readings, findings });
const event = (overrides={}) => ({ category: categories[0],eventId:'park-1', eventType:'parking', assessment:'suspected_violation',description:'Автомобиль стоит на тротуаре.',observableEvidence:'Колёса автомобиля находятся на пешеходной дорожке.',requiresExternalVerification:true,confidence:'высокая',evidence:['s0'],...overrides });

test('Russian plates: lookalike alphabet, Cyrillic, no guessed 7/T or 0/O',()=>{
 assert.equal(normalizeRussianPlate('t540cx790'),'Т540СХ790');assert.equal(normalizeRussianPlate('Т 540 СХ 790'),'Т540СХ790');
 assert.equal(normalizeRussianPlate('7540cx199'),''); assert.equal(normalizeRussianPlate('Т54ОСХ790'),'');assert.equal(normalizeRussianPlate('Т540СХ?90'),'');
});
test('photo input with or without native crop; invalid limits and mismatched evidence',()=>{
 assert(validInput({...input,mediaType:'photo',duration:0,frames:[frame('s0'),frame('p0')]}));
 assert(validInput({...input,mediaType:'photo',duration:0,frames:[frame('s0')]}));
 assert(!validInput({...input,mediaType:'photo',duration:0,frames:[frame('s0'),frame('s1')]}));
 assert(!validInput({...input,frames:[frame('s0'),frame('p0',2)]}));
 assert(!validInput({...input,frames:[frame('s0'),frame('s0')]}));
 assert(!validInput({...input,frames:[{...frame('s0'),width:0}]}));
});
test('distinct crop readings agree; missing frame stays unreadable and never inherits a number',()=>{
 const r=processModelResult(raw([reading('p0','T540CX790'),reading('p1','Т540СХ790')]),input);
 assert.equal(r.plates[0].status,'agreement');assert.equal(r.plates[0].number,'Т540СХ790');
 assert.deepEqual(r.plates[0].readings.find(r=>r.imageId==='p2'),{imageId:'p2',vehicleId:'selected-vehicle',number:'',readability:'unreadable'});
 assert.equal(r.findings.length,0);
});
test('conflicting regions are not majority-voted or marked high confidence',()=>{
 const r=processModelResult(raw([reading('p0','Т540СХ790'),reading('p1','Т540СХ790'),reading('p2','Т540СХ199')]),input);
 assert.equal(r.plates[0].status,'conflict');assert.equal(r.plates[0].number,'');assert.equal(r.plates[0].alternatives.length,2);
});
test('uncertain, invalid and identical images cannot create agreement',()=>{
 const one=processModelResult(raw([reading('p0','Т540СХ790','uncertain'),reading('p1','Т540СХ790','uncertain')]),input);assert.equal(one.plates[0].status,'single');
 const bad=processModelResult(raw([reading('p0','7540cx199')]),input);assert.equal(bad.plates[0].status,'unreadable');
 const clone={...input,frames:input.frames.map(f=>f.id==='p1'?{...f,image:input.frames[1].image}:f)};
 assert.equal(processModelResult(raw([reading('p0','Т540СХ790'),reading('p1','Т540СХ790')]),clone).plates[0].status,'single');
});
test('context cannot supply crop readings and duplicated readings are rejected',()=>{
 assert.throws(()=>processModelResult(raw([reading('s0','Т540СХ790')]),input));
 assert.throws(()=>processModelResult(raw([reading('p0','Т540СХ790'),reading('p0','Т540СХ790')]),input));
});
test('tow truck transport is not a violation even if model flags it',()=>{
 const tow=event({description:'Эвакуатор перевозит повреждённую машину.',observableEvidence:'Повреждённый автомобиль на платформе эвакуатора.',eventType:'traffic'});
 assert.equal(processModelResult(raw([], [tow]),input).findings.length,0);
 assert.equal(processModelResult(raw([], [event({assessment:'ordinary_activity'})]),input).findings.length,0);
 assert.equal(processModelResult(raw([], [event({assessment:'insufficient_evidence'})]),input).findings.length,0);
});
test('a separate tow-truck dumping action can be reviewed; repeated event merges evidence',()=>{
 const e=event({eventType:'waste',description:'Эвакуатор сбрасывает мусор.',observableEvidence:'Виден сброс отходов с платформы.'});
 const r=processModelResult(raw([], [e,{...e,evidence:['s1']}]),input);
 assert.equal(r.findings.length,1);assert.deepEqual(r.findings[0].evidence,['s0','s1']);assert.equal(r.findings[0].timestamp,1);assert.equal(r.findings[0].confidence,'низкая');
});
test('unsupported model evidence is rejected rather than silently attached',()=>{
 assert.throws(()=>processModelResult(raw([], [event({evidence:['s99']})]),input));
 assert.throws(()=>processModelResult(raw([], [event({evidence:['p0']})]),input));
});
