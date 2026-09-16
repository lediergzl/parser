-- pending_bets: estados usados por el flujo de saldo pendiente.
-- La aplicación utiliza estos tres estados: awaiting_balance, processed y rejected.
-- La migración elimina el CHECK antiguo (incompatible) y lo reemplaza por el contrato actual.

ALTER TABLE public.pending_bets
DROP CONSTRAINT IF EXISTS pending_bets_status_check;

ALTER TABLE public.pending_bets
ADD CONSTRAINT pending_bets_status_check
CHECK (status IN ('awaiting_balance', 'processed', 'rejected'));
