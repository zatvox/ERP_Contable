// ============================================================================
// MAIN.JS - Funciones globales de la aplicación
// ============================================================================
import { getItems } from './supabase-data.js'
import { getCurrentUser } from './auth-supabase.js'

const THEME_KEY = 'erp_theme';

// ============================================================================
// TEMA CLARO/OSCURO
// ============================================================================

export function initTheme() {
  const saved = localStorage.getItem(THEME_KEY);
  const isDark = saved === 'dark';
  
  if (isDark) {
    document.body.classList.add('dark-mode');
  }
  updateThemeButton();
}

function toggleTheme() {
  const isDark = document.body.classList.toggle('dark-mode');
  localStorage.setItem(THEME_KEY, isDark ? 'dark' : 'light');
  updateThemeButton();
}

function updateThemeButton() {
  const btn = document.getElementById('themeToggle');
  if (btn) {
    const isDark = document.body.classList.contains('dark-mode');
    btn.textContent = isDark ? '☀️ Claro' : '🌙 Oscuro';
  }
}

// ============================================================================
// MENÚ RESPONSIVO
// ============================================================================

export function initMenu() {
  const toggle = document.getElementById('menuToggle');
  const sidebar = document.querySelector('.sidebar');

  if (toggle) {
    toggle.addEventListener('click', () => {
      sidebar.classList.toggle('hidden');
    });
  }

  initSidebarCollapse(sidebar);

  // Cerrar menú al hacer click en enlace
  document.querySelectorAll('.sidebar a').forEach(link => {
    link.addEventListener('click', () => {
      if (window.innerWidth <= 768) {
        sidebar.classList.add('hidden');
      }
    });
  });

  // Cerrar menú al redimensionar
  window.addEventListener('resize', () => {
    if (window.innerWidth > 768) {
      sidebar.classList.remove('hidden');
    }
  });

  // Marcar menú activo
  const current = window.location.pathname.split('/').pop() || 'dashboard.html';
  document.querySelectorAll('.sidebar a').forEach(link => {
    link.classList.remove('active');
    if (link.href.includes(current)) {
      link.classList.add('active');
    }
  });
}

// ============================================================================
// SIDEBAR COLAPSABLE (barra de solo íconos)
// ============================================================================
// Inyecta un botón en la esquina superior del sidebar (no requiere tocar el
// HTML de cada página, ya que main.js se carga en las 9 pantallas). Al
// colapsar, cada link se reestructura en <span class="sidebar-icon"> +
// <span class="sidebar-label"> (en vez de solo recortar el texto con
// overflow:hidden, que dejaba letras sueltas pegadas al ícono) para poder
// OCULTAR el label por completo y CENTRAR/AGRANDAR el ícono, con tooltip
// nativo (title) para no perder el nombre al pasar el mouse. El estado se
// recuerda en localStorage.

const SIDEBAR_COLLAPSE_KEY = 'erp_sidebar_collapsed';

// Separa el emoji líder ("📦 Inventario" -> ["📦", "Inventario"]). Cubre
// emojis compuestos por más de un code point (ej. banderas, variation
// selectors) tomando todo hasta el primer espacio.
function _splitIconLabel(texto) {
  const limpio = texto.trim();
  const idx = limpio.indexOf(' ');
  if (idx === -1) return [limpio, ''];
  return [limpio.slice(0, idx), limpio.slice(idx + 1).trim()];
}

