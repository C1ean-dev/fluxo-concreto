/* Motor de fórmulas · interpreta as fórmulas de cálculo editáveis (sem eval).
   Sintaxe parecida com a do Excel em português: operadores + - * / ^ e comparações (= <> < > <= >=), parênteses,
   argumentos separados por ponto e vírgula, decimais com vírgula ou ponto, textos entre aspas.
   Carregado antes de js/config.js e js/app.js. */

class FormulaError extends Error {}
class MissingInput extends Error { constructor(name){ super('falta valor em «' + name + '»'); this.varName = name; } }
class LookupError extends Error { constructor(table, argumento){ super(`valor ${argumento} não encontrado na tabela ${table}`); this.table = table; this.arg = argumento; } }

/* Mapeamento de sinônimos/aliases para permitir fórmulas com nomes 100% descritivos ou siglas curtas */
const FORM_VAR_ALIASES = {
  // Entradas de medição (alturas):
  ALTURA_1: 'H1', ALTURA1: 'H1', H1: 'H1',
  ALTURA_2: 'H2', ALTURA2: 'H2', H2: 'H2',
  ALTURA_3: 'H3', ALTURA3: 'H3', H3: 'H3',

  // Entradas de medição (diâmetros):
  DIAMETRO_1: 'D1', DIAMETRO1: 'D1', D1: 'D1',
  DIAMETRO_2: 'D2', DIAMETRO2: 'D2', D2: 'D2',

  // Entradas de medição (massa e carga):
  MASSA_CP_KG: 'MASSA', MASSA_KG: 'MASSA', MASSA: 'MASSA',
  CARGA_RUPTURA_TF: 'CARGA', CARGA_TF: 'CARGA', CARGA: 'CARGA',

  // Condições do ensaio:
  SENTIDO_EXTRACAO: 'SENTIDO', SENTIDO: 'SENTIDO',
  METODO_CURA: 'CURA', CURA: 'CURA',
  IDADE_DIAS: 'IDADE', IDADE: 'IDADE',

  // Calibração da prensa:
  COEFICIENTE_ANGULAR: 'A', COEFICIENTE_ANGULAR_A: 'A', COEFICIENTE_ANGULAR_PRENSA: 'A',
  COEF_ANGULAR_PRENSA: 'A', COEF_ANGULAR: 'A', COEFA: 'A', A: 'A',
  COEFICIENTE_LINEAR: 'B', COEFICIENTE_LINEAR_B: 'B', COEFICIENTE_LINEAR_PRENSA: 'B',
  COEF_LINEAR_PRENSA: 'B', COEF_LINEAR: 'B', COEFB: 'B', B: 'B',

  // Resultados calculados (etapas da norma):
  ALTURA_MEDIA: 'H', ALTURA_MEDIA_MM: 'H', H: 'H',
  DIAMETRO_MEDIO: 'D', DIAMETRO_MEDIO_MM: 'D', D: 'D',
  RELACAO_HD: 'HD', RELACAO_ESBELTEZ_HD: 'HD', HD: 'HD',
  MASSA_ESPECIFICA: 'RHO', MASSA_ESPECIFICA_KGM3: 'RHO', DENSIDADE: 'RHO', RHO: 'RHO',
  FCI_INICIAL: 'INI', FCI_EXT_INICIAL: 'INI', FCI_INICIAL_MPA: 'INI', TENSAO_INICIAL_MPA: 'INI', TENSAO_INICIAL: 'INI', INI: 'INI',
  K1_CORRECAO_HD: 'K1', K1_HD: 'K1', K1: 'K1',
  K2_CORRECAO_DIAMETRO: 'K2', K2_DIAMETRO: 'K2', K2: 'K2',
  K3_CORRECAO_EXTRACAO: 'K3', K3_SENTIDO: 'K3', K3: 'K3',
  K4_CORRECAO_CURA: 'K4', K4_CURA: 'K4', K4: 'K4',
  FCI_EXT: 'FCI', FCI_EXT_FINAL: 'FCI', FCI_EXT_FINAL_MPA: 'FCI', RESISTENCIA_FCI_MPA: 'FCI', FCI: 'FCI'
};

