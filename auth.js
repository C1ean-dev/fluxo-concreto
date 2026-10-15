/* Módulo de Autenticação via Magic Link e OTP de 6 dígitos.
   Integração com a API Resend para envio de e-mails transacionais.
   Restrição obrigatória de domínio corporativo: @falcaobauer.com.br */

const crypto = require('node:crypto');
const { AuthToken, Session } = require('./db/models');

const ALLOWED_DOMAIN = (process.env.AUTH_ALLOWED_DOMAIN || 'falcaobauer.com.br').toLowerCase().trim();
const RESEND_API_URL = 'https://api.resend.com/emails';
const CODE_EXPIRATION_MINUTES = 15;
const SESSION_EXPIRATION_DAYS = 30;

/**
 * Valida se o e-mail pertence exclusivamente ao domínio corporativo permitido
 */
function isValidCorporateEmail(email) {
  if (typeof email !== 'string') return false;
  const normalized = email.trim().toLowerCase();
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(normalized)) return false;
  return normalized.endsWith('@' + ALLOWED_DOMAIN);
}

/**
 * Gera código OTP numérico de 6 dígitos
 */
function generateOtp() {
  return String(crypto.randomInt(100000, 1000000));
}

/**
 * Gera token seguro para Magic Link
 */
function generateToken() {
  return crypto.randomBytes(32).toString('hex');
}

/**
 * Gera identificador de sessão
 */
function generateSessionId() {
  return typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : crypto.randomBytes(32).toString('hex');
}

/**
 * Envia o e-mail com o código OTP e o Magic Link utilizando a API do Resend
 */
async function sendAuthEmail({ email, otp, magicLink, testOnly = false }) {
  const apiKey = process.env.RESEND_API_KEY;

  if (testOnly || !apiKey || apiKey === 'test-only') {
    console.log(`\n[AUTH TEST/DEV] E-mail para: ${email}`);
    console.log(`[AUTH TEST/DEV] Código OTP de 6 dígitos: ${otp}`);
    console.log(`[AUTH TEST/DEV] Magic Link direto: ${magicLink}\n`);
    return { ok: true, devMode: true };
  }

  const fromEmail = process.env.RESEND_FROM_EMAIL || 'Concreto Projetado <onboarding@resend.dev>';
  const subject = `Seu código de acesso: ${otp} · Falcão Bauer`;

  const html = `
<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8">
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; background-color: #f4f6f8; margin: 0; padding: 24px; color: #1e293b; }
    .card { max-width: 520px; margin: 0 auto; background: #ffffff; border-radius: 12px; border: 1px solid #e2e8f0; overflow: hidden; box-shadow: 0 4px 12px rgba(0,0,0,0.05); }
    .header { background: #0f172a; padding: 28px 24px; text-align: center; }
    .header h1 { color: #38bdf8; font-size: 20px; margin: 0; font-weight: 700; letter-spacing: -0.5px; }
    .header p { color: #94a3b8; font-size: 13px; margin: 6px 0 0; }
    .content { padding: 32px 28px; text-align: center; }
    .greeting { font-size: 15px; color: #334155; margin-bottom: 20px; line-height: 1.5; text-align: left; }
    .otp-label { font-size: 12px; font-weight: 600; text-transform: uppercase; letter-spacing: 1px; color: #64748b; margin-bottom: 8px; }
    .otp-box { background: #f8fafc; border: 2px dashed #0284c7; border-radius: 8px; padding: 18px; margin: 12px 0 24px; display: inline-block; min-width: 220px; }
    .otp-code { font-family: 'SF Mono', Consolas, Monaco, monospace; font-size: 34px; font-weight: 800; letter-spacing: 8px; color: #0284c7; margin: 0; }
    .divider { height: 1px; background: #e2e8f0; margin: 28px 0; }
    .magic-text { font-size: 14px; color: #475569; margin-bottom: 16px; }
    .magic-btn { display: inline-block; background: #0284c7; color: #ffffff !important; text-decoration: none; font-weight: 600; font-size: 15px; padding: 13px 32px; border-radius: 8px; box-shadow: 0 2px 4px rgba(2, 132, 199, 0.2); }
    .footer { background: #f8fafc; padding: 20px 24px; font-size: 12px; color: #64748b; text-align: center; border-top: 1px solid #e2e8f0; line-height: 1.5; }
    .tag { display: inline-block; background: #e0f2fe; color: #0369a1; padding: 2px 8px; border-radius: 4px; font-size: 11px; font-weight: 600; margin-top: 4px; }
  </style>
</head>
<body>
  <div class="card">
    <div class="header">
      <h1>Falcão Bauer</h1>
      <p>Fluxo de Relatórios de Concreto Projetado</p>
    </div>
    <div class="content">
      <div class="greeting">
        Olá,<br>
        Você solicitou acesso ao sistema com seu e-mail institucional <strong>${email}</strong>.
      </div>
      
      <div class="otp-label">Código de Verificação (OTP)</div>
      <div class="otp-box">
        <div class="otp-code">${otp}</div>
      </div>
      <p style="font-size: 12px; color: #64748b; margin-top: 0;">Digite este código de 6 dígitos na tela de login.</p>

      <div class="divider"></div>

      <div class="magic-text">Ou se preferir, entre com um clique:</div>
      <a href="${magicLink}" class="magic-btn" target="_blank">Acessar com Magic Link</a>
    </div>
    <div class="footer">
      <div>Este código e link expiram em <strong>${CODE_EXPIRATION_MINUTES} minutos</strong>.</div>
      <div style="margin-top: 6px;">Se você não solicitou este acesso, desconsidere esta mensagem.</div>
      <div class="tag">Acesso exclusivo @falcaobauer.com.br</div>
    </div>
  </div>
</body>
</html>
  `;

  try {
    const res = await fetch(RESEND_API_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        from: fromEmail,
        to: [email],
        subject,
        html
      })
    });

    const data = await res.json();
    if (!res.ok) {
      console.error('[Resend Error]', data);
      // Se a conta Resend de teste não tiver o domínio verificado, loga no console para não travar o desenvolvedor
      console.log(`\n[FALLBACK CONSOLE] Para logar use o OTP: ${otp} ou Link: ${magicLink}\n`);
      if (data?.name === 'validation_error' || data?.message?.includes('verified')) {
        return { ok: true, fallback: true, warning: data.message };
      }
      throw new Error(data.message || 'Falha ao enviar e-mail pelo Resend.');
    }

    return { ok: true, id: data.id };
  } catch (err) {
    console.error('[Resend Exception]', err.message);
    // Em caso de falha de rede/API, imprime no console para contingência
    console.log(`\n[CONTINGÊNCIA AUTH] OTP para ${email}: ${otp}\nLink: ${magicLink}\n`);
    throw err;
  }
}

