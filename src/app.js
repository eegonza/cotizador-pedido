import '../script.js';
import * as api from './backend.js';
import { money, dateAndTime, dateRange, quotesCsv, validateCustomer, TIME_ZONE } from './format.js';

const $ = id => document.getElementById(id);
const state = { profile: null, view: 'quote', id: crypto.randomUUID(), revision: 0, saved: '', saving: null,
  timer: null, hydrating: false, epoch: 0, quotesPage: 1, quotesTotal: 0, allQuotes: false,
  auditPage: 1, auditTotal: 0, users: [], detail: null, reportRequest: 0, deletingId: null };
const labels = { draft: 'Borrador', sent: 'Enviada', confirmed: 'Confirmada', cancelled: 'Cancelada', admin: 'Administrador', seller: 'Vendedor' };
const actionLabels = { login: 'Inicio de sesión', logout: 'Cierre de sesión', quote_created: 'Cotización creada', quote_updated: 'Cotización modificada',
  quote_cancelled: 'Cotización cancelada', quote_deleted: 'Cotización eliminada', quote_status_changed: 'Cambio de estado', user_created: 'Usuario creado', user_updated: 'Usuario modificado',
  user_deactivated: 'Usuario desactivado', user_reactivated: 'Usuario reactivado', password_reset: 'Contraseña restablecida',
  password_reset_requested: 'Restablecimiento solicitado', admin_bootstrapped: 'Administrador inicial creado', user_provisioned: 'Cuenta técnica creada (inactiva)' };

