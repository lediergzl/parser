begin;

-- Permite conservar una jugada cuando el único bloqueo es falta de saldo.
alter table public.pending_bets
drop constraint if exists pending_bets_status_check;

alter table public.pending_bets
add constraint pending_bets_status_check
check (status in ('pending','approved','processed','rejected','error','awaiting_balance'));

create index if not exists pending_bets_balance_idx
  on public.pending_bets(user_telegram_id, status, created_at desc);

commit;
