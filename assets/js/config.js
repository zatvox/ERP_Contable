// ============================================================================
// CONFIG.JS - Configuración segura de Supabase
// ============================================================================
// ⚠️ IMPORTANTE: Este archivo contiene credenciales
// - NO SUBIR A GIT (agregado a .gitignore)
// - Reemplaza URL y ANON_KEY con tus valores de Supabase
// ============================================================================

export const SUPABASE_CONFIG = {
  URL: 'https://ishwabioqxdpbldcxpwc.supabase.co',
  ANON_KEY: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImlzaHdhYmlvcXhkcGJsZGN4cHdjIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzg3NjExMTQsImV4cCI6MjA5NDMzNzExNH0.TtzSkl4_O9rU69vckQhtpZOFtL_LxqdQX0DhBHddBDU'
}

// Validar que existan las credenciales
if (!SUPABASE_CONFIG.URL || !SUPABASE_CONFIG.ANON_KEY) {
  console.error('❌ Credenciales de Supabase no configuradas en config.js')
  throw new Error('Faltan credenciales de Supabase')
}

console.log('✅ Configuración de Supabase cargada correctamente')
  