const test=require('node:test'),assert=require('node:assert/strict'),ts=require('typescript');
require.extensions['.ts']=(module,file)=>module._compile(ts.transpileModule(require('fs').readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020}}).outputText,file);
const handler=require('../pages/api/analyze.ts').default;
const data='data:image/jpeg;base64,YQ==';
const input={mediaType:'photo',duration:0,location:'',categories:['Автомобили и парковка'],frames:[{id:'s0',timestamp:0,kind:'scene',width:100,height:50,image:data},{id:'p0',timestamp:0,kind:'plate',width:50,height:15,image:data}]};
async function call(body,method='POST'){const res={code:200,setHeader(){},status(code){this.code=code;return this},json(body){this.body=body;return this}};await handler({body,method},res);return res;}
test('API performs one OpenRouter call with scene and crop and validates response',async()=>{
 const originalFetch=global.fetch,originalKey=process.env.OPENROUTER_API_KEY;let count=0;
 process.env.OPENROUTER_API_KEY='test-only';
 global.fetch=async(url,options)=>{count++;assert.equal(url,'https://openrouter.ai/api/v1/chat/completions');const b=JSON.parse(options.body);assert.equal(b.messages[1].content.filter(c=>c.type==='image_url').length,2);return {ok:true,json:async()=>({choices:[{message:{content:JSON.stringify({summary:'Нарушений нет.',findings:[],readings:[{imageId:'p0',vehicleId:'selected-vehicle',number:'T540CX790',readability:'readable'}]})}}]})};};
 try{const r=await call(input);assert.equal(r.code,200);assert.equal(count,1);assert.equal(r.body.plates[0].number,'Т540СХ790');assert.equal(r.body.plates[0].status,'single');assert.equal(r.body.findings.length,0);}
 finally{global.fetch=originalFetch;if(originalKey===undefined)delete process.env.OPENROUTER_API_KEY;else process.env.OPENROUTER_API_KEY=originalKey;}
});
test('API malformed requests, rate limits and malformed provider outputs',async()=>{
 const originalFetch=global.fetch,originalKey=process.env.OPENROUTER_API_KEY;process.env.OPENROUTER_API_KEY='test-only';
 try{
  assert.equal((await call({...input,frames:[]})).code,400);
  assert.equal((await call(input,'DELETE')).code,405);
  global.fetch=async()=>({ok:false,status:429});assert.equal((await call(input)).code,502);
  global.fetch=async()=>({ok:true,json:async()=>({choices:[{message:{content:'{"summary":"x","findings":[]}'}}]})});assert.equal((await call(input)).code,502);
  delete process.env.OPENROUTER_API_KEY;assert.equal((await call(input)).code,503);
 }finally{global.fetch=originalFetch;if(originalKey===undefined)delete process.env.OPENROUTER_API_KEY;else process.env.OPENROUTER_API_KEY=originalKey;}
});
