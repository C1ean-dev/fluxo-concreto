/* Fluxo de Relatórios · Concreto projetado — lógica da aplicação (protótipo).
   Depende, nesta ordem, de: js/vendor/xlsx.mini.min.js (XLSX), js/tabelas-k.js (K1_TABLE, K2_TABLE)
   js/parser.js (parseWorkbook), js/formulas.js (motor de fórmulas) e js/config.js (tabelas e fórmulas em uso). Scripts clássicos: funcionam abrindo o HTML direto do disco. */

/* ===== Tabelas K1 e K2 =====
   Valores originais da planilha: js/tabelas-k.js. Tabelas em uso, edição e revisões: js/config.js (cfgOf, cfgMaps) */

/* ===== Regras vindas do e-mail ===== */
const TOLERANCIA_MEDIDAS = 0.10;            // divergência máxima entre medidas individuais
const FCI_MAX = 70;          // MPa: acima disso, provável erro de digitação
const LIMITE_POR_IDADE = {3:0.5, 7:0.75, 28:1};   // fração do fck por idade (EGTC)
const AGES = [3,7,28];
const SENTIDOS = ['Mesmo do lançamento','Ortogonal'];
const CURAS = ['Úmida','Ao ar'];
const GRAVIDADE = 9.80665;

/* ===== Etapas do fluxo ===== */
const STAGES = [
  {id:'entrada',    name:'Entrada de dados',  role:'Técnico de ensaio',   desc:'Digitar ou importar a planilha do ensaio',
   gate:'Ao enviar, o card entra na Análise. Exige ao menos um CP lançado.'},
  {id:'analise',    name:'Análise',           role:'Sistema',             desc:'Validação automática; cada erro mostra onde está',
   gate:'Com erros, o card fica aqui até a correção. Sem erros, segue para Ajuste (se alguma idade ficou abaixo do mínimo) ou direto para IA de Decisão / classificação.'},
  {id:'ajuste',     name:'Ajuste',            role:'Laboratório',         desc:'Métricas abaixo do mínimo: verificar e editar',
   gate:'Só entram aqui idades abaixo do mínimo. Para sair: caixa "Conferi as medições" marcada e justificativa preenchida. Segue para IA de Decisão / classificação.'},
  {id:'decision', name:'IA de Decisão / classificação', role:'IA de Decisão / classificação', desc:'Classificação automática de conformidade antes do parecer técnico',
   gate:'Uma classificação válida é obrigatória. Todas as classes seguem como contexto para a LLM; em falha, tente novamente.'},
  {id:'ia',         name:'IA generativa (LLM)',     role:'IA generativa (LLM)', desc:'Parecer técnico e diagnóstico antes do envio ao cliente',
   gate:'Após gerar um parecer válido, o card segue automaticamente para Notificar cliente. Em falha, permanece aqui para nova tentativa.'},
  {id:'notificar',  name:'Notificar cliente', role:'Setor de relatórios', desc:'Manual, com texto pronto e envio em 1 clique',
   gate:'Ao notificar as idades pendentes, vai para Aguardando idades (faltam idades) ou para Relatório final (3, 7 e 28 dias notificados). Antes de notificar, dá para voltar ao Ajuste para corrigir dados.'},
  {id:'aguardando', name:'Aguardando idades', role:'Laboratório',         desc:'Faltam resultados de 3, 7 ou 28 dias',
   gate:'Quando os dados da próxima idade são lançados ou importados, o card volta para a Análise.'},
  {id:'relatorio',  name:'Relatório final',   role:'Setor de relatórios', desc:'3, 7 e 28 dias notificados: enviar o relatório final',
   gate:'Ao enviar o relatório final ao cliente, o card é finalizado.'},
  {id:'finalizado', name:'Finalizado',        role:'—',                   desc:'3, 7 e 28 dias notificados e relatório final enviado',
   gate:'Pode ser reaberto no Relatório final.'}
];
const TRANSITIONS = {
  entrada:['analise'],
  analise:['entrada','ajuste','decision'],
  ajuste:['analise','decision'],
  decision:['analise','ajuste','ia'],
  ia:['ajuste','analise','decision','notificar'],
  notificar:['decision','ia','ajuste','aguardando','relatorio'],
  aguardando:['analise'],
  relatorio:['finalizado'],
  finalizado:['relatorio']
};
const stageOf = idEtapa => STAGES.find(etapa => etapa.id === idEtapa);
const EDIT_STAGES = ['entrada','analise','ajuste','decision','ia','aguardando'];
const UPDATABLE = ['entrada','analise','ajuste','decision','ia','notificar','aguardando'];

const IDENT_FIELDS = [
  {chave:'relNumero', label:'Nº do relatório'},
  {chave:'interessado', label:'Interessado', req:true, wide:true},
  {chave:'emailCliente', label:'E-mail do cliente (destinatário)', type:'email', extra:true},
  {chave:'central', label:'Central', req:true},
  {chave:'fck', label:'fck 28 dias (MPa)', type:'number', req:true},
  {chave:'abatimento', label:'Abatimento especificado'},
  {chave:'cimentoMarca', label:'Cimento (marca)', req:true},
  {chave:'cimentoTipo', label:'Cimento (tipo)', req:true},
  {chave:'cimentoConsumo', label:'Consumo de cimento (kg/m³)', type:'number'},
  {chave:'aditivo', label:'Aditivo 1'},
  {chave:'acelerador', label:'Acelerador'},
  {chave:'aceleradorConsumo', label:'Consumo do acelerador (kg/m³)', type:'number'},
  {chave:'agregados', label:'Agregados'},
  {chave:'maquina', label:'Máquina de ensaio'},
  {chave:'dataProjecao', label:'Data de projeção', type:'date', req:true},
  {chave:'coletadoPor', label:'Coletado por'},
  {chave:'coletadoEm', label:'Coletado em'},
  {chave:'elemento', label:'Elemento projetado', req:true, wide:true},
  {chave:'placa', label:'Placa', req:true},
  {chave:'nf', label:'Nota fiscal', req:true}
];
const IDENT_REQ = IDENT_FIELDS.filter(campo => campo.req).map(campo => campo.chave);
const IDENT_LABEL = Object.fromEntries(IDENT_FIELDS.map(campo => [campo.chave, campo.label]));
const IDENT_CELL = {interessado:'P14', central:'M26', fck:'Z26', cimentoMarca:'P28', cimentoTipo:'Y28', dataProjecao:'P31', elemento:'P32', placa:'L33', nf:'S33'};