/* Variáveis de entrada (por CP) e ordem de cálculo das fórmulas editáveis */
const FORM_INPUTS = [
  'H1','H2','H3','D1','D2','MASSA','CARGA','IDADE','SENTIDO','CURA','A','B',
  'ALTURA_1','ALTURA_2','ALTURA_3','ALTURA1','ALTURA2','ALTURA3',
  'DIAMETRO_1','DIAMETRO_2','DIAMETRO1','DIAMETRO2',
  'MASSA_CP_KG','MASSA_KG','CARGA_RUPTURA_TF','CARGA_TF',
  'SENTIDO_EXTRACAO','METODO_CURA','IDADE_DIAS',
  'COEFICIENTE_ANGULAR','COEFICIENTE_LINEAR','COEFICIENTE_ANGULAR_A','COEFICIENTE_LINEAR_B',
  'COEF_ANGULAR_PRENSA','COEF_LINEAR_PRENSA','COEF_ANGULAR','COEF_LINEAR','COEFA','COEFB'
];
const FORM_ORDER = ['h','d','hd','rho','ini','k1','k2','k3','k4','fci'];
const FORM_META = {
  h:   {varName:'ALTURA_MEDIA_MM',       label:'Altura média h (mm)',                      fields:[{nome:'h',posicao:0},{nome:'h',posicao:1},{nome:'h',posicao:2}]},
  d:   {varName:'DIAMETRO_MEDIO_MM',     label:'Diâmetro médio d (mm)',                    fields:[{nome:'d',posicao:0},{nome:'d',posicao:1}]},
  hd:  {varName:'RELACAO_HD',            label:'Relação esbeltez h/d',                     fields:[{nome:'h',posicao:0},{nome:'h',posicao:1},{nome:'h',posicao:2},{nome:'d',posicao:0},{nome:'d',posicao:1}]},
  rho: {varName:'MASSA_ESPECIFICA_KGM3', label:'Massa específica aparente (kg/m³)',       fields:[{nome:'massa'},{nome:'h',posicao:0},{nome:'h',posicao:1},{nome:'h',posicao:2},{nome:'d',posicao:0}]},
  ini: {varName:'FCI_INICIAL_MPA',       label:'fci,ext,inicial (MPa)',                    fields:[{nome:'carga'},{nome:'d',posicao:0},{nome:'d',posicao:1}]},
  k1:  {varName:'K1_CORRECAO_HD',        label:'k1 · correção relação h/d',                fields:[{nome:'h',posicao:0},{nome:'h',posicao:1},{nome:'h',posicao:2},{nome:'d',posicao:0},{nome:'d',posicao:1}]},
  k2:  {varName:'K2_CORRECAO_DIAMETRO',   label:'k2 · correção diâmetro (broqueamento)',   fields:[{nome:'d',posicao:0},{nome:'d',posicao:1}]},
  k3:  {varName:'K3_CORRECAO_EXTRACAO',  label:'k3 · correção direção da extração',        fields:[{nome:'sentido'}]},
  k4:  {varName:'K4_CORRECAO_CURA',      label:'k4 · correção umidade / cura',            fields:[{nome:'cura'}]},
  fci: {varName:'FCI_EXT_FINAL_MPA',     label:'fci,ext corrigido final (MPa)',            fields:[{nome:'carga'}]}
};

/* Fórmulas padrão: nomes e variáveis descritivos, claros e autodocumentados */
const FORM_DEFAULT = {
  h:   'MEDIA(ALTURA_1; ALTURA_2; ALTURA_3)',
  d:   'MEDIA(DIAMETRO_1; DIAMETRO_2)',
  hd:  'ALTURA_MEDIA_MM / DIAMETRO_MEDIO_MM',
  rho: 'MASSA_CP_KG / ((PI() * (DIAMETRO_1 / 2)^2 * ALTURA_MEDIA_MM) / 1000000000)',
  ini: '(CARGA_RUPTURA_TF * 1000 * 9,80665) / (PI() * DIAMETRO_MEDIO_MM^2 / 4) * COEF_ANGULAR_PRENSA + COEF_LINEAR_PRENSA',
  k1:  'TABELA_K1(ARRED(RELACAO_HD; 2))',
  k2:  'TABELA_K2(ARRED(DIAMETRO_MEDIO_MM; 0))',
  k3:  'SE(SENTIDO_EXTRACAO = "Ortogonal"; 0,05; 0)',
  k4:  'SE(METODO_CURA = "Ao ar"; -0,04; 0)',
  fci: 'FCI_INICIAL_MPA * (1 + K1_CORRECAO_HD + K2_CORRECAO_DIAMETRO + K3_CORRECAO_EXTRACAO + K4_CORRECAO_CURA)'
};

