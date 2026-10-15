const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const P = require('../js/ai-pipeline');
function browser(){
  const elements = new Map(), storage = new Map();
  const element = key => {
    if(!elements.has(key)) elements.set(key,{innerHTML:'',textContent:'',value:'',dataset:{},style:{},hidden:true,
      classList:{add(){},remove(){},toggle(){}},addEventListener(){},focus(){},setAttribute(){},getAttribute(){return 'false';},
      querySelector:s => element(s),querySelectorAll:() => []});
    return elements.get(key);
  };
  const context = vm.createContext({console,Symbol,URL,Blob,Map,Set,WeakMap,Date,JSON,Number,Math,
    document:{querySelector:element,getElementById:element,querySelectorAll:() => [],addEventListener(){},body:element('body')},
    localStorage:{getItem:k => storage.get(k)||null,setItem:(k,v) => storage.set(k,v)},
    navigator:{clipboard:{writeText:async () => {}}},window:{},
    setTimeout:() => 1,clearTimeout(){},confirm:() => true,
    fetch:async () => ({ok:false,json:async () => ({ok:false,error:'Offline'})})});
  for(const file of ['js/tabelas-k.js','js/formulas.js','js/ai-pipeline.js','js/config.js','js/app.js']){
    let source = fs.readFileSync(path.join(__dirname,'..',file),'utf8');
    if(file.endsWith('app.js')) source = source.replace(/renderBoard\(\);\s*syncFromSqlite\(\);\s*$/,'');
    vm.runInContext(source,context,{filename:file});
  }
  const run = code => vm.runInContext(code,context);
  run("estado.cards = [criarCard('TEST','analise',{...IDENT_PLACA_113},criarCps(DADOS_PLACA_113.slice(0,3)))]; renderBoard();");
  return {context,run,storage,elements};
}
const ticks = async () => { for(let i=0;i<5;i++) await new Promise(resolve => setImmediate(resolve)); };

test('card dropdown filters data errors, model errors, below minimum, overdue and negative reports', () => {
  const b=browser();
  assert.equal(b.run("filtroAtual='errors'; matches(estado.cards[0])"),false);
  assert.equal(b.run("estado.cards[0].aiAnalysis={status:'erro'}; matches(estado.cards[0])"),true);
  assert.equal(b.run("estado.cards[0].aiAnalysis=null; estado.cards[0].cps[0].h[0]=120; matches(estado.cards[0])"),true);
  b.run('estado.cards[0].cps[0].h[0]=144.86');
  assert.equal(b.run("filtroAtual='below'; matches(estado.cards[0])"),false);
  assert.equal(b.run("estado.cards[0].cps.forEach(cp=>cp.carga=6); matches(estado.cards[0])"),true);
  assert.equal(b.run("filtroAtual='late'; estado.cards[0].stage='aguardando'; estado.cards[0].ident.dataProjecao='2000-01-01'; matches(estado.cards[0])"),true);
  assert.equal(b.run("estado.cards[0].ident.dataProjecao='2099-01-01'; matches(estado.cards[0])"),false);
  assert.equal(b.run("filtroAtual='negative'; estado.cards[0].aiAnalysis={status:'concluido',verdict:'nao_conforme'}; matches(estado.cards[0])"),true);
  assert.equal(b.run("estado.cards[0].aiAnalysis.status='erro'; matches(estado.cards[0])"),false);
  assert.equal(b.run("filtroAtual='all'; textoBusca='inexistente'; matches(estado.cards[0])"),false);
});

