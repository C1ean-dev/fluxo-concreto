/* Servidor HTTP e API REST para persistência SQLite e Gerenciamento do Banco.
   Sem dependências externas - utiliza apenas módulos nativos do Node.js.
   Porta padrão: 3000 (ou variável de ambiente PORT). */

// Carrega variáveis do arquivo .env nativamente no Node.js
if (typeof process.loadEnvFile === 'function') {
  try { process.loadEnvFile(); } catch (err) {}
}

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const db = require('./db/database');
const { Card, CorpoDeProva, Configuracao, Log, syncAllModels } = require('./db/models');
const { seedDatabase } = require('./db/seed');

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = __dirname;

// Módulo especializado de Inteligência Artificial (OpenRouter)
const { analyzeCardWithAi, buildAiPrompt, classifyCard, settingsOf, OPENROUTER_CONFIG } = require('./ai');

// Garante que a estrutura das tabelas está sincronizada com novas colunas
syncAllModels();

// Inicializa e popula o banco de dados caso esteja vazio
seedDatabase();

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.js':   'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.svg':  'image/svg+xml',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.sqlite': 'application/octet-stream'
};

function sendJson(res, statusCode, data) {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
  });
  res.end(JSON.stringify(data));
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      if (!body) return resolve({});
      try {
        resolve(JSON.parse(body));
      } catch (err) {
        reject(new Error('JSON inválido no corpo da requisição'));
      }
    });
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  const reqUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = reqUrl.pathname;
  const method = req.method.toUpperCase();

  // Tratamento de CORS Preflight
  if (method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type'
    });
    return res.end();
  }

  // ==========================================
  // ROTAS DA API REST
  // ==========================================

  // 1. Status do Banco
  if (pathname === '/api/status' && method === 'GET') {
    try {
      const stats = fs.statSync(db.DB_PATH);
      return sendJson(res, 200, {
        ok: true,
        engine: 'SQLite (node:sqlite)',
        file: db.DB_PATH,
        sizeKb: (stats.size / 1024).toFixed(2),
        counts: {
          cards: Card.count(),
          corpos_de_prova: CorpoDeProva.count(),
          configuracoes: Configuracao.count(),
          logs: Log.count()
        }
      });
    } catch (err) {
      return sendJson(res, 500, { ok: false, error: err.message });
    }
  }

  // 2. Estado completo para o Frontend (/api/state)
  if (pathname === '/api/state' && method === 'GET') {
    try {
      const allCards = Card.allWithCps({ orderBy: 'id ASC' });
      const configRecord = Configuracao.findById(1);

      // Formata os cards no padrão que o app.js consome (cps como objetos com arrays h e d)
      const formattedCards = allCards.map(c => {
        const cpsObjects = (c.cps || []).map((cp, idx) => ({
          n: cp.cp_index !== undefined ? cp.cp_index + 1 : idx + 1,
          idade: cp.idade,
          dataEnsaio: '',
          h: [
            cp.h1 !== null && cp.h1 !== undefined ? cp.h1 : '',
            cp.h2 !== null && cp.h2 !== undefined ? cp.h2 : '',
            cp.h3 !== null && cp.h3 !== undefined ? cp.h3 : ''
          ],
          d: [
            cp.d1 !== null && cp.d1 !== undefined ? cp.d1 : '',
            cp.d2 !== null && cp.d2 !== undefined ? cp.d2 : ''
          ],
          massa: cp.massa !== null && cp.massa !== undefined ? cp.massa : '',
          carga: cp.carga !== null && cp.carga !== undefined ? cp.carga : '',
          sentido: cp.sentido ? cp.sentido : ((cp.carga || cp.h1 || cp.massa) ? 'Mesmo do lançamento' : ''),
          cura: cp.cura ? cp.cura : ((cp.carga || cp.h1 || cp.massa) ? 'Úmida' : '')
        }));

        const standardCols = new Set([
          'id', 'stage', 'placa', 'interessado', 'email_cliente', 'central', 'fck',
          'data_projecao', 'criterio', 'coef_a', 'coef_b', 'ident', 'notified',
          'adjust', 'decision_analysis', 'ai_analysis', 'email_drafts', 'notification_history', 'cfg_snap', 'final_sent', 'created_at', 'updated_at', 'cps'
        ]);
        const customCols = {};
        for (const [k, v] of Object.entries(c)) {
          if (!standardCols.has(k) && v !== null && v !== undefined && String(v).trim() !== '') {
            customCols[k] = v;
          }
        }
        const mergedIdent = { ...customCols, ...(c.ident || {}) };

        return {
          id: c.id,
          stage: c.stage,
          ident: mergedIdent,
          cps: cpsObjects,
          criterio: c.criterio || 'media',
          coefA: c.coef_a !== undefined && c.coef_a !== null ? c.coef_a : 1.0024,
          coefB: c.coef_b !== undefined && c.coef_b !== null ? c.coef_b : 0.0299,
          notified: c.notified || {},
          adjust: c.adjust || {},
          aiAnalysis: c.ai_analysis || null,
          emailDrafts: c.email_drafts || {},
          decisionAnalysis: c.decision_analysis || null,
          cfgSnap: c.cfg_snap || null,
          finalSent: c.final_sent || null,
          notifLog: c.notification_history || [],
          log: Log.findMany({card_id:c.id},{orderBy:'data_hora ASC, id ASC'}).map(entry => ({t:entry.data_hora,text:entry.mensagem}))
        };
      });

      const formattedConfig = configRecord ? {
        rev: configRecord.rev,
        active: configRecord.active,
        sets: configRecord.sets || [],
        formulas: configRecord.formulas || {},
        history: configRecord.history || [],
        decision: configRecord.decision || null,
        ai: settingsOf({config:configRecord}).ai
      } : null;

      return sendJson(res, 200, {
        ok: true,
        cards: formattedCards,
        config: formattedConfig
      });
    } catch (err) {
      return sendJson(res, 500, { ok: false, error: err.message });
    }
  }

  // 3. Salvar Estado do Frontend no SQLite (/api/save)
  if (pathname === '/api/save' && method === 'POST') {
    try {
      const payload = await parseBody(req);
      const { cards, config } = payload;

      db.transaction(() => {
        // Atualiza ou insere configuração
        if (config) {
          const cfgData = {
            rev: config.rev || 1,
            active: config.active || 'planilha',
            sets: config.sets || [],
            formulas: config.formulas || {},
            history: config.history || [],
            decision: config.decision || null,
            ai: config.ai || null
          };
          const exists = Configuracao.findById(1);
          if (exists) Configuracao.update(1, cfgData);
          else Configuracao.create({ id: 1, ...cfgData });
        }

        // Atualiza ou insere cards
        if (Array.isArray(cards)) {
          cards.forEach(c => {
            const cardData = {
              id: c.id,
              stage: c.stage,
              placa: String(c.ident?.placa || ''),
              interessado: String(c.ident?.interessado || ''),
              email_cliente: String(c.ident?.emailCliente || ''),
              central: String(c.ident?.central || ''),
              fck: Number(c.ident?.fck || 35),
              data_projecao: String(c.ident?.dataProjecao || ''),
              criterio: c.criterio || 'media',
              coef_a: Number(c.coefA || 1.0024),
              coef_b: Number(c.coefB || 0.0299),
              ident: c.ident || {},
              notified: c.notified || {},
              notification_history: c.notifLog || [],
              adjust: c.adjust || {},
              ai_analysis: c.aiAnalysis || null,
              email_drafts: c.emailDrafts || {},
              decision_analysis: c.decisionAnalysis || null,
              cfg_snap: c.cfgSnap || null,
              final_sent: c.finalSent || null
            };

            const existingCard = Card.findById(c.id);
            cardData.notification_history = [...new Map([...(existingCard?.notification_history || []),...(cardData.notification_history || [])].map(entry => [JSON.stringify(entry),entry])).values()];
            if (existingCard) Card.update(c.id, cardData);
            else Card.create(cardData);
            const recorded = new Set(Log.findMany({card_id:c.id}).map(entry => JSON.stringify([entry.data_hora,entry.mensagem])));
            for(const entry of Array.isArray(c.log) ? c.log : []){
              if(typeof entry?.text !== 'string' || !entry.text.trim() || typeof entry.t !== 'string' || !Number.isFinite(Date.parse(entry.t))) continue;
              const key = JSON.stringify([entry.t,entry.text]);
              if(recorded.has(key)) continue;
              Log.create({card_id:c.id,mensagem:entry.text,data_hora:entry.t});
              recorded.add(key);
            }

            // Atualiza CPs se fornecidos
            if (Array.isArray(c.cps)) {
              // Remove anteriores deste card para substituir atomicamente
              db.execute('DELETE FROM corpos_de_prova WHERE card_id = ?;', [c.id]);
              c.cps.forEach((item, idx) => {
                let idade, h1, h2, h3, d1, d2, massa, carga, sentido, cura;
                if (Array.isArray(item)) {
                  [idade, h1, h2, h3, d1, d2, massa, carga, sentido, cura] = item;
                } else if (item && typeof item === 'object') {
                  idade = item.idade;
                  h1 = item.h ? item.h[0] : null;
                  h2 = item.h ? item.h[1] : null;
                  h3 = item.h ? item.h[2] : null;
                  d1 = item.d ? item.d[0] : null;
                  d2 = item.d ? item.d[1] : null;
                  massa = item.massa;
                  carga = item.carga;
                  sentido = item.sentido;
                  cura = item.cura;
                }
                const toNum = v => (v === '' || v === null || v === undefined ? null : Number(v));

                CorpoDeProva.create({
                  card_id: c.id,
                  cp_index: idx,
                  idade: Number(idade) || 3,
                  h1: toNum(h1),
                  h2: toNum(h2),
                  h3: toNum(h3),
                  d1: toNum(d1),
                  d2: toNum(d2),
                  massa: toNum(massa),
                  carga: toNum(carga),
                  sentido: String(sentido || 'Mesmo do lançamento'),
                  cura: String(cura || 'Úmida')
                });
              });
            }
          });
        }
      });

      return sendJson(res, 200, { ok: true, message: 'Dados salvos no SQLite com sucesso!' });
    } catch (err) {
      return sendJson(res, 500, { ok: false, error: err.message });
    }
  }

  // Preview and execution consume the exact same builders and current card snapshot.
  if (['/api/decision/analyze','/api/decision/prompt','/api/ai/analyze','/api/ai/prompt'].includes(pathname) && (method === 'POST' || (method === 'GET' && pathname.endsWith('/prompt')))) {
    try {
      const body = method === 'POST' ? await parseBody(req) : {cardId:reqUrl.searchParams.get('cardId')};
      const card = body.card || (body.cardId ? Card.findWithCps(body.cardId) : Card.allWithCps()[0]);
      if(!card) return sendJson(res,404,{ok:false,error:'Card não localizado.'});
      if(body.cardId && card.id !== body.cardId) return sendJson(res,400,{ok:false,error:'O card informado não corresponde ao identificador.'});
      const storedConfig = Configuracao.findById(1) || {};
      const config = settingsOf({config:body.config || {...storedConfig, ...(body.aiConfig ? {ai:body.aiConfig} : {})}});
      const Pipeline = require('./js/ai-pipeline');
      const decision = pathname.startsWith('/api/decision/');
      if(pathname.endsWith('/prompt')) {
        const request = decision ? Pipeline.buildDecisionRequest(card,config) : Pipeline.buildAiRequest(card,config,body.customPrompt || '');
        const prompt = decision ? {} : {promptSystem:request.messages[0].content,promptUser:request.messages[1].content};
        return sendJson(res,200,{ok:true,cardId:card.id,request,...prompt,config:OPENROUTER_CONFIG});
      }
      if(!decision && !Pipeline.validDecision(card,config)) return sendJson(res,409,{ok:false,error:'Classificação ausente ou desatualizada. Classifique os dados atuais antes do parecer.'});
      const result = decision ? await classifyCard(card,{config}) : await analyzeCardWithAi(card,body.customPrompt || '',{config});
      // The browser applies the result only if its execution token and inputs are still current,
      // then persists it through /api/save. Never write an asynchronous result over newer data here.
      return sendJson(res,200,{ok:true,[decision ? 'decision' : 'analysis']:result});
    } catch(error) { return sendJson(res,500,{ok:false,error:error.message}); }
  }

  // ==========================================
  // ROTAS DO GERENCIADOR DE BANCO DE DADOS (/api/db/*)
  // ==========================================

  // Listar todas as tabelas e schemas
  if (pathname === '/api/db/tables' && method === 'GET') {
    try {
      const tablesInfo = [
        { name: 'cards', model: Card, label: 'Cards (Relatórios)' },
        { name: 'corpos_de_prova', model: CorpoDeProva, label: 'Corpos de Prova (CPs)' },
        { name: 'configuracoes', model: Configuracao, label: 'Configurações de Tabelas e Fórmulas' },
        { name: 'logs', model: Log, label: 'Logs do Sistema' }
      ].map(t => ({
        name: t.name,
        label: t.label,
        count: t.model.count(),
        schema: t.model.schema,
        primaryKey: t.model.primaryKey
      }));

      return sendJson(res, 200, { ok: true, tables: tablesInfo });
    } catch (err) {
      return sendJson(res, 500, { ok: false, error: err.message });
    }
  }

  // Consultar registros de uma tabela específica
  if (pathname.startsWith('/api/db/table/') && method === 'GET') {
    const tableName = pathname.replace('/api/db/table/', '');
    const search = reqUrl.searchParams.get('q') || '';
    const page = Math.max(1, Number(reqUrl.searchParams.get('page') || 1));
    const limit = Math.max(1, Math.min(200, Number(reqUrl.searchParams.get('limit') || 50)));
    const offset = (page - 1) * limit;

    try {
      const models = { cards: Card, corpos_de_prova: CorpoDeProva, configuracoes: Configuracao, logs: Log };
      const model = models[tableName];
      if (!model) {
        return sendJson(res, 400, { ok: false, error: 'Tabela inválida ou não permitida' });
      }

      let whereClause = '';
      const params = [];
      if (search) {
        const cols = Object.keys(model.schema);
        const conditions = cols.map(col => `CAST("${col}" AS TEXT) LIKE ?`);
        whereClause = `WHERE (${conditions.join(' OR ')})`;
        cols.forEach(() => params.push(`%${search}%`));
      }

      const totalRow = db.queryOne(`SELECT COUNT(*) AS total FROM "${tableName}" ${whereClause};`, params);
      const total = totalRow ? Number(totalRow.total) : 0;

      const rows = db.query(`SELECT * FROM "${tableName}" ${whereClause} LIMIT ${limit} OFFSET ${offset};`, params);

      return sendJson(res, 200, {
        ok: true,
        table: tableName,
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit) || 1,
        rows
      });
    } catch (err) {
      return sendJson(res, 500, { ok: false, error: err.message });
    }
  }

  // Inserir registro em uma tabela
  if (pathname.startsWith('/api/db/table/') && method === 'POST') {
    const tableName = pathname.replace('/api/db/table/', '');
    try {
      const models = { cards: Card, corpos_de_prova: CorpoDeProva, configuracoes: Configuracao, logs: Log };
      const model = models[tableName];
      if (!model) return sendJson(res, 400, { ok: false, error: 'Tabela não encontrada' });

      const data = await parseBody(req);
      const created = model.create(data);
      return sendJson(res, 201, { ok: true, row: created });
    } catch (err) {
      return sendJson(res, 500, { ok: false, error: err.message });
    }
  }

  // Atualizar registro por ID
  if (pathname.startsWith('/api/db/row/') && method === 'PUT') {
    const parts = pathname.replace('/api/db/row/', '').split('/');
    const tableName = parts[0];
    const id = decodeURIComponent(parts[1]);

    try {
      const models = { cards: Card, corpos_de_prova: CorpoDeProva, configuracoes: Configuracao, logs: Log };
      const model = models[tableName];
      if (!model) return sendJson(res, 400, { ok: false, error: 'Tabela não encontrada' });

      const data = await parseBody(req);
      const updated = model.update(id, data);
      return sendJson(res, 200, { ok: true, row: updated });
    } catch (err) {
      return sendJson(res, 500, { ok: false, error: err.message });
    }
  }

  // Excluir registro por ID
  if (pathname.startsWith('/api/db/row/') && method === 'DELETE') {
    const parts = pathname.replace('/api/db/row/', '').split('/');
    const tableName = parts[0];
    const id = decodeURIComponent(parts[1]);

    try {
      const models = { cards: Card, corpos_de_prova: CorpoDeProva, configuracoes: Configuracao, logs: Log };
      const model = models[tableName];
      if (!model) return sendJson(res, 400, { ok: false, error: 'Tabela não encontrada' });

      const deleted = model.delete(id);
      return sendJson(res, 200, { ok: true, deleted });
    } catch (err) {
      return sendJson(res, 500, { ok: false, error: err.message });
    }
  }

  // Executar Consulta SQL Arbitrária
  if (pathname === '/api/db/query' && method === 'POST') {
    try {
      const { sql } = await parseBody(req);
      if (!sql || typeof sql !== 'string') {
        return sendJson(res, 400, { ok: false, error: 'Comando SQL não informado' });
      }

      const trimmed = sql.trim();
      const start = Date.now();

      if (/^select\b/i.test(trimmed) || /^pragma\b/i.test(trimmed)) {
        const rows = db.query(trimmed);
        const timeMs = Date.now() - start;
        return sendJson(res, 200, {
          ok: true,
          type: 'SELECT',
          timeMs,
          count: rows.length,
          columns: rows.length > 0 ? Object.keys(rows[0]) : [],
          rows
        });
      } else {
        const result = db.execute(trimmed);
        const timeMs = Date.now() - start;
        return sendJson(res, 200, {
          ok: true,
          type: 'EXECUTE',
          timeMs,
          changes: result.changes,
          lastInsertRowid: result.lastInsertRowid
        });
      }
    } catch (err) {
      return sendJson(res, 400, { ok: false, error: err.message });
    }
  }

  // Resetar / Semear dados padrão
  if (pathname === '/api/db/reset' && method === 'POST') {
    try {
      seedDatabase(true);
      return sendJson(res, 200, { ok: true, message: 'Banco de dados restaurado com sucesso!' });
    } catch (err) {
      return sendJson(res, 500, { ok: false, error: err.message });
    }
  }

  // Download do arquivo do banco SQLite
  if (pathname === '/api/db/download' && method === 'GET') {
    try {
      res.writeHead(200, {
        'Content-Type': 'application/octet-stream',
        'Content-Disposition': 'attachment; filename="database.sqlite"'
      });
      fs.createReadStream(db.DB_PATH).pipe(res);
      return;
    } catch (err) {
      return sendJson(res, 500, { ok: false, error: err.message });
    }
  }

  // ==========================================
  // ARQUIVOS ESTÁTICOS
  // ==========================================
  if(pathname.startsWith('/api/')) {
    return sendJson(res,404,{ok:false,error:'Rota de API não encontrada. Confira o endereço da requisição e a versão do servidor.'});
  }
  if(pathname.split('/').some(segment => segment.startsWith('.'))){ res.writeHead(403); return res.end('Acesso negado'); }
  let filePath = path.join(PUBLIC_DIR, pathname === '/' ? 'prototipo-fluxo-relatorios.html' : pathname);

  // Prevenção de Path Traversal
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    return res.end('Acesso negado');
  }

  fs.stat(filePath, (err, stats) => {
    if (err || !stats.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('Arquivo não encontrado: ' + pathname);
    }

    const ext = path.extname(filePath).toLowerCase();
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';

    res.writeHead(200, { 'Content-Type': contentType });
    fs.createReadStream(filePath).pipe(res);
  });
});

