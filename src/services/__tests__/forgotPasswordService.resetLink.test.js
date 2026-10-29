// Run: node --test src/services/__tests__/forgotPasswordService.resetLink.test.js
// Offline: the database, the auth admin API and SMTP are stubbed in memory.
const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('module');

const sent = [];
const fakeAdminClient = () => ({
  auth: { admin: {
    generateLink: async () => ({ data: { properties: { hashed_token: 'T0KEN' } }, error: null }),
    listUsers: async () => ({ data: { users: [] }, error: null })
  } }
});
const stubs = {
  '../utils/postgresExecutor': {
    executeDirectSQL: async (sql, params) => {
      if (/^\s*SELECT/i.test(sql)) return { data: [{ id: 'u1', email: params[0] }] };
      return { data: [{ id: 'u1' }] }; // UPDATE auth.users ... RETURNING id
    }
  },
  // used by the tenant copies that call auth.admin.generateLink / listUsers
  '../config/database': { getDbClient: fakeAdminClient, getDbAdmin: fakeAdminClient, getSupabaseAdmin: fakeAdminClient },
  nodemailer: {
    createTransport: () => ({
      verify: async () => true,
      sendMail: async (m) => { sent.push(m); return { messageId: 'm1' }; }
    })
  }
};
const realLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (Object.prototype.hasOwnProperty.call(stubs, request)) return stubs[request];
  return realLoad.call(this, request, parent, isMain);
};

Object.assign(process.env, {
  SMTP_HOST: 'smtp.invalid', SMTP_USER: 'stub', SMTP_PASSWORD: 'stub',
  PASSWORD_RESET_REDIRECT_URL: 'https://tenant.truckast.ai/reset-password'
});
delete process.env.PASSWORD_RESET_ALLOWED_ORIGINS;

const { requestPasswordReset } = require('../forgotPasswordService');
const links = (html) => [...String(html).matchAll(/https?:\/\/[^"'\s<>]+/g)].map((m) => m[0]);

test('attacker redirect_url is ignored: the e-mailed link uses the configured host', async () => {
  const r = await requestPasswordReset('victim1@example.com', 'https://evil.example/reset-password');
  assert.equal(r.success, true);
  const html = sent.at(-1).html;
  assert.ok(!html.includes('evil.example'), 'attacker host must not appear in the e-mail');
  assert.ok(links(html).some((l) => l.startsWith('https://tenant.truckast.ai/reset-password?token=')));
});

test('no redirect_url (admin federated flow): configured host, unchanged behaviour', async () => {
  const r = await requestPasswordReset('victim2@example.com');
  assert.equal(r.success, true);
  assert.ok(links(sent.at(-1).html).some((l) => l.startsWith('https://tenant.truckast.ai/reset-password?token=')));
});

test('redirect_url on the tenant origin is still honoured', async () => {
  const r = await requestPasswordReset('victim3@example.com', 'https://tenant.truckast.ai/auth/reset');
  assert.equal(r.success, true);
  assert.ok(links(sent.at(-1).html).some((l) => l.startsWith('https://tenant.truckast.ai/auth/reset?token=')));
});