test('waiting ages show deadline status using the Sao Paulo date and exclude received results', () => {
  const b=browser();
  b.run("estado.cards[0].ident.dataProjecao='2026-10-01'; estado.cards[0].notified={};");
  const status = time => b.run(`ageDeadlineStatus(estado.cards[0],7,{ages:{}},new Date('${time}')).label`);
  assert.equal(status('2026-10-07T12:00:00Z'),'Em prazo');
  assert.equal(status('2026-10-08T12:00:00Z'),'Alerta');
  assert.equal(status('2026-10-09T01:00:00Z'),'Alerta');
  assert.equal(status('2026-10-09T12:00:00Z'),'Atrasado');
  assert.equal(b.run("ageDeadlineStatus(estado.cards[0],7,{ages:{7:{media:30}}}).label"),'Resultado disponível');
  b.run("estado.cards[0].notified[7]='2026-10-08';");
  assert.equal(b.run("ageDeadlineStatus(estado.cards[0],7,{ages:{}}).label"),'Notificado');
  b.run("estado.cards[0].ident.dataProjecao='';");
  assert.equal(b.run("ageDeadlineStatus(estado.cards[0],28,{ages:{}}).label"),'Sem data prevista');
});
function network(b, {choice='conforme',failure=false,delay=false}={}){
  const calls=[]; let resolveDecision;
  b.context.fetch = async (url,options) => {
    const body = JSON.parse(options.body); calls.push({url,body});
    if(url.includes('/decision/')){
      if(delay) await new Promise(resolve => {resolveDecision=resolve;});
      if(failure) return {ok:false,json:async () => ({ok:false,error:'Serviço indisponível'})};
      return {ok:true,json:async () => ({ok:true,decision:{status:'concluido',verdict:choice,model:body.config.decision.model,generatedAt:'2026-10-13T12:00:00Z',probabilities:{[choice]:1},inputKey:P.inputKey(body.card,body.config,'decision')}})};
    }
    return {ok:true,json:async () => ({ok:true,analysis:{status:'concluido',verdict:'conforme',model:body.config.ai.model,summary:'Resultados disponíveis atendem.',content:'## Parecer\nResultados disponíveis atendem. [CONFORME]',inputKey:P.inputKey(body.card,body.config,'ai')}})};
  };
  return {calls,release:() => resolveDecision()};
}

test('automatic classification and report run before notification, for every class',async () => {
  for(const choice of ['conforme','atencao','nao_conforme']){
    const b = browser(), n = network(b,{choice});
    assert.equal(b.run("gateChecks(estado.cards[0],'ia')[0].ok"),false);
    b.run('runAnalysis(estado.cards[0])'); await ticks();
    assert.deepEqual(n.calls.map(c => c.url),['/api/decision/analyze','/api/ai/analyze']);
    assert.equal(b.run('estado.cards[0].stage'),'notificar');
    assert.equal(b.run('estado.cards[0].decisionAnalysis.verdict'),choice);
    assert.equal(b.run("gateChecks(estado.cards[0],'notificar').every(c => c.ok)"),true);
    assert.equal(b.run('estado.cards[0].notified[3]'),undefined);
  }
});

test('below minimum requires adjustment confirmation before classification',async () => {
  const b = browser(), n = network(b,{choice:'nao_conforme'});
  b.run('estado.cards[0].cps.forEach(cp => cp.carga=6); runAnalysis(estado.cards[0])');
  assert.equal(b.run('estado.cards[0].stage'),'ajuste'); assert.equal(n.calls.length,0);
  assert.equal(b.run("tryMove('TEST','decision')"),false);
  b.run("estado.cards[0].adjust[3]={hash:assinaturaDaIdade(estado.cards[0],3),note:'Medições conferidas'}");
  assert.equal(b.run("tryMove('TEST','decision')"),true); await ticks();
  assert.equal(n.calls.length,2); assert.equal(b.run('estado.cards[0].stage'),'notificar');
});

test('failed or incomplete LLM report remains in the LLM stage without notifying',async () => {
  for(const invalid of [false,true]){
    const b=browser(); network(b);
    const original = b.context.fetch;
    b.context.fetch = async (url,options) => {
      if(url === '/api/ai/analyze'){
        if(!invalid) return {ok:false,json:async () => ({ok:false,error:'Falha no modelo'})};
        const body=JSON.parse(options.body);
        return {ok:true,json:async () => ({ok:true,analysis:{status:'concluido',content:'',inputKey:P.inputKey(body.card,body.config,'ai')}})};
      }
      return original(url,options);
    };
    b.run('runAnalysis(estado.cards[0])'); await ticks();
    assert.equal(b.run('estado.cards[0].stage'),'ia');
    assert.equal(b.run('estado.cards[0].aiAnalysis.status'),'erro');
    assert.equal(b.run('estado.cards[0].notified[3]'),undefined);
  }
});

