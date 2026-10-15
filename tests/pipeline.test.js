const test = require('node:test');
const assert = require('node:assert/strict');
const P = require('../js/ai-pipeline');
const {FORM_DEFAULT} = require('../js/formulas');
const {classifyCard,analyzeCardWithAi} = require('../ai');
process.env.OPENROUTER_API_KEY = 'test-only';
const card = () => ({id:'TEST',ident:{placa:'113',fck:35,interessado:'Teste',custom:'extra'},coefA:1.0024,coefB:0.0299,criterio:'media',adjust:{3:{note:'Conferido'}},cps:[{n:1,idade:3,h:[144.86,144.17,144.7],d:[74.76,74.75],massa:1.381,carga:11.88,sentido:'Mesmo do lançamento',cura:'Úmida'}]});
const settings = () => ({formulas:{...FORM_DEFAULT},ai:P.config('ai',{model:'test/llm',fallbackModels:[]}),decision:P.config('decision')});
const response = value => ({ok:true,json:async () => value});
const decisionReply = choice => ({model:'microsoft/microsoft-decision-1',answers:{conformidade:{type:'choice',choice,confidence:0.8,probabilities:{conforme:0.8,atencao:0.1,nao_conforme:0.1}}}});

test('notification uses the actual suggestion section and the full report without that section', () => {
  for(const title of ['## 5. Sugestão de Texto Técnico para a Notificação ao Cliente','**4. Sugestão para Notificação**','5. Sugestão de e-mail ao cliente','Sugestão de Texto Técnico para a Notificação ao Cliente']){
    const parts = P.notificationParts('## Resumo executivo\nParecer técnico detalhado.\n\n'+title+'\n**Assunto:** Resultado\nPrezados, seguem os resultados.\n1. Resultados recebidos.\nAtenciosamente, equipe.\n\n## Referências\nDados do projeto.');
    assert.match(parts.suggestion,/Prezados, seguem os resultados/);
    assert.match(parts.suggestion,/1\. Resultados recebidos/);
    assert.doesNotMatch(parts.suggestion,/Dados do projeto/);
    assert.match(parts.report,/Parecer técnico detalhado/);
    assert.match(parts.report,/Dados do projeto/);
    assert.doesNotMatch(parts.report,/Sugestão|Prezados|Atenciosamente/);
  }
  assert.deepEqual(P.notificationParts('## Parecer\nDados analisados.'),{report:'Parecer\nDados analisados.',suggestion:''});
  assert.equal(P.notificationParts('## Sugestão para Notificação\n"Prezados, resultado recebido."').suggestion,'Prezados, resultado recebido.');
});

test('quoted customer email excludes the report author footer and strips citation markers', () => {
  const parts = P.notificationParts('## Parecer técnico\nAnálise detalhada.\n\n## 5. Sugestão de Texto Técnico para a Notificação ao Cliente\n> Prezado(a) Sr(a). [Nome do Cliente],\n>\n> Informamos os resultados da placa RT-115.\n>\n> Atenciosamente,\n> [Nome da Equipe Técnica]\n> Projeto Placa RT-115 – NF 000115\n\nElaborado por:\nEngenheiro Civil especialista\nData da análise: 13/10/2026');
  assert.equal(parts.suggestion,'Prezado(a) Sr(a). [Nome do Cliente],\n\nInformamos os resultados da placa RT-115.\n\nAtenciosamente,\n[Nome da Equipe Técnica]\nProjeto Placa RT-115 – NF 000115');
  assert.doesNotMatch(parts.suggestion,/Elaborado por|Data da análise|>/);
  assert.match(parts.report,/Análise detalhada/);
  assert.match(parts.report,/Elaborado por/);
});

