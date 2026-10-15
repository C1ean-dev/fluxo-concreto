/* ===== Leitura da planilha modelo (abas "Relatório" e "Plan1") ===== */
function parseWorkbook(workbook){
  const normalizar = texto => String(texto).normalize('NFD').replace(/[̀-ͯ]/g, '').trim().toLowerCase();
  const acharAba = nome => workbook.SheetNames.find(nomeAba => normalizar(nomeAba) === normalizar(nome));
  const nomeAbaRelatorio = acharAba('Relatório'), nomeAbaPlan1 = acharAba('Plan1');
  const warnings = [];
  if(!nomeAbaPlan1) throw new Error('A aba "Plan1" não foi encontrada. Use a planilha modelo de concreto projetado (abas Relatório, Plan1, K1 e k2).');
  const abaPlan1 = workbook.Sheets[nomeAbaPlan1], abaRelatorio = nomeAbaRelatorio ? workbook.Sheets[nomeAbaRelatorio] : null;
  if(!abaRelatorio) warnings.push('Aba "Relatório" não encontrada: identificação e idades dos CPs não foram lidas.');
  const valorDaCelula = (aba, endereco) => { const celula = aba && aba[endereco]; return celula ? celula.v : undefined; };
  const textoDaCelula = (aba, endereco) => { const valor = valorDaCelula(aba, endereco); return valor === undefined || valor === null ? '' : String(valor).replace(/\s+/g, ' ').trim(); };
  const numeroDe = valor => { if(valor === undefined || valor === null || valor === '') return ''; if(typeof valor === 'number') return valor; const semSeparadorDeMilhar = Number(String(valor).replace(/\./g, '').replace(',', '.')); const comVirgulaDecimal = Number(String(valor).replace(',', '.')); return Number.isFinite(comVirgulaDecimal) ? comVirgulaDecimal : (Number.isFinite(semSeparadorDeMilhar) ? semSeparadorDeMilhar : ''); };
  const paraDataIso = valor => {
    if(valor === undefined || valor === null || valor === '') return '';
    if(typeof valor === 'number'){ const data = new Date(Date.UTC(1899, 11, 30) + Math.round(valor) * 864e5); return data.toISOString().slice(0, 10); }
    if(valor instanceof Date) return valor.toISOString().slice(0, 10);
    const partes = String(valor).match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
    return partes ? `${partes[3]}-${partes[2].padStart(2, '0')}-${partes[1].padStart(2, '0')}` : '';
  };
  if(abaRelatorio && !/IDENTIFICA/i.test(textoDaCelula(abaRelatorio, 'J24'))) warnings.push('O layout da aba "Relatório" difere do modelo; confira a identificação lida.');
  if(normalizar(textoDaCelula(abaPlan1, 'D6')) !== 'cp') warnings.push('O cabeçalho da aba "Plan1" difere do modelo; confira os CPs lidos.');

  // Identificação (campos amarelos da aba Relatório)
  let relNumero = '';
  if(abaRelatorio){
    const tituloDoRelatorio = textoDaCelula(abaRelatorio, 'B7');
    const trechoNumero = tituloDoRelatorio.match(/N[º°o]\s*(.+?)\s*-\s*RELAT[ÓO]RIO COMPLEMENTAR/i) || tituloDoRelatorio.match(/N[º°o]\s*(.+)$/i);
    relNumero = trechoNumero ? trechoNumero[1].trim() : '';
  }
  const ident = abaRelatorio ? {
    relNumero, interessado: textoDaCelula(abaRelatorio, 'P14'), central: textoDaCelula(abaRelatorio, 'M26'), fck: numeroDe(valorDaCelula(abaRelatorio, 'Z26')), abatimento: textoDaCelula(abaRelatorio, 'AF26'),
    cimentoMarca: textoDaCelula(abaRelatorio, 'P28'), cimentoTipo: textoDaCelula(abaRelatorio, 'Y28'), cimentoConsumo: numeroDe(valorDaCelula(abaRelatorio, 'AI28')),
    aditivo: textoDaCelula(abaRelatorio, 'N29'), acelerador: textoDaCelula(abaRelatorio, 'Z29'), aceleradorConsumo: numeroDe(valorDaCelula(abaRelatorio, 'AI29')), agregados: textoDaCelula(abaRelatorio, 'N30'),
    maquina: textoDaCelula(abaRelatorio, 'AE30'), dataProjecao: paraDataIso(valorDaCelula(abaRelatorio, 'P31')), coletadoPor: textoDaCelula(abaRelatorio, 'Y31'), coletadoEm: textoDaCelula(abaRelatorio, 'AE31'),
    elemento: textoDaCelula(abaRelatorio, 'P32'), placa: textoDaCelula(abaRelatorio, 'L33'), nf: textoDaCelula(abaRelatorio, 'S33')
  } : {};

  // Idade de cada CP: aba Relatório, colunas H (CP) e M ("3 Dias"). A primeira ocorrência de cada CP vale
  // (as linhas duplicadas e ocultas da planilha original são ignoradas).
  const ageOf = {};
  if(abaRelatorio){
    for(let linha = 46; linha <= 140; linha++){
      const numeroCp = numeroDe(valorDaCelula(abaRelatorio, 'H' + linha)), trechoIdade = textoDaCelula(abaRelatorio, 'M' + linha).match(/(\d+)\s*dias?/i);
      if(typeof numeroCp === 'number' && trechoIdade && ageOf[numeroCp] === undefined) ageOf[numeroCp] = Number(trechoIdade[1]);
    }
  }

  // Dados dos CPs (aba Plan1, a partir da linha 7)
  const cps = [];
  const sentidoNorm = texto => /ortogonal/i.test(texto) ? 'Ortogonal' : (/mesmo/i.test(texto) ? 'Mesmo do lançamento' : '');
  const curaNorm = texto => /ao\s*ar/i.test(texto) ? 'Ao ar' : (/[úu]mida/i.test(texto) ? 'Úmida' : '');
  for(let linha = 7; linha <= 60; linha++){
    const numeroCp = numeroDe(valorDaCelula(abaPlan1, 'D' + linha));
    const alturas = ['G', 'H', 'I'].map(coluna => numeroDe(valorDaCelula(abaPlan1, coluna + linha))), diametros = ['J', 'K'].map(coluna => numeroDe(valorDaCelula(abaPlan1, coluna + linha)));
    const massa = numeroDe(valorDaCelula(abaPlan1, 'L' + linha)), carga = numeroDe(valorDaCelula(abaPlan1, 'N' + linha));
    if(![...alturas, ...diametros, massa, carga].some(valor => valor !== '')) continue;
    const idade = ageOf[numeroCp] ?? '';
    if(idade === '') warnings.push(`CP ${numeroCp}: idade não encontrada na aba Relatório (preencher na Plan1).`);
    cps.push({ n: typeof numeroCp === 'number' ? numeroCp : cps.length + 1, idade, dataEnsaio: paraDataIso(valorDaCelula(abaPlan1, 'E' + linha)), h: alturas, d: diametros, massa, carga,
      sentido: sentidoNorm(textoDaCelula(abaPlan1, 'P' + linha)), cura: curaNorm(textoDaCelula(abaPlan1, 'Q' + linha)) });
  }
  if(!cps.length) throw new Error('Nenhum CP com dados foi encontrado na aba "Plan1" (a leitura começa na linha 7).');
  const coeficienteAngular = numeroDe(valorDaCelula(abaPlan1, 'Z3')), coeficienteLinear = numeroDe(valorDaCelula(abaPlan1, 'Z4'));
  return { ident, cps, coefA: coeficienteAngular === '' ? 1.0024 : coeficienteAngular, coefB: coeficienteLinear === '' ? 0.0299 : coeficienteLinear, warnings };
}
