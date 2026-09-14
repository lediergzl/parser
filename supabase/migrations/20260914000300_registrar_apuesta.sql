-- Registro atómico de una apuesta.
-- Evita que dos apuestas concurrentes puedan gastar el mismo saldo.

begin;

create or replace function public.registrar_apuesta(
  p_telegram_id bigint,
  p_loteria_id bigint,
  p_sorteo_id bigint,
  p_fecha date,
  p_input_raw text,
  p_total numeric,
  p_detalle text,
  p_moneda text
)
returns table (
  bet_id bigint,
  saldo_antes numeric,
  saldo_despues numeric
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_saldo numeric(14,2);
  v_nuevo numeric(14,2);
  v_bet_id bigint;
begin
  if p_total is null or p_total <= 0 then
    raise exception 'INVALID_BET_TOTAL';
  end if;

  if p_moneda is null or lower(p_moneda) not in ('cup', 'usd') then
    raise exception 'INVALID_CURRENCY';
  end if;

  select u.saldo
    into v_saldo
    from public.users u
   where u.telegram_id = p_telegram_id
   for update;

  if not found then
    raise exception 'USER_NOT_FOUND';
  end if;

  if v_saldo < p_total then
    raise exception 'INSUFFICIENT_BALANCE';
  end if;

  v_nuevo := round(v_saldo - p_total, 2);

  update public.users
     set saldo = v_nuevo,
         updated_at = now()
   where telegram_id = p_telegram_id;

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
    moneda
  ) values (
    p_telegram_id,
    p_loteria_id,
    p_sorteo_id,
    p_fecha,
    p_input_raw,
    round(p_total, 2),
    p_detalle,
    v_saldo,
    v_nuevo,
    lower(p_moneda)
  )
  returning id into v_bet_id;

  return query select v_bet_id, v_saldo, v_nuevo;
end;
$$;

revoke all on function public.registrar_apuesta(bigint,bigint,bigint,date,text,numeric,text,text) from public;

grant execute on function public.registrar_apuesta(bigint,bigint,bigint,date,text,numeric,text,text) to service_role;

commit;
