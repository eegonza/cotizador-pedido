-- Descuentos por producto. No recalcula ni modifica cotizaciones históricas.
-- Aplicar después de 202610190002_varios_bultos.sql, antes de publicar la interfaz.
begin;

alter table public.quote_items
  add column discount_type text not null default 'percent'
    check (discount_type in ('percent', 'fixed')),
  add column discount_value bigint not null default 0
    check (discount_value >= 0),
  add column discount_cents bigint not null default 0
    check (discount_cents >= 0 and discount_cents <= unit_price_cents * quantity),
  add constraint quote_items_discount_value_range check (
    (discount_type = 'percent' and discount_value <= 10000) or
    (discount_type = 'fixed' and discount_value <= unit_price_cents * quantity)
  );

-- La interfaz comprueba la compatibilidad antes de enviar un guardado.
create function public.quote_discount_version() returns integer
language plpgsql stable security definer set search_path = '' as $$
begin
  if not public.is_active_user() then raise exception 'Cuenta activa requerida' using errcode = '42501'; end if;
  return 1;
end;
$$;
revoke all on function public.quote_discount_version() from public, anon;
grant execute on function public.quote_discount_version() to authenticated;

create or replace function public.save_quote(p_id uuid, p_expected_revision integer, p_payload jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_actor public.profiles; v_quote public.quotes; v_previous public.quotes; v_client uuid;
  v_customer text; v_rate numeric; v_weight numeric; v_subtotal numeric := 0; v_shipping numeric; v_shipping_crc numeric; v_subtotal_crc numeric; v_total numeric;
  v_package_inputs jsonb; v_package jsonb; v_packages jsonb := '[]'::jsonb; v_package_weight numeric; v_package_usd numeric; v_package_crc numeric; v_package_label text;
  v_items jsonb := '[]'::jsonb; v_item jsonb; v_price numeric; v_qty integer; v_description text; v_exempt boolean;
  v_original numeric := 0; v_discounts numeric := 0; v_line_original numeric; v_discount_type text; v_discount_raw text; v_discount_value numeric; v_discount numeric; v_line_total numeric;
  v_units integer := 0; v_count integer := 0; v_snapshot jsonb; v_input jsonb;
begin
  select * into v_actor from public.profiles where id = auth.uid() and active;
  if not found then raise exception 'Sesión válida y cuenta activa requeridas' using errcode = '42501'; end if;
  if p_id is null or p_expected_revision is null or p_expected_revision < 0 or jsonb_typeof(p_payload) <> 'object' then raise exception 'Solicitud inválida'; end if;
  if p_payload ? 'discount_pricing_version' and p_payload->>'discount_pricing_version' is distinct from '1' then raise exception 'Versión de descuentos no compatible'; end if;
  v_customer := btrim(p_payload->>'customer_name');
  if v_customer is null or char_length(v_customer) not between 1 and 120 or v_customer ~ '[[:cntrl:]]' then raise exception 'Nombre del cliente inválido'; end if;
  if coalesce(p_payload->>'exchange_rate_cents', '') !~ '^[0-9]{1,9}$' then raise exception 'Cambio inválido'; end if;
  v_rate := (p_payload->>'exchange_rate_cents')::numeric;
  if v_rate not between 1 and 100000000 then raise exception 'Cambio fuera de rango'; end if;
  if p_payload ? 'packages' then
    v_package_inputs := p_payload->'packages';
  else
    v_package_inputs := jsonb_build_array(jsonb_build_object('weight_micros', p_payload->>'weight_micros'));
  end if;
  if jsonb_typeof(v_package_inputs) is distinct from 'array' then raise exception 'Lista de bultos requerida'; end if;
  if jsonb_array_length(v_package_inputs) not between 1 and 100 then raise exception 'De 1 a 100 bultos requeridos'; end if;
  v_weight := 0; v_shipping := 0; v_shipping_crc := 0;
  for v_package in select value from jsonb_array_elements(v_package_inputs) loop
    if jsonb_typeof(v_package) is distinct from 'object' or coalesce(v_package->>'weight_micros','') !~ '^[0-9]{1,13}$' then raise exception 'Peso de bulto inválido'; end if;
    v_package_weight := (v_package->>'weight_micros')::numeric;
    if v_package_weight not between 0 and 1000000000000 then raise exception 'Peso de bulto fuera de rango'; end if;
    v_package_usd := case when v_package_weight <= 10000000 then 1500 when v_package_weight <= 20000000 then 3000 else 4000 end;
    v_package_crc := case when v_package_weight <= 10000000 then 750000 when v_package_weight <= 20000000 then 1500000 else 2000000 end;
    v_package_label := case when v_package_weight <= 10000000 then '0–10 kg' when v_package_weight <= 20000000 then 'Más de 10–20 kg' else 'Más de 20 kg' end;
    v_weight := v_weight + v_package_weight; v_shipping := v_shipping + v_package_usd; v_shipping_crc := v_shipping_crc + v_package_crc;
    v_packages := v_packages || jsonb_build_array(jsonb_build_object('weight_micros', v_package_weight::text,
      'shipping_cents', v_package_usd::text, 'shipping_crc_cents', v_package_crc::text, 'shipping_rate_label', v_package_label));
  end loop;
  if jsonb_typeof(p_payload->'items') is distinct from 'array' then raise exception 'Lista de productos requerida'; end if;
  if jsonb_array_length(p_payload->'items') not between 1 and 100 then raise exception 'De 1 a 100 productos requeridos'; end if;
  for v_item in select value from jsonb_array_elements(p_payload->'items') loop
    if coalesce(v_item->>'unit_price_cents', '') !~ '^[0-9]{1,9}$' or coalesce(v_item->>'quantity', '') !~ '^[0-9]{1,4}$' then raise exception 'Precio o cantidad inválidos'; end if;
    v_price := (v_item->>'unit_price_cents')::numeric; v_qty := (v_item->>'quantity')::integer;
    if v_price not between 0 and 999999999 or v_qty not between 1 and 9999 then raise exception 'Precio o cantidad fuera de rango'; end if;
    v_count := v_count + 1; v_units := v_units + v_qty;
    v_description := coalesce(nullif(btrim(v_item->>'description'), ''), 'Producto ' || v_count);
    if char_length(v_description) > 120 or v_description ~ '[[:cntrl:]]' then raise exception 'Descripción inválida'; end if;
    if v_item ? 'tax_exempt' and jsonb_typeof(v_item->'tax_exempt') <> 'boolean' then raise exception 'Exención inválida'; end if;
    v_exempt := coalesce((v_item->>'tax_exempt')::boolean, false);
    if (v_item ? 'discount_type' or v_item ? 'discount_value') and p_payload->>'discount_pricing_version' is distinct from '1' then
      raise exception 'Actualiza la página para guardar descuentos';
    end if;
    v_line_original := v_price * v_qty;
    v_discount_type := coalesce(v_item->>'discount_type', 'percent');
    if v_discount_type not in ('percent', 'fixed') then raise exception 'Tipo de descuento inválido'; end if;
    -- Porcentaje en puntos básicos (10 % = 1000); monto fijo en centavos USD.
    v_discount_raw := coalesce(nullif(v_item->>'discount_value', ''), '0');
    if v_discount_raw !~ '^[0-9]{1,13}$' then raise exception 'Descuento inválido'; end if;
    v_discount_value := v_discount_raw::numeric;
    if v_discount_type = 'percent' then
      if v_discount_value > 10000 then raise exception 'El porcentaje de descuento no puede superar 100'; end if;
      v_discount := round(v_line_original * v_discount_value / 10000);
    else
      if v_discount_value > v_line_original then raise exception 'El descuento no puede superar el subtotal del producto'; end if;
      v_discount := v_discount_value;
    end if;
    v_line_total := v_line_original - v_discount;
    v_original := v_original + v_line_original; v_discounts := v_discounts + v_discount;
    v_subtotal := v_subtotal + v_line_total;
    v_items := v_items || jsonb_build_array(jsonb_build_object('description', v_description, 'unit_price_cents', v_price::text,
      'quantity', v_qty, 'tax_exempt', v_exempt, 'original_subtotal_cents', v_line_original::text,
      'discount_type', v_discount_type, 'discount_value', v_discount_value::text,
      'discount_cents', v_discount::text, 'subtotal_cents', v_line_total::text));
  end loop;
  v_subtotal_crc := round(v_subtotal * v_rate / 100);
  v_total := v_subtotal + v_shipping;
  -- El servidor recalcula los importes; nunca confía en totales enviados por el navegador.
  v_input := jsonb_build_object('customer_name', v_customer, 'exchange_rate_cents', v_rate::text,
    'weight_micros', v_weight::text, 'items', v_items, 'shipping_pricing_version', 3, 'packages', v_packages, 'discount_pricing_version', 1);
  v_snapshot := v_input || jsonb_build_object('original_subtotal_cents', v_original::text, 'discount_cents', v_discounts::text,
    'subtotal_cents', v_subtotal::text, 'shipping_cents', v_shipping::text,
    'subtotal_crc_cents', v_subtotal_crc::text, 'shipping_crc_cents', v_shipping_crc::text,
    'total_usd_cents', v_total::text, 'total_crc_cents', (v_subtotal_crc + v_shipping_crc)::text,
    'shipping_rate_label', case when jsonb_array_length(v_packages) = 1 then v_packages->0->>'shipping_rate_label' else 'Tarifa por bulto' end, 'package_count', jsonb_array_length(v_packages),
    'product_count', v_count, 'unit_count', v_units, 'tax_rate_basis_points', null, 'tax_cents', null,
    'tax_note', 'Sin tasa de IVA definida; precios finales. Exenciones registradas sin modificar importes.');
  -- Serializa reintentos del mismo ID, incluso cuando llegan a la vez.
  perform pg_advisory_xact_lock(hashtextextended(p_id::text, 0));
  if exists(select 1 from public.audit_events where action = 'quote_deleted' and resource_id = p_id) then
    raise exception 'La cotización fue eliminada; inicia una nueva' using errcode = 'P0002';
  end if;
  select * into v_previous from public.quotes where id = p_id for update;
  if found then
    if v_previous.owner_id <> v_actor.id and v_actor.role <> 'admin' then raise exception 'Cotización no autorizada' using errcode = '42501'; end if;
    if not (p_payload ? 'packages') and jsonb_array_length(coalesce(v_previous.snapshot->'packages', '[]'::jsonb)) > 1 then
      raise exception 'Actualiza la página para editar esta cotización con varios bultos';
    end if;
    if p_payload->>'discount_pricing_version' is distinct from '1' and exists (
      select 1 from jsonb_array_elements(v_previous.snapshot->'items') as item
      where coalesce(item->>'discount_type', 'percent') = 'fixed'
         or coalesce((item->>'discount_value')::numeric, 0) > 0
    ) then
      raise exception 'Actualiza la página para conservar los descuentos de esta cotización';
    end if;
    if v_previous.input_payload = v_input then return public.quote_response(v_previous); end if;
    if v_previous.status in ('confirmed', 'cancelled') then raise exception 'Esta cotización está cerrada; crea una nueva'; end if;
    if p_expected_revision <> v_previous.revision then raise exception 'Conflicto: recarga la cotización antes de guardar' using errcode = '40001'; end if;
  elsif p_expected_revision <> 0 then raise exception 'Cotización inexistente'; end if;
  insert into public.clients(owner_id, name) values(coalesce(v_previous.owner_id, v_actor.id), v_customer)
    on conflict (owner_id, lower(name)) do nothing;
  select id into v_client from public.clients where owner_id = coalesce(v_previous.owner_id, v_actor.id) and lower(name) = lower(v_customer);
  if v_previous.id is null then
    insert into public.quotes(id, owner_id, username, client_id, customer_name, input_payload, snapshot)
    values(p_id, v_actor.id, v_actor.username, v_client, v_customer, v_input, v_snapshot) returning * into v_quote;
  else
    update public.quotes set client_id = v_client, customer_name = v_customer, input_payload = v_input, snapshot = v_snapshot,
      revision = revision + 1, updated_at = now() where id = p_id returning * into v_quote;
    delete from public.quote_items where quote_id = p_id;
  end if;
  insert into public.quote_items(quote_id, position, description, quantity, unit_price_cents, tax_exempt, discount_type, discount_value, discount_cents)
  select p_id, ordinality, value->>'description', (value->>'quantity')::integer, (value->>'unit_price_cents')::bigint, (value->>'tax_exempt')::boolean,
    value->>'discount_type', (value->>'discount_value')::bigint, (value->>'discount_cents')::bigint
  from jsonb_array_elements(v_items) with ordinality;
  insert into public.quote_revisions(quote_id, revision, actor_id, previous_snapshot, new_snapshot, previous_status, new_status)
  values(p_id, v_quote.revision, v_actor.id, v_previous.snapshot, v_snapshot, v_previous.status, v_quote.status);
  perform public.append_audit(v_actor.id, case when v_previous.id is null then 'quote_created' else 'quote_updated' end, p_id,
    jsonb_build_object('revision', v_quote.revision, 'previous', v_previous.snapshot, 'new', v_snapshot));
  return public.quote_response(v_quote);
end;
$$;
revoke all on function public.save_quote(uuid, integer, jsonb) from public, anon;
grant execute on function public.save_quote(uuid, integer, jsonb) to authenticated;

commit;
