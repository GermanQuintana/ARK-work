import assert from 'node:assert/strict';
import { test, before, after } from 'node:test';
import { randomBytes, createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { createServer as netServer } from 'node:net';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createApp } from '../dist/app.js';
import { Store } from '../dist/store.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

let service, listener, upstream, base, ark, clientInfo;
const callback='https://chatgpt.com/connector_platform_oauth_redirect';
const read='ark:read',write='ark:write';
const freePort=async()=>{const s=netServer();await new Promise(r=>s.listen(0,'127.0.0.1',r));const port=s.address().port;await new Promise(r=>s.close(r));return port;};
const jsonPost=(url,data,extra={})=>fetch(url,{method:'POST',headers:{'Content-Type':'application/json',...extra},body:JSON.stringify(data),redirect:'manual'});
const formPost=(url,data,extra={})=>fetch(url,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded',...extra},body:new URLSearchParams(data),redirect:'manual'});
before(async()=>{
  upstream=createServer(async(req,res)=>{
    const chunks=[];for await(const chunk of req)chunks.push(chunk);
    res.setHeader('Content-Type','application/json');
    if(req.url==='/ark/rest/auth/signin'){
      const body=JSON.parse(Buffer.concat(chunks).toString());
      if(body.password!=='fake-password'){res.writeHead(401);res.end('{}');return;}
      res.end(JSON.stringify({accessToken:'ARK-'+body.tenant,refreshToken:'fake'}));return;
    }
    if(req.url==='/ark/rest/empresas/findEmpresaPrincipal'){
      res.end(JSON.stringify({nombre:'Empresa '+String(req.headers.authorization).replace('Bearer ARK-','')}));return;
    }
    res.writeHead(404);res.end('{}');
  });
  await new Promise(r=>upstream.listen(0,'127.0.0.1',r));
  ark=new URL(`http://127.0.0.1:${upstream.address().port}/ark/rest`);
  base=new URL(`http://127.0.0.1:${await freePort()}`);
  service=createApp({publicUrl:base,arkUrl:ark,encryptionKey:randomBytes(32),dbPath:':memory:',redirects:new Set([callback]),allowLocalHttp:true});
  listener=service.app.listen(Number(base.port),'127.0.0.1');
  await new Promise(r=>listener.once('listening',r));
  const response=await jsonPost(new URL('/register',base),{redirect_uris:[callback],token_endpoint_auth_method:'none',grant_types:['authorization_code','refresh_token'],response_types:['code']});
  assert.equal(response.status,201);clientInfo=await response.json();
});
after(async()=>{await new Promise(r=>listener.close(r));await new Promise(r=>upstream.close(r));service.close();});

async function begin(scopes=read){
  const verifier=randomBytes(40).toString('base64url');
  const challenge=createHash('sha256').update(verifier).digest('base64url');
  const url=new URL('/authorize',base);
  url.search=new URLSearchParams({response_type:'code',client_id:clientInfo.client_id,redirect_uri:callback,scope:scopes,state:'test-state',code_challenge:challenge,code_challenge_method:'S256',resource:new URL('/mcp',base).href}).toString();
  const response=await fetch(url,{redirect:'manual'});assert.equal(response.status,302);
  const cookie=response.headers.get('set-cookie').split(';')[0];
  const login=new URL(response.headers.get('location'),base);
  const html=await (await fetch(login,{headers:{Cookie:cookie}})).text();
  const csrf=html.match(/name="csrf" value="([^"]+)"/)[1];
  return {verifier,cookie,login,csrf};
}
async function authorize(tenant,scopes=read,allowWrite=false){
  const flow=await begin(scopes);
  const response=await formPost(flow.login,{tenant,username:'test-user',password:'fake-password',csrf:flow.csrf,...(allowWrite?{write:'yes'}:{})},{Cookie:flow.cookie,Origin:base.origin});
  assert.equal(response.status,302);
  const target=new URL(response.headers.get('location'));assert.equal(target.searchParams.get('state'),'test-state');
  return {...flow,code:target.searchParams.get('code')};
}
async function exchange(flow,overrides={}){
  return formPost(new URL('/token',base),{grant_type:'authorization_code',client_id:clientInfo.client_id,code:flow.code,code_verifier:flow.verifier,redirect_uri:callback,resource:new URL('/mcp',base).href,...overrides});
}
async function connect(token){
  const client=new Client({name:'ark-work-test',version:'1.0.0'});
  await client.connect(new StreamableHTTPClientTransport(new URL('/mcp',base),{requestInit:{headers:{Authorization:'Bearer '+token}}}));
  return client;
}

