// Full Express/QueueManager/SQLite ordinary-cache consumer, no real model transport.
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {spawnSync}=require('node:child_process');
const path=require('node:path');
const crypto=require('node:crypto');
const source=process.env.REPOSREVIEW_SOURCE||path.resolve(__dirname,'..');
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
require('https').request=()=>{throw Error('External HTTPS prohibited')};
const originalRequest=http.request;http.request=(options,...rest)=>{assert.equal(options.host,'127.0.0.1');assert.equal(options.port,server.address().port);return originalRequest(options,...rest)};
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
 const FileHasher=require(path.join(root,'utils/file_hasher'));
 const repo={name:'synthetic-language',description:'Synthetic fixture',readme_content:'Synthetic original',languages:{Python:100,JavaScript:50},size:1};
 await run('/api/analysis/bulk',repo,false);assert.equal(calls.length,1);
 assert.ok(calls[0].prompt.includes('Languages: Python, JavaScript'));
 const ordinary=await run('/api/analysis/bulk',repo,false);assert.equal(ordinary.response.body.jobId,null);assert.equal(calls.length,1);
 const changed={...repo,languages: mode==='name'?{Python:100,TypeScript:50}:mode==='bytes'?{Python:101,JavaScript:50}:{JavaScript:50,Python:100}};
 const next=await run('/api/analysis/bulk',changed,false);
 if(mode==='order'){
  assert.equal(FileHasher.calculateHash(repo),FileHasher.calculateHash(changed));
  assert.equal(next.response.body.jobId,null);assert.equal(calls.length,1);
 }else{
  assert.notEqual(FileHasher.calculateHash(repo),FileHasher.calculateHash(changed));
  assert.ok(next.response.body.jobId);assert.equal(calls.length,2);
  if(mode==='name')assert.ok(calls[1].prompt.includes('Languages: Python, TypeScript'));
  const cached=await request('GET','/api/analysis/cached/'+repo.name);
  assert.equal(cached.body.analysis.analysis,'Synthetic revision 2');
 }
 const again=await run('/api/analysis/bulk',changed,false);assert.equal(again.response.body.jobId,null);
 const before=calls.length;
 await run('/api/analysis/bulk',{...changed,readme_content:'Changed synthetic README'},false);assert.equal(calls.length,before+1);
 console.log('SCOPED_RESULT='+JSON.stringify({mode,calls:calls.length}));
 server.close(()=>{fs.rmSync(tmp,{recursive:true,force:true});process.exit(0)});
})().catch(error=>{console.error(error);if(server)server.close();fs.rmSync(tmp,{recursive:true,force:true});process.exit(1)});
`;
for(const mode of ['name','bytes','order']){
 test('ordinary full HTTP cache respects nested language '+mode,()=>{
  const result=spawnSync(process.execPath,['-e',worker,source,mode],{encoding:'utf8',timeout:20000});
  assert.equal(result.status,0,result.stdout+'\n'+result.stderr);
  assert.match(result.stdout,/SCOPED_RESULT=/);
 });
}
test('included scalar fields, defaults, quick hash and model policies stay unchanged',()=>{
 const Hasher=require(path.join(source,'utils/file_hasher'));
 const repo={name:'synthetic-controls',description:'original',updated_at:'synthetic-time',languages:{},size:1,default_branch:'main',readme_content:'original',file_count:1};
 const original=Hasher.calculateHash(repo);
 for(const [key,value] of Object.entries({name:'other',description:'changed',updated_at:'other-time',size:2,default_branch:'other',readme_content:'changed',file_count:2})){
  assert.notEqual(original,Hasher.calculateHash({...repo,[key]:value}),key);
 }
 const hashInput={name:'',description:'',updated_at:'',languages:{},size:0,default_branch:'main',readme_snippet:'',file_count:0};
 const legacy=crypto.createHash('sha256').update(JSON.stringify(hashInput,Object.keys(hashInput).sort())).digest('hex');
 assert.equal(Hasher.calculateHash({}),legacy);
 assert.equal(Hasher.calculateHash({languages:undefined}),legacy);
 assert.equal(Hasher.calculateHash({readme_content:'x'.repeat(1000)+'a'}),Hasher.calculateHash({readme_content:'x'.repeat(1000)+'b'}));
 assert.equal(Hasher.calculateQuickHash('n','t',1),crypto.createHash('sha256').update('n|t|1').digest('hex'));
 assert.equal(Hasher.selectOptimalModel({size:1}),'gemma2-32k');
 assert.equal(Hasher.selectOptimalModel({size:101}),'llama3-32k');
 assert.equal(Hasher.selectOptimalModel({size:501}),'qwen-128k');
});
