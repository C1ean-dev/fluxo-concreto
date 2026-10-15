/* Configurações · conjuntos de tabelas K1 e K2 (planilha atual, importados), fórmulas de cálculo editáveis,
   revisões com motivo e análise de impacto.
   Carregado antes de js/app.js. As funções de dados (defaultConfig, cfgOf, cfgMaps...) são usadas pelo app.js;
   o editor (modal "Configurações") usa, só em tempo de execução, globais do app.js (S, $, esc, fmt, toast, save...). */

/* ===== Chaves fixas das tabelas (a busca é por valor exato, como na planilha) ===== */
const CFG_KEYS = {
  k1: Array.from({length: 101}, (_item, indice) => (200 - indice) / 100),   // h/d de 2,00 a 1,00, passo 0,01
  k2: Array.from({length: 101}, (_item, indice) => 50 + indice)             // diâmetro de 50 a 150 mm, passo 1 mm
};

const cfgArredondar8 = valor => Math.round(valor * 1e8) / 1e8;
const cfgFormatarNumero = valor => String(+Number(valor).toFixed(8)).replace('.', ',');
function cfgInterpolar(pontos, chave){   // pontos em ordem crescente de chave; null fora do intervalo
  if(chave < pontos[0][0] - 1e-9 || chave > pontos[pontos.length - 1][0] + 1e-9) return null;
  for(let indice = 0; indice < pontos.length - 1; indice++){
    const [chaveA, valorA] = pontos[indice], [chaveB, valorB] = pontos[indice + 1];
    if(chave >= chaveA - 1e-9 && chave <= chaveB + 1e-9) return valorA + (valorB - valorA) * (chave - chaveA) / (chaveB - chaveA);
  }
  return pontos[pontos.length - 1][1];
}

/* ===== Conjuntos fixos: valores da planilha (js/tabelas-k.js) ===== */
const CFG_FIXED = {
  planilha: {k1: K1_TABLE.map(linha => [linha[0], linha[1]]), k2: K2_TABLE.map(linha => [linha[0], linha[1]])}
};
const cfgFixedSets = () => [{id: 'planilha', name: 'Planilha atual', builtin: true}];

/* ===== Configuração: conjunto em uso + conjuntos importados ===== */
const AI_DEFAULT_CONFIG = AiPipeline.aiDefaults;

const cfgForms = config => config.formulas || FORM_DEFAULT;
function defaultConfig(){
  return {rev: 1, active: 'planilha', sets: cfgFixedSets(), formulas: {...FORM_DEFAULT}, ai: AiPipeline.config("ai", AI_DEFAULT_CONFIG), decision: AiPipeline.config("decision"),
    history: [{t: new Date().toISOString(), rev: 1, note: 'Conjunto inicial: valores da planilha atual (abas K1 e k2).', changes: null}]};
}
function cfgMigrate(config){   // estados salvos em versões anteriores: {rev, k1, k2, history}
  if(config.sets){
    config.sets = config.sets.filter(conjunto => conjunto.id !== 'cbc2015');
    if(config.active === 'cbc2015') config.active = 'planilha';
    if(!config.formulas) {
      config.formulas = {...FORM_DEFAULT};
    } else {
      // Migração automática: se as fórmulas salvas no navegador ainda usam as siglas antigas (ex: MEDIA(H1; H2; H3)),
      // atualiza automaticamente para as novas fórmulas descritivas em português.
      const ehAntiga = config.formulas.h === 'MEDIA(H1; H2; H3)' || config.formulas.fci === 'ini * (1 + k1 + k2 + k3 + k4)';
      if(ehAntiga) config.formulas = {...FORM_DEFAULT};
    }
    config.ai = AiPipeline.config('ai', {...AI_DEFAULT_CONFIG, ...(config.ai || {})});
    config.decision = AiPipeline.config('decision', config.decision);
    return config;
  }
  const tabelasIguais = (tabelaA, tabelaB) => tabelaA.length === tabelaB.length && tabelaA.every((linha, indice) => linha[0] === tabelaB[indice][0] && linha[1] === tabelaB[indice][1]);
  const base = defaultConfig(); base.ai = AiPipeline.config("ai", {...AI_DEFAULT_CONFIG, ...(config.ai || {})}); base.decision = AiPipeline.config("decision", config.decision); base.rev = config.rev || 1; base.history = config.history || base.history;
  if(tabelasIguais(config.k1, K1_TABLE) && tabelasIguais(config.k2, K2_TABLE)) return base;
  const idConjunto = 'pers-' + base.rev;
  base.sets.push({id: idConjunto, name: 'Personalizado (revisão ' + base.rev + ')', builtin: false, k1: config.k1.map(linha => [linha[0], linha[1]]), k2: config.k2.map(linha => [linha[0], linha[1]])});
  base.active = idConjunto;
  return base;
}
const cfgSetTables = conjunto => conjunto.builtin ? CFG_FIXED[conjunto.id] : {k1: conjunto.k1, k2: conjunto.k2};
function cfgTablesOf(config){   // tabelas do conjunto em uso (cópia)
  const conjunto = config.sets.find(candidato => candidato.id === config.active) || config.sets[0], tabelas = cfgSetTables(conjunto);
  return {name: conjunto.name, k1: tabelas.k1.map(linha => [linha[0], linha[1]]), k2: tabelas.k2.map(linha => [linha[0], linha[1]]), formulas: {...cfgForms(config)}};
}
const CFG_ACTIVE = new WeakMap();   // um objeto estável por configuração (base do cache de mapas)
function cfgActive(config){
  let ativa = CFG_ACTIVE.get(config);
  if(!ativa){ ativa = Object.assign({rev: config.rev}, cfgTablesOf(config)); CFG_ACTIVE.set(config, ativa); }
  return ativa;
}
function cfgSnapshot(config){   // fixa as tabelas num card (ou monta a cópia usada na análise de impacto)
  const tabelas = config.sets ? cfgTablesOf(config) : config;
  return {rev: config.rev, name: tabelas.name || null, k1: tabelas.k1.map(linha => [linha[0], linha[1]]), k2: tabelas.k2.map(linha => [linha[0], linha[1]]), formulas: {...cfgForms(tabelas)}};
}

const CFG_MAPS = new WeakMap();   // cache dos mapas de busca; um por objeto de tabelas (nunca alterado depois de criado)
function cfgMaps(tabelas){
  let mapas = CFG_MAPS.get(tabelas);
  if(!mapas){
    const k1 = new Map(), k2 = new Map();
    tabelas.k1.forEach(([chave, valor]) => { if(Number.isFinite(valor)) k1.set(Math.round(chave * 100), valor); });
    tabelas.k2.forEach(([chave, valor]) => { if(Number.isFinite(valor)) k2.set(Math.round(chave), valor); });
    const chavesK1 = tabelas.k1.map(linha => linha[0]), chavesK2 = tabelas.k2.map(linha => linha[0]);
    mapas = {k1, k2, k1min: Math.min(...chavesK1), k1max: Math.max(...chavesK1), k2min: Math.min(...chavesK2), k2max: Math.max(...chavesK2)};
    CFG_MAPS.set(tabelas, mapas);
  }
  return mapas;
}
/* Um card usa as tabelas e fórmulas em uso até a primeira notificação ao cliente; depois elas ficam fixadas no card. */
const cfgOf = card => card.cfgSnap || cfgActive(estado.config);
const CFG_COMP = new WeakMap();   // fórmulas compiladas, um cache por objeto de tabelas
function cfgCompiled(tabelas){
  let compiladas = CFG_COMP.get(tabelas);
  if(!compiladas){ compiladas = formCompileAll(cfgForms(tabelas)); CFG_COMP.set(tabelas, compiladas); }
  return compiladas;
}

