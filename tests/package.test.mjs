import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, copyFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { spawnSync } from 'node:child_process';
test('web package generator binds the remote endpoint and registered app without a local executor',()=>{
  const dir=mkdtempSync(join(tmpdir(),'ark-work-package-'));
  try {
    mkdirSync(join(dir,'scripts'));mkdirSync(join(dir,'plugin'));
    copyFileSync('scripts/configure-plugin.mjs',join(dir,'scripts/configure-plugin.mjs'));
    copyFileSync('plugin/plugin.template.json',join(dir,'plugin/plugin.template.json'));
    const script=join(dir,'scripts/configure-plugin.mjs');
    const invalid=spawnSync(process.execPath,[script,'--url','http://example.invalid','--app-id','plugin_asdk_app_test'],{encoding:'utf8'});
    assert.notEqual(invalid.status,0);
    const result=spawnSync(process.execPath,[script,'--url','https://work.example.invalid','--app-id','plugin_asdk_app_test'],{encoding:'utf8'});
    assert.equal(result.status,0,result.stderr);
    const json=p=>JSON.parse(readFileSync(join(dir,p),'utf8'));
    assert.equal(json('plugin/.app.json').apps['ark-work'].id,'plugin_asdk_app_test');
    const mcp=json('plugin/mcp.json').mcpServers['ark-work'];
    assert.equal(mcp.type,'streamable-http');assert.equal(mcp.url,'https://work.example.invalid/mcp');assert.equal(mcp.command,undefined);
    assert.equal(json('plugin/plugin.json').extensions['com.openai'].requires_local_executor,undefined);
    assert.equal(json('.agents/plugins/marketplace.json').plugins[0].source.path,'./plugin');
  } finally {assert.ok(resolve(dir).startsWith(resolve(tmpdir())+sep));rmSync(dir,{recursive:true,force:true});}
});
