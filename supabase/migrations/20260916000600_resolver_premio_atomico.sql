begin;

create or replace function public.resolver_premio_deposito(
  p_premio_id bigint,
  p_resuelto_por bigint
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_premio public.premios%rowtype;
  v_origen text;
  v_cliente_banca_id bigint;
  v_user_telegram_id bigint;
  v_monto numeric(14,2);
  v_saldo numeric(14,2);
begin
  select p.*, b.origen, b.cliente_banca_id, b.user_telegram_id
    into v_premio, v_origen, v_cliente_banca_id, v_user_telegram_id
  from public.premios p
  left join public.bets b on b.id = p.bet_id
  where p.id = p_premio_id
  for update of p;

  if not found then
    return jsonb_build_object('ok', false, 'message', 'Premio no encontrado.');
  end if;

  if v_premio.estado not in ('detectado', 'confirmado') then
    return jsonb_build_object('ok', false, 'estado', v_premio.estado, 'message', 'El premio ya fue resuelto.');
  end if;

  v_monto := v_premio.monto_premio;
  if v_monto is null or v_monto <= 0 then
    return jsonb_build_object('ok', false, 'message', 'El monto del premio no es válido.');
  end if;

  if v_origen = 'comercial' and v_cliente_banca_id is not null then
    update public.clientes_banca
       set saldo = coalesce(saldo, 0) + v_monto,
           updated_at = now()
     where id = v_cliente_banca_id
     returning saldo into v_saldo;

    if not found then
      return jsonb_build_object('ok', false, 'message', 'El cliente de banca no existe.');
    end if;
  elsif v_user_telegram_id is not null then
    update public.users
       set saldo = coalesce(saldo, 0) + v_monto,
           updated_at = now()
     where telegram_id = v_user_telegram_id
     returning saldo into v_saldo;

    if not found then
      return jsonb_build_object('ok', false, 'message', 'El usuario no existe.');
    end if;
  else
    return jsonb_build_object('ok', false, 'message', 'El premio no tiene un saldo de destino válido.');
  end if;

  update public.premios
     set estado = 'depositado',
         resuelto_por = p_resuelto_por,
         fecha_resuelto = now()
   where id = p_premio_id;

  return jsonb_build_object(
    'ok', true,
    'estado', 'depositado',
    'monto', v_monto,
    'saldo_nuevo', v_saldo
  );
end;
$$;

revoke all on function public.resolver_premio_deposito(bigint, bigint) from public;
grant execute on function public.resolver_premio_deposito(bigint, bigint) to service_role;

commit;
