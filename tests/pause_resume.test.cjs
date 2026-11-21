// Whole API/Express/SQLite regression. External model transport is synthetic only.
const {test} = require('node:test');
const assert = require('node:assert/strict');
const {spawnSync} = require('node:child_process');
const path = require('node:path');
const source = process.env.REPOSREVIEW_SOURCE || path.resolve(__dirname, '..');
const worker = String.raw`
const fs=require('fs'), os=require('os'), path=require('path'), http=require('http'), assert=require('assert/strict');
const root=process.argv[1], mode=process.argv[2];
const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'reposreview-force-test-')); process.chdir(tmp);
let calls=[], releaseFirst; const firstGate=new Promise(resolve=>releaseFirst=resolve);
global.fetch=async(url,options)=>{
 assert.equal(url,'http://localhost:11434/api/generate');
 calls.push(JSON.parse(options.body));
 if(calls.length===1)await firstGate;
 return {ok:true,json:async()=>({response:'Synthetic revision '+calls.length})};
};
const cp=require('child_process');
for(const name of ['exec','execSync','spawn','spawnSync','execFile','execFileSync']) cp[name]=()=>{throw Error('External child commands prohibited')};
const express=require('express'), listen=express.application.listen;
let server;
express.application.listen=function(_port,cb){server=listen.call(this,0,'127.0.0.1',cb);return server};
require(path.join(root,'api-server.js'));
const pause=ms=>new Promise(r=>setTimeout(r,ms));
function request(method,url,body){return new Promise((resolve,reject)=>{
 const data=body?JSON.stringify(body):null;
 const req=http.request({host:'127.0.0.1',port:server.address().port,path:url,method,
 headers:data?{'content-type':'application/json','content-length':Buffer.byteLength(data)}:{}},res=>{
 let text='';res.on('data',b=>text+=b);res.on('end',()=>resolve({status:res.statusCode,body:JSON.parse(text)}));
 });req.on('error',reject);if(data)req.write(data);req.end();
})}
async function run(endpoint,repo,forceRefresh){
 const response=await request('POST',endpoint,{repos:[repo],forceRefresh});assert.equal(response.status,200);
 let status;
 if(response.body.jobId){
  for(let n=0;n<200;n++){status=await request('GET','/api/analysis/status/'+response.body.jobId);if(status.body.status.status==='completed')break;await pause(5)}
  assert.equal(status.body.status.status,'completed');assert.equal(status.body.status.progress,1);
 }
 return {response,status};
}
(async()=>{
 while(!server.listening)await pause(5);
 let next;
 const repos=['synthetic-first','synthetic-second'].map(name=>({name,readme_content:'Synthetic fixture'}));
 if(mode==='normal')releaseFirst();
 const created=await request('POST','/api/analysis/bulk',{repos:mode==='last'?repos.slice(0,1):repos});assert.equal(created.status,200);
 async function state(id){const r=await request('GET','/api/analysis/status/'+id);assert.equal(r.status,200);return r.body.status}
 async function until(id,wanted){let status;for(let n=0;n<200;n++){status=await state(id);if(status.status===wanted)return status;await pause(5)}assert.fail('Expected '+wanted+' got '+JSON.stringify(status))}
 while(!calls.length)await pause(5);
 if(mode!=='normal'){
  assert.equal((await request('POST','/api/analysis/pause',{})).status,200);
  if(mode==='inflight')assert.equal((await request('POST','/api/analysis/resume',{})).status,200);
  releaseFirst();
  if(mode==='drained'||mode==='queued'){
   const held=await until(created.body.jobId,'pending');assert.equal(held.progress,1);assert.equal(held.total,2);assert.equal(held.completedAt,null);assert.equal(calls.length,1);
   assert.equal((await request('GET','/api/analysis/cached/synthetic-second')).status,404);
   if(mode==='queued'){
    next=await request('POST','/api/analysis/bulk',{repos:[{name:'synthetic-later',readme_content:'Later fixture'}]});
    const pending=await state(next.body.jobId);assert.equal(pending.status,'pending');assert.equal(calls.length,1);
   }
   assert.equal((await request('POST','/api/analysis/resume',{})).status,200);
  }
 }
 const done=await until(created.body.jobId,'completed');
 assert.equal(done.progress,mode==='last'?1:2);assert.equal(done.results,done.progress);assert.equal(done.errors,0);
 if(mode==='last')assert.equal((await request('POST','/api/analysis/resume',{})).status,200);
 next=next||await request('POST','/api/analysis/bulk',{repos:[{name:'synthetic-later',readme_content:'Later fixture'}]});
 const later=await until(next.body.jobId,'completed');assert.equal(later.progress,1);
 assert.equal(calls.length,mode==='last'?2:3);
 for(const name of ['synthetic-first','synthetic-later',...(mode==='last'?[]:['synthetic-second'])])assert.equal((await request('GET','/api/analysis/cached/'+name)).status,200);
 const originalCount=calls.filter(x=>x.prompt.includes('Repository: synthetic-first\n')).length;assert.equal(originalCount,1);
 console.log('SCOPED_RESULT='+JSON.stringify({mode,calls:calls.length}));
 server.close(()=>{fs.rmSync(tmp,{recursive:true,force:true});process.exit(0)});
})().catch(error=>{console.error(error);if(server)server.close();fs.rmSync(tmp,{recursive:true,force:true});process.exit(1)});
`;
for(const mode of ['drained','queued','last','inflight','normal']){
 test('complete HTTP '+mode+' resumes unfinished work and permits later jobs',()=>{
  const result=spawnSync(process.execPath,['-e',worker,source,mode],{encoding:'utf8',timeout:20000});
  assert.equal(result.status,0,result.stdout+'\n'+result.stderr);
  assert.match(result.stdout,/SCOPED_RESULT=/);
 });
}