const formNormalizar = texto => String(texto).normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase();
const FORM_ALIAS = {MEDIA:'MEDIA', AVERAGE:'MEDIA', SOMA:'SOMA', SUM:'SOMA', MAX:'MAX', MAXIMO:'MAX', MIN:'MIN', MINIMO:'MIN', ABS:'ABS',
  RAIZ:'RAIZ', SQRT:'RAIZ', PI:'PI', ARRED:'ARRED', ROUND:'ARRED', SE:'SE', IF:'SE', E:'E', AND:'E', OU:'OU', OR:'OU', TABELA_K1:'TABELA_K1', TABELA_K2:'TABELA_K2'};
const FORM_ARITY = {MEDIA:[1,99], SOMA:[1,99], MAX:[1,99], MIN:[1,99], ABS:[1,1], RAIZ:[1,1], PI:[0,0], ARRED:[1,2], SE:[3,3], E:[1,99], OU:[1,99], TABELA_K1:[1,1], TABELA_K2:[1,1]};

/* Arredondamento "meio para longe do zero", como o ARRED do Excel (1,935 com 2 casas dá 1,94) */
function formArredondar(valor, casas){
  const sinal = Math.sign(valor), absoluto = Math.abs(valor), texto = String(absoluto);
  if(texto.includes('e')) return sinal * Math.round(absoluto * 10 ** casas) / 10 ** casas;
  return sinal * Number(Math.round(Number(absoluto + 'e' + casas)) + 'e-' + casas);
}

/* ----- análise léxica ----- */
function formTokens(textoFormula){
  const tokens = [], tamanho = textoFormula.length; let posicao = 0;
  const ehDigito = caractere => caractere !== undefined && caractere >= '0' && caractere <= '9';
  const ehLetra = caractere => caractere !== undefined && /[A-Za-zÀ-ÖØ-öø-ÿ_]/.test(caractere);
  while(posicao < tamanho){
    const caractere = textoFormula[posicao];
    if(/\s/.test(caractere)){ posicao++; continue; }
    if(ehDigito(caractere) || (caractere === '.' && ehDigito(textoFormula[posicao + 1]))){
      let fim = posicao; while(ehDigito(textoFormula[fim])) fim++;
      if((textoFormula[fim] === '.' || textoFormula[fim] === ',') && ehDigito(textoFormula[fim + 1])){ fim++; while(ehDigito(textoFormula[fim])) fim++; }
      tokens.push({tipo: 'num', valor: Number(textoFormula.slice(posicao, fim).replace(',', '.'))}); posicao = fim; continue;
    }
    if(caractere === '"'){
      let fim = posicao + 1, conteudo = '';
      for(;;){
        if(fim >= tamanho) throw new FormulaError('texto sem aspas de fechamento');
        if(textoFormula[fim] === '"'){ if(textoFormula[fim + 1] === '"'){ conteudo += '"'; fim += 2; continue; } break; }
        conteudo += textoFormula[fim++];
      }
      tokens.push({tipo: 'str', valor: conteudo}); posicao = fim + 1; continue;
    }
    if(ehLetra(caractere)){
      let fim = posicao + 1; while(ehLetra(textoFormula[fim]) || ehDigito(textoFormula[fim])) fim++;
      tokens.push({tipo: 'id', valor: textoFormula.slice(posicao, fim)}); posicao = fim; continue;
    }
    const doisCaracteres = textoFormula.slice(posicao, posicao + 2);
    if(doisCaracteres === '<=' || doisCaracteres === '>=' || doisCaracteres === '<>'){ tokens.push({tipo: 'op', valor: doisCaracteres}); posicao += 2; continue; }
    if('+-*/^()=<>;'.includes(caractere)){ tokens.push({tipo: 'op', valor: caractere}); posicao++; continue; }
    if(caractere === ',') throw new FormulaError('vírgula fora de um número: separe os argumentos com ponto e vírgula (;)');
    throw new FormulaError(`caractere inesperado «${caractere}»`);
  }
  return tokens;
}