/**
 * Cria a solicitação de login e envia o e-mail via Resend
 */
async function requestLogin(email, reqUrl) {
  const normalized = email.trim().toLowerCase();

  if (!isValidCorporateEmail(normalized)) {
    throw new Error(`Acesso permitido somente para e-mails institucionais @${ALLOWED_DOMAIN}.`);
  }

  // Rate limiting simples: verifica se foi enviado código nos últimos 30 segundos
  const now = new Date();
  const recentToken = await AuthToken.findOne({
    email: normalized,
    used: false
  });

  if (recentToken && (now.getTime() - new Date(recentToken.created_at).getTime()) < 30000) {
    throw new Error('Aguarde 30 segundos antes de solicitar um novo código.');
  }

  const otp = generateOtp();
  const token = generateToken();
  const expiresAt = new Date(Date.now() + CODE_EXPIRATION_MINUTES * 60 * 1000).toISOString();

  await AuthToken.create({
    email: normalized,
    otp,
    token,
    expires_at: expiresAt,
    used: false,
    created_at: now.toISOString()
  });

  const baseUrl = `${reqUrl.protocol}//${reqUrl.host}`;
  const magicLink = `${baseUrl}/api/auth/verify-magic?token=${token}`;

  await sendAuthEmail({
    email: normalized,
    otp,
    magicLink
  });

  return {
    ok: true,
    email: normalized,
    expiresInMinutes: CODE_EXPIRATION_MINUTES,
    message: `Código de acesso enviado com sucesso para ${normalized}!`
  };
}

/**
 * Valida o código OTP de 6 dígitos e cria a sessão do usuário
 */
