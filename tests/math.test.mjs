import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../script.js', import.meta.url), 'utf8');
const math = vm.runInNewContext(source.slice(0, source.indexOf('const elements =')) + `\n({parsePrice,parseQuantity,parseDiscount,parseWeight,parseExchangeRate,shippingIndex,usd,crc,quoteTotalCrc,taxBreakdown,setRate(v){exchangeRateCents=BigInt(v)}})`);
test('Funciones reales del cotizador conservan los resultados comerciales', () => {
  math.setRate('50000');
  assert.equal(math.usd(3500n), '$35.00'); assert.equal(math.crc(3500n), '₡17,500.00');
  assert.equal(math.crc(8500n), '₡42,500.00'); assert.equal(math.crc(14000n), '₡70,000.00');
  math.setRate('60000'); assert.equal(math.crc(3500n), '₡21,000.00');
  math.setRate('60025'); assert.equal(math.crc(3500n), '₡21,008.75');
});
test('Solo los productos se convierten; el envío se suma en colones fijos', () => {
  for (const [rate, total] of [[50000n, 1750000n], [60000n, 1950000n], [70000n, 2150000n], [60025n, 1950500n]]) {
    assert.equal(math.quoteTotalCrc(2000n, 750000n, rate), total);
  }
  assert.equal(math.quoteTotalCrc(2000n, 1500000n, 60000n), 2700000n);
  assert.equal(math.quoteTotalCrc(2000n, 2000000n, 60000n), 3200000n);
  assert.equal(math.quoteTotalCrc(2000n, 750000n, null), null);
});
test('Fronteras de envío y entradas inválidas conservan sus validaciones', () => {
  for (const [weight, rate] of [['0', 0], ['10', 0], ['10.000001', 1], ['20', 1], ['20.000001', 2]]) assert.equal(math.shippingIndex(math.parseWeight(weight).value), rate);
  for (const raw of ['-1', 'abc', '1e3', 'Infinity', '1.001']) assert.ok(math.parsePrice(raw).error);
  for (const raw of ['0', '-1', '1.5', 'abc']) assert.ok(math.parseQuantity(raw).error);
  for (const raw of ['', '0', '-600', '600.123', '1000000.01']) assert.ok(math.parseExchangeRate(raw).error);
  assert.equal(math.parsePrice('0,10').value, 10n); assert.equal(math.parseExchangeRate('600,25').value, 60025n);
  assert.equal(math.taxBreakdown(1500n).grossCents, 1500n); assert.equal(math.taxBreakdown(1500n).ivaCents, null);
});
test('Descuentos por línea conservan centavos, límites y el ejemplo de aceptación', () => {
  const discount = math.parseDiscount('10', 'percent', 4000n);
  assert.equal(discount.value, 1000n); assert.equal(discount.cents, 400n);
  assert.equal(4000n - discount.cents + 1500n, 5100n);
  assert.equal(math.parseDiscount('12,50', 'percent', 1999n).cents, 250n);
  assert.equal(math.parseDiscount('50', 'percent', 1n).cents, 1n);
  assert.equal(math.parseDiscount('100', 'percent', 4000n).cents, 4000n);
  assert.equal(math.parseDiscount('40', 'fixed', 4000n).cents, 4000n);
  assert.equal(math.parseDiscount('1.25', 'fixed', 4000n).cents, 125n);
  assert.equal(math.parseDiscount(' ', 'fixed', 4000n).cents, 0n);
  assert.equal(math.parseDiscount('', 'percent', 4000n).value, 0n);
  for (const value of ['-1', '100.01', '1e2', '10.001', 'Infinity']) assert.ok(math.parseDiscount(value, 'percent', 4000n).error);
  for (const value of ['-0.01', '40.01', '1.001']) assert.ok(math.parseDiscount(value, 'fixed', 4000n).error);
  assert.ok(math.parseDiscount('1', 'other', 4000n).error);
  const large = 999999999n * 9999n;
  assert.equal(math.parseDiscount('99989999900.01', 'fixed', large).cents, large);
});
