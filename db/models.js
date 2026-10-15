/* Definição de Modelos ORM para o sistema de relatórios de concreto.
   Cada classe estende 'Model' e declara sua tabela, schema, campos e relacionamentos.
   Pronto para SQLite e PostgreSQL (Railway). */

const { Model } = require('./orm');

/**
 * Modelo para os Cards de Relatório (uma placa ou lote ensaiado)
 */
class Card extends Model {
  static tableName = 'cards';
  static primaryKey = 'id';
  static schema = {
    id:            { type: 'string', primaryKey: true },
    stage:         { type: 'string', notNull: true, default: 'entrada' },
    placa:         { type: 'string', default: '' },
    interessado:   { type: 'string', default: '' },
    email_cliente: { type: 'string', default: '' },
    central:       { type: 'string', default: '' },
    fck:           { type: 'number', default: 35 },
    data_projecao: { type: 'string', default: '' },
    criterio:      { type: 'string', default: 'media' },
    coef_a:        { type: 'number', default: 1.0024 },
    coef_b:        { type: 'number', default: 0.0299 },
    ident:         { type: 'json',   default: {} },
    notified:      { type: 'json',   default: {} },
    notification_history: { type: 'json', default: [] },
    adjust:        { type: 'json',   default: {} },
    decision_analysis: { type: 'json', default: null },
    ai_analysis:   { type: 'json',   default: null },
    email_drafts:  { type: 'json',   default: {} },
    cfg_snap:      { type: 'json',   default: null },
    final_sent:    { type: 'string', default: null },
    created_at:    { type: 'date' },
    updated_at:    { type: 'date' }
  };

  /**
   * Retorna o Card completo com a lista de Corpos de Prova (CPs) associados
   */
  static async findWithCps(cardId) {
    const card = await this.findById(cardId);
    if (!card) return null;
    const cps = await CorpoDeProva.findMany({ card_id: cardId }, { orderBy: 'cp_index ASC' });
    return { ...card, cps };
  }

  /**
   * Retorna todos os Cards completos com seus CPs
   */
  static async allWithCps(options = {}) {
    const cards = await this.all(options);
    const allCps = await CorpoDeProva.all({ orderBy: 'card_id ASC, cp_index ASC' });
    const cpsByCard = {};
    for (const cp of allCps) {
      if (!cpsByCard[cp.card_id]) cpsByCard[cp.card_id] = [];
      cpsByCard[cp.card_id].push(cp);
    }
    return cards.map(c => ({
      ...c,
      cps: cpsByCard[c.id] || []
    }));
  }
}

/**
 * Modelo para as medições dos Corpos de Prova (CPs) de cada Card
 */
class CorpoDeProva extends Model {
  static tableName = 'corpos_de_prova';
  static primaryKey = 'id';
  static schema = {
    id:         { type: 'integer', primaryKey: true, autoIncrement: true },
    card_id:    { type: 'string', notNull: true },
    cp_index:   { type: 'integer', notNull: true },
    idade:      { type: 'integer', default: 3 },
    h1:         { type: 'number', default: null },
    h2:         { type: 'number', default: null },
    h3:         { type: 'number', default: null },
    d1:         { type: 'number', default: null },
    d2:         { type: 'number', default: null },
    massa:      { type: 'number', default: null },
    carga:      { type: 'number', default: null },
    sentido:    { type: 'string', default: 'Mesmo do lançamento' },
    cura:       { type: 'string', default: 'Úmida' },
    created_at: { type: 'date' },
    updated_at: { type: 'date' }
  };
}

/**
 * Modelo para as Configurações de Tabelas (K1, K2), Fórmulas e Histórico de Revisões
 */
class Configuracao extends Model {
  static tableName = 'configuracoes';
  static primaryKey = 'id';
  static schema = {
    id:         { type: 'integer', primaryKey: true, default: 1 },
    rev:        { type: 'integer', default: 1 },
    active:     { type: 'string',  default: 'planilha' },
    sets:       { type: 'json',    default: [] },
    formulas:   { type: 'json',    default: {} },
    history:    { type: 'json',    default: [] },
    decision:   { type: 'json', default: null },
    ai:         { type: 'json',    default: null },
    updated_at: { type: 'date' }
  };
}

/**
 * Modelo para o Histórico de Auditoria e Logs de Eventos
 */
class Log extends Model {
  static tableName = 'logs';
  static primaryKey = 'id';
  static schema = {
    id:        { type: 'integer', primaryKey: true, autoIncrement: true },
    card_id:   { type: 'string', default: null },
    mensagem:  { type: 'string', notNull: true },
    data_hora: { type: 'string', notNull: true }
  };
}

/**
 * Modelo para Tokens de Autenticação (OTP de 6 dígitos e Magic Link)
 */
class AuthToken extends Model {
  static tableName = 'auth_tokens';
  static primaryKey = 'id';
  static schema = {
    id:         { type: 'integer', primaryKey: true, autoIncrement: true },
    email:      { type: 'string', notNull: true },
    otp:        { type: 'string', notNull: true },
    token:      { type: 'string', notNull: true },
    expires_at: { type: 'string', notNull: true },
    used:       { type: 'boolean', default: false },
    created_at: { type: 'date' }
  };
}

/**
 * Modelo para Sessões Ativas dos Usuários
 */
class Session extends Model {
  static tableName = 'sessions';
  static primaryKey = 'id';
  static schema = {
    id:         { type: 'string', primaryKey: true },
    email:      { type: 'string', notNull: true },
    expires_at: { type: 'string', notNull: true },
    created_at: { type: 'date' }
  };
}

/**
 * Sincroniza todas as tabelas de todos os modelos
 */
async function syncAllModels() {
  await Card.sync();
  await CorpoDeProva.sync();
  await Configuracao.sync();
  await Log.sync();
  await AuthToken.sync();
  await Session.sync();
}

module.exports = {
  Card,
  CorpoDeProva,
  Configuracao,
  Log,
  AuthToken,
  Session,
  syncAllModels
};
