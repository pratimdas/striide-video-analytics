import test from 'node:test';
import assert from 'node:assert/strict';
import {TraceRecorder,redact,unionDuration,summarise,costSummary} from './telemetry.mjs';

test('overlap is counted once',()=>assert.equal(unionDuration([[0,10],[5,15],[20,25]]),20));
test('self time subtracts child interval union',()=>{
 const s=[{span_id:'root',parent_span_id:null,start_offset_ms:0,end_offset_ms:100,duration_ms:100},{span_id:'a',parent_span_id:'root',start_offset_ms:10,end_offset_ms:60,duration_ms:50},{span_id:'b',parent_span_id:'root',start_offset_ms:30,end_offset_ms:80,duration_ms:50}];
 const result=summarise(s);assert.equal(result.wall_time_ms,100);assert.equal(result.rows[0].self_ms,30);
});
test('failed operations are timed and rethrown',async()=>{
 const trace=new TraceRecorder({runId:'test'});
 await assert.rejects(trace.span('failure',{},async()=>{throw new Error('expected')}),/expected/);
 assert.equal(trace.spans.length,1);assert.equal(trace.spans[0].status,'error');assert.ok(trace.spans[0].duration_ms>=0);
});
test('children preserve parent relationships',async()=>{
 const trace=new TraceRecorder({runId:'test'});
 await trace.span('root',{},async c=>{await c.child('child',{},async()=>1)});
 const root=trace.spans.find(s=>s.name==='root'),child=trace.spans.find(s=>s.name==='child');assert.equal(child.parent_span_id,root.span_id);
});
test('secrets are redacted without losing token usage',()=>{
 const value=redact({api_key:'secret',input_tokens:100,nested:{message:'token=abc123',url:'https://x.test/a?key=abc123'}},['abc123']);
 assert.equal(value.api_key,'[REDACTED]');assert.equal(value.input_tokens,100);assert.ok(!JSON.stringify(value).includes('abc123'));assert.ok(!value.nested.url.includes('key='));
});
test('unknown cost remains unknown',()=>assert.deepEqual(costSummary([{name:'pegasus',cost_usd:null}]),{currency:'USD',status:'unknown',known_subtotal_usd:null,unknown_components:['pegasus']}));
test('known subtotal is not called complete when prices are missing',()=>{
 const cost=costSummary([{name:'a',cost_usd:.02},{name:'b',cost_usd:null}]);assert.equal(cost.status,'partial');assert.equal(cost.known_subtotal_usd,.02);
});
