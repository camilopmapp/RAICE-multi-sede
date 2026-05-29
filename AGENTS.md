# AGENTS.md

Guía operativa para agentes y desarrolladores en el proyecto RAICE.

Sistema de gestión escolar (asistencia, convivencia, horarios, sedes, subgrupos) desplegado en Vercel con Next.js 14 y Supabase.

---

## 1. Principios Rectores

1. No regresión funcional — un cambio no puede romper lo que ya funciona.
2. Cambios pequeños, aislados y verificables.
3. Seguridad y estabilidad por encima de velocidad de cambio.
4. Trazabilidad de toda modificación.
5. Preguntar antes de escribir código cuando el impacto no sea claro.

---

## 2. Regla de Oro de Cambios

Toda modificación debe preservar el comportamiento existente del sistema.

Si un cambio impacta módulos no relacionados o altera un flujo estable, se considera no conforme y debe revertirse o rediseñarse.

---

## 3. Arquitectura Actual

El proyecto usa una arquitectura monolítica pragmática:

```
pages/
  api/
    [...path].js       ← API única (todas las rutas del servidor)
public/
  docente.html         ← App docente (JS inline, monolítico)
  admin.html           ← App coordinador/admin
  rector.html          ← App rector
  superadmin.html      ← App superadmin
  superadmin.html      ← App superadmin
  portal-acudiente.html← App acudiente
  Acudiente.html       ← App acudiente legacy
  login.html           ← Login general
  offline.html         ← Fallback offline
  sw.js                ← Service Worker (cache + offline)
  manifest.json        ← PWA manifest
  js/
    chart.umd.min.js   ← Charts (local, sin CDN)
    xlsx.full.min.js   ← Exportación Excel
vercel.json            ← Configuración Vercel (headers, crons, funciones)
next.config.js         ← Rewrites de rutas + headers de seguridad
RAICE_maestro.sql      ← Esquema completo de base de datos
```

**Stack:**
- Frontend: HTML + JS vanilla inline (sin framework de UI)
- Backend: Next.js API Routes (`pages/api/[...path].js`)
- Base de datos: Supabase (PostgreSQL)
- Hosting: Vercel
- Autenticación: JWT + bcryptjs
- PWA: Service Worker con soporte offline

---

## 4. Roles del Sistema

| Rol | Archivo | Descripción |
|-----|---------|-------------|
| `teacher` (docente) | docente.html | Toma asistencia, registra observaciones |
| `admin` | admin.html | Coordinador de sede, mapa escolar, reportes |
| `rector` | rector.html | Vista global multi-sede |
| `superadmin` | superadmin.html | Configuración total del sistema |
| `acudiente` | portal-acudiente.html | Portal de padres/acudientes |

---

## 5. Directrices Obligatorias de Implementación

1. **Leer antes de editar** — siempre usar Read en el archivo antes de modificarlo.
2. **Un cambio = una intención clara** — no mezclar correcciones de bugs con features.
3. **Verificar impacto cruzado** — un cambio en la API puede afectar múltiples roles.
4. **No eliminar código legacy** sin confirmación explícita del usuario.
5. **No cambiar esquema de base de datos** (RAICE_maestro.sql) sin instrucción directa.
6. **No modificar next.config.js ni vercel.json** salvo que el cambio sea el objetivo principal.

---

## 6. Política de No Afectación del Resto del Código

Para cada cambio, validar obligatoriamente:

1. Flujos críticos siguen operativos (toma de asistencia, login, mapa escolar).
2. No se rompen contratos de datos entre API y frontend.
3. No se alteran rutas, PWA ni autenticación existente.
4. No se introducen side-effects en módulos no tocados.
5. Si se cambia el formato de un dato (ej: array de números → array de objetos), buscar TODOS los consumidores de ese dato en todos los archivos.

---

## 7. Zonas de Alto Riesgo

Estos módulos requieren especial cuidado — un error aquí afecta a todos los usuarios:

| Zona | Riesgo |
|------|--------|
| `handleAttendance()` en la API | Pérdida o corrupción de asistencia |
| `saved_hours` (formato `[{hour, by}]`) | Usado en múltiples lugares del frontend |
| Service Worker (`sw.js`) | Puede bloquear actualizaciones a todos los usuarios |
| `getSchedulesOverview()` | Mapa escolar de coordinadores |
| JWT / autenticación | Acceso no autorizado si se rompe |
| `raice_excusas` + horas array | Lógica de excusas por hora específica |

