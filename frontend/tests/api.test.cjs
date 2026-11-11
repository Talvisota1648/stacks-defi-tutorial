const test=require('node:test'),assert=require('node:assert/strict'),ts=require('typescript');
require.extensions['.ts']=(m,f)=>m._compile(ts.transpileModule(require('fs').readFileSync(f,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020}}).outputText,f);
const handler=require('../pages/api/analyze.ts').default;
test('obsolete public analysis endpoint cannot make a paid provider request',()=>{
 const r={status(code){this.code=code;return this},setHeader(){},json(body){this.body=body;return this}};
 handler({method:'POST'},r);assert.equal(r.code,410);assert.match(r.body.error,/manual/);
});