function coefInfo(card){
  const tabelasFixadas = card.cfgSnap, emUso = cfgActive(estado.config);
  return `<div class="banner info banner-row"><span>${tabelasFixadas
    ? `Este card usa as tabelas e fórmulas <b>«${escaparHtml(tabelasFixadas.name || 'revisão ' + tabelasFixadas.rev)}»</b> (revisão ${tabelasFixadas.rev}), fixadas na primeira notificação ao cliente. Alterações em Configurações não o afetam.`
    : `Este card usa as tabelas e fórmulas em uso: <b>«${escaparHtml(emUso.name)}»</b> (revisão ${estado.config.rev}). Elas ficam fixadas no card na primeira notificação ao cliente.`}</span>
    ${tabelasFixadas && card.stage !== 'finalizado' ? '<button class="btn sm" data-act="unpin">Usar as tabelas e fórmulas em uso</button>' : ''}</div>`;
}

/* ===== Impacto de uma alteração nos cards ainda não fixados ===== */
function cfgImpact(draft){
  const tabelasDoRascunho = cfgSnapshot(draft);   // cópia com as tabelas do conjunto em uso do rascunho
  const rows = []; let fixados = 0;
  estado.cards.forEach(card => {
    if(card.cfgSnap){ fixados++; return; }
    const antes = evaluate(card), depois = evaluate(card, tabelasDoRascunho);
    if(!antes.started.length) return;
    AGES.forEach(idade => {
      const idadeAntes = antes.ages[idade], idadeDepois = depois.ages[idade];
      if(!idadeAntes && !idadeDepois) return;
      if(!idadeAntes !== !idadeDepois || Math.abs((idadeAntes ? idadeAntes.media : 0) - (idadeDepois ? idadeDepois.media : 0)) > 0.005 || (idadeAntes && idadeDepois && idadeAntes.pass !== idadeDepois.pass)) rows.push({card: card, age: idade, antes: idadeAntes, depois: idadeDepois});
    });
    if(antes.errors.length !== depois.errors.length) rows.push({card: card, errors: [antes.errors.length, depois.errors.length]});
  });
  return {rows, fixados};
}

/* ===== Importação de conjuntos (.xlsx no modelo da planilha ou .json exportado daqui) ===== */
function cfgFit(pontos, tabela){   // ajusta pontos importados à grade fixa de chaves, por interpolação linear
  const keys = CFG_KEYS[tabela], minimo = Math.min(...keys), maximo = Math.max(...keys), rotulo = tabela.toUpperCase();
  pontos = pontos.filter(ponto => Number.isFinite(ponto[0]) && Number.isFinite(ponto[1])).sort((pontoA, pontoB) => pontoA[0] - pontoB[0]);
  if(pontos.length < 2) throw new Error(`a tabela ${rotulo} tem menos de 2 pontos numéricos`);
  if(pontos.some((ponto, indice) => indice > 0 && Math.abs(ponto[0] - pontos[indice - 1][0]) < 1e-9)) throw new Error(`a tabela ${rotulo} tem chaves repetidas`);
  if(pontos[0][0] > minimo + 1e-9 || pontos[pontos.length - 1][0] < maximo - 1e-9) throw new Error(`a tabela ${rotulo} cobre ${cfgFormatarNumero(pontos[0][0])} a ${cfgFormatarNumero(pontos[pontos.length - 1][0])}, mas é preciso cobrir ${cfgFormatarNumero(minimo)} a ${cfgFormatarNumero(maximo)}`);
  let interpoladas = 0;
  const rows = keys.map(chave => {
    const exato = pontos.find(ponto => Math.abs(ponto[0] - chave) < 1e-9);
    if(exato) return [chave, exato[1]];   // chave presente no arquivo: valor mantido como está
    interpoladas++;
    return [chave, cfgArredondar8(cfgInterpolar(pontos, chave))];
  });
  return {rows, interpoladas};
}
function cfgFromWorkbook(workbook){   // modelo da planilha: aba "K1" em B4:C104 e aba "k2" em I4:J104
  const normalizar = texto => String(texto).normalize('NFD').replace(/[̀-ͯ]/g, '').trim().toLowerCase();
  const buscarAba = nomeBuscado => { const nomeEncontrado = workbook.SheetNames.find(nomeAba => normalizar(nomeAba) === nomeBuscado); return nomeEncontrado ? workbook.Sheets[nomeEncontrado] : null; };
  const abaK1 = buscarAba('k1'), abaK2 = buscarAba('k2');
  if(!abaK1 || !abaK2) throw new Error('não encontrei as abas "K1" e "k2" do modelo da planilha');
  const lerPontos = (aba, colunaChave, colunaValor) => {
    const pontos = [];
    for(let linha = 4; linha <= 104; linha++){ const celulaChave = aba[colunaChave + linha], celulaValor = aba[colunaValor + linha]; if(celulaChave && celulaValor && typeof celulaChave.v === 'number' && typeof celulaValor.v === 'number') pontos.push([celulaChave.v, celulaValor.v]); }
    return pontos;
  };
  return {k1: cfgFit(lerPontos(abaK1, 'B', 'C'), 'k1'), k2: cfgFit(lerPontos(abaK2, 'I', 'J'), 'k2')};
}
function cfgFromJson(json){
  if(!json || !Array.isArray(json.k1) || !Array.isArray(json.k2)) throw new Error('arquivo JSON inválido (esperado um objeto com k1 e k2)');
  const paraPares = lista => lista.map(par => [Number(par[0]), Number(par[1])]);
  return {k1: cfgFit(paraPares(json.k1), 'k1'), k2: cfgFit(paraPares(json.k2), 'k2')};
}

