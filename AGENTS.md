# AdminWeb — AGENTS.md

## 1. Propósito

Este archivo está dirigido **exclusivamente a asistentes de IA** (OpenCode,
Gemini CLI, Claude Code, Cursor, etc.). NO es un README. `README.md` explica
qué hace el panel. `AGENTS.md` explica **cómo trabajar sin romperlo**.

### Filosofía

AdminWeb es un **panel administrativo web (SPA)**. Su función es gestionar
conductores, buses, asignaciones diarias y administradores sobre Firebase
(Auth + Realtime Database). No captura GPS ni dibuja el mapa: eso lo hacen
DriverApp y la app de usuario.

Un error aquí no produce un crash visible: deja cuentas de autenticación
huérfanas, nodos RTDB desincronizados o un administrador fuera del panel.
Ante la duda: modificar menos, preguntar antes de asumir, y no alterar la
lógica de autorización ni las convenciones de correo.

---

## 2. Flujo obligatorio de trabajo

1. **Entender la tarea** — Identifica qué módulo toca (choferes, buses,
   asignaciones, admins, auth gate).
2. **Identificar archivos afectados** — Usa la tabla de sección 4 y 6.
3. **Leer documentación relacionada** — Referencias al final.
4. **Modificar solo lo necesario** — Sin refactors ni expansión de alcance.
5. **Sincronizar documentación** — Si el cambio impacta >1 documento,
   actualiza todos antes de cerrar.
6. **Ejecutar verificaciones** — Checklist de sección 9.
7. **Entregar resultado** — Confirma `lint` y `build`.

---

## 3. Comandos

| Acción | Comando |
|--------|---------|
| Instalar dependencias | `npm install` |
| Dev server | `npm run dev` (por defecto `http://localhost:5173`) |
| Lint | `npm run lint` (Oxlint) |
| Build (typecheck + bundle) | `npm run build` (`tsc -b && vite build`) |
| Preview de build | `npm run preview` |
| Deploy a Hosting | `firebase deploy` (proyecto `burritounmsm`, sirve `dist/`) |

No hay script separado de typecheck: `tsc -b` corre dentro de `npm run build`.
Prettier no está configurado como script; respeta el estilo existente.

---

## 4. Arquitectura mínima

```
src/main.tsx → App.tsx (auth gate)
            → LoginScreen (sin sesión)
            → "No autorizado" / "No se pudo verificar" (sin rol / error)
            → AdminNavigator (con rol admin)
```

| Archivo | Rol |
|---------|-----|
| `src/App.tsx` | **Crítico**: auth gate (`onAuthStateChanged` + verificación de rol) |
| `src/screen/LoginScreen.tsx` | Login DNI + contraseña (`{dni}@admin.com`) |
| `src/navigation/AdminNavigator.tsx` | Rutas: `/`, `/choferes`, `/buses`, `/asignaciones`, `/admins`, `*`→`/` (dentro del `AppShell`) |
| `src/shared/layout/AppShell.tsx` | Sidebar + topbar + drawer móvil; provee la sesión (`SessionContext`) |
| `src/shared/ui/*` | Primitivas de UI (`Button`, `Field`, `Card`, `Modal`/`ConfirmDialog`, `Toast`, `Icon`, etc.) |
| `src/styles/*` + `src/index.css` | Sistema de diseño por tokens (colores, layout, componentes) |
| `src/features/admin/services/admin_service.ts` | **Crítico**: toda la lógica CRUD (Auth + RTDB) |
| `src/features/admin/services/admin_check.ts` | Verificación de rol en `/administradores/{uid}` |
| `src/shared/config/env.ts` | Validación de variables `VITE_FIREBASE_*` al iniciar |
| `src/shared/config/firebase.ts` | Inicialización Firebase (Auth + RTDB) desde el config validado |
| `src/shared/utils/dni.ts` | Normalización y validación de DNI (8 dígitos) |
| `src/shared/utils/timeout.ts` | `withTimeout` para reads de RTDB |

Para detalles de datos y flujos: `docs/ARCHITECTURE.md` (sección AdminWeb) y
`docs/FIREBASE_SCHEMA.md`.

---

## 5. Flujo de auth y autorización