/* ----- análise sintática (precedência do Excel: comparação < + - < * / < ^ < sinal) ----- */
function formParse(textoFormula, permitidas){
  if(!String(textoFormula).trim()) throw new FormulaError('fórmula vazia');
  if(textoFormula.length > 400) throw new FormulaError('fórmula longa demais (máximo de 400 caracteres)');
  const tokens = formTokens(textoFormula); let posicao = 0;
  const peek = () => tokens[posicao], ehOperador = operador => tokens[posicao] && tokens[posicao].tipo === 'op' && tokens[posicao].valor === operador;
  const exigir = operador => { if(!ehOperador(operador)) throw new FormulaError(tokens[posicao] ? `esperado «${operador}» antes de «${tokens[posicao].valor}»` : `esperado «${operador}» no fim da fórmula`); posicao++; };
  function comparacao(){ let esquerda = adicao(); while(tokens[posicao] && tokens[posicao].tipo === 'op' && ['=','<>','<','>','<=','>='].includes(tokens[posicao].valor)){ const operador = tokens[posicao++].valor; esquerda = {tipo: 'bin', operador: operador, esquerda: esquerda, direita: adicao()}; } return esquerda; }
  function adicao(){ let esquerda = multiplicacao(); while(ehOperador('+') || ehOperador('-')){ const operador = tokens[posicao++].valor; esquerda = {tipo: 'bin', operador: operador, esquerda: esquerda, direita: multiplicacao()}; } return esquerda; }
  function multiplicacao(){ let esquerda = potencia(); while(ehOperador('*') || ehOperador('/')){ const operador = tokens[posicao++].valor; esquerda = {tipo: 'bin', operador: operador, esquerda: esquerda, direita: potencia()}; } return esquerda; }
  function potencia(){ let esquerda = sinal(); while(ehOperador('^')){ posicao++; esquerda = {tipo: 'bin', operador: '^', esquerda: esquerda, direita: sinal()}; } return esquerda; }
  function sinal(){ if(ehOperador('-')){ posicao++; return {tipo: 'neg', expressao: sinal()}; } if(ehOperador('+')){ posicao++; return sinal(); } return primario(); }
  function primario(){
    const token = peek();
    if(!token) throw new FormulaError('fórmula incompleta');
    if(token.tipo === 'num' || token.tipo === 'str'){ posicao++; return {tipo: token.tipo, valor: token.valor}; }
    if(token.tipo === 'id'){
      posicao++;
      if(ehOperador('(')){
        posicao++;
        const nomeCanonico = FORM_ALIAS[formNormalizar(token.valor)];
        if(!nomeCanonico) throw new FormulaError(`função desconhecida «${token.valor}»`);
        const argumentos = [];
        if(!ehOperador(')')){ argumentos.push(comparacao()); while(ehOperador(';')){ posicao++; argumentos.push(comparacao()); } }
        exigir(')');
        const [minimo, maximo] = FORM_ARITY[nomeCanonico];
        if(argumentos.length < minimo || argumentos.length > maximo) throw new FormulaError(`a função ${formNormalizar(token.valor)} espera ${minimo === maximo ? minimo : minimo + ' a ' + maximo} argumento(s), mas recebeu ${argumentos.length}`);
        return {tipo: 'call', nome: nomeCanonico, args: argumentos};
      }
      if(permitidas && !permitidas.has(formNormalizar(token.valor))) throw new FormulaError(`variável desconhecida «${token.valor}»`);
      return {tipo: 'var', nome: token.valor};
    }
    if(token.tipo === 'op' && token.valor === '('){ posicao++; const expressao = comparacao(); exigir(')'); return expressao; }
    throw new FormulaError(`«${token.valor}» inesperado`);
  }
  const ast = comparacao();
  if(posicao < tokens.length) throw new FormulaError(`«${tokens[posicao].valor}» inesperado`);
  return ast;
}

