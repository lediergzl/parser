-- Preserve the position of a Pick 4 corrido when two positions contain
-- the same two-digit value (example: 6868 -> 68,68).
-- Safe to run more than once.

begin;

alter table public.premios
  add column if not exists posicion_resultado integer;

alter table public.premios
  drop constraint if exists premios_posicion_resultado_check;

alter table public.premios
  add constraint premios_posicion_resultado_check
  check (posicion_resultado is null or posicion_resultado >= 1);

create index if not exists idx_premios_bet_tipo_numero_posicion
  on public.premios (bet_id, tipo_jugada, numeros_ganadores, posicion_resultado);

commit;
