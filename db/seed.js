/* Script de inicialização e seed do banco de dados (SQLite e PostgreSQL).
   Cria as tabelas caso não existam e popula com os dados iniciais do protótipo
   (cards de exemplo nas diferentes etapas do fluxo e configurações das fórmulas). */

const db = require('./database');
const { Card, CorpoDeProva, Configuracao, Log, syncAllModels } = require('./models');

const IDENT_PLACA_113 = {
  relNumero: '025.402', interessado: 'Engenharia & Obras Exemplo Ltda',
  emailCliente: 'engenharia@cliente-exemplo.com.br', central: 'Central Alpha',
  fck: 35, abatimento: '100 mm', cimentoMarca: 'Marca Exemplo', cimentoTipo: 'CP II-F 32',
  cimentoConsumo: 420, aditivo: 'Plastificante Exemplo', acelerador: 'Acelerador A',
  aceleradorConsumo: 18, agregados: 'Areia média e brita 0', maquina: 'Prensa Hidráulica 100 tf',
  dataProjecao: '2026-03-01', coletadoPor: 'Carlos Técnico', coletadoEm: '2026-03-04',
  elemento: 'Túnel 3 · Estaca 42', placa: '113', nf: 'NF-9841'
};

const DADOS_PLACA_113 = [
  [3, 144.86, 144.17, 144.70, 74.76, 74.75, 1.381, 11.88],
  [3, 144.60, 144.18, 144.33, 74.78, 74.78, 1.383, 12.35],
  [3, 144.20, 144.37, 144.50, 74.88, 74.89, 1.380, 12.44],
  [7, 144.80, 144.35, 144.23, 74.82, 74.83, 1.384, 15.10],
  [7, 144.60, 144.75, 144.40, 74.80, 74.79, 1.388, 14.85],
  [7, 144.30, 144.85, 144.57, 74.85, 74.86, 1.385, 15.30],
  [28, 144.70, 144.30, 144.55, 74.75, 74.77, 1.386, 17.80],
  [28, 144.85, 144.60, 144.45, 74.82, 74.80, 1.389, 18.10],
  [28, 144.50, 144.40, 144.60, 74.78, 74.79, 1.387, 17.95]
];

