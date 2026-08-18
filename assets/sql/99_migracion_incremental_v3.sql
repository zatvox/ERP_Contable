-- ============================================================
-- 99_migracion_incremental_v3.sql
-- Migración incremental: schema v2 → v3
-- Usar SOLO si ya tienes datos y no quieres hacer drop completo.
-- Si vas desde cero: usa 00_drop_all + 01_schema (Opción A).
-- ============================================================

-- ────────────────────────────────────────────────────────────
-- 1. journal_entries: numero → numero_asiento
-- ────────────────────────────────────────────────────────────
ALTER TABLE public.journal_entries
  RENAME COLUMN numero TO numero_asiento;

-- Índice actualizado
DROP INDEX IF EXISTS public.idx_journal_entries_numero;
CREATE INDEX IF NOT EXISTS idx_journal_entries_numero_asiento
  ON public.journal_entries(numero_asiento);

-- ────────────────────────────────────────────────────────────
-- 2. journal_entry_lines: entry_id → journal_entry_id
--                         tipo + importe → debe + haber
-- ────────────────────────────────────────────────────────────

-- 2a. Renombrar FK
ALTER TABLE public.journal_entry_lines
  RENAME COLUMN entry_id TO journal_entry_id;

-- 2b. Agregar columnas nuevas
ALTER TABLE public.journal_entry_lines
  ADD COLUMN IF NOT EXISTS debe  NUMERIC NOT NULL DEFAULT 0 CHECK (debe  >= 0),
  ADD COLUMN IF NOT EXISTS haber NUMERIC NOT NULL DEFAULT 0 CHECK (haber >= 0);

-- 2c. Poblar debe/haber desde tipo+importe existentes
UPDATE public.journal_entry_lines
SET
  debe  = CASE WHEN tipo = 'debe'  THEN COALESCE(importe, 0) ELSE 0 END,
  haber = CASE WHEN tipo = 'haber' THEN COALESCE(importe, 0) ELSE 0 END
WHERE tipo IS NOT NULL;

-- 2d. Agregar constraints de integridad
ALTER TABLE public.journal_entry_lines
  ADD CONSTRAINT chk_jel_debe_o_haber
    CHECK (debe > 0 OR haber > 0),
  ADD CONSTRAINT chk_jel_no_ambos
    CHECK (NOT (debe > 0 AND haber > 0));

-- 2e. Eliminar columnas antiguas (una vez validado el paso 2c)
ALTER TABLE public.journal_entry_lines
  DROP COLUMN IF EXISTS tipo,
  DROP COLUMN IF EXISTS importe;