---

## 8. Convenciones de Desarrollo

1. JS vanilla en los HTML — no introducir frameworks sin autorización.
2. Funciones pequeñas con responsabilidad única.
3. Evitar estado global cuando exista alternativa controlada.
4. Los IDs de elementos HTML deben ser únicos y descriptivos.
5. Notificaciones al usuario: usar `showToast()` (no alerts).
6. Fechas: usar siempre `todayCO()` y `dayOfWeekCO()` para zona horaria Colombia.

---

## 9. Flujos Críticos — No Romper

1. **Toma de asistencia** — docente selecciona curso → hora → marca estudiantes → guarda.
2. **Copiar lista de hora anterior** — solo si el mismo docente tomó la hora previa.
3. **Mapa escolar** — admin ve en tiempo real qué horas fueron llamadas.
4. **Login multi-rol** — cada rol redirige a su HTML correspondiente.
5. **Modo offline** — SW sirve caché cuando no hay conexión.
6. **Banner de versión nueva** — aparece automáticamente cuando hay un deploy.
7. **Excusas por hora** — PE se aplica solo a las horas seleccionadas.
8. **Detección de evasión** — al guardar hora N, compara con hora N-1.

---

## 10. Seguridad

1. No hardcodear credenciales ni secrets en el frontend.
2. Toda ruta de API valida el JWT y el rol antes de operar.
3. Los docentes solo pueden ver y modificar sus propios cursos.
4. Fechas pasadas están bloqueadas para registro de asistencia.
5. Correcciones de lista requieren autorización y ventana de tiempo configurada.

---

## 11. Caché y Despliegue

- `vercel.json` configura `Cache-Control: no-cache` para `.html` y `sw.js`.
- `sw.js` usa `network-first` para HTML y `cache-first` para recursos estáticos.
- Al hacer un deploy, incrementar `VERSION` en `sw.js` para forzar reinstalación del SW.
- El banner "🔄 Hay una versión nueva disponible" se activa automáticamente en todos los roles.

---

## 12. Checklist Mínimo por Cambio

- [ ] Alcance definido y acotado
- [ ] Archivo leído antes de editar
- [ ] Impacto en otros roles/archivos evaluado
- [ ] Contratos de datos entre API y frontend verificados
- [ ] Flujos críticos no afectados
- [ ] Sin secrets expuestos

---

## 13. Regla de Escalamiento

Si un cambio implica riesgo alto de ruptura:

1. Detener implementación directa.
2. Describir el problema y proponer alternativa al usuario.
3. Esperar confirmación antes de continuar.
4. Preferir cambios incrementales sobre rewrites grandes.

---

## 14. Estrategia de Modularización

### Estado actual (problema)

| Archivo | Líneas | Problema |
|---------|--------|---------|
| `admin.html` | 10.535 | CSS + HTML + JS mezclados, difícil de mantener |
| `pages/api/[...path].js` | 8.302 | Todas las rutas del servidor en un solo archivo |
| `superadmin.html` | 6.406 | Ídem admin |
| `docente.html` | 4.768 | Ídem |
| `rector.html` | 1.756 | Ídem |
| **Total** | **~31.767** | |

### Principio de modularización

No reescribir — extraer. Cada pieza que se saque debe funcionar exactamente igual que antes. La funcionalidad no cambia, solo su ubicación.

---

### Fase 1 — API: dividir `[...path].js` (mayor impacto, menor riesgo)

Next.js soporta múltiples archivos en `pages/api/`. Dividir por dominio funcional:

```
pages/api/raice/
  auth.js            ← login, logout, cambio de contraseña
  attendance.js      ← handleAttendance, getAttendanceByCourse, getAttendanceRange
  courses.js         ← getMyCourses, getCourseStudents, handleCourses
  schedules.js       ← getSchedulesOverview, handleBellSchedule, handleSchedules
  students.js        ← handleStudents, suspensiones, retiros
  excusas.js         ← handleExcusas
  reports.js         ← reportes, exportaciones
  notifications.js   ← handleNotifications
  config.js          ← handleConfig, handleSeeds
  shared/
    supabase.js      ← getSupabase(), cliente compartido
    auth.js          ← requireRole(), verifyToken()
    dates.js         ← todayCO(), dayOfWeekCO()
    helpers.js       ← utilidades compartidas entre handlers
```

