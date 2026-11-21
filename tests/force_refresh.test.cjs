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
let calls=[];
global.fetch=async(url,options)=>{
 assert.equal(url,'http://localhost:11434/api/generate');
 calls.push(JSON.parse(options.body));
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
 const repo={name:'synthetic-refresh',readme_content:'Synthetic original',languages:{Python:100}};
 await run('/api/analysis/bulk',repo,false);assert.equal(calls.length,1);
 const ordinary=await run('/api/analysis/bulk',repo,false);assert.equal(ordinary.response.body.jobId,null);assert.equal(calls.length,1);
 if(mode==='ordinary'){
  await run('/api/analysis/bulk',{...repo,readme_content:'Synthetic changed'},false);assert.equal(calls.length,2);
 }else{
  const endpoint=mode==='all'?'/api/analysis/all':'/api/analysis/bulk';
  const forced=await run(endpoint,repo,true);assert.ok(forced.response.body.jobId);assert.equal(calls.length,2);
  const cached=await request('GET','/api/analysis/cached/'+repo.name);assert.equal(cached.status,200);
  assert.equal(cached.body.analysis.analysis,'Synthetic revision 2');
  const after=await run(endpoint,repo,false);assert.equal(after.response.body.jobId,null);assert.equal(calls.length,2);
 }
 console.log('SCOPED_RESULT='+JSON.stringify({mode,calls:calls.length}));
 server.close(()=>{fs.rmSync(tmp,{recursive:true,force:true});process.exit(0)});
})().catch(error=>{console.error(error);if(server)server.close();fs.rmSync(tmp,{recursive:true,force:true});process.exit(1)});
`;
for(const mode of ['bulk','all','ordinary']){
 test('complete HTTP '+mode+' preserves explicit refresh and ordinary cache intent',()=>{
  const result=spawnSync(process.execPath,['-e',worker,source,mode],{encoding:'utf8',timeout:20000});
  assert.equal(result.status,0,result.stdout+'\n'+result.stderr);
  assert.match(result.stdout,/SCOPED_RESULT=/);
 });
}