```
onAuthStateChanged → sin usuario → LoginScreen
                   → con usuario → estado "checking" mientras existeAdministrador(uid)
                        → nodo existe       → AdminNavigator
                        → PERMISSION_DENIED → "No autorizado"
                        → timeout / red     → "No se pudo verificar" (Reintentar / Cerrar Sesión)
```

- El acceso requiere que exista el nodo `/administradores/{uid}`.
- Mientras el rol está en `checking` **no** se muestra "No autorizado": es un
  estado pendiente, no una denegación. Esto evita el flash al iniciar sesión.
- En `/administradores/{uid}` la regla exige ser admin, así que
  `PERMISSION_DENIED` equivale a "no es administrador".
- La verificación de rol tiene un **timeout de 10s** (`ROLE_TIMEOUT_MS`).
  Sin red, `get()` de RTDB nunca resuelve ni rechaza. Timeout y errores de red
  **no** se interpretan como denegación (van a "No se pudo verificar").

---

## 6. Reglas críticas

### 6.1 No quitar el timeout del auth gate

`existeAdministrador` corre una sola vez al abrir el panel. Sin `withTimeout`,
un `get()` sin red cuelga indefinidamente y deja un spinner eterno (C4.AUTH).
El timeout es lo que permite mostrar la pantalla Reintentar/Cerrar Sesión.

### 6.2 Usar app temporal para gestionar cuentas Auth

Crear cuentas de conductor o de admin usa una **app Firebase temporal por
operación** (`initializeApp(firebaseConfig, 'reg_...' | 'admin_...')`) con
`inMemoryPersistence`. Nunca operar estas cuentas con la app/sesión del
administrador actual: se cerraría su sesión.

### 6.3 No leer `uid` desde `/choferes_uids`

`/choferes_uids` tiene `.read: false`. Si necesitás el `uid` de un conductor,
leelo de `/choferes/{dni}`. No agregues reads desde `/choferes_uids`.

### 6.4 Convenciones de correo hardcodeadas

Conductores: `{dni}@conductor.com` (contraseña inicial = DNI).
Administradores: `{dni}@admin.com`.
Están hardcodeadas en `admin_service.ts` y `LoginScreen.tsx` y deben
coincidir con DriverApp (ADR-025). Cambiarlas rompe el login del conductor.

### 6.5 Validación de asignaciones

`createAsignacion` valida que el conductor no tenga otra asignación activa
**para la misma fecha** (hoy o futura) y que los turnos sean válidos. No
valida que el bus esté libre: varios conductores pueden usar el mismo bus.
`hasActiveOrFutureBusAssignment` se usa en `BusesScreen` para bloquear la
eliminación de un bus con asignación activa o futura; no está conectado al
alta. No afirmes ni documentes una validación de bus que el código no ejecuta.

### 6.6 Cancelar asignación no elimina

`cancelarAsignacion` marca `activo: false`; no borra el nodo. Mantén el
historial de asignaciones del día.

### 6.7 `deleteAdmin` no borra la cuenta Auth

Eliminar un administrador borra solo su nodo en `/administradores/{uid}`.
Su cuenta de Authentication se borra manualmente desde la consola de Firebase.

### 6.8 Crear bus inicializa `ubicacion_buses`

`createBus` normaliza la placa a mayúsculas y crea `/ubicacion_buses/{placa}`
con `isActive: false`. No lo omitas: la DriverApp y la app de usuario dependen
de ese nodo.

### 6.9 No tocar el deploy sin intención

`firebase.json` sirve `dist/` con rewrites SPA y cache inmutable en
`/assets/**`. El proyecto de Hosting es `burritounmsm`. No versionar `.env`
(gitignored).

### 6.10 Bootstrap del primer administrador

El **primer** administrador se crea manualmente en Firebase Console (cuenta
Auth + nodo `/administradores/{uid}`). A partir de ahí, los demás se crean
desde el panel (`AdminsScreen` → `createAdmin()`): la escritura sobre
`/administradores` exige ser un administrador ya existente.

### 6.11 Los conductores se desactivan, no se eliminan

No existe `deleteChofer`. Retirar a un conductor de la actividad es
`toggleChoferStatus(dni, false)`. Se conservan su cuenta Auth, su `uid`, el
nodo `/choferes/{dni}` y el vínculo `/choferes_uids/{uid}`. Reactivar es el
mismo toggle con `true`, sin crear una cuenta nueva. No reintroduzcas la
eliminación física como operación habitual.

