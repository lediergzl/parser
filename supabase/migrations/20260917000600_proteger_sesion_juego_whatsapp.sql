-- Protección contra sesiones de juego abandonadas.
-- La selección de lotería/sorteo de un cliente de WhatsApp no puede reutilizarse
-- indefinidamente: vence después de 30 minutos de inactividad y nunca puede
-- cruzar al día siguiente en horario de Cuba.
--
-- La comprobación se hace dentro de la misma operación atómica que descuenta
-- el saldo y registra la apuesta. Así, aunque el proceso Node conserve el
-- modo /jugar en memoria, una selección antigua no puede terminar registrando
-- una apuesta por accidente.

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
  v_whatsapp_jid text;
  v_pref_loteria_id bigint;
  v_pref_sorteo_id bigint;
  v_pref_updated_at timestamptz;
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

  select saldo, whatsapp_jid
    into v_saldo_antes, v_whatsapp_jid
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

  -- Si el cliente está vinculado a WhatsApp, la apuesta debe corresponder
  -- exactamente a su selección vigente. Esto evita reutilizar una selección
  -- abandonada aunque el proceso Node todavía conserve /jugar activo.
  if nullif(trim(v_whatsapp_jid), '') is not null then
    select loteria_id, sorteo_id, updated_at
      into v_pref_loteria_id, v_pref_sorteo_id, v_pref_updated_at
      from public.whatsapp_cliente_preferencias
     where comercial_telegram_id = p_comercial_telegram_id
       and whatsapp_jid = v_whatsapp_jid
     for update;

    if not found then
      raise exception 'La sesión de juego no está configurada. Selecciona nuevamente la lotería y el sorteo.';
    end if;

    if v_pref_loteria_id is null or v_pref_sorteo_id is null then
      raise exception 'La sesión de juego no tiene una lotería y un sorteo seleccionados. Selecciona nuevamente antes de jugar.';
    end if;

    if v_pref_loteria_id <> p_loteria_id or v_pref_sorteo_id <> p_sorteo_id then
      raise exception 'La selección de lotería/sorteo cambió. La jugada fue rechazada para evitar registrarla en una lotería incorrecta.';
    end if;

    if v_pref_updated_at < now() - interval '30 minutes' then
      raise exception 'La sesión de juego expiró por inactividad. Vuelve a seleccionar la lotería y el sorteo antes de jugar.';
    end if;

    if (v_pref_updated_at at time zone 'America/Havana')::date <>
       (now() at time zone 'America/Havana')::date then
      raise exception 'La sesión de juego pertenece a otro día. Selecciona nuevamente la lotería y el sorteo.';
    end if;
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

  -- Una apuesta válida mantiene viva la sesión durante otros 30 minutos,
  -- pero nunca más allá del día actual de Cuba.
  if nullif(trim(v_whatsapp_jid), '') is not null then
    update public.whatsapp_cliente_preferencias
       set updated_at = now()
     where comercial_telegram_id = p_comercial_telegram_id
       and whatsapp_jid = v_whatsapp_jid;
  end if;

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
