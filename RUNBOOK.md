# RUNBOOK.md — Guía operativa para IA

> **Léeme primero.** Este documento permite a cualquier IA entender la aplicación RAICE
> y resolver problemas de forma **rápida y segura**. Si solo vas a leer un archivo, lee este.
>
> Documentos relacionados: `AGENTS.md` (reglas de migración), `public/shared/README.md`
> (capa compartida), `CHECKLIST.md` (validación), `DESPLIEGUE.md` (instalación).

---

## 1. Qué es RAICE (en 30 segundos)

Plataforma escolar colombiana (Ley 1620 — convivencia escolar) para gestionar asistencia,
casos de convivencia, observador del estudiante, excusas y reportes. Tiene **5 roles**:
superadmin, coordinador (admin), docente (teacher), rector, y portal de acudientes (público).

**Stack:**
- Frontend: **HTML monolítico** (1 archivo por rol) con JS vanilla inline. Sin framework, sin build.
- Backend: **un solo archivo** `pages/api/[...path].js` (Next.js API route) con TODA la lógica.
- Base de datos: **Supabase** (PostgreSQL). Acceso vía service_role key.
- Hosting: **Vercel** (auto-deploy desde GitHub).
- Auth: JWT propio (no Supabase Auth). Token en `sessionStorage`.

---

## 2. Mapa de archivos

```
pages/api/[...path].js        ← TODO el backend (~8600 líneas). Router por `route` string.
public/
  login.html                  Login (todos los roles)
  superadmin.html             Panel superadmin
  admin.html                  Panel coordinador (el más grande, ~10k líneas)
  docente.html                Portal docente
  rector.html                 Panel rector
  portal-acudiente.html       Portal padres (público, sin token)
  shared/                     ← Capa compartida (ver public/shared/README.md)
    constants/index.js        Constantes (días, etiquetas, colores)
    utils/index.js            Utilidades (escapeHtml, logout, showToast, checkAuth...)
    utils/printObservador.js  Impresión del observador
    utils/pwa.js              Banners PWA
    data/apiClient.js         createApiClient() — cliente HTTP
    data/realtime.js          initRealtime() — Supabase Realtime
    data/repositories.js      Funciones de acceso a datos (fetchX, createX...)
    domain/index.js           Reglas de negocio (gradeLbl, classifyRisk...)
RAICE_maestro.sql             Esquema completo de la BD (fuente de verdad de tablas/constraints)
vercel.json                   Config Vercel + cron jobs
```

### Patrón shared (CRÍTICO — no romper)
Los módulos `shared/` son **IIFE** que registran en `window.RAICE`. Se cargan como
`<script src>` **regulares** (NUNCA `type="module"` — rompe el timing con PWA/Realtime).
Los HTML hacen `var { x } = window.RAICE;` al inicio. Detalle completo en `public/shared/README.md`.

---

## 3. Cómo desplegar (LEE ESTO ANTES DE EDITAR)

⚠️ **Hay DOS carpetas:**
- `RAICE MIGRACION/` → carpeta de **trabajo** (donde editas)
- `RAICE 060626/` → carpeta del **repo Git** (lo que se despliega a Vercel)

**Después de editar, SIEMPRE copia el archivo a la carpeta del repo:**
```powershell
Copy-Item "RAICE MIGRACION\public\X.html" "RAICE 060626\public\X.html" -Force
```

⚠️ El archivo `pages/api/[...path].js` tiene **corchetes** en el nombre. PowerShell los
interpreta como glob. Usa SIEMPRE `-LiteralPath`:
```powershell
Copy-Item -LiteralPath "RAICE MIGRACION\pages\api\[...path].js" `
          -Destination "RAICE 060626\pages\api\[...path].js" -Force