/* ===== Utilidades ===== */
const consultar = (seletor, raiz=document) => raiz.querySelector(seletor);
const escaparHtml = valor => String(valor ?? '').replace(/[&<>"']/g, caractere => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[caractere]));
const paraNumero = valor => { if (valor === '' || valor === null || valor === undefined) return null; const numero = Number(valor); return Number.isFinite(numero) ? numero : null; };
const calcularMedia = valores => valores.reduce((soma,valor) => soma + valor, 0) / valores.length;
const formatarNumero = (valor, casas=2) => (valor === null || valor === undefined || valor === '' || Number.isNaN(valor)) ? '—' : Number(valor).toLocaleString('pt-BR', {minimumFractionDigits:casas, maximumFractionDigits:casas});
const formatarDataHora = dataIso => { try { return new Date(dataIso).toLocaleString('pt-BR', {dateStyle:'short', timeStyle:'short'}); } catch { return dataIso; } };
const formatarData = dataIso => { try { return new Date(dataIso).toLocaleDateString('pt-BR'); } catch { return dataIso; } };
const ehVazio = valor => valor === '' || valor === null || valor === undefined;
function expectedDateIso(card, idade){
  const projecao = card.ident.dataProjecao; if(!projecao) return '';
  const data = new Date(projecao + 'T00:00:00Z'); if(isNaN(data)) return '';
  data.setUTCDate(data.getUTCDate() + idade); return data.toISOString().slice(0,10);
}
function expectedDate(card, idade){
  const iso = expectedDateIso(card,idade);
  return iso ? new Date(iso + 'T00:00:00Z').toLocaleDateString('pt-BR', {timeZone:'UTC'}) : '';
}
function ageDeadlineStatus(card, idade, avaliacao, now=new Date()){
  if(card.notified[idade]) return {label:'Notificado',tone:'mute'};
  if(avaliacao.ages[idade]?.media != null) return {label:'Resultado disponível',tone:'info'};
  const due = expectedDateIso(card,idade);
  if(!due) return {label:'Sem data prevista',tone:'mute'};
  const parts = new Intl.DateTimeFormat('en-US',{timeZone:'America/Sao_Paulo',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(now);
  const part = type => parts.find(p => p.type === type).value;
  const today = `${part('year')}-${part('month')}-${part('day')}`;
  return today > due ? {label:'Atrasado',tone:'err'} : today === due ? {label:'Alerta',tone:'warn'} : {label:'Em prazo',tone:'ok'};
}
function ageDeadlineHtml(card, idade, avaliacao){
  const status = ageDeadlineStatus(card,idade,avaliacao);
  return `<span class="pill ${status.tone}">${status.label}</span>`;
}

/* ===== Localização dos erros ===== */
const COLUNAS_PLAN1 = {h:['G','H','I'], d:['J','K'], massa:'L', carga:'N', sentido:'P', cura:'Q'};
const FNAME = {massa:'Massa', carga:'Carga de ruptura', sentido:'Sentido de extração', cura:'Método de cura', idade:'Idade'};
function cellsText(indice, fields){
  const linhaPlan1 = 7 + indice, celulas = [];
  const referenciasAltura = fields.filter(referencia => referencia.nome === 'h'), referenciasDiametro = fields.filter(referencia => referencia.nome === 'd');
  if(referenciasAltura.length === 3) celulas.push(`Plan1!G${linhaPlan1}:I${linhaPlan1}`); else referenciasAltura.forEach(referencia => celulas.push(`Plan1!${COLUNAS_PLAN1.h[referencia.posicao]}${linhaPlan1}`));
  if(referenciasDiametro.length === 2) celulas.push(`Plan1!J${linhaPlan1}:K${linhaPlan1}`); else referenciasDiametro.forEach(referencia => celulas.push(`Plan1!${COLUNAS_PLAN1.d[referencia.posicao]}${linhaPlan1}`));
  fields.forEach(referencia => {
    if(['massa','carga','sentido','cura'].includes(referencia.nome)) celulas.push(`Plan1!${COLUNAS_PLAN1[referencia.nome]}${linhaPlan1}`);
    if(referencia.nome === 'idade') celulas.push('coluna Idade');
  });
  return celulas.join(', ');
}
const chaveDoCampo = (indice, nomeCampo, posicao) => `p:${indice}:${nomeCampo}:${posicao ?? ''}`;

/* ===== Cálculo (reproduz as fórmulas da planilha) ===== */
function cpEnv(card, cp){ return AiPipeline.cpEnv(card, cp); }
function calcCP(card, cp, tabelasAlternativas){
  const alturas = cp.h.map(paraNumero), diametros = cp.d.map(paraNumero), massa = paraNumero(cp.massa), carga = paraNumero(cp.carga);
  const started = [...cp.h, ...cp.d, cp.massa, cp.carga, cp.sentido, cp.cura].some(valor => !ehVazio(valor));
  const resultado = {started, errors:[], vals:{}};
  if(!started) return resultado;
  const valores = resultado.vals, tabelas = tabelasAlternativas || cfgOf(card), mapas = cfgMaps(tabelas);
  const faltantes = [], camposFaltando = [];
  alturas.forEach((valor,indice) => { if(valor === null){ faltantes.push('Altura ' + (indice+1)); camposFaltando.push({nome:'h', posicao:indice}); } });
  diametros.forEach((valor,indice) => { if(valor === null){ faltantes.push('Diâmetro D' + (indice+1)); camposFaltando.push({nome:'d', posicao:indice}); } });
  if(massa === null){ faltantes.push('Massa'); camposFaltando.push({nome:'massa'}); }
  if(carga === null){ faltantes.push('Carga de ruptura'); camposFaltando.push({nome:'carga'}); }
  if(!cp.sentido){ faltantes.push('Sentido de extração'); camposFaltando.push({nome:'sentido'}); }
  if(!cp.cura){ faltantes.push('Método de cura'); camposFaltando.push({nome:'cura'}); }
  if(!cp.idade){ faltantes.push('Idade'); camposFaltando.push({nome:'idade'}); }
  if(faltantes.length) resultado.errors.push({kind:'vazio', msg:'Campo(s) sem preenchimento: ' + faltantes.join(', '), fields:camposFaltando});
  const naoPositivos = [];
  alturas.forEach((valor,indice) => { if(valor !== null && valor <= 0) naoPositivos.push({nome:'h', posicao:indice}); });
  diametros.forEach((valor,indice) => { if(valor !== null && valor <= 0) naoPositivos.push({nome:'d', posicao:indice}); });
  if(massa !== null && massa <= 0) naoPositivos.push({nome:'massa'});
  if(carga !== null && carga <= 0) naoPositivos.push({nome:'carga'});
  if(naoPositivos.length) resultado.errors.push({kind:'invalido', msg:'Há valores zero ou negativos', fields:naoPositivos});
  const alturasValidas = alturas.every(valor => valor !== null && valor > 0), diametrosValidos = diametros.every(valor => valor !== null && valor > 0);
  const camposAlturas = [{nome:'h',posicao:0},{nome:'h',posicao:1},{nome:'h',posicao:2}], camposDiametros = [{nome:'d',posicao:0},{nome:'d',posicao:1}];
  if(alturasValidas){
    const alturaMedia = calcularMedia(alturas), dispersao = (Math.max(...alturas) - Math.min(...alturas)) / alturaMedia;
    if(dispersao > TOLERANCIA_MEDIDAS) resultado.errors.push({kind:'diverg', msg:`Alturas (${alturas.map(valor => formatarNumero(valor,2)).join(' / ')} mm) divergem ${formatarNumero(dispersao*100,1)}% entre si; limite de 10%`, fields:camposAlturas});
  }
  if(diametrosValidos){
    const diametroMedio = calcularMedia(diametros), dispersao = (Math.max(...diametros) - Math.min(...diametros)) / diametroMedio;
    if(dispersao > TOLERANCIA_MEDIDAS) resultado.errors.push({kind:'diverg', msg:`Diâmetros D1 e D2 (${diametros.map(valor => formatarNumero(valor,2)).join(' / ')} mm) divergem ${formatarNumero(dispersao*100,1)}%; limite de 10%`, fields:camposDiametros});
    valores.d1 = diametros[0]; valores.d0 = Math.round(diametroMedio);
  }
  // fórmulas editáveis (Configurações), calculadas em ordem; entradas inválidas deixam o resultado sem valor
  const compiladas = cfgCompiled(tabelas), variaveis = cpEnv(card, cp), contexto = {maps: mapas};
  FORM_ORDER.forEach(chave => {
    const nomeVariavel = chave.toUpperCase(), compilada = compiladas[chave];
    const varNameDescritivo = FORM_META[chave] && FORM_META[chave].varName;
    variaveis[nomeVariavel] = null;
    if(varNameDescritivo) variaveis[varNameDescritivo] = null;
    if(compilada.error){ resultado.errors.push({kind:'formula', msg:`Fórmula de ${FORM_META[chave].label} inválida: ${compilada.error}`, fields:FORM_META[chave].fields}); return; }
    try {
      const val = formEval(compilada.ast, variaveis, contexto);
      variaveis[nomeVariavel] = valores[chave] = val;
      if(varNameDescritivo) variaveis[varNameDescritivo] = val;
      Object.entries(FORM_VAR_ALIASES).forEach(([alias, target]) => {
        if(target === nomeVariavel) variaveis[alias] = val;
      });
    }
    catch(erro){
      if(erro instanceof MissingInput) return;
      if(erro instanceof LookupError){
        resultado.errors.push(erro.table === 'K1'
          ? {kind:'coef', msg:`k1 não encontrado: h/d = ${formatarNumero(variaveis.HD != null ? variaveis.HD : (variaveis.RELACAO_HD != null ? variaveis.RELACAO_HD : erro.arg), 3)} fora da tabela (${formatarNumero(mapas.k1min,2)} a ${formatarNumero(mapas.k1max,2)})`, fields:[...camposAlturas, ...camposDiametros]}
          : {kind:'coef', msg:`k2 não encontrado: diâmetro médio ${formatarNumero(variaveis.D != null ? variaveis.D : (variaveis.DIAMETRO_MEDIO_MM != null ? variaveis.DIAMETRO_MEDIO_MM : erro.arg), 2)} mm fora da tabela (${mapas.k2min} a ${mapas.k2max} mm)`, fields:camposDiametros});
        return;
      }
      resultado.errors.push({kind:'formula', msg:`Fórmula de ${FORM_META[chave].label}: ${erro.message}`, fields:FORM_META[chave].fields});
    }
  });
  if(valores.hd != null) valores.hdR = formArredondar(valores.hd, 2);
  if(valores.fci != null && valores.fci > FCI_MAX) resultado.errors.push({kind:'limite', msg:`fci,ext = ${formatarNumero(valores.fci,1)} MPa, acima de ${FCI_MAX} MPa (provável erro de digitação, por exemplo na carga de ruptura)`, fields:[{nome:'carga'}], extra:'V'});
  return resultado;
}

const RULES = [
  {kind:'ident',    title:'Identificação completa'},
  {kind:'vazio',    title:'Campos dos CPs preenchidos'},
  {kind:'invalido', title:'Valores positivos'},
  {kind:'diverg',   title:'Medidas com divergência de até 10%'},
  {kind:'limite',   title:`fci,ext de até ${FCI_MAX} MPa`},
  {kind:'coef',     title:'Coeficientes k1 e k2 encontrados nas tabelas'},
  {kind:'formula',  title:'Fórmulas calculadas sem erro'}
];

function evaluate(card, tabelasAlternativas){
  const rows = card.cps.map((cp,indice) => ({cp, indice: indice, calculo:calcCP(card, cp, tabelasAlternativas)}));
  const errors = [];
  const faltantes = IDENT_REQ.filter(chave => !String(card.ident[chave] ?? '').trim() || (chave === 'fck' && !(paraNumero(card.ident.fck) > 0)));
  if(faltantes.length) errors.push({where:'Identificação', kind:'ident', msg:'Falta preencher ou corrigir: ' + faltantes.map(chave => IDENT_LABEL[chave]).join(', '),
    fields:faltantes.map(chave => ({ident:chave})), cells:faltantes.map(chave => IDENT_CELL[chave] ? 'Relatório!' + IDENT_CELL[chave] : '').filter(Boolean).join(', ')});
  rows.forEach(linha => linha.calculo.errors.forEach(erro => errors.push({where:'CP ' + linha.cp.n, cp:linha.indice, kind:erro.kind, msg:erro.msg, fields:erro.fields,
    cells:cellsText(linha.indice, erro.fields) + (erro.extra ? `, Plan1!${erro.extra}${7 + linha.indice}` : '')})));
  const started = rows.filter(linha => linha.calculo.started);
  const fck = paraNumero(card.ident.fck);
  const ages = {};
  AGES.forEach(idade => {
    const linhasDaIdade = started.filter(linha => Number(linha.cp.idade) === idade && linha.calculo.vals.fci != null);
    if(!linhasDaIdade.length) return;
    const vals = linhasDaIdade.map(linha => linha.calculo.vals.fci);
    const limit = fck != null ? fck * LIMITE_POR_IDADE[idade] : null;
    const media = calcularMedia(vals);
    const atende = limit == null ? null : (card.criterio === 'media' ? media >= limit : vals.every(valor => valor >= limit));
    ages[idade] = {age: idade, n:linhasDaIdade.length, media, limit, pass: atende, vals};
  });
  const alerts = Object.values(ages).filter(resultadoIdade => resultadoIdade.pass === false);
  const camposComProblema = new Set();
  errors.forEach(erro => erro.fields.forEach(referencia => camposComProblema.add(referencia.ident ? 'i:' + referencia.ident : chaveDoCampo(erro.cp, referencia.nome, referencia.posicao))));
  return {rows, started, errors, ages, alerts, bad: camposComProblema};
}
const chaveDoErro = erro => { const referencia = erro.fields[0]; return referencia.ident ? 'i:' + referencia.ident : chaveDoCampo(erro.cp, referencia.nome, referencia.posicao); };

/* ===== Leitura da planilha modelo (SheetJS) =====
   parseWorkbook() é definida em js/parser.js */

/* ===== Dados de exemplo ===== */
const DADOS_PLACA_113 = [  // idade, h1,h2,h3, d1,d2, massa, carga(tf)  — lidos da Plan1 da placa 113
  [3,144.86,144.17,144.7,74.76,74.75,1.381,11.88],
  [3,140.65,140.76,140.23,74.23,74.12,1.404,11.76],
  [3,147.16,147.26,147,74.73,74.79,1.415,12.94],
  [7,140.69,140.7,140.71,74.9,74.93,1.4,15.97],
  [7,142.29,142.3,142.39,75.08,75.12,1.404,15.18],
  [7,143.52,143.55,143.68,74.97,75.09,1.441,13.57],
  [28,138.69,138.71,138.9,74.56,74.33,1.36655,17.45],
  [28,138.91,138.96,138.13,75,75.03,1.37223,18.76],
  [28,135.13,135.01,134.99,74.65,74.56,1.35474,18.12]
];
const IDENT_PLACA_113 = {
  relNumero:'CT / ENE /025.402 - 26', interessado:'CONSORCIO EXPRESSO LINHA 4 AMARELA', emailCliente:'', central:'VALEBETON', fck:35,
  abatimento:'220 + 30 mm', cimentoMarca:'NACIONAL', cimentoTipo:'CPV ARI RS', cimentoConsumo:460,
  aditivo:'MB TRADING - 107.10.8.2.6', acelerador:'Acelerador de pega - Master Roc S.A. 190', aceleradorConsumo:0.072,
  agregados:'N/I', maquina:'Classe 1', dataProjecao:'2026-08-31', coletadoPor:'L.A - Falcão Bauer', coletadoEm:'N/I',
  elemento:'Placa de ensaio - Damas 16, 17, 19, 3 - 4 Reforço - Poço 3 - 4º Avanço - Cota 746,200 - 745,200',
  placa:'113', nf:'53699'
};
const identExemplo = (cliente, placa, extra={}) => ({...IDENT_PLACA_113, relNumero:'', interessado:cliente, emailCliente:'cliente.exemplo@example.com', central:'Central exemplo', elemento:'Placa de ensaio (exemplo)', placa:String(placa), nf:'000' + placa, ...extra});
const criarCps = rows => rows.map((linha,indice) => ({n:indice+1, idade:linha[0], dataEnsaio:'', h:[linha[1],linha[2],linha[3]], d:[linha[4],linha[5]], massa:linha[6], carga:linha[7], sentido:'Mesmo do lançamento', cura:'Úmida'}));
const cpEmBranco = (numero, idade) => ({n: numero, idade, dataEnsaio:'', h:['','',''], d:['',''], massa:'', carga:'', sentido:'', cura:''});
const cpsEmBranco = () => [3,3,3,7,7,7,28,28,28].map((idade,indice) => cpEmBranco(indice+1, idade));
const variacaoDaPlaca113 = alterar => { const rows = DADOS_PLACA_113.map(linha => [...linha]); alterar(rows); return criarCps(rows); };
const haDias = dias => new Date(Date.now() - dias*864e5).toISOString();
const entradasDeHistorico = (...entradas) => entradas.map(([dias,text]) => ({t:haDias(dias), text}));
const criarCard = (id, stage, ident, cps, extra={}) => ({id, stage, ident, cps, criterio:'media', coefA:1.0024, coefB:0.0299, notified:{}, adjust:{}, aiAnalysis:null, decisionAnalysis:null, finalSent:null, notifLog:[], log:[], ...extra});
const assinaturaDaLinha = cp => [cp.idade, cp.h.join(','), cp.d.join(','), cp.massa, cp.carga, cp.sentido, cp.cura].join('|');
const assinaturaDaIdade = (card, idade) => card.cps.filter(cp => Number(cp.idade) === idade).map(assinaturaDaLinha).join('#');

function seed(){
  const datasNotificacao = {3:haDias(18), 7:haDias(14), 28:haDias(3)};
  const cards = [
    criarCard('RT-114','entrada', identExemplo('Cliente exemplo B', 114, {dataProjecao:'2026-10-01', elemento:'', nf:'', cimentoMarca:'', cimentoTipo:''}), cpsEmBranco(),
      {log:entradasDeHistorico([2,'Card criado manualmente'])}),
    criarCard('RT-115','analise', identExemplo('Cliente exemplo C', 115), variacaoDaPlaca113(linha => { linha[1][3] = 125; linha[4][6] = ''; linha[7][7] = 40; }),
      {log:entradasDeHistorico([4,'Planilha importada'],[4,'Movido automaticamente de Entrada de dados para Análise — 3 erros encontrados'])}),
    criarCard('RT-116','ajuste', identExemplo('Cliente exemplo D', 116), variacaoDaPlaca113(linha => { [0,1,2].forEach(indice => linha[indice][7] = +(linha[indice][7]*0.55).toFixed(2)); }),
      {log:entradasDeHistorico([3,'Planilha importada'],[3,'Movido automaticamente de Análise para Ajuste — análise sem erros; 3 dias abaixo do mínimo para verificar'])}),
    criarCard('RT-117','aguardando', identExemplo('Cliente exemplo E', 117), variacaoDaPlaca113(linha => { [6,7,8].forEach(indice => { linha[indice][1]=linha[indice][2]=linha[indice][3]=linha[indice][4]=linha[indice][5]=linha[indice][6]=linha[indice][7]=''; }); }).map(cp => cp.n > 6 ? {...cp, sentido:'', cura:''} : cp),
      {notified:{3:haDias(6), 7:haDias(2)}, notifLog:[{t:haDias(6), ages:[3], mode:'manual'},{t:haDias(2), ages:[7], mode:'1 clique (simulado)'}],
       log:entradasDeHistorico([14,'Card criado manualmente'],[12,'Movido de Entrada de dados para Análise'],[6,'Cliente notificado (manual) — 3 dias'],[6,'Movido automaticamente de Notificar cliente para Aguardando idades'],[3,'Movido de Aguardando idades para Análise'],[2,'Cliente notificado (1 clique (simulado)) — 7 dias'],[2,'Movido automaticamente de Notificar cliente para Aguardando idades'])}),
    criarCard('RT-118','relatorio', identExemplo('Cliente exemplo F', 118), criarCps(DADOS_PLACA_113),
      {notified:{3:haDias(9), 7:haDias(5), 28:haDias(1)}, notifLog:[{t:haDias(9), ages:[3], mode:'manual'},{t:haDias(5), ages:[7], mode:'manual'},{t:haDias(1), ages:[28], mode:'1 clique (simulado)'}],
       log:entradasDeHistorico([30,'Card criado manualmente'],[9,'Cliente notificado (manual) — 3 dias'],[5,'Cliente notificado (manual) — 7 dias'],[1,'Cliente notificado (1 clique) — 28 dias'],[1,'Movido automaticamente de Notificar cliente para Relatório final'])}),
    criarCard('RT-110','finalizado', identExemplo('Cliente exemplo G', 110), criarCps(DADOS_PLACA_113),
      {notified:datasNotificacao, finalSent:haDias(2), notifLog:[{t:datasNotificacao[3], ages:[3], mode:'manual'},{t:datasNotificacao[7], ages:[7], mode:'manual'},{t:datasNotificacao[28], ages:[28], mode:'manual'}],
       log:entradasDeHistorico([35,'Card criado manualmente'],[18,'Cliente notificado (manual) — 3 dias'],[14,'Cliente notificado (manual) — 7 dias'],[3,'Cliente notificado (manual) — 28 dias'],[2,'Relatório final enviado ao cliente'],[2,'Movido automaticamente de Relatório final para Finalizado'])})
  ];
  const card119 = criarCard('RT-119','ia', identExemplo('Cliente exemplo H', 119), variacaoDaPlaca113(linha => { [0,1,2].forEach(indice => linha[indice][7] = +(linha[indice][7]*0.55).toFixed(2)); }),
    {
      aiAnalysis: {
        verdict: 'atencao',
        summary: 'Idade de 3 dias apresentou resistência de 14.85 MPa (meta: 17.50 MPa). Ajuste conferido; parecer emitido para ciência antes da notificação.',
        content: `### 1. Resumo Executivo e Veredito Geral\n**Veredito: [ATENÇÃO]**\nOs ensaios iniciais de 3 dias da Placa 119 apresentaram resistência média corrigida de **14,85 MPa** (42,4% do fck especificado de 35 MPa), situando-se abaixo da meta normativa de 50% (17,50 MPa). As medições foram conferidas e justificadas pelo laboratório na etapa de Ajuste.\n\n### 2. Avaliação de Resistências à Compressão vs Limites de Projeto\n- **3 dias (3 CPs):** Rupturas de 6,53 tf gerando fci,ext de 14,85 MPa (limite >= 17,50 MPa). Status: **ATENÇÃO**.\n- **7 e 28 dias:** Ensaios pendentes em processo de cura.\n\n### 3. Consistência Dimensional\n- Relação h/d de 1,93 sem desvios dimensionais superiores a 10%.\n\n### 4. Sugestão para a Notificação ao Cliente\n"Prezados, comunicamos os resultados de 3 dias da Placa 119 (14,85 MPa). Medições reconferidas pela equipe técnica. Segue em monitoramento para 7 dias."`,
        model: 'openrouter/free',
        generatedAt: haDias(2)
      },
      log:entradasDeHistorico([5,'Planilha importada'],[5,'Movido de Análise para Ajuste — 3 dias abaixo do mínimo'],[4,'Ajuste conferido e confirmado'],[2,'Movido para IA generativa (LLM)'],[2,'Parecer técnico de IA emitido via OpenRouter'])
    });
  card119.adjust = {3:{hash:assinaturaDaIdade(card119, 3), note:'Cargas e dimensões reconferidas na prensa; resultado mantido.', t:haDias(4)}};
  cards.push(card119);

  const card120 = criarCard('RT-120','notificar', identExemplo('Cliente exemplo I', 120), criarCps(DADOS_PLACA_113),
    {
      aiAnalysis: {
        verdict: 'conforme',
        summary: 'Resistência de 3 dias atingiu 28.88 MPa (82,5% do fck 35 MPa, acima dos 50% normativos). Parecer aprovado para notificação.',
        content: `### 1. Resumo Executivo e Veredito Geral\n**Veredito: [CONFORME]**\nResultados aos 3 dias superaram amplamente o limite normativo (atingiu 28,88 MPa vs mínimo de 17,50 MPa). Lote com excelente curva de resistência inicial.\n\n### 2. Sugestão para Notificação\n"Prezados, os resultados de 3 dias da Placa 120 atingiram 28,88 MPa, superando a meta de 17,50 MPa. Lote em conformidade."`,
        model: 'openrouter/free',
        generatedAt: haDias(1)
      },
      log:entradasDeHistorico([6,'Card criado'],[3,'Análise sem erros'],[1,'IA generativa (LLM) concluída — CONFORME'],[1,'Movido para Notificar cliente'])
    });
  cards.push(card120);

  const config = defaultConfig();
  ['RT-117','RT-118','RT-110'].forEach(id => { cards.find(card => card.id === id).cfgSnap = cfgSnapshot(config); });
  return {cards, config};
}

/* ===== Estado e Persistência (SQLite / LocalStorage) ===== */
const CHAVE_ARMAZENAMENTO = 'rt-fluxo-proto-v2';
let syncBackendTimer = null, syncBackendQueue = Promise.resolve();

function syncBackend(){
  clearTimeout(syncBackendTimer);
  syncBackendTimer = setTimeout(() => {
    const payload = JSON.stringify({cards:estado.cards,config:estado.config});
    syncBackendQueue = syncBackendQueue.then(async () => {
      try {
        const res = await fetch('/api/save',{method:'POST',headers:{'Content-Type':'application/json'},body:payload});
        setSqliteIndicator(res.ok);
      } catch { setSqliteIndicator(false); }
    });
  },350);
}

function setSqliteIndicator(online){
  const el = document.getElementById('sqliteIndicator');
  if (!el) return;
  if (online) {
    el.className = 'pill ok';
    el.innerHTML = 'SQLite';
    el.title = 'Conectado ao banco de dados SQLite local (persistência ativa via ORM)';
  } else {
    el.className = 'pill mute';
    el.innerHTML = 'Local';
    el.title = 'Modo local (navegador). Execute "node server.js" para conectar ao banco SQLite.';
  }
}

async function syncFromSqlite(){
  try {
    const res = await fetch('/api/state');
    if (!res.ok) throw new Error('Status ' + res.status);
    const data = await res.json();
    if (data.ok && Array.isArray(data.cards) && data.cards.length > 0) {
      let recoveredHistory = false;
      for(const card of data.cards){
        const cached = startupState?.cards.find(item => item.id === card.id);
        for(const field of ['log','notifLog']){
          const records = card[field] || [];
          const known = new Set(records.map(entry => JSON.stringify(entry)));
          for(const entry of cached?.[field] || []){
            if(!known.has(JSON.stringify(entry))){ records.push(entry); known.add(JSON.stringify(entry)); recoveredHistory = true; }
          }
          card[field] = records;
        }
      }
      estado.cards = data.cards;
      estado.cards.forEach(interruptedPipeline);
      if (data.config) estado.config = cfgMigrate(data.config);
      invalidatePipelineResults();
      try { localStorage.setItem(CHAVE_ARMAZENAMENTO, JSON.stringify(estado)); } catch {}
      setSqliteIndicator(true);
      renderBoard();
      if (idCardAberto) renderDrawer();
      if(recoveredHistory) syncBackend();
      return true;
    }
  } catch {
    setSqliteIndicator(false);
  }
  return false;
}

function load(){
  try {
    const estadoSalvo = JSON.parse(localStorage.getItem(CHAVE_ARMAZENAMENTO));
    if(estadoSalvo && Array.isArray(estadoSalvo.cards)){
      estadoSalvo.config = estadoSalvo.config ? cfgMigrate(estadoSalvo.config) : defaultConfig();
      estadoSalvo.cards.forEach(card => {
        interruptedPipeline(card);
        card.adjust = card.adjust || {};
        if(!card.cfgSnap && Object.keys(card.notified || {}).length) card.cfgSnap = cfgSnapshot(estadoSalvo.config);
      });
      return estadoSalvo;
    }
  } catch {}
  return null;
}

const pipelineExecutions = new Map();
function invalidatePipelineResults(){
  for(const card of estado.cards){
    if(!['entrada','analise','ajuste','decision','ia','aguardando'].includes(card.stage)) continue;
    let invalid = false;
    for(const [kind,field] of [['decision','decisionAnalysis'],['ai','aiAnalysis']]){
      const result = card[field];
      if(result?.inputKey && result.inputKey !== AiPipeline.inputKey(card,estado.config,kind) && ['aguardando','concluido'].includes(result.status)){
        card[field] = {...result,status:'desatualizado',error:'Os dados ou configurações mudaram. Execute novamente.',...(kind === 'ai' ? {summary:'Parecer desatualizado. Execute novamente.',content:null,verdict:'pendente'} : {})};
        invalid = true;
      }
    }
    if(invalid){
      pipelineExecutions.delete(card.id);
      if(card.stage === 'ia' && !AiPipeline.validDecision(card,estado.config)){
        card.stage = 'decision';
        addLog(card,'Movido automaticamente de IA generativa (LLM) para IA de Decisão / classificação — dados ou configurações alterados');
      }
    }
  }
}
function interruptedPipeline(card){
  for(const field of ['decisionAnalysis','aiAnalysis']){
    if(card[field]?.status === 'aguardando') card[field] = {...card[field],status:'erro',verdict:'erro',error:'A consulta foi interrompida. Tente novamente.',summary:'A consulta foi interrompida. Tente novamente.'};
  }
}
function save(){
  invalidatePipelineResults();
  try { localStorage.setItem(CHAVE_ARMAZENAMENTO, JSON.stringify(estado)); } catch {}
  syncBackend();
}
const startupState = load();
let estado = startupState || seed();
let idCardAberto = null, abaAtual = 'resumo', banner = null, celulaInspecionada = null, textoBusca = '', filtroAtual = 'all', edicaoRegistrada = {}, importacaoPendente = null;
const cardAberto = () => estado.cards.find(card => card.id === idCardAberto);
const editStage = card => EDIT_STAGES.includes(card.stage);
const identEditable = card => ['entrada','analise','ajuste'].includes(card.stage);
const rowLocked = (card, cp) => !!card.notified[Number(cp.idade)];
const allNotified = card => AGES.every(idade => card.notified[idade]);
const pendingAges = (card, avaliacao) => { avaliacao = avaliacao || evaluate(card); return AGES.filter(idade => avaliacao.ages[idade] && !card.notified[idade]); };
const newRows = (card, avaliacao) => (avaliacao || evaluate(card)).started.filter(linha => !rowLocked(card, linha.cp));
const isVerified = (card, idade) => !!(card.adjust && card.adjust[idade] && card.adjust[idade].hash && card.adjust[idade].hash === assinaturaDaIdade(card, idade));
const hasNote = (card, idade) => !!(((card.adjust && card.adjust[idade] && card.adjust[idade].note) || '').trim());
const isConfirmed = (card, idade) => isVerified(card, idade) && hasNote(card, idade);
const failingPending = (card, avaliacao) => { avaliacao = avaliacao || evaluate(card); return pendingAges(card, avaliacao).filter(idade => avaliacao.ages[idade].pass === false); };
function addLog(card, text){ card.log = card.log || []; card.log.push({t:new Date().toISOString(), text}); }

/* ===== Regras de transição ===== */
function baseChecks(avaliacao){
  const temErro = tipo => avaliacao.errors.some(erro => erro.kind === tipo);
  return [
    {ok:!temErro('ident'), text:'Identificação completa (campos amarelos da aba Relatório)'},
    {ok:!temErro('vazio'), text:'Nenhum campo vazio nos CPs lançados'},
    {ok:!temErro('invalido'), text:'Nenhum valor zero ou negativo'},
    {ok:!temErro('diverg'), text:'Nenhuma divergência acima de 10% entre alturas ou diâmetros'},
    {ok:!temErro('limite'), text:`Nenhum fci,ext acima de ${FCI_MAX} MPa`},
    {ok:!temErro('coef'), text:'Coeficientes k1 e k2 encontrados nas tabelas'},
    {ok:!temErro('formula'), text:'Fórmulas calculadas sem erro'}
  ];
}
function gateChecks(card, destino){
  const avaliacao = evaluate(card), pendentes = pendingAges(card, avaliacao), reprovadas = pendentes.filter(idade => avaliacao.ages[idade].pass === false);
  switch(destino){
    case 'analise': return [{ok:newRows(card, avaliacao).length > 0, text: card.stage === 'aguardando' ? 'Dados lançados de uma idade ainda não notificada' : 'Ao menos um CP lançado na Plan1'}];
    case 'ajuste':
      if(['notificar','ia','decision'].includes(card.stage)) return [];   // voltar para corrigir dados não exige nenhuma condição
      return [{ok:avaliacao.started.length > 0, text:'Ao menos um CP lançado'}, ...baseChecks(avaliacao), {ok:reprovadas.length > 0, text:'Há idade abaixo do mínimo a verificar'}];
    case 'decision': {
      const base = [{ok:avaliacao.started.length > 0, text:'Ao menos um CP lançado'}, ...baseChecks(avaliacao), {ok:pendentes.length > 0, text:'Há resultado novo para emissão de parecer da IA'}];
      if(['ajuste','ia','decision'].includes(card.stage)) return base.concat(reprovadas.flatMap(idade => [
        {ok:isVerified(card, idade), text:`${idade} dias abaixo do mínimo: caixa "Conferi as medições" marcada`},
        {ok:hasNote(card, idade), text:`${idade} dias abaixo do mínimo: justificativa preenchida`}
      ]));
      return base.concat([{ok:reprovadas.length === 0, text:'Resultado abaixo do mínimo precisa passar antes pelo Ajuste'}]);
    }
    case 'ia': return [{ok:card.stage === 'notificar' || AiPipeline.validDecision(card,estado.config), text:'Classificação concluída para os dados e configurações atuais'}];
    case 'notificar': {
      const base = [{ok:avaliacao.started.length > 0, text:'Ao menos um CP lançado'}, ...baseChecks(avaliacao), {ok:pendentes.length > 0, text:'Há resultado novo a notificar'}];
      if(card.stage === 'ia') base.push({ok:AiPipeline.validDecision(card,estado.config),text:'Classificação válida para os dados atuais'}, {ok:card.aiAnalysis?.status === 'concluido' && card.aiAnalysis.inputKey === AiPipeline.inputKey(card,estado.config,'ai'),text:'Parecer concluído para os dados atuais'});
      if(card.stage === 'ajuste' || card.stage === 'ia') return base.concat(reprovadas.flatMap(idade => [
        {ok:isVerified(card, idade), text:`${idade} dias abaixo do mínimo: caixa "Conferi as medições" marcada`},
        {ok:hasNote(card, idade), text:`${idade} dias abaixo do mínimo: justificativa preenchida`}
      ]));
      return base.concat([{ok:reprovadas.length === 0, text:'Resultado abaixo do mínimo precisa passar antes pelo Ajuste'}]);
    }
    case 'aguardando': return [{ok:pendentes.length === 0, text:'Todas as idades com resultado já foram notificadas'}, {ok:!allNotified(card), text:'Ainda faltam idades (3, 7 e 28 dias)'}];
    case 'relatorio': return card.stage === 'finalizado' ? [] : [{ok:pendentes.length === 0, text:'Todas as idades com resultado já foram notificadas'}, {ok:allNotified(card), text:'As 3 idades (3, 7 e 28 dias) foram notificadas'}];
    case 'finalizado': return [{ok:allNotified(card), text:'As 3 idades (3, 7 e 28 dias) foram notificadas'}, {ok:!!card.finalSent, text:'Relatório final enviado ao cliente'}];
    default: return [];
  }
}
function stageChecks(card){
  switch(card.stage){
    case 'entrada': return gateChecks(card, 'analise');
    case 'analise': return gateChecks(card, failingPending(card).length ? 'ajuste' : 'decision');
    case 'ajuste': return gateChecks(card, 'decision');
    case 'decision': return gateChecks(card, 'ia');
    case 'ia': return gateChecks(card, 'notificar');
    case 'notificar': { const pendentes = pendingAges(card); return [{ok:pendentes.length === 0, text:'Notificar o cliente sobre ' + (pendentes.length ? pendentes.join(', ') + ' dias' : 'as idades pendentes')}]; }
    case 'aguardando': return gateChecks(card, 'analise');
    case 'relatorio': return gateChecks(card, 'finalizado');
    default: return [];
  }
}
function moveTo(card, destino, {auto=false, note=''}={}){
  const from = card.stage;
  if(from !== destino){ pipelineExecutions.delete(card.id); interruptedPipeline(card); }
  if(from === 'finalizado' && destino === 'relatorio') card.finalSent = null;
  card.stage = destino; edicaoRegistrada[card.id] = false; banner = null;
  addLog(card, `${auto ? 'Movido automaticamente' : 'Movido'} de ${stageOf(from).name} para ${stageOf(destino).name}${note ? ' — ' + note : ''}`);

  if(destino === 'decision'){
    save(); renderBoard();
    if(idCardAberto === card.id){ abaAtual = defaultTab(card); renderDrawer(); }
    triggerDecisionAnalysis(card); return;
  }
  if(destino === 'ia'){
    if(!AiPipeline.validDecision(card,estado.config)){ moveTo(card,'decision',{auto:true,note:'classificação obrigatória antes do parecer'}); return; }
    save(); renderBoard();
    if(idCardAberto === card.id){ abaAtual = defaultTab(card); renderDrawer(); }
    triggerAiAnalysis(card); return;
  }

  save(); renderBoard();
  if(idCardAberto === card.id){ abaAtual = defaultTab(card); renderDrawer(); }
}
function runAnalysis(card){
  const avaliacao = evaluate(card);
  if(avaliacao.errors.length){
    toast(`${card.id}: ${avaliacao.errors.length} erro(s) na análise. A aba Análise mostra onde estão.`, 'err');
    renderBoard(); if(idCardAberto === card.id) renderDrawer(); return false;
  }
  const pendentes = pendingAges(card, avaliacao);
  if(pendentes.length){
    const reprovadas = pendentes.filter(idade => avaliacao.ages[idade].pass === false);
    if(reprovadas.length){ moveTo(card, 'ajuste', {auto:true, note:`análise sem erros; ${reprovadas.join(', ')} dias abaixo do mínimo para verificar`}); toast(`${card.id}: ${reprovadas.join(', ')} dias abaixo do mínimo → Ajuste`, 'warn'); return true; }
    moveTo(card, 'decision', {auto:true, note:`análise sem erros; classificar resultados de ${pendentes.join(', ')} dias`}); toast(`${card.id}: análise sem erros → IA de Decisão / classificação`, 'ok'); return true;
  }
  moveTo(card, allNotified(card) ? 'relatorio' : 'aguardando', {auto:true, note:'análise sem erros e sem resultado novo a notificar'});
  return true;
}
function tryMove(idCard, destino){
  const card = estado.cards.find(candidato => candidato.id === idCard);
  if(!card || card.stage === destino) return false;
  if(!TRANSITIONS[card.stage].includes(destino)){
    toast(`Transição não permitida: ${stageOf(card.stage).name} → ${stageOf(destino).name}. O fluxo é: Entrada de dados → Análise → Ajuste (se abaixo do mínimo) → IA de Decisão / classificação → IA generativa (LLM) → Notificar cliente → Aguardando idades → Relatório final → Finalizado.`, 'warn');
    return false;
  }
  const pendencias = gateChecks(card, destino).filter(condicao => !condicao.ok);
  if(pendencias.length){
    banner = {title:`Não foi possível mover ${card.id} para ${stageOf(destino).name}`, items:pendencias.map(pendencia => pendencia.text)};
    toast(`${card.id} não pode ir para ${stageOf(destino).name}: ${pendencias[0].text}.`, 'err');
    if(idCardAberto === idCard) renderDrawer();
    return false;
  }
  const from = card.stage;
  moveTo(card, destino, from === 'notificar' && destino === 'ajuste' ? {note:'devolvido para correção'} : {});
  if(destino === 'analise' && ['entrada','aguardando'].includes(from)) runAnalysis(card);
  else toast(`${card.id} → ${stageOf(destino).name}`, 'ok');
  return true;
}
function markNotified(card, modo){
  const ages = pendingAges(card);
  if(card.stage !== 'notificar' || !ages.length) return;
  const agora = new Date().toISOString();
  ages.forEach(idade => card.notified[idade] = agora);
  card.notifLog.push({t: agora, ages, mode: modo});
  addLog(card, `Cliente notificado (${modo}) — ${ages.join(', ')} dias`);
  if(!card.cfgSnap){ card.cfgSnap = cfgSnapshot(estado.config); addLog(card, `Tabelas e fórmulas fixadas: «${cfgActive(estado.config).name}» (revisão ${estado.config.rev})`); }
  const destino = allNotified(card) ? 'relatorio' : 'aguardando';
  moveTo(card, destino, {auto:true, note: destino === 'relatorio' ? 'as 3 idades foram notificadas' : 'faltam ' + AGES.filter(idade => !card.notified[idade]).join(', ') + ' dias'});
  toast(`${card.id}: notificação registrada → ${stageOf(destino).name}`, 'ok');
}
function markFinalSent(card, modo){
  card.finalSent = new Date().toISOString();
  addLog(card, `Relatório final enviado ao cliente (${modo})`);
  moveTo(card, 'finalizado', {auto:true, note:'3, 7 e 28 dias notificados e relatório final enviado'});
  toast(`${card.id}: relatório final enviado → Finalizado`, 'ok');
}

/* ===== Quadro ===== */
function matches(card){
  const avaliacao = evaluate(card);
  const textoDoCard = (card.id + ' ' + card.ident.interessado + ' ' + card.ident.placa + ' ' + card.ident.elemento).toLowerCase();
  if(textoBusca && !textoDoCard.includes(textoBusca.toLowerCase())) return false;
  if(filtroAtual === 'errors' && !(avaliacao.errors.length || card.decisionAnalysis?.status === 'erro' || card.aiAnalysis?.status === 'erro')) return false;
  if(filtroAtual === 'below' && !avaliacao.alerts.length) return false;
  if(filtroAtual === 'late' && !(card.stage === 'aguardando' && AGES.some(idade => ageDeadlineStatus(card,idade,avaliacao).label === 'Atrasado'))) return false;
  if(filtroAtual === 'negative' && !((card.aiAnalysis?.status === 'concluido' || (!card.aiAnalysis?.status && card.aiAnalysis?.content)) && (card.aiAnalysis.decision?.classe || card.aiAnalysis.verdict) === 'nao_conforme')) return false;
  return true;
}
function cardHTML(card){
  const avaliacao = evaluate(card), etapa = card.stage;
  const bolinhasDasIdades = AGES.map(idade => {
    const resultadoIdade = avaliacao.ages[idade], sent = !!card.notified[idade];
    const classe = resultadoIdade ? (resultadoIdade.pass === false ? 'fail' : 'pass') + (sent ? ' sent' : '') : '';
    const dica = `${idade} dias: ` + (!resultadoIdade ? 'sem resultado' : (resultadoIdade.pass === false ? 'abaixo do mínimo' : 'atende') + (sent ? ' · cliente notificado' : ' · a notificar'));
    return `<span class="dot ${classe}" title="${dica}">${idade}</span>`;
  }).join('');
  let badge = '', errline = '', border = '';
  if((etapa === 'analise' || etapa === 'ajuste') && avaliacao.errors.length){
    badge = `<span class="pill err">${avaliacao.errors.length} erro${avaliacao.errors.length > 1 ? 's' : ''}</span>`; border = ' b-err';
    const erro = avaliacao.errors[0];
    errline = `<div class="errline"><b>${escaparHtml(erro.where)}:</b> ${escaparHtml(erro.msg)}${avaliacao.errors.length > 1 ? ` <i>(+${avaliacao.errors.length - 1})</i>` : ''}</div>`;
  } else if(etapa === 'analise'){
    badge = '<span class="pill ok">Sem erros</span>';
  } else if(etapa === 'ajuste'){
    const reprovadas = failingPending(card, avaliacao), naoConfirmadas = reprovadas.filter(idade => !isConfirmed(card, idade));
    border = ' b-warn';
    badge = !reprovadas.length ? '<span class="pill ok">Pronto p/ IA</span>' : naoConfirmadas.length ? `<span class="pill warn">Verificar ${naoConfirmadas.join('/')} d</span>` : '<span class="pill ok">Verificado</span>';
  } else if(etapa === 'decision'){
    const d = card.decisionAnalysis;
    badge = `<span class="pill ${d?.status === 'erro' ? 'err' : 'info'}">${d?.status === 'aguardando' ? 'Classificando...' : d?.status === 'erro' ? 'Erro na classificação' : 'Classificação pendente'}</span>`;
  } else if(etapa === 'ia'){
    if(card.aiAnalysis?.status === 'aguardando'){
      badge = '<span class="pill info" style="display:inline-flex; align-items:center; gap:4px;">Aguardando IA generativa (LLM)</span>';
      border = ' b-info';
    } else if(card.aiAnalysis?.status === 'erro'){
      badge = '<span class="pill err">Erro na IA</span>';
      border = ' b-err';
    } else if(card.aiAnalysis?.verdict){
      const v = card.aiAnalysis.verdict;
      if(v === 'conforme'){ badge = '<span class="pill ok">Classificação: Conforme</span>'; border = ' b-ok'; }
      else if(v === 'atencao'){ badge = '<span class="pill warn">Classificação: Atenção</span>'; border = ' b-warn'; }
      else if(v === 'nao_conforme'){ badge = '<span class="pill err">Classificação: Não conforme</span>'; border = ' b-err'; }
      else { badge = '<span class="pill info">Aguardando IA generativa (LLM)</span>'; }
    } else {
      badge = '<span class="pill info">Aguardando IA generativa (LLM)</span>';
    }
  } else if(etapa === 'notificar'){
    badge = `<span class="pill info">Notificar ${pendingAges(card, avaliacao).join('/')} d</span>`; if(avaliacao.alerts.length) border = ' b-warn';
  } else if(etapa === 'aguardando'){
    badge = `<span class="pill mute">Faltam ${AGES.filter(idade => !card.notified[idade]).join('/')} d</span>`;
  } else if(etapa === 'relatorio'){
    badge = '<span class="pill info">Enviar final</span>';
  } else if(etapa === 'finalizado'){
    badge = '<span class="pill ok">Concluído</span>'; border = ' b-ok';
  }
  const warn = avaliacao.alerts.length && etapa !== 'analise' && etapa !== 'ajuste' && etapa !== 'ia' && etapa !== 'decision' ? '<span class="pill warn">Abaixo do mínimo</span>' : '';
  let blocoIaCard = '';
  if (card.aiAnalysis) {
    if (card.aiAnalysis.status === 'aguardando') {
      blocoIaCard = `<div style="font-size:11px; margin:4px 0 6px; padding:5px 8px; background:var(--surface2); border-left:3px solid var(--accent); border-radius:4px; line-height:1.35; color:var(--text);"><b style="display:inline-flex; align-items:center; gap:5px;">Aguardando parecer da IA generativa (LLM)...</b><div style="font-size:10px; color:var(--muted); margin-top:2px;">Requisição em processamento...</div></div>`;
    } else if (card.aiAnalysis.status === 'erro') {
      blocoIaCard = `<div style="font-size:11px; margin:4px 0 6px; padding:5px 8px; background:var(--surface2); border-left:3px solid var(--err); border-radius:4px; line-height:1.35; color:var(--err);"><b>Erro na IA generativa (LLM):</b> ${escaparHtml(card.aiAnalysis.summary ? card.aiAnalysis.summary.substring(0, 80) : 'Falha na consulta')}</div>`;
    } else if (card.aiAnalysis.summary) {
      blocoIaCard = `<div style="font-size:11px; margin:4px 0 6px; padding:4px 7px; background:var(--surface2); border-left:3px solid var(${card.aiAnalysis.verdict === 'conforme' ? '--ok' : (card.aiAnalysis.verdict === 'atencao' ? '--warn' : '--err')}); border-radius:4px; line-height:1.35; color:var(--text);"><b>Parecer da IA generativa (LLM):</b> ${escaparHtml(card.aiAnalysis.summary.substring(0, 95))}${card.aiAnalysis.summary.length > 95 ? '...' : ''}</div>`;
    }
  }
  return `<div class="card${border}" draggable="true" tabindex="0" role="button" data-id="${card.id}" aria-label="${escaparHtml(card.id)}">
    <h3>Placa ${escaparHtml(card.ident.placa || '—')} · ${escaparHtml(card.ident.interessado || 'Sem interessado')}</h3>
    <div class="meta"><span class="tag">fck ${escaparHtml(card.ident.fck || '—')} MPa</span><span class="tag">${avaliacao.started.length}/${card.cps.length} CPs</span></div>
    ${errline}
    ${blocoIaCard}
    ${etapa === 'aguardando' ? `<div class="hint mt8">${AGES.filter(idade => !card.notified[idade]).map(idade => `<div class="rowline"><span>${idade} dias · ${expectedDate(card,idade) || 'Sem data prevista'}</span>${ageDeadlineHtml(card,idade,avaliacao)}</div>`).join('')}</div>` : ''}
    <div class="foot"><span class="key">${escaparHtml(card.id)}</span><span class="right"><span class="dots">${bolinhasDasIdades}</span>${warn}${badge}</span></div>
  </div>`;
}
const collapsedBoardGroups = {insertion:false,automation:false,followup:false};
function renderBoard(){
  const groups = [
    {id:'insertion',label:'Inserção',stages:['entrada','analise','ajuste']},
    {id:'automation',label:'Automação',stages:['decision','ia']},
    {id:'followup',label:'Acompanhamento',stages:['notificar','aguardando','relatorio','finalizado']}
  ];
  const columns = {}, tracks = []; let headers = '';
  for(const group of groups){
    const collapsed = collapsedBoardGroups[group.id], start = tracks.length + 1;
    const span = collapsed ? 1 : group.stages.length;
    headers += `<button type="button" class="board-group board-group-${group.id}" data-board-group="${group.id}" aria-expanded="${!collapsed}" style="grid-column:${start} / span ${span}" title="${collapsed ? 'Expandir' : 'Recolher'} ${group.label}">${group.label} <span aria-hidden="true">${collapsed ? '▸' : '▾'}</span></button>`;
    if(collapsed){
      tracks.push('160px');
      const count = estado.cards.filter(card => group.stages.includes(card.stage) && matches(card)).length;
      headers += `<div class="board-group-collapsed board-group-${group.id}" style="grid-column:${start};grid-row:2">${group.stages.length} etapas recolhidas<br>${count} card${count === 1 ? '' : 's'}</div>`;
    } else {
      for(const stage of group.stages){ columns[stage] = tracks.length + 1; tracks.push('280px'); }
    }
  }
  for(const stage of STAGES.filter(stage => !groups.some(group => group.stages.includes(stage.id)))){
    columns[stage.id] = tracks.length + 1; tracks.push('280px');
  }
  consultar('#board').style.gridTemplateColumns = tracks.join(' ');
  consultar('#board').innerHTML = headers + STAGES.filter(stage => columns[stage.id]).map(etapa => {
    const cards = estado.cards.filter(card => card.stage === etapa.id && matches(card));
    const botaoNovo = etapa.id === 'entrada' ? '<button class="addcard" data-new="1">+ Novo lançamento</button>' : '';
    return `<section class="col" data-stage="${etapa.id}" style="grid-column:${columns[etapa.id]};grid-row:2" aria-label="${escaparHtml(etapa.name)}">
      <div class="col-h"><div class="col-t"><span class="col-name">${escaparHtml(etapa.name)}</span><span class="count">${cards.length}</span></div>
      <div class="col-d">${escaparHtml(etapa.desc)}</div></div>
      <div class="col-b">${botaoNovo}${cards.map(cardHTML).join('') || (botaoNovo ? '' : '<div class="empty">Nenhum card</div>')}</div></section>`;
  }).join('');
}
const board = consultar('#board');
board.addEventListener('click', evento => {
  const groupButton = evento.target.closest('[data-board-group]');
  if(groupButton){
    const group = groupButton.dataset.boardGroup;
    collapsedBoardGroups[group] = !collapsedBoardGroups[group];
    renderBoard();
    consultar(`[data-board-group="${group}"]`).focus();
    return;
  }
  if(evento.target.closest('[data-new]')){ openNew(); return; }
  const elemento = evento.target.closest('.card'); if(elemento) openCard(elemento.dataset.id);
});
board.addEventListener('keydown', evento => { const elemento = evento.target.closest('.card'); if(elemento && (evento.key === 'Enter' || evento.key === ' ')){ evento.preventDefault(); openCard(elemento.dataset.id); } });
let idCardArrastado = null;
board.addEventListener('dragstart', evento => { const elemento = evento.target.closest('.card'); if(!elemento) return; idCardArrastado = elemento.dataset.id; elemento.classList.add('dragging'); evento.dataTransfer.setData('text/plain', idCardArrastado); evento.dataTransfer.effectAllowed = 'move'; });
board.addEventListener('dragend', () => { idCardArrastado = null; document.querySelectorAll('.dragging,.over').forEach(elemento => elemento.classList.remove('dragging','over')); });
board.addEventListener('dragover', evento => { const coluna = evento.target.closest('.col'); if(coluna && idCardArrastado){ evento.preventDefault(); document.querySelectorAll('.col.over').forEach(outraColuna => outraColuna !== coluna && outraColuna.classList.remove('over')); coluna.classList.add('over'); } });
board.addEventListener('drop', evento => { const coluna = evento.target.closest('.col'); if(!coluna || !idCardArrastado) return; evento.preventDefault(); const idCard = idCardArrastado; coluna.classList.remove('over'); tryMove(idCard, coluna.dataset.stage); });

consultar('#q').addEventListener('input', evento => { textoBusca = evento.target.value.trim(); renderBoard(); });
consultar('#cardFilter').addEventListener('change', evento => { filtroAtual = evento.target.value; renderBoard(); });
consultar('#btnReset').addEventListener('click', async () => {
  if(confirm('Restaurar os cards de exemplo? As alterações feitas neste navegador serão perdidas.')){
    try { await fetch('/api/db/reset', { method: 'POST' }); } catch {}
    estado = seed();
    save();
    closeDrawer();
    renderBoard();
    toast('Dados de exemplo restaurados.', 'ok');
  }
});
consultar('#btnFlow').addEventListener('click', openFlow);
consultar('#btnConfig').addEventListener('click', openConfig);
consultar('#btnNew').addEventListener('click', openNew);

/* ===== Drawer do card ===== */
const TABS = [['resumo','Resumo'],['ident','Identificação'],['plan1','Plan1 (digitação e cálculo)'],['analise','Análise'],['ajuste','Ajuste'],['coef','Coeficientes k1–k4'],['decision','IA de Decisão / classificação'],['ia','IA generativa (LLM)'],['notif','Notificação'],['rel','Relatório final'],['hist','Histórico']];
function defaultTab(card){ return {entrada:'plan1', analise:'analise', ajuste:'ajuste', decision:'decision', ia:'ia', notificar:'notif', relatorio:'rel'}[card.stage] || 'resumo'; }
function openCard(idCard){ idCardAberto = idCard; const card = cardAberto(); abaAtual = defaultTab(card); banner = null; celulaInspecionada = null; renderDrawer(); consultar('#drawer').hidden = false; document.body.classList.add('noscroll'); consultar('#dClose').focus(); }
function closeDrawer(){
  const card = cardAberto();
  consultar('#drawer').hidden = true; document.body.classList.remove('noscroll'); idCardAberto = null;
  // Sair da edição é o gatilho: se o card está na Análise e não há mais erros, ele segue para a próxima etapa.
  if(card && card.stage === 'analise' && !evaluate(card).errors.length) runAnalysis(card);
  renderBoard();
}
consultar('#dClose').addEventListener('click', closeDrawer);
consultar('#drawer').addEventListener('mousedown', evento => { if(evento.target.id === 'drawer') closeDrawer(); });
document.addEventListener('keydown', evento => { if(evento.key === 'Escape'){ if(!consultar('#modal').hidden) closeModal(); else if(!consultar('#drawer').hidden) closeDrawer(); } });

function statusPill(card, avaliacao){
  if(card.stage === 'entrada') return `<span class="pill mute">${avaliacao.started.length}/${card.cps.length} CPs lançados</span>`;
  if(card.stage === 'analise') return avaliacao.errors.length ? `<span class="pill err">${avaliacao.errors.length} erro(s)</span>` : '<span class="pill ok">Sem erros</span>';
  if(!avaliacao.started.length) return '';
  return avaliacao.alerts.length ? '<span class="pill warn">Abaixo do mínimo</span>' : '<span class="pill ok">Critérios atendidos</span>';
}
function actionsFor(card){
  switch(card.stage){
    case 'entrada': return [{label:'Enviar para análise →', act:'toanalise', primary:true}, {label:'Importar planilha', act:'importcard'}];
    case 'analise': return [{label:'Reanalisar', act:'reanalyse', primary:true}, {label:'Importar planilha', act:'importcard'}, {label:'← Devolver para Entrada de dados', act:'move', to:'entrada', ghost:true}];
    case 'ajuste': return [{label:'Concluir ajuste → Classificação', act:'move', to:'decision', primary:true}, {label:'← Devolver para Análise', act:'move', to:'analise', ghost:true}];
    case 'decision': return [{label:card.decisionAnalysis?.status === 'aguardando' ? 'Classificando...' : 'Tentar classificação novamente',act:'gen_decision',primary:true},{label:'← Voltar para Ajuste',act:'move',to:'ajuste'},{label:'← Devolver para Análise',act:'move',to:'analise',ghost:true}];
    case 'ia': return [
      {label:'Prosseguir para Notificação →', act:'move', to:'notificar', primary:true},
      {label:'← Voltar para Ajuste', act:'move', to:'ajuste'},
      {label:card.aiAnalysis?.status === 'aguardando' ? 'Consultando IA generativa (LLM)...' : 'Regerar Parecer da IA generativa (LLM)', act:'gen_ia'},
      {label:'← Devolver para Análise', act:'move', to:'analise', ghost:true}
    ];
    case 'notificar': return [{label:'Ir para a notificação →', act:'tab', tab:'notif', primary:true}, {label:'← Voltar para IA generativa (LLM)', act:'move', to:'ia'}, {label:'← Voltar para Ajuste', act:'move', to:'ajuste', ghost:true}];
    case 'aguardando': return [{label:'Enviar novos dados para análise →', act:'toanalise', primary:true}, {label:'Importar planilha atualizada', act:'importcard'}];
    case 'relatorio': return [{label:'Ir para o relatório final →', act:'tab', tab:'rel', primary:true}];
    default: return [{label:'Reabrir no Relatório final', act:'move', to:'relatorio', ghost:true}];
  }
}
function tabsHTML(card, avaliacao){
  const naoConfirmadas = failingPending(card, avaliacao).filter(idade => !isConfirmed(card, idade)).length;
  return TABS.map(([chave,rotulo]) => {
    let tag = '';
    if(chave === 'analise' && avaliacao.errors.length) tag = `<span class="n">${avaliacao.errors.length}</span>`;
    else if(chave === 'ajuste' && naoConfirmadas) tag = `<span class="n w">${naoConfirmadas}</span>`;
    return `<button class="tab" role="tab" data-tab="${chave}" aria-selected="${chave === abaAtual}">${rotulo}${tag}</button>`;
  }).join('');
}
function renderHead(card, avaliacao){
  const etapa = stageOf(card.stage);
  consultar('#dKey').innerHTML = `${escaparHtml(card.id)} <span class="pill info">${escaparHtml(etapa.name)}</span> <span class="hint">Responsável: ${escaparHtml(etapa.role)}</span> ${statusPill(card, avaliacao)}`;
  consultar('#dTitle').textContent = `Placa ${card.ident.placa || '—'} · ${card.ident.interessado || 'Sem interessado'}`;
  consultar('#dTabs').innerHTML = tabsHTML(card, avaliacao);
}
function renderDrawer(){
  const card = cardAberto(); if(!card) return;
  renderHead(card, evaluate(card));
  consultar('#dActions').innerHTML = actionsFor(card).map(acao => `<button class="btn ${acao.primary ? 'primary' : (acao.ghost ? 'ghost' : '')}" data-act="${acao.act}" ${(['gen_ia','gen_decision'].includes(acao.act) && pipelineExecutions.has(card.id)) || (acao.to && gateChecks(card,acao.to).some(c => !c.ok)) ? 'disabled' : ''} ${acao.to ? `data-to="${acao.to}"` : ''} ${acao.tab ? `data-tab="${acao.tab}"` : ''}>${acao.label}</button>`).join('');
  renderBody();
}
function renderBody(){
  const card = cardAberto(); if(!card) return;
  const renderizarAba = {resumo:tabResumo, ident:tabIdent, plan1:tabPlan1, analise:tabAnalise, ajuste:tabAjuste, coef:tabCoef, decision:tabDecision, ia:(card,avaliacao) => tabDecision(card) + tabIa(card,avaliacao), notif:tabNotif, rel:tabRel, hist:tabHist}[abaAtual];
  const avisoBanner = banner ? `<div class="banner ${banner.info ? 'info' : ''}" role="alert"><b>${escaparHtml(banner.title)}</b>${banner.items?.length ? `<ul>${banner.items.map(item => `<li>${escaparHtml(item)}</li>`).join('')}</ul>` : ''}</div>` : '';
  const avisoSomenteLeitura = ((abaAtual === 'ident' && !identEditable(card)) || (abaAtual === 'plan1' && !editStage(card))) ? `<div class="banner info">Edição bloqueada nesta etapa. Os dados só podem ser alterados em Entrada de dados, Análise, Ajuste e Aguardando idades.</div>` : '';
  consultar('#dBody').innerHTML = avisoBanner + avisoSomenteLeitura + renderizarAba(card, evaluate(card));
  if(['plan1','ident','ajuste','notif','rel'].includes(abaAtual)) bindEdit();
  if(abaAtual === 'plan1') refreshPlan1();
  if(abaAtual === 'ajuste') refreshAjuste();
}
consultar('#dActions').addEventListener('click', evento => {
  const botao = evento.target.closest('[data-act]'); if(!botao) return; const card = cardAberto();
  switch(botao.dataset.act){
    case 'move': tryMove(card.id, botao.dataset.to); break;
    case 'tab': banner = null; abaAtual = botao.dataset.tab; renderDrawer(); break;
    case 'toanalise': tryMove(card.id, 'analise'); break;
    case 'reanalyse': if(card.stage === 'analise') runAnalysis(card); break;
    case 'gen_decision': triggerDecisionAnalysis(card); break;
    case 'gen_ia': triggerAiAnalysis(card); break;
    case 'importcard': consultar('#fileIn').dataset.mode = 'merge'; consultar('#fileIn').click(); break;
  }
});
consultar('#dTabs').addEventListener('click', evento => { const botao = evento.target.closest('[data-tab]'); if(botao){ banner = null; abaAtual = botao.dataset.tab; renderDrawer(); } });
consultar('#dBody').addEventListener('click', evento => {
  const botaoRemover = evento.target.closest('[data-rm]'); if(botaoRemover){ removeCP(cardAberto(), +botaoRemover.dataset.rm); return; }
  const linkIrPara = evento.target.closest('[data-go]'); if(linkIrPara){ evento.preventDefault(); banner = null; abaAtual = linkIrPara.dataset.go; renderDrawer(); return; }
  const botaoIrParaCampo = evento.target.closest('[data-goto]'); if(botaoIrParaCampo){ gotoField(botaoIrParaCampo.dataset.goto); return; }
  const botaoAcao = evento.target.closest('[data-act]'); if(!botaoAcao) return;
  const card = cardAberto();
  switch(botaoAcao.dataset.act){
    case 'gen_decision': triggerDecisionAnalysis(card); break;
    case 'gen_ia': triggerAiAnalysis(card); break;
    case 'copy_ia': {
      if(card.aiAnalysis?.content){
        navigator.clipboard?.writeText(card.aiAnalysis.content).then(() => toast('Parecer da IA generativa (LLM) copiado.', 'ok')).catch(() => toast('Não foi possível copiar.', 'warn'));
      }
      break;
    }
    case 'apply_ia_suggestion':
    case 'apply_ia_report': {
      const suggestion = botaoAcao.dataset.act === 'apply_ia_suggestion';
      const parts = AiPipeline.notificationParts(card.aiAnalysis?.content);
      if(card.aiAnalysis?.content && !['erro','aguardando','desatualizado'].includes(card.aiAnalysis.status) && parts[suggestion ? 'suggestion' : 'report']){
        card.aiAnalysis[suggestion ? 'notificationSuggestion' : 'notificationReport'] = true;
        if(suggestion){
          card.aiAnalysis.notificationReport = false;
          card.aiAnalysis.includeInNotification = false;
        }
        const key = noticeDraftKey(card, evaluate(card));
        if(typeof card.emailDrafts?.[key] === 'string'){
          if(suggestion) card.emailDrafts[key] = parts.suggestion;
          else if(!card.emailDrafts[key].includes(parts.report)) card.emailDrafts[key] += '\n\nParecer técnico da IA generativa (LLM):\n' + parts.report;
        }
        save();
        abaAtual = 'notif';
        renderDrawer();
        toast(suggestion ? 'Sugestão de e-mail da IA inserida na notificação.' : 'Parecer completo da IA adicionado à notificação.', 'ok');
      } else toast(suggestion ? 'Não foi encontrada uma seção de sugestão de e-mail no parecer válido da IA.' : 'Gere um parecer válido da IA antes de adicioná-lo à notificação.', 'warn');
      break;
    }
    case 'sendnotice': markNotified(card, '1 clique (simulado)'); break;
    case 'marknotified': markNotified(card, 'manual'); break;
    case 'sendfinal': markFinalSent(card, '1 clique (simulado)'); break;
    case 'markfinal': markFinalSent(card, 'manual'); break;
    case 'copy': { const textoCompleto = consultar('#mailSubj').textContent + '\n\n' + consultar('#mailText').value; navigator.clipboard?.writeText(textoCompleto).then(() => toast('Texto copiado.', 'ok')).catch(() => toast('Não foi possível copiar.', 'warn')); break; }
    case 'print': window.print(); break;
    case 'csv': exportCSV(card); break;
    case 'importcard': consultar('#fileIn').dataset.mode = 'merge'; consultar('#fileIn').click(); break;
    case 'addcp': if(card.cps.length < 15){ card.cps.push(cpEmBranco(card.cps.length + 1, '')); addLog(card, `CP ${card.cps.length} adicionado à Plan1`); save(); renderDrawer(); renderBoard(); } else toast('Limite de 15 CPs por card.', 'warn'); break;
    case 'reanalyse': if(card.stage === 'analise') runAnalysis(card); break;
    case 'move': tryMove(card.id, botaoAcao.dataset.to); break;
    case 'unpin':
      if(card.cfgSnap && confirm(`Este card passará a usar as tabelas e fórmulas em uso («${cfgActive(estado.config).name}», revisão ${estado.config.rev}). Os resultados serão recalculados e podem mudar valores já comunicados ao cliente. Continuar?`)){
        card.cfgSnap = null; addLog(card, `Card passou a usar as tabelas e fórmulas em uso: «${cfgActive(estado.config).name}» (revisão ${estado.config.rev})`); save(); renderDrawer(); renderBoard();
      }
      break;
  }
});
consultar('#dBody').addEventListener('change', evento => {
  if(evento.target.name === 'crit'){ const card = cardAberto(); card.criterio = evento.target.value; addLog(card, 'Critério alterado para ' + (card.criterio === 'media' ? 'média' : 'individual')); save(); renderDrawer(); renderBoard(); }
  if(evento.target.id === 'emailCli'){ const card = cardAberto(); card.ident.emailCliente = evento.target.value.trim(); save(); renderDrawer(); }
});

/* Ir para o campo com erro */
function gotoField(chaveCampo){
  const card = cardAberto(); let seletor;
  if(chaveCampo.startsWith('i:')){ abaAtual = 'ident'; renderDrawer(); seletor = '#i-' + chaveCampo.slice(2); }
  else {
    const [, indice, nomeCampo, posicao] = chaveCampo.split(':'); abaAtual = 'plan1'; renderDrawer();
    seletor = `[data-i="${indice}"][data-f="${nomeCampo}"]` + (posicao !== '' ? `[data-x="${posicao}"]` : '');
  }
  const elemento = consultar(seletor, consultar('#dBody'));
  if(elemento){ elemento.scrollIntoView({block:'center', inline:'center', behavior:'smooth'}); elemento.focus({preventScroll:true}); elemento.classList.add('pulse'); setTimeout(() => elemento.classList.remove('pulse'), 2600); }
}

/* ---- Resumo ---- */
function listChecks(checks){
  return checks.length ? `<ul class="checks">${checks.map(condicao => `<li><span class="ic ${condicao.ok ? 'ok' : 'no'}">${condicao.ok ? '✓' : '✕'}</span><span>${escaparHtml(condicao.text)}</span></li>`).join('')}</ul>` : '<p class="hint">Sem condições adicionais nesta etapa.</p>';
}
function tabResumo(card, avaliacao){
  const ageRows = AGES.map(idade => {
    const rows = avaliacao.rows.filter(linha => Number(linha.cp.idade) === idade), cpsLancados = rows.filter(linha => linha.calculo.started).length, resultadoIdade = avaliacao.ages[idade];
    const prev = expectedDate(card, idade);
    return `<tr><td><b>${idade} dias</b></td><td>${prev || '—'}${card.stage === 'aguardando' ? ' ' + ageDeadlineHtml(card,idade,avaliacao) : ''}</td><td>${cpsLancados ? `${cpsLancados}/${rows.length} CPs` : '<span class="hint">sem dados</span>'}</td>
      <td>${resultadoIdade ? `${formatarNumero(resultadoIdade.media,2)} MPa ${resultadoIdade.pass === false ? '<span class="pill warn">Não atende</span>' : resultadoIdade.pass ? '<span class="pill ok">Atende</span>' : ''}` : '—'}</td>
      <td>${card.notified[idade] ? `<span class="pill ok">Notificado em ${formatarData(card.notified[idade])}</span>` : (resultadoIdade ? '<span class="pill info">A notificar</span>' : '—')}</td></tr>`;
  }).join('');
  const envioFinal = card.finalSent ? `<span class="pill ok">Relatório final enviado em ${formatarData(card.finalSent)}</span>` : '<span class="pill mute">Relatório final não enviado</span>';
  const linhasDeErros = avaliacao.errors.slice(0, 3).map(erro => `<div class="issue"><span class="pill err">Erro</span><span class="grow"><b>${escaparHtml(erro.where)}</b> ${escaparHtml(erro.msg)}<br><span class="hint">Onde: ${escaparHtml(erro.cells || '—')}</span></span></div>`).join('');
  return `<div class="sec"><h3>Andamento por idade</h3><div class="tbl-wrap"><table class="t plain"><thead><tr><th>Idade</th><th>Data prevista</th><th>Dados</th><th>fci,ext médio</th><th>Notificação ao cliente</th></tr></thead><tbody>${ageRows}</tbody></table></div>
      <p class="mt8">${envioFinal} <span class="hint">O card só é finalizado com as 3 idades notificadas e o relatório final enviado.</span></p></div>
    <div class="grid2">
      <div class="sec"><h3>Etapa atual: ${escaparHtml(stageOf(card.stage).name)}</h3>${listChecks(stageChecks(card))}</div>
      <div class="sec"><h3>Erros da análise</h3>${avaliacao.errors.length ? linhasDeErros + (avaliacao.errors.length > 3 ? `<p class="hint mt6">+ ${avaliacao.errors.length - 3} erro(s)</p>` : '') + '<p class="mt8"><a href="#" data-go="analise">Ver todos e onde estão →</a></p>' : '<p class="hint">Nenhum erro encontrado.</p>'}</div>
    </div>
    <p class="hint">Dica: em <a href="#" data-go="plan1">Plan1</a>, clique em qualquer célula cinza para ver a fórmula original da planilha com os valores substituídos.</p>`;
}

/* ---- Identificação ---- */
function tabIdent(card, avaliacao){
  const desabilitar = !identEditable(card) ? 'disabled' : '';
  return `<p class="hint mb10">Campos amarelos da aba "Relatório". Campos obrigatórios (*) ficam em destaque quando vazios. O e-mail do cliente não existe na planilha; foi acrescentado para o envio.</p><div class="fields">` + IDENT_FIELDS.map(campo => {
    const valor = card.ident[campo.chave] ?? '';
    const classeFaltando = campo.req && !String(valor).trim() ? ' miss' : '';
    const desabilitado = campo.chave === 'emailCliente' ? '' : desabilitar;
    return `<div class="field${campo.wide ? ' wide' : ''}${classeFaltando}"><label for="i-${campo.chave}">${escaparHtml(campo.label)}${campo.req ? ' *' : ''}</label><input id="i-${campo.chave}" class="${card.stage !== 'entrada' && avaliacao.bad.has('i:' + campo.chave) ? 'bad-in' : ''}" data-k="${campo.chave}" type="${campo.type || 'text'}" ${campo.type === 'number' ? 'step="any"' : ''} value="${escaparHtml(valor)}" ${desabilitado}></div>`;
  }).join('') + '</div>';
}
function noteEdit(card){ if(!edicaoRegistrada[card.id]){ edicaoRegistrada[card.id] = true; addLog(card, 'Dados editados'); } }

/* ---- Plan1 ---- */
const CALC_COLS = [['hd','h/d',3],['rho','Massa específica (kg/m³)',0],['ini','fci,ext,inicial (MPa)',2],['k1','k1',4],['k2','k2',4],['k3','k3',2],['k4','k4',2],['fci','fci,ext (MPa)',2]];
function tabPlan1(card, avaliacao){
  const stageRO = !editStage(card);
  const fckParams = `<div class="sec"><h3>Parâmetros do critério</h3>
    <div class="field fck-field"><label for="plan-fck">fck 28 dias (MPa)</label><input id="plan-fck" data-k="fck" type="number" min="0" step="any" value="${escaparHtml(card.ident.fck)}" ${identEditable(card) ? '' : 'disabled'}></div>
    <p class="hint mt8">Limites mínimos calculados a partir do fck de 28 dias. Os resultados dos ensaios são apresentados na planilha abaixo.</p>
    <div id="plan-fck-limits" aria-live="polite">${fckLimitsHtml(card)}</div>
    <div class="radios mt8" role="radiogroup" aria-label="Critério aplicado sobre"><b>Critério aplicado sobre:</b>
      <label><input type="radio" name="crit" value="media" ${card.criterio === 'media' ? 'checked' : ''} ${stageRO ? 'disabled' : ''}> média dos CPs da idade</label>
      <label><input type="radio" name="crit" value="individual" ${card.criterio === 'individual' ? 'checked' : ''} ${stageRO ? 'disabled' : ''}> cada CP individualmente</label></div></div>`;
  const head = `<tr><th>CP</th><th class="in">Idade</th><th class="in">Data do ensaio</th><th class="in">Altura 1 (mm)</th><th class="in">Altura 2 (mm)</th><th class="in">Altura 3 (mm)</th><th class="in">Diâmetro D1 (mm)</th><th class="in">Diâmetro D2 (mm)</th><th class="in">Massa (kg)</th><th class="in">Carga de ruptura (tf)</th><th class="th-green">Sentido de extração</th><th class="th-blue">Método de cura</th>${CALC_COLS.map(coluna => `<th>${coluna[1]}</th>`).join('')}</tr>`;
  let anyLocked = false;
  const rows = card.cps.map((cp,indice) => {
    const locked = rowLocked(card, cp); anyLocked = anyLocked || locked;
    const desabilitar = (stageRO || locked) ? 'disabled' : '';
    const ageOpts = `<option value=""></option>` + AGES.map(idade => `<option value="${idade}" ${Number(cp.idade) === idade ? 'selected' : ''}>${idade} d</option>`).join('');
    const sOpts = `<option value=""></option>` + SENTIDOS.map(opcao => `<option ${cp.sentido === opcao ? 'selected' : ''}>${opcao}</option>`).join('');
    const cOpts = `<option value=""></option>` + CURAS.map(opcao => `<option ${cp.cura === opcao ? 'selected' : ''}>${opcao}</option>`).join('');
    const celulaNumerica = (campo, posicao) => `<td><input type="number" step="any" data-i="${indice}" data-f="${campo}" ${posicao !== undefined ? `data-x="${posicao}"` : ''} value="${escaparHtml(posicao !== undefined ? cp[campo][posicao] : cp[campo])}" ${desabilitar}></td>`;
    const canRm = !stageRO && !locked && card.cps.length > 1;
    return `<tr id="r-${indice}" class="${locked ? 'locked' : ''}" ${locked ? 'title="Idade já notificada ao cliente: linha travada"' : ''}><td>${cp.n}${canRm ? `<button class="rm" type="button" data-rm="${indice}" title="Remover o CP ${cp.n}" aria-label="Remover o CP ${cp.n}">×</button>` : ''}</td>
      <td><select class="sel-age" data-i="${indice}" data-f="idade" ${desabilitar}>${ageOpts}</select></td>
      <td><input class="w-date" type="date" data-i="${indice}" data-f="dataEnsaio" value="${escaparHtml(cp.dataEnsaio)}" ${desabilitar}></td>
      ${celulaNumerica('h',0)}${celulaNumerica('h',1)}${celulaNumerica('h',2)}${celulaNumerica('d',0)}${celulaNumerica('d',1)}${celulaNumerica('massa')}${celulaNumerica('carga')}
      <td><select class="sel-green" data-i="${indice}" data-f="sentido" ${desabilitar}>${sOpts}</select></td>
      <td><select class="sel-blue" data-i="${indice}" data-f="cura" ${desabilitar}>${cOpts}</select></td>
      ${CALC_COLS.map(([coluna]) => `<td class="calc" id="c-${indice}-${coluna}" data-i="${indice}" data-k="${coluna}"></td>`).join('')}</tr>`;
  }).join('');
  return fckParams + `<div class="sec"><div class="toolbar">
      <span class="hint">Células amarelas, verdes e azuis: digitação. Cinzas: fórmulas da planilha original (clique para inspecionar). Linha sem nenhum dado = ensaio ainda não realizado. Use + CP para adicionar e × ao lado do número para remover (dá para desfazer).${anyLocked ? ' Linhas de idades já notificadas ficam travadas.' : ''}</span>
      <span class="spacer"></span>
      ${!stageRO ? '<button class="btn" data-act="importcard">Importar planilha (.xlsx)</button>' : ''}
      ${!stageRO && card.cps.length < 15 ? '<button class="btn" data-act="addcp">+ CP</button>' : ''}
      <button class="btn" data-act="csv">Exportar CSV</button></div>
    <div class="tbl-wrap"><table class="t"><thead>${head}</thead><tbody>${rows}</tbody></table></div>
    <div class="hint mt6">Coeficiente angular (A) = ${formatarNumero(card.coefA,4)} · Coeficiente linear (B) = ${formatarNumero(card.coefB,4)} (valores fixos da planilha)</div>
    <div id="insp"></div><div class="sec mt16"><h3>Erros desta planilha</h3><div id="plIssues"></div></div></div>`;
}
function removeCP(card, indice){
  const cp = card && card.cps[indice];
  if(!cp || !editStage(card) || rowLocked(card, cp)) return;
  if(card.cps.length <= 1){ toast('A Plan1 precisa ter ao menos um CP.', 'warn'); return; }
  const saved = JSON.parse(JSON.stringify(cp)), numero = cp.n;
  card.cps.splice(indice, 1); card.cps.forEach((item, posicao) => { item.n = posicao + 1; });
  celulaInspecionada = null;
  addLog(card, `CP ${numero} removido da Plan1${saved.idade ? ' (' + saved.idade + ' dias)' : ''}`);
  save(); renderDrawer(); renderBoard();
  toastUndo(`CP ${numero} removido. Os números dos CPs seguintes foram ajustados.`, () => {
    card.cps.splice(indice, 0, saved); card.cps.forEach((item, posicao) => { item.n = posicao + 1; });
    addLog(card, `Remoção do CP ${numero} desfeita`); save();
    if(idCardAberto === card.id) renderDrawer();
    renderBoard();
  });
}
function issueHTML(erro, withGo=true){
  return `<div class="issue"><span class="pill err">Erro</span><span class="grow"><b>${escaparHtml(erro.where)}</b> ${escaparHtml(erro.msg)}<br><span class="hint">Onde: ${escaparHtml(erro.cells || '—')}</span></span>${withGo ? `<button class="btn sm" data-goto="${escaparHtml(chaveDoErro(erro))}">Ir para o campo</button>` : ''}</div>`;
}
function fckLimitsHtml(card){
  const fck = paraNumero(card.ident.fck);
  return `<div class="tbl-wrap"><table class="t plain"><thead><tr>${AGES.map(idade => `<th>${idade} dias · ${LIMITE_POR_IDADE[idade]*100}%</th>`).join('')}</tr></thead><tbody><tr>${AGES.map(idade => `<td><b>${fck > 0 ? formatarNumero(fck * LIMITE_POR_IDADE[idade],2) + ' MPa' : '—'}</b></td>`).join('')}</tr></tbody></table></div>`;
}
function refreshPlan1(){
  const card = cardAberto(); if(!card) return; const avaliacao = evaluate(card);
  const limits = consultar('#plan-fck-limits'); if(limits) limits.innerHTML = fckLimitsHtml(card);
  avaliacao.rows.forEach(linha => {
    const linhaTabela = consultar('#r-' + linha.indice); if(!linhaTabela) return;
    linhaTabela.classList.toggle('idle', !linha.calculo.started);
    linhaTabela.classList.toggle('err', linha.calculo.errors.length > 0);
    CALC_COLS.forEach(([coluna,,casas]) => {
      const celula = consultar(`#c-${linha.indice}-${coluna}`); celula.textContent = linha.calculo.vals[coluna] == null ? '' : formatarNumero(linha.calculo.vals[coluna], casas);
      const comProblema = (coluna === 'fci' && linha.calculo.errors.some(erro => erro.kind === 'limite')) || ((coluna === 'k1' || coluna === 'k2') && linha.calculo.errors.some(erro => erro.kind === 'coef') && linha.calculo.vals[coluna] == null && linha.calculo.started);
      celula.classList.toggle('bad', !!comProblema);
      celula.classList.toggle('sel', !!celulaInspecionada && celulaInspecionada.indice === linha.indice && celulaInspecionada.coluna === coluna);
    });
  });
  document.querySelectorAll('#dBody [data-f]').forEach(entrada => entrada.classList.toggle('bad-in', avaliacao.bad.has(chaveDoCampo(+entrada.dataset.i, entrada.dataset.f, entrada.dataset.x))));
  const listaDeErros = consultar('#plIssues'); if(listaDeErros) listaDeErros.innerHTML = avaliacao.errors.filter(erro => erro.kind !== 'ident').map(erro => issueHTML(erro)).join('') || '<p class="hint">Nenhum erro encontrado.</p>';
  renderInspector(card);
}
function planInput(card, entrada){
  const cp = card.cps[+entrada.dataset.i], nomeCampo = entrada.dataset.f;
  if(entrada.dataset.x !== undefined) cp[nomeCampo][+entrada.dataset.x] = entrada.value; else cp[nomeCampo] = nomeCampo === 'idade' ? (entrada.value ? Number(entrada.value) : '') : entrada.value;
}
function identInput(card, entrada){
  card.ident[entrada.dataset.k] = entrada.value;
  const definicao = IDENT_FIELDS.find(candidato => candidato.chave === entrada.dataset.k);
  if(definicao?.req) entrada.closest('.field')?.classList.toggle('miss', !entrada.value.trim());
  entrada.classList.remove('bad-in');
}
function afterEdit(card){
  noteEdit(card); save();
  if(abaAtual === 'plan1') refreshPlan1();
  if(abaAtual === 'ajuste') refreshAjuste();
  renderHead(card, evaluate(card)); renderBoard();
}
function bindEdit(){
  const body = consultar('#dBody');
  body.oninput = evento => {
    const draft = evento.target.closest('[data-email-draft]');
    if(draft){
      const card = cardAberto();
      card.emailDrafts = card.emailDrafts || {};
      card.emailDrafts[draft.dataset.emailDraft] = draft.value;
      save();
      const mailLink = consultar('#mailOpen');
      if(mailLink && card.ident.emailCliente) mailLink.href = 'mailto:' + card.ident.emailCliente + '?subject=' + encodeURIComponent(consultar('#mailSubj').textContent) + '&body=' + encodeURIComponent(draft.value);
      return;
    }
    const entrada = evento.target.closest('[data-f],[data-k],[data-note]'); if(!entrada || entrada.tagName === 'SELECT') return;
    const card = cardAberto();
    if(entrada.dataset.note !== undefined){ setNote(card, +entrada.dataset.note, entrada.value); return; }
    if(entrada.dataset.k !== undefined) identInput(card, entrada); else planInput(card, entrada);
    afterEdit(card);
  };
  body.onchange = evento => {
    const card = cardAberto();
    const caixaConferi = evento.target.closest('[data-verify]'); if(caixaConferi){ toggleVerify(card, +caixaConferi.dataset.verify, caixaConferi.checked); return; }
    const entrada = evento.target.closest('[data-f]');
    if(entrada && entrada.tagName === 'SELECT'){ planInput(card, entrada); afterEdit(card); }
  };
  body.onclick = evento => { const celula = evento.target.closest('td.calc'); if(celula){ celulaInspecionada = {indice:+celula.dataset.i, coluna:celula.dataset.k}; refreshPlan1(); } };
}
function explainFormula(card, cp, chave){   // reexecuta a cadeia de fórmulas do CP e registra as variáveis usadas em `chave`
  const tabelas = cfgOf(card), compiladas = cfgCompiled(tabelas), contexto = {maps: cfgMaps(tabelas)}, variaveis = cpEnv(card, cp);
  for(const chaveAtual of FORM_ORDER){
    const compilada = compiladas[chaveAtual], nomeVariavel = chaveAtual.toUpperCase();
    const varNameDescritivo = FORM_META[chaveAtual] && FORM_META[chaveAtual].varName;
    variaveis[nomeVariavel] = null;
    if(varNameDescritivo) variaveis[varNameDescritivo] = null;
    if(compilada.error){ if(chaveAtual === chave) return {formula: compilada.src, error: compilada.error, vars: []}; continue; }
    const trace = chaveAtual === chave ? [] : null; contexto.trace = trace;
    try {
      const val = formEval(compilada.ast, variaveis, contexto);
      variaveis[nomeVariavel] = val;
      if(varNameDescritivo) variaveis[varNameDescritivo] = val;
      Object.entries(FORM_VAR_ALIASES).forEach(([alias, target]) => {
        if(target === nomeVariavel) variaveis[alias] = val;
      });
      if(chaveAtual === chave) return {formula: compilada.src, value: val, vars: trace, varName: varNameDescritivo};
    }
    catch(erro){ if(chaveAtual === chave) return {formula: compilada.src, error: erro instanceof MissingInput ? 'faltam dados (' + erro.message + ')' : erro.message, vars: trace, lookup: erro instanceof LookupError, varName: varNameDescritivo}; }
  }
  return null;
}
function renderInspector(card){
  const caixa = consultar('#insp'); if(!caixa) return;
  if(!celulaInspecionada){ caixa.innerHTML = ''; return; }
  const cp = card.cps[celulaInspecionada.indice], indice = celulaInspecionada.indice, chave = celulaInspecionada.coluna, rowP = 7 + indice, rowK1 = 11 + indice, rowK2 = 9 + indice;
  const referenciaPlanilha = {   // referência: célula e fórmula da planilha original
    hd:{cell:`K1!I${rowK1}`, excel:`=IFERROR(G${rowK1}/H${rowK1},"")`},
    rho:{cell:`Plan1!M${rowP}`, excel:`=IFERROR(((L${rowP}*1000)/((PI()*((J${rowP}/2)^2)*AVERAGE(G${rowP}:I${rowP}))/1000)*1000),"")`},
    ini:{cell:`Plan1!O${rowP}`, excel:`=IFERROR((N${rowP}*1000*9.80665)/((PI()*AVERAGE(J${rowP}:K${rowP})^2)/4)*coefa+coefb,"")`},
    k1:{cell:`Plan1!R${rowP} → K1!J${rowK1}`, excel:`=IFERROR(VLOOKUP(ROUND(I${rowK1},2),$B$4:$C$104,2,FALSE),"")`},
    k2:{cell:`Plan1!S${rowP} → k2!F${rowK2}`, excel:`=IFERROR(VLOOKUP(ROUND(E${rowK2},0),$I$4:$J$104,2,FALSE),"")`},
    k3:{cell:`Plan1!T${rowP}`, excel:`=IF(P${rowP}="","",IF(P${rowP}="Ortogonal",0.05,0))`},
    k4:{cell:`Plan1!U${rowP}`, excel:`=IF(Q${rowP}="","",IF(Q${rowP}="Ao ar",-0.04,0))`},
    fci:{cell:`Plan1!V${rowP}`, excel:`=IFERROR(O${rowP}*(1+R${rowP}+S${rowP}+T${rowP}+U${rowP}),"")`}
  }[chave];
  const explicacao = explainFormula(card, cp, chave), formatarValor = valor => typeof valor === 'number' ? cfgFormatarNumero(valor) : `"${valor}"`;
  const vars = explicacao ? [...new Map(explicacao.vars.map(([nome, valor]) => [nome, valor])).entries()].map(([nome, valor]) => `${nome} = ${formatarValor(valor)}`) : [];
  caixa.innerHTML = `<div class="insp"><h4>CP ${cp.n} · ${escaparHtml(FORM_META[chave].label)}</h4>
    <div class="hint">Fórmula em uso (editável em Configurações):</div><code>${escaparHtml(chave + ' = ' + (explicacao ? explicacao.formula : ''))}</code>
    ${explicacao && explicacao.value !== undefined ? `<code>${escaparHtml(vars.concat(chave + ' = ' + formatarValor(explicacao.value)).join('\n'))}</code>` : `<p class="hint">Ainda sem resultado: ${escaparHtml(explicacao && explicacao.error ? explicacao.error : 'faltam dados ou há erro neste CP.')}</p>`}
    ${chave === 'k1' && explicacao && explicacao.lookup ? '<div class="note">Na planilha o IFERROR deixa a célula em branco sem avisar. Aqui isso vira um erro de validação.</div>' : ''}
    <div class="hint mt8">Planilha original (referência): ${escaparHtml(referenciaPlanilha.cell)}</div><code>${escaparHtml(referenciaPlanilha.excel)}</code></div>`;
}
function exportCSV(card){
  const avaliacao = evaluate(card);
  const head = ['CP','Idade','Data do ensaio','Altura 1','Altura 2','Altura 3','D1','D2','Massa (kg)','Carga (tf)','Sentido','Cura','h/d','Massa específica','fci,ext,inicial','k1','k2','k3','k4','fci,ext'];
  const montarLinha = linha => { const cp = linha.cp, valores = linha.calculo.vals; return [cp.n,cp.idade,cp.dataEnsaio,...cp.h,...cp.d,cp.massa,cp.carga,cp.sentido,cp.cura,valores.hd,valores.rho,valores.ini,valores.k1,valores.k2,valores.k3,valores.k4,valores.fci].map(valor => valor == null ? '' : String(valor).replace('.',',')).join(';'); };
  const csv = '﻿' + [head.join(';'), ...avaliacao.rows.filter(linha => linha.calculo.started).map(montarLinha)].join('\n');
  const link = document.createElement('a'); link.href = URL.createObjectURL(new Blob([csv], {type:'text/csv;charset=utf-8'})); link.download = `plan1-placa-${card.ident.placa || card.id}.csv`; link.click(); setTimeout(() => URL.revokeObjectURL(link.href), 1500);
}

/* ---- Análise ---- */
function resultCards(card, avaliacao){
  const keys = AGES.filter(idade => avaliacao.ages[idade]);
  if(!keys.length) return '<p class="hint">Nenhuma idade com resultado calculado ainda.</p>';
  return `<div class="stats">${keys.map(idade => {
    const resultadoIdade = avaliacao.ages[idade], maximo = Math.max(resultadoIdade.media, resultadoIdade.limit || 0) * 1.2 || 1;
    const status = resultadoIdade.pass === null ? '<span class="pill mute">Sem fck</span>' : resultadoIdade.pass ? '<span class="pill ok">Atende</span>' : '<span class="pill warn">Não atende</span>';
    return `<div class="stat"><div class="row-between"><b>${idade} dias</b>${status}</div>
      <div class="big">${formatarNumero(resultadoIdade.media,2)} <span class="hint">MPa (média de ${resultadoIdade.n})</span></div>
      <div class="meter ${resultadoIdade.pass === false ? 'fail' : ''}"><i style="width:${Math.min(100, resultadoIdade.media/maximo*100)}%"></i>${resultadoIdade.limit != null ? `<b style="left:${Math.min(100, resultadoIdade.limit/maximo*100)}%" title="Mínimo"></b>` : ''}</div>
      <div class="hint">Mínimo: ${formatarNumero(resultadoIdade.limit,2)} MPa (${LIMITE_POR_IDADE[idade]*100}% do fck ${escaparHtml(card.ident.fck)})</div>
      <div class="vals">${resultadoIdade.vals.map(valor => `<span class="${resultadoIdade.limit != null && valor < resultadoIdade.limit ? 'low' : ''}">${formatarNumero(valor,2)}</span>`).join('')}</div></div>`;
  }).join('')}</div>`;
}
function tabAnalise(card, avaliacao){
  let aviso;
  if(!avaliacao.started.length) aviso = '<div class="banner info">Nenhum CP lançado ainda. Digite ou importe os dados na aba Plan1.</div>';
  else if(avaliacao.errors.length) aviso = `<div class="banner" role="alert"><b>${avaliacao.errors.length} erro(s) encontrado(s).</b> ${card.stage === 'analise' ? 'O card permanece em Análise até a correção; ao zerar os erros, ele segue para o Ajuste ou para Notificar cliente quando você sair da edição.' : 'Corrija antes de avançar.'}</div>`;
  else if(card.stage === 'analise') aviso = '<div class="banner okk banner-row"><span><b>Sem erros.</b> O card só segue quando você sair da edição (fechar o card) ou clicar em Continuar: para Ajuste, se alguma idade ficou abaixo do mínimo, ou direto para Notificar cliente. Pode testar valores à vontade.</span><button class="btn primary sm" data-act="reanalyse">Continuar →</button></div>';
  else aviso = '<div class="banner okk"><b>Sem erros.</b> Os dados passaram em todas as validações.</div>';
  const rules = RULES.map(rule => {
    const items = avaliacao.errors.filter(erro => erro.kind === rule.kind);
    const situacao = !avaliacao.started.length ? 'na' : items.length ? 'no' : 'ok';
    return `<div class="rule"><div class="rule-h"><span class="ic ${situacao}">${situacao === 'ok' ? '✓' : situacao === 'no' ? '✕' : '–'}</span>${escaparHtml(rule.title)}${items.length ? ` <span class="pill err">${items.length}</span>` : ''}</div>${items.map(erro => issueHTML(erro)).join('')}</div>`;
  }).join('');
  const opcoesCriterio = `<div class="radios" role="radiogroup" aria-label="Critério aplicado sobre"><b>Critério aplicado sobre:</b>
    <label><input type="radio" name="crit" value="media" ${card.criterio === 'media' ? 'checked' : ''}> média dos CPs da idade</label>
    <label><input type="radio" name="crit" value="individual" ${card.criterio === 'individual' ? 'checked' : ''}> cada CP individualmente</label></div>`;
  return aviso + `<div class="sec"><div class="sec-head"><h3 class="m0">Validação dos dados</h3>${card.stage === 'analise' ? '<button class="btn sm" data-act="reanalyse">Reanalisar</button>' : ''}</div>${rules}</div>
    <div class="sec"><h3>Critérios de aceitação (EGTC)</h3>${opcoesCriterio}
    <p class="hint mb12">O e-mail não diz se o limite vale para a média ou para cada CP. Alterne para ver o efeito. Mínimos: fck × 50% (3 dias), × 75% (7 dias) e × 100% (28 dias); com fck 35 MPa: 17,5 / 26,25 / 35 MPa. Resultado abaixo do mínimo não é erro de dados: o card passa pela etapa Ajuste antes da notificação.</p>
    ${avaliacao.errors.length ? '<div class="banner mt0">Resultados provisórios: há erros de validação nos dados. Corrija-os antes de confiar nestes valores.</div>' : ''}${resultCards(card, avaliacao)}</div>`;
}

/* ---- Ajuste (idades abaixo do mínimo) ---- */
const ajRows = (card, avaliacao, idade) => avaliacao.rows.filter(linha => linha.calculo.started && Number(linha.cp.idade) === idade);
function ajRow(card, linha){
  const cp = linha.cp, indice = linha.indice, desabilitar = (!editStage(card) || rowLocked(card, cp)) ? 'disabled' : '';
  const celulaNumerica = (campo, posicao) => `<td><input type="number" step="any" data-i="${indice}" data-f="${campo}" ${posicao !== undefined ? `data-x="${posicao}"` : ''} value="${escaparHtml(posicao !== undefined ? cp[campo][posicao] : cp[campo])}" ${desabilitar}></td>`;
  const sOpts = `<option value=""></option>` + SENTIDOS.map(opcao => `<option ${cp.sentido === opcao ? 'selected' : ''}>${opcao}</option>`).join('');
  const cOpts = `<option value=""></option>` + CURAS.map(opcao => `<option ${cp.cura === opcao ? 'selected' : ''}>${opcao}</option>`).join('');
  return `<tr><td>${cp.n}</td>${celulaNumerica('h',0)}${celulaNumerica('h',1)}${celulaNumerica('h',2)}${celulaNumerica('d',0)}${celulaNumerica('d',1)}${celulaNumerica('massa')}${celulaNumerica('carga')}
    <td><select class="sel-green" data-i="${indice}" data-f="sentido" ${desabilitar}>${sOpts}</select></td><td><select class="sel-blue" data-i="${indice}" data-f="cura" ${desabilitar}>${cOpts}</select></td>
    <td class="fcell" id="ajf-${indice}"></td><td id="ajs-${indice}"></td></tr>`;
}
function tabAjuste(card, avaliacao){
  const inStage = card.stage === 'ajuste';
  const pendentes = pendingAges(card, avaliacao);
  const show = AGES.filter(idade => (pendentes.includes(idade) && (inStage || avaliacao.ages[idade].pass === false)) || (card.adjust[idade] && (card.adjust[idade].hash || card.adjust[idade].note)));
  let intro;
  if(!show.length) intro = `<div class="banner ${inStage ? 'okk' : 'info'}">${inStage ? 'Nenhuma idade abaixo do mínimo no momento. Não há o que ajustar: você já pode concluir o ajuste.' : 'Nenhuma idade abaixo do mínimo. Este card não precisa passar pelo Ajuste.'}</div>`;
  else if(inStage && !pendentes.some(idade => avaliacao.ages[idade].pass === false)) intro = '<div class="banner info"><b>Correção de dados.</b> Nenhuma idade está abaixo do mínimo. Edite o que for preciso nas tabelas abaixo (ou nas abas Identificação e Plan1) e conclua o ajuste para seguir para IA de Decisão / classificação. Se uma edição deixar alguma idade abaixo do mínimo, ela exigirá conferência.</div>';
  else if(inStage) intro = '<div class="banner warn" role="alert"><b>Idade(s) abaixo do mínimo.</b> Isso não é erro de digitação, mas precisa ser verificado: reconfira as medições, edite o que estiver errado e, para cada idade abaixo do mínimo, marque <b>Conferi as medições</b> e escreva uma <b>justificativa</b> (qualquer texto serve, sem mínimo de caracteres). Depois conclua o ajuste para ir à IA de Decisão / classificação. Se um valor editado fizer a idade atender o mínimo, ela deixa de exigir isso.</div>';
  else intro = `<div class="banner info">${pendentes.some(idade => avaliacao.ages[idade].pass === false) ? 'Há idade abaixo do mínimo. Depois da análise sem erros, o card passa por esta etapa antes de ir à IA de Decisão / classificação.' : 'Registro do ajuste feito neste card.'}</div>`;
  const head = '<tr><th>CP</th><th class="in">Altura 1</th><th class="in">Altura 2</th><th class="in">Altura 3</th><th class="in">D1</th><th class="in">D2</th><th class="in">Massa (kg)</th><th class="in">Carga (tf)</th><th class="th-green">Sentido</th><th class="th-blue">Cura</th><th>fci,ext (MPa)</th><th>Situação</th></tr>';
  const secs = show.map(idade => {
    const rows = ajRows(card, avaliacao, idade), registro = card.adjust[idade] || {};
    return `<div class="adj${avaliacao.ages[idade] && avaliacao.ages[idade].pass === false ? '' : ' okk'}" data-aj-age="${idade}">
      <div class="adj-h"><b>${idade} dias</b><span id="aj-pill-${idade}"></span><span id="aj-sum-${idade}"></span></div>
      <div class="tbl-wrap"><table class="t"><thead>${head}</thead><tbody>${rows.map(linha => ajRow(card, linha)).join('')}</tbody></table></div>
      <div class="adj-v">
        <label class="chk"><input type="checkbox" data-verify="${idade}" id="aj-chk-${idade}"> Conferi as medições de ${idade} dias</label>
        <label for="aj-note-${idade}" class="hint lbl-note">Justificativa <span id="aj-nreq-${idade}"></span></label>
        <textarea data-note="${idade}" id="aj-note-${idade}" rows="2" placeholder="Escreva qualquer texto (ex.: cargas reconferidas; resultado mantido)" ${inStage ? '' : 'disabled'}>${escaparHtml(registro.note || '')}</textarea>
        <div class="hint" id="aj-stale-${idade}"></div></div></div>`;
  }).join('');
  const tail = inStage ? `<div class="sec"><h3>Para concluir o ajuste</h3><div id="ajChecks"></div><div id="ajIssues"></div><p class="mt10"><button class="btn primary" data-act="move" data-to="decision">Concluir ajuste → Classificação</button></p></div>` : '';
  return intro + secs + tail;
}
function refreshAjuste(){
  const card = cardAberto(); if(!card) return; const avaliacao = evaluate(card), inStage = card.stage === 'ajuste';
  document.querySelectorAll('#dBody [data-aj-age]').forEach(secao => {
    const idade = +secao.dataset.ajAge, resultadoIdade = avaliacao.ages[idade];
    ajRows(card, avaliacao, idade).forEach(linha => {
      const fci = linha.calculo.vals.fci, limite = resultadoIdade ? resultadoIdade.limit : null;
      const celulaFci = consultar('#ajf-' + linha.indice), celulaSituacao = consultar('#ajs-' + linha.indice);
      if(celulaFci) celulaFci.textContent = fci == null ? '' : formatarNumero(fci, 2);
      if(celulaSituacao) celulaSituacao.innerHTML = fci == null ? '' : (limite != null && fci < limite ? '<span class="pill warn">abaixo</span>' : '<span class="pill ok">ok</span>');
    });
    const failing = !!resultadoIdade && resultadoIdade.pass === false && !card.notified[idade];
    secao.classList.toggle('okk', !(resultadoIdade && resultadoIdade.pass === false));
    consultar('#aj-pill-' + idade).innerHTML = !resultadoIdade ? '<span class="pill mute">sem resultado</span>' : resultadoIdade.pass === false ? '<span class="pill warn">Abaixo do mínimo</span>' : resultadoIdade.pass ? '<span class="pill ok">Atende agora</span>' : '<span class="pill mute">Sem fck</span>';
    consultar('#aj-sum-' + idade).textContent = resultadoIdade ? `média ${formatarNumero(resultadoIdade.media,2)} MPa · mínimo ${formatarNumero(resultadoIdade.limit,2)} MPa` + (resultadoIdade.pass === false ? ` · faltam ${formatarNumero(resultadoIdade.limit - resultadoIdade.media,2)} MPa (${formatarNumero((resultadoIdade.limit - resultadoIdade.media) / resultadoIdade.limit * 100,1)}%)` : '') : '';
    const caixaConferi = consultar('#aj-chk-' + idade), conferido = isVerified(card, idade), registro = card.adjust[idade], temJustificativa = hasNote(card, idade);
    caixaConferi.checked = conferido; caixaConferi.disabled = !inStage || !failing;
    consultar('#aj-nreq-' + idade).textContent = failing ? '(obrigatória; qualquer texto serve)' : '(opcional)';
    const note = consultar('#aj-note-' + idade); if(note) note.classList.toggle('need', inStage && failing && !temJustificativa);
    let hint = '';
    if(!failing) hint = (resultadoIdade && resultadoIdade.pass) ? 'Esta idade atende o mínimo: não precisa de conferência nem de justificativa.' : '';
    else if(inStage){
      const falta = [];
      if(!conferido) falta.push(registro && registro.hash ? 'marcar de novo a caixa de conferência (os dados mudaram)' : 'marcar a caixa de conferência');
      if(!temJustificativa) falta.push('preencher a justificativa');
      hint = falta.length ? 'Falta: ' + falta.join(' e ') + '.' : 'Conferência completa.';
    }
    consultar('#aj-stale-' + idade).textContent = hint;
  });
  document.querySelectorAll('#dBody [data-f]').forEach(entrada => entrada.classList.toggle('bad-in', avaliacao.bad.has(chaveDoCampo(+entrada.dataset.i, entrada.dataset.f, entrada.dataset.x))));
  const listaCondicoes = consultar('#ajChecks'); if(listaCondicoes) listaCondicoes.innerHTML = listChecks(gateChecks(card, 'ia'));
  const listaErros = consultar('#ajIssues'); if(listaErros) listaErros.innerHTML = avaliacao.errors.map(erro => issueHTML(erro)).join('');
}
function toggleVerify(card, idade, marcada){
  const registro = card.adjust[idade] = card.adjust[idade] || {};
  if(marcada){ registro.hash = assinaturaDaIdade(card, idade); registro.t = new Date().toISOString(); addLog(card, `Ajuste: ${idade} dias conferido e confirmado${registro.note ? ' — ' + registro.note : ''}`); }
  else { registro.hash = null; addLog(card, `Ajuste: confirmação de ${idade} dias removida`); }
  save(); refreshAjuste(); renderHead(card, evaluate(card)); renderBoard();
}
function setNote(card, idade, text){ const registro = card.adjust[idade] = card.adjust[idade] || {}; registro.note = text; save(); refreshAjuste(); renderHead(card, evaluate(card)); renderBoard(); }

/* ---- Coeficientes ---- */
function tabCoef(card, avaliacao){
  const used1 = new Set(), used2 = new Set();
  const rows = avaliacao.rows.filter(linha => linha.calculo.started).map(linha => {
    const valores = linha.calculo.vals; if(valores.hd != null) used1.add(Math.round(valores.hd*100)); if(valores.d0 != null) used2.add(valores.d0);
    return `<tr><td>${linha.cp.n}</td><td>${formatarNumero(valores.h,2)}</td><td>${formatarNumero(valores.d,2)}</td><td>${formatarNumero(valores.hd,3)}</td><td>${formatarNumero(valores.hdR,2)}</td><td>${formatarNumero(valores.k1,4)}</td><td>${valores.d0 ?? '—'}</td><td>${formatarNumero(valores.k2,4)}</td><td>${formatarNumero(valores.k3,2)}</td><td>${formatarNumero(valores.k4,2)}</td><td><b>${valores.k1 != null && valores.k2 != null && valores.k3 != null && valores.k4 != null ? formatarNumero(valores.k1+valores.k2+valores.k3+valores.k4,4) : '—'}</b></td></tr>`;
  }).join('') || '<tr><td colspan="11">Nenhum CP lançado.</td></tr>';
  const tabelas = cfgOf(card);
  const linhasK1 = tabelas.k1.map(([chave,valor]) => `<tr class="${used1.has(Math.round(chave*100)) ? 'used' : ''}"><td>${formatarNumero(chave,2)}</td><td>${formatarNumero(valor,4)}</td></tr>`).join('');
  const linhasK2 = tabelas.k2.map(([chave,valor]) => `<tr class="${used2.has(chave) ? 'used' : ''}"><td>${chave}</td><td>${formatarNumero(valor,4)}</td></tr>`).join('');
  return coefInfo(card) + `<div class="sec"><h3>Coeficientes por CP</h3><div class="tbl-wrap"><table class="t"><thead><tr><th>CP</th><th>h médio (mm)</th><th>d médio (mm)</th><th>h/d</th><th>h/d arred.</th><th>k1</th><th>d arred.</th><th>k2</th><th>k3</th><th>k4</th><th>Σ k</th></tr></thead><tbody>${rows}</tbody></table></div></div>
  <div class="sec"><div class="grid2">
    <div><h3>Tabela K1 (aba "K1")</h3><div class="scroll-sm"><table class="t"><thead><tr><th>h/d</th><th>k1</th></tr></thead><tbody>${linhasK1}</tbody></table></div></div>
    <div><h3>Tabela K2 (aba "k2")</h3><div class="scroll-sm"><table class="t"><thead><tr><th>Diâmetro (mm)</th><th>k2</th></tr></thead><tbody>${linhasK2}</tbody></table></div></div>
  </div><p class="hint mt8">Linhas destacadas: valores usados pelos CPs deste card.</p></div>
  <div class="sec"><h3>k3 e k4 (fórmulas em uso)</h3><ul class="premise"><li><b>k3</b> (direção da extração): <code>${escaparHtml(cfgForms(tabelas).k3)}</code></li><li><b>k4</b> (umidade do testemunho): <code>${escaparHtml(cfgForms(tabelas).k4)}</code></li></ul></div>`;
}

/* ---- IA generativa (LLM) (OpenRouter) ---- */
function renderMarkdown(md){
  if(!md) return '';
  let text = String(md).trim();

  // 1. Escapar HTML para segurança
  text = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  // 2. Parser de tabelas Markdown (| col | col |)
  const tableRegex = /((?:^[ \t]*\|.+?\|[ \t]*\r?\n)+(?:^[ \t]*\|[-: |]+\|[ \t]*\r?\n)(?:^[ \t]*\|.+?\|[ \t]*(?:\r?\n|$))+)/gm;
  text = text.replace(tableRegex, (match) => {
    const lines = match.trim().split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    if (lines.length < 2) return match;
    const parseRow = l => l.replace(/^\||\|$/g, '').split('|').map(c => c.trim());
    const headers = parseRow(lines[0]);
    const aligns = parseRow(lines[1]).map(col => {
      const left = col.startsWith(':'), right = col.endsWith(':');
      if (left && right) return 'center';
      if (right) return 'right';
      return 'left';
    });
    let thead = '<thead><tr>';
    headers.forEach((h, i) => {
      const align = aligns[i] || 'left';
      thead += `<th style="text-align:${align};">${h}</th>`;
    });
    thead += '</tr></thead>';

    let tbody = '<tbody>';
    lines.slice(2).forEach(rowLine => {
      const cells = parseRow(rowLine);
      tbody += '<tr>';
      cells.forEach((c, i) => {
        const align = aligns[i] || 'left';
        tbody += `<td style="text-align:${align};">${c}</td>`;
      });
      tbody += '</tr>';
    });
    tbody += '</tbody>';
    return `<div class="tbl-wrap" style="margin:14px 0;"><table class="t">${thead}${tbody}</table></div>\n\n`;
  });

  // 3. Blockquotes (> texto)
  text = text.replace(/^&gt;\s+(.*$)/gim, '<blockquote>$1</blockquote>');

  // 4. Cabeçalhos
  text = text.replace(/^#### (.*$)/gim, '<h4 style="margin:14px 0 6px; font-size:13px; font-weight:700;">$1</h4>');
  text = text.replace(/^### (.*$)/gim, '<h3 style="margin:16px 0 6px; font-size:14px; font-weight:700;">$1</h3>');
  text = text.replace(/^## (.*$)/gim, '<h2 style="margin:18px 0 8px; font-size:15px; font-weight:700; border-bottom:1px solid var(--border); padding-bottom:4px;">$1</h2>');
  text = text.replace(/^# (.*$)/gim, '<h1 style="margin:20px 0 10px; font-size:16px; font-weight:700;">$1</h1>');

  // 5. Linhas divisórias (---)
  text = text.replace(/^---+$/gim, '<hr style="margin:16px 0; border:none; border-top:1px solid var(--border);">');

  // 6. Badges e Vereditos
  text = text.replace(/\[CONFORME\]/g, '<span class="pill ok" style="font-size:12px; padding:2px 8px; font-weight:700; vertical-align:middle;">CONFORME</span>');
  text = text.replace(/\[ATENÇÃO\]/g, '<span class="pill warn" style="font-size:12px; padding:2px 8px; font-weight:700; vertical-align:middle;">ATENÇÃO</span>');
  text = text.replace(/\[NÃO CONFORME\]/g, '<span class="pill err" style="font-size:12px; padding:2px 8px; font-weight:700; vertical-align:middle;">NÃO CONFORME</span>');

  // 7. Formatação de texto
  text = text.replace(/\*\*(.*?)\*\*/g, '<b>$1</b>');
  text = text.replace(/\*(.*?)\*/g, '<i>$1</i>');
  text = text.replace(/`([^`]+)`/g, '<code style="background:var(--surface2); padding:2px 5px; border-radius:3px; font-size:12px;">$1</code>');

  // 8. Listas
  text = text.replace(/^\s*[-•*]\s+(.*$)/gim, '<li style="margin-left:18px; margin-bottom:4px;">$1</li>');
  text = text.replace(/^\s*(\d+)\.\s+(.*$)/gim, '<li style="margin-left:18px; margin-bottom:4px;" value="$1">$2</li>');

  // 9. Quebras de linha
  text = text.replace(/\n\n+/g, '<br><br>');
  text = text.replace(/\n/g, '<br>');

  return text;
}

function refreshPipeline(card){
  renderBoard(); if(idCardAberto === card.id) renderDrawer();
}
function pipelineSnapshot(card){ return JSON.parse(JSON.stringify({card,config:estado.config})); }
function executionCurrent(card, kind, token, key, stage){
  return estado.cards.includes(card) && card.stage === stage && pipelineExecutions.get(card.id)?.token === token && AiPipeline.inputKey(card,estado.config,kind) === key;
}
async function readPipelineResponse(response){
  const contentType = response.headers?.get('content-type');
  const recovery = response.status === 404
    ? 'O servidor em execução não possui esta rota. Reinicie o servidor com iniciar-servidor.bat e atualize a página antes de tentar novamente.'
    : 'O servidor não retornou uma resposta JSON válida. Confira o endereço da aplicação e inicie o servidor com iniciar-servidor.bat antes de tentar novamente.';
  if(contentType && !/application\/(?:[\w.-]+\+)?json\b/i.test(contentType)) throw new Error(recovery);
  try { return await response.json(); }
  catch { throw new Error(recovery); }
}
async function triggerDecisionAnalysis(card){
  if(!card || card.stage !== 'decision') return;
  if(pipelineExecutions.has(card.id)) return;
  const problems = gateChecks(card,'decision').filter(check => !check.ok);
  if(problems.length){ card.decisionAnalysis = {status:'erro',error:problems.map(check => check.text).join('; ')}; save(); refreshPipeline(card); return; }
  const token = Symbol(), key = AiPipeline.inputKey(card,estado.config,'decision');
  pipelineExecutions.set(card.id,{token});
  card.decisionAnalysis = {status:'aguardando',inputKey:key,model:estado.config.decision.model};
  card.aiAnalysis = null;
  save(); refreshPipeline(card);
  const snapshot = pipelineSnapshot(card);
  try {
    const response = await fetch('/api/decision/analyze',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({cardId:card.id,...snapshot})});
    const data = await readPipelineResponse(response);
    if(!executionCurrent(card,'decision',token,key,'decision')) return;
    if(!response.ok || !data.ok || !data.decision) throw new Error(data.error || 'Resposta de classificação inválida.');
    card.decisionAnalysis = data.decision;
    if(!AiPipeline.validDecision(card,estado.config)) throw new Error('A classificação não corresponde aos dados atuais. Tente novamente.');
    addLog(card,`Classificação concluída: ${decisionLabel(data.decision.verdict)} (${data.decision.model})`);
    pipelineExecutions.delete(card.id);
    save();
    moveTo(card,'ia',{auto:true,note:'classificação válida incluída no contexto da LLM'});
  } catch(error){
    if(!executionCurrent(card,'decision',token,key,'decision')) return;
    card.decisionAnalysis = {status:'erro',error:error.message,inputKey:key,model:estado.config.decision.model};
    save(); refreshPipeline(card); toast(error.message,'err');
  } finally {
    if(pipelineExecutions.get(card.id)?.token === token) pipelineExecutions.delete(card.id);
  }
}
async function triggerAiAnalysis(card){
  if(!card || !['ia','decision'].includes(card.stage)) return;
  if(pipelineExecutions.has(card.id)) return;
  if(!AiPipeline.validDecision(card,estado.config)){
    moveTo(card,'decision',{auto:true,note:'classificação ausente ou desatualizada'}); return;
  }
  if(card.stage !== 'ia'){ moveTo(card,'ia',{auto:true}); return; }
  const token = Symbol(), key = AiPipeline.inputKey(card,estado.config,'ai');
  pipelineExecutions.set(card.id,{token});
  card.aiAnalysis = {status:'aguardando',verdict:'aguardando',summary:'Aguardando parecer da IA generativa (LLM)...',inputKey:key,model:estado.config.ai.model};
  save(); refreshPipeline(card);
  const snapshot = pipelineSnapshot(card);
  try {
    const response = await fetch('/api/ai/analyze',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({cardId:card.id,...snapshot})});
    const data = await readPipelineResponse(response);
    if(!executionCurrent(card,'ai',token,key,'ia')) return;
    if(!response.ok || !data.ok || !data.analysis) throw new Error(data.error || 'Resposta do parecer inválida.');
    if(data.analysis.inputKey !== key) throw new Error('O parecer não corresponde aos dados atuais. Tente novamente.');
    if(data.analysis.status !== 'concluido' || typeof data.analysis.content !== 'string' || data.analysis.content.trim().length < 30) throw new Error('O modelo retornou um parecer vazio ou incompleto. Tente novamente.');
    card.aiAnalysis = data.analysis;
    addLog(card,`Parecer da IA generativa (LLM) concluído (${data.analysis.verdict}) via ${data.analysis.model}`);
    if(gateChecks(card,'notificar').every(check => check.ok)){
      moveTo(card,'notificar',{auto:true,note:'parecer válido da IA generativa (LLM) concluído'});
      toast('Parecer concluído. Card movido para Notificar cliente.','ok');
    } else { save(); refreshPipeline(card); toast('Parecer concluído. Confira as pendências para notificar o cliente.','warn'); }
  } catch(error){
    if(!executionCurrent(card,'ai',token,key,'ia')) return;
    card.aiAnalysis = {status:'erro',verdict:'erro',summary:error.message,error:error.message,inputKey:key};
    save(); refreshPipeline(card); toast(error.message,'err');
  } finally {
    if(pipelineExecutions.get(card.id)?.token === token) pipelineExecutions.delete(card.id);
  }
}
function decisionLabel(value){ return {conforme:'Conforme',atencao:'Atenção',nao_conforme:'Não conforme'}[value] || 'Pendente'; }
function tabDecision(card){
  const d = card.decisionAnalysis, valid = AiPipeline.validDecision(card,estado.config);
  const title = d?.status === 'aguardando' ? 'Classificando o ensaio...' : valid ? decisionLabel(d.verdict) : d?.status === 'erro' ? 'Falha na classificação' : 'Classificação pendente';
  const rows = Object.entries(valid ? (d?.probabilities || {}) : {}).map(([key,value]) => `<tr><td>${decisionLabel(key)}</td><td>${formatarNumero(value*100,1)}%</td></tr>`).join('');
  return `<div class="sec"><h3>IA de Decisão / classificação</h3><p class="mt8"><b>${escaparHtml(title)}</b></p>
    ${d?.error ? `<p class="txt-err mt8" role="alert">${escaparHtml(d.error)}</p>` : ''}
    <p class="hint mt8">A classificação orienta o parecer técnico. Conforme, Atenção e Não conforme seguem para a LLM após uma resposta válida.</p>
    ${d?.model ? `<p class="hint mt8">Modelo: ${escaparHtml(d.model)}${d.generatedAt ? ' · '+formatarDataHora(d.generatedAt) : ''}</p>` : ''}
    ${valid && d?.confidence != null ? `<p class="mt8">Confiança retornada pelo modelo: ${formatarNumero(d.confidence*100,1)}%</p>` : ''}
    ${rows ? `<div class="tbl-wrap mt10"><table class="t plain"><thead><tr><th>Classe</th><th>Probabilidade</th></tr></thead><tbody>${rows}</tbody></table></div>` : ''}
    ${card.stage === 'decision' && d?.status !== 'aguardando' ? '<p class="mt10"><button class="btn primary" data-act="gen_decision">Tentar novamente</button></p>' : ''}
    ${valid && card.stage === 'ia' ? '<p class="hint mt8">Resultado incluído no contexto da análise da IA generativa (LLM).</p>' : ''}</div>`;
}

function tabIa(card, avaliacao){
  const hasAi = !!card.aiAnalysis;
  const status = card.aiAnalysis?.status || (hasAi && card.aiAnalysis.content ? 'concluido' : 'pendente');
  const v = card.aiAnalysis?.verdict || 'pendente';
  const vPill = status === 'aguardando'
    ? '<span class="pill info" style="font-size:12px; padding:3px 10px;">AGUARDANDO PARECER DA IA</span>'
    : (status === 'erro'
      ? '<span class="pill err" style="font-size:12px; padding:3px 10px;">ERRO NA CONSULTA</span>'
      : (v === 'conforme'
        ? '<span class="pill ok" style="font-size:12px; padding:3px 10px;">CONFORME</span>'
        : (v === 'atencao'
          ? '<span class="pill warn" style="font-size:12px; padding:3px 10px;">ATENÇÃO</span>'
          : (v === 'nao_conforme'
            ? '<span class="pill err" style="font-size:12px; padding:3px 10px;">NÃO CONFORME</span>'
            : '<span class="pill mute" style="font-size:12px; padding:3px 10px;">PENDENTE DE ANÁLISE</span>'))));

  const modelInfo = (hasAi && card.aiAnalysis.generatedAt)
    ? `<span class="hint" style="font-size:11px;">Modelo: <b>${escaparHtml(card.aiAnalysis.model || 'openrouter/free')}</b> · Emitido em: ${formatarDataHora(card.aiAnalysis.generatedAt)}</span>`
    : '';

  let bodyContent = '';
  if(status === 'aguardando'){
    bodyContent = `
      <div class="sec" style="background:var(--surface); border:1px solid var(--accent); border-radius:8px; padding:36px 20px; text-align:center; box-shadow:var(--shadow);">
        <div style="font-size:13px; font-weight:700; color:var(--accent); margin-bottom:12px; text-transform:uppercase; letter-spacing:0.5px;">Processamento em andamento</div>
        <h3 style="font-size:16px; margin:0 0 8px; color:var(--text);">Aguardando Parecer da IA generativa (LLM)</h3>
        <p class="hint" style="max-width:540px; margin:0 auto 16px; line-height:1.5; font-size:13px;">
          Os dados dos corpos de prova da <b>Placa ${escaparHtml(card.ident.placa || card.id)}</b> estão sendo processados.<br>A IA generativa (LLM) está analisando a evolução das resistências, dispersão de medidas e conformidade técnica normatizada.
        </p>
        <div style="display:inline-flex; align-items:center; gap:8px; padding:6px 14px; background:var(--surface2); border:1px solid var(--border); border-radius:20px; font-size:12px; color:var(--text);">
          <span style="display:inline-block; width:8px; height:8px; border-radius:50%; background:var(--accent);">●</span>
          Requisição em processamento...
        </div>
      </div>
    `;
  } else if(status === 'erro'){
    bodyContent = `
      <div class="sec" style="background:var(--surface); border:1px solid var(--err); border-radius:8px; padding:24px 20px; box-shadow:var(--shadow);">
        <div style="display:flex; align-items:center; gap:8px; margin-bottom:12px; color:var(--err);">
          <b style="font-size:15px;">Ocorreu uma falha na consulta da IA generativa (LLM)</b>
        </div>
        <p style="font-size:13px; color:var(--text); line-height:1.5; margin-bottom:16px;">
          ${escaparHtml(card.aiAnalysis?.summary || 'Não foi possível obter o parecer técnico da IA generativa (LLM).')}
        </p>
        <div style="display:flex; gap:10px; align-items:center;">
          <button class="btn primary sm" data-act="gen_ia">Tentar Novamente</button>
          <button class="btn sm" data-act="move" data-to="ajuste">← Voltar para Ajuste</button>
        </div>
      </div>
    `;
  } else if(hasAi && card.aiAnalysis.content){
    bodyContent = `
      <div class="sec" style="background:var(--surface); border:1px solid var(--border); border-radius:8px; padding:18px; box-shadow:var(--shadow);">
        <div style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:8px; margin-bottom:14px; padding-bottom:10px; border-bottom:1px solid var(--border);">
          <div style="display:flex; align-items:center; gap:8px;">
            <b style="font-size:14px;">Diagnóstico do Modelo</b>
            ${vPill}
          </div>
          <div>${modelInfo}</div>
        </div>
        <div class="ia-body-text" style="font-size:13.5px; line-height:1.6; color:var(--text);">
          ${renderMarkdown(card.aiAnalysis.content)}
        </div>

        <!-- Caixa de Decisão da Equipe Técnica -->
        <div style="margin-top:22px; padding:16px 18px; background:var(--surface2); border:1px solid var(--border); border-left:4px solid var(--accent); border-radius:8px; display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:12px;">
          <div>
            <b style="font-size:13.5px; display:block; margin-bottom:2px;">Revisão da equipe técnica:</b>
            <span class="hint" style="font-size:12px;">Um parecer válido encaminha o card automaticamente para Notificar cliente. Revise o texto antes de enviar ou retorne ao Ajuste para correções.</span>
          </div>
          <div style="display:flex; gap:8px; flex-wrap:wrap; align-items:center;">
            <button class="btn" data-act="move" data-to="ajuste" style="font-weight:600;">← Voltar para Ajuste</button>
            <button class="btn primary" data-act="tab" data-tab="notif" style="font-weight:600;">Ver notificação →</button>
          </div>
        </div>

        <div style="margin-top:16px; padding-top:12px; border-top:1px solid var(--border); display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:8px;">
          <div style="display:flex; gap:8px;">
            <button class="btn sm" data-act="copy_ia">Copiar parecer completo</button>
            <button class="btn sm ghost" data-act="tab" data-tab="notif">Preparar e-mail de notificação</button>
          </div>
          <div>
            <button class="btn sm" data-act="gen_ia">Regerar Parecer da IA generativa (LLM)</button>
          </div>
        </div>
      </div>
    `;
  } else {
    bodyContent = `
      <div class="sec" style="background:var(--surface); border:1px dashed var(--accent); border-radius:8px; padding:28px 20px; text-align:center;">
        <div style="font-size:13px; font-weight:700; color:var(--accent); margin-bottom:10px; text-transform:uppercase; letter-spacing:0.5px;">IA generativa (LLM)</div>
        <h3 style="font-size:16px; margin-bottom:6px;">Parecer Técnico Especializado via IA generativa (LLM)</h3>
        <p class="hint" style="max-width:560px; margin:0 auto 18px; line-height:1.5;">
          A IA generativa (LLM) analisa as cargas e dimensões dos corpos de prova da <b>Placa ${escaparHtml(card.ident.placa || card.id)}</b>, compara as resistências obtidas com os limites do <b>fck ${card.ident.fck || 35} MPa</b> e gera um parecer técnico fundamentado para embasar a notificação ao cliente.
        </p>
        <button class="btn primary" data-act="gen_ia" style="padding:8px 20px; font-size:14px;">Gerar análise com IA generativa (LLM) agora</button>
      </div>
    `;
  }

  return `
    <div class="head-row" style="margin-bottom:14px; align-items:center;">
      <div>
        <h3 style="font-size:16px; margin:0 0 2px;">Parecer Técnico · IA generativa (LLM)</h3>
        <p class="hint">Análise diagnóstica e recomendações técnicas emitidas via OpenRouter antes da notificação.</p>
      </div>
      <div style="display:flex; gap:8px; align-items:center;">
        ${status !== 'aguardando' && hasAi ? '<button class="btn sm" data-act="gen_ia">Regerar Parecer da IA generativa (LLM)</button>' : ''}
      </div>
    </div>
    ${bodyContent}
  `;
}

/* ---- Textos prontos (notificação e relatório final) ---- */
function ageLine(idade, resultadoIdade){ return `• ${idade} dias: média ${formatarNumero(resultadoIdade.media,2)} MPa (mínimo ${formatarNumero(resultadoIdade.limit,2)} MPa) — ${resultadoIdade.pass === false ? 'NÃO ATENDE' : resultadoIdade.pass ? 'atende' : 'sem fck para comparar'}`; }
function noticeDraftKey(card, avaliacao){ return 'notice:' + pendingAges(card, avaliacao).join(','); }
function buildNotice(card, avaliacao){
  const ages = pendingAges(card, avaliacao), reprovadas = ages.filter(idade => avaliacao.ages[idade].pass === false);
  const missing = AGES.filter(idade => !card.notified[idade] && !ages.includes(idade));
  const subject = `${reprovadas.length ? 'ATENÇÃO · ' : ''}Resultado de ensaio · Placa ${card.ident.placa} · ${ages.join(', ')} dias`;
  let body = `Prezados,\n\nSeguem os resultados de resistência à compressão (fci,ext, NBR 7680-1) dos testemunhos extraídos da Placa ${card.ident.placa} (${card.ident.elemento}), fck ${card.ident.fck} MPa:\n\n` + ages.map(idade => ageLine(idade, avaliacao.ages[idade])).join('\n');
  if(reprovadas.length) body += `\n\nA(s) idade(s) ${reprovadas.join(', ')} dias ficou(aram) abaixo do mínimo do critério. Estamos à disposição para discutir os próximos passos.`;
  if(missing.length) body += `\n\nPróximos resultados previstos: ` + missing.map(idade => `${idade} dias${expectedDate(card, idade) ? ' em ' + expectedDate(card, idade) : ''}`).join('; ') + '.';
  body += `\n\nO relatório final será enviado após a conclusão dos ensaios de 3, 7 e 28 dias.`;
  const analysis = card.aiAnalysis;
  const parts = AiPipeline.notificationParts(analysis?.content);
  const validReport = analysis?.content && !['erro','aguardando','desatualizado'].includes(analysis.status);
  const includeReport = validReport && (analysis.notificationReport || analysis.includeInNotification) && parts.report;
  if(includeReport) body += `\n\nParecer técnico da IA generativa (LLM):\n${parts.report}`;
  body += `\n\nAtenciosamente,\n[Nome] — Setor de relatórios`;
  if(validReport && analysis.notificationSuggestion && parts.suggestion){
    body = parts.suggestion + (includeReport ? `\n\nParecer técnico da IA generativa (LLM):\n${parts.report}` : '');
  }
  if(typeof card.emailDrafts?.[noticeDraftKey(card,avaliacao)] === 'string') body = card.emailDrafts[noticeDraftKey(card,avaliacao)];
  return {ages, fails: reprovadas, subject, body};
}
function buildFinal(card, avaliacao){
  const subject = `Relatório final de ensaio · Placa ${card.ident.placa}${card.ident.relNumero ? ' · Nº ' + card.ident.relNumero : ''}`;
  const body = `Prezados,\n\nSegue em anexo o relatório final de ensaio${card.ident.relNumero ? ' Nº ' + card.ident.relNumero : ''}, referente à Placa ${card.ident.placa} (${card.ident.elemento}), com os resultados de 3, 7 e 28 dias (fck ${card.ident.fck} MPa):\n\n` + AGES.filter(idade => avaliacao.ages[idade]).map(idade => ageLine(idade, avaliacao.ages[idade])).join('\n') + `\n\nOs resultados já haviam sido comunicados nas notificações anteriores. Permanecemos à disposição.\n\nAtenciosamente,\n[Nome] — Setor de relatórios`;
  return {subject, body:typeof card.emailDrafts?.final === 'string' ? card.emailDrafts.final : body};
}
function mailBlock(card, subject, body, {primary, primaryLabel, manualAct, manualLabel, enabled, why: motivoDesabilitado}){
  const email = card.ident.emailCliente || '';
  const href = email ? `mailto:${escaparHtml(email)}?subject=${escaparHtml(encodeURIComponent(subject))}&body=${escaparHtml(encodeURIComponent(body))}` : '';
  return `<div class="mailfield"><label for="emailCli"><b>Para:</b></label><input id="emailCli" type="email" placeholder="e-mail do cliente" value="${escaparHtml(email)}"></div>
    <div class="email"><div class="eh"><b>Assunto:</b> <span id="mailSubj">${escaparHtml(subject)}</span></div><label class="hint" for="mailText">Texto do e-mail · você pode editar antes de enviar</label><textarea class="eb" id="mailText" data-email-draft="${primary === 'sendnotice' ? noticeDraftKey(card,evaluate(card)) : 'final'}" rows="14">${escaparHtml(body)}</textarea></div>
    <div class="rowline">
      <button class="btn primary" data-act="${primary}" ${enabled && email ? '' : 'disabled'}>${primaryLabel}</button>
      <a id="mailOpen" class="btn ${href ? '' : 'disabled'}" ${href ? `href="${href}"` : ''}>Abrir no meu e-mail</a>
      <button class="btn" data-act="copy">Copiar texto</button>
      <button class="btn" data-act="${manualAct}" ${enabled ? '' : 'disabled'}>${manualLabel}</button>
    </div>
    <p class="hint">${enabled ? (email ? '' : 'Informe o e-mail do cliente para habilitar o envio em 1 clique e o botão "Abrir no meu e-mail". ') : motivoDesabilitado}</p>`;
}

/* ---- Notificação ---- */
function tabNotif(card, avaliacao){
  const historicoHtml = card.notifLog.length ? `<div class="sec"><h3>Notificações já registradas</h3><ul class="log">${[...card.notifLog].sort((primeira,segunda) => primeira.t < segunda.t ? 1 : -1).map(notificacao => `<li><time>${formatarDataHora(notificacao.t)}</time>${notificacao.ages.join(', ')} dias · ${escaparHtml(notificacao.mode)}</li>`).join('')}</ul></div>` : '';
  const pend = pendingAges(card, avaliacao);
  if(avaliacao.errors.length && card.stage === 'analise') return '<div class="banner">Há erros na análise. A notificação só é liberada depois que eles forem corrigidos.</div>' + historicoHtml;
  if(!pend.length){
    const mensagem = !avaliacao.started.length ? 'Nenhum resultado lançado ainda.' : (allNotified(card) ? 'As 3 idades já foram notificadas. O próximo passo é o relatório final.' : `Nenhuma notificação pendente. Aguardando resultados de ${AGES.filter(idade => !card.notified[idade]).join(', ')} dias.`);
    return `<div class="banner info">${mensagem}</div>` + historicoHtml;
  }
  const avisoPronto = buildNotice(card, avaliacao), enabled = card.stage === 'notificar';
  const ajustes = AGES.filter(idade => avisoPronto.ages.includes(idade) && card.adjust[idade] && card.adjust[idade].hash);
  const adjNote = ajustes.length ? `<p class="hint mb10">Ajuste interno (não vai no e-mail): ${ajustes.map(idade => `${idade} dias conferido${card.adjust[idade].note ? ' (' + escaparHtml(card.adjust[idade].note) + ')' : ''}`).join('; ')}.</p>` : '';
  const avisoInicial = avisoPronto.fails.length
    ? `<div class="banner" role="alert"><b>Alerta:</b> ${avisoPronto.fails.join(', ')} dias abaixo do mínimo. O texto abaixo já destaca isso para o cliente.</div>`
    : '<div class="banner okk">Resultados dentro do critério. O texto abaixo está pronto para envio.</div>';

  const blocoIaNotif = card.aiAnalysis ? `
    <div class="sec" style="background:var(--surface2); border:1px solid var(--border); border-left:4px solid var(${card.aiAnalysis.verdict === 'conforme' ? '--ok' : (card.aiAnalysis.verdict === 'atencao' ? '--warn' : '--err')}); border-radius:6px; padding:12px 14px; margin-bottom:14px;">
      <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:6px; flex-wrap:wrap; gap:6px;">
        <b style="display:flex; align-items:center; gap:6px; font-size:13px;">Parecer Técnico da IA generativa (LLM) (OpenRouter)</b>
        <span class="pill ${card.aiAnalysis.verdict === 'conforme' ? 'ok' : (card.aiAnalysis.verdict === 'atencao' ? 'warn' : 'err')}">${card.aiAnalysis.verdict.toUpperCase()}</span>
      </div>
      <p style="font-size:12.5px; margin:0 0 8px; color:var(--text); line-height:1.4;">${escaparHtml(card.aiAnalysis.summary)}</p>
      <div style="display:flex; gap:8px; flex-wrap:wrap;">
        <button class="btn sm ghost" data-act="apply_ia_suggestion" ${AiPipeline.notificationParts(card.aiAnalysis.content).suggestion && !['erro','aguardando','desatualizado'].includes(card.aiAnalysis.status) ? '' : 'disabled'}>Inserir sugestão de e-mail da IA</button>
        <button class="btn sm ghost" data-act="apply_ia_report" ${AiPipeline.notificationParts(card.aiAnalysis.content).report && !['erro','aguardando','desatualizado'].includes(card.aiAnalysis.status) ? '' : 'disabled'}>Adicionar parecer completo da IA</button>
      </div>
      ${!AiPipeline.notificationParts(card.aiAnalysis.content).suggestion ? '<p class="hint mt8">Este parecer não contém uma seção de sugestão de e-mail ao cliente.</p>' : ''}
    </div>
  ` : `
    <div class="sec" style="background:var(--surface3); border:1px dashed var(--border); border-radius:6px; padding:10px 14px; margin-bottom:14px; display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:8px;">
      <span style="font-size:12px; color:var(--muted);">IA generativa (LLM) ainda não foi gerada para este lote.</span>
      <button class="btn sm primary" data-act="gen_ia">Gerar análise com IA generativa (LLM)</button>
    </div>
  `;

  return avisoInicial + adjNote + blocoIaNotif + `<p class="hint mb10">Por padrão a notificação é manual: copie o texto ou abra no seu e-mail, envie e marque como notificado. Se preferir, o botão de 1 clique faz tudo (neste protótipo o envio é simulado e nada sai do navegador). Pendente: <b>${pend.join(', ')} dias</b>.</p>` +
    mailBlock(card, avisoPronto.subject, avisoPronto.body, {primary:'sendnotice', primaryLabel:'Enviar notificação agora (1 clique)', manualAct:'marknotified', manualLabel:'Marcar como notificado (envio manual)', enabled, why:'Os botões de envio ficam ativos quando o card está na etapa "Notificar cliente".'})
    + (enabled ? '<p class="hint mt6">Encontrou algo errado nos dados? <button class="btn sm" data-act="move" data-to="ajuste">← Voltar para Ajuste</button></p>' : '') + historicoHtml;
}

/* ---- Relatório final ---- */
function tabRel(card, avaliacao){
  const ident = card.ident, enabled = card.stage === 'relatorio';
  const status = card.finalSent ? `<span class="pill ok">Enviado em ${formatarDataHora(card.finalSent)}</span>` : '<span class="pill mute">Não enviado</span>';
  const lines = [];
  AGES.forEach(idade => {
    const linhasDaIdade = avaliacao.rows.filter(linha => linha.calculo.started && Number(linha.cp.idade) === idade);
    linhasDaIdade.forEach((linha,posicao) => { const valores = linha.calculo.vals; lines.push(`<tr><td>${linha.cp.n}</td><td>${escaparHtml(ident.nf)}</td><td>${idade} dias</td><td>${formatarNumero(valores.h,2)}</td><td>${formatarNumero(valores.d,2)}</td><td>${formatarNumero(valores.rho,0)}</td><td>${valores.ini != null ? formatarNumero(paraNumero(linha.cp.carga)*1000*GRAVIDADE,0) : '—'}</td><td>${formatarNumero(valores.ini,2)}</td><td>${formatarNumero(valores.k1,4)}</td><td>${formatarNumero(valores.k2,4)}</td><td>${formatarNumero(valores.k3,2)}</td><td>${formatarNumero(valores.k4,2)}</td><td>${formatarNumero(valores.fci,2)}</td>${posicao === 0 ? `<td rowspan="${linhasDaIdade.length}"><b>${avaliacao.ages[idade] ? formatarNumero(avaliacao.ages[idade].media,2) : '—'}</b></td>` : ''}</tr>`); });
  });
  const dataProjecao = ident.dataProjecao ? new Date(ident.dataProjecao + 'T00:00:00').toLocaleDateString('pt-BR') : '—';
  const cura = (card.cps.find(cp => cp.cura) || {}).cura || '—';
  const envioFinal = buildFinal(card, avaliacao);
  const blocoEmail = mailBlock(card, envioFinal.subject, envioFinal.body, {primary:'sendfinal', primaryLabel:'Enviar relatório final agora (1 clique)', manualAct:'markfinal', manualLabel:'Marcar como enviado (envio manual)', enabled: enabled && allNotified(card), why: enabled ? 'Disponível quando as 3 idades estiverem notificadas.' : 'Os botões de envio ficam ativos quando o card está na etapa "Relatório final".'});
  const paper = `<div class="paper-wrap"><div class="paper">
    <div class="ph">[Cabeçalho do laboratório e dados de acreditação]</div>
    <div class="rt">RELATÓRIO DE ENSAIO Nº ${escaparHtml(ident.relNumero || '[a definir]')}</div>
    <div class="center-b">CONCRETO PROJETADO</div>
    <p class="mt10"><b>Interessado:</b> ${escaparHtml(ident.interessado)}</p>
    <h4>1. Identificação da(s) amostra(s)</h4>
    <div class="id">
      <div><b>Central:</b> ${escaparHtml(ident.central)}</div><div><b>fck (MPa):</b> ${escaparHtml(ident.fck)} &nbsp; <b>Abat. especif.:</b> ${escaparHtml(ident.abatimento)}</div>
      <div><b>Cimento:</b> ${escaparHtml(ident.cimentoMarca)} · ${escaparHtml(ident.cimentoTipo)} · ${escaparHtml(ident.cimentoConsumo)} kg/m³</div><div><b>Aditivo 1:</b> ${escaparHtml(ident.aditivo)}</div>
      <div><b>Acelerador:</b> ${escaparHtml(ident.acelerador)} · ${escaparHtml(ident.aceleradorConsumo)} kg/m³</div><div><b>Agregados:</b> ${escaparHtml(ident.agregados)}</div>
      <div><b>Máquina de ensaio:</b> ${escaparHtml(ident.maquina)}</div><div><b>Data de projeção:</b> ${dataProjecao}</div>
      <div><b>Coletado por:</b> ${escaparHtml(ident.coletadoPor)} · <b>em:</b> ${escaparHtml(ident.coletadoEm)}</div><div><b>Método de cura:</b> ${escaparHtml(cura)}</div>
      <div class="span-all"><b>Elemento projetado:</b> ${escaparHtml(ident.elemento)}</div>
      <div><b>Placa:</b> ${escaparHtml(ident.placa)} &nbsp; <b>Nota fiscal:</b> ${escaparHtml(ident.nf)}</div>
    </div>
    <h4>2. Metodologia(s) utilizada(s)</h4>
    <div>ABNT NBR 7680-1:2015 — Extração, preparo, ensaio e análise de testemunhos de estruturas de concreto. Parte 1: Resistência à compressão.<br>ABNT NBR 14026:2012 — Concreto projetado: especificação.<br>ABNT NBR 5739:2018 — Ensaios de compressão de corpos de prova cilíndricos.</div>
    <h4>3. Resultados obtidos</h4>
    <table><thead><tr><th>CP</th><th>NF</th><th>Idade</th><th>Altura média (mm)</th><th>Diâmetro médio (mm)</th><th>Massa esp. (kg/m³) *</th><th>Carga de ruptura (N)</th><th>fci,ext,inicial (MPa)</th><th>k1</th><th>k2</th><th>k3</th><th>k4</th><th>fci,ext (MPa) **</th><th>Média (MPa)</th></tr></thead>
    <tbody>${lines.join('') || '<tr><td colspan="14">Sem CPs lançados.</td></tr>'}</tbody></table>
    <small class="mt6">* Massa específica aparente da amostra (kg/m³) · ** Tensão de ruptura corrigida · Obs. 1: k1 = correção pela relação h/d · Obs. 2: k2 = correção pelo efeito de broqueamento · Obs. 3: k3 = correção pela direção da extração · Obs. 4: k4 = correção pelo efeito da umidade</small>
    <div class="sig"><div>[Assinatura 1]</div><div>[Assinatura 2]</div></div>
  </div></div>`;
  const missing = AGES.filter(idade => !card.notified[idade]);
  const warn = missing.length ? `<div class="banner info">Pré-visualização parcial: ainda faltam ${missing.join(', ')} dias. O relatório final só é enviado depois que as 3 idades forem notificadas.</div>` : '';
  return warn + `<div class="rowline mt0"><b>Relatório final</b> ${status}<span class="spacer"></span><button class="btn" data-act="print">Imprimir / salvar PDF</button></div>${paper}
    <div class="sec mt20"><h3>E-mail de envio do relatório final</h3><p class="hint mb8">Anexe o PDF gerado por "Imprimir / salvar PDF" ao enviar manualmente.</p>${blocoEmail}</div>`;
}

/* ---- Histórico ---- */
function tabHist(card){
  if(!card.log?.length) return '<p class="hint">Ainda não há movimentações registradas para este card.</p>';
  return `<ul class="log">${[...card.log].sort((primeira,segunda) => primeira.t < segunda.t ? 1 : -1).map(entrada => `<li><time>${formatarDataHora(entrada.t)}</time>${escaparHtml(entrada.text)}</li>`).join('')}</ul>`;
}

/* ===== Novo lançamento: importar planilha ou digitar ===== */
function nextId(placa){
  let base = placa ? `RT-${placa}` : 'RT-' + (Math.max(0, ...estado.cards.map(card => parseInt(String(card.id).replace(/\D/g, '')) || 0)) + 1);
  let idCandidato = base, sufixo = 2; while(estado.cards.some(card => card.id === idCandidato)) idCandidato = base + '-' + (sufixo++);
  return idCandidato;
}
function withSkeleton(cps){
  const cpsCompletos = cps.map(cp => ({...cp}));
  AGES.forEach(idade => { if(!cpsCompletos.some(cp => Number(cp.idade) === idade)) for(let copia = 0; copia < 3; copia++) cpsCompletos.push(cpEmBranco(0, idade)); });
  cpsCompletos.sort((primeiro,segundo) => (AGES.indexOf(Number(primeiro.idade)) < 0 ? 9 : AGES.indexOf(Number(primeiro.idade))) - (AGES.indexOf(Number(segundo.idade)) < 0 ? 9 : AGES.indexOf(Number(segundo.idade))) || primeiro.n - segundo.n);
  cpsCompletos.forEach((cp,indice) => cp.n = indice + 1);
  return cpsCompletos;
}
function openNew(){
  importacaoPendente = null;
  consultar('#mBox').className = 'm-box';
  consultar('#mBox').innerHTML = `<div class="head-row"><div><h2 id="mTitle">Novo lançamento</h2><p class="hint">Escolha como entrar com os dados do ensaio. Depois da entrada, o card passa pela análise automaticamente.</p></div><button class="x" id="mClose" aria-label="Fechar">×</button></div>
    <div class="opts">
      <div class="opt"><h3>Importar planilha</h3><p class="hint">Planilha modelo de concreto projetado (.xlsx) com as abas Relatório e Plan1. Identificação, CPs e idades são lidos sozinhos.</p>
        <label class="drop" id="drop" tabindex="0"><input type="file" id="fileNew" accept=".xlsx,.xlsm" hidden><b>Arraste o arquivo aqui</b><br>ou clique para escolher</label>
        <button class="btn ghost" id="useEx" type="button">Usar exemplo da Placa 113</button></div>
      <div class="opt"><h3>Digitar manualmente</h3><p class="hint">Cria um card em Entrada de dados com a Plan1 em branco (3 CPs para cada idade). Preencha a identificação e os CPs e envie para análise.</p>
        <p class="mt12"><button class="btn" id="manualNew" type="button">Criar card em branco</button></p></div>
    </div>
    <div id="importPrev"></div>`;
  consultar('#modal').hidden = false; consultar('#mClose').focus();
}
function readFile(file, modo){
  if(typeof XLSX === 'undefined'){ showImportError('A biblioteca de leitura de planilhas não foi carregada.', modo); return; }
  file.arrayBuffer().then(bytes => {
    let parsed;
    try { parsed = parseWorkbook(XLSX.read(bytes, {type:'array'})); }
    catch(erro){ showImportError(erro.message || String(erro), modo); return; }
    parsed.filename = file.name;
    if(modo === 'merge') applyMerge(cardAberto(), parsed); else showImportPreview(parsed);
  }).catch(() => showImportError('Não foi possível ler o arquivo.', modo));
}
function showImportError(mensagem, modo){
  if(modo === 'merge' || consultar('#modal').hidden) toast('Importação: ' + mensagem, 'err');
  else consultar('#importPrev').innerHTML = `<div class="banner" role="alert"><b>Não foi possível importar.</b><ul><li>${escaparHtml(mensagem)}</li></ul></div>`;
}
function findMatch(parsed){
  const placa = String(parsed.ident.placa || '').trim(), notaFiscal = String(parsed.ident.nf || '').trim();
  if(!placa) return null;
  return estado.cards.find(card => UPDATABLE.includes(card.stage) && String(card.ident.placa).trim() === placa && String(card.ident.nf || '').trim() === notaFiscal) || null;
}
function showImportPreview(parsed){
  importacaoPendente = parsed;
  const cpsPorIdade = AGES.map(idade => `${idade} dias: ${parsed.cps.filter(cp => Number(cp.idade) === idade).length}`).join(' · ');
  const semIdade = parsed.cps.filter(cp => !cp.idade).length;
  const match = findMatch(parsed);
  const ident = parsed.ident;
  consultar('#importPrev').innerHTML = `<div class="prev"><b>${escaparHtml(parsed.filename)}</b><br>
    Placa <b>${escaparHtml(ident.placa || '—')}</b> · ${escaparHtml(ident.interessado || 'sem interessado')} · relatório ${escaparHtml(ident.relNumero || '—')}<br>
    <b>${parsed.cps.length} CPs</b> lidos (${cpsPorIdade}${semIdade ? ` · ${semIdade} sem idade` : ''}) · fck ${escaparHtml(ident.fck || '—')} MPa
    ${parsed.warnings.length ? `<ul>${parsed.warnings.map(aviso => `<li>${escaparHtml(aviso)}</li>`).join('')}</ul>` : ''}
    ${match ? `<div class="radios mt10"><label><input type="radio" name="imode" value="update" checked> Atualizar <b>${escaparHtml(match.id)}</b> (${escaparHtml(stageOf(match.stage).name)}): substitui só as idades ainda não notificadas</label><label><input type="radio" name="imode" value="new"> Criar um novo card</label></div>` : ''}
    <div class="rowline"><button class="btn primary" id="doImport" type="button">${match ? 'Importar e analisar' : 'Criar card e analisar'}</button><button class="btn ghost" id="cancelImport" type="button">Cancelar</button></div></div>`;
}
function commitImport(){
  const parsed = importacaoPendente; if(!parsed) return;
  const modo = (document.querySelector('input[name=imode]:checked') || {}).value;
  const match = findMatch(parsed);
  consultar('#modal').hidden = true;
  if(match && modo !== 'new'){ idCardAberto = match.id; applyMerge(match, parsed); openCard(match.id); return; }
  const card = criarCard(nextId(parsed.ident.placa), 'analise', {...blankIdent(), ...parsed.ident}, withSkeleton(parsed.cps), {coefA:parsed.coefA, coefB:parsed.coefB});
  addLog(card, `Planilha importada (${parsed.filename}): ${parsed.cps.length} CPs`);
  estado.cards.push(card); save(); renderBoard();
  runAnalysis(card);
  openCard(card.id);
}
const blankIdent = () => Object.fromEntries(IDENT_FIELDS.map(campo => [campo.chave, '']));
function applyMerge(card, parsed){
  if(!UPDATABLE.includes(card.stage)){ toast('Este card não aceita atualização nesta etapa.', 'warn'); return; }
  let ignored = 0; const replaced = [];
  Object.entries(parsed.ident).forEach(([chave,valor]) => { if(!ehVazio(valor) && ehVazio(card.ident[chave])) card.ident[chave] = valor; });
  AGES.forEach(idade => {
    const recebidos = parsed.cps.filter(cp => Number(cp.idade) === idade);
    if(!recebidos.length) return;
    if(card.notified[idade]){ ignored += recebidos.length; return; }
    card.cps = card.cps.filter(cp => Number(cp.idade) !== idade).concat(recebidos.map(cp => ({...cp})));
    replaced.push(idade);
  });
  parsed.cps.filter(cp => !cp.idade).forEach(cp => card.cps.push({...cp}));
  card.cps = withSkeleton(card.cps);
  addLog(card, `Planilha importada (${parsed.filename}): idades atualizadas ${replaced.length ? replaced.join(', ') + ' dias' : 'nenhuma'}${ignored ? `; ${ignored} CP(s) de idades já notificadas ignorados` : ''}`);
  save();
  if(ignored) toast(`${ignored} CP(s) de idades já notificadas foram ignorados (dados travados).`, 'warn');
  if(card.stage !== 'analise'){ card.stage = 'analise'; addLog(card, `Movido para Análise após a importação`); }
  save(); renderBoard();
  runAnalysis(card);
  if(idCardAberto === card.id) renderDrawer();
}
function manualNew(){
  const ident = {...blankIdent(), fck:35};
  const card = criarCard(nextId(''), 'entrada', ident, cpsEmBranco());
  addLog(card, 'Card criado manualmente');
  estado.cards.push(card); save(); renderBoard();
  consultar('#modal').hidden = true;
  openCard(card.id); abaAtual = 'ident';
  banner = {title:'Preencha a Identificação e a Plan1 e clique em "Enviar para análise".', items:[], info:true};
  renderDrawer();
}
consultar('#modal').addEventListener('mousedown', evento => { if(evento.target.id === 'modal' || evento.target.id === 'mClose') closeModal(); });
consultar('#modal').addEventListener('click', evento => {
  if(evento.target.id === 'useEx'){
    showImportPreview({ident:{...IDENT_PLACA_113}, cps:criarCps(DADOS_PLACA_113), coefA:1.0024, coefB:0.0299, warnings:['Dados de exemplo embutidos (equivalentes à planilha da Placa 113).'], filename:'Exemplo Placa 113'});
  }
  if(evento.target.id === 'manualNew') manualNew();
  if(evento.target.id === 'doImport') commitImport();
  if(evento.target.id === 'cancelImport'){ importacaoPendente = null; consultar('#importPrev').innerHTML = ''; }
});
consultar('#modal').addEventListener('change', evento => { if(evento.target.id === 'fileNew' && evento.target.files[0]) readFile(evento.target.files[0], 'new'); });
consultar('#modal').addEventListener('dragover', evento => { if(evento.target.closest('#drop')){ evento.preventDefault(); consultar('#drop').classList.add('over'); } });
consultar('#modal').addEventListener('dragleave', evento => { if(evento.target.closest('#drop')) consultar('#drop').classList.remove('over'); });
consultar('#modal').addEventListener('drop', evento => { if(evento.target.closest('#drop')){ evento.preventDefault(); consultar('#drop').classList.remove('over'); const arquivo = evento.dataTransfer.files[0]; if(arquivo) readFile(arquivo, 'new'); } });
consultar('#modal').addEventListener('keydown', evento => { if((evento.key === 'Enter' || evento.key === ' ') && evento.target.id === 'drop'){ evento.preventDefault(); consultar('#fileNew').click(); } });
consultar('#fileIn').addEventListener('change', evento => { const arquivo = evento.target.files[0]; if(arquivo) readFile(arquivo, evento.target.dataset.mode || 'merge'); evento.target.value = ''; });

/* ===== Fluxo e premissas ===== */
function openFlow(){
  consultar('#mBox').className = 'm-box';
  consultar('#mBox').innerHTML = `<div class="head-row"><div><h2 id="mTitle">Fluxo do processo</h2><p class="hint">Cada card é um relatório (placa) e atravessa as etapas abaixo. Dados entram por digitação ou importação. A análise roda ao enviar ou importar e, durante a correção de erros, só quando você sai da edição.</p></div><button class="x" id="mClose" aria-label="Fechar">×</button></div>
    <ol class="steps">${STAGES.map(etapa => `<li><b>${escaparHtml(etapa.name)} <span class="hint">· ${escaparHtml(etapa.role)}</span></b>${escaparHtml(etapa.desc)}<br><span class="hint">${escaparHtml(etapa.gate)}</span></li>`).join('')}</ol>
    <h3 class="sub-h">Ajuste: métricas abaixo do mínimo</h3>
    <p class="hint mb12">Depois da análise sem erros, idades com fci,ext abaixo do mínimo (50% do fck aos 3 dias, 75% aos 7 e 100% aos 28) não vão direto ao cliente. Elas passam pelo Ajuste, onde a pessoa reconfere as medições, edita o que estiver errado (inclusive o fck) e, para cada idade abaixo do mínimo, marca a caixa de conferência e escreve uma justificativa (qualquer texto, sem mínimo de caracteres). Se alterar os dados depois de conferir, a caixa precisa ser marcada de novo; a justificativa é mantida. Só então o card vai para Notificar cliente.</p>
    <h3 class="sub-h">Como as idades de 3, 7 e 28 dias entram no fluxo</h3>
    <p class="hint mb12">Os resultados chegam em datas diferentes. Cada idade analisada sem erros é notificada ao cliente; depois o card espera a próxima idade em "Aguardando idades" e volta para a Análise quando ela é lançada. Só quando as 3 idades foram notificadas o card vai para "Relatório final", e só é finalizado depois que o relatório final é enviado, não apenas as notificações. Dados de idades já notificadas ficam travados.</p>
    <h3 class="sub-h">Premissas a confirmar com a engenheira</h3>
    <ul class="premise">
      <li><b>Critério por média ou por CP?</b> O e-mail não define. O protótipo usa a média por idade e permite alternar na aba Análise.</li>
      <li><b>Resultado abaixo do mínimo não é erro de dados.</b> O card passa pelo Ajuste: confere as medições, edita se preciso e, em cada idade abaixo do mínimo, marca a caixa de conferência e escreve uma justificativa antes da notificação, que destaca o alerta. Cards que atendem o mínimo pulam o Ajuste.</li>
      <li><b>Limites derivados do fck.</b> 17,5 / 26,25 / 35 MPa vêm de 50% / 75% / 100% de 35 MPa e são calculados a partir do fck do card.</li>
      <li><b>"Divergir mais de 10%".</b> Implementado como (máx − mín) / média, separadamente para as 3 alturas e para D1 e D2.</li>
      <li><b>Linhas totalmente vazias</b> são tratadas como "ensaio ainda não realizado", não como erro.</li>
      <li><b>Idade do CP</b> não existe na Plan1; na planilha ela é digitada na aba Relatório. Na importação ela é lida de lá; na digitação virou uma coluna da Plan1.</li>
      <li><b>E-mail do cliente</b> não existe na planilha; foi acrescentado à identificação.</li>
      <li><b>k2 interpolado.</b> A planilha preenche os diâmetros intermediários por interpolação linear (74 mm dá 0,0912, não 0,09). Reproduzido como está.</li>
      <li><b>Tabelas k1 e k2 e fórmulas.</b> Em Configurações escolha o conjunto de tabelas em uso (planilha atual ou um importado) e edite as fórmulas de cálculo. Cada card usa as tabelas e fórmulas em uso até a primeira notificação ao cliente; depois elas ficam fixadas nele, para que alterações futuras não mudem resultados já comunicados.</li>
      <li><b>Massa específica</b> usa só D1 na planilha (as demais fórmulas usam a média). Reproduzido como está.</li>
      <li><b>Planilha original:</b> as linhas 52 a 66 da aba Relatório estão ocultas e apontam para linhas erradas da Plan1; a importação ignora essas duplicatas.</li>
      <li><b>IFERROR silencioso:</b> na planilha, k1 ou k2 fora da tabela deixam a célula em branco. Aqui viram erro de validação.</li>
    </ul>`;
  consultar('#modal').hidden = false; consultar('#mClose').focus();
}

/* ===== Toast ===== */
let temporizadorAviso;
function toast(mensagem, tipo=''){ const elementoAviso = consultar('#toast'); elementoAviso.textContent = mensagem; elementoAviso.className = 'show ' + tipo; clearTimeout(temporizadorAviso); temporizadorAviso = setTimeout(() => elementoAviso.className = '', 5200); }
function toastUndo(mensagem, undo){
  const elementoAviso = consultar('#toast'); clearTimeout(temporizadorAviso);
  elementoAviso.innerHTML = `${escaparHtml(mensagem)} <button class="tundo" type="button">Desfazer</button>`;
  elementoAviso.className = 'show act';
  elementoAviso.querySelector('.tundo').onclick = () => { elementoAviso.className = ''; undo(); toast('Remoção desfeita.', 'ok'); };
  temporizadorAviso = setTimeout(() => elementoAviso.className = '', 9000);
}

renderBoard();
syncFromSqlite();