server.on('error',async error => {
  if(error.code === 'EADDRINUSE'){
    try {
      const response = await fetch(`http://localhost:${PORT}/api/status`,{signal:AbortSignal.timeout(2000)});
      const status = await response.json();
      if(response.ok && status.ok && status.engine === 'SQLite (node:sqlite)' && typeof status.file === 'string' && path.resolve(status.file) === path.resolve(db.DB_PATH)){
        console.log(`A aplicação já está em execução em http://localhost:${PORT}/. Use a janela do navegador aberta; não é necessário iniciar outro servidor.`);
        db.closeDb();
        return;
      }
    } catch {}
    console.error(`A porta ${PORT} está ocupada por outra aplicação. Encerre essa aplicação ou escolha outra porta usando a variável PORT.`);
  } else console.error(`Não foi possível iniciar o servidor: ${error.message}`);
  process.exitCode = 1;
  db.closeDb();
});
server.listen(PORT, () => {
  console.log(`\n========================================================`);
  console.log(`Servidor Concreto Projetado rodando com sucesso!`);
  console.log(`--------------------------------------------------------`);
  console.log(`Aplicação Principal: http://localhost:${PORT}/`);
  console.log(`Gerenciador do Banco: http://localhost:${PORT}/banco.html`);
  console.log(`Arquivo SQLite:       ${db.DB_PATH}`);
  console.log(`========================================================\n`);
});

module.exports = server;
