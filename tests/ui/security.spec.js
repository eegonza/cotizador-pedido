import { test, expect } from '@playwright/test';

// Solo se usan valores ficticios; ninguna prueba requiere contraseñas reales.
const exampleUser = 'security_fixture_user';
const examplePassword = 'security-fixture-not-a-real-password';

async function blockApplication(page, guardToo = false) {
  await page.route(/\/src\/app\.js(?:\?|$)/, route => route.abort());
  if (guardToo) await page.route('**/form-safety.js', route => route.abort());
  await page.goto('/');
}

async function expectNativeSubmissionBlocked(page, formId) {
  const navigations = [];
  page.on('request', request => {
    if (request.isNavigationRequest()) navigations.push(request.method());
  });
  const blocked = page.waitForEvent('console', {
    predicate: message => message.type() === 'error' && message.text().includes('form-action'),
  });
  // submit() omite los manejadores JavaScript: la barrera HTML debe impedirlo.
  await page.locator('#' + formId).evaluate(form => HTMLFormElement.prototype.submit.call(form));
  await blocked;
  expect(navigations).toEqual([]);
  const url = new URL(page.url());
  expect(url.searchParams.has('username')).toBe(false);
  expect(url.searchParams.has('password')).toBe(false);
}

test('Un módulo de acceso que no carga mantiene los controles bloqueados y cancela el envío', async ({ page }) => {
  await blockApplication(page);
  await expect(page.locator('#login-username')).toBeDisabled();
  await expect(page.locator('#login-password')).toBeDisabled();
  await expect(page.locator('#login-submit')).toBeDisabled();
  await expect(page.locator('#login-status')).toContainText('No se pudo cargar el acceso');
  const result = await page.evaluate(() => {
    let prevented = false;
    const form = document.getElementById('login-form');
    form.addEventListener('submit', event => { prevented = event.defaultPrevented; }, { once: true });
    form.requestSubmit();
    return { prevented, hasQuery: location.search !== '' };
  });
  expect(result).toEqual({ prevented: true, hasQuery: false });
});

test('Un fallo durante la inicialización tampoco habilita el acceso ni envía credenciales', async ({ page }) => {
  await page.addInitScript(() => { Object.defineProperty(Crypto.prototype, 'randomUUID', { value: undefined }); });
  await page.goto('/');
  await expect(page.locator('#login-submit')).toBeDisabled();
  await expect(page.locator('#login-password')).toBeDisabled();
  await expect(page.locator('#login-status')).toContainText('No se pudo cargar el acceso');
  await expectNativeSubmissionBlocked(page, 'login-form');
});

test('Sin JavaScript, el HTML impide publicar credenciales mediante un formulario nativo', async ({ browser, baseURL }) => {
  const context = await browser.newContext({ javaScriptEnabled: false, baseURL });
  try {
    const page = await context.newPage(); await page.goto('/');
    await expect(page.locator('#login-submit')).toBeDisabled();
    await expect(page.locator('#login-username')).not.toHaveAttribute('name');
    await expect(page.locator('#login-password')).not.toHaveAttribute('name');
    await expect(page.locator('#login-form')).toHaveAttribute('method', 'post');
    await expectNativeSubmissionBlocked(page, 'login-form');
  } finally { await context.close(); }
});

test('Aunque no cargue ningún script, CSP bloquea un envío directo con campos nombrados', async ({ page }) => {
  await blockApplication(page, true);
  await page.evaluate(({ username, password }) => {
    const user = document.getElementById('login-username');
    const pass = document.getElementById('login-password');
    user.disabled = false; user.name = 'username'; user.value = username;
    pass.disabled = false; pass.name = 'password'; pass.value = password;
  }, { username: exampleUser, password: examplePassword });
  await expectNativeSubmissionBlocked(page, 'login-form');
});

for (const formId of ['login-form', 'user-form', 'password-form']) {
  test(`El formulario ${formId} impide la navegación nativa`, async ({ page }) => {
    await blockApplication(page);
    await expect(page.locator('#' + formId)).toHaveAttribute('method', 'post');
    await expectNativeSubmissionBlocked(page, formId);
  });
}

test('Una URL heredada se limpia sin reenviar sus credenciales como Referer a los recursos', async ({ page }) => {
  const resourceReferrers = [];
  page.on('request', request => {
    if (!request.isNavigationRequest()) resourceReferrers.push(Boolean(request.headers().referer));
  });
  await page.route(/\/src\/app\.js(?:\?|$)/, route => route.abort());
  const query = new URLSearchParams({ USERNAME: exampleUser, password: examplePassword, campana: 'prueba' });
  query.append('password', examplePassword);
  await page.goto('/?' + query + '#inicio');
  await expect.poll(() => new URL(page.url()).search).toBe('?campana=prueba');
  expect(new URL(page.url()).hash).toBe('#inicio');
  expect(resourceReferrers.length).toBeGreaterThan(0);
  expect(resourceReferrers.every(present => !present)).toBe(true);
  await expect(page.locator('meta[name="referrer"]')).toHaveAttribute('content', 'no-referrer');
});
