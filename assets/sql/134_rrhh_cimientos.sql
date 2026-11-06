-- ============================================================================
-- 134_rrhh_cimientos.sql — RRHH · etapa R0 (2026-11-05)
-- Régimen laboral por empresa, parámetros legales con vigencia, AFP y empleados.
-- Nada de esto toca Tesorería ni Contabilidad. Re-ejecutable (IF NOT EXISTS).
-- ============================================================================

-- 1) Régimen LABORAL por empresa (distinto del tributario, que ya existe)
ALTER TABLE public.empresa_config
  ADD COLUMN IF NOT EXISTS regimen_laboral varchar NOT NULL DEFAULT 'general'
    CHECK (regimen_laboral IN ('general','mype_micro','mype_pequena'));
ALTER TABLE public.empresa_config
  ADD COLUMN IF NOT EXISTS remype_inscrito boolean NOT NULL DEFAULT false;

-- 2) Parámetros legales con vigencia (globales; los edita el admin)
CREATE TABLE IF NOT EXISTS public.rrhh_parametros (
  id             serial      PRIMARY KEY,
  codigo         varchar     NOT NULL,
  nombre         varchar     NOT NULL,
  valor          numeric(14,4) NOT NULL,
  unidad         varchar     NOT NULL DEFAULT 'pct' CHECK (unidad IN ('pct','soles','uit','veces')),
  vigente_desde  date        NOT NULL DEFAULT DATE '2026-01-01',
  vigente_hasta  date,
  nota           text,
  created_at     timestamptz DEFAULT now(),
  UNIQUE (codigo, vigente_desde)
);

INSERT INTO public.rrhh_parametros (codigo, nombre, valor, unidad, nota) VALUES
 ('RMV',            'Remuneración mínima vital',            1130,     'soles', 'VERIFICAR con el contador: las fuentes consultadas dan S/ 1,130 y S/ 1,230.'),
 ('UIT',            'Unidad Impositiva Tributaria 2026',    5500,     'soles', 'DS 301-2025-EF'),
 ('ASIG_FAM_PCT',   'Asignación familiar (% de la RMV)',    10,       'pct',   NULL),
 ('ESSALUD_PCT',    'EsSalud (aporte del empleador)',       9,        'pct',   'Base mínima = RMV'),
 ('ONP_PCT',        'ONP (descuento al trabajador)',        13,       'pct',   NULL),
 ('AFP_APORTE_PCT', 'AFP aporte obligatorio',               10,       'pct',   NULL),
 ('AFP_PRIMA_PCT',  'AFP prima de seguro',                  1.37,     'pct',   'Igual para las 4 AFP'),
 ('AFP_TOPE',       'AFP tope de remuneración asegurable',  12598.91, 'soles', 'Vigente abr–jun 2026; la SBS lo actualiza por trimestre'),
 ('R5_DEDUCCION_UIT','Renta 5ta: deducción anual',          7,        'uit',   NULL),
 ('R5_TRAMO1_UIT',  'Renta 5ta: tramo 1 hasta',             5,        'uit',   'Tasa 8%'),
 ('R5_TRAMO2_UIT',  'Renta 5ta: tramo 2 hasta',             20,       'uit',   'Tasa 14%'),
 ('R5_TRAMO3_UIT',  'Renta 5ta: tramo 3 hasta',             35,       'uit',   'Tasa 17%'),
 ('R5_TRAMO4_UIT',  'Renta 5ta: tramo 4 hasta',             45,       'uit',   'Tasa 20%; el exceso paga 30%'),
 ('R5_TASA1',       'Renta 5ta: tasa tramo 1',              8,        'pct',   NULL),
 ('R5_TASA2',       'Renta 5ta: tasa tramo 2',              14,       'pct',   NULL),
 ('R5_TASA3',       'Renta 5ta: tasa tramo 3',              17,       'pct',   NULL),
 ('R5_TASA4',       'Renta 5ta: tasa tramo 4',              20,       'pct',   NULL),
 ('R5_TASA5',       'Renta 5ta: tasa exceso',               30,       'pct',   NULL)
ON CONFLICT (codigo, vigente_desde) DO NOTHING;