function _reestructurarLinksSidebar(sidebar) {
  sidebar.querySelectorAll('.sidebar-menu a').forEach(a => {
    if (a.querySelector('.sidebar-icon')) return; // ya reestructurado
    const [icono, label] = _splitIconLabel(a.textContent);
    a.textContent = '';
    a.title = label || icono;
    const spanIcon = document.createElement('span');
    spanIcon.className = 'sidebar-icon';
    spanIcon.textContent = icono;
    const spanLabel = document.createElement('span');
    spanLabel.className = 'sidebar-label';
    spanLabel.textContent = label;
    a.appendChild(spanIcon);
    a.appendChild(spanLabel);
  });

  const logoutBtn = document.querySelector('.btn-logout');
  if (logoutBtn && !logoutBtn.querySelector('.btn-logout-icon')) {
    const label = logoutBtn.textContent.trim();
    logoutBtn.textContent = '';
    logoutBtn.title = label;
    const spanIcon = document.createElement('span');
    spanIcon.className = 'btn-logout-icon';
    spanIcon.textContent = '🚪';
    const spanLabel = document.createElement('span');
    spanLabel.className = 'btn-logout-label';
    spanLabel.textContent = label;
    logoutBtn.appendChild(spanIcon);
    logoutBtn.appendChild(spanLabel);
  }
}

function initSidebarCollapse(sidebar) {
  if (!sidebar || document.getElementById('sidebarCollapseBtn')) return;

  _reestructurarLinksSidebar(sidebar);

  const btn = document.createElement('button');
  btn.id = 'sidebarCollapseBtn';
  btn.className = 'sidebar-toggle-btn';
  btn.type = 'button';
  btn.title = 'Colapsar menú';
  btn.textContent = '«';
  sidebar.insertBefore(btn, sidebar.firstChild);

  function aplicarEstado(colapsado) {
    document.body.classList.toggle('sidebar-collapsed', colapsado);
    btn.textContent = colapsado ? '»' : '«';
    btn.title = colapsado ? 'Expandir menú' : 'Colapsar menú';
  }

  const guardado = localStorage.getItem(SIDEBAR_COLLAPSE_KEY) === '1';
  aplicarEstado(guardado);

  btn.addEventListener('click', () => {
    const colapsado = !document.body.classList.contains('sidebar-collapsed');
    aplicarEstado(colapsado);
    localStorage.setItem(SIDEBAR_COLLAPSE_KEY, colapsado ? '1' : '0');
  });
}

// ============================================================================
// MODAL
// ============================================================================

function openModal(id) {
  const modal = document.getElementById(id);
  if (modal) {
    modal.classList.add('show');
    document.body.style.overflow = 'hidden';
  }
}

// Hacer disponible globalmente
window.openModal = openModal;

function closeModal(id) {
  const modal = document.getElementById(id);
  if (modal) {
    modal.classList.remove('show');
    document.body.style.overflow = 'auto';
  }
}

// Hacer disponible globalmente
window.closeModal = closeModal;

// Cerrar modal al hacer click fuera
document.addEventListener('click', (e) => {
  if (e.target.classList.contains('modal')) {
    e.target.classList.remove('show');
    document.body.style.overflow = 'auto';
  }
});

// ============================================================================
// TOAST
// ============================================================================

function showToast(message, type = 'info', duration = 3000) {
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.textContent = message;
  document.body.appendChild(toast);
  
  setTimeout(() => {
    toast.remove();
  }, duration);
}

// ============================================================================
// FORMATO
// ============================================================================