/* Compila as fórmulas na ordem de cálculo; cada uma só enxerga as entradas e as fórmulas anteriores */
function formCompileAll(formulas){
  const compiladas = {}, permitidas = new Set([...FORM_INPUTS, 'PI']);
  FORM_ORDER.forEach(chave => {
    const textoFormula = String(formulas && formulas[chave] != null ? formulas[chave] : FORM_DEFAULT[chave]);
    try { compiladas[chave] = {src: textoFormula, ast: formParse(textoFormula, permitidas)}; } catch(erro){ compiladas[chave] = {src: textoFormula, error: erro.message}; }
    const chaveAlta = chave.toUpperCase();
    permitidas.add(chaveAlta);
    if(FORM_META[chave] && FORM_META[chave].varName) permitidas.add(formNormalizar(FORM_META[chave].varName));
    Object.entries(FORM_VAR_ALIASES).forEach(([alias, target]) => {
      if(target === chaveAlta) permitidas.add(alias);
    });
  });
  return compiladas;
}

/* ----- avaliação ----- */
function formEval(ast, variaveis, contexto){
  const comoNumero = valor => { if(typeof valor !== 'number' || !Number.isFinite(valor)) throw new FormulaError('valor não numérico na operação'); return valor; };
  const avaliar = noDaArvore => {
    switch(noDaArvore.tipo){
      case 'num': case 'str': return noDaArvore.valor;
      case 'var': {
        const nomeNormalizado = formNormalizar(noDaArvore.nome);
        if(nomeNormalizado === 'PI') return Math.PI;
        const chaveReal = FORM_VAR_ALIASES[nomeNormalizado] || nomeNormalizado;
        let valorVariavel;
        if(nomeNormalizado in variaveis && variaveis[nomeNormalizado] !== undefined){
          valorVariavel = variaveis[nomeNormalizado];
        } else if(chaveReal in variaveis && variaveis[chaveReal] !== undefined){
          valorVariavel = variaveis[chaveReal];
        } else {
          // Busca em qualquer alias que aponte para a mesma chave canônica
          const aliasChave = Object.entries(FORM_VAR_ALIASES).find(([k, v]) => v === chaveReal && variaveis[k] !== undefined);
          if(aliasChave) valorVariavel = variaveis[aliasChave[0]];
          else throw new FormulaError(`variável desconhecida «${noDaArvore.nome}»`);
        }
        if(valorVariavel === null || valorVariavel === undefined) throw new MissingInput(noDaArvore.nome);
        if(contexto && contexto.trace) contexto.trace.push([noDaArvore.nome, valorVariavel]);
        return valorVariavel;
      }
      case 'neg': return -comoNumero(avaliar(noDaArvore.expressao));
      case 'bin': {
        const esquerda = avaliar(noDaArvore.esquerda), direita = avaliar(noDaArvore.direita);
        if(['=','<>','<','>','<=','>='].includes(noDaArvore.operador)){
          const mesmoTipo = (typeof esquerda === 'number' && typeof direita === 'number') || (typeof esquerda === 'string' && typeof direita === 'string');
          const esquerdaComparavel = typeof esquerda === 'string' ? esquerda.toLowerCase() : esquerda, direitaComparavel = typeof direita === 'string' ? direita.toLowerCase() : direita;
          if(noDaArvore.operador === '=') return mesmoTipo && esquerdaComparavel === direitaComparavel;
          if(noDaArvore.operador === '<>') return !(mesmoTipo && esquerdaComparavel === direitaComparavel);
          if(!mesmoTipo) throw new FormulaError('não é possível comparar texto com número');
          return noDaArvore.operador === '<' ? esquerdaComparavel < direitaComparavel : noDaArvore.operador === '>' ? esquerdaComparavel > direitaComparavel : noDaArvore.operador === '<=' ? esquerdaComparavel <= direitaComparavel : esquerdaComparavel >= direitaComparavel;
        }
        const operandoEsquerdo = comoNumero(esquerda), operandoDireito = comoNumero(direita);
        if(noDaArvore.operador === '/' && operandoDireito === 0) throw new FormulaError('divisão por zero');
        const resultadoOperacao = noDaArvore.operador === '+' ? operandoEsquerdo + operandoDireito : noDaArvore.operador === '-' ? operandoEsquerdo - operandoDireito : noDaArvore.operador === '*' ? operandoEsquerdo * operandoDireito : noDaArvore.operador === '/' ? operandoEsquerdo / operandoDireito : Math.pow(operandoEsquerdo, operandoDireito);
        if(!Number.isFinite(resultadoOperacao)) throw new FormulaError('resultado fora do intervalo numérico');
        return resultadoOperacao;
      }
      case 'call': {
        const funcao = noDaArvore.nome;
        if(funcao === 'SE'){ const condicao = avaliar(noDaArvore.args[0]); return avaliar((typeof condicao === 'boolean' ? condicao : comoNumero(condicao) !== 0) ? noDaArvore.args[1] : noDaArvore.args[2]); }
        const argumentosAvaliados = noDaArvore.args.map(avaliar), comoBooleano = valor => typeof valor === 'boolean' ? valor : comoNumero(valor) !== 0;
        switch(funcao){
          case 'MEDIA': return argumentosAvaliados.map(comoNumero).reduce((acumulado, valor) => acumulado + valor, 0) / argumentosAvaliados.length;
          case 'SOMA': return argumentosAvaliados.map(comoNumero).reduce((acumulado, valor) => acumulado + valor, 0);
          case 'MAX': return Math.max(...argumentosAvaliados.map(comoNumero));
          case 'MIN': return Math.min(...argumentosAvaliados.map(comoNumero));
          case 'ABS': return Math.abs(comoNumero(argumentosAvaliados[0]));
          case 'RAIZ': { const radicando = comoNumero(argumentosAvaliados[0]); if(radicando < 0) throw new FormulaError('raiz de número negativo'); return Math.sqrt(radicando); }
          case 'PI': return Math.PI;
          case 'ARRED': return formArredondar(comoNumero(argumentosAvaliados[0]), argumentosAvaliados.length > 1 ? comoNumero(argumentosAvaliados[1]) : 0);
          case 'E': return argumentosAvaliados.every(comoBooleano);
          case 'OU': return argumentosAvaliados.some(comoBooleano);
          case 'TABELA_K1': { const valorTabela = contexto.maps.k1.get(Math.round(comoNumero(argumentosAvaliados[0]) * 100)); if(valorTabela === undefined) throw new LookupError('K1', argumentosAvaliados[0]); if(contexto.trace) contexto.trace.push([`TABELA_K1(${String(argumentosAvaliados[0]).replace('.', ',')})`, valorTabela]); return valorTabela; }
          case 'TABELA_K2': { const valorTabela = contexto.maps.k2.get(Math.round(comoNumero(argumentosAvaliados[0]))); if(valorTabela === undefined) throw new LookupError('K2', argumentosAvaliados[0]); if(contexto.trace) contexto.trace.push([`TABELA_K2(${String(argumentosAvaliados[0]).replace('.', ',')})`, valorTabela]); return valorTabela; }
        }
      }
    }
    throw new FormulaError('expressão não suportada');
  };
  const resultado = avaliar(ast);
  if(typeof resultado !== 'number' || !Number.isFinite(resultado)) throw new FormulaError('o resultado não é um número');
  return resultado;
}

