/* Camada de conexão com o Banco de Dados.
   Suporta modo duplo:
   1. PostgreSQL via 'pg' (ativado automaticamente no Railway via DATABASE_URL ou PGHOST)
   2. SQLite via 'node:sqlite' nativo (usado em ambiente de desenvolvimento local e testes) */

const { AsyncLocalStorage } = require('node:async_hooks');
const path = require('node:path');
const fs = require('node:fs');

// Verifica se deve utilizar PostgreSQL (Railway, DATABASE_URL, PGHOST ou DB_CLIENT)
const isPostgres = Boolean(
  process.env.DATABASE_URL ||
  process.env.DATABASE_PUBLIC_URL ||
  process.env.PGHOST ||
  process.env.DB_CLIENT === 'postgres'
);

const DB_PATH = process.env.DATABASE_PATH || path.join(__dirname, '..', 'database.sqlite');

let sqliteInstance = null;
let pgPool = null;
const txStorage = new AsyncLocalStorage();

function getPoolConfig() {
  const connectionString = process.env.DATABASE_URL || process.env.DATABASE_PUBLIC_URL;
  if (connectionString) {
    const config = { connectionString };
    const needsSsl = process.env.PGSSLMODE === 'require' ||
      process.env.PGSSLMODE === 'no-verify' ||
      connectionString.includes('railway') ||
      connectionString.includes('sslmode=require') ||
      process.env.NODE_ENV === 'production';

    if (process.env.PGSSLMODE !== 'disable' && needsSsl) {
      config.ssl = { rejectUnauthorized: false };
    }
    return config;
  }

  const config = {
    host: process.env.PGHOST || 'localhost',
    port: Number(process.env.PGPORT) || 5432,
    user: process.env.PGUSER || 'postgres',
    password: process.env.PGPASSWORD || '',
    database: process.env.PGDATABASE || 'railway'
  };

  if (process.env.PGSSL === 'true' || process.env.PGSSLMODE === 'require') {
    config.ssl = { rejectUnauthorized: false };
  }

  return config;
}

function getPgPool() {
  if (!pgPool) {
    const { Pool } = require('pg');
    pgPool = new Pool(getPoolConfig());
    pgPool.on('error', (err) => {
      console.error('[PostgreSQL] Erro inesperado no pool:', err.message);
    });
  }
  return pgPool;
}

function getSqliteDb() {
  if (!sqliteInstance) {
    const { DatabaseSync } = require('node:sqlite');
    sqliteInstance = new DatabaseSync(DB_PATH);
    sqliteInstance.exec('PRAGMA foreign_keys = ON;');
    sqliteInstance.exec('PRAGMA journal_mode = WAL;');
  }
  return sqliteInstance;
}

function getDb() {
  if (isPostgres) return getPgPool();
  return getSqliteDb();
}

function convertPlaceholders(sql) {
  let paramIdx = 1;
  let inQuote = false;
  let result = '';
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i];
    if (ch === "'" && (i === 0 || sql[i - 1] !== '\\')) {
      inQuote = !inQuote;
      result += ch;
    } else if (ch === '?' && !inQuote) {
      result += `$${paramIdx++}`;
    } else {
      result += ch;
    }
  }
  return result;
}

function getDbInfo() {
  if (!isPostgres) return DB_PATH;
  const connectionString = process.env.DATABASE_URL || process.env.DATABASE_PUBLIC_URL;
  if (connectionString) {
    try {
      const parsed = new URL(connectionString);
      return `PostgreSQL (${parsed.username}@${parsed.host}${parsed.pathname})`;
    } catch (_) {
      return 'PostgreSQL (URL configurada)';
    }
  }
  return `PostgreSQL (${process.env.PGUSER || 'postgres'}@${process.env.PGHOST || 'localhost'}:${process.env.PGPORT || 5432}/${process.env.PGDATABASE || 'railway'})`;
}

/**
 * Executa uma consulta SQL retornando todas as linhas
 */
async function query(sql, params = []) {
  if (isPostgres) {
    const client = txStorage.getStore() || getPgPool();
    const pgSql = convertPlaceholders(sql);
    const res = await client.query(pgSql, params);
    return res.rows;
  }
  const db = getSqliteDb();
  const stmt = db.prepare(sql);
  return stmt.all(...params);
}

/**
 * Executa uma consulta SQL retornando a primeira linha
 */
async function queryOne(sql, params = []) {
  const rows = await query(sql, params);
  return rows.length > 0 ? rows[0] : null;
}

/**
 * Executa um comando SQL (INSERT, UPDATE, DELETE) retornando metadados da execução
 */
async function execute(sql, params = []) {
  if (isPostgres) {
    const client = txStorage.getStore() || getPgPool();
    const pgSql = convertPlaceholders(sql);
    const res = await client.query(pgSql, params);
    return {
      changes: res.rowCount || 0,
      rows: res.rows || [],
      lastInsertRowid: res.rows?.[0]?.id
    };
  }
  const db = getSqliteDb();
  const stmt = db.prepare(sql);
  const result = stmt.run(...params);
  return {
    changes: result.changes,
    lastInsertRowid: result.lastInsertRowid,
    rows: []
  };
}

/**
 * Executa um script SQL contendo múltiplos comandos separados por ponto e vírgula
 */
async function execScript(sql) {
  if (isPostgres) {
    const client = txStorage.getStore() || getPgPool();
    return await client.query(sql);
  }
  const db = getSqliteDb();
  return db.exec(sql);
}

/**
 * Executa uma função dentro de uma transação atômica
 */
async function transaction(fn) {
  if (isPostgres) {
    const pool = getPgPool();
    const client = await pool.connect();
    try {
      await client.query('BEGIN;');
      const result = await txStorage.run(client, () => fn(client));
      await client.query('COMMIT;');
      return result;
    } catch (err) {
      await client.query('ROLLBACK;');
      throw err;
    } finally {
      client.release();
    }
  }

  const db = getSqliteDb();
  db.exec('BEGIN TRANSACTION;');
  try {
    const result = await fn(db);
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
async function closeDb() {
  if (pgPool) {
    try { await pgPool.end(); } catch (_) {}
    pgPool = null;
  }
  if (sqliteInstance) {
    try { sqliteInstance.close(); } catch (_) {}
    sqliteInstance = null;
  }
}

module.exports = {
  DB_PATH,
  isPostgres,
  getDbInfo,
  getDb,
  query,
  queryOne,
  execute,
  execScript,
  transaction,
  closeDb
};
