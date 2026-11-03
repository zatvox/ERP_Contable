// ============================================================================
// WEB-DATA.JS — capa de datos del catálogo público, conectada al ERP.
// Misma API que usaba el sitio JHIRO original (getProductos, getCategorias, …)
// pero ahora lee de las funciones seguras del ERP (rpc) en vez de tablas propias.
// El visitante NUNCA toca tablas: solo crm_catalogo / crm_crear_cotizacion / etc.
// ============================================================================
import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.39.3/+esm'
import { SUPABASE_CONFIG } from '../../../assets/js/config.js'

export const supabase = createClient(SUPABASE_CONFIG.URL, SUPABASE_CONFIG.ANON_KEY)

const ls = {
  get: k => { try { return localStorage.getItem(k) } catch { return null } },
  set: (k, v) => { try { localStorage.setItem(k, v) } catch { /* sin storage */ } },
}

// ---------- contexto: empresa activa + sesión interna ----------
let ctx = null
export async function initCtx() {
  if (ctx) return ctx
  const { data, error } = await supabase.rpc('crm_empresas_publicas')
  if (error) console.error('[CRM] empresas:', error.message)
  let empresas = data || []

  // sesión interna (si entró desde el ERP comparte la sesión)
  let staff = null
  try {
    const { data: { session } } = await supabase.auth.getSession()
    if (session) {
      const { data: u } = await supabase.from('users').select('id, nombre, role, active').eq('auth_id', session.user.id).maybeSingle()
      if (u && u.active !== false && ['admin', 'oficina', 'vendedor'].includes(u.role)) staff = u
    }
  } catch { /* anónimo */ }

  // el personal ve TODAS las empresas, aunque aún no publiquen nada
  if (staff) {
    const { data: todas } = await supabase.from('empresa_config').select('id, codigo, nombre_comercial, color').order('id')
    const ids = new Set(empresas.map(e => e.id))
    ;(todas || []).forEach(e => { if (!ids.has(e.id)) empresas.push({ ...e, whatsapp: null, titulo: null, mensaje: null, mostrar_precios: true, igv_incluido: true, moneda_precio: 'PEN', cuentas_bancarias: [] }) })
    empresas.sort((a, b) => a.id - b.id)
  }

  const q = Number(new URLSearchParams(location.search).get('emp')) || Number(ls.get('crm_emp')) || null
  const emp = empresas.find(e => e.id === q) || empresas[0] || null
  if (emp) ls.set('crm_emp', String(emp.id))
  ctx = { empresas, emp, staff }
  return ctx
}
export const getCtx = () => ctx
export const carritoKey = () => 'crm_carrito_' + (ls.get('crm_emp') || '0')