test('LLM defaults analyze without reclassification and preserve custom prompts', () => {
  const defaults = P.config('ai');
  assert.match(defaults.promptSystem,/Não emita uma nova classificação nem um veredito próprio/);
  assert.match(defaults.userInstructions,/classificação recebida/);
  const custom = P.config('ai',{promptSystem:'Meu prompt personalizado',userInstructions:'Minha estrutura'});
  assert.equal(custom.promptSystem,'Meu prompt personalizado');
  assert.equal(custom.userInstructions,'Minha estrutura');
  const oldInstructions = 'Estruture sua resposta nas 4 seções a seguir:\n1. Resumo Executivo e Veredito Geral ([CONFORME], [ATENÇÃO] ou [NÃO CONFORME])\n2. Avaliação de Resistências à Compressão vs Limites de Projeto (3, 7 e 28 dias) — inclua tabela comparativa em Markdown\n3. Análise de Consistência Dimensional, Massas e Fatores de Correção (k1 a k4)\n4. Sugestão de Texto Técnico para a Notificação ao Cliente';
  assert.equal(P.config('ai',{userInstructions:oldInstructions}).userInstructions,defaults.userInstructions);
});

test('partial ages, custom formulas, individual criteria and pinned tables use the same calculation engine', () => {
  const c = card(), cfg = settings();
  const data = P.technicalData(c,cfg);
  assert.equal(data.ageSummary[0].atende,true);
  assert.equal(data.ageSummary[1].ensaiado,false);
  assert.equal(data.ageSummary[1].atende,null);
  cfg.formulas.fci = '10';
  assert.equal(P.technicalData(c,cfg).ageSummary[0].mediaMPa,10);
  assert.equal(P.technicalData(c,cfg).ageSummary[0].atende,false);
  c.cfgSnap = {...P.calculationTables(c,settings()),formulas:{...FORM_DEFAULT,fci:'20'}};
  assert.equal(P.technicalData(c,cfg).ageSummary[0].mediaMPa,20);
  delete c.cfgSnap;
  c.cps.push({...c.cps[0],n:2,carga:4});
  cfg.formulas = {...FORM_DEFAULT};
  assert.equal(P.technicalData(c,cfg).ageSummary[0].atende,true);
  c.criterio = 'individual';
  assert.equal(P.technicalData(c,cfg).ageSummary[0].atende,false);
});

test('requests respect groups, templates and all compatible parameters', () => {
  const c = card(), cfg = settings();
  cfg.decision.dataGroups.mix = false;
  cfg.decision.dataFormat = 'text';
  const decision = P.buildDecisionRequest(c,cfg);
  assert.equal(typeof decision.state,'string');
  assert.equal(JSON.parse(decision.state).mix,undefined);
  assert.equal(decision.questions.conformidade.type,'choice');
  assert.equal(decision.temperature,undefined);
  cfg.ai.userTemplate = '{{placa}} {{cardId}} {{dados}} {{instrucoes}} {{observacao}}';
  cfg.ai.dataGroups.measurements = false;
  cfg.ai.temperature = 0.7; cfg.ai.maxTokens = 123;
  const request = P.buildAiRequest(c,cfg,'Observação de teste');
  assert.equal(request.temperature,0.7); assert.equal(request.max_tokens,123);
  assert.match(request.messages[1].content,/113 TEST/);
  assert.match(request.messages[1].content,/Observação de teste/);
  assert.doesNotMatch(request.messages[1].content,/"measurements"/);
  assert.match(request.messages[1].content,/Classificação pendente/);
  assert.ok(P.validate('ai',{userTemplate:'{{desconhecida}}'}).length);
  assert.ok(P.validate('decision',{criteria:{conforme:''}}).length);
});

