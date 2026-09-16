-- LotoPro Parser - Reparación final del esquema de premios
--
-- premios.js utiliza ambas columnas para registrar y consultar ganadores:
--   monto_unitario      -> importe apostado al número/par ganador
--   posicion_resultado  -> posición del corrido en Pick 4
--
-- Idempotente: puede ejecutarse aunque una o ambas columnas ya existan.

begin;

alter table public.premios
  add column if not exists monto_unitario numeric(14,2) not null default 0;

alter table public.premios
  add column if not exists posicion_resultado integer;

create index if not exists idx_premios_bet_tipo_numero_posicion
  on public.premios (bet_id, tipo_jugada, numeros_ganadores, posicion_resultado);

commit;
