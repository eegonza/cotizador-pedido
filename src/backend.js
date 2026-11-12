import { createClient } from '@supabase/supabase-js';
import { technicalEmail } from '../supabase/functions/_shared/identity.ts';

const url = import.meta.env.VITE_SUPABASE_URL;
const key = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY || import.meta.env.VITE_SUPABASE_ANON_KEY;
function publicKey(value) {
  if (!value || value.startsWith('sb_secret_')) return false;
  if (value.startsWith('sb_publishable_')) return true;
  try { return JSON.parse(atob(value.split('.')[1].replaceAll('-', '+').replaceAll('_', '/'))).role === 'anon'; }
  catch { return false; }
}
export const configured = Boolean(url && publicKey(key));
const sessionKey = 'cotizador.auth.session';
const memory = new Map();
const storage = {
  getItem(name) { try { return localStorage.getItem(name); } catch { return memory.get(name) ?? null; } },
  setItem(name, value) { memory.set(name, value); try { localStorage.setItem(name, value); } catch {} },
  removeItem(name) { memory.delete(name); try { localStorage.removeItem(name); } catch {} }
};
export function clearLocalSession() { storage.removeItem(sessionKey); }
export const supabase = configured ? createClient(url, key, {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false, storageKey: sessionKey, storage }
}) : null;
export async function result(request) {
  const { data, error } = await request;
  if (error) { const problem = new Error(error.message); problem.code = error.code; throw problem; }
  return data;
}
export function login(username, password) {
  return result(supabase.auth.signInWithPassword({ email: technicalEmail(username), password }));
}
export function profile(id) {
  return result(supabase.from('profiles').select('id,username,display_name,role,active').eq('id', id).single());
}
let discountSupport;
async function requireDiscountSupport() {
  if (!discountSupport) {
    discountSupport = (async () => {
      const { data, error } = await supabase.rpc('quote_discount_version');
      if (error || data !== 1) throw new Error('Los descuentos aún no están habilitados en el servidor. Contacta al administrador para actualizarlo antes de guardar.');
    })().catch(error => { discountSupport = null; throw error; });
  }
  await discountSupport;
}
export async function saveQuote(id, revision, payload) {
  // Evita que un servidor anterior guarde un pedido ignorando sus descuentos.
  await requireDiscountSupport();
  return result(supabase.rpc('save_quote', { p_id: id, p_expected_revision: revision, p_payload: payload }));
}
export function searchQuotes(filters) { return result(supabase.rpc('search_quotes', filters)); }
export function getQuote(id) { return result(supabase.rpc('get_quote', { p_id: id })); }
export function deleteQuote(id, revision) { return result(supabase.rpc('delete_quote', { p_id: id, p_expected_revision: revision })); }
export function setStatus(id, status, revision) {
  return result(supabase.rpc('set_quote_status', { p_id: id, p_status: status, p_expected_revision: revision }));
}
export function sessionEvent(action) { return result(supabase.rpc('record_session_event', { p_action: action })); }
export async function manageUser(input) {
  const { data, error } = await supabase.functions.invoke('admin-users', { body: input });
  if (error) {
    let message = 'No se pudo administrar el usuario. Comprueba la función admin-users y tu sesión.';
    try { const details = await error.context.json(); if (details.error) message = details.error; } catch {}
    throw new Error(message);
  }
  if (data?.error) throw new Error(data.error);
  return data;
}
