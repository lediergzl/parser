-- Preferencias de juego por cliente de WhatsApp.
-- La selección pertenece al cliente + comercial, NO al comercial global.

create table if not exists public.whatsapp_cliente_preferencias (
  comercial_telegram_id bigint not null,
  whatsapp_jid text not null,
  loteria_id bigint,
  sorteo_id bigint,
  moneda text not null default 'cup',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint whatsapp_cliente_preferencias_pk primary key (comercial_telegram_id, whatsapp_jid)
);

create index if not exists idx_whatsapp_cliente_pref_loteria_sorteo
  on public.whatsapp_cliente_preferencias (loteria_id, sorteo_id);

revoke all on table public.whatsapp_cliente_preferencias from public;
grant select, insert, update, delete on table public.whatsapp_cliente_preferencias to service_role;
