-- 157 · Detracciones (SPOT) en Compras y Cuentas por Pagar (2026-11-11)
-- Solo COMPRAS de SERVICIOS gravados con IGV (Anexo 3 de la R.S. 183-2004/SUNAT). Ventas/cobranzas quedan fuera de esta etapa.
-- Modelo: la CxP queda por el TOTAL; la detracción es una parte de ese total que se paga por separado:
--   · camino A (lo paga el PROVEEDOR): pagamos el total al proveedor y registramos su constancia de depósito (sin movimiento de banco extra).
--   · camino B (lo pagamos NOSOTROS): pago medio 'detraccion' (egreso de nuestro banco) + pago del neto al proveedor.
-- Fuente de verdad: compras.detraccion_*; cuentas_pagar.detraccion_* es el espejo para trabajar en CxP.
-- Tasas/códigos: por_verificar=true hasta que el contador confirme el Anexo 3 vigente (editable, no hardcodeado en el código).

-- 1) Catálogo de tasas (único para todo el sistema; editable)
create table if not exists detraccion_tasas (
  codigo        text primary key,                 -- código SUNAT (Anexo 4): '037'
  descripcion   text not null,
  anexo         smallint not null default 3,
  porcentaje    numeric(5,2) not null,
  monto_minimo  numeric(14,2) not null default 700, -- se detrae si el importe de la operación es MAYOR a este monto (S/)
  palabras_clave text,                             -- para sugerir el código según la descripción del servicio (separadas por coma)
  por_verificar boolean not null default true,
  activo        boolean not null default true,
  orden         int not null default 0
);
alter table detraccion_tasas enable row level security;
drop policy if exists p_detr_tasas_all on detraccion_tasas;
create policy p_detr_tasas_all on detraccion_tasas for all using (true) with check (true);

insert into detraccion_tasas (codigo, descripcion, porcentaje, palabras_clave, orden) values
 ('012','Intermediación laboral y tercerización',12,'intermediacion,tercerizacion,tercerización,outsourcing,personal temporal',10),
 ('019','Arrendamiento de bienes (muebles e inmuebles)',10,'alquiler,arrendamiento,renta de,leasing',20),
 ('020','Mantenimiento y reparación de bienes muebles',12,'mantenimiento,reparacion,reparación,servicio tecnico,servicio técnico',30),
 ('021','Movimiento de carga',10,'estiba,desestiba,movimiento de carga,montacarga,descarga,carga y descarga,cuadrilla,almacenaje',40),
 ('022','Otros servicios empresariales',12,'asesoria,asesoría,consultoria,consultoría,contable,legal,publicidad,marketing,auditoria,auditoría,agenciamiento,despacho aduanero,agente de aduana',50),
 ('024','Comisión mercantil',10,'comision,comisión',60),
 ('025','Fabricación de bienes por encargo',10,'fabricacion por encargo,fabricación por encargo,maquila',70),
 ('026','Servicio de transporte de personas',10,'transporte de personas,pasajeros,movilidad',80),
 ('027','Servicio de transporte de bienes por vía terrestre',4,'transporte terrestre,flete terrestre,transporte de carga,acarreo,flete local',90),
 ('030','Contratos de construcción',4,'construccion,construcción,obra,ingenieria civil,ingeniería civil',100),
 ('037','Demás servicios gravados con el IGV',12,'sobreestadia,sobreestadía,demurrage,servicio,penalidad,late payment,gastos administrativos',110)
on conflict (codigo) do nothing;

-- 2) Perfil del proveedor: sección «Detracción» (la consulta y la completa el modal de compra)
alter table contacts add column if not exists detraccion_codigo        text;           -- código habitual de su servicio
alter table contacts add column if not exists detraccion_pct           numeric(5,2);   -- % habitual
alter table contacts add column if not exists detraccion_cuenta_bn     text;           -- N° de su cuenta de detracciones en el Banco de la Nación
alter table contacts add column if not exists detraccion_paga_habitual text;           -- 'proveedor' | 'nosotros' (quién suele depositar)
alter table contacts drop constraint if exists contacts_detraccion_paga_chk;
alter table contacts add constraint contacts_detraccion_paga_chk check (detraccion_paga_habitual is null or detraccion_paga_habitual in ('proveedor','nosotros'));

