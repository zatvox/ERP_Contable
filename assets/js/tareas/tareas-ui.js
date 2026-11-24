// tareas-ui.js — pantalla de Tareas (3 vistas: Mis tareas · Las que pedí · Gerencia) + modal de detalle y de nueva tarea.
import { T, msgError } from './tareas-data.js';

const $ = (s, r = document) => r.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const ETQ = { pendiente: 'Pendiente', en_proceso: 'En proceso', bloqueada: 'Bloqueada', en_revision: 'En revisión', hecha: 'Hecha', anulada: 'Anulada' };
const PRIO = { baja: 'Baja', normal: 'Normal', alta: 'Alta', urgente: 'Urgente' };
const fmtF = (d) => (d ? d.split('-').reverse().join('/') : '—');
const fmtFH = (ts) => new Date(ts).toLocaleString('es-PE', { timeZone: 'America/Lima', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });

const S = { perfil: null, personas: [], vista: 'mias', filas: [], filtro: '', soloAbiertas: true, empresas: null, empresaDefault: null };

function toast(msg, err) { const t = document.createElement('div'); t.className = 'tk-toast' + (err ? ' err' : ''); t.textContent = msg; document.body.appendChild(t); setTimeout(() => t.remove(), 3500); }
async function seguro(fn) { try { return await fn(); } catch (e) { toast(msgError(e), true); return null; } }

export async function iniciar({ empresaId, empresas = null }) {
  S.empresaDefault = empresaId; S.empresas = empresas;
  S.perfil = await T.perfil();
  if (!S.perfil) { $('#tk-root').innerHTML = '<p class="tk-vacio">Tu sesión no está vinculada a un usuario activo. Cierra e inicia sesión de nuevo.</p>'; return; }
  S.personas = await T.personas(empresas);
  if (S.perfil.es_admin || S.perfil.es_jefe) await seguro(() => T.generarRec());   // idempotente
  $('#tk-tab-gerencia').style.display = S.perfil.ve_gerencia ? '' : 'none';
  $('#tk-btn-rec').style.display = S.perfil.ve_gerencia ? '' : 'none';
  document.querySelectorAll('.tk-tab').forEach((b) => b.addEventListener('click', () => { S.vista = b.dataset.v; cargar(); }));
  $('#tk-btn-nueva').addEventListener('click', () => modalNueva());
  $('#tk-btn-rec').addEventListener('click', () => modalRecurrentes());
  $('#tk-buscar').addEventListener('input', (e) => { S.filtro = e.target.value.toLowerCase(); pintar(); });
  $('#tk-abiertas').addEventListener('change', (e) => { S.soloAbiertas = e.target.checked; pintar(); });
  await cargar();
}

async function cargar() {
  document.querySelectorAll('.tk-tab').forEach((b) => b.classList.toggle('active', b.dataset.v === S.vista));
  $('#tk-lista').innerHTML = '<p class="tk-vacio">Cargando…</p>';
  S.filas = (await seguro(() => T.listar(S.vista, S.empresas))) || [];
  if (S.vista === 'gerencia') { const k = await seguro(() => T.kpis(S.empresas)); pintarKpis(k); } else $('#tk-kpis').innerHTML = '';
  pintar();
}

function pintarKpis(k) {
  if (!k) return;
  $('#tk-kpis').innerHTML = [['Pendientes', k.pendientes, ''], ['Vencidas', k.vencidas, k.vencidas ? 'rojo' : ''], ['Bloqueadas', k.bloqueadas, k.bloqueadas ? 'ambar' : ''], ['Cerradas esta semana', k.cerradas_semana, 'verde']]
    .map(([t, n, c]) => `<div class="tk-kpi ${c}"><b>${n}</b><span>${t}</span></div>`).join('');
}

function chipEstado(t) {
  if (t.estado === 'bloqueada') return `<span class="tk-chip bloq" title="${esc(t.bloqueo_motivo)}">Esperando a ${esc(t.bloqueada_por_nombre || 'un tercero')} · ${t.dias_bloqueada ?? 0} d</span>`;
  return `<span class="tk-chip ${t.estado}">${ETQ[t.estado]}</span>`;
}

