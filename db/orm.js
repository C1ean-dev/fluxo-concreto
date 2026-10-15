/* ORM Simples e Portável para Node.js + SQLite.
   Inspirado nos padrões ActiveRecord / DataMapper (estilo Prisma/Sequelize/Drizzle).
   Fornece mapeamento objeto-relacional com schemas tipados, serialização automática
   de campos JSON, e operações CRUD padronizadas para facilitar a migração
   futura para PostgreSQL ou MySQL sem refatorar o restante do código. */

const db = require('./database');

class Model {
  static tableName = '';
  static primaryKey = 'id';
  static schema = {};

  /**
   * Converte a definição de schema em comando SQL DDL (CREATE TABLE)
   */
  static getCreateTableSQL() {
    const cols = [];
    const pkFields = [];

    for (const [colName, def] of Object.entries(this.schema)) {
      let colDef = `"${colName}" `;

      // Mapeamento de tipos portáveis
      switch (def.type) {
        case 'integer':
        case 'boolean':
          colDef += 'INTEGER';
          break;
        case 'real':
        case 'float':
        case 'number':
          colDef += 'REAL';
          break;
        case 'text':
        case 'string':
        case 'json':
        case 'date':
          colDef += 'TEXT';
          break;
        default:
          colDef += 'TEXT';
      }

      if (def.primaryKey) {
        colDef += ' PRIMARY KEY';
        if (def.autoIncrement) colDef += ' AUTOINCREMENT';
      }

      if (def.notNull && !def.primaryKey) {
        colDef += ' NOT NULL';
      }

      if (def.default !== undefined) {
        if (typeof def.default === 'string') {
          colDef += ` DEFAULT '${def.default.replace(/'/g, "''")}'`;
        } else if (typeof def.default === 'number') {
          colDef += ` DEFAULT ${def.default}`;
        } else if (typeof def.default === 'boolean') {
          colDef += ` DEFAULT ${def.default ? 1 : 0}`;
        }
      }

      cols.push(colDef);
    }

    return `CREATE TABLE IF NOT EXISTS "${this.tableName}" (\n  ${cols.join(',\n  ')}\n);`;
  }

  /**
   * Cria a tabela no banco de dados se ela ainda não existir
   */
  static sync() {
    const sql = this.getCreateTableSQL();
    db.execScript(sql);

    // Auto-migração: adiciona colunas do schema que ainda não existam no SQLite
    try {
      const existingCols = db.query(`PRAGMA table_info("${this.tableName}");`).map(c => c.name);
      for (const [colName, def] of Object.entries(this.schema)) {
        if (!existingCols.includes(colName)) {
          let colType = 'TEXT';
          if (def.type === 'integer' || def.type === 'boolean') colType = 'INTEGER';
          else if (['real', 'float', 'number'].includes(def.type)) colType = 'REAL';
          db.execute(`ALTER TABLE "${this.tableName}" ADD COLUMN "${colName}" ${colType};`);
        }
      }
    } catch (e) {
      console.warn(`[ORM] Aviso ao sincronizar colunas de ${this.tableName}:`, e.message);
    }

    return true;
  }

  /**
   * Serializa os dados antes de gravar no banco (ex.: converte objetos/arrays em JSON string)
   */
  static _serialize(data) {
    const row = {};
    for (const [key, value] of Object.entries(data)) {
      const def = this.schema[key];
      if (!def) continue;

      if (value === null || value === undefined) {
        row[key] = null;
      } else if (def.type === 'json') {
        row[key] = typeof value === 'string' ? value : JSON.stringify(value);
      } else if (def.type === 'boolean') {
        row[key] = value ? 1 : 0;
      } else {
        row[key] = value;
      }
    }
    return row;
  }

  /**
   * Deserializa os dados lidos do banco (ex.: converte strings JSON em objetos JavaScript)
   */
  static _deserialize(row) {
    if (!row) return null;
    const item = { ...row };
    for (const [key, def] of Object.entries(this.schema)) {
      if (item[key] === null || item[key] === undefined) continue;

      if (def.type === 'json') {
        try {
          item[key] = typeof item[key] === 'string' ? JSON.parse(item[key]) : item[key];
        } catch (_) {
          // mantém string caso não seja json válido
        }
      } else if (def.type === 'boolean') {
        item[key] = !!item[key];
      }
    }
    return item;
  }

