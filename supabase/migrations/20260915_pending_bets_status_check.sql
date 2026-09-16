-- pending_bets: estados usados por el flujo de saldo pendiente.
--
-- IMPORTANTE: existen filas antiguas con estados que no pertenecen al
-- contrato actual. Por eso el CHECK se crea como NOT VALID: PostgreSQL
-- permite conservar esas filas y, desde este momento, exige los estados
-- correctos en INSERT/UPDATE nuevos.
--
-- Estados actuales de la aplicación:
--   awaiting_balance = pendiente por saldo
--   processed        = procesado
--   rejected         = cancelado/rechazado

ALTER TABLE public.pending_bets
DROP CONSTRAINT IF EXISTS pending_bets_status_check;

ALTER TABLE public.pending_bets
ADD CONSTRAINT pending_bets_status_check
CHECK (status IN ('awaiting_balance', 'processed', 'rejected'))
NOT VALID;

-- Diagnóstico opcional para limpiar posteriormente estados históricos.
-- No ejecutar VALIDATE CONSTRAINT hasta haber corregido esas filas.
-- SELECT status, COUNT(*)
-- FROM public.pending_bets
-- GROUP BY status
-- ORDER BY status;