function pintar() {
  let f = S.filas.filter((t) => (!S.soloAbiertas || !['hecha', 'anulada'].includes(t.estado)) && (!S.filtro || (t.titulo + ' ' + (t.responsable_nombre || '') + ' ' + (t.area || '')).toLowerCase().includes(S.filtro)));
  if (!f.length) { $('#tk-lista').innerHTML = `<p class="tk-vacio">${S.vista === 'mias' ? 'No tienes tareas pendientes 🎉' : 'Nada por mostrar aquí.'}</p>`; return; }
  const gerencia = S.vista === 'gerencia';
  $('#tk-lista').innerHTML = `<table class="tk-tabla"><thead><tr><th>Tarea</th>${S.vista === 'mias' ? '<th>Pidió</th>' : '<th>Responsable</th>'}<th>Estado</th><th>Límite</th></tr></thead><tbody>` +
    f.map((t) => `<tr data-id="${t.id}" class="${t.dias_atraso > 0 ? 'atraso' : ''}">
      <td><b>${t.nueva ? '<span class="tk-nuevo">Nueva</span> ' : ''}${esc(t.titulo)}</b><small>${esc(t.area || '')}${t.registro_etiqueta ? ' · ' + esc(t.registro_etiqueta) : ''}${t.prioridad !== 'normal' ? ' · ' + PRIO[t.prioridad] : ''}</small></td>
      <td>${S.vista === 'mias' ? esc(t.solicitante_nombre) : esc(t.responsable_nombre || 'Sin asignar') + (t.responsable_tiene_cuenta === false ? ' <small>(sin cuenta)</small>' : '')}</td>
      <td>${chipEstado(t)}</td>
      <td>${fmtF(t.fecha_limite)}${t.dias_atraso > 0 ? `<small class="rojo">${t.dias_atraso} d de atraso</small>` : ''}</td></tr>`).join('') + '</tbody></table>';
  document.querySelectorAll('#tk-lista tbody tr').forEach((tr) => tr.addEventListener('click', () => abrirDetalle(tr.dataset.id)));
}

// ---------- Modal base ----------
function modal(html, ancho = 560) {
  const m = document.createElement('div'); m.className = 'tk-modal';
  m.innerHTML = `<div class="tk-card" style="max-width:${ancho}px"><button class="tk-x" aria-label="Cerrar">×</button>${html}</div>`;
  m.addEventListener('click', (e) => { if (e.target === m) m.remove(); });
  $('.tk-x', m).addEventListener('click', () => m.remove());
  document.body.appendChild(m); return m;
}
const optPersonas = (sel, excluir) => '<option value="">— Sin asignar —</option>' + S.personas.filter((p) => p.id !== excluir)
  .map((p) => `<option value="${p.id}" ${String(sel) === String(p.id) ? 'selected' : ''}>${esc(p.nombre)}${p.area ? ' · ' + esc(p.area) : ''}${p.tiene_cuenta ? '' : ' (sin cuenta)'}</option>`).join('');

// ---------- Nueva tarea ----------
export function modalNueva(pre = {}) {
  const yo = S.perfil.empleados?.[0];
  const m = modal(`<h3>Nueva tarea</h3>
    <label>¿Qué hay que hacer?<input id="n-tit" maxlength="140" value="${esc(pre.titulo || '')}" placeholder="Ej: Conciliar banco BCP de octubre"></label>
    <label>Responsable<select id="n-resp">${optPersonas(pre.responsable)}</select></label>
    <div class="fila"><label>Fecha límite<input id="n-lim" type="date" value="${pre.fecha_limite || ''}"></label>
    <label>Prioridad<select id="n-pri">${Object.entries(PRIO).map(([k, v]) => `<option value="${k}" ${k === (pre.prioridad || 'normal') ? 'selected' : ''}>${v}</option>`).join('')}</select></label></div>
    <label>Detalle (opcional)<textarea id="n-det" rows="3">${esc(pre.detalle || '')}</textarea></label>
    ${pre.registro_etiqueta ? `<p class="tk-ref">Relacionada con: <b>${esc(pre.registro_etiqueta)}</b></p>` : ''}
    <div class="tk-acc"><button class="btn btn-secondary" id="n-cancel">Cancelar</button><button class="btn btn-primary" id="n-ok">Crear tarea</button></div>`);
  $('#n-cancel', m).onclick = () => m.remove();
  $('#n-ok', m).onclick = async () => {
    const r = await seguro(() => T.crear({ empresa_id: pre.empresa_id || yo?.empresa_id || S.empresaDefault, titulo: $('#n-tit', m).value, responsable: $('#n-resp', m).value || null,
      fecha_limite: $('#n-lim', m).value, prioridad: $('#n-pri', m).value, detalle: $('#n-det', m).value, modulo_ref: pre.modulo_ref, registro_ref: pre.registro_ref, registro_etiqueta: pre.registro_etiqueta }));
    if (r?.ok) { m.remove(); toast('Tarea creada'); cargar(); }
  };
}

