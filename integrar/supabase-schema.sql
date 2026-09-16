-- Ejecutar en el SQL editor de Supabase

-- 1. Guarda las credenciales de la sesión de WhatsApp (Baileys)
-- para sobrevivir a redeploys/reinicios en Render (free = sin disco persistente).
create table if not exists whatsapp_session (
  id text primary key default 'default',
  creds jsonb,
  keys jsonb,
  updated_at timestamptz default now()
);

-- 2. Jugadas procesadas por el bot de Telegram.
create table if not exists jugadas (
  id bigserial primary key,
  external_id text unique,        -- id del mensaje/jugada en Telegram, para evitar duplicados
  cliente text,
  banca text,
  numeros jsonb,                  -- estructura de la jugada ya parseada
  monto numeric,
  raw_text text,                  -- texto original tal cual llegó, por auditoría
  estado text default 'procesada', -- procesada | enviada_wa | error
  creado_en timestamptz default now(),
  enviado_wa_en timestamptz
);

create index if not exists idx_jugadas_estado on jugadas (estado);
