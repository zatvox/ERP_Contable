// tareas-data.js — capa de datos del módulo Tareas. TODO escribe/lee vía RPC (la seguridad vive en SQL 161).
// ÚNICO punto a verificar al conectar: cómo se obtiene el cliente Supabase en este ERP (ver init.js → obtenerCliente).
let sb = null;
export function setClient(c) { sb = c; }

async function rpc(fn, args = {}) {
  if (!sb) throw new Error('Cliente Supabase no configurado');
  const { data, error } = await sb.rpc(fn, args);
  if (error) throw new Error(error.message || String(error));
  return data;
}

export const T = {
  perfil:        ()                  => rpc('tareas_perfil'),
  personas:      (empresas = null)   => rpc('tareas_personas', { p_empresas: empresas }),
  listar:        (modo, empresas = null) => rpc('tareas_listar', { p_modo: modo, p_empresas: empresas }),
  kpis:          (empresas = null)   => rpc('tareas_kpis', { p_empresas: empresas }),
  bitacora:      (id)                => rpc('tareas_bitacora_de', { p_tarea_id: id }),
  numeros:       ()                  => rpc('tareas_mis_numeros'),
  avisos:        ()                  => rpc('tareas_avisos'),
  generarRec:    ()                  => rpc('tareas_generar_recurrentes'),
  crear:         (o) => rpc('tareas_crear', { p_empresa_id: o.empresa_id, p_titulo: o.titulo, p_responsable_empleado_id: o.responsable ?? null,
                          p_fecha_limite: o.fecha_limite || null, p_detalle: o.detalle || null, p_area: o.area || null, p_prioridad: o.prioridad || 'normal',
                          p_modulo_ref: o.modulo_ref || null, p_registro_ref: o.registro_ref || null, p_registro_etiqueta: o.registro_etiqueta || null }),
  estado:        (id, estado, nota) => rpc('tareas_cambiar_estado', { p_tarea_id: id, p_estado: estado, p_nota: nota || null }),
  bloquear:      (id, porEmpleado, motivo) => rpc('tareas_bloquear', { p_tarea_id: id, p_bloqueada_por_empleado_id: porEmpleado || null, p_motivo: motivo }),
  desbloquear:   (id, nota)          => rpc('tareas_desbloquear', { p_tarea_id: id, p_nota: nota || null }),
  reasignar:     (id, emp, nota)     => rpc('tareas_reasignar', { p_tarea_id: id, p_responsable_empleado_id: emp, p_nota: nota || null }),
  editar:        (id, o)             => rpc('tareas_editar', { p_tarea_id: id, p_titulo: o.titulo, p_detalle: o.detalle || null, p_fecha_limite: o.fecha_limite || null, p_prioridad: o.prioridad }),
  comentar:      (id, texto)         => rpc('tareas_comentar', { p_tarea_id: id, p_texto: texto }),
  vista:         (id)                => rpc('tareas_marcar_vista', { p_tarea_id: id }),
  recListar:     ()                  => rpc('tareas_recurrentes_listar'),
  recGuardar:    (o) => rpc('tareas_recurrente_guardar', { p_id: o.id || null, p_empresa_id: o.empresa_id, p_titulo: o.titulo, p_detalle: o.detalle || null, p_area: o.area || null,
                          p_responsable_empleado_id: o.responsable, p_periodicidad: o.periodicidad, p_dia_referencia: o.dia_referencia ?? null, p_prioridad: o.prioridad || 'normal' }),
  recToggle:     (id, activa)        => rpc('tareas_recurrente_toggle', { p_id: id, p_activa: activa }),
};

// Mensajes de error entendibles (las funciones SQL ya devuelven texto en español)
export const msgError = (e) => String(e?.message || e).replace(/^.*?ERROR:\s*/, '');
