-- Las apuestas recibidas por WhatsApp no pueden consumir saldo inexistente.
-- El saldo de clientes_banca representa crédito disponible (por ejemplo,
-- depósitos de premios). La operación es atómica y bloquea la fila del cliente.

create or replace function public.registrar_bet_comercial_atomica(
  p_comercial_telegram_id bigint,
  p_cliente_banca_id bigint,
  p_loteria_id bigint,
  p_sorteo_id bigint,
  p_fecha_apuesta date,
  p_input_raw text,
  p_total_apuesta numeric,
  p_detalle text,
  p_moneda text default 'cup'
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_saldo_antes numeric;
  v_saldo_despues numeric;
  v_bet_id bigint;
begin
  if p_total_apuesta is null or p_total_apuesta < 0 then
    raise exception 'Monto de apuesta inválido';
  end if;

  if not exists (
    select 1
      from public.users
     where telegram_id = p_comercial_telegram_id
  ) then
    raise exception 'Comercial no encontrado en users';
  end if;

  select saldo
    into v_saldo_antes
    from public.clientes_banca
   where id = p_cliente_banca_id
     and comercial_telegram_id = p_comercial_telegram_id
   for update;

  if not found then
    raise exception 'Cliente de banca no encontrado para este comercial';
  end if;

  v_saldo_antes := greatest(coalesce(v_saldo_antes, 0), 0);

  if v_saldo_antes < p_total_apuesta then
    raise exception 'Saldo insuficiente. Disponible: $%, necesario: $%',
      to_char(v_saldo_antes, 'FM999999990.00'),
      to_char(p_total_apuesta, 'FM999999990.00');
  end if;

  v_saldo_despues := v_saldo_antes - p_total_apuesta;

  update public.clientes_banca
     set saldo = v_saldo_despues,
         updated_at = now()
   where id = p_cliente_banca_id
     and comercial_telegram_id = p_comercial_telegram_id;

  insert into public.bets (
    user_telegram_id,
    loteria_id,
    sorteo_id,
    fecha_apuesta,
    input_raw,
    total_apuesta,
    detalle,
    saldo_antes,
    saldo_despues,
    moneda,
    origen,
    comercial_telegram_id,
    cliente_banca_id
  ) values (
    p_comercial_telegram_id,
    p_loteria_id,
    p_sorteo_id,
    p_fecha_apuesta,
    p_input_raw,
    p_total_apuesta,
    p_detalle,
    v_saldo_antes,
    v_saldo_despues,
    coalesce(nullif(trim(p_moneda), ''), 'cup'),
    'comercial',
    p_comercial_telegram_id,
    p_cliente_banca_id
  )
  returning id into v_bet_id;

  return jsonb_build_object(
    'ok', true,
    'bet_id', v_bet_id,
    'saldo_antes', v_saldo_antes,
    'credito', p_total_apuesta,
    'saldo_despues', v_saldo_despues
  );
end;
$$;

revoke all on function public.registrar_bet_comercial_atomica(bigint,bigint,bigint,bigint,date,text,numeric,text,text) from public;
grant execute on function public.registrar_bet_comercial_atomica(bigint,bigint,bigint,bigint,date,text,numeric,text,text) to service_role;