-- 2f. Agregar columnas nuevas de CxC/CxP en líneas (si no existen)
ALTER TABLE public.journal_entry_lines
  ADD COLUMN IF NOT EXISTS contact_id        UUID REFERENCES public.contacts(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS referencia_doc    VARCHAR(100),
  ADD COLUMN IF NOT EXISTS fecha_vencimiento DATE;

-- ────────────────────────────────────────────────────────────
-- 3. Nuevas tablas (si no existen)
-- ────────────────────────────────────────────────────────────

-- empresa_config
CREATE TABLE IF NOT EXISTS public.empresa_config (
  id               SERIAL PRIMARY KEY,
  ruc              VARCHAR(11) NOT NULL UNIQUE,
  razon_social     TEXT NOT NULL,
  nombre_comercial TEXT,
  direccion        TEXT,
  ubigeo           VARCHAR(6),
  igv_porcentaje   NUMERIC DEFAULT 18,
  moneda_funcional VARCHAR(3) DEFAULT 'PEN',
  regimen_tributario TEXT,
  created_at       TIMESTAMPTZ DEFAULT now()
);

-- almacenes
CREATE TABLE IF NOT EXISTS public.almacenes (
  id          SERIAL PRIMARY KEY,
  codigo      VARCHAR(20) NOT NULL UNIQUE,
  nombre      TEXT NOT NULL,
  direccion   TEXT,
  ubigeo      VARCHAR(6),
  activo      BOOLEAN DEFAULT TRUE,
  created_at  TIMESTAMPTZ DEFAULT now()
);

-- ubicaciones
CREATE TABLE IF NOT EXISTS public.ubicaciones (
  id          SERIAL PRIMARY KEY,
  almacen_id  INTEGER REFERENCES public.almacenes(id) ON DELETE CASCADE,
  codigo      VARCHAR(30) NOT NULL,
  descripcion TEXT,
  activo      BOOLEAN DEFAULT TRUE
);

-- letras_cambio
CREATE TABLE IF NOT EXISTS public.letras_cambio (
  id                 SERIAL PRIMARY KEY,
  numero_letra       VARCHAR(50) NOT NULL UNIQUE,
  tipo               VARCHAR(10) NOT NULL CHECK (tipo IN ('emitida','recibida')),
  contact_id         UUID REFERENCES public.contacts(id) ON DELETE SET NULL,
  journal_entry_id   INTEGER REFERENCES public.journal_entries(id) ON DELETE SET NULL,
  fecha_emision      DATE NOT NULL,
  fecha_vencimiento  DATE NOT NULL,
  moneda             VARCHAR(3) DEFAULT 'PEN',
  monto              NUMERIC NOT NULL CHECK (monto > 0),
  tipo_cambio        NUMERIC DEFAULT 1,
  monto_pen          NUMERIC,
  cuenta_contable    VARCHAR(10),
  estado             VARCHAR(20) DEFAULT 'vigente'
    CHECK (estado IN ('vigente','cobrada','pagada','protestada','descontada','en_cobranza')),
  banco_id           INTEGER REFERENCES public.bancos(id) ON DELETE SET NULL,
  referencia_doc     VARCHAR(100),
  notas              TEXT,
  created_at         TIMESTAMPTZ DEFAULT now(),
  updated_at         TIMESTAMPTZ DEFAULT now()
);

-- carpetas_importacion
CREATE TABLE IF NOT EXISTS public.carpetas_importacion (
  id                   SERIAL PRIMARY KEY,
  numero_carpeta       VARCHAR(50) NOT NULL UNIQUE,
  descripcion          TEXT,
  proveedor_id         UUID REFERENCES public.contacts(id) ON DELETE SET NULL,
  fecha_apertura       DATE,
  fecha_cierre         DATE,
  estado               VARCHAR(20) DEFAULT 'abierta'
    CHECK (estado IN ('abierta','cerrada','cancelada')),
  moneda               VARCHAR(3) DEFAULT 'USD',
  fob_total_usd        NUMERIC DEFAULT 0,
  cif_total_pen        NUMERIC DEFAULT 0,
  gastos_destino_pen   NUMERIC DEFAULT 0,
  costo_total_pen      NUMERIC DEFAULT 0,
  factor               NUMERIC,
  tipo_cambio          NUMERIC DEFAULT 1,
  notas                TEXT,
  created_at           TIMESTAMPTZ DEFAULT now(),
  updated_at           TIMESTAMPTZ DEFAULT now()
);

-- FK diferida lotes → carpetas_importacion (evita circular ref)
ALTER TABLE public.lotes
  ADD COLUMN IF NOT EXISTS carpeta_importacion_id INTEGER,
  ADD COLUMN IF NOT EXISTS costo_estado            VARCHAR(15) DEFAULT 'definitivo'
    CHECK (costo_estado IN ('provisional','definitivo')),
  ADD COLUMN IF NOT EXISTS costo_unitario_provisional NUMERIC,
  ADD COLUMN IF NOT EXISTS almacen_id             INTEGER REFERENCES public.almacenes(id),
  ADD COLUMN IF NOT EXISTS dua_numero             VARCHAR(50),
  ADD COLUMN IF NOT EXISTS fecha_ingreso          DATE;

ALTER TABLE public.lotes
  DROP CONSTRAINT IF EXISTS fk_lotes_carpeta;

ALTER TABLE public.lotes
  ADD CONSTRAINT fk_lotes_carpeta
  FOREIGN KEY (carpeta_importacion_id) REFERENCES public.carpetas_importacion(id);

-- ────────────────────────────────────────────────────────────
-- 4. Recrear vistas contables (usan los nuevos nombres de columna)
-- ────────────────────────────────────────────────────────────
-- Ejecutar 12_vistas_contables.sql después de este script.

-- ────────────────────────────────────────────────────────────
-- 5. Habilitar RLS en nuevas tablas
-- ────────────────────────────────────────────────────────────
ALTER TABLE public.empresa_config      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.almacenes           ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ubicaciones         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.letras_cambio       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.carpetas_importacion ENABLE ROW LEVEL SECURITY;

-- Políticas básicas (ajustar según necesidad)
CREATE POLICY "auth read empresa_config"
  ON public.empresa_config FOR SELECT TO authenticated USING (true);

CREATE POLICY "auth all almacenes"
  ON public.almacenes FOR ALL TO authenticated USING (true) WITH CHECK (true);

CREATE POLICY "auth all ubicaciones"
  ON public.ubicaciones FOR ALL TO authenticated USING (true) WITH CHECK (true);

CREATE POLICY "auth all letras_cambio"
  ON public.letras_cambio FOR ALL TO authenticated USING (true) WITH CHECK (true);

CREATE POLICY "auth all carpetas_importacion"
  ON public.carpetas_importacion FOR ALL TO authenticated USING (true) WITH CHECK (true);

-- ────────────────────────────────────────────────────────────
-- Verificación final
-- ────────────────────────────────────────────────────────────
-- Confirma que debe/haber quedaron bien:
-- SELECT COUNT(*) FROM journal_entry_lines WHERE debe = 0 AND haber = 0;
-- Debe retornar 0 (si hay filas con 0/0 son datos corruptos del schema viejo)

-- Confirma renombre:
-- SELECT numero_asiento FROM journal_entries LIMIT 3;
-- SELECT journal_entry_id, debe, haber FROM journal_entry_lines LIMIT 3;
