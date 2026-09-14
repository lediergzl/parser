-- Agrega monto_unitario a premios: el pago se calcula sobre lo apostado a
-- ese número/par específico, no sobre el total de la línea.
begin;

alter table public.premios
  add column if not exists monto_unitario numeric(14,2) not null default 0;

commit;
