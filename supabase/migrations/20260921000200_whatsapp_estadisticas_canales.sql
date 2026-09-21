-- Canal de WhatsApp independiente por comercial para el módulo de estadísticas.
create table if not exists public.whatsapp_estadisticas_canales (
  comercial_telegram_id bigint primary key,
  enlace text not null,
  destino_id text not null,
  nombre text,
  activo boolean not null default true,
  creado_at timestamptz not null default now(),
  actualizado_at timestamptz not null default now()
);

create index if not exists idx_whatsapp_estadisticas_canales_activo
  on public.whatsapp_estadisticas_canales (activo);

comment on table public.whatsapp_estadisticas_canales is
  'Canal WhatsApp de destino de estadísticas para cada comercial.';