-- 3) AFP (comisiones vigentes)
CREATE TABLE IF NOT EXISTS public.rrhh_afp (
  id                       serial   PRIMARY KEY,
  nombre                   varchar  NOT NULL UNIQUE,
  comision_flujo_pct       numeric(6,3) NOT NULL,
  comision_mixta_saldo_pct numeric(6,3) NOT NULL,
  vigente_desde            date     NOT NULL DEFAULT DATE '2026-01-01',
  activo                   boolean  NOT NULL DEFAULT true
);
INSERT INTO public.rrhh_afp (nombre, comision_flujo_pct, comision_mixta_saldo_pct) VALUES
 ('Habitat',   1.47, 1.25),
 ('Integra',   1.55, 0.78),
 ('Prima',     1.60, 1.25),
 ('Profuturo', 1.69, 0.68)
ON CONFLICT (nombre) DO NOTHING;

-- 4) Empleados — SIEMPRE de una empresa. user_id es opcional: hay personal sin
--    cuenta del sistema (su asistencia la marca el admin).
CREATE TABLE IF NOT EXISTS public.empleados (
  id                  serial      PRIMARY KEY,
  empresa_id          integer     NOT NULL REFERENCES public.empresa_config(id),
  contact_id          integer     NOT NULL REFERENCES public.contacts(id),
  user_id             integer     REFERENCES public.users(id),
  vinculo             varchar     NOT NULL DEFAULT 'planilla' CHECK (vinculo IN ('planilla','rh_prestador')),
  cargo               varchar,
  sede_id             integer     REFERENCES public.sedes(id),
  fecha_ingreso       date,
  fecha_cese          date,
  motivo_cese         varchar,
  estado              varchar     NOT NULL DEFAULT 'activo' CHECK (estado IN ('activo','suspendido','cesado')),
  sueldo_mensual      numeric(12,2) NOT NULL DEFAULT 0 CHECK (sueldo_mensual >= 0),
  asignacion_familiar boolean     NOT NULL DEFAULT false,
  sistema_pensiones   varchar     NOT NULL DEFAULT 'onp' CHECK (sistema_pensiones IN ('onp','afp','sin_aporte')),
  afp_id              integer     REFERENCES public.rrhh_afp(id),
  cuspp               varchar,
  tipo_comision_afp   varchar     CHECK (tipo_comision_afp IN ('flujo','mixta')),
  jornada_horas       numeric(4,1) NOT NULL DEFAULT 8,
  hora_entrada        time        NOT NULL DEFAULT '08:30',
  hora_salida         time        NOT NULL DEFAULT '18:00',
  tolerancia_min      integer     NOT NULL DEFAULT 10,
  notas               text,
  created_at          timestamptz DEFAULT now(),
  updated_at          timestamptz DEFAULT now(),
  UNIQUE (empresa_id, contact_id),
  CONSTRAINT ck_emp_afp CHECK (sistema_pensiones <> 'afp' OR afp_id IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS idx_empleados_empresa ON public.empleados(empresa_id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_empleados_user_empresa ON public.empleados(user_id, empresa_id) WHERE user_id IS NOT NULL;

-- 5) RLS — mismo criterio que el resto hoy (USING true); se endurece junto con
--    el resto del ERP. OJO: aquí hay sueldos, endurecer esto es prioridad.
ALTER TABLE public.rrhh_parametros ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.rrhh_afp        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.empleados       ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='rrhh_parametros' AND policyname='rrhh_all') THEN
    CREATE POLICY rrhh_all ON public.rrhh_parametros FOR ALL USING (true) WITH CHECK (true); END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='rrhh_afp' AND policyname='rrhh_all') THEN
    CREATE POLICY rrhh_all ON public.rrhh_afp FOR ALL USING (true) WITH CHECK (true); END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='empleados' AND policyname='rrhh_all') THEN
    CREATE POLICY rrhh_all ON public.empleados FOR ALL USING (true) WITH CHECK (true); END IF;
END $$;

COMMENT ON TABLE public.empleados IS 'RRHH: un registro por persona y empresa. user_id NULL = sin cuenta del sistema (asistencia la marca el admin).';
