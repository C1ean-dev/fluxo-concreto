/* OpenRouter transport. Request builders are shared with the browser. */
if (typeof process.loadEnvFile === 'function') { try { process.loadEnvFile(); } catch {} }
const Pipeline = require('./js/ai-pipeline');
const OPENROUTER_CONFIG = {
  MODEL: process.env.OPENROUTER_MODEL || 'openrouter/free',
  TIMEOUT_SECONDS: Number(process.env.OPENROUTER_TIMEOUT_SECONDS || 60),
  TEMPERATURE: Number(process.env.OPENROUTER_TEMPERATURE || 0.2),
  MAX_TOKENS: Math.min(Number(process.env.OPENROUTER_MAX_TOKENS || 15000),8000)
};
function settingsOf(options={}) {
  const settings = options.config || {};
  return {...settings, ai:Pipeline.config('ai', {
    model:OPENROUTER_CONFIG.MODEL, timeoutSeconds:OPENROUTER_CONFIG.TIMEOUT_SECONDS,
    temperature:OPENROUTER_CONFIG.TEMPERATURE, maxTokens:OPENROUTER_CONFIG.MAX_TOKENS,
    ...(settings.ai || options.aiConfig || {})
  })};
}
async function requestOpenRouter(endpoint, body, timeoutSeconds, fetchImpl=fetch) {
  const key = process.env.OPENROUTER_API_KEY;
  if(!key) throw new Error('Credencial OpenRouter não configurada no servidor.');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutSeconds * 1000);
  try {
    const response = await fetchImpl('https://openrouter.ai' + endpoint, {
      method:'POST', headers:{Authorization:'Bearer ' + key, 'Content-Type':'application/json',
        'HTTP-Referer':process.env.OPENROUTER_SITE_URL || 'http://localhost:3000',
        'X-Title':process.env.OPENROUTER_APP_NAME || 'ConcretoProjetado'},
      body:JSON.stringify(body), signal:controller.signal
    });
    if(!response.ok) throw new Error('OpenRouter respondeu HTTP ' + response.status + '. Tente novamente ou confira o modelo e o saldo da conta.');
    return await response.json();
  } catch(error) {
    if(error.name === 'AbortError') throw new Error('Tempo limite da consulta excedido. Tente novamente.');
    throw error;
  } finally { clearTimeout(timer); }
}
async function classifyCard(card, options={}) {
  const settings = settingsOf(options), started = Date.now();
  const request = Pipeline.buildDecisionRequest(card, settings);
  const raw = await requestOpenRouter('/api/alpha/decisions', request, Pipeline.config('decision',settings.decision).timeoutSeconds, options.fetchImpl);
  const answer = raw?.answers?.conformidade;
  if(answer?.type !== 'choice' || !Object.hasOwn(Pipeline.decisionDefaults.criteria,answer.choice)) throw new Error('O modelo retornou uma classificação inválida. Tente novamente.');
  if(answer.probabilities != null && (typeof answer.probabilities !== 'object' || Array.isArray(answer.probabilities) || Object.entries(answer.probabilities).some(([k,v]) => !Object.hasOwn(Pipeline.decisionDefaults.criteria,k) || !Number.isFinite(v) || v < 0 || v > 1))) throw new Error('Probabilidades inválidas na classificação.');
  if(answer.confidence != null && (!Number.isFinite(answer.confidence) || answer.confidence < 0 || answer.confidence > 1)) throw new Error('Confiança inválida na classificação.');
  return {status:'concluido', verdict:answer.choice, probabilities:answer.probabilities || null, confidence:answer.confidence ?? null,
    rawResponse:raw, model:raw.model || request.model, durationMs:Date.now()-started, generatedAt:new Date().toISOString(), inputKey:Pipeline.inputKey(card,settings,'decision')};
}
function buildAiPrompt(card, customPrompt='', aiConfig={}, config={}) {
  const settings = settingsOf({config:{...config,ai:{...config.ai,...aiConfig}}});
  const request = Pipeline.buildAiRequest(card,settings,customPrompt);
  return {promptSystem:request.messages[0].content, promptUser:request.messages[1].content, request,
    fck:Number(card.ident?.fck ?? card.fck ?? 35), placa:card.ident?.placa || card.placa || card.id};
}
function sanitizeAiResponse(rawContent) {
  if (!rawContent || typeof rawContent !== 'string') return '';
  let text = rawContent;

  // 1. Remove tags <think>...</think>
  text = text.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();

  // 2. Remove preâmbulo em inglês se o modelo raciocinou antes do parecer em português
  const matchPtHeader = text.search(/(?:^|\n)(?:#{1,4}\s+|(?:\*\*|#\s*)?(?:1[\.\)]|Parecer|Relatório|Resumo|Veredito|Avaliação))/i);
  if (matchPtHeader > 0) {
    const preamble = text.substring(0, matchPtHeader).trim();
    if (/(?:We need to|Let's compute|Typically load|In that case|Assume that|The required loads|Compute average|For a cylindrical)/i.test(preamble)) {
      text = text.substring(matchPtHeader).trim();
    }
  }

  // 3. Corta repetições degeneradas de tokens ou loops
  const lines = text.split('\n');
  const cleanLines = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/\b(copper|tr0id|trash|the following|days uses|h trade)\b/i.test(line) && line.length > 50) {
      break;
    }
    if (cleanLines.length > 0 && cleanLines[cleanLines.length - 1] === line && line.trim().length > 10) {
      break;
    }
    cleanLines.push(line);
  }

  return cleanLines.join('\n').trim();
}


async function analyzeCardWithAi(card, customPrompt='', options={}) {
  const settings = settingsOf(options), started = Date.now();
  if(!Pipeline.validDecision(card,settings)) throw new Error('Conclua uma classificação válida para os dados atuais antes de gerar o parecer.');
  const request = Pipeline.buildAiRequest(card,settings,customPrompt), c = settings.ai;
  const retryDelays = [0,5000,10000,15000];
  const wait = options.sleepImpl || (ms => new Promise(resolve => setTimeout(resolve,ms)));
  let content = '', usedModel = request.model, lastError;
  for(const delay of retryDelays) {
    if(delay) await wait(delay);
    try {
      const raw = await requestOpenRouter('/api/v1/chat/completions', request,c.timeoutSeconds,options.fetchImpl);
      const rawContent = raw?.choices?.[0]?.message?.content;
      if(typeof rawContent !== 'string' || rawContent.trim().length < 30) throw new Error('O modelo retornou um parecer vazio ou incompleto.');
      content = sanitizeAiResponse(rawContent);
      if(content.length < 30) throw new Error('O modelo retornou um parecer incompleto.');
      usedModel = raw.model || request.model; break;
    } catch(error) { lastError = error; }
  }
  if(!content) throw lastError || new Error('Nenhum modelo respondeu com sucesso.');
  const verdict = card.decisionAnalysis.verdict;
  const summary = content.split('\n').map(l => l.replace(/[*_#]/g,'').trim()).find(l => l.length > 25 && !l.startsWith('|'))?.slice(0,180) || 'Parecer técnico emitido.';
  return {status:'concluido', verdict, summary, content, model:usedModel, durationMs:Date.now()-started,
    generatedAt:new Date().toISOString(), inputKey:Pipeline.inputKey(card,settings,'ai'), decision:Pipeline.decisionContext(card)};
}
module.exports = {analyzeCardWithAi, classifyCard, buildAiPrompt, sanitizeAiResponse, settingsOf, OPENROUTER_CONFIG,
  normalizeCpsList:Pipeline.normalizeCps,
  calculateCpResistance:(cp,coefA=1.0024,coefB=0.0299,config={}) => {
    const v = Pipeline.calculate({coefA,coefB},cp,config).values;
    if(v.fci == null) return null;
    return {hMed:v.h,dMed:v.d,hd:v.hd,areaMm2:Math.PI*v.d*v.d/4,cargaTf:Number(cp.carga),cargaN:Number(cp.carga)*1000*9.80665,fciIni:v.ini,k1:v.k1,k2:v.k2,k3:v.k3,k4:v.k4,fciExt:v.fci};
  }};
if(require.main === module) {
  (async () => {
    const {Card,Configuracao} = require('./db/models');
    const id = process.argv.slice(2).find(a => !a.startsWith('--'));
    const card = id ? await Card.findWithCps(id) : (await Card.allWithCps())[0];
    if(!card) throw new Error('Nenhum card encontrado.');
    const config = (await Configuracao.findById(1)) || {};
    if(process.argv.includes('--prompt')) { console.log(JSON.stringify(Pipeline.buildAiRequest(card,settingsOf({config})),null,2)); return; }
    card.decisionAnalysis = await classifyCard(card,{config});
    console.log((await analyzeCardWithAi(card,'',{config})).content);
  })().catch(error => { console.error(error.message); process.exitCode=1; });
}
