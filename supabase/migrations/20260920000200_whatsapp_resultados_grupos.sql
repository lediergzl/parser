-- Grupos de WhatsApp autorizados exclusivamente para publicar resultados.
-- Un resultado se publica en todos los grupos con activo=true.
create table if not exists public.whatsapp_resultados_grupos (
  destino_id text primary key,
  nombre text null,
  activo boolean not null default true,
  autorizado_por bigint null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_whatsapp_resultados_grupos_activo
  on public.whatsapp_resultados_grupos (activo);

comment on table public.whatsapp_resultados_grupos is
  'Grupos WhatsApp autorizados para recibir automáticamente los resultados de sorteos.';
