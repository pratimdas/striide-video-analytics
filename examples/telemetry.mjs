import {performance} from 'node:perf_hooks';
import {randomUUID} from 'node:crypto';
import {appendFileSync,mkdirSync} from 'node:fs';
import {dirname} from 'node:path';

const sensitiveKey=/api.?key|authorization|password|secret|access.?token|refresh.?token|cookie|signed.?url/i;
export function redact(value,secrets=[]){
  if(Array.isArray(value))return value.map(v=>redact(v,secrets));
  if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([k,v])=>[k,sensitiveKey.test(k)?'[REDACTED]':redact(v,secrets)]));
  if(typeof value==='string'){
    let s=value;
    for(const secret of secrets)if(secret)s=s.split(secret).join('[REDACTED]');
    s=s.replace(/https?:\/\/[^\s"<>]+/g,match=>{try{const u=new URL(match);u.username='';u.password='';if(u.search)u.search='?redacted';u.hash='';return u.toString()}catch{return '[REDACTED_URL]'}});
    return s.slice(0,2000);
  }
  return value;
}

export class TraceRecorder{
  constructor({runId,outputFile=null,redactValues=[]}){
    this.runId=runId;this.traceId=randomUUID();this.started=performance.now();this.outputFile=outputFile;this.redactValues=redactValues;this.spans=[];
    if(outputFile)mkdirSync(dirname(outputFile),{recursive:true});
  }
  async span(name,attributes,fn,parentSpanId=null){
    const id=randomUUID(),start=performance.now(),startUtc=new Date().toISOString();
    const attrs={...attributes};let status='ok';
    const ctx={spanId:id,set:more=>Object.assign(attrs,more),child:(n,a,f)=>this.span(n,a,f,id)};
    try{return await fn(ctx)}
    catch(error){status=error?.name==='AbortError'?'cancelled':'error';attrs.error_type=error?.name||'Error';attrs.error_message=String(error?.message||error);throw error}
    finally{
      const end=performance.now();
      const record={event:'span_end',run_id:this.runId,trace_id:this.traceId,span_id:id,parent_span_id:parentSpanId,name,start_utc:startUtc,end_utc:new Date().toISOString(),start_offset_ms:start-this.started,end_offset_ms:end-this.started,duration_ms:end-start,status,attributes:redact(attrs,this.redactValues)};
      this.spans.push(record);if(this.outputFile)appendFileSync(this.outputFile,JSON.stringify(record)+'\n');
    }
  }
}

export function unionDuration(intervals){
  const sorted=intervals.filter(([s,e])=>e>=s).map(x=>[...x]).sort((a,b)=>a[0]-b[0]);
  let total=0,current=null;
  for(const [s,e] of sorted){if(!current)current=[s,e];else if(s<=current[1])current[1]=Math.max(current[1],e);else{total+=current[1]-current[0];current=[s,e]}}
  if(current)total+=current[1]-current[0];return total;
}

export function summarise(spans){
  const rows=spans.map(span=>{
    const children=spans.filter(c=>c.parent_span_id===span.span_id).map(c=>[Math.max(span.start_offset_ms,c.start_offset_ms),Math.min(span.end_offset_ms,c.end_offset_ms)]);
    return {...span,self_ms:Math.max(0,span.duration_ms-unionDuration(children))};
  });
  const roots=spans.filter(s=>s.parent_span_id===null);
  return {wall_time_ms:unionDuration(roots.map(s=>[s.start_offset_ms,s.end_offset_ms])),span_count:spans.length,failed_spans:spans.filter(s=>s.status==='error').length,rows};
}

export function costSummary(parts){
  const known=parts.filter(x=>typeof x.cost_usd==='number'&&Number.isFinite(x.cost_usd)&&x.cost_usd>=0);
  const missing=parts.filter(x=>!known.includes(x));
  return {currency:'USD',status:missing.length?(known.length?'partial':'unknown'):'estimated',known_subtotal_usd:known.length?known.reduce((n,p)=>n+p.cost_usd,0):null,unknown_components:missing.map(x=>x.name)};
}
