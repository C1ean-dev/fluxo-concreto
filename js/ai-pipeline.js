/* Shared request builders: used by both the browser preview and the server. */
(function(root, factory){
  const api = typeof module === 'object' && module.exports
    ? factory(require('./formulas'), require('./tabelas-k'))
    : factory({FORM_DEFAULT, FORM_VAR_ALIASES, formPreview}, {K1_TABLE, K2_TABLE});
  if(typeof module === 'object' && module.exports) module.exports = api;
  else root.AiPipeline = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function(form, tables){
  const groups = {
    identification:'Identificação', mix:'Traço e fornecedora', calibration:'Calibração da prensa',
    measurements:'Medições dos CPs', calculations:'Cálculos e fatores de correção',
    ageSummary:'Resumo por idade', extras:'Metadados extras', adjustments:'Justificativas de ajuste'
  };
  const selected = Object.fromEntries(Object.keys(groups).map(k => [k, true]));
  const decisionDefaults = {
    model:'microsoft/microsoft-decision-1', timeoutSeconds:60, dataFormat:'json', dataGroups:selected,
    instructions:'Classifique a conformidade do ensaio pelas idades com resultados disponíveis e pelo critério de avaliação informado. Use os cálculos fornecidos, sem recalcular resistências. Idades futuras sem ensaio não causam reprovação. Considere as justificativas sem tratar uma justificativa como correção de uma resistência abaixo do limite.',
    criteria:{
      conforme:'Os resultados disponíveis atendem aos limites do projeto pelo critério informado, sem inconsistências relevantes.',
      atencao:'Há inconsistências, dados insuficientes ou ambiguidade que impedem uma conclusão segura sobre os resultados disponíveis.',
      nao_conforme:'Ao menos uma idade com resultado disponível não atende ao limite do projeto pelo critério informado.'
    }
  };
const legacyAiDefaults = {
  promptSystem: `Você é um Engenheiro Civil Especialista Sênior em Tecnologia do Concreto e Controle Tecnológico de Concreto Projetado (Shotcrete/Sprayed Concrete), regido pelas normas brasileiras ABNT NBR 13070, ABNT NBR 7680-1 e ABNT NBR 14026.
Sua missão é emitir um Parecer Técnico Especializado de Inteligência Artificial completo, formal e profissional, analisando o ensaio dos corpos de prova antes do envio ao cliente.

REGRAS OBRIGATÓRIAS:
1. RESPONDA ESTRITAMENTE EM PORTUGUÊS DO BRASIL (pt-BR).
2. NUNCA inclua pensamentos em inglês, notas de rascunho (é terminantemente proibido frases como "We need to produce...", "Let's compute..."). Comece DIRETO na Seção 1 do Parecer Técnico em Markdown.
3. As resistências à compressão fci,ext (em MPa) e as médias por idade JÁ FORAM CALCULADAS com exatidão matemática e constam na lista abaixo. NÃO faça conversões manuais de tf para MPa; use diretamente os valores de fci,ext (MPa) fornecidos.
4. Utilize tabelas em Markdown (| Coluna 1 | Coluna 2 |) para sintetizar as idades, resistências médias obtidas (MPa) e limites normativos (% do fck).
5. Conclua com um Veredito explícito em destaque: [CONFORME], [ATENÇÃO] ou [NÃO CONFORME].`,
  userInstructions: `Estruture sua resposta nas 4 seções a seguir:
1. Resumo Executivo e Veredito Geral ([CONFORME], [ATENÇÃO] ou [NÃO CONFORME])
2. Avaliação de Resistências à Compressão vs Limites de Projeto (3, 7 e 28 dias) — inclua tabela comparativa em Markdown
3. Análise de Consistência Dimensional, Massas e Fatores de Correção (k1 a k4)
4. Sugestão de Texto Técnico para a Notificação ao Cliente`
};
  const aiDefaults = {
    model:'openrouter/free', fallbackModels:[],
    temperature:0.2, maxTokens:8000, timeoutSeconds:60, dataGroups:selected,
    promptSystem:`Você é a IA generativa (LLM), atuando como engenheiro civil especialista em controle tecnológico de concreto projetado. Sua função é analisar os resultados e produzir um parecer técnico claro, formal e profissional em português do Brasil para revisão da equipe técnica.

REGRAS OBRIGATÓRIAS:
1. A classificação já foi realizada pela IA de Decisão / classificação e será fornecida em uma seção identificada. Não emita uma nova classificação nem um veredito próprio. Apresente a classificação recebida como resultado desse modelo, sem assumir sua autoria.
2. Analise as resistências disponíveis em relação aos limites informados, a consistência das medições, os fatores de correção e as justificativas. Use os cálculos fornecidos sem recalcular resistências ou converter manualmente cargas em MPa. Não trate idades futuras sem ensaio como reprovação.
3. Considere a classificação recebida como contexto. Se encontrar uma divergência entre ela e os dados, explique a evidência e indique a necessidade de revisão pela equipe técnica, sem substituir a classe recebida.
4. Comece diretamente no parecer em Markdown, sem notas de rascunho. Use tabelas para comparar resultados por idade e limites do projeto. Não declare atendimento a normas que não possa demonstrar pelos dados fornecidos.
5. Aponte limitações dos dados, possíveis causas e recomendações tecnicamente justificadas, distinguindo evidências de hipóteses. A revisão e a decisão técnica final cabem à equipe.`,
    userInstructions:`Estruture o parecer nas seguintes seções:
1. Resumo executivo da análise e classificação recebida da IA de Decisão / classificação
2. Análise das resistências por idade (3, 7 e 28 dias), com tabela dos resultados disponíveis e limites do projeto
3. Análise de consistência dimensional, massas, fatores de correção (k1 a k4) e justificativas
4. Limitações, eventuais divergências em relação à classificação recebida e recomendações para revisão técnica
5. Sugestão de texto técnico para a notificação ao cliente`,
    userTemplate:'Realize a análise técnica do ensaio da placa {{placa}} (card {{cardId}}).\n\n{{dados}}\n\n{{observacao}}\n\n{{instrucoes}}'
  };
  const clone = value => JSON.parse(JSON.stringify(value));
  function config(kind, value={}){
    const defaults = kind === 'decision' ? decisionDefaults : aiDefaults;
    const result = {...clone(defaults), ...(value || {}), dataGroups:{...selected, ...(value?.dataGroups || {})}};
    if(kind === 'ai'){
      result.model = 'openrouter/free';
      result.timeoutSeconds = 60;
      result.fallbackModels = [];
      for(const key of ['promptSystem','userInstructions']){
        const previousDefault = legacyAiDefaults[key];
        const previousServerDefault = previousDefault.replace(' (Shotcrete/Sprayed Concrete)', '').replace('Parecer Técnico Especializado de Inteligência Artificial', 'Parecer Técnico Especializado');
        if(result[key] === previousDefault || result[key] === previousServerDefault) result[key] = aiDefaults[key];
      }
    }
    if(kind === 'decision') result.criteria = {...decisionDefaults.criteria, ...(value?.criteria || {})};
    return result;
  }
  function validate(kind, value){
    const c = config(kind, value), errors = [];
    if(typeof c.model !== 'string' || !c.model.trim()) errors.push('Informe o modelo.');
    if(!Number.isFinite(c.timeoutSeconds) || c.timeoutSeconds < 1 || c.timeoutSeconds > 300) errors.push('O tempo limite deve estar entre 1 e 300 segundos.');
    if(!Object.values(c.dataGroups).some(Boolean)) errors.push('Selecione ao menos um grupo de dados.');
    if(kind === 'decision'){
      if(!['json','text'].includes(c.dataFormat)) errors.push('Formato de dados inválido.');
      if(!c.instructions?.trim() || Object.values(c.criteria).some(v => typeof v !== 'string' || !v.trim())) errors.push('Preencha as instruções e os três critérios.');
    } else {
      if(!Number.isFinite(c.temperature) || c.temperature < 0 || c.temperature > 2) errors.push('A temperatura deve estar entre 0 e 2.');
      if(!Number.isInteger(c.maxTokens) || c.maxTokens < 1 || c.maxTokens > 128000) errors.push('O limite de tokens deve estar entre 1 e 128000.');
      if(!Array.isArray(c.fallbackModels) || c.fallbackModels.some(m => typeof m !== 'string' || !m.trim())) errors.push('Lista de modelos alternativos inválida.');
      if(!c.promptSystem?.trim() || !c.userInstructions?.trim()) errors.push('Preencha os prompts.');
      if(typeof c.userTemplate !== 'string' || !c.userTemplate.includes('{{dados}}')) errors.push('O template deve incluir {{dados}}.');
      const unknown = (c.userTemplate || '').match(/{{\s*([^}]+)\s*}}/g) || [];
      if(unknown.some(v => !['{{dados}}','{{placa}}','{{cardId}}','{{observacao}}','{{instrucoes}}'].includes(v))) errors.push('O template contém uma variável desconhecida.');
    }
    return errors;
  }
  function normalizeCps(card){
    return (card.cps || []).map((cp, i) => Array.isArray(cp)
      ? {n:i+1, idade:Number(cp[0]), h:cp.slice(1,4), d:cp.slice(4,6), massa:cp[6], carga:cp[7], sentido:cp[8], cura:cp[9]}
      : {n:cp.n ?? ((cp.cp_index ?? i)+1), idade:Number(cp.idade), h:cp.h || [cp.h1,cp.h2,cp.h3], d:cp.d || [cp.d1,cp.d2], massa:cp.massa, carga:cp.carga, sentido:cp.sentido, cura:cp.cura});
  }
  function cpEnv(card, cp){
    const positive = v => v !== '' && v != null && Number(v) > 0 ? Number(v) : null;
    const base = {H1:positive(cp.h[0]), H2:positive(cp.h[1]), H3:positive(cp.h[2]), D1:positive(cp.d[0]), D2:positive(cp.d[1]), MASSA:positive(cp.massa), CARGA:positive(cp.carga), IDADE:positive(cp.idade), SENTIDO:cp.sentido || null, CURA:cp.cura || null, A:Number(card.coefA ?? card.coef_a ?? 1.0024), B:Number(card.coefB ?? card.coef_b ?? 0.0299)};
    Object.entries(form.FORM_VAR_ALIASES).forEach(([alias, key]) => { if(key in base) base[alias] = base[key]; });
    return base;
  }
  function calculationTables(card, settings={}){
    if(card.cfgSnap || card.cfg_snap) return card.cfgSnap || card.cfg_snap;
    const set = (settings.sets || []).find(s => s.id === settings.active);
    return {k1:set && !set.builtin ? set.k1 : tables.K1_TABLE, k2:set && !set.builtin ? set.k2 : tables.K2_TABLE, formulas:settings.formulas || form.FORM_DEFAULT};
  }
  function calculate(card, cp, settings){
    const t = calculationTables(card, settings), maps = {k1:new Map(t.k1.map(([k,v]) => [Math.round(k*100),v])), k2:new Map(t.k2.map(([k,v]) => [Math.round(k),v]))};
    const preview = form.formPreview({...form.FORM_DEFAULT, ...t.formulas}, maps, cpEnv(card, cp));
    return {values:Object.fromEntries(Object.entries(preview).filter(([,v]) => v.value != null).map(([k,v]) => [k,v.value])), errors:Object.fromEntries(Object.entries(preview).filter(([,v]) => v.error).map(([k,v]) => [k,v.error]))};
  }
  function technicalData(card, settings={}){
    const ident = card.ident || {}, cps = normalizeCps(card), fck = Number(ident.fck ?? card.fck ?? 35);
    const pick = keys => Object.fromEntries(keys.filter(k => ident[k] != null).map(k => [k,ident[k]]));
    const identification = pick(['placa','interessado','elemento','fck','dataProjecao','nf','relNumero','emailCliente']);
    const mixKeys = ['cimentoMarca','cimentoTipo','cimentoConsumo','aditivo','acelerador','aceleradorConsumo','central','agregados'];
    const rows = cps.filter(cp => cp.carga !== '' && cp.carga != null && Number(cp.carga) > 0).map(cp => ({cp, ...calculate(card, cp, settings)}));
    const ageSummary = [3,7,28].map(age => {
      const available = rows.filter(r => r.cp.idade === age), vals = available.map(r => r.values.fci).filter(Number.isFinite);
      const limit = fck * ({3:0.5,7:0.75,28:1}[age]);
      const mean = vals.length ? vals.reduce((a,b) => a+b,0)/vals.length : null;
      return {idade:age, ensaiado:available.length > 0, quantidade:available.length, calculados:vals.length, mediaMPa:mean, limiteMPa:limit, percentualFck:mean == null ? null : mean/fck*100, atende:mean == null ? null : (card.criterio === 'individual' ? vals.every(v => v >= limit) : mean >= limit)};
    });
    const standard = [...Object.keys(identification), ...mixKeys];
    return {
      identification:{cardId:card.id, ...identification, fck, criterio:card.criterio || 'media'},
      mix:pick(mixKeys), calibration:{coefA:card.coefA ?? card.coef_a ?? 1.0024, coefB:card.coefB ?? card.coef_b ?? 0.0299},
      measurements:cps, calculations:rows.map(r => ({cp:r.cp.n, idade:r.cp.idade, ...r.values, erros:r.errors})), ageSummary,
      extras:Object.fromEntries(Object.entries(ident).filter(([k]) => !standard.includes(k))),
      adjustments:Object.fromEntries(Object.entries(card.adjust || {}).filter(([,v]) => v?.note).map(([k,v]) => [k,v.note]))
    };
  }
  function dataFor(card, settings, c){
    const data = technicalData(card, settings);
    return Object.fromEntries(Object.entries(data).filter(([k]) => c.dataGroups[k]));
  }
  function stable(value){
    if(Array.isArray(value)) return value.map(stable);
    if(value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(k => [k,stable(value[k])]));
    return value;
  }
  // Full canonical input is retained so equality cannot suffer hash collisions.
  function inputKey(card, settings, kind){
    const c = config(kind, settings?.[kind === 'decision' ? 'decision' : 'ai']);
    return JSON.stringify(stable({data:technicalData(card, settings), tables:calculationTables(card,settings), config:c,
      ...(kind === 'ai' ? {decision:decisionContext(card)} : {})}));
  }
  function decisionContext(card){
    const d = card.decisionAnalysis || card.decision_analysis;
    return d?.status === 'concluido' ? {classe:d.verdict, probabilidades:d.probabilities, confianca:d.confidence, modelo:d.model, geradoEm:d.generatedAt} : null;
  }
  function validDecision(card, settings){
    const d = card.decisionAnalysis || card.decision_analysis;
    return d?.status === 'concluido' && Object.hasOwn(decisionDefaults.criteria,d.verdict) && d.inputKey === inputKey(card, settings, 'decision');
  }
  function buildDecisionRequest(card, settings={}){
    const c = config('decision', settings.decision), errors = validate('decision',c);
    if(errors.length) throw new Error(errors.join(' '));
    const data = dataFor(card, settings,c);
    return {model:c.model.trim(), state:c.dataFormat === 'text' ? JSON.stringify(data,null,2) : data,
      questions:{conformidade:{type:'choice', instructions:c.instructions, criteria:c.criteria}}};
  }
  function buildAiRequest(card, settings={}, note=''){
    const c = config('ai',settings.ai), errors = validate('ai',c);
    if(errors.length) throw new Error(errors.join(' '));
    const variables = {dados:JSON.stringify(dataFor(card,settings,c),null,2), placa:String(card.ident?.placa || card.placa || card.id), cardId:card.id, observacao:note, instrucoes:c.userInstructions};
    const user = c.userTemplate.replace(/{{([^}]+)}}/g, (_,key) => variables[key]);
    const decision = decisionContext(card);
    const decisionText = '\n\nIA DE DECISÃO / CLASSIFICAÇÃO — RESULTADO PRÉVIO:\n' + (decision ? JSON.stringify(decision,null,2) : 'Classificação pendente. Esta prévia não pode ser executada antes de uma classificação válida.') + '\nAnalise os dados considerando esta classificação. Não emita uma nova classe ou veredito. Explique eventuais divergências e encaminhe-as à revisão da equipe técnica.';
    return {model:c.model.trim(), messages:[{role:'system',content:c.promptSystem},{role:'user',content:user+decisionText}], temperature:c.temperature, max_tokens:c.maxTokens};
  }
  function notificationParts(content=''){
    const lines = String(content).replace(/\r\n?/g,'\n').split('\n');
    const heading = line => {
      const hash = line.match(/^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/);
      if(hash) return {level:hash[1].length,title:hash[2]};
      const bold = line.match(/^\s*\*\*(.+?)\*\*\s*:?\s*$/);
      const sectionTitle = /^(?:\d+[.)]\s*)?(?:resumo|avalia|an[aá]lise|consist[eê]ncia|limita|sugest|recomenda|conclus|parecer|observa|refer[eê]ncia)/i;
      if(bold && sectionTitle.test(bold[1])) return {level:2,title:bold[1]};
      if(/^\s*\d+[.)]\s+\S/.test(line) && sectionTitle.test(line.trim()) && line.length < 180) return {level:2,title:line};
      return null;
    };
    const isSuggestion = title => {
      const normalized = title.normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase();
      return /sugest/.test(normalized) && /notifica|cliente|e-?mail/.test(normalized);
    };
    const report = [], suggestion = [];
    let suggestionLevel = null, quotedSuggestion = false;
    for(const line of lines){
      const h = heading(line);
      // Accept an unformatted section title as well as Markdown headings.
      const suggestionHeading = isSuggestion(h?.title || line) && (h || /^(?:\s*\d+[.)]\s*)?sugest[aã]o\b/i.test(line.trim()));
      if(suggestionHeading){ suggestionLevel = h?.level || 2; quotedSuggestion = false; continue; }
      if(suggestionLevel !== null){
        const quoted = /^\s*>/.test(line);
        const footer = /^\s*(?:elaborad[oa] por|data (?:da an[aá]lise|do parecer)|respons[aá]vel (?:pela an[aá]lise|t[eé]cnico))\s*:/i.test(line);
        if((h && h.level <= suggestionLevel) || footer || (quotedSuggestion && line.trim() && !quoted)) suggestionLevel = null;
        else if(quoted) quotedSuggestion = true;
      }
      (suggestionLevel !== null ? suggestion : report).push(line);
    }
    const readable = text => text.join('\n').trim()
      .replace(/^[ \t]{0,3}(?:>[ \t]?)+/gm,'')
      .replace(/^\s{0,3}#{1,6}\s+/gm,'').replace(/\*\*([^*\n]+)\*\*/g,'$1')
      .replace(/^\s*[-*_]{3,}\s*$/gm,'').replace(/\n{3,}/g,'\n\n').trim();
    let suggestedText = readable(suggestion);
    if(/^["“][\s\S]*["”]$/.test(suggestedText)) suggestedText = suggestedText.slice(1,-1).trim();
    return {suggestion:suggestedText,report:readable(report)};
  }
  return {groups, decisionDefaults, aiDefaults, config, validate, normalizeCps, cpEnv, calculationTables, calculate, technicalData, inputKey, validDecision, decisionContext, buildDecisionRequest, buildAiRequest, notificationParts};
});