test('MCP refuses anonymous access and advertises OAuth discovery',async()=>{
  const response=await jsonPost(new URL('/mcp',base),{});
  assert.equal(response.status,401);assert.match(response.headers.get('www-authenticate'),/resource_metadata/);
  const meta=await (await fetch(new URL('/.well-known/oauth-authorization-server',base))).json();
  assert.deepEqual(meta.code_challenge_methods_supported,['S256']);assert.ok(meta.registration_endpoint);
});
test('arbitrary callback registrations and foreign origins are blocked',async()=>{
  const response=await jsonPost(new URL('/register',base),{redirect_uris:['https://evil.example/callback'],token_endpoint_auth_method:'none'});
  assert.equal(response.status,400);
  assert.equal((await jsonPost(new URL('/mcp',base),{},{Origin:'https://evil.example'})).status,403);
});
test('login requires the browser cookie, same-origin POST and CSRF token',async()=>{
  const flow=await begin();
  const bad=await formPost(flow.login,{tenant:'A',username:'x',password:'fake-password',csrf:'wrong'},{Cookie:flow.cookie,Origin:base.origin});
  assert.equal(bad.status,403);
  const noCookie=await fetch(flow.login);assert.equal(noCookie.status,400);
  const wrongPassword=await formPost(flow.login,{tenant:'A',username:'x',password:'wrong',csrf:flow.csrf},{Cookie:flow.cookie,Origin:base.origin});
  assert.equal(wrongPassword.status,401);assert.doesNotMatch(await wrongPassword.text(),/wrong|fake-password/);
});
test('PKCE, audience and single-use authorization codes are enforced',async()=>{
  const flow=await authorize('PKCE');
  assert.equal((await exchange(flow,{code_verifier:'incorrect-verifier'})).status,400);
  assert.equal((await exchange(flow,{resource:'https://evil.example/mcp'})).status,400);
  assert.equal((await exchange(flow)).status,200);
  assert.equal((await exchange(flow)).status,400);
});
test('two clinic connections cannot read each other and profiles survive reconnect',async()=>{
  const a=await (await exchange(await authorize('A'))).json();
  const b=await (await exchange(await authorize('B'))).json();
  const ca=await connect(a.access_token),cb=await connect(b.access_token);
  try{
    const [ra,rb]=await Promise.all([ca.callTool({name:'ark_empresa',arguments:{}}),cb.callTool({name:'ark_empresa',arguments:{}})]);
    assert.match(ra.content[0].text,/Empresa A/);assert.doesNotMatch(ra.content[0].text,/Empresa B/);
    assert.match(rb.content[0].text,/Empresa B/);
    const pa=await ca.callTool({name:'get_profile',arguments:{}}),pb=await cb.callTool({name:'get_profile',arguments:{}});
    assert.notEqual(pa.structuredContent.id,pb.structuredContent.id);
    const again=await (await exchange(await authorize('A'))).json();
    const cc=await connect(again.access_token);
    try{assert.equal((await cc.callTool({name:'get_profile',arguments:{}})).structuredContent.id,pa.structuredContent.id);}finally{await cc.close();}
  }finally{await ca.close();await cb.close();}
});
test('read-only consent hides writes; explicit write consent exposes preview tools',async()=>{
  const a=await (await exchange(await authorize('READ',read+' '+write,false))).json();
  const b=await (await exchange(await authorize('WRITE',read+' '+write,true))).json();
  const ca=await connect(a.access_token),cb=await connect(b.access_token);
  try{
    const ta=(await ca.listTools()).tools,tb=(await cb.listTools()).tools;
    assert.equal(ta.length,34);assert.equal(tb.length,40);
    assert.ok(!ta.some(t=>t.name==='ark_crear_compra'));
    assert.ok(tb.some(t=>t.name==='ark_crear_compra'&&t.annotations.readOnlyHint===false));
    assert.equal((await ca.callTool({name:'ark_crear_compra',arguments:{confirmar:true}})).isError,true);
  }finally{await ca.close();await cb.close();}
});
test('refresh tokens rotate, replay revokes the family and client revocation works',async()=>{
  const tokens=await (await exchange(await authorize('ROTATE'))).json();
  const refresh=async(token)=>formPost(new URL('/token',base),{grant_type:'refresh_token',refresh_token:token,client_id:clientInfo.client_id,resource:new URL('/mcp',base).href});
  const rotated=await (await refresh(tokens.refresh_token)).json();assert.ok(rotated.access_token);
  assert.equal((await refresh(tokens.refresh_token)).status,400);
  assert.equal((await jsonPost(new URL('/mcp',base),{},{Authorization:'Bearer '+rotated.access_token})).status,401);
  const fresh=await (await exchange(await authorize('REVOKE'))).json();
  assert.equal((await formPost(new URL('/revoke',base),{client_id:clientInfo.client_id,token:fresh.access_token})).status,200);
  assert.equal((await jsonPost(new URL('/mcp',base),{},{Authorization:'Bearer '+fresh.access_token})).status,401);
});
test('profile secrets are encrypted on disk and cannot be transplanted between records',()=>{
  const dir=mkdtempSync(join(tmpdir(),'ark-work-test-'));const path=join(dir,'profiles.sqlite');
  const key=randomBytes(32),db=new Store(path,key);
  db.put('profile','one',{password:'DO-NOT-PERSIST-PLAINTEXT'});assert.equal(db.get('profile','one').password,'DO-NOT-PERSIST-PLAINTEXT');
  const raw=new DatabaseSync(path);
  const encrypted=raw.prepare('SELECT value FROM records WHERE ns=? AND k=?').get('profile','one').value;
  raw.prepare('INSERT INTO records VALUES (?,?,?,?)').run('profile','two',encrypted,0);
  raw.close();assert.throws(()=>db.get('profile','two'));
  db.close();
  assert.ok(!readFileSync(path).includes(Buffer.from('DO-NOT-PERSIST-PLAINTEXT')));
  const reopened=new Store(path,key);assert.equal(reopened.get('profile','one').password,'DO-NOT-PERSIST-PLAINTEXT');reopened.close();
  const wrong=new Store(path,randomBytes(32));assert.throws(()=>wrong.get('profile','one'));wrong.close();
  rmSync(dir,{recursive:true,force:true});
});
test('production settings refuse HTTP and missing redirect allowlists',()=>{
  const settings={publicUrl:new URL('http://127.0.0.1'),arkUrl:ark,dbPath:':memory:',encryptionKey:randomBytes(32),redirects:new Set([callback])};
  assert.throws(()=>createApp(settings),/HTTPS/);
  assert.throws(()=>createApp({...settings,publicUrl:new URL('https://work.example'),arkUrl:new URL('https://ark.example/rest'),redirects:new Set()}),/redirect/);
});