function status(id, text, error = false) { $(id).textContent = text; $(id).classList.toggle('error', error); }
function updateSaveButton(saving = Boolean(state.saving)) {
  $('save-quote').setAttribute('aria-busy', String(saving));
  $('save-quote').textContent = saving ? 'Guardando…' : 'Guardar pedido';
  $('save-quote').disabled = saving || state.id === state.deletingId;
}
function saveStatus(text, kind = 'idle') {
  status('save-status', text, kind === 'error');
  $('save-quote').closest('.summary').dataset.saveState = kind;
  updateSaveButton(kind === 'saving' || Boolean(state.saving));
}
function focusInvalidField() {
  const invalid = $('quote-view').querySelector('[aria-invalid="true"]');
  if (invalid) { invalid.focus(); invalid.scrollIntoView({ block: 'center', behavior: 'auto' }); }
}
let messageScope = null;
function message(text, error = false, scope = null) { messageScope = text ? scope : null; $('app-message').hidden = !text; status('app-message', text, error); }
function cell(row, text) { const td = document.createElement('td'); td.textContent = String(text ?? ''); row.append(td); return td; }
function labelTableRows(body) {
  const labels = [...body.closest('table').querySelectorAll('thead th')].map(th => th.textContent);
  for (const row of body.rows) [...row.cells].forEach((td, index) => { td.dataset.label = labels[index] || ''; });
}
function button(text, action) { const b = document.createElement('button'); b.type = 'button'; b.className = 'small-button'; b.textContent = text; b.addEventListener('click', () => run(action)); return b; }
async function run(action, scope = null) { try { await action(); } catch (error) { message(error.message || 'No se pudo completar la operación.', true, scope); } }
function clearPrivateData() {
  state.epoch++; state.profile = null; state.id = crypto.randomUUID(); state.revision = 0; state.saved = ''; state.users = []; state.detail = null;
  clearTimeout(state.timer); state.hydrating = true; $('customer-name').value = ''; window.Cotizador.clearQuote(); state.hydrating = false;
  $('toast').hidden = true;
  for (const id of ['quotes-body', 'users-body', 'audit-body', 'stats-grid', 'seller-report-body', 'quote-detail-content', 'quote-detail-actions']) $(id).replaceChildren();
  status('seller-report-status', '');
  $('event-detail-content').textContent = ''; $('login-password').value = ''; $('user-password').value = ''; $('reset-password').value = '';
  $('quote-filters').reset(); $('audit-filters').reset(); resetUserForm();
  document.querySelectorAll('dialog[open]').forEach(dialog => dialog.close());
  document.querySelectorAll('[data-admin]').forEach(el => { el.hidden = true; });
  for (const id of ['quote-view', 'history-view', 'users-view', 'audit-view', 'app-toolbar', 'mobile-total', 'exchange-control']) $(id).hidden = true;
  $('login-view').hidden = false; $('session-name').textContent = ''; message('');
  saveStatus('Completa el cliente, los productos y el peso para guardar automáticamente.');
}
async function activateSession(session) {
  if (!session) { clearPrivateData(); return; }
  const epoch = state.epoch;
  const profile = await api.profile(session.user.id);
  if (epoch !== state.epoch) return;
  if (!profile.active) {
    await api.supabase.auth.signOut({ scope: 'local' }); api.clearLocalSession(); clearPrivateData();
    status('login-status', 'Cuenta desactivada. Contacta al administrador.', true); return;
  }
  if (state.profile && state.profile.id !== profile.id) clearPrivateData();
  const roleChanged = state.profile && state.profile.role !== profile.role;
  const first = !state.profile;
  state.profile = profile; $('login-view').hidden = true; $('app-toolbar').hidden = false;
  $('session-name').textContent = `${profile.display_name} · ${labels[profile.role]}`;
  document.querySelectorAll('[data-admin]').forEach(el => { el.hidden = profile.role !== 'admin'; });
  if (first) { state.id = crypto.randomUUID(); state.revision = 0; state.saved = ''; showView('quote'); }
  if (roleChanged) { state.allQuotes = false; $('quotes-body').replaceChildren(); $('audit-body').replaceChildren(); $('users-body').replaceChildren(); $('stats-grid').replaceChildren(); $('seller-report-body').replaceChildren(); status('seller-report-status', ''); state.users = []; showView('quote'); }
  if (profile.role !== 'admin' && ['users', 'audit'].includes(state.view)) showView('quote');
}
function showView(view) {
  if (!state.profile?.active) return;
  if (['audit', 'users'].includes(view) && state.profile.role !== 'admin') return;
  state.view = view;
  for (const name of ['quote', 'history', 'audit', 'users']) $(name + '-view').hidden = name !== view;
  $('exchange-control').hidden = view !== 'quote'; $('mobile-total').hidden = view !== 'quote';
  document.querySelectorAll('[data-view]').forEach(b => { b.classList.toggle('active', b.dataset.view === view); });
  if (view === 'history') run(loadQuotes);
  if (view === 'audit') { run(loadAudit); run(loadSellerReport); }
  if (view === 'users') run(loadUsers);
}
function payload() {
  const snapshot = window.Cotizador.getSnapshot();
  if (!snapshot) return null;
  return { ...snapshot, customer_name: validateCustomer($('customer-name').value) };
}
function updateCustomerValidity(show = false) {
  let error = '';
  try { validateCustomer($('customer-name').value); } catch (e) { if (show || $('customer-name').value) error = e.message; }
  $('customer-error').hidden = !error; $('customer-error').textContent = error;
  $('customer-name').setAttribute('aria-invalid', error ? 'true' : 'false');
  $('copy-summary').disabled ||= !$('customer-name').value.trim() || Boolean(error);
}
function queueSave() {
  if (!state.profile || state.hydrating || state.id === state.deletingId) return;
  updateCustomerValidity(); clearTimeout(state.timer);
  let next; try { next = payload(); } catch { saveStatus('Completa correctamente los datos del cliente.', 'error'); return; }
  if (!next) {
    if ($('quote-view').querySelector('[aria-invalid="true"]')) saveStatus('Corrige los campos marcados antes de guardar.', 'error');
    return;
  }
  if (JSON.stringify(next) === state.saved) {
    if (messageScope === 'save') message('');
    if (!state.saving) saveStatus(`${$('editing-number').textContent} guardada · revisión ${state.revision}.`, 'success');
    return;
  }
  if (!state.saving) saveStatus('Cambios pendientes; se guardarán automáticamente…', 'pending');
  state.timer = setTimeout(() => { run(() => flushSave(), 'save'); }, 900);
}
async function flushSave(required = false) {
  clearTimeout(state.timer);
  if (!state.profile) throw new Error('Inicia sesión para guardar.');
  if (state.id === state.deletingId) throw new Error('La cotización se está eliminando.');
  if (state.saving) { await state.saving; return flushSave(required); }
  if (required) { window.Cotizador.validate(); updateCustomerValidity(true); clearTimeout(state.timer); }
  let next;
  try { next = payload(); } catch (error) { if (required) { updateCustomerValidity(true); throw error; } return; }
  if (!next) { if (required) throw new Error('Completa al menos un producto válido y el peso de cada bulto.'); return; }
  const hash = JSON.stringify(next);
  if (hash === state.saved) { if (messageScope === 'save') message(''); return; }
  const id = state.id; const epoch = state.epoch; const revision = state.revision;
  saveStatus('Guardando pedido…', 'saving');
  state.saving = (async () => {
    try {
      const saved = await api.saveQuote(id, revision, next);
      if (epoch !== state.epoch || state.id !== id) return;
      state.revision = saved.revision; state.saved = hash;
      $('editing-number').textContent = saved.number;
      saveStatus(`${saved.number} guardada · revisión ${saved.revision}.`, 'success');
      if (messageScope === 'save') message('');
    } catch (error) {
      if (epoch === state.epoch) saveStatus(error.code === 'P0002' ? 'Esta cotización fue eliminada. Pulsa Limpiar cotización para comenzar otra.' : error.code === '40001' ? 'Otra sesión modificó esta cotización. Abre su versión actual desde el historial antes de editar.' : 'No se pudo guardar. Tus datos siguen en el formulario; pulsa Guardar pedido para reintentar.', 'error');
      throw error;
    } finally { state.saving = null; updateSaveButton(); }
  })();
  await state.saving;
  if (epoch === state.epoch && state.id === id) queueSave();
}
async function newQuote() {
  try { await flushSave(); } catch (error) { if (error.code !== 'P0002') throw error; }
  resetQuote();
}
function resetQuote() {
  clearTimeout(state.timer); state.hydrating = true;
  state.id = crypto.randomUUID(); state.revision = 0; state.saved = ''; $('customer-name').value = '';
  window.Cotizador.clearQuote(); $('editing-number').textContent = 'Nueva cotización';
  saveStatus('Completa el cliente, los productos y el peso para guardar automáticamente.');
  updateCustomerValidity(); state.hydrating = false;
}
async function deleteQuote(q, control) {
  if (state.profile?.role !== 'admin' || !state.profile.active) throw new Error('Administrador activo requerido.');
  if (state.deletingId) throw new Error('Espera a que termine la eliminación actual.');
  if (!window.confirm(`¿Eliminar definitivamente ${q.number} del cliente ${q.customer_name}? Se borrarán la cotización, sus productos y sus revisiones. Quedará constancia en Auditoría. Esta acción no se puede deshacer.`)) return;
  const epoch = state.epoch; state.deletingId = q.id; control.disabled = true;
  try {
    if (state.id === q.id) {
      clearTimeout(state.timer); $('save-quote').disabled = true;
      if (state.saving) await state.saving;
      q.revision = Math.max(q.revision, state.revision);
    }
    if (epoch !== state.epoch) return;
    await api.deleteQuote(q.id, q.revision);
    if (epoch !== state.epoch) return;
    if (state.id === q.id) resetQuote();
    state.detail = null; $('quote-detail-dialog').close(); state.quotesPage = 1;
    message(''); window.Cotizador.showToast('Cotización eliminada.');
    await Promise.all([loadQuotes(), loadAudit(), loadSellerReport()]);
  } catch (error) { if (epoch === state.epoch) throw error; }
  finally {
    state.deletingId = null; control.disabled = false; $('save-quote').disabled = Boolean(state.saving);
  }
}
function filters(page = state.quotesPage, size = 20) {
  return { p_customer: $('filter-customer').value.trim(), p_username: state.allQuotes ? $('filter-user').value.trim() : state.profile.username,
    p_number: $('filter-number').value.trim(), p_status: $('filter-status').value || null,
    ...dateRange($('filter-from').value, $('filter-to').value), p_page: page, p_page_size: size, p_sort: $('filter-sort').value, p_own_only: !state.allQuotes };
}
async function loadQuotes() {
  status('history-status', 'Cargando cotizaciones…');
  const epoch = state.epoch; const data = await api.searchQuotes(filters()); if (epoch !== state.epoch) return;
  state.quotesTotal = data.total; $('quotes-body').replaceChildren();
  for (const q of data.rows) {
    const row = document.createElement('tr'); const s = q.snapshot; const when = dateAndTime(q.created_at);
    [q.number, q.username, q.customer_name, when.date, when.time, s.product_count, money(s.subtotal_cents),
      money(s.shipping_cents), money(s.total_usd_cents), money(s.total_crc_cents, '₡', true), labels[q.status]].forEach(v => cell(row, v));
    cell(row, '').append(button('Ver detalles', () => openQuote(q.id))); $('quotes-body').append(row);
  }
  labelTableRows($('quotes-body'));
  status('history-status', data.total ? `${data.total} cotizaciones encontradas. Fechas y horas de Panamá.` : 'No hay cotizaciones con esos filtros.');
  $('quotes-page').textContent = `Página ${state.quotesPage} de ${Math.max(1, Math.ceil(data.total / 20))}`;
  $('quotes-prev').disabled = state.quotesPage <= 1; $('quotes-next').disabled = state.quotesPage * 20 >= data.total;
}
async function exportQuotes() {
  const epoch = state.epoch;
  $('export-quotes').disabled = true; status('history-status', 'Preparando todos los resultados filtrados…');
  try {
    const rows = []; let page = 1; let total = 0;
    do { const data = await api.searchQuotes(filters(page++, 100)); if (epoch !== state.epoch) return; rows.push(...data.rows); total = data.total; if (!data.rows.length) break; } while (rows.length < total);
    const url = URL.createObjectURL(new Blob([quotesCsv(rows)], { type: 'text/csv;charset=utf-8;' }));
    const link = document.createElement('a'); link.href = url; link.download = 'cotizaciones.csv'; link.click(); URL.revokeObjectURL(url);
    status('history-status', `${rows.length} cotizaciones exportadas.`);
  } finally { $('export-quotes').disabled = false; }
}
function paragraph(parent, text, className = '') { const p = document.createElement('p'); p.textContent = text; p.className = className; parent.append(p); return p; }
async function openQuote(id) {
  const epoch = state.epoch;
  const q = await api.getQuote(id); if (epoch !== state.epoch || !state.profile) return;
  state.detail = q; const s = q.snapshot; const when = dateAndTime(q.created_at);
  $('quote-detail-title').textContent = q.number; const content = $('quote-detail-content'); content.replaceChildren();
  paragraph(content, `Cliente: ${q.customer_name}`); paragraph(content, `Usuario: ${q.username}`);
  paragraph(content, `${when.date} · ${when.time} (Panamá) · ${labels[q.status]} · revisión ${q.revision}`);
  paragraph(content, `Cambio de esta cotización: $1 USD = ${money(s.exchange_rate_cents, '₡', true)} CRC.`, 'detail-rate');
  const wrapper = document.createElement('div'); wrapper.className = 'data-table-wrapper'; const table = document.createElement('table'); table.className = 'data-table';
  const thead = document.createElement('thead'); const head = document.createElement('tr');
  ['Producto', 'Cantidad', 'Precio USD', 'Subtotal original USD', 'Descuento USD', 'Total USD', 'Exento'].forEach(label => { const th = document.createElement('th'); th.textContent = label; head.append(th); });
  thead.append(head); table.append(thead); const tbody = document.createElement('tbody');
  for (const item of s.items) {
    const row = document.createElement('tr');
    [item.description, item.quantity, money(item.unit_price_cents), money(item.original_subtotal_cents ?? item.subtotal_cents),
      money(item.discount_cents ?? '0'), money(item.subtotal_cents), item.tax_exempt ? 'Sí' : 'No'].forEach(v => cell(row, v)); tbody.append(row);
  }
  table.append(tbody); wrapper.append(table); content.append(wrapper);
  labelTableRows(tbody);
  paragraph(content, `Peso: ${Number(s.weight_micros) / 1000000} kg · ${s.shipping_rate_label}`);
  const shippingCrc = s.shipping_crc_cents ?? ((BigInt(s.shipping_cents) * BigInt(s.exchange_rate_cents) + 50n) / 100n).toString();
  paragraph(content, `Subtotal: ${money(s.subtotal_cents)} · Envío: ${money(s.shipping_cents)} / ${money(shippingCrc, '₡', true)}`);
  paragraph(content, `Subtotal original: ${money(s.original_subtotal_cents ?? s.subtotal_cents)} · Descuentos individuales: ${money(s.discount_cents ?? '0')}`);
  if (s.packages) s.packages.forEach((p, i) => paragraph(content, `Bulto ${i + 1}: ${Number(p.weight_micros) / 1000000} kg · ${money(p.shipping_cents)} / ${money(p.shipping_crc_cents, '₡', true)}`));
  paragraph(content, `TOTAL: ${money(s.total_usd_cents)} USD / ${money(s.total_crc_cents, '₡', true)} CRC`, 'detail-total');
  paragraph(content, s.tax_note);
  const changes = document.createElement('details'); const summary = document.createElement('summary'); summary.textContent = 'Historial de revisiones y valores anteriores'; changes.append(summary);
  for (const revision of q.revisions) {
    const entry = document.createElement('details'); const title = document.createElement('summary'); const date = dateAndTime(revision.created_at);
    title.textContent = `Revisión ${revision.revision} · ${revision.actor_username} · ${date.date} ${date.time}`; entry.append(title);
    const pre = document.createElement('pre'); pre.textContent = JSON.stringify({ estado_anterior: revision.previous_status, estado_nuevo: revision.new_status,
      datos_anteriores: revision.previous_snapshot, datos_nuevos: revision.new_snapshot }, null, 2); entry.append(pre); changes.append(entry);
  }
  content.append(changes); const actions = $('quote-detail-actions'); actions.replaceChildren();
  if (['draft', 'sent'].includes(q.status)) actions.append(button('Editar cotización', () => editQuote(q, false)));
  actions.append(button('Crear copia nueva', () => editQuote(q, true)));
  const select = document.createElement('select'); select.setAttribute('aria-label', 'Nuevo estado');
  const permitted = state.profile.role === 'admin' ? Object.keys(labels).slice(0, 4) : q.status === 'draft' || q.status === 'sent' ? ['draft', 'sent', 'cancelled'] : [q.status];
  for (const value of permitted) { const option = document.createElement('option'); option.value = value; option.textContent = labels[value]; option.selected = value === q.status; select.append(option); }
  actions.append(select, button('Cambiar estado', async () => {
    if (state.id === q.id) { await flushSave(); q.revision = state.revision; }
    const changed = await api.setStatus(q.id, select.value, q.revision);
    if (state.id === q.id) { state.revision = changed.revision; if (['confirmed', 'cancelled'].includes(changed.status)) await newQuote(); }
    await openQuote(q.id); await loadQuotes();
  }));
  if (state.profile.role === 'admin') {
    const remove = button('Eliminar cotización', () => deleteQuote(q, remove));
    remove.classList.add('danger-button'); actions.append(remove);
  }
  if (!$('quote-detail-dialog').open) $('quote-detail-dialog').showModal();
}
async function editQuote(q, copy) {
  await flushSave(); if (!copy) q = await api.getQuote(q.id); state.hydrating = true;
  state.id = copy ? crypto.randomUUID() : q.id; state.revision = copy ? 0 : q.revision;
  $('customer-name').value = q.customer_name; window.Cotizador.loadSnapshot(q.snapshot);
  const legacyPricing = q.snapshot.shipping_pricing_version !== 3 || q.snapshot.discount_pricing_version !== 1;
  state.saved = copy || legacyPricing ? '' : JSON.stringify(payload()); $('editing-number').textContent = copy ? 'Copia nueva' : q.number;
  saveStatus(copy ? 'La copia se guardará como una cotización nueva.' : legacyPricing ? `${q.number} cargada con las tarifas actuales; pulsa Guardar pedido para registrar una nueva revisión.` : `${q.number} cargada; los cambios crearán una nueva revisión.`);
  state.hydrating = false; $('quote-detail-dialog').close(); showView('quote'); updateCustomerValidity(); if (copy) queueSave();
}
async function loadSellerReport() {
  if (state.profile?.role !== 'admin') return;
  const epoch = state.epoch; const request = ++state.reportRequest;
  status('seller-report-status', 'Cargando reporte…');
  $('seller-report-body').replaceChildren();
  try {
    const dates = dateRange($('report-from').value, $('report-to').value);
    const rows = await api.result(api.supabase.rpc('seller_period_report', { p_period: $('report-period').value, ...dates }));
    if (epoch !== state.epoch || request !== state.reportRequest || state.profile?.role !== 'admin') return;
    for (const entry of rows) {
      const row = document.createElement('tr');
      const start = dateAndTime(entry.period_start + 'T12:00:00-05:00').date;
      const end = dateAndTime(entry.period_end + 'T12:00:00-05:00').date;
      [start + ' – ' + end, `${entry.seller_name} (${entry.username})`, entry.quote_count,
        money(entry.total_usd_cents), money(entry.total_crc_cents, '₡', true), entry.quoted_units,
        entry.confirmed_count, entry.sold_units].forEach(value => cell(row, value));
      $('seller-report-body').append(row);
    }
    labelTableRows($('seller-report-body'));
    status('seller-report-status', rows.length ? `${rows.length} resultados. Cada cotización se cuenta una vez; las revisiones no duplican cantidades.` : 'No hay cotizaciones ni ventas en este rango.');
  } catch (error) {
    if (epoch === state.epoch && request === state.reportRequest && state.profile?.role === 'admin') status('seller-report-status', error.message, true);
  }
}
async function loadAudit() {
  if (state.profile?.role !== 'admin') return;
  status('audit-status', 'Cargando auditoría…');
  const epoch = state.epoch;
  const [stats, events] = await Promise.all([
    api.result(api.supabase.rpc('quote_statistics')),
    (async () => {
      let query = api.supabase.from('audit_events').select('id,actor_username,action,resource_id,details,created_at', { count: 'exact' }).order('created_at', { ascending: false }).order('id', { ascending: false });
      if ($('audit-user').value.trim()) query = query.ilike('actor_username', '%' + $('audit-user').value.trim().replaceAll('%', '\\%').replaceAll('_', '\\_') + '%');
      if ($('audit-action').value) query = query.eq('action', $('audit-action').value);
      const { data, error, count } = await query.range((state.auditPage - 1) * 20, state.auditPage * 20 - 1);
      if (error) throw new Error(error.message); return { data, count };
    })()
  ]);
  if (epoch !== state.epoch || state.profile?.role !== 'admin') return;
  $('stats-grid').replaceChildren();
  for (const [label, value] of [['Cotizaciones', stats.quotes], ['Usuarios activos', stats.active_users], ['Total USD (sin canceladas)', money(stats.total_usd_cents)], ['Total CRC histórico (sin canceladas)', money(stats.total_crc_cents, '₡', true)]]) {
    const box = document.createElement('div'); box.className = 'stat-card'; paragraph(box, label); const strong = document.createElement('strong'); strong.textContent = String(value); box.append(strong); $('stats-grid').append(box);
  }
  $('audit-body').replaceChildren();
  for (const event of events.data) { const row = document.createElement('tr'); const when = dateAndTime(event.created_at);
    [event.actor_username || 'Sistema', actionLabels[event.action] || event.action, when.date, when.time, event.resource_id || '—'].forEach(v => cell(row, v));
    cell(row, '').append(button('Ver detalle', () => { $('event-detail-content').textContent = JSON.stringify(event.details, null, 2); $('event-detail-dialog').showModal(); })); $('audit-body').append(row);
  }
  labelTableRows($('audit-body'));
  state.auditTotal = events.count; status('audit-status', `${events.count} eventos. Solo los administradores pueden consultar esta auditoría.`);
  $('audit-page').textContent = `Página ${state.auditPage} de ${Math.max(1, Math.ceil(events.count / 20))}`;
  $('audit-prev').disabled = state.auditPage <= 1; $('audit-next').disabled = state.auditPage * 20 >= events.count;
}
async function loadUsers() {
  if (state.profile?.role !== 'admin') return;
  status('users-status', 'Cargando usuarios…');
  const epoch = state.epoch;
  const users = await api.result(api.supabase.from('profiles').select('id,username,display_name,role,active').order('username'));
  if (epoch !== state.epoch || state.profile?.role !== 'admin') return;
  state.users = users;
  $('users-body').replaceChildren();
  for (const profile of state.users) {
    const row = document.createElement('tr'); [profile.username, profile.display_name, labels[profile.role], profile.active ? 'Activa' : 'Desactivada'].forEach(v => cell(row, v));
    const actions = cell(row, ''); actions.className = 'table-actions';
    actions.append(button('Editar', () => {
      $('user-id').value = profile.id; $('user-username').value = profile.username; $('user-username').disabled = true;
      $('user-display-name').value = profile.display_name; $('user-role').value = profile.role; $('user-password').value = '';
      $('user-password').disabled = true; $('user-password').required = false; $('user-submit').textContent = 'Guardar cambios'; $('user-cancel').hidden = false;
    }), button(profile.active ? 'Desactivar' : 'Reactivar', async () => {
      await api.manageUser({ action: 'update', id: profile.id, role: profile.role, active: !profile.active, display_name: profile.display_name });
      await loadUsers(); await checkProfile();
    }), button('Restablecer contraseña', () => {
      $('password-user-id').value = profile.id; $('password-user-name').textContent = profile.username; $('reset-password').value = ''; status('password-status', ''); $('password-dialog').showModal();
    })); $('users-body').append(row);
  }
  labelTableRows($('users-body'));
  status('users-status', `${state.users.length} usuarios. Las contraseñas nunca se muestran ni se almacenan en perfiles.`);
}
function resetUserForm() {
  $('user-form').reset(); $('user-id').value = ''; $('user-username').disabled = false; $('user-password').disabled = false;
  $('user-password').required = true; $('user-submit').textContent = 'Crear usuario'; $('user-cancel').hidden = true;
}
async function checkProfile() {
  if (!state.profile) return;
  const { data, error } = await api.supabase.auth.getSession(); if (error) throw error;
  await activateSession(data.session);
}

