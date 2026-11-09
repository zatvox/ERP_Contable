-- 142 · Recibo por Honorarios (02) en Compras + retención de 4ta categoría (2026-11-07)
-- Regla: se retiene 8% si el RH supera S/ 1,500 (por recibo) y el proveedor NO tiene suspensión vigente (Form. 1609, año calendario).
-- Solo estructura y parámetros: sin asientos (generarAsientoRH queda como función semi armada con comentarios).

-- 1) Compras: retención y neto a pagar
alter table compras add column if not exists retencion_4ta numeric(14,2) not null default 0;
alter table compras add column if not exists neto_pagado   numeric(14,2);

-- 2) Contactos: perfil «Renta 4ta» (suspensión vigente)
alter table contacts add column if not exists suspension_4ta_anio       int;   -- año en que rige la suspensión (null = sin suspensión)
alter table contacts add column if not exists suspension_4ta_constancia text;  -- N° de constancia / referencia del Form. 1609

-- 3) Parámetros anuales (los cambia SUNAT; no se hardcodean)
create table if not exists parametros_renta4ta (
  anio                  int primary key,
  tasa_retencion        numeric(5,4)  not null default 0.08,
  umbral_retencion_pen  numeric(14,2) not null default 1500,
  tope_suspension_pen   numeric(14,2) not null default 48125,
  umbral_bancariz_pen   numeric(14,2) not null default 2000,
  umbral_bancariz_usd   numeric(14,2) not null default 500
);
insert into parametros_renta4ta (anio) values (2026) on conflict (anio) do nothing;
alter table parametros_renta4ta enable row level security;
drop policy if exists p_param4ta_all on parametros_renta4ta;
create policy p_param4ta_all on parametros_renta4ta for all using (true) with check (true);

-- 4) CONSULTA (aparte): ¿qué comprobantes aceptan cuentas_pagar y compras?
select conrelid::regclass tabla, conname, pg_get_constraintdef(oid) def from pg_constraint
where conrelid in ('cuentas_pagar'::regclass,'compras'::regclass) and contype='c' and pg_get_constraintdef(oid) ilike '%tipo_comprobante%';
