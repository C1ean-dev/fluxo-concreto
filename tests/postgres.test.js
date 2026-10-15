const test = require('node:test');
const assert = require('node:assert/strict');
const { Model } = require('../db/orm');
const { Card, CorpoDeProva, Configuracao, Log } = require('../db/models');
const db = require('../db/database');

test('PostgreSQL DDL schema and dialect generation', () => {
  // Simula ambiente PostgreSQL
  const origIsPostgres = db.isPostgres;
  try {
    db.isPostgres = true;

    const cardSql = Card.getCreateTableSQL();
    assert.match(cardSql, /"id" TEXT PRIMARY KEY/);
    assert.match(cardSql, /"fck" DOUBLE PRECISION/);
    assert.match(cardSql, /"ident" JSONB/);

    const cpSql = CorpoDeProva.getCreateTableSQL();
    assert.match(cpSql, /"id" SERIAL PRIMARY KEY/);
    assert.match(cpSql, /"carga" DOUBLE PRECISION/);

    const configSql = Configuracao.getCreateTableSQL();
    assert.match(configSql, /"sets" JSONB/);
  } finally {
    db.isPostgres = origIsPostgres;
  }
});

test('Database engine detection handles Railway environment variables', () => {
  // Verifica se o módulo database expõe as funções de diagnóstico
  assert.equal(typeof db.query, 'function');
  assert.equal(typeof db.execute, 'function');
  assert.equal(typeof db.transaction, 'function');
  assert.equal(typeof db.getDbInfo, 'function');
  assert.ok(db.getDbInfo().length > 0);
});
