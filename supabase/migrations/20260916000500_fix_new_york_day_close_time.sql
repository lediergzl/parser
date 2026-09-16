-- New York Día cierra a las 2:20 PM, no a las 2:20 AM.
-- La hora se almacena como TIME en formato 24 horas.

begin;

update public.sorteos s
set hora_cierre = '14:20'::time,
    updated_at = now()
from public.loterias l
where s.loteria_id = l.id
  and lower(l.nombre) = lower('New York')
  and lower(s.nombre) = lower('Día');

commit;
