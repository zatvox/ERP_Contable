// ============================================================================
// CONFIG.JS - Configuración de Supabase
// ============================================================================
// ⚠️  NO SUBIR A GIT (credenciales sensibles)
// ⚠️  Solo se necesita la ANON_KEY en el frontend — NO service_role key.
//     La seguridad se maneja a través de Supabase Auth (JWT) + RLS policies.
//
// El proyecto comparte workspace con ZV Task Manager.
// Tablas del ERP tienen políticas RLS para rol 'authenticated'.
// ============================================================================

export const SUPABASE_CONFIG = {
  URL:      'https://ygqmbgwtciuzgrpycxjx.supabase.co',
  ANON_KEY: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InlncW1iZ3d0Y2l1emdycHljeGp4Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODI4MzE2OTIsImV4cCI6MjA5ODQwNzY5Mn0.FO5y51jl-w46Jszp6e1JS21h_hoMbMSblOuaqW0vxqo'
}

// ============================================================================
// SUNAT_CONFIG — Credenciales de APIs externas
// ⚠️  Completar con tus tokens reales (ver SETUP.md)
// ============================================================================

export const SUNAT_CONFIG = {
  // ── NUBEFACT (CPE: Facturas y Boletas Electrónicas) ──────────────────────
  // Obtener en: https://nubefact.com → Mi cuenta → Configuración → Token API
  NUBEFACT_TOKEN: 'REEMPLAZAR_CON_TU_TOKEN_NUBEFACT',

  // RUC de la empresa emisora (20 dígitos)
  NUBEFACT_RUC:   'REEMPLAZAR_CON_RUC_EMPRESA',

  // Ambiente: 'demo' para pruebas | 'produccion' para SUNAT real
  AMBIENTE:       'demo',

  // ── APIS.PE (Consulta RUC/DNI sin SOAP) ──────────────────────────────────
  // Obtener en: https://apis.pe → Registrarse → Mi cuenta → Tokens
  APIS_PE_TOKEN:  'REEMPLAZAR_CON_TU_TOKEN_APIS_PE'
}

if (!SUPABASE_CONFIG.URL || !SUPABASE_CONFIG.ANON_KEY) {
  console.error('❌ Credenciales de Supabase no configuradas en config.js')
  throw new Error('Faltan credenciales de Supabase')
}

// Validar SUNAT config (aviso suave, no bloquea)
if (SUNAT_CONFIG.NUBEFACT_TOKEN.startsWith('REEMPLAZAR')) {
  console.warn('⚠️  SUNAT_CONFIG no configurado. Ver SETUP.md para obtener tokens.')
}

console.log('✅ Supabase config cargado | Ambiente SUNAT:', SUNAT_CONFIG.AMBIENTE)