// ---------- catálogo ----------
const norm = s => String(s ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
export const fotoUrl = p => (!p ? '' : /^https?:/i.test(p) ? p : String(p).replace(/^\/?crm\//, ''))

const DISP = { disponible: 'En stock', poco: 'En stock — Stock limitado', agotado: 'Agotado' }
let cache = { t: 0, emp: null, rows: [] }

async function cargarCatalogo(force = false) {
  const { emp } = await initCtx()
  if (!emp) return []
  if (!force && cache.emp === emp.id && Date.now() - cache.t < 15000) return cache.rows
  const { data, error } = await supabase.rpc('crm_catalogo', { p_empresa: emp.id })
  if (error) { console.error('[CRM] catálogo:', error.message); return cache.rows }
  cache = {
    t: Date.now(), emp: emp.id,
    rows: (data || []).map(r => ({
      id: String(r.id), item_id: r.item_id, nombre: r.nombre, categoria: r.grupo,
      color_nombre: r.color_nombre, color_no: r.color_no, color_hex: r.color_hex,
      thumbnail_url: (Array.isArray(r.fotos) ? r.fotos : []).map(fotoUrl).filter(Boolean),
      descripcion: r.descripcion, aplicaciones: r.aplicaciones,
      precio_referencia: r.precio, precio_moneda: r.moneda || 'PEN', igv_incluido: r.igv_incluido,
      peso_caja_kg: r.peso_caja_kg, conos_por_caja: r.conos_por_caja,
      disponibilidad: DISP[r.semaforo] || 'En stock', semaforo: r.semaforo, orden_display: r.orden_display,
    })),
  }
  return cache.rows
}

export async function getProductos(filtros = {}, force = false) {
  let rows = await cargarCatalogo(force)
  if (filtros.categoria && filtros.categoria !== 'Todos') rows = rows.filter(p => p.categoria === filtros.categoria)
  if (filtros.disponibilidad === 'stock') rows = rows.filter(p => p.semaforo === 'disponible')
  else if (filtros.disponibilidad === 'limited') rows = rows.filter(p => p.semaforo === 'poco')
  const b = norm(filtros.busqueda || '').trim()
  if (b) rows = rows.filter(p => norm(`${p.nombre} ${p.descripcion} ${p.categoria} ${p.color_nombre} ${p.color_no}`).includes(b))
  return rows
}

export async function getProductoById(id) {
  const rows = await cargarCatalogo()
  return rows.find(p => p.id === String(id)) || null
}

export async function getCategorias() {
  const rows = await cargarCatalogo()
  const map = {}
  rows.forEach(r => { map[r.categoria] = (map[r.categoria] || 0) + 1 })
  return Object.entries(map).map(([categoria, total]) => ({ categoria, total })).sort((a, b) => a.categoria.localeCompare(b.categoria))
}

export async function getColoresByCategoria(categoria) {
  const rows = await cargarCatalogo()
  const map = {}
  rows.filter(r => r.categoria === categoria).forEach(r => {
    const k = r.color_hex || r.color_nombre
    if (k && !map[k]) map[k] = { color_hex: r.color_hex, color_nombre: r.color_nombre || '', id: r.id }
  })
  return Object.values(map).sort((a, b) => String(a.color_nombre).localeCompare(String(b.color_nombre)))
}

// ---------- cotización (todo pasa por funciones del servidor) ----------
export async function getClienteByRuc(ruc) {
  const { data } = await supabase.rpc('crm_buscar_ruc', { p_ruc: ruc })
  const r = Array.isArray(data) ? data[0] : data
  return r?.razon_social ? { razon_social: r.razon_social } : null
}

export async function crearCotizacion(c, e, carrito, notas) {
  const { emp } = await initCtx()
  const { data, error } = await supabase.rpc('crm_crear_cotizacion', {
    p_cliente: { ruc: c.ruc, razon_social: c.razon_social, nombre_contacto: c.nombre_contacto, email: c.email, telefono: c.telefono, direccion_fiscal: c.direccion_fiscal },
    p_entrega: { dir_entrega: e.dir_entrega, distrito_entrega: e.distrito_entrega, referencia_entrega: e.referencia_entrega },
    p_lineas: carrito.map(l => ({ catalogo_id: Number(l.producto_id), cantidad_kg: l.cantidad_kg })),
    p_notas: notas || null, p_empresa: emp?.id ?? null,
  })
  if (error) return { error }
  return { cotizacion: { id: data.id, numero_cotizacion: data.numero, total: data.total } }
}

export async function subirComprobante(cotizacionId, archivo) {
  if (archivo.size > 5 * 1024 * 1024) return { url: null, error: { message: 'El archivo supera 5 MB.' } }
  const nombre = archivo.name.replace(/[^\w.\-]+/g, '_')
  const path = `comprobantes/${cotizacionId}/${Date.now()}-${nombre}`
  const up = await supabase.storage.from('crm-comprobantes').upload(path, archivo, { contentType: archivo.type, upsert: false })
  if (up.error) return { url: null, error: up.error }
  const { error } = await supabase.rpc('crm_adjuntar_comprobante', { p_cotizacion: cotizacionId, p_path: path, p_nombre: archivo.name })
  return { url: path, error: error || null }
}

// ---------- cálculos / formato ----------
export function calcularTotalesCarrito(lineas) {
  const s = lineas.reduce((a, l) => a + (l.cantidad_kg || 0) * (l.precio_unitario_pen || 0) * (1 - (l.descuento_pct || 0) / 100), 0)
  const incl = ctx?.emp?.igv_incluido !== false
  const subtotal = incl ? s / 1.18 : s
  const total = incl ? s : s * 1.18
  return { subtotal: +subtotal.toFixed(2), igv: (total - subtotal).toFixed(2), total: +total.toFixed(2) }
}
export const validarRUC = r => /^(\d{8}|\d{11})$/.test(r || '')
export function formatCurrency(value, currency = 'PEN') {
  return `${currency === 'USD' ? '$' : 'S/.'}${(parseFloat(value) || 0).toFixed(2)}`
}
export function formatDate(d) {
  return d ? new Date(d).toLocaleDateString('es-PE', { year: 'numeric', month: '2-digit', day: '2-digit' }) : ''
}
