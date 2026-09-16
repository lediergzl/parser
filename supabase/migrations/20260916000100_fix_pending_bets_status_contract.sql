-- Corrige el contrato de estados de pending_bets.
--
-- La aplicación utiliza DOS flujos sobre la misma tabla:
-- 1) revisión humana: pending -> approved -> processed/error
-- 2) saldo insuficiente: awaiting_balance -> processed/rejected
-- Además, el job de expiración utiliza expired.
--
-- La migración anterior 20260915_pending_bets_status_check.sql dejó solamente
-- awaiting_balance/processed/rejected, por lo que una jugada ambigua fallaba
-- al intentar insertarse con status='pending'.
--
-- NOT VALID permite conservar cualquier fila histórica existente con estados
-- antiguos y aplica el CHECK a los INSERT/UPDATE nuevos.

ALTER TABLE public.pending_bets
DROP CONSTRAINT IF EXISTS pending_bets_status_check;

ALTER TABLE public.pending_bets
ADD CONSTRAINT pending_bets_status_check
CHECK (
  status IN (
    'pending',
    'approved',
    'awaiting_balance',
    'processed',
    'rejected',
    'error',
    'expired'
  )
)
NOT VALID;

-- Diagnóstico opcional:
-- SELECT status, COUNT(*)
-- FROM public.pending_bets
-- GROUP BY status
-- ORDER BY status;