/* ===== Editor ===== */
let cfgDraft = null, cfgTab = 'k1', cfgStep = 'edit', cfgMsg = null;
const CFG_DESC = {
  k1: 'k1 · correção pela relação altura/diâmetro. O h/d médio do testemunho é arredondado a 2 casas e a linha correspondente é buscada nesta tabela (1,00 a 2,00).',
  k2: 'k2 · correção pelo efeito do broqueamento. O diâmetro médio do testemunho é arredondado ao mm e a linha correspondente é buscada nesta tabela (50 a 150 mm).'
};
const cfgCloneState = config => JSON.parse(JSON.stringify({rev: config.rev, active: config.active, sets: config.sets, formulas: {...cfgForms(config)}, ai: AiPipeline.config("ai", config.ai), decision: AiPipeline.config("decision", config.decision)}));
const cfgSig = config => JSON.stringify([config.active, config.sets, config.formulas, config.ai, config.decision]);
const cfgDirty = () => !!cfgDraft && cfgSig(cfgDraft) !== cfgSig(estado.config);
const cfgCurSet = () => cfgDraft.sets.find(conjunto => conjunto.id === cfgDraft.active) || cfgDraft.sets[0];
function cfgBad(conjunto){
  const invalidos = {k1: new Set(), k2: new Set()};
  if(!conjunto.builtin) ['k1', 'k2'].forEach(tabela => conjunto[tabela].forEach((linha, indice) => { if(!Number.isFinite(linha[1])) invalidos[tabela].add(indice); }));
  return invalidos;
}
function cfgNameProblem(conjunto){
  const nomeNormalizado = String(conjunto.name || '').trim().toLowerCase();
  if(!nomeNormalizado) return 'Dê um nome ao conjunto.';
  if(cfgDraft.sets.some(outro => outro !== conjunto && String(outro.name || '').trim().toLowerCase() === nomeNormalizado)) return 'Já existe um conjunto com esse nome.';
  return '';
}
let cfgSampleCura = 'Úmida';
const CFG_SAMPLE = () => {
  const linha = DADOS_PLACA_113[0];
  const h1 = linha[1], h2 = linha[2], h3 = linha[3], d1 = linha[4], d2 = linha[5], massa = linha[6], carga = linha[7];
  return {
    H1: h1, H2: h2, H3: h3, D1: d1, D2: d2, MASSA: massa, CARGA: carga, IDADE: linha[0], SENTIDO: 'Mesmo do lançamento', CURA: cfgSampleCura, A: 1.0024, B: 0.0299,
    ALTURA_1: h1, ALTURA_2: h2, ALTURA_3: h3, ALTURA1: h1, ALTURA2: h2, ALTURA3: h3,
    DIAMETRO_1: d1, DIAMETRO_2: d2, DIAMETRO1: d1, DIAMETRO2: d2,
    MASSA_CP_KG: massa, MASSA_KG: massa,
    CARGA_RUPTURA_TF: carga, CARGA_TF: carga,
    SENTIDO_EXTRACAO: 'Mesmo do lançamento', METODO_CURA: cfgSampleCura, IDADE_DIAS: linha[0],
    COEF_ANGULAR_PRENSA: 1.0024, COEF_LINEAR_PRENSA: 0.0299, COEF_ANGULAR: 1.0024, COEF_LINEAR: 0.0299, COEFA: 1.0024, COEFB: 0.0299,
    COEFICIENTE_ANGULAR: 1.0024, COEFICIENTE_LINEAR: 0.0299, COEFICIENTE_ANGULAR_A: 1.0024, COEFICIENTE_LINEAR_B: 0.0299
  };
};
const cfgFormPreview = () => formPreview(cfgDraft.formulas, cfgMaps(cfgSnapshot(cfgDraft)), CFG_SAMPLE());
const cfgFormErrors = () => Object.values(cfgFormPreview()).filter(previa => previa.error).length;
const cfgErrorCount = () => AiPipeline.validate("ai", cfgDraft.ai).length + AiPipeline.validate("decision", cfgDraft.decision).length + cfgFormErrors() + cfgDraft.sets.reduce((total, conjunto) => total + (conjunto.builtin ? 0 : cfgBad(conjunto).k1.size + cfgBad(conjunto).k2.size) + (cfgNameProblem(conjunto) ? 1 : 0), 0);
function cfgSummary(){
  const saved = estado.config, rascunho = cfgDraft, resumo = [];
  const nomeDoConjunto = (config, idConjunto) => (config.sets.find(conjunto => conjunto.id === idConjunto) || {}).name;
  if(saved.active !== rascunho.active) resumo.push(`Conjunto em uso: «${nomeDoConjunto(saved, saved.active)}» → «${nomeDoConjunto(rascunho, rascunho.active)}»`);
  rascunho.sets.filter(conjunto => !saved.sets.some(original => original.id === conjunto.id)).forEach(conjunto => resumo.push(`Conjunto adicionado: «${conjunto.name}»`));
  saved.sets.filter(original => !rascunho.sets.some(conjunto => conjunto.id === original.id)).forEach(original => resumo.push(`Conjunto excluído: «${original.name}»`));
  rascunho.sets.forEach(conjunto => { const original = saved.sets.find(candidato => candidato.id === conjunto.id); if(original && JSON.stringify(original) !== JSON.stringify(conjunto)) resumo.push(`Conjunto alterado: «${conjunto.name}»${original.name !== conjunto.name ? ` (antes «${original.name}»)` : ''}`); });
  FORM_ORDER.forEach(chave => { const original = cfgForms(saved)[chave], novo = rascunho.formulas[chave]; if(original !== novo) resumo.push(`Fórmula de ${FORM_META[chave].label}: «${original}» → «${novo}»`); });
  if(JSON.stringify(saved.decision) !== JSON.stringify(rascunho.decision)) resumo.push('Configurações de IA de Decisão / classificação alteradas');
  if(rascunho.ai && JSON.stringify(saved.ai) !== JSON.stringify(rascunho.ai)) resumo.push('Configurações e prompts de IA generativa (LLM) alterados');
  return resumo;
}

