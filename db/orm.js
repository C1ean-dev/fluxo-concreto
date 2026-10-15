/* ORM Portável para Node.js com suporte a SQLite e PostgreSQL.
   Inspirado nos padrões ActiveRecord / DataMapper.
   Fornece mapeamento objeto-relacional com schemas tipados, serialização automática
   de campos JSON, e operações CRUD assíncronas padronizadas para funcionar tanto localmente
   com SQLite quanto em produção com PostgreSQL (Railway). */

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

    for (const [colName, def] of Object.entries(this.schema)) {
      let colDef = `"${colName}" `;

      if (db.isPostgres) {
        if (def.primaryKey && def.autoIncrement) {
          colDef += 'SERIAL PRIMARY KEY';
          cols.push(colDef);
          continue;
        }

        switch (def.type) {
          case 'integer':
            colDef += 'INTEGER';
            break;
          case 'boolean':
            colDef += 'BOOLEAN';
            break;
          case 'real':
          case 'float':
          case 'number':
            colDef += 'DOUBLE PRECISION';
            break;
          case 'json':
            colDef += 'JSONB';
            break;
          case 'date':
          case 'text':
          case 'string':
          default:
            colDef += 'TEXT';
        }

        if (def.primaryKey) colDef += ' PRIMARY KEY';
        if (def.notNull && !def.primaryKey) colDef += ' NOT NULL';

        if (def.default !== undefined) {
          if (def.type === 'json') {
            colDef += ` DEFAULT '${JSON.stringify(def.default)}'::jsonb`;
          } else if (typeof def.default === 'string') {
            colDef += ` DEFAULT '${def.default.replace(/'/g, "''")}'`;
          } else if (typeof def.default === 'number') {
            colDef += ` DEFAULT ${def.default}`;
          } else if (typeof def.default === 'boolean') {
            colDef += ` DEFAULT ${def.default ? 'TRUE' : 'FALSE'}`;
          }
        }
      } else {
        // SQLite
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
      }

      cols.push(colDef);
    }

    return `CREATE TABLE IF NOT EXISTS "${this.tableName}" (\n  ${cols.join(',\n  ')}\n);`;
  }

  /**
   * Cria a tabela no banco de dados se ela ainda não existir
   */
  static async sync() {
    const sql = this.getCreateTableSQL();
    await db.execScript(sql);

    // Auto-migração: adiciona colunas do schema que ainda não existam
    try {
      if (db.isPostgres) {
        const rows = await db.query(
          `SELECT column_name FROM information_schema.columns WHERE table_name = $1;`,
          [this.tableName.toLowerCase()]
        );
        const existingCols = rows.map(r => r.column_name.toLowerCase());
        for (const [colName, def] of Object.entries(this.schema)) {
          if (!existingCols.includes(colName.toLowerCase())) {
            let colType = 'TEXT';
            if (def.type === 'integer') colType = 'INTEGER';
            else if (def.type === 'boolean') colType = 'BOOLEAN';
            else if (['real', 'float', 'number'].includes(def.type)) colType = 'DOUBLE PRECISION';
            else if (def.type === 'json') colType = 'JSONB';
            await db.execute(`ALTER TABLE "${this.tableName}" ADD COLUMN IF NOT EXISTS "${colName}" ${colType};`);
          }
        }
      } else {
        const existingCols = (await db.query(`PRAGMA table_info("${this.tableName}");`)).map(c => c.name);
        for (const [colName, def] of Object.entries(this.schema)) {
          if (!existingCols.includes(colName)) {
            let colType = 'TEXT';
            if (def.type === 'integer' || def.type === 'boolean') colType = 'INTEGER';
            else if (['real', 'float', 'number'].includes(def.type)) colType = 'REAL';
            await db.execute(`ALTER TABLE "${this.tableName}" ADD COLUMN "${colName}" ${colType};`);
          }
        }
      }
    } catch (e) {
      console.warn(`[ORM] Aviso ao sincronizar colunas de ${this.tableName}:`, e.message);
    }

    return true;
  }

  /**
   * Serializa os dados antes de gravar no banco
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
        row[key] = db.isPostgres ? Boolean(value) : (value ? 1 : 0);
      } else {
        row[key] = value;
      }
    }
    return row;
  }

  /**
   * Deserializa os dados lidos do banco
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
          // mantém valor caso não seja string JSON válida
        }
      } else if (def.type === 'boolean') {
        item[key] = Boolean(item[key]);
      }
    }
    return item;
  }

  /**
   * Busca todas as linhas que atendam aos filtros fornecidos
   */
  static async findMany(where = {}, options = {}) {
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

    const rows = await db.query(sql, params);
    return rows.map(r => this._deserialize(r));
  }

  /**
   * Busca todas as linhas da tabela
   */
  static async all(options = {}) {
    return await this.findMany({}, options);
  }

  /**
   * Busca a primeira linha que atende aos filtros
   */
  static async findOne(where = {}) {
    const list = await this.findMany(where, { limit: 1 });
    return list.length > 0 ? list[0] : null;
  }

  /**
   * Busca uma linha pela chave primária
   */
  static async findById(id) {
    return await this.findOne({ [this.primaryKey]: id });
  }

  /**
   * Insere um novo registro no banco de dados
   */
  static async create(data) {
    const now = new Date().toISOString();
    const payload = { ...data };

    if (this.schema.created_at && !payload.created_at) payload.created_at = now;
    if (this.schema.updated_at && !payload.updated_at) payload.updated_at = now;

    const row = this._serialize(payload);
    const keys = Object.keys(row);
    const placeholders = keys.map(() => '?').join(', ');
    const cols = keys.map(k => `"${k}"`).join(', ');

    let sql = `INSERT INTO "${this.tableName}" (${cols}) VALUES (${placeholders})`;
    if (db.isPostgres) {
      sql += ` RETURNING "${this.primaryKey}"`;
    }
    sql += ';';

    const params = Object.values(row);
    const result = await db.execute(sql, params);

    const insertId = db.isPostgres
      ? (result.rows?.[0]?.[this.primaryKey] || payload[this.primaryKey])
      : result.lastInsertRowid;

    if (this.schema[this.primaryKey]?.autoIncrement) {
      return await this.findById(insertId);
    }
    return await this.findById(payload[this.primaryKey] || insertId);
  }

  /**
   * Atualiza um registro existente pela chave primária
   */
  static async update(id, data) {
    const now = new Date().toISOString();
    const payload = { ...data };

    if (this.schema.updated_at) payload.updated_at = now;
    delete payload[this.primaryKey]; // não altera chave primária

    const row = this._serialize(payload);
    const keys = Object.keys(row);
    if (keys.length === 0) return await this.findById(id);

    const setClauses = keys.map(k => `"${k}" = ?`).join(', ');
    const sql = `UPDATE "${this.tableName}" SET ${setClauses} WHERE "${this.primaryKey}" = ?;`;
    const params = [...Object.values(row), id];

    await db.execute(sql, params);
    return await this.findById(id);
  }

  /**
   * Exclui um registro pela chave primária
   */
  static async delete(id) {
    const sql = `DELETE FROM "${this.tableName}" WHERE "${this.primaryKey}" = ?;`;
    const result = await db.execute(sql, [id]);
    return result.changes > 0;
  }

  /**
   * Conta a quantidade de registros que atendem aos filtros
   */
  static async count(where = {}) {
    let sql = `SELECT COUNT(*) AS total FROM "${this.tableName}"`;
    const params = [];
    const clauses = [];

    for (const [key, val] of Object.entries(where)) {
      if (val === null) clauses.push(`"${key}" IS NULL`);
      else { clauses.push(`"${key}" = ?`); params.push(val); }
    }

    if (clauses.length > 0) sql += ` WHERE ${clauses.join(' AND ')}`;
    const row = await db.queryOne(sql, params);
    return row ? Number(row.total) : 0;
  }

  /**
   * Executa uma consulta SQL customizada
   */
  static async raw(sql, params = []) {
    return await db.query(sql, params);
  }
}

module.exports = {
  Model,
  db
};