  /**
   * Busca todas as linhas que atendam aos filtros fornecidos
   */
  static findMany(where = {}, options = {}) {
    let sql = `SELECT * FROM "${this.tableName}"`;
    const params = [];
    const clauses = [];

    for (const [key, val] of Object.entries(where)) {
      if (val === null) {
        clauses.push(`"${key}" IS NULL`);
      } else {
        clauses.push(`"${key}" = ?`);
        params.push(val);
      }
    }

    if (clauses.length > 0) {
      sql += ` WHERE ${clauses.join(' AND ')}`;
    }

    if (options.orderBy) {
      sql += ` ORDER BY ${options.orderBy}`;
    }

    if (options.limit) {
      sql += ` LIMIT ${Number(options.limit)}`;
      if (options.offset) {
        sql += ` OFFSET ${Number(options.offset)}`;
      }
    }

    const rows = db.query(sql, params);
    return rows.map(r => this._deserialize(r));
  }

  /**
   * Busca todas as linhas da tabela
   */
  static all(options = {}) {
    return this.findMany({}, options);
  }

  /**
   * Busca a primeira linha que atende aos filtros
   */
  static findOne(where = {}) {
    const list = this.findMany(where, { limit: 1 });
    return list.length > 0 ? list[0] : null;
  }

  /**
   * Busca uma linha pela chave primária
   */
  static findById(id) {
    return this.findOne({ [this.primaryKey]: id });
  }

  /**
   * Insere um novo registro no banco de dados
   */
  static create(data) {
    const now = new Date().toISOString();
    const payload = { ...data };

    if (this.schema.created_at && !payload.created_at) payload.created_at = now;
    if (this.schema.updated_at && !payload.updated_at) payload.updated_at = now;

    const row = this._serialize(payload);
    const keys = Object.keys(row);
    const placeholders = keys.map(() => '?').join(', ');
    const cols = keys.map(k => `"${k}"`).join(', ');

    const sql = `INSERT INTO "${this.tableName}" (${cols}) VALUES (${placeholders});`;
    const params = Object.values(row);

    const result = db.execute(sql, params);
    const insertId = result.lastInsertRowid;

    if (this.schema[this.primaryKey]?.autoIncrement) {
      return this.findById(insertId);
    }
    return this.findById(payload[this.primaryKey] || insertId);
  }

  /**
   * Atualiza um registro existente pela chave primária
   */
  static update(id, data) {
    const now = new Date().toISOString();
    const payload = { ...data };

    if (this.schema.updated_at) payload.updated_at = now;
    delete payload[this.primaryKey]; // não altera chave primária

    const row = this._serialize(payload);
    const keys = Object.keys(row);
    if (keys.length === 0) return this.findById(id);

    const setClauses = keys.map(k => `"${k}" = ?`).join(', ');
    const sql = `UPDATE "${this.tableName}" SET ${setClauses} WHERE "${this.primaryKey}" = ?;`;
    const params = [...Object.values(row), id];

    db.execute(sql, params);
    return this.findById(id);
  }

  /**
   * Exclui um registro pela chave primária
   */
  static delete(id) {
    const sql = `DELETE FROM "${this.tableName}" WHERE "${this.primaryKey}" = ?;`;
    const result = db.execute(sql, [id]);
    return result.changes > 0;
  }

  /**
   * Conta a quantidade de registros que atendem aos filtros
   */
  static count(where = {}) {
    let sql = `SELECT COUNT(*) AS total FROM "${this.tableName}"`;
    const params = [];
    const clauses = [];

    for (const [key, val] of Object.entries(where)) {
      if (val === null) clauses.push(`"${key}" IS NULL`);
      else { clauses.push(`"${key}" = ?`); params.push(val); }
    }

    if (clauses.length > 0) sql += ` WHERE ${clauses.join(' AND ')}`;
    const row = db.queryOne(sql, params);
    return row ? Number(row.total) : 0;
  }

  /**
   * Executa uma consulta SQL customizada
   */
  static raw(sql, params = []) {
    return db.query(sql, params);
  }
}

module.exports = {
  Model,
  db
};
