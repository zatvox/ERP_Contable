// ============================================================================
// SUPABASE-CLIENT.JS - Cliente Supabase para JHIRO ERP
// ============================================================================

import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.39.3/+esm'
import { SUPABASE_CONFIG } from './config.js'

export const supabase = createClient(SUPABASE_CONFIG.URL, SUPABASE_CONFIG.ANON_KEY)

// ============================================================================
// FUNCIONES HELPER PARA SUPABASE
// ============================================================================

/**
 * Obtener todos los registros de una tabla
 */
export async function getAll(table) {
  try {
    const { data, error } = await supabase
      .from(table)
      .select('*')
    
    if (error) {
      console.error(`Error fetching ${table}:`, error)
      return []
    }
    return data || []
  } catch (error) {
    console.error('Error en getAll:', error)
    return []
  }
}

/**
 * Obtener un registro por ID
 */
export async function getById(table, id) {
  try {
    const { data, error } = await supabase
      .from(table)
      .select('*')
      .eq('id', id)
      .single()
    
    if (error) {
      console.error(`Error fetching ${table} by ID:`, error)
      return null
    }
    return data
  } catch (error) {
    console.error('Error en getById:', error)
    return null
  }
}

/**
 * Insertar un nuevo registro
 */
export async function insert(table, data) {
  try {
    const { data: result, error } = await supabase
      .from(table)
      .insert([data])
      .select()
    
    if (error) {
      console.error(`Error inserting into ${table}:`, error)
      return null
    }
    return result ? result[0] : null
  } catch (error) {
    console.error('Error en insert:', error)
    return null
  }
}

/**
 * Actualizar un registro
 */
export async function update(table, id, data) {
  try {
    const { data: result, error } = await supabase
      .from(table)
      .update(data)
      .eq('id', id)
      .select()
    
    if (error) {
      console.error(`Error updating ${table}:`, error)
      return null
    }
    return result ? result[0] : null
  } catch (error) {
    console.error('Error en update:', error)
    return null
  }
}

/**
 * Eliminar un registro
 */
export async function deleteRecord(table, id) {
  try {
    const { error } = await supabase
      .from(table)
      .delete()
      .eq('id', id)
    
    if (error) {
      console.error(`Error deleting from ${table}:`, error)
      return false
    }
    return true
  } catch (error) {
    console.error('Error en deleteRecord:', error)
    return false
  }
}

/**
 * Query con filtros
 */
export async function query(table, filters = {}) {
  try {
    let q = supabase.from(table).select('*')
    
    Object.keys(filters).forEach(key => {
      q = q.eq(key, filters[key])
    })
    
    const { data, error } = await q
    
    if (error) {
      console.error(`Error querying ${table}:`, error)
      return []
    }
    return data || []
  } catch (error) {
    console.error('Error en query:', error)
    return []
  }
}

/**
 * Escuchar cambios en tiempo real
 */
export function subscribe(table, callback) {
  const subscription = supabase
    .from(table)
    .on('*', payload => {
      callback(payload)
    })
    .subscribe()
  
  return subscription
}
