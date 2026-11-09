import {TraceRecorder,summarise,costSummary} from './telemetry.mjs';
import {writeFileSync,mkdirSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {join,dirname} from 'node:path';
const out=join(dirname(fileURLToPath(import.meta.url)),'demo-output');mkdirSync(out,{recursive:true});
const trace=new TraceRecorder({runId:'local-telemetry-demo',outputFile:join(out,'trace.jsonl')});
const wait=ms=>new Promise(r=>setTimeout(r,ms));
await trace.span('demo.run',{fixture:true,provider_calls:0},async root=>{
 await root.child('demo.prepare',{fixture:true},()=>wait(20));
 await Promise.all([root.child('demo.parallel_a',{fixture:true},()=>wait(30)),root.child('demo.parallel_b',{fixture:true},()=>wait(40))]);
});
const result={notice:'Telemetry exercise only. No video analysis or provider calls.',...summarise(trace.spans),cost:costSummary([{name:'live_analysis',cost_usd:null}])};
writeFileSync(join(out,'summary.json'),JSON.stringify(result,null,2));
console.log(JSON.stringify({notice:result.notice,wall_time_ms:result.wall_time_ms,span_count:result.span_count,cost:result.cost},null,2));