function formatCurrency(value, currency = 'PEN') {
  const num = parseFloat(value) || 0;
  const symbol = currency === 'USD' ? '$' : 'S/.';
  return `${symbol} ${num.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function formatDate(dateStr) {
  if (!dateStr) return '';
  const date = new Date(dateStr);
  return date.toLocaleDateString('es-PE', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  });
}

function formatNumber(value) {
  return parseFloat(value || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// ============================================================================
// VALIDACIONES
// ============================================================================

function validateRequired(value) {
  return value && value.toString().trim().length > 0;
}

function validateEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function validateRUC(ruc) {
  return ruc && ruc.length === 11 && /^\d+$/.test(ruc);
}

// ============================================================================
// TABS
// ============================================================================

function initTabs(containerSelector) {
  const buttons = document.querySelectorAll(`${containerSelector} .tab-btn`);
  const contents = document.querySelectorAll(`${containerSelector} .tab-content`);

  buttons.forEach(btn => {
    btn.addEventListener('click', () => {
      const tab = btn.getAttribute('data-tab');

      buttons.forEach(b => b.classList.remove('active'));
      contents.forEach(c => c.classList.remove('active'));

      btn.classList.add('active');
      document.getElementById(`tab-${tab}`)?.classList.add('active');
    });
  });
}

// ============================================================================
// SUBMENÚ DE MÓDULO ESTILO ODOO (.module-nav)
// ============================================================================
// Cada módulo (inventario.html, compras.html, ventas.html, ...) organiza sus
// tabs dentro de grupos desplegables en el header, en vez de una fila plana
// de botones. Los .tab-btn de adentro son los mismos de siempre (mismo
// data-tab, misma clase .active) — este helper SOLO agrega el
// abrir/cerrar del dropdown y resaltar el grupo que contiene el tab activo.
// El cambio de tab en sí lo sigue manejando cada módulo con su propio
// listener de .tab-btn (ej. initTabsInventario en inventario.js), así que
// llamar a esta función es aditivo y no reemplaza nada existente.
export function initModuleNavDropdowns(containerSelector) {
  const nav = document.querySelector(containerSelector);
  if (!nav) return;

  const groups = nav.querySelectorAll('.module-nav-group');

  function closeAllGroups(except) {
    groups.forEach(g => { if (g !== except) g.classList.remove('open'); });
  }

  function highlightActiveGroup() {
    groups.forEach(g => {
      const hasActive = !!g.querySelector('.tab-btn.active');
      g.classList.toggle('group-active', hasActive);
    });
  }

  groups.forEach(group => {
    const toggle = group.querySelector('.module-nav-group-toggle');
    if (!toggle) return;

    toggle.addEventListener('click', (e) => {
      e.stopPropagation();
      const isOpen = group.classList.contains('open');
      closeAllGroups(null);
      group.classList.toggle('open', !isOpen);
    });

    group.querySelectorAll('.tab-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        group.classList.remove('open');
        highlightActiveGroup();
      });
    });
  });

  // El botón suelto de Configuración (fuera de cualquier grupo) también
  // debe quitar el resaltado de grupo activo al seleccionarse.
  nav.querySelectorAll(':scope > .tab-btn').forEach(btn => {
    btn.addEventListener('click', highlightActiveGroup);
  });

  document.addEventListener('click', (e) => {
    if (!nav.contains(e.target)) closeAllGroups(null);
  });

  highlightActiveGroup();
}

// ============================================================================
// INICIALIZACIÓN - Solo si se carga directamente como módulo
// ============================================================================

// Exportar funciones útiles
export function openModalGlobal(id) {
  openModal(id);
}

export function closeModalGlobal(id) {
  closeModal(id);
}

export function showToastGlobal(message, type = 'info', duration = 3000) {
  showToast(message, type, duration);
}

// Auto-inicializar solo si no se importa como módulo
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => {
    initTheme();
    initMenu();
    
    const themeBtn = document.getElementById('themeToggle');
    if (themeBtn) {
      themeBtn.addEventListener('click', toggleTheme);
    }
  });
} else {
  // DOM ya está listo
  initTheme();
  initMenu();
  
  const themeBtn = document.getElementById('themeToggle');
  if (themeBtn) {
    themeBtn.addEventListener('click', toggleTheme);
  }
}

// ============================================================================
// FASE 2 — SUB-TABS DENTRO DE UN TAB (usado por los tabs de Reportes)
// ============================================================================
// Estructura esperada:
//   <div class="subtab-bar" id="X"><button class="subtab" data-sub="panelId">..</button></div>
//   <div id="panelId" class="subtab-panel active">..</div>
// `onCambio(panelId)` permite construir el reporte solo cuando se abre
// (lazy render): así el módulo no calcula 6 reportes al arrancar.

export function initSubtabs(barraSelector, onCambio) {
  const barra = document.querySelector(barraSelector)
  if (!barra) return
  const botones = barra.querySelectorAll('.subtab')
  botones.forEach(btn => {
    btn.addEventListener('click', () => {
      const destino = btn.getAttribute('data-sub')
      botones.forEach(b => b.classList.remove('active'))
      btn.classList.add('active')
      botones.forEach(b => {
        const p = document.getElementById(b.getAttribute('data-sub'))
        if (p) p.classList.remove('active')
      })
      document.getElementById(destino)?.classList.add('active')
      if (typeof onCambio === 'function') onCambio(destino)
    })
  })
}

// ============================================================================
// FASE 2 — VISIBILIDAD DE MÓDULOS POR ROL
// ============================================================================
// Cualquier <li data-solo-admin> del sidebar solo se muestra si el usuario
// tiene role='admin'. Se oculta de entrada y se revela después, para que un
// usuario sin permisos no vea siquiera un parpadeo del enlace.
// El cache de auth se puebla de forma asíncrona (auth-init.js), por eso se
// reintenta unos segundos antes de rendirse.

function aplicarVisibilidadPorRol() {
  const items = document.querySelectorAll('[data-solo-admin]')
  if (items.length === 0) return
  items.forEach(el => { el.style.display = 'none' })

  let intentos = 0
  const revisar = () => {
    const user = getCurrentUser()
    if (user) {
      const esAdmin = String(user.role || '').toLowerCase() === 'admin'
      items.forEach(el => { el.style.display = esAdmin ? '' : 'none' })
      return
    }
    if (++intentos < 30) setTimeout(revisar, 120)
  }
  revisar()
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', aplicarVisibilidadPorRol)
} else {
  aplicarVisibilidadPorRol()
}

// ============================================================================
// FASE 2 — NAVEGACIÓN CRUZADA ENTRE MÓDULOS (?tab=...)
// ============================================================================
// El Dashboard (y cualquier otra pantalla) puede enlazar directamente a un tab
// concreto de otro módulo: `cobranzas.html?tab=cxc`. Al terminar de cargar, se
// dispara un click sobre el .tab-btn correspondiente, reutilizando el mismo
// handler que ya tiene cada módulo (no hace falta cablear nada extra allí).
// El pequeño retardo da tiempo a que el módulo registre sus listeners.

function abrirTabDeUrl() {
  const tab = new URLSearchParams(window.location.search).get('tab')
  if (!tab) return

  let intentos = 0
  const intentar = () => {
    const btn = document.querySelector(`.tab-btn[data-tab="${CSS.escape(tab)}"]`)
    if (btn) {
      btn.click()
      // Si el tab vive dentro de un grupo desplegable, resaltarlo y cerrarlo.
      btn.closest('.module-nav-group')?.classList.remove('open')
      // Limpia el parámetro para que un F5 no reabra siempre el mismo tab.
      const url = new URL(window.location.href)
      url.searchParams.delete('tab')
      window.history.replaceState({}, '', url)
      return
    }
    if (++intentos < 25) setTimeout(intentar, 150)
  }
  setTimeout(intentar, 250)
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', abrirTabDeUrl)
} else {
  abrirTabDeUrl()
}

// ============================================================================
// FASE 2 — MENÚ DE ACCIONES POR FILA (botón ⋮)
// ============================================================================
// Las tablas de Ventas y Compras tenían 4-6 botones por fila, lo que hacía la
// columna "Acciones" más ancha que el resto de la tabla. Ahora cada fila
// muestra un solo botón ⋮ que despliega sus acciones.
//
// Cómo funciona, y por qué así:
//   * El módulo escribe las acciones como HTML normal (con sus `onclick` de
//     siempre) dentro de un contenedor oculto en la propia celda. No hace
//     falta registrar callbacks en ningún sitio ni mantener un mapa global
//     que habría que limpiar en cada re-render.
//   * Al abrir, ese HTML se clona en un panel `position:fixed` colgado del
//     <body>. Esto es indispensable: las tablas viven dentro de
//     `.table-container { overflow:auto }`, y un menú `position:absolute`
//     quedaría recortado por ese overflow.
//   * El panel se voltea hacia arriba si no hay espacio abajo, y se cierra al
//     hacer scroll, redimensionar, pulsar Escape o clicar fuera.

/**
 * Devuelve el HTML de la celda de acciones.
 * @param {Array} acciones  [{ label, icono?, onclick?, href?, clase?, peligro?, separador? }]
 */
export function menuAccionesFila(acciones = []) {
  const items = acciones.filter(Boolean).map(a => {
    if (a.separador) return '<div class="acciones-separador"></div>'
    const clases = `acciones-item${a.peligro ? ' peligro' : ''}${a.clase ? ' ' + a.clase : ''}`
    const icono = a.icono ? `<span class="acciones-icono">${a.icono}</span>` : '<span class="acciones-icono"></span>'
    if (a.href) {
      return `<a class="${clases}" href="${a.href}" target="${a.target || '_blank'}">${icono}<span>${a.label}</span></a>`
    }
    return `<button type="button" class="${clases}" onclick="${a.onclick || ''}">${icono}<span>${a.label}</span></button>`
  }).join('')

  if (!items) return '<span style="color:var(--text-secondary);">—</span>'

  return `<div class="acciones-celda">
    <button type="button" class="acciones-kebab" onclick="window.abrirMenuAcciones(this, event)" title="Acciones" aria-label="Acciones">⋮</button>
    <div class="acciones-menu-datos" hidden>${items}</div>
  </div>`
}

let _panelAcciones = null
let _kebabActivo = null

function _cerrarMenuAcciones() {
  if (_panelAcciones) { _panelAcciones.remove(); _panelAcciones = null }
  if (_kebabActivo) { _kebabActivo.classList.remove('abierto'); _kebabActivo = null }
}

window.cerrarMenuAcciones = _cerrarMenuAcciones

window.abrirMenuAcciones = function (boton, evento) {
  if (evento) evento.stopPropagation()

  // Segundo click sobre el mismo botón: cerrar (comportamiento esperado).
  const yaAbierto = _kebabActivo === boton
  _cerrarMenuAcciones()
  if (yaAbierto) return

  const datos = boton.parentElement?.querySelector('.acciones-menu-datos')
  if (!datos) return

  const panel = document.createElement('div')
  panel.className = 'acciones-menu'
  panel.innerHTML = datos.innerHTML
  document.body.appendChild(panel)

  // Cualquier acción cierra el menú; el onclick propio del item se ejecuta
  // igual porque este listener corre después (mismo bubbling, otro handler).
  panel.querySelectorAll('.acciones-item').forEach(el => {
    el.addEventListener('click', () => setTimeout(_cerrarMenuAcciones, 0))
  })

  const r = boton.getBoundingClientRect()
  const alto = panel.offsetHeight
  const ancho = panel.offsetWidth
  const espacioAbajo = window.innerHeight - r.bottom

  // Se abre hacia abajo salvo que no quepa; alineado a la derecha del botón
  // para que no se salga por el borde de la ventana.
  panel.style.top = (espacioAbajo < alto + 12 && r.top > alto + 12)
    ? `${r.top - alto - 4}px`
    : `${r.bottom + 4}px`
  panel.style.left = `${Math.max(8, Math.min(r.right - ancho, window.innerWidth - ancho - 8))}px`

  panel.classList.add('visible')
  _panelAcciones = panel
  _kebabActivo = boton
  boton.classList.add('abierto')
}

document.addEventListener('click', (e) => {
  if (_panelAcciones && !_panelAcciones.contains(e.target) && !e.target.closest('.acciones-kebab')) {
    _cerrarMenuAcciones()
  }
})
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') _cerrarMenuAcciones() })
window.addEventListener('resize', _cerrarMenuAcciones)
// `true` = fase de captura: así también se detecta el scroll de los
// contenedores internos (.table-container), no solo el de la ventana.
window.addEventListener('scroll', _cerrarMenuAcciones, true)
