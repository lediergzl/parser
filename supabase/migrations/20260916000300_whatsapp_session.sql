-- Sesión de WhatsApp (Baileys) persistida en Supabase.
--
-- El plan free de Render no tiene disco persistente: al dormir o redesplegar el
-- servicio se pierde cualquier carpeta de credenciales local, lo que obligaría a
-- volver a escanear el QR en cada reinicio. Guardando `creds` y las signal keys
-- aquí, el proceso recupera la sesión al arrancar.
--
-- Nota: la jugada NO se duplica en una tabla nueva. Ya vive en public.bets y el
-- trigger trg_bets_crear_jugada_evento la publica en public.jugadas_eventos,
-- que incluye la bandera entregado_whatsapp usada por lib/jugadas-store.js.

create table if not exists public.whatsapp_session (
  id text primary key default 'default',
  creds jsonb,
  keys jsonb,
  updated_at timestamptz not null default now()
);

alter table public.whatsapp_session enable row level security;

-- Sin políticas: solo la service role key (el bot) puede leer/escribir.
-- Estas credenciales dan control del WhatsApp vinculado, así que no se expone
-- ninguna lectura pública ni anónima.