// ---------- Detalle ----------
async function abrirDetalle(id) {
  const t = S.filas.find((x) => x.id === id); if (!t) return;
  const p = t.permisos; if (t.nueva) T.vista(id).catch(() => {});
  const bit = (await seguro(() => T.bitacora(id))) || [];
  const m = modal(`<h3>${esc(t.titulo)}</h3><div class="tk-meta">${chipEstado(t)} <span>Pidió: <b>${esc(t.solicitante_nombre)}</b></span> <span>Responsable: <b>${esc(t.responsable_nombre || 'Sin asignar')}</b></span> <span>Límite: <b>${fmtF(t.fecha_limite)}</b></span></div>
    ${t.detalle ? `<p class="tk-det">${esc(t.detalle)}</p>` : ''}
    ${t.estado === 'bloqueada' ? `<div class="tk-aviso">⏳ Esperando a <b>${esc(t.bloqueada_por_nombre || 'un tercero externo')}</b> desde hace ${t.dias_bloqueada ?? 0} día(s): ${esc(t.bloqueo_motivo)}</div>` : ''}
    <div class="tk-acc wrap" id="d-acc"></div>
    <h4>Historial</h4><ul class="tk-bit">${bit.map((b) => `<li><small>${fmtFH(b.created_at)} · ${esc(b.usuario_nombre || '')}</small> ${b.tipo === 'comentario' ? '💬 ' : ''}${esc(b.detalle || (b.estado_despues ? ETQ[b.estado_antes] + ' → ' + ETQ[b.estado_despues] : b.tipo))}${b.tipo === 'cambio_estado' && b.detalle ? ` <em>(${ETQ[b.estado_antes]} → ${ETQ[b.estado_despues]})</em>` : ''}</li>`).join('')}</ul>
    <div class="fila"><input id="d-com" placeholder="Escribe un comentario…"><button class="btn btn-secondary" id="d-env">Enviar</button></div>`, 640);
  const acc = $('#d-acc', m); const add = (txt, fn, cls = 'sec') => { const b = document.createElement('button'); b.className = 'btn btn-' + ({'':'primary','sec':'secondary','ok':'success','peligro':'danger'}[cls] ?? 'primary'); b.textContent = txt; b.onclick = fn; acc.appendChild(b); };
  const cerrarRec = async (r) => { if (r?.ok) { m.remove(); cargar(); } };
  if (p.cambiar_estado && t.estado !== 'bloqueada') {
    if (['pendiente', 'en_revision'].includes(t.estado)) add('Empezar', async () => cerrarRec(await seguro(() => T.estado(id, 'en_proceso'))), '');
    if (['pendiente', 'en_proceso'].includes(t.estado)) add('Marcar hecha', async () => cerrarRec(await seguro(() => T.estado(id, 'hecha'))), 'ok');
    if (['hecha', 'anulada'].includes(t.estado)) add('Reabrir', async () => cerrarRec(await seguro(() => T.estado(id, 'pendiente'))));
  }
  if (p.bloquear) add('Estoy esperando a…', () => modalBloqueo(id, t, m));
  if (p.desbloquear) add('Ya me lo dieron / Desbloquear', async () => cerrarRec(await seguro(() => T.desbloquear(id))), 'ok');
  if (p.reasignar) add('Reasignar', () => modalReasignar(id, t, m));
  if (p.anular && t.estado !== 'bloqueada') add('Anular', async () => { if (confirm('¿Anular esta tarea?')) cerrarRec(await seguro(() => T.estado(id, 'anulada'))); }, 'peligro');
  $('#d-env', m).onclick = async () => { const v = $('#d-com', m).value.trim(); if (!v) return; const r = await seguro(() => T.comentar(id, v)); if (r?.ok) { m.remove(); abrirDetalle(id); } };
}

