const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const {spawn} = require('node:child_process');
const {once} = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

test('duplicate startup recognizes the running app and handles an unrelated occupied port',async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(),'concreto-startup-'));
  const database = path.join(temp,'test.sqlite');
  let sameApp = true;
  const occupied = http.createServer((req,res) => {
    res.writeHead(200,{'Content-Type':'application/json'});
    res.end(JSON.stringify(sameApp ? {ok:true,engine:'SQLite (node:sqlite)',file:database} : {ok:false}));
  });
  occupied.listen(0); await once(occupied,'listening');
  const run = async () => {
    const child = spawn(process.execPath,['server.js'],{
      cwd:path.resolve(__dirname,'..'),env:{...process.env,PORT:String(occupied.address().port),DATABASE_PATH:database},windowsHide:true
    });
    let output='';
    child.stdout.on('data',data => {output+=data;});
    child.stderr.on('data',data => {output+=data;});
    const [code] = await once(child,'close');
    return {code,output};
  };
  try {
    const duplicate = await run();
    assert.equal(duplicate.code,0);
    assert.match(duplicate.output,/já está em execução/);
    assert.doesNotMatch(duplicate.output,/Unhandled|EADDRINUSE/);
    sameApp=false;
    const conflict=await run();
    assert.equal(conflict.code,1);
    assert.match(conflict.output,/ocupada por outra aplicação/);
    assert.doesNotMatch(conflict.output,/Unhandled|EADDRINUSE/);
  } finally { await new Promise(resolve => occupied.close(resolve)); }
});
