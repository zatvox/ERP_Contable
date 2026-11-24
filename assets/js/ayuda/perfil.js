import { E } from '../shared/ayuda.js'
const T = t => `.module-nav .tab-btn[data-tab="${t}"]`
export default [
  E('per.datos', T('datos'), 'Mis datos', 'Tu información personal y de contacto.', null, { q: true }),
  E('per.seg', T('seguridad'), 'Seguridad', 'Cambia tu contraseña. Usa mínimo 8 caracteres.', null, { q: true }),
  E('per.act', T('actividad'), 'Mi actividad', 'Lo que has hecho en el sistema.', null, { q: true }),
  E('per.pref', T('configuracion'), 'Preferencias', 'Cómo se ve y comporta el sistema para ti (tema, vistas por defecto).', null, { q: true }),
  E('per.multi', T('multiempresa'), 'Multiempresa', 'Administra las empresas y sus datos: logo, cabecera de documentos y ámbito familiar.', null, { q: true }),
  E('per.cmd', T('comandos'), 'Comandos', 'Atajos de texto para hacer acciones rápidas.', null, { q: true, pv: true }),
  E('per.limpiar', 'button', 'Limpiar datos locales', 'Borra lo que el sistema guardó en este navegador (preferencias y cachés). No toca tu información en el servidor.', null, { txt: 'Limpiar' }),
]