```

Luego el usuario hace `git push` desde `RAICE 060626/` y Vercel despliega solo.
**El cambio NO está en producción hasta que se hace push y Vercel termina el build.**

### Verificar sintaxis antes de desplegar
```powershell
# Para el API (tiene corchetes):
Copy-Item -LiteralPath "pages\api\[...path].js" "_check.js" -Force; node --check _check.js; Remove-Item _check.js -Confirm:$false
```
Para un HTML, extrae el `<script>` principal y haz `node --check`.

---

## 4. Esquema de BD — lo que SIEMPRE debes verificar

La fuente de verdad es `RAICE_maestro.sql`. **29 tablas** con prefijo `raice_`.
Antes de tocar inserciones/restauración, revisa los **constraints** de la tabla afectada.

### Constraints que causan el 90% de los bugs de datos

| Tabla | Constraint clave | Trampa común |
|---|---|---|
| `raice_attendance` | `UNIQUE(student_id, date, course_id, class_hour)` · `course_id` NOT NULL · `status IN (P,A,PE,T,S,NR)` | FK a course/teacher que no existe → registro se pierde |
| `raice_students` | `status IN (active,transferred,retired,graduated,desertor)` · `code` UNIQUE | status 'inactive' u otro → viola CHECK |
| `raice_subgroup_members` | UNIQUE(subgroup_course_id, student_id) + posible UNIQUE(student_id) | un estudiante en 2 subgrupos falla |
| `raice_periods` | `UNIQUE(year, period_num)` · `year` NOT NULL | period_num huérfano al reducir num_periods |
| `raice_calendar` | `type IN (holiday,vacation,event,institutional_day)` | type fuera de lista → viola CHECK |
| `raice_observations` | `type IN (positive,neutral,negative)` · teacher/course nullable | FK inválido |
| `raice_cases` | `type IN (1,2,3)` · `status IN (open,tracking,closed)` · teacher_id FK | teacher_id inexistente |
| `raice_faltas_catalogo` | `UNIQUE(tipo, categoria, numeral)` | upsert por id falla por el otro unique |
| `raice_suspensions` | tiene `coordinator_id` (NO teacher_id) | columna inexistente al mapear |

### Regla de oro al insertar datos de otra fuente (backup, import)
Antes de insertar, **limpiar las FK**:
- FK NOT NULL inválido → **descartar** el registro (no se puede insertar).
- FK nullable inválido → ponerlo en **null** (preserva el registro).
- Campo con CHECK → **mapear** a un valor válido o un default.
- Validar contra IDs **reales en BD** (consultar `select id`), no contra los del archivo.

---

## 5. Problemas conocidos y solución probada

### 5.1 La restauración de backup pierde datos (asistencia, etc.)
**Causa:** registros con FK a docente/curso inexistente se descartan; o payload > 4.5MB
(límite de Vercel) en un solo POST.
**Solución implementada:** en `handleBackupImport` (step 'chunk'), la asistencia/observaciones
se importan en lotes de 500 desde el frontend, y en el servidor se limpian las FK
(course_id obligatorio se valida; teacher_id/corrected_by inválidos → null) y el status se
mapea contra el CHECK. Si faltan datos tras restaurar, revisa `errors[]` que devuelve el endpoint.

### 5.2 El conteo de períodos muestra de más (ej: 4 cuando son 3)
**Causa:** período huérfano `period_num > num_periods` que quedó al reducir el número de
períodos (el dropdown de config y "Guardar períodos" son guardados distintos).
**Solución:** `handleConfig` borra `raice_periods` con `period_num > num_periods` al guardar.
El usuario re-guarda la configuración para limpiar. La app ya filtra `period_num <= num_periods`.

### 5.3 Una vista deja de funcionar tras tocar shared (onclick no responde, "X is not a function")
**Causa típica:** se usó `type="module"` (defer rompe timing), o falta cargar
`shared/utils/index.js` (donde viven checkAuth, showToast, logout), o `checkAuth` retornó null.
**Solución:** usar `<script src>` regular; cargar TODOS los módulos shared que el HTML use;
`checkAuth` retorna `{}` (no null) cuando hay token válido pero sin datos de user.

### 5.4 El historial de asistencia del DOCENTE muestra menos fechas/registros que el real
**Causa:** `getAttendanceRange` filtra la asistencia del docente por su HORARIO
(`raice_schedules` por `teacher_course_id`). Si el horario quedó incompleto tras un restore,
descarta registros de asistencia que SÍ existen. El restore perdía horarios porque
`raice_teacher_courses` requiere `course_id` válido (NOT NULL) pero solo se validaba `teacher_id`;
los tc que fallaban dejaban sus `raice_schedules` huérfanos (FK en cascada). Síntoma: el backup
preview muestra "Horarios clase: 650" pero el restore importa solo ~50.
**Solución:** validar teacher_courses por teacher_id Y course_id reales en BD; validar schedules
contra los teacher_course_id que REALMENTE quedaron en BD (query `select id`), no contra el filtro;
deduplicar por (teacher_course_id, day_of_week, class_hour). **Diagnóstico:** comparar la misma
vista en COORDINADOR (no filtra por horario) vs DOCENTE — si difieren, es el horario.

### 5.5 Superadmin no carga datos
**Causa:** faltaba `<script src="/shared/utils/index.js">` en el `<head>` (checkAuth no existía).
**Solución:** confirmar que cada HTML carga los módulos shared que referencia.

---

## 6. Metodología de diagnóstico (¿código o datos?)

Antes de "arreglar código", determina la naturaleza del problema:

1. **¿El código que renderiza cambió recientemente?** Si NO se tocó la función de display
   y aun así muestra distinto → es problema de **DATOS**, no de código. Revisa la BD/restore.
2. **¿El mismo query devuelve distinto?** Entonces la BD cambió (restore parcial, FK drops).
3. **¿Hay error en consola del navegador (F12)?** Errores rojos = problema de JS frontend.
   `X is not a function` = módulo shared no cargado o `type="module"`.
4. **¿500 en la API?** Revisa logs de Vercel (Functions). Suele ser FK, CHECK, o auth.
5. **Reproduce con un caso mínimo** antes de cambiar nada.

---

## 7. Reglas de seguridad (NO romper)

- **Cero regresión funcional** (AGENTS.md §2). Si un cambio toca flujos no relacionados, rediseñar.
- **Nunca** exponer `SUPABASE_SERVICE_ROLE_KEY` ni `JWT_SECRET` en el frontend.
- **Validar siempre** con `node --check` antes de copiar a producción.
- **Cambios acotados y reversibles.** Identifica el commit de rollback antes de tocar.
- **No big-bang.** Migración incremental (strangler pattern).
- Ejecutar el **CHECKLIST.md** del rol afectado antes de dar por terminado.
- El SQL es idempotente (`IF NOT EXISTS`); para cambios de constraint, sección
  "CORRECCIONES DE CONSTRAINTS" del SQL.

---

## 8. Estado de la migración (contexto)

Arquitectura migrando de monolito HTML a capas limpias (AGENTS.md §10).
Etapas 1-4 completas: `shared/constants`, `utils`, `data` (apiClient + repositories), `domain`.
Etapa 5 (presentation: separar render del estado) pendiente — hacer **incremental**, NO big-bang.

---

## 9. Checklist rápido para resolver un problema nuevo

1. [ ] Leer este RUNBOOK + el doc específico (shared/README, AGENTS, etc.)
2. [ ] Reproducir el problema; mirar consola (F12) y/o logs de Vercel
3. [ ] Determinar si es código o datos (sección 6)
4. [ ] Revisar constraints de la tabla afectada en `RAICE_maestro.sql` (sección 4)
5. [ ] Hacer el cambio MÍNIMO y acotado
6. [ ] `node --check` del archivo
7. [ ] Copiar a la carpeta del repo (`-LiteralPath` si es el API)
8. [ ] Ejecutar CHECKLIST.md del rol afectado
9. [ ] Indicar al usuario qué archivos subir a GitHub

---

*RUNBOOK v1 — junio 2026. Mantener actualizado al resolver problemas nuevos (sección 5).*
