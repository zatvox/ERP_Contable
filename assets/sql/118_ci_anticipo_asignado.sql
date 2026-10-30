-- Una Proforma (PI) con varios Commercial Invoices: anticipo que absorbe cada CI.
-- Ejecutar en Supabase → SQL Editor. Es seguro repetirlo.
ALTER TABLE comercial_invoices ADD COLUMN IF NOT EXISTS anticipo_asignado numeric(14,2);
COMMENT ON COLUMN comercial_invoices.anticipo_asignado IS 'Parte del anticipo de la PI que se descuenta en el saldo de este CI (NULL = CI único o reparto proporcional)';
NOTIFY pgrst, 'reload schema';