**Regla:** cada archivo exporta sus handlers. El router central puede mantenerse o eliminarse gradualmente.

**Orden de extracción recomendado** (de menor a mayor riesgo):
1. `shared/dates.js` — funciones puras, sin dependencias
2. `shared/supabase.js` — cliente de base de datos
3. `shared/auth.js` — middleware de roles
4. `excusas.js` — módulo aislado
5. `notifications.js` — módulo aislado
6. `config.js` — módulo aislado
7. `attendance.js` — núcleo del sistema, requiere pruebas exhaustivas
8. `schedules.js`
9. `courses.js`
10. `students.js`
11. `reports.js`

---

### Fase 2 — Frontend: extraer CSS de los HTML

Cada HTML tiene bloques `<style>` grandes. Extraerlos a archivos separados:

```
public/css/
  base.css           ← variables, reset, tipografía (compartido)
  components.css     ← botones, modales, toasts (compartido)
  docente.css        ← estilos específicos del docente
  admin.css          ← estilos específicos del admin
  rector.css
  superadmin.css
  login.css
```

Reemplazar el bloque `<style>` por `<link rel="stylesheet" href="/css/docente.css">`.

**Beneficio:** el navegador cachea el CSS separado — carga más rápida en visitas repetidas.

---

### Fase 3 — Frontend: extraer JS de los HTML

Dividir el JS inline por responsabilidad funcional:

```
public/js/
  shared/
    api.js           ← fetchAPI(), manejo de errores HTTP
    auth.js          ← currentUser, logout, token
    ui.js            ← showToast(), openModal(), closeModal()
    dates.js         ← formatDate(), formatHour()
  docente/
    courses.js       ← loadMyCourses(), buildCard()
    attendance.js    ← loadCourseStudents(), saveAttendance(), copyFromPrevHour()
    hourSelector.js  ← buildHourSelector(), selectHour()
    students.js      ← renderStudentList(), sortStudents()
    offline.js       ← enqueueOffline(), syncOfflineQueue()
  admin/
    map.js           ← mapa escolar, getSchedulesOverview()
    reports.js       ← reportes de asistencia, exportaciones
    students.js      ← gestión de estudiantes
    ...
```

Cargar con `<script type="module" src="/js/docente/attendance.js"></script>`.

**Nota:** el paso a ES modules requiere verificar compatibilidad con el Service Worker actual.

---

### Fase 4 — Componentes HTML reutilizables (largo plazo)

Elementos que se repiten en varios archivos (sidebar, topbar, modales base) pueden extraerse como templates o web components simples, cargados dinámicamente via JS.

---

### Reglas de la modularización

1. **Nunca romper una funcionalidad existente** para modularizar — si hay duda, no extraer.
2. **Cada fase se ejecuta completa en una sola sesión** — no dejar fases a medias.
3. **Respetar el orden entre fases** — no iniciar la Fase 2 sin que la Fase 1 esté validada en producción.
4. **Mantener los archivos originales** hasta confirmar paridad funcional del módulo extraído.
5. **No cambiar lógica al extraer** — mover código, no reescribirlo.
6. **Priorizar la API** sobre el frontend — es más seguro y el impacto es mayor.
7. **Documentar qué se extrajo** y desde qué líneas del archivo original.

---

### Orden de ejecución por sesión

| Sesión | Fase | Alcance | Riesgo |
|--------|------|---------|--------|
| 1 | Fase 2 — CSS | Extraer todos los estilos de todos los HTML | Bajo |
| 2 | Fase 1 — API | Dividir `[...path].js` completo en módulos por dominio | Medio-alto |
| 3 | Fase 3 — JS | Extraer todo el JS de los HTML en módulos separados | Alto |
| 4 | Fase 4 — Componentes | Templates y elementos reutilizables entre roles | Medio |

Cada sesión solo inicia cuando el usuario confirma que la sesión anterior está estable en producción.

---

### Criterio de avance entre fases

No iniciar la siguiente fase sin que la anterior esté:
- Funcionando en producción sin errores reportados
- Validada con smoke tests manuales de los flujos críticos
- Aprobada explícitamente por el usuario del proyecto
