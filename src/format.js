export const TIME_ZONE = 'America/Panama';
const integer = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });
export function money(cents, symbol = '$', decimals = true) {
  const n = BigInt(cents ?? 0);
  const fraction = n % 100n;
  return symbol + integer.format(n / 100n) + (decimals || fraction !== 0n ? '.' + fraction.toString().padStart(2, '0') : '');
}
export function dateAndTime(iso) {
  const date = new Date(iso);
  return {
    date: new Intl.DateTimeFormat('es-PA', { timeZone: TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit' }).format(date),
    time: new Intl.DateTimeFormat('es-PA', { timeZone: TIME_ZONE, hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(date)
  };
}
export function dateRange(from, to) {
  const start = from ? new Date(from + 'T00:00:00-05:00') : null;
  const end = to ? new Date(new Date(to + 'T00:00:00-05:00').getTime() + 86400000) : null;
  if ((start && Number.isNaN(start.getTime())) || (end && Number.isNaN(end.getTime())) || (start && end && start >= end)) {
    throw new Error('Revisa el rango de fechas.');
  }
  return { p_from: start?.toISOString() ?? null, p_to: end?.toISOString() ?? null };
}
export function csvCell(value) {
  let text = String(value ?? '');
  if (/^[\s]*[=+\-@\t\r]/.test(text)) text = "'" + text;
  return '"' + text.replaceAll('"', '""') + '"';
}
export function quotesCsv(rows) {
  const header = ['ID', 'Usuario', 'Cliente', 'Fecha (Panamá)', 'Hora (Panamá)', 'Productos', 'Subtotal original USD', 'Descuentos USD', 'Subtotal USD', 'Envío USD', 'Total USD', 'Total CRC', 'Estado', 'CRC por USD'];
  return '\ufeff' + [header, ...rows.map(q => {
    const when = dateAndTime(q.created_at); const s = q.snapshot;
    return [q.number, q.username, q.customer_name, when.date, when.time, s.product_count,
      money(s.original_subtotal_cents ?? s.subtotal_cents), money(s.discount_cents ?? '0'), money(s.subtotal_cents), money(s.shipping_cents), money(s.total_usd_cents), money(s.total_crc_cents, '₡'),
      q.status, money(s.exchange_rate_cents, '₡')];
  })].map(row => row.map(csvCell).join(',')).join('\r\n');
}
export function validateCustomer(value) {
  const name = value.trim();
  if (name.length < 1 || name.length > 120 || /[\u0000-\u001f\u007f]/.test(name)) throw new Error('Ingresa el nombre del cliente, de 1 a 120 caracteres.');
  return name;
}
