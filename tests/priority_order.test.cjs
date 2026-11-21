// Actual full HTTP queue ordering with deterministic in-flight transport gate.
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {spawnSync}=require('node:child_process');
const path=require('node:path');
const source=process.env.REPOSREVIEW_SOURCE||path.resolve(__dirname,'..');
const worker=String.raw`
const fs=require('fs'),os=require('os'),path=require('path'),http=require('http'),assert=require('assert/strict');
const root=process.argv[1], mode=process.argv[2];
const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'reposreview-priority-test-'));process.chdir(tmp);
let calls=[],release;const gate=new Promise(resolve=>release=resolve);
global.fetch=async(url,options)=>{
 assert.equal(url,'http://localhost:11434/api/generate');const body=JSON.parse(options.body);
 calls.push(body);if(calls.length===1)await gate;
 return {ok:true,json:async()=>({response:'Synthetic ordering fixture'})};
};
const cp=require('child_process');for(const name of ['exec','execSync','spawn','spawnSync','execFile','execFileSync'])cp[name]=()=>{throw Error('External commands prohibited')};
require('https').request=()=>{throw Error('External HTTPS prohibited')};
const express=require('express'),listen=express.application.listen;let server;
express.application.listen=function(_port,callback){server=listen.call(this,0,'127.0.0.1',callback);return server};
const originalRequest=http.request;http.request=(options,...rest)=>{assert.equal(options.host,'127.0.0.1');assert.equal(options.port,server.address().port);return originalRequest(options,...rest)};
require(path.join(root,'api-server.js'));
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
function request(method,url,body){return new Promise((resolve,reject)=>{
 const data=body?JSON.stringify(body):null;
 const req=http.request({host:'127.0.0.1',port:server.address().port,path:url,method,headers:data?{'content-type':'application/json','content-length':Buffer.byteLength(data)}:{}},response=>{
  let text='';response.on('data',chunk=>text+=chunk);response.on('end',()=>resolve({status:response.statusCode,body:JSON.parse(text)}));
 });req.on('error',reject);if(data)req.write(data);req.end();
})}
async function submit(name,priority){const body={repos:[{name,readme_content:'Synthetic fixture'}]};if(priority!==undefined)body.priority=priority;const result=await request('POST','/api/analysis/bulk',body);assert.equal(result.status,200);assert.ok(result.body.jobId);return result.body.jobId}
(async()=>{
 while(!server.listening)await wait(5);
 const jobs=[await submit('synthetic-inflight','normal')];while(!calls.length)await wait(5);
 let entries,expected;
 if(mode==='priority'){
  entries=[['synthetic-normal','normal'],['synthetic-high','high'],['synthetic-low','low']];expected=['synthetic-inflight','synthetic-high','synthetic-normal','synthetic-low'];
 }else if(mode==='high-fifo'){
  entries=[['synthetic-high-first','high'],['synthetic-normal','normal'],['synthetic-high-second','high']];expected=['synthetic-inflight','synthetic-high-first','synthetic-high-second','synthetic-normal'];
 }else{
  entries=[['synthetic-normal-first','normal'],['synthetic-default',undefined],['synthetic-normal-last','normal'],['synthetic-low','low']];expected=['synthetic-inflight',...entries.map(entry=>entry[0])];
 }
 for(const [name,priority]of entries){jobs.push(await submit(name,priority));await wait(5)}
 for(const job of jobs.slice(1)){const status=await request('GET','/api/analysis/status/'+job);assert.equal(status.body.status.status,'pending')}
 assert.equal(calls.length,1,'no pending job preempts in-flight work');release();
 for(let tries=0;tries<200;tries++){
  const statuses=await Promise.all(jobs.map(job=>request('GET','/api/analysis/status/'+job)));
  if(statuses.every(value=>value.body.status.status==='completed'))break;
  await wait(5);
 }
 for(const job of jobs){const status=await request('GET','/api/analysis/status/'+job);assert.equal(status.body.status.status,'completed');assert.equal(status.body.status.progress,1);assert.equal(status.body.status.results,1);assert.equal(status.body.status.errors,0)}
 assert.deepEqual(calls.map(call=>call.prompt.match(/Repository: (.*)/)[1]),expected);
 console.log('SCOPED_RESULT='+JSON.stringify({mode,expected}));server.close(()=>{fs.rmSync(tmp,{recursive:true,force:true});process.exit(0)});
})().catch(error=>{console.error(error);if(server)server.close();fs.rmSync(tmp,{recursive:true,force:true});process.exit(1)});
`;
for(const mode of ['priority','high-fifo','normal-fifo']){
 test('full HTTP pending priority '+mode+' and nonpreemption',()=>{
  const result=spawnSync(process.execPath,['-e',worker,source,mode],{encoding:'utf8',timeout:20000});
  assert.equal(result.status,0,result.stdout+'\n'+result.stderr);assert.match(result.stdout,/SCOPED_RESULT=/);
 });
}