const reportToday = new Intl.DateTimeFormat('en-CA', { timeZone: TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
$('report-from').value = reportToday.slice(0, 4) + '-01-01'; $('report-to').value = reportToday;
$('seller-report-filters').addEventListener('submit', event => { event.preventDefault(); run(loadSellerReport); });
document.querySelectorAll('[data-current-year]').forEach(el => { el.textContent = new Intl.DateTimeFormat('en', { timeZone: TIME_ZONE, year: 'numeric' }).format(new Date()); });
document.querySelectorAll('[data-close-dialog]').forEach(b => b.addEventListener('click', () => { b.closest('dialog').close(); $('reset-password').value = ''; }));
$('login-form').addEventListener('submit', async event => {
  event.preventDefault(); $('login-submit').disabled = true; status('login-status', 'Iniciando sesión…');
  try {
    const data = await api.login($('login-username').value, $('login-password').value); $('login-password').value = '';
    await activateSession(data.session);
    if (state.profile) { try { await api.sessionEvent('login'); } catch { message('La sesión inició, pero no pudo registrarse el evento de acceso.', true); } }
  } catch { status('login-status', 'No se pudo iniciar sesión. Revisa el usuario, la contraseña y la configuración del proyecto.', true); }
  finally { $('login-submit').disabled = false; }
});
$('logout-button').addEventListener('click', () => run(async () => {
  await flushSave();
  try { await api.sessionEvent('logout'); } catch { /* El fallo de auditoría no impide cerrar la sesión local. */ }
  await api.supabase.auth.signOut({ scope: 'local' }); api.clearLocalSession();
  clearPrivateData(); status('login-status', 'Sesión cerrada.');
}));
document.querySelectorAll('[data-view]').forEach(b => b.addEventListener('click', () => {
  if (b.dataset.view === 'history') { state.allQuotes = false; $('history-heading').textContent = 'Mis cotizaciones'; $('filter-user-field').hidden = true; state.quotesPage = 1; }
  showView(b.dataset.view);
}));
$('all-quotes-button').addEventListener('click', () => { state.allQuotes = true; state.quotesPage = 1; $('history-heading').textContent = 'Auditoría de todas las cotizaciones'; $('filter-user-field').hidden = false; showView('history'); });
document.addEventListener('quote:changed', queueSave);
$('customer-name').addEventListener('input', () => { window.Cotizador.refresh(); updateCustomerValidity(); queueSave(); });
$('save-quote').addEventListener('click', () => run(async () => {
  $('toast').hidden = true;
  const epoch = state.epoch;
  try { await flushSave(true); }
  catch (error) {
    if (!state.saving) { saveStatus(error.message || 'No se pudo guardar el pedido.', 'error'); focusInvalidField(); }
    throw error;
  }
  if (epoch === state.epoch && state.profile && JSON.stringify(payload()) === state.saved) {
    window.Cotizador.showToast('Información guardada correctamente.');
  }
}, 'save'));
$('clear-quote').addEventListener('click', event => { event.stopImmediatePropagation(); run(newQuote); }, true);
$('quote-filters').addEventListener('submit', event => { event.preventDefault(); state.quotesPage = 1; run(loadQuotes); });
$('quotes-prev').addEventListener('click', () => { state.quotesPage--; run(loadQuotes); });
$('quotes-next').addEventListener('click', () => { state.quotesPage++; run(loadQuotes); });
$('export-quotes').addEventListener('click', () => run(exportQuotes));
$('audit-filters').addEventListener('submit', event => { event.preventDefault(); state.auditPage = 1; run(loadAudit); });
$('audit-prev').addEventListener('click', () => { state.auditPage--; run(loadAudit); });
$('audit-next').addEventListener('click', () => { state.auditPage++; run(loadAudit); });
$('user-cancel').addEventListener('click', resetUserForm);
$('user-form').addEventListener('submit', event => { event.preventDefault(); run(async () => {
  $('user-submit').disabled = true;
  try {
    const id = $('user-id').value; const previous = state.users.find(p => p.id === id);
    await api.manageUser(id ? { action: 'update', id, role: $('user-role').value, display_name: $('user-display-name').value, active: previous.active }
      : { action: 'create', username: $('user-username').value, display_name: $('user-display-name').value, role: $('user-role').value, password: $('user-password').value });
    resetUserForm(); await loadUsers(); await checkProfile();
  } catch (error) { status('users-status', error.message, true); } finally { $('user-submit').disabled = false; $('user-password').value = ''; }
}); });
$('password-form').addEventListener('submit', event => { event.preventDefault(); run(async () => {
  try { await api.manageUser({ action: 'reset-password', id: $('password-user-id').value, password: $('reset-password').value });
    $('password-dialog').close(); message('Contraseña restablecida. Entrégala al empleado por un medio privado.');
  } catch (error) { status('password-status', error.message, true); } finally { $('reset-password').value = ''; }
}); });
window.addEventListener('online', queueSave);
window.addEventListener('beforeunload', event => {
  let dirty = false; try { const next = payload(); dirty = next && JSON.stringify(next) !== state.saved; } catch {}
  if (state.profile && (state.saving || dirty)) { event.preventDefault(); event.returnValue = ''; }
});

if (!api.configured) {
  $('login-submit').disabled = true;
  status('login-status', 'Conexión pendiente: configura la URL de Supabase y su clave pública en .env, y ejecuta la migración SQL. Consulta GUIA_SUPABASE.md.', true);
} else {
  api.supabase.auth.onAuthStateChange((_event, session) => {
    if (!session) clearPrivateData();
    else setTimeout(() => run(() => activateSession(session)), 0);
  });
  run(async () => { const data = await api.result(api.supabase.auth.getSession()); await activateSession(data.session); if (!data.session) status('login-status', 'Introduce tus credenciales para continuar.'); });
  setInterval(() => run(checkProfile), 30000);
  for (const id of ['login-username', 'login-password', 'login-submit']) $(id).disabled = false;
}
// Solo se habilita el acceso después de registrar los manejadores de los formularios.
document.documentElement.setAttribute('data-app-ready', 'true');
