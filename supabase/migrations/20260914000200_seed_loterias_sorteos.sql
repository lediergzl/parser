-- Catálogo inicial de loterías y sorteos.
-- Idempotente: no duplica registros si se ejecuta más de una vez.

insert into public.loterias (nombre, activo)
select 'Florida', true
where not exists (
  select 1 from public.loterias where lower(nombre) = lower('Florida')
);

insert into public.loterias (nombre, activo)
select 'New York', true
where not exists (
  select 1 from public.loterias where lower(nombre) = lower('New York')
);

insert into public.loterias (nombre, activo)
select 'Georgia', true
where not exists (
  select 1 from public.loterias where lower(nombre) = lower('Georgia')
);

insert into public.sorteos (loteria_id, nombre, hora_apertura, hora_cierre, activo)
select l.id, s.nombre, s.hora_apertura::time, s.hora_cierre::time, true
from (
  values
    ('Florida', 'Día', '00:00', '13:20'),
    ('Florida', 'Noche', '00:00', '21:30'),
    ('New York', 'Día', '00:00', '02:20'),
    ('New York', 'Noche', '00:00', '22:20'),
    ('Georgia', 'Día', '00:00', '12:20'),
    ('Georgia', 'Tarde', '00:00', '18:45'),
    ('Georgia', 'Noche', '00:00', '23:20')
) as s(loteria_nombre, nombre, hora_apertura, hora_cierre)
join public.loterias l on lower(l.nombre) = lower(s.loteria_nombre)
where not exists (
  select 1
  from public.sorteos x
  where x.loteria_id = l.id
    and lower(x.nombre) = lower(s.nombre)
);