test('all decision classes feed the LLM, and execution sends the exact preview body',async () => {
  for(const choice of ['conforme','atencao','nao_conforme']){
    const c = card(), cfg = settings(), calls = [];
    const fetchImpl = async (url,options) => {
      calls.push({url,body:JSON.parse(options.body)});
      return response(url.endsWith('/decisions') ? decisionReply(choice) : {model:'test/llm',choices:[{message:{content:'## Resumo executivo\nParecer técnico completo para o ensaio. [CONFORME]'}}]});
    };
    c.decisionAnalysis = await classifyCard(c,{config:cfg,fetchImpl});
    assert.deepEqual(calls[0].body,P.buildDecisionRequest(c,cfg));
    const expected = P.buildAiRequest(c,cfg);
    const report = await analyzeCardWithAi(c,'',{config:cfg,fetchImpl});
    assert.deepEqual(calls[1].body,expected);
    assert.equal(report.decision.classe,choice);
    assert.equal(report.verdict,choice, 'The report retains the decision class regardless of LLM wording');
    assert.match(expected.messages[1].content,new RegExp(choice));
    assert.equal(P.validDecision(c,cfg),true);
    c.cps[0].carga += 1;
    await assert.rejects(analyzeCardWithAi(c,'',{config:cfg,fetchImpl}),/classificação válida/);
    assert.equal(calls.length,2);
  }
});

test('invalid responses, HTTP errors, and timeout produce actionable errors',async () => {
  const c = card(), cfg = settings();
  await assert.rejects(classifyCard(c,{config:cfg,fetchImpl:async () => response({answers:{conformidade:{type:'choice',choice:'unknown'}}})}),/classificação inválida/);
  await assert.rejects(classifyCard(c,{config:cfg,fetchImpl:async () => ({ok:false,status:429})}),/HTTP 429/);
  cfg.decision.timeoutSeconds = 1;
  await assert.rejects(classifyCard(c,{config:cfg,fetchImpl:async (_,options) => new Promise((resolve,reject) => options.signal.addEventListener('abort',() => reject(Object.assign(new Error(),{name:'AbortError'}))))}),/Tempo limite/);
});

test('LLM retries the same free model after 5, 10 and 15 seconds and stops on success',async () => {
  const c = card(), cfg = settings(), models=[], delays=[];
  c.decisionAnalysis = await classifyCard(c,{config:cfg,fetchImpl:async () => response(decisionReply('conforme'))});
  cfg.ai.fallbackModels = ['test/backup'];
  const report = await analyzeCardWithAi(c,'',{config:cfg,sleepImpl:async ms => delays.push(ms),fetchImpl:async (_,options) => {
    const model = JSON.parse(options.body).model; models.push(model);
    if(models.length === 1) return {ok:false,status:503};
    if(models.length === 2) return response({choices:[{message:{content:''}}]});
    if(models.length === 3) throw Object.assign(new Error(),{name:'AbortError'});
    return response({model,choices:[{message:{content:'## Parecer\nOs resultados disponíveis atendem ao projeto. [CONFORME]'}}]});
  }});
  assert.deepEqual(models,Array(4).fill('openrouter/free'));
  assert.deepEqual(delays,[5000,10000,15000]);
  assert.equal(report.model,'openrouter/free');
  assert.equal(P.config('ai',{model:'other',timeoutSeconds:10,fallbackModels:['other']}).timeoutSeconds,60);
});

test('LLM returns error only after exhausting retries and makes no retry after success',async () => {
  const c=card(),cfg=settings();
  c.decisionAnalysis = await classifyCard(c,{config:cfg,fetchImpl:async () => response(decisionReply('conforme'))});
  let calls=0; const delays=[];
  await assert.rejects(analyzeCardWithAi(c,'',{config:cfg,sleepImpl:async ms => delays.push(ms),fetchImpl:async () => {calls++;return {ok:false,status:503};}}),/HTTP 503/);
  assert.equal(calls,4); assert.deepEqual(delays,[5000,10000,15000]);
  calls=0;delays.length=0;
  await analyzeCardWithAi(c,'',{config:cfg,sleepImpl:async ms => delays.push(ms),fetchImpl:async () => {calls++;return response({choices:[{message:{content:'## Parecer técnico\nAnálise dos resultados disponíveis concluída.'}}]});}});
  assert.equal(calls,1);assert.deepEqual(delays,[]);
});