let cfgGuideOpen = false, cfgSampleOpen = false;
function openConfig(){
  cfgSampleCura = 'Úmida';
  cfgGuideOpen = false;
  cfgSampleOpen = false;
  cfgDraft = cfgCloneState(estado.config); cfgTab = 'k1'; cfgStep = 'edit'; cfgMsg = null;
  consultar('#mBox').className = 'm-box wide';
  renderConfig();
  consultar('#modal').hidden = false;
}
function closeModal(){
  if(cfgDirty() && !confirm('Há alterações nas tabelas que ainda não foram salvas. Descartar?')) return;
  cfgDraft = null; cfgStep = 'edit'; cfgMsg = null;
  consultar('#modal').hidden = true; consultar('#mBox').className = 'm-box';
}
function renderConfig(){
  consultar('#mBox').innerHTML = `<div class="head-row"><div><h2 id="mTitle">Configurações</h2>
      <p class="hint">Revisão vigente: <b>${estado.config.rev}</b>. Edite tabelas, fórmulas e as configurações dos modelos de classificação e parecer técnico. Para salvar, revise o impacto e informe o motivo.</p></div>
      <button class="x" id="mClose" aria-label="Fechar">×</button></div>
    <div id="cfgSwitch"></div><div id="cfgSetBar"></div>
    <div class="cfg-tabs" id="cfgTabs" role="tablist"></div><div id="cfgBody"></div><div class="cfg-foot" id="cfgFoot"></div>`;
  renderCfgSwitch(); renderCfgSetBar(); renderCfgTabs(); renderCfgBody(); renderCfgFoot();
}
const cfgShowSets = () => cfgStep === 'edit' && (cfgTab === 'k1' || cfgTab === 'k2');
function renderCfgSwitch(){
  if(!cfgShowSets()){ consultar('#cfgSwitch').innerHTML = ''; return; }
  const botoes = cfgDraft.sets.map(conjunto => `<button class="cfg-opt" type="button" role="radio" aria-checked="${conjunto.id === cfgDraft.active}" data-cfg-set="${escaparHtml(conjunto.id)}">${escaparHtml(conjunto.name || '(sem nome)')}${conjunto.id === estado.config.active ? ' <span class="pill mute">em uso</span>' : ''}</button>`).join('');
  consultar('#cfgSwitch').innerHTML = `<div class="cfg-switch" role="radiogroup" aria-label="Conjunto de tabelas em uso">${botoes}<button class="btn sm" type="button" data-cfg="import">+ Importar…</button></div>`;
}
function renderCfgSetBar(){
  if(!cfgShowSets()){ consultar('#cfgSetBar').innerHTML = ''; return; }
  const conjunto = cfgCurSet();
  consultar('#cfgSetBar').innerHTML = conjunto.builtin
    ? `<div class="cfg-setbar"><span class="hint">Conjunto fixo, somente leitura. Para editar, duplique.</span><button class="btn sm" type="button" data-cfg="dup">Duplicar para editar</button><button class="btn sm" type="button" data-cfg="export">Exportar (.json)</button></div>`
    : `<div class="cfg-setbar"><label class="hint" for="cfgName">Nome</label><input id="cfgName" class="cfg-name" type="text" data-cfg-name value="${escaparHtml(conjunto.name)}">
        <button class="btn sm" type="button" data-cfg="dup">Duplicar</button><button class="btn sm" type="button" data-cfg="export">Exportar (.json)</button><button class="btn sm ghost" type="button" data-cfg="delete">Excluir</button>
        <span class="hint txt-err" id="cfgNameProb">${escaparHtml(cfgNameProblem(conjunto))}</span></div>`;
}
function renderCfgTabs(){
  const botaoDaAba = (idAba, label) => `<button class="cfg-tab" role="tab" data-cfg-tab="${idAba}" aria-selected="${cfgStep === 'edit' && cfgTab === idAba}">${label}</button>`;
  consultar('#cfgTabs').innerHTML = botaoDaAba('k1', 'K1 · h/d') + botaoDaAba('k2', 'K2 · diâmetro') + botaoDaAba('form', 'Fórmulas') + botaoDaAba('decision', 'IA de Decisão / classificação') + botaoDaAba('ia', 'IA generativa (LLM)') + botaoDaAba('hist', 'Histórico');
}
function cfgTableHTML(tabela, conjunto){
  const keys = CFG_KEYS[tabela], rows = cfgSetTables(conjunto)[tabela], somenteLeitura = conjunto.builtin, invalidos = cfgBad(conjunto)[tabela];
  const head = tabela === 'k1' ? ['h/d', 'k1'] : ['Diâmetro (mm)', 'k2'];
  const body = rows.map((linha, indice) => `<tr id="cfgr-${tabela}-${indice}"${invalidos.has(indice) ? ' class="bad"' : ''}><td>${tabela === 'k1' ? formatarNumero(keys[indice], 2) : keys[indice]}</td>
    <td>${somenteLeitura ? cfgFormatarNumero(linha[1]) : `<input type="number" step="any" data-cfgv="${tabela}:${indice}" value="${Number.isFinite(linha[1]) ? +linha[1].toFixed(8) : ''}" aria-label="${escaparHtml(tabela === 'k1' ? 'h/d ' + formatarNumero(keys[indice], 2) : keys[indice] + ' mm')}">`}</td></tr>`).join('');
  return `<div class="cfg-grid"><table><thead><tr><th>${head[0]}</th><th>${head[1]}${somenteLeitura ? '' : ' (editável)'}</th></tr></thead><tbody>${body}</tbody></table></div>`;
}
const cfgBadHTML = (conjunto, tabela) => { const quantidade = cfgBad(conjunto)[tabela].size; return quantidade ? `<div class="banner">${quantidade} valor(es) ausente(s) ou inválido(s). Corrija antes de salvar.</div>` : ''; };
function renderCfgBody(){
  const corpo = consultar('#cfgBody');
  if(cfgStep === 'save'){ corpo.innerHTML = cfgSaveHTML(); return; }
  if(cfgTab === 'hist'){ corpo.innerHTML = cfgHistHTML(); return; }
  if(cfgTab === 'form'){ corpo.innerHTML = `${cfgMsg ? `<div class="banner ${cfgMsg.kind}">${escaparHtml(cfgMsg.text)}</div>` : ''}${cfgFormHTML()}`; return; }
  if(cfgTab === 'ia' || cfgTab === 'decision'){ corpo.innerHTML = cfgModelHTML(); return; }
  const tabela = cfgTab, conjunto = cfgCurSet();
  corpo.innerHTML = `${cfgMsg ? `<div class="banner ${cfgMsg.kind}">${escaparHtml(cfgMsg.text)}</div>` : ''}
    <p class="hint">${CFG_DESC[tabela]}</p>
    ${conjunto.builtin ? '' : `<details class="cfg-gen"><summary>Gerar esta tabela a partir de pontos de referência</summary>
      <p class="hint mt8">Uma linha por ponto, com a chave e o valor separados por <code>;</code> ou tab (dá para colar duas colunas do Excel). Os valores entre dois pontos são interpolados linearmente; chaves fora do intervalo dos pontos ficam como estão.</p>
      <textarea id="cfgPts" class="ta mt8" rows="6" placeholder="Ex.:&#10;${tabela === 'k1' ? '2,00; 0&#10;1,00; -0,14' : '50; 0,12&#10;150; 0,04'}"></textarea>
      <p class="mt8"><button class="btn sm" type="button" data-cfg="gen">Gerar tabela por interpolação linear</button></p></details>`}
    <div id="cfgBad">${cfgBadHTML(conjunto, tabela)}</div>${cfgTableHTML(tabela, conjunto)}`;
}
function renderCfgFoot(){
  const dirty = cfgDirty(), qtdErros = cfgErrorCount();
  consultar('#cfgFoot').innerHTML = cfgStep === 'save' ? '' :
    `<span class="hint">${dirty ? 'Há alterações ainda não salvas.' : 'Nenhuma alteração pendente.'}${qtdErros ? ` · ${qtdErros} erro(s) a corrigir` : ''}</span>
     <span class="cfg-actions">${dirty ? '<button class="btn ghost" type="button" data-cfg="discard">Descartar alterações</button>' : ''}
     <button class="btn primary" type="button" data-cfg="review" ${dirty && !qtdErros ? '' : 'disabled'}>Revisar e salvar →</button><button class="btn" type="button" data-cfg="close">Fechar</button></span>`;
}
function cfgHistHTML(){
  const historico = [...(estado.config.history || [])].reverse();
  const detalhes = entrada => !entrada.changes ? '' : typeof entrada.changes === 'string' ? ` <span class="hint">· ${escaparHtml(entrada.changes)}</span>` : ` <span class="hint">· K1: ${entrada.changes.k1} valores · K2: ${entrada.changes.k2} valores</span>`;
  return `<p class="hint mb10">Revisão vigente: <b>${estado.config.rev}</b>. Cada card usa o conjunto em uso até a primeira notificação ao cliente; depois as tabelas ficam fixadas nele.</p>
    <ul class="log">${historico.map(entrada => `<li><time>${formatarDataHora(entrada.t)} · revisão ${entrada.rev}</time>${escaparHtml(entrada.note)}${detalhes(entrada)}</li>`).join('')}</ul>`;
}
const cfgPassTxt = idade => idade ? (idade.pass === false ? 'não atende' : idade.pass ? 'atende' : 'sem fck') : '—';
function cfgSaveHTML(){
  const impacto = cfgImpact(cfgDraft), resumo = cfgSummary();
  const rows = impacto.rows.map(linha => linha.errors
    ? `<tr><td>${escaparHtml(linha.card.id)}</td><td>${escaparHtml(stageOf(linha.card.stage).name)}</td><td colspan="3">erros de validação: ${linha.errors[0]} → ${linha.errors[1]}</td></tr>`
    : `<tr><td>${escaparHtml(linha.card.id)}</td><td>${escaparHtml(stageOf(linha.card.stage).name)}</td><td>${linha.age} dias</td><td>${linha.antes ? formatarNumero(linha.antes.media, 2) : '—'} → ${linha.depois ? formatarNumero(linha.depois.media, 2) : '—'} MPa</td><td>${cfgPassTxt(linha.antes)} → ${cfgPassTxt(linha.depois)}</td></tr>`).join('');
  return `<h3 class="sub-h">Revisar e salvar (será a revisão ${estado.config.rev + 1})</h3>
    <ul class="premise mb10">${resumo.map(item => `<li>${escaparHtml(item)}</li>`).join('')}</ul>
    <div class="sec mt12"><h3>Impacto nos cards ainda não fixados</h3>
      ${impacto.rows.length ? `<div class="tbl-wrap"><table class="t plain"><thead><tr><th>Card</th><th>Etapa</th><th>Idade</th><th>fci,ext médio</th><th>Situação</th></tr></thead><tbody>${rows}</tbody></table></div>` : '<p class="hint">Nenhum card ativo muda de resultado.</p>'}
      <p class="hint mt8">${impacto.fixados} card(s) já tiveram a primeira notificação e mantêm as tabelas fixadas na época; não são afetados.</p></div>
    <label for="cfgNote" class="lbl-note">Motivo da alteração <span class="hint">(obrigatório)</span></label>
    <textarea id="cfgNote" class="ta" rows="3" placeholder="Ex.: atualizamos valores das tabelas conforme nova calibração"></textarea>
    <div class="rowline"><button class="btn primary" type="button" data-cfg="confirm">Confirmar e salvar</button><button class="btn" type="button" data-cfg="back">← Voltar à edição</button></div>`;
}