test('failed decision stays in classification and can be retried',async () => {
  const b=browser(), n=network(b,{failure:true});
  b.run('runAnalysis(estado.cards[0])'); await ticks();
  assert.equal(n.calls.length,1); assert.equal(b.run('estado.cards[0].stage'),'decision');
  assert.equal(b.run('estado.cards[0].decisionAnalysis.status'),'erro');
  const retry=network(b); await b.run('triggerDecisionAnalysis(estado.cards[0])'); await ticks();
  assert.equal(retry.calls.length,2);
});

test('missing classification route reports server recovery instead of a JSON syntax error',async () => {
  const b = browser();
  b.context.fetch = async () => new Response('Arquivo não encontrado: /api/decision/analyze', {
    status:404,headers:{'Content-Type':'text/plain; charset=utf-8'}
  });
  b.run('runAnalysis(estado.cards[0])'); await ticks();
  const error = b.run('estado.cards[0].decisionAnalysis.error');
  assert.doesNotMatch(error,/Unexpected token|not valid JSON/);
  assert.match(error,/servidor.*atualizado|reinicie.*servidor/i);
  assert.equal(b.run('estado.cards[0].stage'),'decision');
});

test('editing during a request discards stale responses and invalidates dependent results',async () => {
  const b=browser(), n=network(b,{delay:true});
  b.run('runAnalysis(estado.cards[0]); estado.cards[0].cps[0].carga+=1; save()');
  n.release(); await ticks();
  assert.equal(n.calls.length,1);
  assert.equal(b.run('estado.cards[0].decisionAnalysis.status'),'desatualizado');
  const retry=network(b); await b.run('triggerDecisionAnalysis(estado.cards[0])'); await ticks();
  assert.equal(retry.calls.length,2);
  b.run("estado.cards[0].stage='ia'; estado.config.ai.promptSystem+=' Revisão'; save()");
  assert.equal(b.run('estado.cards[0].aiAnalysis.status'),'desatualizado');
  assert.equal(b.run('estado.cards[0].stage'),'ia');
  assert.equal(b.run('AiPipeline.validDecision(estado.cards[0],estado.config)'),true);
  b.run("estado.config.decision.instructions+=' Nova revisão'; save()");
  assert.equal(b.run('estado.cards[0].decisionAnalysis.status'),'desatualizado');
  assert.equal(b.run('estado.cards[0].stage'),'decision');
});

test('configuration migration preserves prompts; browser and server requests match; reload offers retry',async () => {
  const b=browser();
  const migrated = JSON.parse(b.run("JSON.stringify(cfgMigrate({sets:cfgFixedSets(),active:'planilha',ai:{promptSystem:'Personalizado',userInstructions:'Instruções antigas'}}))"));
  assert.equal(migrated.ai.promptSystem,'Personalizado'); assert.equal(migrated.ai.userInstructions,'Instruções antigas');
  assert.equal(migrated.decision.model,'microsoft/microsoft-decision-1');
  const snapshot=JSON.parse(b.run('JSON.stringify({card:estado.cards[0],config:estado.config})'));
  assert.equal(b.run('JSON.stringify(AiPipeline.buildDecisionRequest(estado.cards[0],estado.config))'),JSON.stringify(P.buildDecisionRequest(snapshot.card,snapshot.config)));
  assert.equal(b.run('evaluate(estado.cards[0]).ages[3].media'),P.technicalData(snapshot.card,snapshot.config).ageSummary[0].mediaMPa);
  b.run("estado.cards[0].stage='decision'; estado.cards[0].decisionAnalysis={status:'aguardando'}; save(); estado=load()");
  assert.equal(b.run('estado.cards[0].decisionAnalysis.status'),'erro');
  assert.match(b.run('estado.cards[0].decisionAnalysis.error'),/interrompida/);
  b.run("estado.cards[0].stage='finalizado'; estado.cards[0].aiAnalysis={status:'concluido',inputKey:'historical',content:'Parecer antigo'}; save()");
  assert.equal(b.run('estado.cards[0].aiAnalysis.content'),'Parecer antigo');
});
