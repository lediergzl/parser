-- Corrección de la migración multi-WhatsApp.
-- whatsapp_comercial_resultados nació con comercial_telegram_id como PRIMARY KEY.
-- Al añadir cuenta_alias, ese PK siguió impidiendo una segunda cuenta para el mismo comercial.
-- La identidad real de la fila es (comercial_telegram_id, cuenta_alias).

DO $$
DECLARE
  pk_name text;
BEGIN
  SELECT c.conname
    INTO pk_name
  FROM pg_constraint c
  JOIN pg_class t ON t.oid = c.conrelid
  JOIN pg_namespace n ON n.oid = t.relnamespace
  WHERE n.nspname = 'public'
    AND t.relname = 'whatsapp_comercial_resultados'
    AND c.contype = 'p'
  LIMIT 1;

  IF pk_name IS NOT NULL THEN
    EXECUTE format(
      'ALTER TABLE public.whatsapp_comercial_resultados DROP CONSTRAINT %I',
      pk_name
    );
  END IF;
END $$;

-- El índice UNIQUE creado por la migración anterior pasa a ser redundante
-- porque la nueva PK cubre exactamente las mismas columnas.
DROP INDEX IF EXISTS public.uq_whatsapp_comercial_resultados_comercial_cuenta;

ALTER TABLE public.whatsapp_comercial_resultados
  ADD CONSTRAINT whatsapp_comercial_resultados_pkey
  PRIMARY KEY (comercial_telegram_id, cuenta_alias);
