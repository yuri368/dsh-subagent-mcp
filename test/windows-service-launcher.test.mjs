import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {temporaryDirectory} from '../src/platform.mjs';

test('Windows hidden service launcher preserves Unicode/ampersand argv, cwd and nonzero daemon exit',
  {skip:process.platform !== 'win32',timeout:30000},()=>{
    const root=mkdtempSync(join(temporaryDirectory(),'dsh hidden 雪 & '));
    try {
      const runner=join(root,'fixture runner & 雪.mjs'),config=join(root,'config & 雪.json'),result=join(root,'result.json');
      writeFileSync(config,'{}');
      writeFileSync(runner,`import{writeFileSync}from'node:fs';writeFileSync(${JSON.stringify(result)},JSON.stringify({args:process.argv.slice(2),cwd:process.cwd()}));setTimeout(()=>process.exit(37),500);`);
      const script=fileURLToPath(new URL('../scripts/run-windows-service.ps1',import.meta.url));
      const system=process.env.SystemRoot || 'C:\\Windows';
      const child=spawnSync(join(system,'System32/WindowsPowerShell/v1.0/powershell.exe'),[
        '-NoLogo','-NoProfile','-NonInteractive','-WindowStyle','Hidden','-ExecutionPolicy','Bypass','-File',script,
        '-NodePath',process.execPath,'-Runner',runner,'-Config',config,'-WorkingDirectory',root,
      ],{windowsHide:true,encoding:'utf8',timeout:20000});
      assert.equal(child.error,undefined);
      assert.equal(child.status,37,child.stdout+child.stderr);
      const actual=JSON.parse(readFileSync(result,'utf8'));
      assert.deepEqual(actual.args,['--config',config,'--daemon']);
      assert.equal(actual.cwd,root);
    } finally {rmSync(root,{recursive:true,force:true});}
  });
