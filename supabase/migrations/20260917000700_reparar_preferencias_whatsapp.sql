-- Reparación defensiva de la tabla usada al iniciar /jugar.
-- Fuerza permisos y recarga del schema cache de PostgREST después de crear
-- whatsapp_cliente_preferencias, evitando errores cuando la tabla existe en
-- PostgreSQL pero todavía no fue reconocida por la API de Supabase.

create table if not exists public.whatsapp_cliente_preferencias (
  comercial_telegram_id bigint not null,
  whatsapp_jid text not null,
  loteria_id bigint,
  sorteo_id bigint,
  moneda text not null default 'cup',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists whatsapp_cliente_preferencias_pk_idx
  on public.whatsapp_cliente_preferencias (comercial_telegram_id, whatsapp_jid);

revoke all on table public.whatsapp_cliente_preferencias from public;
grant select, insert, update, delete on table public.whatsapp_cliente_preferencias to service_role;

notify pgrst, 'reload schema';
