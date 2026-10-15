import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { ArkClient } from '../dist/arkClient.js';
test('an ambiguous network failure never automatically retries a clinical write',async()=>{
  let writes=0,reads=0;
  const server=createServer(async(req,res)=>{
    for await(const chunk of req) { /* consume synthetic input */ }
    if(req.url==='/auth/signin'){res.setHeader('Content-Type','application/json');res.end(JSON.stringify({accessToken:'fake',refreshToken:'fake'}));return;}
    if(req.url==='/write'){writes++;req.socket.destroy();return;}
    reads++;req.socket.destroy();
  });
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const client=new ArkClient({baseUrl:`http://127.0.0.1:${server.address().port}`,tenant:'fake',username:'fake',password:'fake'});
  try{
    await assert.rejects(client.post('/write',{}));assert.equal(writes,1);
    await assert.rejects(client.putSearch('/read',{}));assert.equal(reads,3);
  }finally{await new Promise(r=>server.close(r));}
});
