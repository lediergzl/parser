-- Expiración segura de jugadas que quedaron pendientes de revisión humana.
-- La fecha de la jugada pendiente se toma de created_at en horario de Cuba.
-- Si el sorteo ya cerró ese día, la solicitud deja de bloquear nuevas jugadas.

begin;

alter table public.pending_bets
  drop constraint if exists pending_bets_status_check;

alter table public.pending_bets
  add constraint pending_bets_status_check
  check (status in ('pending', 'approved', 'processed', 'rejected', 'expired', 'error'));

create or replace function public.expire_pending_bets()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  afectados integer := 0;
begin
  update public.pending_bets p
     set status = 'expired',
         error_message = 'La jugada quedó pendiente de revisión hasta después del cierre del sorteo.',
         updated_at = now()
    from public.sorteos s
   where p.sorteo_id = s.id
     and p.status = 'pending'
     and s.hora_cierre is not null
     and now() > (
       (
         (p.created_at at time zone 'America/Havana')::date
         + s.hora_cierre
         + case
             when s.hora_apertura is not null and s.hora_cierre < s.hora_apertura
               then interval '1 day'
             else interval '0 day'
           end
       ) at time zone 'America/Havana'
     );

  get diagnostics afectados = row_count;
  return afectados;
end;
$$;

revoke all on function public.expire_pending_bets() from public;
grant execute on function public.expire_pending_bets() to service_role;

commit;
