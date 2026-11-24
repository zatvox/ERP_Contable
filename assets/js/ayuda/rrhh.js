import { E } from '../shared/ayuda.js'
const T = t => `.module-nav .tab-btn[data-tab="${t}"]`
export default [
  E('rrhh.emp', T('empleados'), 'Empleados', 'Tu equipo: personas con ficha por empresa (cargo, sueldo, régimen, horario).', ['Una persona puede tener ficha en varias empresas. Pueden aparecer también usuarios **por completar** (tienen cuenta pero aún no ficha).', 'En la ficha defines **Área** y **Jefe de área** para el módulo Tareas.'], { q: true }),
  E('rrhh.asis', T('asistencia'), 'Asistencia', 'Marcas de ingreso, almuerzo y salida, por día, semana o mes.', ['• **Día**: lista del día con horas netas y tardanzas.', '• **Semana / Mes**: grilla empleados × días.', '• **Falta** = día laborable (según su horario) sin marca.', 'La hora oficial es la del servidor (Lima); nadie puede marcar con otra hora.'], { q: true }),
  E('rrhh.reg', T('regimen'), 'Régimen y parámetros', 'Reglas laborales y de pensión (AFP/ONP), RMV, EsSalud y demás parámetros de planilla.', null, { q: true, pv: true }),
  E('rrhh.usu', T('usuarios'), 'Usuarios y accesos', 'Quién puede entrar al sistema y con qué rol.', ['El rol **Administrador** da acceso total. Puedes dar o quitar ese rol desde las acciones de la fila; tú no puedes quitártelo a ti mismo.'], { q: true }),
  E('rrhh.cambiar', '#empBtnCambiarEmpresa', 'Cambiar de empresa', 'Dos caminos según el caso.', ['• **Mover**: la ficha estaba mal asignada; se corrige sin dejar rastro laboral.', '• **Transferir**: la persona pasa de una empresa a otra; se cierra la ficha anterior y se abre una nueva.']),
  E('rrhh.area', '#empArea', 'Área', 'Equipo al que pertenece (Contabilidad, Ventas, Almacén…). Define qué tareas ve su jefe.', null, { q: true }),
  E('rrhh.jefe', '#empJefeArea', 'Jefe de área', 'Si lo marcas, esta persona ve y reparte las tareas de su área.', null),
]