async function verifyOtpCode(email, otp) {
  if (!email || !otp) {
    throw new Error('E-mail e código OTP de 6 dígitos são obrigatórios.');
  }

  const normalizedEmail = email.trim().toLowerCase();
  const normalizedOtp = String(otp).trim();

  if (!isValidCorporateEmail(normalizedEmail)) {
    throw new Error(`Acesso permitido somente para e-mails @${ALLOWED_DOMAIN}.`);
  }

  const authToken = await AuthToken.findOne({
    email: normalizedEmail,
    otp: normalizedOtp,
    used: false
  });

  if (!authToken) {
    throw new Error('Código OTP inválido ou não encontrado.');
  }

  if (new Date(authToken.expires_at).getTime() < Date.now()) {
    throw new Error('O código de acesso expirou. Solicite um novo código.');
  }

  // Marca token como utilizado
  await AuthToken.update(authToken.id, { used: true });

  // Cria sessão duradoura
  const sessionId = generateSessionId();
  const sessionExpiresAt = new Date(Date.now() + SESSION_EXPIRATION_DAYS * 24 * 60 * 60 * 1000).toISOString();

  const session = await Session.create({
    id: sessionId,
    email: normalizedEmail,
    expires_at: sessionExpiresAt,
    created_at: new Date().toISOString()
  });

  return {
    ok: true,
    sessionId: session.id,
    user: { email: session.email }
  };
}

/**
 * Valida o token de Magic Link e cria a sessão do usuário
 */
async function verifyMagicLinkToken(token) {
  if (!token || typeof token !== 'string') {
    throw new Error('Token do link mágico inválido ou não informado.');
  }

  const authToken = await AuthToken.findOne({
    token: token.trim(),
    used: false
  });

  if (!authToken) {
    throw new Error('Link mágico inválido ou já utilizado.');
  }

  if (new Date(authToken.expires_at).getTime() < Date.now()) {
    throw new Error('O link mágico expirou. Solicite um novo acesso.');
  }

  // Marca token como utilizado
  await AuthToken.update(authToken.id, { used: true });

  // Cria sessão duradoura
  const sessionId = generateSessionId();
  const sessionExpiresAt = new Date(Date.now() + SESSION_EXPIRATION_DAYS * 24 * 60 * 60 * 1000).toISOString();

  const session = await Session.create({
    id: sessionId,
    email: authToken.email,
    expires_at: sessionExpiresAt,
    created_at: new Date().toISOString()
  });

  return {
    ok: true,
    sessionId: session.id,
    user: { email: session.email }
  };
}

/**
 * Analisa os cookies da requisição
 */
function parseCookies(req) {
  const list = {};
  const rc = req.headers.cookie;
  if (rc) {
    rc.split(';').forEach(cookie => {
      const parts = cookie.split('=');
      const name = parts.shift().trim();
      const val = decodeURIComponent(parts.join('='));
      list[name] = val;
    });
  }
  return list;
}

/**
 * Gera cabeçalho Set-Cookie para sessão
 */
function createSessionCookieHeader(sessionId, req) {
  const isHttps = req.headers['x-forwarded-proto'] === 'https' || process.env.NODE_ENV === 'production';
  return `auth_token=${sessionId}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_EXPIRATION_DAYS * 24 * 3600}${isHttps ? '; Secure' : ''}`;
}

/**
 * Gera cabeçalho Set-Cookie para remoção da sessão
 */
function createClearSessionCookieHeader() {
  return 'auth_token=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0';
}

/**
 * Obtém o usuário autenticado na requisição atual
 */
async function getAuthenticatedUser(req) {
  const cookies = parseCookies(req);
  let sessionId = cookies.auth_token;

  if (!sessionId && req.headers.authorization) {
    const parts = req.headers.authorization.split(' ');
    if (parts.length === 2 && parts[0].toLowerCase() === 'bearer') {
      sessionId = parts[1];
    }
  }

  if (!sessionId) return null;

  try {
    const session = await Session.findById(sessionId);
    if (!session) return null;

    if (new Date(session.expires_at).getTime() < Date.now()) {
      await Session.delete(session.id);
      return null;
    }

    return { email: session.email, sessionId: session.id };
  } catch (err) {
    return null;
  }
}

/**
 * Encerra a sessão atual
 */
async function logout(req) {
  const cookies = parseCookies(req);
  const sessionId = cookies.auth_token;
  if (sessionId) {
    try {
      await Session.delete(sessionId);
    } catch (_) {}
  }
  return { ok: true };
}

module.exports = {
  ALLOWED_DOMAIN,
  isValidCorporateEmail,
  generateOtp,
  generateToken,
  sendAuthEmail,
  requestLogin,
  verifyOtpCode,
  verifyMagicLinkToken,
  parseCookies,
  createSessionCookieHeader,
  createClearSessionCookieHeader,
  getAuthenticatedUser,
  logout
};