function modalBloqueo(id, t, padre) {
  const m = modal(`<h3>Estoy esperando a…</h3><p class="tk-ayuda">Dice quién te frena y por qué; así queda claro de quién depende y desde cuándo.</p>
    <label>¿A quién esperas?<select id="b-quien">${optPersonas('', t.responsable_empleado_id)}</select></label>
    <label>¿Qué te falta?<input id="b-mot" maxlength="200" placeholder="Ej: Falta el voucher del pago"></label>
    <div class="tk-acc"><button class="btn btn-secondary" id="b-c">Cancelar</button><button class="btn btn-primary" id="b-ok">Marcar como bloqueada</button></div>`, 460);
  $('#b-c', m).onclick = () => m.remove();
  $('#b-ok', m).onclick = async () => { const r = await seguro(() => T.bloquear(id, $('#b-quien', m).value || null, $('#b-mot', m).value)); if (r?.ok) { m.remove(); padre.remove(); cargar(); } };
}
function modalReasignar(id, t, padre) {
  const m = modal(`<h3>Reasignar</h3><label>Nuevo responsable<select id="r-quien">${optPersonas('', t.responsable_empleado_id)}</select></label>
    <label>Nota (opcional)<input id="r-nota"></label><div class="tk-acc"><button class="btn btn-secondary" id="r-c">Cancelar</button><button class="btn btn-primary" id="r-ok">Reasignar</button></div>`, 440);
  $('#r-c', m).onclick = () => m.remove();
  $('#r-ok', m).onclick = async () => { const q = $('#r-quien', m).value; if (!q) return toast('Elige a la persona', true); const r = await seguro(() => T.reasignar(id, Number(q), $('#r-nota', m).value)); if (r?.ok) { m.remove(); padre.remove(); cargar(); } };
}

// ---------- Recurrentes ----------
const PER = { diaria: 'Diaria', semanal: 'Semanal', quincenal: 'Quincenal', mensual: 'Mensual' };
const DIAS = ['', 'Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado', 'Domingo'];
async function modalRecurrentes() {
  const lista = (await seguro(() => T.recListar())) || [];
  const m = modal(`<h3>Tareas recurrentes</h3><p class="tk-ayuda">Se crean solas según la periodicidad. Evita olvidar cierres, arqueos y declaraciones.</p>
    <ul class="tk-bit">${lista.map((r) => `<li><b>${esc(r.titulo)}</b> · ${PER[r.periodicidad]}${r.periodicidad === 'semanal' ? ' (límite ' + DIAS[r.dia_referencia] + ')' : r.periodicidad === 'mensual' ? ' (límite día ' + r.dia_referencia + ')' : ''} · ${esc(r.responsable_nombre || '')} · ${r.activa ? 'Activa' : 'Pausada'}
      <button class="btn btn-secondary btn-small" data-t="${r.id}" data-a="${r.activa}">${r.activa ? 'Pausar' : 'Activar'}</button></li>`).join('') || '<li>Aún no hay recurrentes.</li>'}</ul>
    <h4>Nueva recurrente</h4>
    <label>Título<input id="c-tit"></label>
    <label>Responsable<select id="c-resp">${optPersonas('')}</select></label>
    <div class="fila"><label>Periodicidad<select id="c-per">${Object.entries(PER).map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}</select></label>
    <label id="c-diaw">Día límite<select id="c-dia"></select></label></div>
    <div class="tk-acc"><button class="btn btn-primary" id="c-ok">Guardar</button></div>`, 640);
  const per = $('#c-per', m), dia = $('#c-dia', m), w = $('#c-diaw', m);
  const ajusta = () => { w.hidden = !['semanal', 'mensual'].includes(per.value);
    dia.innerHTML = per.value === 'semanal' ? DIAS.slice(1).map((d, i) => `<option value="${i + 1}">${d}</option>`).join('') : Array.from({ length: 31 }, (_, i) => `<option value="${i + 1}">${i + 1}${i === 30 ? ' (o fin de mes)' : ''}</option>`).join(''); };
  per.onchange = ajusta; ajusta();
  m.querySelectorAll('button[data-t]').forEach((b) => b.onclick = async () => { const r = await seguro(() => T.recToggle(b.dataset.t, b.dataset.a !== 'true')); if (r?.ok) { m.remove(); modalRecurrentes(); } });
  $('#c-ok', m).onclick = async () => {
    const resp = $('#c-resp', m).value; const p = S.personas.find((x) => String(x.id) === resp);
    const r = await seguro(() => T.recGuardar({ empresa_id: p?.empresa_id || S.empresaDefault, titulo: $('#c-tit', m).value, responsable: resp ? Number(resp) : null, periodicidad: per.value, dia_referencia: w.hidden ? null : Number(dia.value) }));
    if (r?.ok) { m.remove(); toast('Recurrente guardada'); modalRecurrentes(); }
  };
}