/* ----- fórmulas ----- */
function cfgFormHTML(){
  const previa = cfgFormPreview(), exemplo = CFG_SAMPLE();
  const rows = FORM_ORDER.map(chave => {
    const meta = FORM_META[chave] || {};
    const nomeDescritivo = meta.varName || chave;
    return `<tr id="cfgfr-${chave}"${previa[chave].error ? ' class="bad"' : ''}>
      <td><b>${escaparHtml(meta.label || chave)}</b><br><code>${escaparHtml(nomeDescritivo)}</code> <span class="hint mute">(${chave})</span></td>
      <td><input class="cfg-formula" type="text" spellcheck="false" autocomplete="off" data-cfgf="${chave}" value="${escaparHtml(cfgDraft.formulas[chave])}" aria-label="Fórmula de ${escaparHtml(meta.label || chave)}"><div class="hint txt-err" id="cfgfe-${chave}">${escaparHtml(previa[chave].error || '')}</div></td>
      <td class="num" id="cfgfv-${chave}">${previa[chave].error ? '—' : cfgFormatarNumero(previa[chave].value)}</td>
      <td><button class="btn sm ghost" type="button" data-cfg="frestore" data-k="${chave}" id="cfgfb-${chave}"${cfgDraft.formulas[chave] === FORM_DEFAULT[chave] ? ' hidden' : ''}>Restaurar padrão</button></td></tr>`;
  }).join('');
  return `<p class="hint">Cada fórmula é calculada na ordem da tabela e pode usar as variáveis de entrada descritivas e os resultados das etapas anteriores. As fórmulas são 100% autodocumentadas e fáceis de manter. Separe argumentos de funções com ponto e vírgula (;) e decimais com vírgula ou ponto.</p>
    <details class="cfg-gen" id="cfgGuideDetails"${cfgGuideOpen ? ' open' : ''}><summary>Guia de Variáveis, Funções e Operadores Disponíveis (clique para expandir)</summary>
      <div class="cfg-guide">
        <div class="cfg-card">
          <h4>Entradas do CP (Medições no Laboratório)</h4>
          <table>
            <tr><td class="cfg-c-var"><code>ALTURA_1..3</code></td><td class="cfg-c-desc">Alturas medidas do corpo de prova (mm)</td><td class="cfg-c-syn"><span class="syn">H1, H2, H3</span></td></tr>
            <tr><td class="cfg-c-var"><code>DIAMETRO_1..2</code></td><td class="cfg-c-desc">Diâmetros ortogonais medidos (mm)</td><td class="cfg-c-syn"><span class="syn">D1, D2</span></td></tr>
            <tr><td class="cfg-c-var"><code>MASSA_CP_KG</code></td><td class="cfg-c-desc">Massa aferida do corpo de prova (kg)</td><td class="cfg-c-syn"><span class="syn">MASSA</span></td></tr>
            <tr><td class="cfg-c-var"><code>CARGA_RUPTURA_TF</code></td><td class="cfg-c-desc">Carga de ruptura obtida na prensa (tf)</td><td class="cfg-c-syn"><span class="syn">CARGA</span></td></tr>
            <tr><td class="cfg-c-var"><code>SENTIDO_EXTRACAO</code></td><td class="cfg-c-desc">"Mesmo do lançamento" ou "Ortogonal"</td><td class="cfg-c-syn"><span class="syn">SENTIDO</span></td></tr>
            <tr><td class="cfg-c-var"><code>METODO_CURA</code></td><td class="cfg-c-desc">"Úmida" ou "Ao ar"</td><td class="cfg-c-syn"><span class="syn">CURA</span></td></tr>
            <tr><td class="cfg-c-var"><code>COEFICIENTE_ANGULAR</code></td><td class="cfg-c-desc">Coeficiente angular da prensa (A)</td><td class="cfg-c-syn"><span class="syn">A</span></td></tr>
            <tr><td class="cfg-c-var"><code>COEFICIENTE_LINEAR</code></td><td class="cfg-c-desc">Coeficiente linear da prensa (B)</td><td class="cfg-c-syn"><span class="syn">B</span></td></tr>
          </table>
        </div>
        <div class="cfg-card">
          <h4>Resultados Calculados (Etapas Anteriores)</h4>
          <table>
            <tr><td class="cfg-c-var"><code>ALTURA_MEDIA_MM</code></td><td class="cfg-c-desc">Média das 3 alturas calculadas (mm)</td><td class="cfg-c-syn"><span class="syn">h</span></td></tr>
            <tr><td class="cfg-c-var"><code>DIAMETRO_MEDIO_MM</code></td><td class="cfg-c-desc">Média dos 2 diâmetros calculados (mm)</td><td class="cfg-c-syn"><span class="syn">d</span></td></tr>
            <tr><td class="cfg-c-var"><code>RELACAO_HD</code></td><td class="cfg-c-desc">Relação de esbeltez do testemunho (h/d)</td><td class="cfg-c-syn"><span class="syn">hd</span></td></tr>
            <tr><td class="cfg-c-var"><code>MASSA_ESPECIFICA_KGM3</code></td><td class="cfg-c-desc">Massa específica aparente da amostra (kg/m³)</td><td class="cfg-c-syn"><span class="syn">rho</span></td></tr>
            <tr><td class="cfg-c-var"><code>FCI_INICIAL_MPA</code></td><td class="cfg-c-desc">Tensão inicial calculada com calibração (MPa)</td><td class="cfg-c-syn"><span class="syn">ini</span></td></tr>
            <tr><td class="cfg-c-var"><code>K1_CORRECAO_HD</code></td><td class="cfg-c-desc">Fator k1 por esbeltez h/d (NBR 7680-1)</td><td class="cfg-c-syn"><span class="syn">k1</span></td></tr>
            <tr><td class="cfg-c-var"><code>K2_CORRECAO_DIAMETRO</code></td><td class="cfg-c-desc">Fator k2 por broqueamento/diâmetro (NBR 7680-1)</td><td class="cfg-c-syn"><span class="syn">k2</span></td></tr>
            <tr><td class="cfg-c-var"><code>K3_CORRECAO_EXTRACAO</code></td><td class="cfg-c-desc">Fator k3 por direção de extração (NBR 7680-1)</td><td class="cfg-c-syn"><span class="syn">k3</span></td></tr>
            <tr><td class="cfg-c-var"><code>K4_CORRECAO_CURA</code></td><td class="cfg-c-desc">Fator k4 por condição de umidade/cura (NBR 7680-1)</td><td class="cfg-c-syn"><span class="syn">k4</span></td></tr>
            <tr><td class="cfg-c-var"><code>FCI_EXT_FINAL_MPA</code></td><td class="cfg-c-desc">Resistência à compressão corrigida final (MPa)</td><td class="cfg-c-syn"><span class="syn">fci</span></td></tr>
          </table>
        </div>
        <div class="cfg-card cfg-card-full">
          <h4>Funções, Operadores e Equivalentes em Inglês</h4>
          <table>
            <tr>
              <td class="cfg-c-var"><b>Matemática:</b></td>
              <td class="cfg-c-desc"><code>MEDIA(...)</code> <code>SOMA(...)</code> <code>MAX(...)</code> <code>MIN(...)</code> <code>ARRED(x; casas)</code> <code>RAIZ(x)</code> <code>ABS(x)</code> <code>PI()</code></td>
              <td class="cfg-c-syn"><span class="hint">AVERAGE, SUM, ROUND, SQRT</span></td>
            </tr>
            <tr>
              <td class="cfg-c-var"><b>Lógica & Tabelas:</b></td>
              <td class="cfg-c-desc"><code>SE(condição; verdadeiro; falso)</code> <code>E(...)</code> <code>OU(...)</code> · <code>TABELA_K1(h/d)</code> <code>TABELA_K2(diâmetro)</code></td>
              <td class="cfg-c-syn"><span class="hint">IF, AND, OR</span></td>
            </tr>
            <tr>
              <td class="cfg-c-var"><b>Operadores:</b></td>
              <td class="cfg-c-desc"><code>+</code> <code>-</code> <code>*</code> <code>/</code> <code>^</code> <code>( )</code> e comparações <code>=</code> <code>&lt;&gt;</code> <code>&lt;</code> <code>&gt;</code> <code>&lt;=</code> <code>&gt;=</code></td>
              <td class="cfg-c-syn"><span class="hint">Ponto e vírgula (;) separa argumentos</span></td>
            </tr>
          </table>
        </div>
      </div>
    </details>
    <details class="cfg-gen" id="cfgSampleDetails"${cfgSampleOpen ? ' open' : ''}>
      <summary>Valores do CP 1 (Placa 113 - 3 dias) usados como referência na prévia ao lado (clique para expandir)</summary>
      <div class="cfg-sample-bar">
        <div class="cfg-pill-list">
          <span class="cfg-pill"><b>ALTURA_1:</b> ${cfgFormatarNumero(exemplo.ALTURA_1)} mm</span>
          <span class="cfg-pill"><b>ALTURA_2:</b> ${cfgFormatarNumero(exemplo.ALTURA_2)} mm</span>
          <span class="cfg-pill"><b>ALTURA_3:</b> ${cfgFormatarNumero(exemplo.ALTURA_3)} mm</span>
          <span class="cfg-pill"><b>DIAMETRO_1:</b> ${cfgFormatarNumero(exemplo.DIAMETRO_1)} mm</span>
          <span class="cfg-pill"><b>DIAMETRO_2:</b> ${cfgFormatarNumero(exemplo.DIAMETRO_2)} mm</span>
          <span class="cfg-pill"><b>MASSA_CP_KG:</b> ${cfgFormatarNumero(exemplo.MASSA_CP_KG)} kg</span>
          <span class="cfg-pill"><b>CARGA_RUPTURA_TF:</b> ${cfgFormatarNumero(exemplo.CARGA_RUPTURA_TF)} tf</span>
          <span class="cfg-pill"><b>SENTIDO:</b> ${escaparHtml(exemplo.SENTIDO_EXTRACAO)}</span>
          <span class="cfg-pill cfg-pill-interactive">
            <b>CURA:</b>
            <span class="cfg-seg-switch" title="Alternar método de cura para testar o coeficiente k4 e o fci final na prévia">
              <button type="button" class="cfg-seg-btn ${cfgSampleCura === 'Úmida' ? 'active' : ''}" data-cfg="set-cura" data-cura="Úmida">Úmida</button>
              <button type="button" class="cfg-seg-btn ${cfgSampleCura === 'Ao ar' ? 'active' : ''}" data-cfg="set-cura" data-cura="Ao ar">Ao ar</button>
            </span>
          </span>
          <span class="cfg-pill"><b>COEFICIENTE ANGULAR (A):</b> ${cfgFormatarNumero(exemplo.COEF_ANGULAR_PRENSA)}</span>
          <span class="cfg-pill"><b>COEFICIENTE LINEAR (B):</b> ${cfgFormatarNumero(exemplo.COEF_LINEAR_PRENSA)}</span>
        </div>
      </div>
    </details>
    <div class="cfg-forms"><table><thead><tr><th>Cálculo / Variável</th><th>Fórmula</th><th>Resultado na prévia</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>
    <p class="mt8"><button class="btn sm" type="button" data-cfg="frestoreall">Restaurar todas as fórmulas padrão</button></p>`;
}
function cfgFormRefresh(){
  const previa = cfgFormPreview();
  FORM_ORDER.forEach(chave => {
    consultar('#cfgfe-' + chave).textContent = previa[chave].error || '';
    consultar('#cfgfv-' + chave).textContent = previa[chave].error ? '—' : cfgFormatarNumero(previa[chave].value);
    consultar('#cfgfb-' + chave).hidden = cfgDraft.formulas[chave] === FORM_DEFAULT[chave];
    consultar('#cfgfr-' + chave).className = previa[chave].error ? 'bad' : '';
  });
  renderCfgFoot();
}

