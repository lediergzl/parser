-- Un grupo de resultados/premios por comercial.
-- El comercial queda identificado por su Telegram ID, que ya es la clave
-- de sus sesiones WhatsApp comerciales.
create table if not exists public.whatsapp_comercial_resultados (
  comercial_telegram_id bigint primary key,
  destino_id text not null,
  nombre text null,
  activo boolean not null default true,
  updated_at timestamptz not null default now()
);

create index if not exists idx_whatsapp_comercial_resultados_activo
  on public.whatsapp_comercial_resultados (activo);

comment on table public.whatsapp_comercial_resultados is
  'Grupo WhatsApp asignado a cada comercial para recibir resultados y premios de sus jugadas.';
