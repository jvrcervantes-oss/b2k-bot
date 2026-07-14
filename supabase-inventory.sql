-- Inventario de motos de Bali Best Motorcycle (rama balibest del bot).
-- Ejecutar una vez en el SQL Editor del proyecto Supabase (Dashboard → SQL Editor → New query).
--
-- Solo lo usa el motor del bot con la service_role key (SUPABASE_SERVICE_KEY en Railway), que
-- salta RLS por diseño; el equipo gestiona las cantidades desde el Table Editor del dashboard,
-- que tampoco pasa por RLS. Por eso RLS va activado sin políticas: cierra el acceso público vía
-- Data API (anon/authenticated) sin bloquear a nadie que de verdad necesita tocar la tabla.

create table if not exists public.moto_inventory (
  model text primary key,
  total_units integer not null default 0,
  updated_at timestamptz not null default now()
);

alter table public.moto_inventory enable row level security;

-- 49 modelos de la tabla de precios de BBM, cantidades en 0 — el equipo las actualiza aquí
-- (Table Editor) o vía SQL. "on conflict do nothing" hace que sea seguro re-ejecutar este script.
insert into public.moto_inventory (model, total_units) values
  ('Honda Beat', 0),
  ('Yamaha Gear', 0),
  ('Honda Genio', 0),
  ('Honda Vario', 0),
  ('Honda Scoopy', 0),
  ('Yamaha Freego', 0),
  ('Yamaha Fazzio', 0),
  ('Yamaha Filano', 0),
  ('Honda Vario 160', 0),
  ('Yamaha Lexi 155', 0),
  ('Honda Stylo 160', 0),
  ('Yamaha Aerox 155', 0),
  ('Honda GTR 150', 0),
  ('Kawasaki W175 TR', 0),
  ('Honda CB150X', 0),
  ('Yamaha WR155', 0),
  ('Honda CRF150', 0),
  ('Kawasaki KLX150', 0),
  ('Kawasaki W175 Cafe', 0),
  ('Yamaha Nmax STD', 0),
  ('Honda PCX STD', 0),
  ('Honda Adv STD', 0),
  ('Yamaha Nmax Turbo/ABS', 0),
  ('Honda PCX ABS', 0),
  ('Honda Adv ABS', 0),
  ('Yamaha Xmax', 0),
  ('Yamaha KLX250', 0),
  ('Kawasaki Versys250', 0),
  ('Honda CRF250', 0),
  ('Vespa Primavera', 0),
  ('Vespa GTS', 0),
  ('Honda Forza', 0),
  ('BMW 310', 0),
  ('Kawasaki Eliminator', 0),
  ('Honda CB500X', 0),
  ('Kawasaki Versys650', 0),
  ('Honda CB650R', 0),
  ('Honda Transalp750', 0),
  ('Kawasaki Z900', 0),
  ('Royal Enfield Himalayan', 0),
  ('155cc (Custom)', 0),
  ('250cc (Custom)', 0),
  ('400cc (Custom)', 0),
  ('650cc (Custom)', 0),
  ('1200cc (Custom)', 0),
  ('Honda Cub C70', 0),
  ('Honda Cub C90', 0),
  ('Vespa Classic', 0),
  ('Honda XR Baja', 0)
on conflict (model) do nothing;
