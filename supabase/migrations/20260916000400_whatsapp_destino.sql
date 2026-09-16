create table if not exists public.whatsapp_destino (
  id integer primary key,
  tipo text not null check (tipo in ('grupo', 'pv')),
  destino_id text not null,
  nombre text,
  updated_at timestamptz not null default now()
);

alter table public.whatsapp_destino enable row level security;

-- La aplicación usa SUPABASE_SERVICE_ROLE_KEY, por lo que no necesita
-- políticas públicas para esta tabla.
