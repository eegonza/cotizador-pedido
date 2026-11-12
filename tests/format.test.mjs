import { test } from 'node:test';
import assert from 'node:assert/strict';
import { money, dateAndTime, dateRange, csvCell, validateCustomer, quotesCsv } from '../src/format.js';

test('Dinero conserva importes grandes sin perder centavos', () => {
  assert.equal(money('99999999999999999999999', '₡', false), '₡999,999,999,999,999,999,999.99');
  assert.equal(money('2100000', '₡', false), '₡21,000');
});
test('Fechas y rangos inclusivos se muestran en Panamá', () => {
  const when = dateAndTime('2026-10-09T04:30:00Z');
  assert.ok(when.date.includes('08')); assert.equal(when.time, '23:30:00');
  assert.deepEqual(dateRange('2026-10-08', '2026-10-08'), { p_from: '2026-10-08T05:00:00.000Z', p_to: '2026-10-09T05:00:00.000Z' });
  assert.throws(() => dateRange('2026-10-09', '2026-10-08'));
});
test('CSV neutraliza fórmulas y escapa comillas', () => {
  assert.equal(csvCell('=HYPERLINK("test")'), '"\'=HYPERLINK(""test"")"');
  assert.equal(csvCell('María, González'), '"María, González"');
});
test('Nombre del cliente exige contenido y admite acentos', () => {
  assert.equal(validateCustomer('  María González  '), 'María González');
  assert.throws(() => validateCustomer(' ')); assert.throws(() => validateCustomer('Cliente\nFalso'));
});
test('CSV conserva históricos sin campos nuevos y desglosa descuentos de pedidos recientes', () => {
  const old = { number: 'COT-1', username: 'seller', customer_name: 'Histórico', created_at: '2026-10-01T12:00:00Z', status: 'draft',
    snapshot: { product_count: 1, subtotal_cents: '4000', shipping_cents: '1500', total_usd_cents: '5500', total_crc_cents: '2750000', exchange_rate_cents: '50000' } };
  const newer = { ...old, number: 'COT-2', snapshot: { ...old.snapshot, original_subtotal_cents: '4000', discount_cents: '400', subtotal_cents: '3600', total_usd_cents: '5100', total_crc_cents: '2550000' } };
  const lines = quotesCsv([old, newer]).split('\r\n');
  assert.ok(lines[0].includes('Subtotal original USD')); assert.ok(lines[0].includes('Descuentos USD'));
  assert.ok(lines[1].includes('"$40.00","$0.00","$40.00"'));
  assert.ok(lines[2].includes('"$40.00","$4.00","$36.00"'));
  assert.ok(lines[2].includes('"₡25,500.00"'));
});
