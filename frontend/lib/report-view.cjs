const list=v=>Array.isArray(v)?v:[];
const str=v=>typeof v==='string'?v:'';
function normalizeTask(task){
 if(!task||typeof task!=='object'||Array.isArray(task))return null;
 const result=task.result;
 if(['queued','processing','failed'].includes(task.status))return {...task,result:undefined};
 if(!result||typeof result!=='object'||Array.isArray(result))return {...task,result:undefined};
 const frames=list(result.frames).filter(f=>f&&typeof f.id==='string'&&/^[asp]\d+$/.test(f.id)).map(f=>({...f,timestamp:typeof f.timestamp==='number'&&Number.isFinite(f.timestamp)?f.timestamp:null}));
 return {...task,result:{...result,summary:str(result.summary),model:str(result.model),frames,observations:list(result.observations).filter(o=>o&&typeof o.description==='string').map(o=>({...o,frame_id:str(o.frame_id),suspected_violation:o.suspected_violation===true})),objects:list(result.objects).filter(o=>o&&typeof o.label==='string'&&Number.isFinite(o.score)),readings:list(result.readings).filter(r=>r&&typeof r.frame_id==='string'&&typeof r.number==='string'),plate_comparison:result.plate_comparison&&typeof result.plate_comparison==='object'?{...result.plate_comparison,variants:list(result.plate_comparison.variants).filter(v=>typeof v==='string')}:undefined}};
}
module.exports={normalizeTask};