/* Prévia das fórmulas com um CP de exemplo (usada no editor de Configurações) */
function formPreview(formulas, mapas, exemplo){
  const compiladas = formCompileAll(formulas), variaveis = {...exemplo}, resultados = {};
  FORM_ORDER.forEach(chave => {
    const nomeVariavel = chave.toUpperCase(), compilada = compiladas[chave];
    const varNameDescritivo = FORM_META[chave] && FORM_META[chave].varName;
    if(compilada.error){
      resultados[chave] = {error: compilada.error};
      variaveis[nomeVariavel] = null;
      if(varNameDescritivo) variaveis[varNameDescritivo] = null;
      return;
    }
    try {
      const val = formEval(compilada.ast, variaveis, {maps: mapas});
      variaveis[nomeVariavel] = val;
      if(varNameDescritivo) variaveis[varNameDescritivo] = val;
      Object.entries(FORM_VAR_ALIASES).forEach(([alias, target]) => {
        if(target === nomeVariavel) variaveis[alias] = val;
      });
      resultados[chave] = {value: val};
    }
    catch(erro){
      variaveis[nomeVariavel] = null;
      if(varNameDescritivo) variaveis[varNameDescritivo] = null;
      resultados[chave] = {error: erro instanceof MissingInput ? `depende de «${erro.varName}», que não pôde ser calculada` : erro.message};
    }
  });
  return resultados;
}

if(typeof module === "object" && module.exports) module.exports = {FORM_DEFAULT, FORM_VAR_ALIASES, formPreview};
