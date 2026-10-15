/* Camada de conexão com o Banco de Dados.
   Utiliza o driver nativo 'node:sqlite' do Node.js (sem dependências externas compiladas).
   Projetado para facilitar a migração futura para PostgreSQL, MySQL ou outro SGBD
   apenas alterando este adaptador. */

const { DatabaseSync } = require('node:sqlite');
const path = require('node:path');
const fs = require('node:fs');

const DB_PATH = process.env.DATABASE_PATH || path.join(__dirname, '..', 'database.sqlite');

let dbInstance = null;

function getDb() {
  if (!dbInstance) {
    dbInstance = new DatabaseSync(DB_PATH);
    // Ativa suporte a chaves estrangeiras e performance WAL
    dbInstance.exec('PRAGMA foreign_keys = ON;');
    dbInstance.exec('PRAGMA journal_mode = WAL;');
  }
  return dbInstance;
}

/**
 * Executa uma consulta SQL retornando todas as linhas
 */
function query(sql, params = []) {
  const db = getDb();
  const stmt = db.prepare(sql);
  return stmt.all(...params);
}

/**
 * Executa uma consulta SQL retornando a primeira linha
 */
function queryOne(sql, params = []) {
  const rows = query(sql, params);
  return rows.length > 0 ? rows[0] : null;
}

/**
 * Executa um comando SQL (INSERT, UPDATE, DELETE) retornando metadados da execução
 */
function execute(sql, params = []) {
  const db = getDb();
  const stmt = db.prepare(sql);
  return stmt.run(...params);
}

/**
 * Executa um script SQL contendo múltiplos comandos separados por ponto e vírgula
 */
function execScript(sql) {
  const db = getDb();
  return db.exec(sql);
}

/**
 * Executa uma função dentro de uma transação atômica
 */
function transaction(fn) {
  const db = getDb();
  db.exec('BEGIN TRANSACTION;');
  try {
    const result = fn(db);
    db.exec('COMMIT;');
    return result;
  } catch (err) {
    db.exec('ROLLBACK;');
    throw err;
  }
}

/**
 * Fecha a conexão com o banco
 */
function closeDb() {
  if (dbInstance) {
    try { dbInstance.close(); } catch (_) {}
    dbInstance = null;
  }
}

module.exports = {
  DB_PATH,
  getDb,
  query,
  queryOne,
  execute,
  execScript,
  transaction,
  closeDb
};