/* ----- IA generativa (LLM) (OpenRouter) ----- */
let cfgIaCardId = null, cfgIaCustomNote = '';
function cfgModelKind(){ return cfgTab === 'decision' ? 'decision' : 'ai'; }
function cfgModelPreview(){
  const card = estado.cards.find(c => c.id === cfgIaCardId) || estado.cards[0];
  if(!card) return 'Cadastre um card para visualizar o pedido.';
  try {
    return JSON.stringify(cfgModelKind() === 'decision'
      ? AiPipeline.buildDecisionRequest(card,cfgDraft)
      : AiPipeline.buildAiRequest(card,cfgDraft,cfgIaCustomNote),null,2);
  } catch(error) { return error.message; }
}
function cfgIaUpdatePromptBox(){
  const box = consultar('#cfgModelPreview');
  if(box) box.value = cfgModelPreview();
  const errors = consultar('#cfgModelErrors');
  if(errors) errors.textContent = AiPipeline.validate(cfgModelKind(),cfgDraft[cfgModelKind()]).join(' ');
}
function cfgModelHTML(){
  const kind = cfgModelKind(), c = cfgDraft[kind], decision = kind === 'decision';
  const field = (key,label,type='text',extra='') => `<label class="model-field" for="model-${key}"><span>${label}</span><input id="model-${key}" type="${type}" ${extra} data-model-field="${key}" value="${escaparHtml(c[key])}"></label>`;
  const text = (key,label,value=c[key]) => `<label class="model-field" for="model-${key}"><span>${label}</span><textarea id="model-${key}" class="ta" rows="4" data-model-field="${key}" spellcheck="false">${escaparHtml(value)}</textarea></label>`;
  const cards = estado.cards;
  if(!cards.some(card => card.id === cfgIaCardId)) cfgIaCardId = cards[0]?.id || null;
  return `<div class="model-settings">
    <p class="hint">${decision ? 'Classificação automática antes do parecer. Edite os critérios e o contexto enviado ao modelo.' : 'Configure o parecer técnico. A classificação prévia é incluída automaticamente no contexto.'}</p>
    ${decision ? '' : '<p class="hint">Somente openrouter/free · 60 segundos por chamada. Em falha: até 3 novas tentativas após 5, 10 e 15 segundos. O erro é exibido após esgotar as tentativas.</p>'}
    <div class="model-fields">${field('model','Modelo OpenRouter','text',decision ? '' : 'readonly')}${field('timeoutSeconds','Tempo limite por consulta (segundos)','number','min="1" max="300" step="1"' + (decision ? '' : ' readonly'))}
    ${decision ? `<label class="model-field" for="model-format"><span>Formato dos dados</span><select id="model-format" data-model-field="dataFormat"><option value="json" ${c.dataFormat === 'json' ? 'selected' : ''}>JSON estruturado</option><option value="text" ${c.dataFormat === 'text' ? 'selected' : ''}>Texto</option></select></label>` : field('temperature','Temperatura','number','min="0" max="2" step="0.1"') + field('maxTokens','Limite de tokens','number','min="1" max="128000" step="1"')}
    </div>
    ${decision ? text('instructions','Instruções de classificação') + Object.entries({conforme:'Conforme',atencao:'Atenção',nao_conforme:'Não conforme'}).map(([key,label]) => text('criteria.'+key,'Critério: '+label,c.criteria[key])).join('') : text('promptSystem','Prompt de sistema') + text('userInstructions','Instruções do parecer') + text('userTemplate','Template da mensagem') + '<p class="hint">Variáveis: {{dados}}, {{placa}}, {{cardId}}, {{observacao}} e {{instrucoes}}. O template precisa incluir {{dados}}. A decisão é acrescentada ao final.</p>'}
    <fieldset class="model-data"><legend>Dados enviados ao modelo</legend><div class="model-group-list">${Object.entries(AiPipeline.groups).map(([key,label]) => `<label><input type="checkbox" data-model-group="${key}" ${c.dataGroups[key] ? 'checked' : ''}> ${label}</label>`).join('')}</div></fieldset>
    <div id="cfgModelErrors" class="hint txt-err" role="status">${escaparHtml(AiPipeline.validate(kind,c).join(' '))}</div>
    <div class="model-preview-head"><h3>Prévia do pedido enviado</h3><label for="cfgIaCardSelect">Card <select id="cfgIaCardSelect">${cards.map(card => `<option value="${escaparHtml(card.id)}" ${card.id === cfgIaCardId ? 'selected' : ''}>${escaparHtml(card.id)} · Placa ${escaparHtml(card.ident?.placa || card.id)}</option>`).join('')}</select></label></div>
    ${decision ? '' : `<label class="model-field" for="cfgIaCustomNote"><span>Observação adicional para simular na prévia</span><input id="cfgIaCustomNote" value="${escaparHtml(cfgIaCustomNote)}"></label>`}
    <textarea id="cfgModelPreview" class="cfg-prompt-box" rows="14" readonly aria-label="Corpo da requisição">${escaparHtml(cfgModelPreview())}</textarea>
    <div class="rowline"><button type="button" class="btn sm" data-cfg="reset-model">Restaurar padrões desta etapa</button><button type="button" class="btn primary sm" data-cfg="copy-model">Copiar prévia</button></div>
  </div>`;
}

