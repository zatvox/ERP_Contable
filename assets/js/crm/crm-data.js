// CAPA 1 · DATOS — todo acceso a Supabase del módulo CRM. Sin HTML aquí.
import { supabase } from '../supabase-client.js'

const q = async (p) => { const { data, error } = await p; if (error) throw new Error(error.message); return data }
export const rpc = (fn, args) => q(supabase.rpc(fn, args))

export async function getYo() {
  const { data: { session } } = await supabase.auth.getSession()
  if (!session) return null
  const { data } = await supabase.from('users').select('id, nombre, role, active').eq('auth_id', session.user.id).maybeSingle()
  if (!data || data.active === false) return null
  return { ...data, esStaff: ['admin', 'oficina', 'vendedor'].includes(data.role), esGestor: ['admin', 'oficina'].includes(data.role) }
}

export const getCotizaciones = (emp) => q(supabase.from('crm_cotizaciones').select('*').eq('empresa_id', emp).order('created_at', { ascending: false }).limit(500))
export const getSemaforos = (emp) => rpc('crm_cotizaciones_semaforo', { p_empresa: emp })
export async function getCotizacionFull(id) {
  const [c, d, s] = await Promise.all([
    q(supabase.from('crm_cotizaciones').select('*').eq('id', id).single()),
    q(supabase.from('crm_cotizacion_detalle').select('*').eq('cotizacion_id', id).order('orden_linea')),
    q(supabase.from('crm_seguimiento').select('*').eq('cotizacion_id', id).order('created_at', { ascending: false }))])
  return { c, d, s }
}
export const getMargenCot = (id) => rpc('crm_cotizacion_margen', { p_cot: id })
export const updCotizacion = (id, patch) => q(supabase.from('crm_cotizaciones').update(patch).eq('id', id))
export const addSeguimiento = (row) => q(supabase.from('crm_seguimiento').insert(row))
export const getUsuariosCRM = () => q(supabase.from('users').select('id,nombre,role').in('role', ['admin', 'oficina', 'vendedor']))
export async function urlComprobante(path) {
  const { data, error } = await supabase.storage.from('crm-comprobantes').createSignedUrl(path, 120)
  if (error) throw new Error(error.message); return data.signedUrl
}

export const getClientes = () => q(supabase.from('crm_clientes').select('*').order('created_at', { ascending: false }).limit(500))
export const getCotResumen = (emp) => q(supabase.from('crm_cotizaciones').select('cliente_id,total,estado').eq('empresa_id', emp))
export const getStockLotes = (emp) => rpc('crm_stock_lotes', { p_empresa: emp })

// ---- precios / despacho (solo gestor)
export const getDespachoResumen = (emp, dias) => rpc('crm_despacho_resumen', { p_empresa: emp, p_dias: dias || null })
export const getDespachoGuias = (emp, dias) => rpc('crm_despacho_por_guia', { p_empresa: emp, p_dias: dias || null })
export const getPrecios = (emp, soloStock = true) => rpc('crm_precios_sugeridos', { p_empresa: emp, p_solo_stock: soloStock })
export const aplicarPrecios = (emp, lotes) => rpc('crm_aplicar_precios', { p_empresa: emp, p_lotes: lotes })
export const getConfigPrecios = (emp) => q(supabase.from('crm_config_precios').select('*').eq('empresa_id', emp).maybeSingle())
export const saveConfigPrecios = (emp, patch) => q(supabase.from('crm_config_precios').update(patch).eq('empresa_id', emp))
export const getCategorias = () => q(supabase.from('categorias').select('id,nombre').order('nombre'))
export const getMargenesFamilia = (emp) => q(supabase.from('crm_margen_familia').select('*').eq('empresa_id', emp))
export const saveMargenFamilia = (row) => q(supabase.from('crm_margen_familia').upsert(row, { onConflict: 'empresa_id,categoria_id' }))
export const delMargenFamilia = (emp, cat) => q(supabase.from('crm_margen_familia').delete().eq('empresa_id', emp).eq('categoria_id', cat))

// ---- catálogo web (gestor)
export const getItems = () => q(supabase.from('items').select('id,nombre,precio_venta,activo').eq('activo', true).order('nombre').limit(2000))
export const getCatCfg = (emp) => q(supabase.from('crm_catalogo_config').select('*').eq('empresa_id', emp))
export const insCatCfg = (row) => q(supabase.from('crm_catalogo_config').insert(row))
export const updCatCfg = (id, patch) => q(supabase.from('crm_catalogo_config').update(patch).eq('id', id))
export const upsertCatCfg = (row) => q(supabase.from('crm_catalogo_config').upsert(row, { onConflict: 'empresa_id,item_id' }))
export async function subirFoto(itemId, file) {
  const path = `items/${itemId}/${Date.now()}-${file.name.replace(/[^\w.\-]+/g, '_')}`
  const up = await supabase.storage.from('crm-catalogo').upload(path, file, { contentType: file.type })
  if (up.error) throw new Error(up.error.message)
  return supabase.storage.from('crm-catalogo').getPublicUrl(path).data.publicUrl
}
export async function getManifest() { try { return await (await fetch('crm/assets/fotos/manifest.json')).json() } catch { return [] } }

// ---- web + flete (gestor)
export const getConfigWeb = (emp) => q(supabase.from('crm_config').select('*').eq('empresa_id', emp).maybeSingle())
export const saveConfigWeb = (emp, patch) => q(supabase.from('crm_config').update(patch).eq('empresa_id', emp))
export const getZonas = () => q(supabase.from('crm_flete_zonas').select('*').order('km'))
export const saveZona = (row) => row.id ? q(supabase.from('crm_flete_zonas').update(row).eq('id', row.id)) : q(supabase.from('crm_flete_zonas').insert(row))
export const getReglas = () => q(supabase.from('crm_flete_reglas').select('*').order('hasta_km'))
export const saveRegla = (row) => row.id ? q(supabase.from('crm_flete_reglas').update(row).eq('id', row.id)) : q(supabase.from('crm_flete_reglas').insert(row))
export const delRegla = (id) => q(supabase.from('crm_flete_reglas').delete().eq('id', id))
export const fleteCalc = (emp, distrito, kg) => rpc('crm_flete_calcular', { p_empresa: emp, p_distrito: distrito, p_kg: kg })

// ---- bandeja unificada por COT (SQL 136): web + cotizaciones ERP + PK facturados sin guía
export const getBandeja = (emp, todo = false) => rpc('crm_bandeja', { p_empresa: emp, p_todo: !!todo })
export const getMapaEntregas = (emp, dias = 7) => rpc('crm_mapa_entregas', { p_empresa: emp, p_dias: dias })
export const getMapaOrigen = (emp) => rpc('crm_mapa_origen', { p_empresa: emp })
export const convertirAPacking = (cotId) => rpc('crm_convertir_a_packing', { p_cot: cotId })

export function suscribirCotizaciones(cb) {
  return supabase.channel('crm-cot-erp').on('postgres_changes', { event: '*', schema: 'public', table: 'crm_cotizaciones' }, cb).subscribe()
}
