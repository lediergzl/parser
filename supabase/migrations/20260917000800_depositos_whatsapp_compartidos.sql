-- Extiende el flujo existente de deposit_requests para clientes de comerciales por WhatsApp.
-- No crea un segundo sistema de depósitos: reutiliza la misma tabla y estados.

alter table public.deposit_requests
  add column if not exists comercial_telegram_id bigint,
  add column if not exists whatsapp_jid text,
  add column if not exists source text not null default 'telegram',
  add column if not exists proof_message_id text,
  add column if not exists client_name text;

create index if not exists idx_deposit_requests_comercial_status
  on public.deposit_requests (comercial_telegram_id, status, created_at desc);

create index if not exists idx_deposit_requests_whatsapp
  on public.deposit_requests (comercial_telegram_id, whatsapp_jid, created_at desc);

create or replace function public.aprobar_deposito_comercial_atomico(
  p_request_id bigint,
  p_aprobado_por bigint
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_req public.deposit_requests%rowtype;
  v_cliente public.clientes_banca%rowtype;
  v_saldo_antes numeric(14,2);
  v_saldo_despues numeric(14,2);
begin
  select * into v_req
    from public.deposit_requests
   where id = p_request_id
     and source = 'whatsapp_comercial'
   for update;

  if not found then
    raise exception 'Solicitud de depósito WhatsApp no encontrada';
  end if;

  if v_req.status <> 'pending' then
    raise exception 'La solicitud #% ya fue procesada. Estado actual: %', p_request_id, v_req.status;
  end if;

  if v_req.comercial_telegram_id is null or nullif(trim(v_req.whatsapp_jid), '') is null then
    raise exception 'La solicitud no tiene comercial o WhatsApp asociado';
  end if;

  select * into v_cliente
    from public.clientes_banca
   where comercial_telegram_id = v_req.comercial_telegram_id
     and whatsapp_jid = v_req.whatsapp_jid
   for update;

  if not found then
    raise exception 'El cliente WhatsApp ya no está registrado con este comercial';
  end if;

  v_saldo_antes := greatest(coalesce(v_cliente.saldo, 0), 0);
  v_saldo_despues := v_saldo_antes + v_req.amount;

  update public.clientes_banca
     set saldo = v_saldo_despues,
         updated_at = now()
   where id = v_cliente.id;

  update public.deposit_requests
     set status = 'approved',
         admin_notes = concat(
           coalesce(admin_notes, ''),
           case when nullif(admin_notes, '') is null then '' else ' | ' end,
           'Aprobado por ', p_aprobado_por,
           ' el ', to_char(now(), 'YYYY-MM-DD HH24:MI:SS TZ')
         ),
         updated_at = now()
   where id = p_request_id
     and status = 'pending';

  if not found then
    raise exception 'La solicitud dejó de estar pendiente durante la aprobación';
  end if;

  return jsonb_build_object(
    'ok', true,
    'request_id', v_req.id,
    'cliente_banca_id', v_cliente.id,
    'comercial_telegram_id', v_req.comercial_telegram_id,
    'whatsapp_jid', v_req.whatsapp_jid,
    'amount', v_req.amount,
    'saldo_antes', v_saldo_antes,
    'saldo_despues', v_saldo_despues
  );
end;
$$;

revoke all on function public.aprobar_deposito_comercial_atomico(bigint,bigint) from public;
grant execute on function public.aprobar_deposito_comercial_atomico(bigint,bigint) to service_role;

notify pgrst, 'reload schema';
