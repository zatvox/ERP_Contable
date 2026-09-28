// ============================================================================
// shared/catalogo.js — función común de Compras y Ventas (antes duplicada idéntica en ambos). 2026-09-25
// Mapa completo de funciones: Claude outputs/glosario_funciones_erp.md
// ============================================================================
import { getCategorias, addCategoria } from '../supabase-data.js'

// items.categoria_id es NOT NULL (FK a categorias). Este modal rápido solo
// pide el nombre de la categoría como texto libre: se busca por nombre
// (case-insensitive) y si no existe se crea. Ver assets/sql/01_schema.sql.
export async function _resolverCategoriaId(nombreCategoria) {
  const nombre = (nombreCategoria || '').trim()
  const categorias = await getCategorias()
  const buscar = (n) => categorias.find(c => (c.nombre || '').toLowerCase() === n.toLowerCase())

  if (nombre) {
    const existente = buscar(nombre)
    if (existente) return existente.id
    const nueva = await addCategoria({ nombre })
    if (nueva?.id) return nueva.id
  }

  // Fallback: categoría "General" (se crea si no existe todavía)
  const general = buscar('General')
  if (general) return general.id
  const nuevaGeneral = await addCategoria({ nombre: 'General' })
  return nuevaGeneral?.id || null
}