/* ----- ações ----- */
function cfgRefreshAll(){ renderCfgSwitch(); renderCfgSetBar(); renderCfgTabs(); renderCfgBody(); renderCfgFoot(); }
function cfgEdit(campo){
  const [tabela, indice] = campo.dataset.cfgv.split(':'), conjunto = cfgCurSet(), valor = campo.value === '' ? null : Number(campo.value);
  conjunto[tabela][+indice][1] = Number.isFinite(valor) ? valor : null;
  const linhaTabela = consultar(`#cfgr-${tabela}-${indice}`); if(linhaTabela) linhaTabela.className = Number.isFinite(conjunto[tabela][+indice][1]) ? '' : 'bad';
  consultar('#cfgBad').innerHTML = cfgBadHTML(conjunto, tabela);
  renderCfgFoot();
}
function cfgNewSet(name, tables, origem){
  let nome = name || 'Novo conjunto', sufixo = 2;
  while(cfgDraft.sets.some(existente => String(existente.name).trim().toLowerCase() === nome.trim().toLowerCase())) nome = `${name} (${sufixo++})`;
  const conjunto = {id: 'c-' + Date.now().toString(36) + Math.floor(Math.random() * 1e3), name: nome, builtin: false, k1: tables.k1.map(linha => [linha[0], linha[1]]), k2: tables.k2.map(linha => [linha[0], linha[1]])};
  cfgDraft.sets.push(conjunto); cfgDraft.active = conjunto.id;
  return conjunto;
}
function cfgDuplicate(){
  const atual = cfgCurSet(), tabelas = cfgSetTables(atual);
  const copia = cfgNewSet(atual.name + ' (cópia)', tabelas);
  cfgMsg = {kind: 'info', text: `Criado «${copia.name}» a partir de «${atual.name}». Edite os valores à vontade; ainda não salvo.`};
  cfgRefreshAll();
}
function cfgDelete(){
  const conjunto = cfgCurSet(); if(conjunto.builtin) return;
  cfgDraft.sets = cfgDraft.sets.filter(outro => outro.id !== conjunto.id); cfgDraft.active = cfgDraft.sets.some(outro => outro.id === estado.config.active) ? estado.config.active : 'planilha';
  cfgMsg = {kind: 'info', text: `Conjunto «${conjunto.name}» excluído. Ainda não salvo; os cards que já fixaram suas tabelas não são afetados.`};
  cfgRefreshAll();
}
function cfgExport(){
  const conjunto = cfgCurSet(), tabelas = cfgSetTables(conjunto);
  const link = document.createElement('a');
  link.href = URL.createObjectURL(new Blob([JSON.stringify({formato: 'rt-tabelas-k', versao: 1, nome: conjunto.name, k1: tabelas.k1, k2: tabelas.k2}, null, 1)], {type: 'application/json'}));
  link.download = 'tabelas-k-' + conjunto.name.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') + '.json';
  link.click(); setTimeout(() => URL.revokeObjectURL(link.href), 1500);
}
function cfgPickFile(){
  const entradaArquivo = document.createElement('input'); entradaArquivo.type = 'file'; entradaArquivo.accept = '.xlsx,.xlsm,.json';
  entradaArquivo.onchange = () => { if(entradaArquivo.files[0]) cfgImportFile(entradaArquivo.files[0]); };
  entradaArquivo.click();
}
async function cfgImportFile(file){
  try {
    let tables, nome = file.name.replace(/\.[^.]+$/, '');
    if(/\.json$/i.test(file.name)){ const json = JSON.parse(await file.text()); tables = cfgFromJson(json); if(json.nome) nome = String(json.nome); }
    else { if(typeof XLSX === 'undefined') throw new Error('a biblioteca de leitura de planilhas não foi carregada'); tables = cfgFromWorkbook(XLSX.read(await file.arrayBuffer(), {type: 'array'})); }
    const conjunto = cfgNewSet(nome, {k1: tables.k1.rows, k2: tables.k2.rows});
    cfgMsg = {kind: 'info', text: `Importado de «${file.name}» como «${conjunto.name}»: K1 com ${tables.k1.rows.length} linhas (${tables.k1.interpoladas} interpoladas) e K2 com ${tables.k2.rows.length} linhas (${tables.k2.interpoladas} interpoladas). Ainda não salvo.`};
  } catch(erro){
    cfgMsg = {kind: 'err', text: 'Não foi possível importar: ' + (erro.message || erro)};
  }
  if(cfgDraft){ cfgStep = 'edit'; cfgRefreshAll(); }
}
function cfgGenerate(){
  const tabela = cfgTab, conjunto = cfgCurSet(), texto = consultar('#cfgPts').value, pontos = [], linhasRuins = [];
  texto.split(/\r?\n/).forEach((linha, indice) => {
    linha = linha.trim(); if(!linha) return;
    const partes = linha.split(/[;\t ]+/).filter(Boolean).map(parte => Number(parte.replace(',', '.')));
    if(partes.length < 2 || !Number.isFinite(partes[0]) || !Number.isFinite(partes[1])) linhasRuins.push(indice + 1); else pontos.push([partes[0], partes[1]]);
  });
  pontos.sort((pontoA, pontoB) => pontoA[0] - pontoB[0]);
  const repetidas = pontos.some((ponto, indice) => indice > 0 && Math.abs(ponto[0] - pontos[indice - 1][0]) < 1e-9);
  if(linhasRuins.length || pontos.length < 2 || repetidas){
    cfgMsg = {kind: 'err', text: linhasRuins.length ? `Linha(s) ${linhasRuins.join(', ')} não entendida(s): use "chave; valor".` : (repetidas ? 'Há chaves repetidas nos pontos.' : 'Informe ao menos 2 pontos.')};
  } else {
    let geradas = 0, mantidas = 0;
    conjunto[tabela] = conjunto[tabela].map(([chave, valor]) => { const interpolado = cfgInterpolar(pontos, chave); if(interpolado === null){ mantidas++; return [chave, valor]; } geradas++; return [chave, cfgArredondar8(interpolado)]; });
    cfgMsg = {kind: 'info', text: `${geradas} linha(s) geradas por interpolação${mantidas ? `; ${mantidas} fora do intervalo dos pontos foram mantidas` : ''}. Ainda não salvo.`};
  }
  cfgRefreshAll();
}
function cfgConfirm(){
  if(cfgErrorCount()){ toast("Corrija os erros de configuração antes de salvar.", "err"); return; }
  const note = (consultar('#cfgNote').value || '').trim();
  if(!note){ consultar('#cfgNote').classList.add('need'); toast('Escreva o motivo da alteração.', 'warn'); return; }
  const impacto = cfgImpact(cfgDraft), changes = cfgSummary().join('; ');
  const revisao = estado.config.rev + 1;
  estado.config = {
    rev: revisao,
    active: cfgDraft.active,
    sets: JSON.parse(JSON.stringify(cfgDraft.sets)),
    formulas: {...cfgDraft.formulas},
    ai: JSON.parse(JSON.stringify(cfgDraft.ai)),
    decision: JSON.parse(JSON.stringify(cfgDraft.decision)),
    history: [...(estado.config.history || []), {t: new Date().toISOString(), rev: revisao, note, changes}]
  };
  new Set(impacto.rows.map(linha => linha.card)).forEach(card => addLog(card, `Tabelas ou fórmulas atualizadas (revisão ${revisao}): resultado recalculado`));
  save(); renderBoard();
  cfgDraft = cfgCloneState(estado.config); cfgStep = 'edit'; cfgTab = 'hist'; cfgMsg = null;
  renderConfig();
  toast(`Configuração salva: revisão ${revisao}.`, 'ok');
}