const FORMULAS_PADRAO = {
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

async function seedDatabase(forceReset = false) {
  await syncAllModels();

  if (forceReset) {
    await db.execScript(`
      DELETE FROM corpos_de_prova;
      DELETE FROM cards;
      DELETE FROM logs;
      DELETE FROM configuracoes;
    `);
  }

  // Verifica se já existem dados
  const totalCards = await Card.count();
  if (totalCards > 0 && !forceReset) {
    console.log(`[SEED] O banco de dados já possui ${totalCards} card(s). Nenhuma ação necessária.`);
    return;
  }

  console.log('[SEED] Populando banco de dados com dados iniciais...');

  // 1. Configuração inicial
  await Configuracao.create({
    id: 1,
    rev: 1,
    active: 'planilha',
    sets: [{ id: 'planilha', name: 'Planilha atual', builtin: true }],
    formulas: FORMULAS_PADRAO,
    history: [{ t: new Date().toISOString(), rev: 1, note: 'Conjunto inicial: valores da planilha atual (K1 e k2).', changes: null }]
  });

  // Função auxiliar para inserir CPs de um card
  async function insertCps(cardId, rowsData) {
    for (let idx = 0; idx < rowsData.length; idx++) {
      const row = rowsData[idx];
      const hasVal = row.slice(1).some(v => v !== null && v !== undefined && v !== '');
      await CorpoDeProva.create({
        card_id: cardId,
        cp_index: idx,
        idade: row[0],
        h1: row[1], h2: row[2], h3: row[3],
        d1: row[4], d2: row[5],
        massa: row[6],
        carga: row[7],
        sentido: hasVal ? 'Mesmo do lançamento' : '',
        cura: hasVal ? 'Úmida' : ''
      });
    }
  }

  // Função auxiliar para criar dados de card
  async function createCardData(id, stage, cliente, placa, rowsData, extra = {}) {
    const ident = {
      ...IDENT_PLACA_113,
      interessado: cliente,
      placa: String(placa),
      relNumero: `025.${placa}`
    };

    await Card.create({
      id,
      stage,
      placa: String(placa),
      interessado: cliente,
      email_cliente: ident.emailCliente,
      central: ident.central,
      fck: ident.fck,
      data_projecao: ident.dataProjecao,
      criterio: 'media',
      coef_a: 1.0024,
      coef_b: 0.0299,
      ident,
      notified: extra.notified || {},
      adjust: extra.adjust || {},
      cfg_snap: extra.cfg_snap || null,
      final_sent: extra.final_sent || null
    });

    await insertCps(id, rowsData);

    await Log.create({
      card_id: id,
      mensagem: `Card ${id} criado na etapa «${stage}»`,
      data_hora: new Date().toISOString()
    });
  }

  // Variações dos dados da placa 113
  const cpsPlaca113 = DADOS_PLACA_113;

  // RT-113: Aguardando idades (só 3 dias preenchidos, notificados)
  const rows113 = cpsPlaca113.map((r, i) => i < 3 ? [...r] : [r[0], null, null, null, null, null, null, null]);
  await createCardData('RT-113', 'aguardando', 'Engenharia & Obras Exemplo Ltda', 113, rows113, {
    notified: { 3: { t: '2026-03-04T14:30:00Z', res: { media: 28.88, limit: 17.5, pass: true } } }
  });

  // RT-114: Ajuste (abaixo do mínimo aos 3 dias)
  const rows114 = cpsPlaca113.map((r, i) => {
    const copy = [...r];
    if (i < 3) copy[7] = 6.8; // carga reduzida para simular falha
    else copy.fill(null, 1);
    return copy;
  });
  await createCardData('RT-114', 'ajuste', 'Cliente Exemplo B (em ajuste)', 114, rows114);

  // RT-115: Análise (com divergência > 10% nas alturas)
  const rows115 = cpsPlaca113.map((r, i) => {
    const copy = [...r];
    if (i === 0) copy[1] = 165.0; // divergência
    if (i >= 3) copy.fill(null, 1);
    return copy;
  });
  await createCardData('RT-115', 'analise', 'Cliente Exemplo C (com divergência)', 115, rows115);

  // RT-116: Entrada (em branco para digitação/importação)
  const rows116 = cpsPlaca113.map(r => [r[0], null, null, null, null, null, null, null]);
  await createCardData('RT-116', 'entrada', 'Cliente Exemplo D (novo lote)', 116, rows116);

  // RT-117: Análise de IA (3 dias calculados e com parecer emitido antes da notificação)
  const rows117 = cpsPlaca113.map((r, i) => i < 3 ? [...r] : [r[0], null, null, null, null, null, null, null]);
  await createCardData('RT-117', 'ia', 'Cliente Exemplo E (parecer emitido pela IA)', 117, rows117, {
    ai_analysis: {
      verdict: 'conforme',
      summary: 'Resistência de 3 dias atingiu média de 28.88 MPa (82,5% do fck 35 MPa, acima dos 50% normativos). Amostras homogêneas e aptas para notificação.',
      content: `### 1. Resumo Executivo e Veredito Geral\n**Veredito: [CONFORME]**\nOs corpos de prova ensaiados aos 3 dias atingiram resistência média corrigida de **28,88 MPa**, superando com folga o limite mínimo normativo de 50% do fck (17,50 MPa para fck 35 MPa). O ganho de resistência inicial foi excelente (82,5% do fck em apenas 3 dias), indicando eficácia da dosagem de acelerador de pega e cimento CP II-F 32.\n\n### 2. Avaliação de Resistências à Compressão vs Limites de Projeto\n- **Idade de 3 dias (3 CPs):** Cargas entre 11,88 e 12,44 tf, gerando fci,ext médio de 28,88 MPa (mínimo exigido: 17,50 MPa). Status: **APROVADO**.\n- **Idades de 7 e 28 dias:** Em processo de cura úmida conforme ABNT NBR 13070. Previsão de atendimento pleno do fck de 35 MPa aos 28 dias.\n\n### 3. Análise de Consistência Dimensional e Amostragem\n- Relação h/d média de 1,93 com dispersão de alturas e diâmetros inferior a 1,5%, muito abaixo da tolerância máxima de 10%.\n- Fatores de correção k1, k2, k3 e k4 calculados com exatidão conforme as tabelas vigentes.\n\n### 4. Sugestão de Texto para a Notificação ao Cliente\n"Prezados, temos a satisfação de informar os resultados de 3 dias da Placa 117. A resistência obtida atingiu 28,88 MPa, superando a meta de 17,50 MPa. O lote apresenta excelente evolução e segue em acompanhamento para a idade de 7 dias."`,
      model: 'openrouter/free',
      generatedAt: new Date(Date.now() - 864e5).toISOString()
    }
  });

  // RT-119: Notificar cliente (pronto para envio após aprovação de IA)
  const rows119 = cpsPlaca113.map((r, i) => i < 3 ? [...r] : [r[0], null, null, null, null, null, null, null]);
  await createCardData('RT-119', 'notificar', 'Cliente Exemplo H (pronto p/ notificação)', 119, rows119);

  // RT-118: Relatório final (3, 7 e 28 dias notificados)
  await createCardData('RT-118', 'relatorio', 'Cliente Exemplo F (concluído)', 118, cpsPlaca113, {
    notified: {
      3: { t: '2026-03-04T10:00:00Z', res: { media: 28.88, limit: 17.5, pass: true } },
      7: { t: '2026-03-08T10:00:00Z', res: { media: 35.12, limit: 26.25, pass: true } },
      28: { t: '2026-03-29T10:00:00Z', res: { media: 42.05, limit: 35.0, pass: true } }
    }
  });

  // RT-110: Finalizado
  await createCardData('RT-110', 'finalizado', 'Cliente Exemplo G (arquivado)', 110, cpsPlaca113, {
    notified: {
      3: { t: '2026-03-04T10:00:00Z', res: { media: 28.88, limit: 17.5, pass: true } },
      7: { t: '2026-03-08T10:00:00Z', res: { media: 35.12, limit: 26.25, pass: true } },
      28: { t: '2026-03-29T10:00:00Z', res: { media: 42.05, limit: 35.0, pass: true } }
    },
    final_sent: '2026-03-29T16:00:00Z'
  });

  console.log('[SEED] Sucesso! Banco de dados inicializado e populado.');
}

if (require.main === module) {
  seedDatabase(true).then(() => db.closeDb()).catch(err => { console.error(err); process.exit(1); });
}

module.exports = {
  seedDatabase
};