-- 3) Compras (fuente de verdad) y CxP (espejo)
alter table compras add column if not exists detraccion_aplica     boolean not null default false;
alter table compras add column if not exists detraccion_codigo     text;
alter table compras add column if not exists detraccion_pct        numeric(5,2);
alter table compras add column if not exists detraccion_monto      numeric(14,2);   -- SIEMPRE en soles (SUNAT redondea al sol)
alter table compras add column if not exists detraccion_estado     text not null default 'no_aplica';
alter table compras add column if not exists detraccion_pagada_por text;            -- 'nosotros' | 'proveedor'
alter table compras add column if not exists detraccion_fecha      date;            -- fecha del depósito
alter table compras add column if not exists detraccion_operacion  text;            -- N° de operación / constancia
alter table compras add column if not exists detraccion_cuenta_bn  text;            -- cuenta destino (BN del proveedor) usada en este comprobante
alter table compras add column if not exists detraccion_pago_id    bigint;          -- pagos_proveedores.id cuando la pagamos nosotros

alter table cuentas_pagar add column if not exists detraccion_aplica     boolean not null default false;
alter table cuentas_pagar add column if not exists detraccion_codigo     text;
alter table cuentas_pagar add column if not exists detraccion_pct        numeric(5,2);
alter table cuentas_pagar add column if not exists detraccion_monto      numeric(14,2);
alter table cuentas_pagar add column if not exists detraccion_estado     text not null default 'no_aplica';
alter table cuentas_pagar add column if not exists detraccion_pagada_por text;
alter table cuentas_pagar add column if not exists detraccion_fecha      date;
alter table cuentas_pagar add column if not exists detraccion_operacion  text;

alter table compras        drop constraint if exists compras_detraccion_estado_chk;
alter table compras        add  constraint compras_detraccion_estado_chk check (detraccion_estado in ('no_aplica','pendiente','depositada'));
alter table cuentas_pagar  drop constraint if exists cxp_detraccion_estado_chk;
alter table cuentas_pagar  add  constraint cxp_detraccion_estado_chk check (detraccion_estado in ('no_aplica','pendiente','depositada'));
alter table compras        drop constraint if exists compras_detraccion_pagada_chk;
alter table compras        add  constraint compras_detraccion_pagada_chk check (detraccion_pagada_por is null or detraccion_pagada_por in ('nosotros','proveedor'));
alter table cuentas_pagar  drop constraint if exists cxp_detraccion_pagada_chk;
alter table cuentas_pagar  add  constraint cxp_detraccion_pagada_chk check (detraccion_pagada_por is null or detraccion_pagada_por in ('nosotros','proveedor'));

create index if not exists idx_compras_detraccion_pend on compras (detraccion_estado) where detraccion_estado = 'pendiente';
create index if not exists idx_cxp_detraccion_pend     on cuentas_pagar (detraccion_estado) where detraccion_estado = 'pendiente';

-- 4) Pagos a proveedores: el pago de la detracción es un pago más (medio 'detraccion'); se guarda su importe en soles
alter table pagos_proveedores add column if not exists monto_pen          numeric(14,2);   -- importe en soles (la detracción siempre es en S/)
alter table pagos_proveedores add column if not exists detraccion_cuenta_bn text;           -- cuenta BN del proveedor a la que se depositó

-- 5) Documentos del costeo (Importaciones): espejo para ver «quién depositó» en Por regularizar
alter table documentos_importacion add column if not exists detraccion_monto  numeric(14,2);
alter table documentos_importacion add column if not exists detraccion_estado text;

-- 6) VERIFICACIÓN (resultados en el panel)
select codigo, descripcion, porcentaje, monto_minimo, por_verificar from detraccion_tasas order by orden;
select table_name, column_name from information_schema.columns
 where table_schema='public' and column_name like 'detraccion%' and table_name in ('contacts','compras','cuentas_pagar','pagos_proveedores','documentos_importacion')
 order by table_name, column_name;
