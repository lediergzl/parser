-- LotoPro Parser - Posición del resultado para premios de corrido
--
-- Corrido puede producir dos premios cuando el mismo número aparece en ambas
-- posiciones del Pick 4 (ej. 6868 -> 68 posición 1 y 68 posición 2).
-- La columna debe existir antes de que premios.js pueda consultar/insertar
-- posicion_resultado.

begin;

alter table public.premios
  add column if not exists posicion_resultado integer;

create index if not exists idx_premios_bet_tipo_numero_posicion
  on public.premios (bet_id, tipo_jugada, numeros_ganadores, posicion_resultado);

commit;