Nota: desactivar **no** cancela asignaciones activas ni detiene por sí solo el
tracking de la DriverApp (que no consulta el flag `activo` del conductor). Es
una limitación conocida; no modifiques DriverApp desde este panel.

### 6.12 DNI: exactamente 8 dígitos numéricos

Validá con `shared/utils/dni.ts` (`isValidDni` / `normalizeDni`) tanto en las
pantallas como en los servicios (`createChofer`, `createAdmin`) antes de operar.
Los inputs de DNI solo aceptan dígitos (`sanitizeDniInput`) y usan
`maxLength={8}`. No cambies las convenciones de correo.

### 6.13 Variables de entorno validadas al iniciar

`shared/config/env.ts` exige las cinco `VITE_FIREBASE_*` antes de inicializar.
Si agregás una variable de configuración nueva, sumala ahí y al `.env.example`.

### 6.14 Turnos de una asignación

Una asignación representa **un solo bus** para un conductor y una fecha.
Los turnos son datos administrativos dentro del mismo `asignacionId`:
`turnos: [{ inicio, fin }]`, en minutos desde medianoche.

- `turnos` es la fuente de verdad; `horaInicio`/`horaFin` se conservan como
  espejo del primer turno por compatibilidad con registros viejos.
- Mínimo un turno, `inicio < fin`, mismo día (sin cruzar medianoche), sin
  solapamientos y ordenados. Consecutivos y separados están permitidos.
- Editar turnos usa `updateTurnos()` sobre el mismo nodo; no crees otra
  asignación.
- La unicidad sigue siendo una asignación activa por conductor + fecha.
- No leas `turnos` desde DriverApp ni cambies el tracking: los turnos no
  inician ni detienen el recorrido. Cambiar de bus requeriría otra fase.

---

## 7. Convenciones

| Ámbito | Regla |
|--------|-------|
| UI strings | Español |
| Código | Inglés |
| Variables | camelCase |
| Componentes | PascalCase |
| Comentarios | Español |
| Documentación | Español |
| Estilos | CSS propio con tokens en `src/styles/` (importado por `index.css`); paleta "Operations Blue" |
| Lint | Oxlint (`npm run lint`) |

---

## 8. Actualización de documentación

| Si cambias... | Actualiza... |
|---------------|-------------|
| Nodo o path de RTDB | `docs/FIREBASE_SCHEMA.md` |
| Flujo o arquitectura del panel | `docs/ARCHITECTURE.md` (sección AdminWeb) |
| Decisión arquitectónica | `docs/DECISIONS.md` |
| Bug en diagnóstico | `docs/TROUBLESHOOTING.md` |
| Bug corregido | `docs/BUGS_RESUELTOS/` |
| Limitación | `docs/PROJECT_CONTEXT.md` |
| Variable de entorno (`VITE_*`) | `README.md` (Variables de entorno) + `.env.example` |
| Regla IA | `AGENTS.md` |
| Setup / stack | `README.md` |

---

## 9. Checklist pre-entrega

- [ ] `npm run lint` sin errores.
- [ ] `npm run build` compila (incluye `tsc -b`).
- [ ] Sin `console.log` temporales.
- [ ] Auth gate intacto (login → verificación de rol → panel → logout).
- [ ] Operaciones de Auth vía app temporal (no afectan la sesión del admin).
- [ ] Convenciones de correo sin cambios.
- [ ] DNI validado (8 dígitos) en pantallas y servicios.
- [ ] Sin `deleteChofer`: los conductores se desactivan, no se eliminan.
- [ ] Documentación sincronizada (todos los docs afectados).

---

## Referencias

| Si necesitas... | Lee... |
|----------------|--------|
| Propósito del sistema | `docs/PROJECT_CONTEXT.md` |
| Flujo y arquitectura | `docs/ARCHITECTURE.md` |
| Estructura RTDB | `docs/FIREBASE_SCHEMA.md` |
| Próximas fases | `docs/ROADMAP.md` |
| Bugs conocidos | `docs/TROUBLESHOOTING.md` |
| Decisiones | `docs/DECISIONS.md` |
| Historial de bugs resueltos | `docs/BUGS_RESUELTOS/` |
| Setup y stack | `README.md` |
