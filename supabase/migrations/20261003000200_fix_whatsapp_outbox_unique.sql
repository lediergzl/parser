-- Corrección de la cola WhatsApp después de habilitar múltiples cuentas.
-- Ejecutar UNA sola vez en Supabase SQL Editor.
--
-- Problema:
-- whatsapp_notificaciones_outbox nació con un UNIQUE sobre
-- (tipo, referencia_id, destino_id). La migración multi-cuenta añadió
-- cuenta_alias y creó otro índice UNIQUE de 4 columnas, pero el índice
-- histórico podía permanecer. En ese caso PostgreSQL seguía rechazando una
-- segunda entrega con el mismo tipo/referencia/destino aunque fuera otra
-- cuenta WhatsApp.

ALTER TABLE public.whatsapp_notificaciones_outbox
  ADD COLUMN IF NOT EXISTS comercial_telegram_id bigint,
  ADD COLUMN IF NOT EXISTS cuenta_alias text NOT NULL DEFAULT 'principal';

-- Elimina cualquier UNIQUE/PK secundaria que cubra exactamente las tres
-- columnas históricas. No toca la PK id.
DO $$
DECLARE
  r record;
BEGIN
  -- UNIQUE constraints.
  FOR r IN
    SELECT c.conname
    FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'whatsapp_notificaciones_outbox'
      AND c.contype = 'u'
      AND (
        SELECT array_agg(a.attname::text ORDER BY array_position(c.conkey, a.attnum))
        FROM pg_attribute a
        WHERE a.attrelid = c.conrelid
          AND a.attnum = ANY(c.conkey)
      ) = ARRAY['tipo','referencia_id','destino_id']::text[]
  LOOP
    EXECUTE format(
      'ALTER TABLE public.whatsapp_notificaciones_outbox DROP CONSTRAINT %I',
      r.conname
    );
  END LOOP;

  -- UNIQUE indexes creados fuera de una constraint.
  FOR r IN
    SELECT i.indexrelid::regclass::text AS index_name
    FROM pg_index i
    JOIN pg_class t ON t.oid = i.indrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'whatsapp_notificaciones_outbox'
      AND i.indisunique
      AND NOT i.indisprimary
      AND (
        SELECT array_agg(a.attname::text ORDER BY array_position(i.indkey::smallint[], a.attnum))
        FROM pg_attribute a
        WHERE a.attrelid = i.indrelid
          AND a.attnum = ANY(i.indkey)
          AND a.attnum > 0
      ) = ARRAY['tipo','referencia_id','destino_id']::text[]
  LOOP
    EXECUTE 'DROP INDEX IF EXISTS ' || r.index_name;
  END LOOP;
END $$;

-- Esta es ahora la única identidad lógica de una notificación.
CREATE UNIQUE INDEX IF NOT EXISTS
  uq_whatsapp_notificaciones_outbox_destino_cuenta
ON public.whatsapp_notificaciones_outbox
  (tipo, referencia_id, destino_id, cuenta_alias);

CREATE INDEX IF NOT EXISTS
  whatsapp_notificaciones_outbox_pendientes_idx
ON public.whatsapp_notificaciones_outbox
  (estado, creado_at);
