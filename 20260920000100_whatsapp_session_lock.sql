-- Lock distribuido para la sesión WhatsApp del sender (Baileys).
--
-- ROOT CAUSE del bucle infinito de QR: en un deploy de Render (zero-downtime)
-- la instancia nueva arranca y conecta a WhatsApp ANTES de que la instancia
-- vieja reciba SIGTERM. Ambas abren socket con la MISMA sesión guardada en
-- whatsapp_session. WhatsApp responde con "connectionReplaced" y los
-- `keys.set` concurrentes de los dos procesos llegan intercalados
-- ("Invalid patch mac"), lo que termina en un logout forzado (401): se
-- borra la sesión y hay que escanear un QR nuevo... que se corrompe otra
-- vez en el próximo redeploy.
--
-- Esta tabla + funciones dan un lock exclusivo con lease (TTL) para que
-- solo UN proceso a la vez pueda tener abierto el socket de la sesión
-- 'default'. El proceso que no logra el lock espera en vez de conectar.

create table if not exists public.whatsapp_session_lock (
  id text primary key,
  holder text not null,
  expires_at timestamptz not null,
  updated_at timestamptz not null default now()
);

alter table public.whatsapp_session_lock enable row level security;

-- Adquiere (o renueva) el lock de forma atómica en una sola sentencia:
-- solo actualiza si nadie lo sostiene, si el lease ya expiró, o si quien
-- pide la renovación es el mismo holder que ya lo tenía.
create or replace function public.whatsapp_lock_acquire(
  p_id text,
  p_holder text,
  p_ttl_seconds int
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_acquired boolean;
begin
  insert into public.whatsapp_session_lock (id, holder, expires_at)
  values (p_id, p_holder, now() + make_interval(secs => p_ttl_seconds))
  on conflict (id) do update
    set holder = excluded.holder,
        expires_at = excluded.expires_at,
        updated_at = now()
    where public.whatsapp_session_lock.holder = p_holder
       or public.whatsapp_session_lock.expires_at < now()
  returning true into v_acquired;

  return coalesce(v_acquired, false);
end;
$$;

create or replace function public.whatsapp_lock_release(
  p_id text,
  p_holder text
)
returns void
language sql
security definer
set search_path = public
as $$
  delete from public.whatsapp_session_lock
   where id = p_id and holder = p_holder;
$$;

revoke all on function public.whatsapp_lock_acquire(text, text, int) from public;
revoke all on function public.whatsapp_lock_release(text, text) from public;
grant execute on function public.whatsapp_lock_acquire(text, text, int) to service_role;
grant execute on function public.whatsapp_lock_release(text, text) to service_role;