/* ----- eventos do modal (só agem quando o editor está aberto) ----- */
(function(){
  const modal = document.querySelector('#modal');
  modal.addEventListener('click', evento => {
    if(!cfgDraft) return;
    const botaoConjunto = evento.target.closest('[data-cfg-set]');
    if(botaoConjunto){ cfgDraft.active = botaoConjunto.dataset.cfgSet; cfgMsg = null; cfgStep = 'edit'; cfgRefreshAll(); return; }
    const botaoAba = evento.target.closest('[data-cfg-tab]');
    if(botaoAba){ cfgTab = botaoAba.dataset.cfgTab; cfgStep = 'edit'; cfgMsg = null; cfgRefreshAll(); return; }
    const botaoAcao = evento.target.closest('[data-cfg]'); if(!botaoAcao) return;
    switch(botaoAcao.dataset.cfg){
      case 'reset-model':
        cfgDraft[cfgModelKind()] = AiPipeline.config(cfgModelKind(), cfgModelKind() === 'ai' ? AI_DEFAULT_CONFIG : {});
        renderCfgBody(); renderCfgFoot(); break;
      case 'copy-model':
        navigator.clipboard.writeText(cfgModelPreview()).then(() => toast('Prévia copiada.', 'ok')).catch(() => toast('Não foi possível copiar.', 'err')); break;
      case 'set-cura': {
        const novaCura = botaoAcao.dataset.cura;
        if(novaCura && novaCura !== cfgSampleCura){
          cfgSampleCura = novaCura;
          modal.querySelectorAll('[data-cfg="set-cura"]').forEach(btn => {
            btn.classList.toggle('active', btn.dataset.cura === cfgSampleCura);
          });
          cfgFormRefresh();
        }
        break;
      }
      case 'import': cfgPickFile(); break;
      case 'dup': cfgDuplicate(); break;
      case 'delete': cfgDelete(); break;
      case 'export': cfgExport(); break;
      case 'frestore': { const chave = botaoAcao.dataset.k; cfgDraft.formulas[chave] = FORM_DEFAULT[chave]; consultar(`[data-cfgf="${chave}"]`).value = FORM_DEFAULT[chave]; cfgFormRefresh(); break; }
      case 'frestoreall': cfgDraft.formulas = {...FORM_DEFAULT}; cfgMsg = {kind: 'info', text: 'Fórmulas padrão restauradas. Ainda não salvo.'}; renderCfgBody(); renderCfgFoot(); break;
      case 'gen': cfgGenerate(); break;
      case 'discard': cfgDraft = cfgCloneState(estado.config); cfgMsg = null; cfgStep = 'edit'; cfgRefreshAll(); break;
      case 'review': if(!cfgErrorCount() && cfgDirty()){ cfgStep = 'save'; cfgRefreshAll(); } break;
      case 'back': cfgStep = 'edit'; cfgRefreshAll(); break;
      case 'confirm': cfgConfirm(); break;
      case 'close': closeModal(); break;
    }
  });
  modal.addEventListener('toggle', evento => {
    if(evento.target.id === 'cfgGuideDetails') cfgGuideOpen = evento.target.open;
    if(evento.target.id === 'cfgSampleDetails') cfgSampleOpen = evento.target.open;
  }, true);
  modal.addEventListener('change', evento => {
    if(!cfgDraft) return;
    if(evento.target.id === 'cfgIaCardSelect'){
      cfgIaCardId = evento.target.value;
      cfgIaUpdatePromptBox();
      return;
    }
  });
  modal.addEventListener('input', evento => {
    if(!cfgDraft) return;
    const modelField = evento.target.dataset.modelField;
    if(modelField){
      const c = cfgDraft[cfgModelKind()], value = evento.target.value;
      if(modelField.startsWith('criteria.')) c.criteria[modelField.split('.')[1]] = value;
      else c[modelField] = ['temperature','timeoutSeconds','maxTokens'].includes(modelField) ? (value === '' ? null : Number(value)) : modelField === 'fallbackModels' ? value.split(/\r?\n/).map(v => v.trim()).filter(Boolean) : value;
      cfgIaUpdatePromptBox(); renderCfgFoot(); return;
    }
    if(evento.target.dataset.modelGroup){
      cfgDraft[cfgModelKind()].dataGroups[evento.target.dataset.modelGroup] = evento.target.checked;
      cfgIaUpdatePromptBox(); renderCfgFoot(); return;
    }
    if(evento.target.id === 'cfgIaCustomNote'){
      cfgIaCustomNote = evento.target.value;
      cfgIaUpdatePromptBox();
      return;
    }
    const campoNome = evento.target.closest('[data-cfg-name]');
    if(campoNome){ const conjunto = cfgCurSet(); conjunto.name = campoNome.value; renderCfgSwitch(); consultar('#cfgNameProb').textContent = cfgNameProblem(conjunto); renderCfgFoot(); return; }
    const campoFormula = evento.target.closest('[data-cfgf]');
    if(campoFormula){ cfgDraft.formulas[campoFormula.dataset.cfgf] = campoFormula.value; cfgFormRefresh(); return; }
    const campoValor = evento.target.closest('[data-cfgv]'); if(campoValor) cfgEdit(campoValor);
  });
})();
