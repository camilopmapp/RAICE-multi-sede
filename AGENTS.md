# AGENTS.md

Guia operativa para agentes y desarrolladores en el proyecto RAICE.

Objetivo principal: evolucionar la arquitectura hacia clean architecture sin romper la funcionalidad actual.

## 1. Principios Rectores

1. No regresion funcional.
2. Cambios pequenos, aislados y verificables.
3. Arquitectura por capas con dependencias controladas.
4. Trazabilidad de toda modificacion.
5. Seguridad y estabilidad por encima de velocidad de cambio.

## 2. Regla de Oro de Cambios

Toda modificacion debe preservar el comportamiento existente del sistema.

Si un cambio impacta modulos no relacionados o altera un flujo estable, se considera no conforme y debe revertirse o redisenarse.

## 3. Arquitectura Limpia Objetivo

Estructura de referencia:

- presentation: UI, eventos, render, estado de interfaz.
- domain: reglas de negocio, casos de uso, entidades.
- data: acceso a datos, clientes, repositorios, mapeos.
- shared: utilidades y constantes transversales.

### 3.1 Regla de dependencia

- presentation puede depender de domain.
- domain no debe depender de presentation ni de detalles de infraestructura.
- data implementa contratos requeridos por domain.
- shared no debe contener reglas de negocio acopladas a UI.

## 4. Directrices Obligatorias de Implementacion

1. No aplicar cambios big-bang.
2. Migrar con estrategia incremental (strangler pattern).
3. Mantener index.html como shell hasta paridad funcional.
4. Extraer primero piezas de bajo riesgo (constants, utils puras).
5. Cada PR/cambio debe tener alcance acotado y reversible.

## 5. Regla sobre Legado y Eliminacion

En esta etapa:

- No eliminar activos legacy por defecto.
- Marcar como deprecated cuando aplique.
- Documentar evidencia de no uso antes de proponer eliminacion.
- Cualquier eliminacion requiere aprobacion explicita.

## 6. Politica de No Afectacion del Resto del Codigo

Para cada cambio, es obligatorio validar:

1. Flujos criticos siguen operativos.
2. No se rompen contratos de datos esperados por UI.
3. No se alteran rutas, PWA ni autenticacion existente.
4. No se introducen side-effects en modulos no tocados.

Checklist minimo por cambio:

- [ ] Alcance definido y acotado
- [ ] Impacto colateral evaluado
- [ ] Smoke test de flujos criticos ejecutado
- [ ] Plan de rollback listo
- [ ] Documentacion actualizada

## 7. Convenciones de Desarrollo

1. Un cambio = una intencion clara.
2. Nombres explicitos y consistentes.
3. Funciones pequenas con responsabilidad unica.
4. Evitar estado global cuando exista alternativa controlada.
5. Preferir composicion sobre logica duplicada.

## 8. Pruebas y Verificacion

Minimo esperado por iteracion:

1. Smoke tests manuales de flujos clave.
2. Validacion de pantalla principal y vistas criticas.
3. Validacion de integracion con Supabase en escenarios principales.
4. Confirmacion de despliegue estable en Vercel.

## 9. Seguridad y Configuracion

1. Evitar secretos hardcodeados en frontend.
2. Configuracion por entorno y manejo seguro de credenciales.
3. Verificar politicas de acceso a datos antes de publicar cambios.

## 10. Estrategia de Migracion Recomendada

Orden tecnico recomendado:

1. shared/constants                  -- COMPLETADO
2. shared/utils                      -- COMPLETADO
3. data/datasources + repositories   -- COMPLETADO (62% de llamadas migradas)
4. domain/use-cases                  -- COMPLETADO (funciones puras extraidas)
5. presentation/controllers + views  -- PENDIENTE (requiere refactorizacion de vistas)

Regla de avance:

No pasar a la siguiente etapa sin paridad funcional validada en la etapa actual.

### 10.1 Estado actual de la capa shared

```
public/shared/
  constants/index.js       11 constantes (dias, pills, labels, colores)
  utils/
    index.js               19 funciones (escapeHtml, logout, showToast, checkAuth,
                            avatarColor, formatDate, deriveProfileData, applyLogoToSidebar,
                            daysAgo, toast, startClock, attendanceColor, getInitials,
                            formatDateCO, getGreeting, isoWeekday, ...)
    printObservador.js      Impresion del observador del estudiante
    pwa.js                  Banners PWA (update, offline)
  data/
    apiClient.js            Cliente API unificado (auth + sede filter)
    realtime.js             Setup Supabase Realtime parametrizado
    repositories.js         61 funciones de acceso a datos (lectura + CRUD)
  domain/
    index.js                7 reglas de negocio (gradeLbl, getCurrentBell,
                            todayColombia, calcAttendancePct, classifyRisk, ...)
```

Todos los modulos se cargan como scripts regulares via window.RAICE (IIFE pattern).
NO usar type="module" porque rompe el timing con scripts secundarios (PWA, Realtime).

### 10.2 Lo que sigue PENDIENTE (estado real)

La app sigue siendo **mayormente monolitica**. Solo la capa shared (~876 lineas) esta extraida.

- Backend `pages/api/[...path].js` ≈ **9000 lineas en UN archivo** (router por string `route`).
  Es 100% monolito y el punto mas fragil. **Candidato natural siguiente:** trocearlo por dominio
  (asistencia, casos, excusas, estudiantes...) de forma incremental.
- Frontend: 1 HTML gigante por rol con JS inline (admin ~10.4k, superadmin ~6.4k, docente ~4.8k,
  rector ~1.7k, portal ~0.7k lineas). Etapa 5 (presentation) aun pendiente.

Mantener el principio: incremental, con paridad funcional validada antes de avanzar.

### 10.3 Despliegue y fuente de verdad

- **Fuente de verdad: GitHub** (`https://github.com/camilopmapp/raice.git`, rama `main`).
  Vercel auto-despliega con cada push.
- Trabajar DIRECTO en el clon Git local (`RAICE FINAL/`), validar con `node --check`,
  y `git push origin main`. **No** subir por la web de GitHub (deja clones locales desfasados).
- Antes de tocar nada, sincronizar el clon (`git fetch` + `git merge --ff-only origin/main`).
  Detalle completo en RUNBOOK.md §3.

## 11. Estandar de Documentacion

Cada cambio relevante debe actualizar:

1. estado tecnico o documento equivalente
2. decisiones de arquitectura (si aplica)
3. runbook operativo si cambia procedimiento

## 12. Criterio de Aceptacion para Nivel Mid-Level

Se considera que la migracion avanza al nivel objetivo cuando:

1. Existen capas separadas y respetadas.
2. Los cambios son predecibles y de bajo impacto colateral.
3. Hay checklists de validacion usados de forma rutinaria.
4. El equipo puede iterar sin depender de una sola persona.

## 13. Regla de Escalamiento

Si un cambio implica riesgo alto de ruptura:

1. detener implementacion directa
2. proponer alternativa incremental
3. ejecutar en feature branch con validacion reforzada
4. publicar resultado con evidencia comparativa
