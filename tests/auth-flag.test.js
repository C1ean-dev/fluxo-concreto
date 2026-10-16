const test = require('node:test');
const assert = require('node:assert/strict');
const {spawn} = require('node:child_process');
const {once} = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

test('email login is off by default, remains off with Resend configured, and can be enabled explicitly',async () => {
  const project = path.resolve(__dirname,'..');
  const temp = fs.mkdtempSync(path.join(os.tmpdir(),'concreto-auth-flag-'));
  try {
    for(const flag of ['', 'false', 'true']){
      const env = {...process.env,PORT:'0',HOST:'127.0.0.1',DATABASE_PATH:path.join(temp,(flag || 'default')+'.sqlite'),AUTH_EMAIL_ENABLED:flag,AUTH_REQUIRED:'true',RESEND_API_KEY:'test-only',NODE_ENV:'test'};
      for(const key of ['DATABASE_URL','DATABASE_PUBLIC_URL','PGHOST']) delete env[key];
      env.DB_CLIENT='sqlite';
      const child = spawn(process.execPath,['-e',"process.loadEnvFile=()=>{};const server=require('./server');server.ready.then(()=>console.log('TEST_PORT='+server.address().port));"],{cwd:project,env,windowsHide:true});
      let output='';
      child.stderr.on('data',data=>{output+=data;});
      const closed=once(child,'close');
      try {
        const port = await new Promise((resolve,reject)=>{
          const timer=setTimeout(()=>reject(new Error('Server startup timeout: '+output)),15000);
          child.stdout.on('data',data=>{
            output+=data;
            const match=output.match(/TEST_PORT=(\d+)/);
            if(match){clearTimeout(timer);resolve(match[1]);}
          });
          child.once('error',error=>{clearTimeout(timer);reject(error);});
          child.once('exit',()=>{clearTimeout(timer);reject(new Error('Server exited: '+output));});
        });
        const base='http://127.0.0.1:'+port;
        const options={redirect:'manual'};
        const root=await fetch(base+'/',options);
        const login=await fetch(base+'/login.html',options);
        const bank=await fetch(base+'/banco.html',options);
        if(flag === 'true'){
          assert.equal(root.status,302);
          assert.equal(root.headers.get('location'),'/login.html');
          assert.equal(bank.status,302);
          assert.equal(login.status,200);
        } else {
          assert.equal(root.status,200);
          assert.equal(bank.status,200);
          assert.equal(login.status,302);
          assert.equal(login.headers.get('location'),'/');
          for(const endpoint of ['send-code','verify-otp']){
            const response=await fetch(base+'/api/auth/'+endpoint,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:'teste@falcaobauer.com.br',otp:'123456'})});
            assert.equal(response.status,403);
            assert.match((await response.json()).error,/desativado/);
          }
          const magic=await fetch(base+'/api/auth/verify-magic?token=unused',options);
          assert.equal(magic.status,302);
          assert.equal(magic.headers.get('location'),'/');
          const me=await (await fetch(base+'/api/auth/me')).json();
          assert.equal(me.enabled,false);
          assert.equal(me.authenticated,false);
          assert.equal(me.user,null);
          assert.doesNotMatch(output,/AUTH TEST\/DEV/,'Disabled access must not issue any email');
        }
      } finally {child.kill();await closed;}
    }
  } finally {
    const resolved=path.resolve(temp);
    if(path.dirname(resolved)===path.resolve(os.tmpdir()) && path.basename(resolved).startsWith('concreto-auth-flag-')) fs.rmSync(resolved,{recursive:true,force:true});
  }
});
