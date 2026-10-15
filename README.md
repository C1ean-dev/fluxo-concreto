# Fluxo de relatórios de concreto

Inicie com `npm start` ou `iniciar-servidor.bat` e abra `http://localhost:3000`.
A integração usa `OPENROUTER_API_KEY` no arquivo `.env` do servidor.

## Classificação e parecer técnico

O fluxo passa por Análise, Ajuste quando necessário, Decisão / Classificação,
Análise de IA e Notificação. O modelo de decisão inicial é
`microsoft/microsoft-decision-1`. Uma classificação válida é obrigatória antes
do parecer; as três classes seguem como contexto para a LLM.

Em **Configurações**, as abas **Decisão / Classificação** e **Inteligência artificial**
permitem editar modelos, instruções, dados enviados e os parâmetros compatíveis
com cada chamada. Na classificação, os critérios das três classes são editáveis.
Na IA generativa (LLM), somente `openrouter/free` é utilizado, com 60 segundos de
tempo limite por chamada. Após erro, resposta incompleta ou timeout, são feitas
até três novas tentativas, após pausas de 5, 10 e 15 segundos. O card permanece
aguardando durante as tentativas e apresenta erro somente quando todas falham.

A prévia mostra o corpo da requisição real. O template da LLM aceita `{{dados}}`,
`{{placa}}`, `{{cardId}}`, `{{observacao}}` e `{{instrucoes}}`; `{{dados}}` é obrigatório.
A classificação é acrescentada automaticamente, mesmo quando o template é alterado.
Alterações são salvas com revisão e motivo. Os cálculos respeitam as tabelas e
fórmulas fixadas no card.

Consultas interrompidas ou resultados desatualizados exigem nova tentativa.
Cards já notificados ou finalizados mantêm seus registros históricos. A próxima
geração do parecer de um card antigo exige a classificação prévia.

## Verificação

- `npm test`: testes com respostas simuladas, cálculo compartilhado, fluxo,
  falhas, invalidação, migração e persistência em banco temporário.
- `node tests/ui-smoke.js`: teste em navegador Chrome, desktop e celular.
  Requer Playwright instalado; `PLAYWRIGHT_MODULE` pode apontar para um runtime
  existente. `BROWSER_CHANNEL` permite selecionar outro navegador compatível.
- `npm run ai:prompt -- RT-113`: prévia sem consulta à OpenRouter.
- `npm run ai -- RT-113`: classificação e parecer reais, sem gravar o resultado
  no banco. Essa opção consome a API configurada.

## Banco de dados e Deploy no Railway

O sistema conta com camada ORM com suporte a modo duplo:
- **Local (padrão):** SQLite nativo (`node:sqlite`), sem necessidade de instalar banco externo.
- **Produção (Railway / Nuvem):** Conexão automática ao **PostgreSQL** quando a variável `DATABASE_URL` (ou `PGHOST`) for fornecida pelo Railway.
  - As tabelas são sincronizadas e migradas automaticamente na inicialização com tipos nativos do PostgreSQL (`JSONB`, `SERIAL`, `DOUBLE PRECISION`).
  - O pool de conexões e transações atômicas utilizam o driver `pg` com suporte a SSL gerenciado.

## Autenticação Corporativa (Magic Link & OTP via Resend)

O sistema possui autenticação corporativa segura e sem senha:
- **Restrição de Domínio:** Acesso permitido exclusivamente para e-mails institucionais `@falcaobauer.com.br`.
- **Modo Duplo de Login:** Ao solicitar o acesso, o usuário recebe um e-mail transacional via **Resend** contendo:
  1. **Código OTP de 6 dígitos** para digitação rápida na tela de login.
  2. **Magic Link direto** para autenticação com 1 clique.
- **Sessões Persistentes:** As sessões ativas são mantidas de forma segura no banco de dados (`sessions`) com cookies `HttpOnly` e `SameSite`.
- **Configuração no Railway:** Adicione a variável `RESEND_API_KEY` no painel do Railway para habilitar o envio dos e-mails em produção.

O servidor adiciona as novas colunas JSON ao banco existente na inicialização,
sem redefinir os cards ou apagar configurações personalizadas.

