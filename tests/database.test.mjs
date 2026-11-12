import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';

let db;
const legacyQuoteId = randomUUID();
const beforeDiscountId = randomUUID();
const ids = { admin: '11111111-1111-4111-8111-111111111111', seller: '22222222-2222-4222-8222-222222222222', other: '33333333-3333-4333-8333-333333333333' };
before(async () => {
  db = new PGlite();
  await db.exec(`create role anon; create role authenticated; create role service_role;
    create schema auth; create table auth.users(id uuid primary key,email text,raw_user_meta_data jsonb default '{}');
    create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
    grant usage on schema auth to authenticated; grant execute on function auth.uid() to authenticated;`);
  await db.exec(await readFile(new URL('../supabase/migrations/202610090001_cotizador.sql', import.meta.url), 'utf8'));
  for (const [username, id] of Object.entries(ids)) await db.query('insert into auth.users(id,email,raw_user_meta_data) values($1,$2,$3)', [id, `${username}@usuarios.cotizador.invalid`, JSON.stringify({ display_name: username, role: 'admin', active: true })]);
  await asService('select public.bootstrap_admin($1)', [ids.admin]);
  for (const key of ['seller', 'other']) await asService("select public.admin_set_profile($1,$2,'seller',true,$3)", [ids.admin, ids[key], key]);
  await save(ids.seller, legacyQuoteId, 0, payload('60000'));
  await db.exec(await readFile(new URL('../supabase/migrations/202610110002_envio_fijo.sql', import.meta.url), 'utf8'));
  await db.exec(await readFile(new URL('../supabase/migrations/202610110003_reportes.sql', import.meta.url), 'utf8'));
  await db.exec(await readFile(new URL('../supabase/migrations/202610190001_borrar_cotizaciones.sql', import.meta.url), 'utf8'));
  await db.exec(await readFile(new URL('../supabase/migrations/202610190002_varios_bultos.sql', import.meta.url), 'utf8'));
  await save(ids.seller, beforeDiscountId, 0, payload());
  await db.exec(await readFile(new URL('../supabase/migrations/202611120001_descuentos_productos.sql', import.meta.url), 'utf8'));
});
after(async () => { await db.close(); });
function asRole(role, id, sql, params = []) {
  return db.transaction(async tx => {
    await tx.exec(`set local role ${role}`);
    await tx.query("select set_config('request.jwt.claim.sub', $1, true)", [id || '']);
    return tx.query(sql, params);
  });
}
const asUser = (id, sql, params) => asRole('authenticated', id, sql, params);
const asService = (sql, params) => asRole('service_role', null, sql, params);
function payload(rate = '50000', customer = 'Cliente de prueba', items = [{ description: 'Producto', unit_price_cents: '1000', quantity: 2, tax_exempt: false }], weight = '5000000') {
  return { customer_name: customer, exchange_rate_cents: rate, weight_micros: weight, items };
}
async function save(owner, id, revision, data) {
  return (await asUser(owner, 'select public.save_quote($1,$2,$3) as quote', [id, revision, JSON.stringify(data)])).rows[0].quote;
}
test('Las seis tablas tienen RLS y las cuentas no heredan roles de metadata', async () => {
  const tables = (await db.query("select relname,relrowsecurity from pg_class where relname in ('profiles','clients','quotes','quote_items','quote_revisions','audit_events')")).rows;
  assert.equal(tables.length, 6); assert.ok(tables.every(t => t.relrowsecurity));
  const id = randomUUID(); await db.query('insert into auth.users(id,email,raw_user_meta_data) values($1,$2,$3)', [id, 'nuevo@usuarios.cotizador.invalid', '{"role":"admin","active":true}']);
  const profile = (await db.query('select role,active from public.profiles where id=$1', [id])).rows[0];
  assert.equal(profile.role, 'seller'); assert.equal(profile.active, false);
});
test('Se conservan los tres cálculos originales; el servidor ignora totales manipulados', async () => {
  const examples = [
    [payload(), '3500', '1750000'],
    [payload('50000', 'Cliente dos', [{ unit_price_cents: '2000', quantity: 2 }, { unit_price_cents: '500', quantity: 3 }], '15000000'), '8500', '4250000'],
    [payload('50000', 'Cliente tres', [{ unit_price_cents: '10000', quantity: 1 }], '25000000'), '14000', '7000000']
  ];
  for (const [input, usd, crc] of examples) {
    input.total_usd_cents = '0'; input.total_crc_cents = '0';
    const q = await save(ids.seller, randomUUID(), 0, input);
    assert.equal(q.snapshot.total_usd_cents, usd); assert.equal(q.snapshot.total_crc_cents, crc);
    assert.equal(q.owner_id, ids.seller); assert.match(q.number, /^COT-/);
  }
});
test('Reintentos del mismo ID no crean duplicados ni revisiones falsas', async () => {
  const id = randomUUID(); const input = payload('60000', 'Idempotente');
  const a = await save(ids.seller, id, 0, input); const b = await save(ids.seller, id, 0, input);
  assert.equal(a.id, b.id); assert.equal(a.revision, b.revision);
  assert.equal((await db.query('select count(*)::int as n from public.quotes where id=$1', [id])).rows[0].n, 1);
  assert.equal((await db.query('select count(*)::int as n from public.quote_revisions where quote_id=$1', [id])).rows[0].n, 1);
});
test('El servidor fija el envío por peso y convierte solo productos aunque el cliente envíe otros importes', async () => {
  for (const rate of ['60000', '70000']) {
    for (const [weight, shipping] of [['0', '750000'], ['10000000', '750000'], ['10000001', '1500000'], ['20000000', '1500000'], ['20000001', '2000000']]) {
      const input = payload(rate, 'Envío fijo', undefined, weight);
      input.shipping_crc_cents = '0'; input.total_crc_cents = '0'; input.shipping_pricing_version = 1;
      const q = await save(ids.seller, randomUUID(), 0, input);
      assert.equal(q.snapshot.shipping_crc_cents, shipping);
      assert.equal(q.snapshot.total_crc_cents, (2000n * BigInt(rate) / 100n + BigInt(shipping)).toString());
      assert.equal(q.snapshot.shipping_pricing_version, 3);
    }
  }
});
test('Usuarios duplicados, incluso con mayúsculas, se rechazan en la base', async () => {
  await assert.rejects(() => db.query('insert into auth.users(id,email) values($1,$2)', [randomUUID(), 'SELLER@usuarios.cotizador.invalid']), error => error.code === '23505');
});
test('La actualización conserva cotizaciones antiguas y registra nuevas tarifas solo al guardar otra revisión', async () => {
  const old = (await asUser(ids.seller, 'select public.get_quote($1) as q', [legacyQuoteId])).rows[0].q;
  assert.equal(old.snapshot.total_crc_cents, '2100000');
  assert.equal(old.revision, 1);
  assert.equal(old.revisions.length, 1);
  const updated = await save(ids.seller, legacyQuoteId, 1, payload('60000'));
  assert.equal(updated.snapshot.total_crc_cents, '1950000');
  assert.equal(updated.snapshot.shipping_crc_cents, '750000');
  assert.equal(updated.revision, 2);
  const detail = (await asUser(ids.seller, 'select public.get_quote($1) as q', [legacyQuoteId])).rows[0].q;
  assert.equal(detail.revisions[0].previous_snapshot.total_crc_cents, '2100000');
});
test('Cliente, exenciones y tipos de cambio históricos conservan versiones anteriores', async () => {
  const id = randomUUID(); await save(ids.seller, id, 0, payload());
  const changed = payload('60000', 'María González'); changed.items[0].tax_exempt = true;
  const updated = await save(ids.seller, id, 1, changed);
  assert.equal(updated.snapshot.total_crc_cents, '1950000'); assert.equal(updated.customer_name, 'María González');
  assert.equal(updated.snapshot.items[0].tax_exempt, true);
  const detail = (await asUser(ids.seller, 'select public.get_quote($1) as quote', [id])).rows[0].quote;
  assert.equal(detail.revisions.length, 2); assert.equal(detail.revisions[0].previous_snapshot.exchange_rate_cents, '50000');
  assert.equal(detail.revisions[0].previous_snapshot.total_crc_cents, '1750000');
  assert.equal(detail.revisions[0].previous_snapshot.customer_name, 'Cliente de prueba');
  await save(ids.seller, randomUUID(), 0, payload('70000'));
  assert.equal((await asUser(ids.seller, 'select public.get_quote($1) as q', [id])).rows[0].q.snapshot.exchange_rate_cents, '60000');
  await assert.rejects(() => save(ids.seller, id, 1, payload('80000')), error => error.code === '40001');
});
test('Vendedores ven solo sus datos; admin ve todos y nadie anónimo cotiza', async () => {
  const other = await save(ids.other, randomUUID(), 0, payload('60000', 'Cliente privado'));
  const own = (await asUser(ids.seller, 'select owner_id from public.quotes')).rows;
  assert.ok(own.length > 0); assert.ok(own.every(q => q.owner_id === ids.seller));
  await assert.rejects(() => asUser(ids.seller, 'select public.get_quote($1)', [other.id]), error => error.code === '42501');
  assert.equal((await asUser(ids.seller, 'select count(*)::int as n from public.audit_events')).rows[0].n, 0);
  assert.ok((await asUser(ids.admin, 'select count(*)::int as n from public.quotes')).rows[0].n > own.length);
  await assert.rejects(() => asRole('anon', null, 'select public.save_quote($1,0,$2)', [randomUUID(), JSON.stringify(payload())]), error => error.code === '42501');
});
test('Roles, auditoría e históricos no admiten escrituras directas de vendedores', async () => {
  await assert.rejects(() => asUser(ids.seller, "update public.profiles set role='admin' where id=$1", [ids.seller]), error => error.code === '42501');
  await assert.rejects(() => asUser(ids.seller, "select public.admin_set_profile($1,$1,'admin',true,'hack')", [ids.seller]), error => error.code === '42501');
  await assert.rejects(() => asUser(ids.seller, "insert into public.audit_events(action) values('falso')"), error => error.code === '42501');
  await assert.rejects(() => asUser(ids.admin, 'delete from public.quote_revisions'), error => error.code === '42501');
  await assert.rejects(() => asUser(ids.admin, 'update public.quotes set snapshot=\'{}\''), error => error.code === '42501');
});
test('Estados y cancelaciones generan revisiones; confirmar requiere administrador', async () => {
  const q = await save(ids.seller, randomUUID(), 0, payload());
  await assert.rejects(() => asUser(ids.seller, "select public.set_quote_status($1,'confirmed',1)", [q.id]), error => error.code === '42501');
  const confirmed = (await asUser(ids.admin, "select public.set_quote_status($1,'confirmed',1) as q", [q.id])).rows[0].q;
  assert.equal(confirmed.status, 'confirmed'); assert.equal(confirmed.revision, 2);
  await assert.rejects(() => save(ids.seller, q.id, 2, payload('60000')), /cerrada/);
  const cancelled = await save(ids.seller, randomUUID(), 0, payload());
  await asUser(ids.seller, "select public.set_quote_status($1,'cancelled',1)", [cancelled.id]);
  assert.equal((await asUser(ids.admin, "select action from public.audit_events where resource_id=$1 order by id desc limit 1", [cancelled.id])).rows[0].action, 'quote_cancelled');
});
test('Búsquedas, filtros, paginación y estadísticas usan datos autorizados', async () => {
  const first = await save(ids.seller, randomUUID(), 0, payload('60000', 'Filtro especial'));
  await save(ids.seller, randomUUID(), 0, payload('60000', 'Filtro especial dos'));
  const sql = "select public.search_quotes($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) as results";
  const result = (await asUser(ids.seller, sql, ['Filtro especial', '', '', null, null, null, 1, 1, 'asc', false])).rows[0].results;
  assert.equal(result.total, 2); assert.equal(result.rows.length, 1);
  const exact = (await asUser(ids.admin, sql, ['', 'seller', first.number, 'draft', null, null, 1, 20, 'desc', false])).rows[0].results;
  assert.equal(exact.total, 1); assert.equal(exact.rows[0].id, first.id);
  const none = (await asUser(ids.admin, sql, ['', '', '', null, '2030-01-01T05:00:00Z', '2030-01-02T05:00:00Z', 1, 20, 'desc', false])).rows[0].results;
  assert.equal(none.total, 0);
  const ownAdmin = (await asUser(ids.admin, sql, ['', '', '', null, null, null, 1, 20, 'desc', true])).rows[0].results;
  assert.equal(ownAdmin.total, 0);
  await assert.rejects(() => asUser(ids.seller, 'select public.quote_statistics()'), error => error.code === '42501');
  const stats = (await asUser(ids.admin, 'select public.quote_statistics() as s')).rows[0].s;
  assert.ok(stats.quotes > 0); assert.equal(typeof stats.total_crc_cents, 'string');
});
test('Precios, cantidades, clientes, cambio y productos inválidos se rechazan en servidor', async () => {
  const invalid = [payload('0'), payload('100000001'), payload('60000', ''), payload('60000', 'x'.repeat(121)),
    payload('60000', 'Cliente', []), payload('60000', 'Cliente', [{ unit_price_cents: '1000', quantity: 0 }]),
    payload('60000', 'Cliente', [{ unit_price_cents: '-100', quantity: 1 }]), payload('60000', 'Cliente', [{ unit_price_cents: '1e3', quantity: 1 }])];
  const missing = payload(); delete missing.items; invalid.push(missing);
  for (const input of invalid) await assert.rejects(() => save(ids.seller, randomUUID(), 0, input));
});
test('Desactivar una cuenta bloquea de inmediato un JWT aún existente', async () => {
  await asService("select public.admin_set_profile($1,$2,'seller',false,'seller')", [ids.admin, ids.seller]);
  assert.equal((await asUser(ids.seller, 'select count(*)::int as n from public.quotes')).rows[0].n, 0);
  await assert.rejects(() => save(ids.seller, randomUUID(), 0, payload()), error => error.code === '42501');
  await assert.rejects(() => asUser(ids.seller, "select public.record_session_event('login')"), error => error.code === '42501');
  await asService("select public.admin_set_profile($1,$2,'seller',true,'seller')", [ids.admin, ids.seller]);
  assert.ok((await asUser(ids.seller, 'select count(*)::int as n from public.quotes')).rows[0].n > 0);
  await assert.rejects(() => asService("select public.admin_set_profile($1,$1,'seller',false,'admin')", [ids.admin]), /administrador activo/);
});
test('Reportes semanales y mensuales separan vendedores, revisiones, cancelaciones y ventas por fecha de confirmación en Panamá', async () => {
  const first = randomUUID(), second = randomUUID(), cancelled = randomUUID();
  await save(ids.seller, first, 0, payload('60000'));
  await save(ids.admin, first, 1, payload('60000', 'Reporte', [{ description: 'Producto', unit_price_cents: '1000', quantity: 3 }]));
  await save(ids.seller, second, 0, payload('60000'));
  await save(ids.other, cancelled, 0, payload('60000'));
  await asUser(ids.admin, "select public.set_quote_status($1,'confirmed',2)", [first]);
  await asUser(ids.other, "select public.set_quote_status($1,'cancelled',1)", [cancelled]);
  // Fechas aisladas de los otros casos: domingo 23:59 y lunes 00:00 en Panamá.
  await db.query("update public.quotes set created_at='2024-10-07T04:59:00Z' where id=$1", [first]);
  await db.query("update public.quotes set created_at='2024-10-07T05:00:00Z' where id in ($1,$2)", [second, cancelled]);
  await db.query("update public.quote_revisions set created_at='2024-10-14T05:00:00Z' where quote_id=$1 and new_status='confirmed'", [first]);
  const args = ['2024-09-30T05:00:00Z', '2024-10-21T05:00:00Z'];
  const report = async period => (await asUser(ids.admin, 'select public.seller_period_report($1,$2,$3) as rows', [period, ...args])).rows[0].rows;
  const weekly = await report('week');
  const sunday = weekly.find(r => r.username === 'seller' && r.period_start === '2024-09-30');
  assert.equal(sunday.quote_count, 1); assert.equal(sunday.quoted_units, 3);
  assert.equal(sunday.total_crc_cents, '2550000'); assert.equal(sunday.sold_units, 0);
  assert.equal(weekly.find(r => r.username === 'seller' && r.period_start === '2024-10-07').quote_count, 1);
  const sales = weekly.find(r => r.username === 'seller' && r.period_start === '2024-10-14');
  assert.equal(sales.quote_count, 0); assert.equal(sales.confirmed_count, 1); assert.equal(sales.sold_units, 3);
  const other = weekly.find(r => r.username === 'other');
  assert.equal(other.quote_count, 1); assert.equal(other.total_crc_cents, '0'); assert.equal(other.quoted_units, 0);
  const monthly = (await report('month')).find(r => r.username === 'seller');
  assert.equal(monthly.period_start, '2024-10-01'); assert.equal(monthly.quote_count, 2);
  assert.equal(monthly.total_crc_cents, '4500000'); assert.equal(monthly.quoted_units, 5); assert.equal(monthly.sold_units, 3);
  await assert.rejects(() => asUser(ids.seller, 'select public.seller_period_report($1,$2,$3)', ['month', ...args]), e => e.code === '42501');
  await assert.rejects(() => report('day'), /Selecciona/);
  await assert.rejects(() => asUser(ids.admin, "select public.seller_period_report('month','2020-01-01','2024-01-01')"), /hasta un año/);
});
test('Solo un administrador activo puede borrar una cotización completa; el borrado conserva auditoría y bloquea autoguardados tardíos', async () => {
  const remove = (actor, id, revision) => asUser(actor, 'select public.delete_quote($1,$2)', [id, revision]);
  for (const status of ['draft', 'sent', 'confirmed', 'cancelled']) {
    const id = randomUUID(); const q = await save(ids.seller, id, 0, payload());
    const clientId = (await db.query('select client_id from public.quotes where id=$1', [id])).rows[0].client_id;
    let revision = q.revision;
    if (status !== 'draft') revision = (await asUser(ids.admin, 'select public.set_quote_status($1,$2,$3) as q', [id, status, revision])).rows[0].q.revision;
    await assert.rejects(() => remove(ids.seller, id, revision), e => e.code === '42501');
    await assert.rejects(() => asRole('anon', null, 'select public.delete_quote($1,$2)', [id, revision]), e => e.code === '42501');
    await assert.rejects(() => remove(randomUUID(), id, revision), e => e.code === '42501');
    await assert.rejects(() => remove(ids.admin, id, revision + 1), e => e.code === '40001');
    await remove(ids.admin, id, revision);
    for (const [table, column] of [['quotes', 'id'], ['quote_items', 'quote_id'], ['quote_revisions', 'quote_id']]) {
      assert.equal((await db.query(`select count(*)::int as n from public.${table} where ${column}=$1`, [id])).rows[0].n, 0);
    }
    assert.equal((await db.query('select count(*)::int as n from public.clients where id=$1', [clientId])).rows[0].n, 1);
    const audit = (await db.query("select actor_id,details from public.audit_events where action='quote_deleted' and resource_id=$1", [id])).rows;
    assert.equal(audit.length, 1); assert.equal(audit[0].actor_id, ids.admin);
    await assert.rejects(() => save(ids.seller, id, 0, payload()), e => e.code === 'P0002');
    await assert.rejects(() => remove(ids.admin, id, revision), e => e.code === 'P0002');
  }
});
test('Bultos de distintos pesos se suman por separado, conservan detalle y no aceptan tarifas del cliente', async () => {
  const id = randomUUID(); const input = payload('60000');
  input.weight_micros = '1';
  input.packages = ['5000000', '15000000', '25000000'].map(weight_micros => ({ weight_micros, shipping_cents: '0', shipping_crc_cents: '0' }));
  const saved = await save(ids.seller, id, 0, input);
  assert.equal(saved.snapshot.weight_micros, '45000000');
  assert.equal(saved.snapshot.package_count, 3);
  assert.deepEqual(saved.snapshot.packages.map(p => p.shipping_cents), ['1500', '3000', '4000']);
  assert.equal(saved.snapshot.shipping_cents, '8500'); assert.equal(saved.snapshot.shipping_crc_cents, '4250000');
  assert.equal(saved.snapshot.total_crc_cents, '5450000');
  assert.equal((await save(ids.seller, id, 1, input)).revision, 1);
  await assert.rejects(() => save(ids.seller, id, 1, payload('60000')), /Actualiza la página/);
  const updated = structuredClone(input); updated.packages.splice(1, 1);
  const revision = await save(ids.seller, id, 1, updated);
  assert.equal(revision.revision, 2); assert.equal(revision.snapshot.shipping_crc_cents, '2750000');
  const detail = (await asUser(ids.seller, 'select public.get_quote($1) as q', [id])).rows[0].q;
  assert.equal(detail.revisions[0].previous_snapshot.packages.length, 3);
  for (const packages of [[], null, [{ weight_micros: '-1' }], [{ weight_micros: '1000000000001' }], [{}], Array(101).fill({ weight_micros: '1' })]) {
    await assert.rejects(() => save(ids.seller, randomUUID(), 0, { ...payload(), packages }));
  }
  const zero = await save(ids.seller, randomUUID(), 0, { ...payload(), packages: [{ weight_micros: '0' }, { weight_micros: '0' }] });
  assert.equal(zero.snapshot.shipping_cents, '3000');
});
test('Descuentos se recalculan por producto, se persisten y las revisiones conservan sus importes', async () => {
  const id = randomUUID();
  const input = { ...payload(), discount_pricing_version: 1, items: [
    { description: 'Primero', unit_price_cents: '2000', quantity: 2, discount_type: 'percent', discount_value: '1000', discount_cents: '9999', subtotal_cents: '0' },
    { description: 'Segundo', unit_price_cents: '1500', quantity: 1, discount_type: 'fixed', discount_value: '' }
  ], total_usd_cents: '1', discount_cents: '10000' };
  const q = await save(ids.seller, id, 0, input);
  assert.equal(q.snapshot.original_subtotal_cents, '5500');
  assert.equal(q.snapshot.discount_cents, '400'); assert.equal(q.snapshot.subtotal_cents, '5100');
  assert.equal(q.snapshot.items[0].subtotal_cents, '3600'); assert.equal(q.snapshot.items[1].subtotal_cents, '1500');
  assert.equal(q.snapshot.total_usd_cents, '6600'); assert.equal(q.snapshot.total_crc_cents, '3300000');
  const rows = (await asUser(ids.seller, 'select discount_type,discount_value,discount_cents from public.quote_items where quote_id=$1 order by position', [id])).rows;
  assert.deepEqual(rows.map(r => [r.discount_type, String(r.discount_value), String(r.discount_cents)]), [['percent', '1000', '400'], ['fixed', '0', '0']]);
  assert.equal((await save(ids.seller, id, 1, input)).revision, 1);
  input.items[0].discount_value = '2000'; input.items[1].discount_value = '125';
  const next = await save(ids.seller, id, 1, input);
  assert.equal(next.revision, 2); assert.equal(next.snapshot.discount_cents, '925');
  const detail = (await asUser(ids.seller, 'select public.get_quote($1) as q', [id])).rows[0].q;
  assert.equal(detail.snapshot.items[1].discount_value, '125');
  assert.equal(detail.revisions[0].previous_snapshot.items[0].discount_value, '1000');
  assert.equal(detail.revisions[0].previous_snapshot.subtotal_cents, '5100');
  await assert.rejects(() => save(ids.seller, id, 2, payload()), /conservar los descuentos/);
  const copy = await save(ids.seller, randomUUID(), 0, { ...detail.snapshot });
  assert.equal(copy.snapshot.subtotal_cents, next.snapshot.subtotal_cents);
});
test('Descuentos inválidos no crean cotizaciones y los límites redondean igual que la interfaz', async () => {
  const discounted = (type, value, price = '2000', quantity = 2) => ({ ...payload(), discount_pricing_version: 1,
    items: [{ unit_price_cents: price, quantity, discount_type: type, discount_value: value }] });
  for (const [type, value] of [['percent', '-1'], ['percent', '10001'], ['percent', '10.5'], ['fixed', '4001'], ['fixed', '1e2'], ['other', '0']]) {
    const id = randomUUID(); await assert.rejects(() => save(ids.seller, id, 0, discounted(type, value)));
    assert.equal((await db.query('select count(*)::int as n from public.quotes where id=$1', [id])).rows[0].n, 0);
  }
  for (const [type, value] of [['percent', '10000'], ['fixed', '4000']]) {
    const q = await save(ids.seller, randomUUID(), 0, discounted(type, value));
    assert.equal(q.snapshot.subtotal_cents, '0'); assert.equal(q.snapshot.total_usd_cents, '1500');
  }
  const half = await save(ids.seller, randomUUID(), 0, discounted('percent', '5000', '1', 1));
  assert.equal(half.snapshot.discount_cents, '1'); assert.equal(half.snapshot.subtotal_cents, '0');
  for (const [type, value] of [['percent', '1'], ['fixed', '0']]) {
    const id = randomUUID(); const q = await save(ids.seller, id, 0, discounted(type, value, '1', 1));
    assert.equal(q.snapshot.discount_cents, '0');
    await assert.rejects(() => save(ids.seller, id, 1, payload()), /conservar los descuentos/);
  }
  const large = await save(ids.seller, randomUUID(), 0, discounted('fixed', '9998999990001', '999999999', 9999));
  assert.equal(large.snapshot.original_subtotal_cents, '9998999990001'); assert.equal(large.snapshot.subtotal_cents, '0');
  await assert.rejects(() => save(ids.seller, randomUUID(), 0, { ...discounted('percent', '1'), discount_pricing_version: 2 }), /Versión/);
});
test('La migración preserva históricos y la compatibilidad solo se consulta con cuenta activa', async () => {
  const old = (await asUser(ids.seller, 'select public.get_quote($1) as q', [beforeDiscountId])).rows[0].q;
  assert.equal(old.snapshot.discount_pricing_version, undefined); assert.equal(old.snapshot.subtotal_cents, '2000');
  const revised = await save(ids.seller, beforeDiscountId, 1, payload());
  assert.equal(revised.snapshot.discount_pricing_version, 1); assert.equal(revised.snapshot.discount_cents, '0');
  assert.equal(revised.snapshot.total_usd_cents, old.snapshot.total_usd_cents);
  const detail = (await asUser(ids.seller, 'select public.get_quote($1) as q', [beforeDiscountId])).rows[0].q;
  assert.equal(detail.revisions[0].previous_snapshot.discount_pricing_version, undefined);
  assert.equal((await asUser(ids.seller, 'select public.quote_discount_version() as version')).rows[0].version, 1);
  await assert.rejects(() => asRole('anon', null, 'select public.quote_discount_version()'), e => e.code === '42501');
  await assert.rejects(() => asUser(randomUUID(), 'select public.quote_discount_version()'), e => e.code === '42501');
});
