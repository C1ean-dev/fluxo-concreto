const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');

const auth = require('../auth');
const { AuthToken, Session } = require('../db/models');

test('E-mail validation restricts strictly to @falcaobauer.com.br', () => {
  assert.equal(auth.isValidCorporateEmail('carlos.silva@falcaobauer.com.br'), true);
  assert.equal(auth.isValidCorporateEmail('ERICK.LIRA@FALCAOBAUER.COM.BR'), true);
  assert.equal(auth.isValidCorporateEmail('engenharia@falcaobauer.com.br'), true);

  assert.equal(auth.isValidCorporateEmail('usuario@gmail.com'), false);
  assert.equal(auth.isValidCorporateEmail('usuario@outlook.com'), false);
  assert.equal(auth.isValidCorporateEmail('usuario@falcaobauer.com'), false); // sem .br
  assert.equal(auth.isValidCorporateEmail('usuario@outrofalcobauer.com.br'), false);
  assert.equal(auth.isValidCorporateEmail('invalido'), false);
  assert.equal(auth.isValidCorporateEmail(''), false);
  assert.equal(auth.isValidCorporateEmail(null), false);
});

test('OTP generator produces 6 numeric digits', () => {
  for (let i = 0; i < 20; i++) {
    const otp = auth.generateOtp();
    assert.equal(typeof otp, 'string');
    assert.equal(otp.length, 6);
    assert.match(otp, /^\d{6}$/);
  }
});

test('Magic Link & OTP authentication lifecycle in database', async () => {
  const email = 'teste.unitario@falcaobauer.com.br';
  const otp = auth.generateOtp();
  const token = auth.generateToken();
  const expiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString();

  // Cria token de teste
  const created = await AuthToken.create({
    email,
    otp,
    token,
    expires_at: expiresAt,
    used: false
  });

  assert.ok(created.id);
  assert.equal(created.email, email);

  // Tentativa de validação com OTP incorreto
  await assert.rejects(
    auth.verifyOtpCode(email, '000000'),
    /inválido ou não encontrado/
  );

  // Tentativa de validação com domínio proibido
  await assert.rejects(
    auth.verifyOtpCode('hacker@externo.com', otp),
    /Acesso permitido somente/
  );

  // Validação com OTP correto
  const verifyResult = await auth.verifyOtpCode(email, otp);
  assert.equal(verifyResult.ok, true);
  assert.equal(verifyResult.user.email, email);
  assert.ok(verifyResult.sessionId);

  // Verifica se o token foi marcado como usado
  const reloadedToken = await AuthToken.findById(created.id);
  assert.equal(reloadedToken.used, true);

  // Não deve permitir reutilizar o mesmo OTP
  await assert.rejects(
    auth.verifyOtpCode(email, otp),
    /inválido ou não encontrado/
  );

  // Validação de sessão criada
  const session = await Session.findById(verifyResult.sessionId);
  assert.ok(session);
  assert.equal(session.email, email);
});

test('Magic Link verification creates valid session and invalidates token', async () => {
  const email = 'link.magico@falcaobauer.com.br';
  const token = auth.generateToken();
  const expiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString();

  await AuthToken.create({
    email,
    otp: '123456',
    token,
    expires_at: expiresAt,
    used: false
  });

  // Rejeita token inexistente
  await assert.rejects(
    auth.verifyMagicLinkToken('token_falso'),
    /inválido ou já utilizado/
  );

  // Valida com token correto
  const result = await auth.verifyMagicLinkToken(token);
  assert.equal(result.ok, true);
  assert.equal(result.user.email, email);
  assert.ok(result.sessionId);

  // Token não pode ser reutilizado
  await assert.rejects(
    auth.verifyMagicLinkToken(token),
    /inválido ou já utilizado/
  );
});

test('HTTP API Auth endpoints: send-code, verify-otp, me and logout', async () => {
  // Salva fetch original
  const origFetch = global.fetch;
  let sentResendEmails = [];

  global.fetch = async (url, opts) => {
    if (String(url).includes('api.resend.com')) {
      const body = JSON.parse(opts.body);
      sentResendEmails.push(body);
      return {
        ok: true,
        json: async () => ({ id: 'resend_mock_id_123' })
      };
    }
    return origFetch(url, opts);
  };

  try {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'concreto-auth-test-'));
    process.env.DATABASE_PATH = path.join(temp, 'test.sqlite');
    process.env.PORT = '0';
    process.env.RESEND_API_KEY = 'test_key';

    const server = require('../server');
    if (!server.listening) await once(server, 'listening');
    const base = 'http://127.0.0.1:' + server.address().port;

    // 1. Tentar enviar código para domínio inválido
    const resForbidden = await origFetch(base + '/api/auth/send-code', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'usuario@gmail.com' })
    });
    assert.equal(resForbidden.status, 400);
    const jsonForbidden = await resForbidden.json();
    assert.match(jsonForbidden.error, /falcaobauer\.com\.br/);

    // 2. Enviar código para e-mail corporativo válido
    const validEmail = 'engenheiro@falcaobauer.com.br';
    const resSend = await origFetch(base + '/api/auth/send-code', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: validEmail })
    });
    assert.equal(resSend.status, 200);
    const jsonSend = await resSend.json();
    assert.equal(jsonSend.ok, true);
    assert.equal(sentResendEmails.length, 1);
    assert.equal(sentResendEmails[0].to[0], validEmail);

    // Localiza o OTP gerado no banco de dados para o teste
    const tokenRecord = await AuthToken.findOne({ email: validEmail, used: false });
    assert.ok(tokenRecord);
    const generatedOtp = tokenRecord.otp;

    // 3. Verificar com OTP incorreto
    const resBadOtp = await origFetch(base + '/api/auth/verify-otp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: validEmail, otp: '000000' })
    });
    assert.equal(resBadOtp.status, 400);

    // 4. Verificar com OTP correto
    const resGoodOtp = await origFetch(base + '/api/auth/verify-otp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: validEmail, otp: generatedOtp })
    });
    assert.equal(resGoodOtp.status, 200);
    const cookieHeader = resGoodOtp.headers.get('set-cookie');
    assert.ok(cookieHeader);
    assert.match(cookieHeader, /auth_token=/);

    // Extrai valor do cookie auth_token
    const sessionCookie = cookieHeader.split(';')[0];

    // 5. Testar /api/auth/me com o cookie de sessão
    const resMe = await origFetch(base + '/api/auth/me', {
      headers: { 'Cookie': sessionCookie }
    });
    assert.equal(resMe.status, 200);
    const jsonMe = await resMe.json();
    assert.equal(jsonMe.authenticated, true);
    assert.equal(jsonMe.user.email, validEmail);

    // 6. Logout
    const resLogout = await origFetch(base + '/api/auth/logout', {
      method: 'POST',
      headers: { 'Cookie': sessionCookie }
    });
    assert.equal(resLogout.status, 200);

    // /api/auth/me agora deve retornar authenticated: false
    const resMeAfter = await origFetch(base + '/api/auth/me', {
      headers: { 'Cookie': sessionCookie }
    });
    const jsonMeAfter = await resMeAfter.json();
    assert.equal(jsonMeAfter.authenticated, false);

    // Limpeza
    await new Promise(resolve => server.close(resolve));
    const resolved = path.resolve(temp);
    if (resolved.startsWith(path.resolve(os.tmpdir())) && path.basename(resolved).startsWith('concreto-auth-test-')) {
      fs.rmSync(resolved, { recursive: true, force: true });
    }
  } finally {
    global.fetch = origFetch;
  }
});
