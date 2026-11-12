# AdminWeb — AGENTS.md

## 1. Alcance

Panel administrativo web (SPA): gestiona conductores, buses, asignaciones
diarias y administradores sobre Firebase (Auth + Realtime Database). No captura
GPS ni dibuja el mapa. Las reglas comunes están en `../AGENTS.md` y el
procedimiento en `../FLUJO_DE_TRABAJO.md`; consultalos antes de modificar
código. Si no están disponibles, informalo y no asumas que fueron cargados.

Un error aquí no produce un crash visible: deja cuentas de autenticación
huérfanas, nodos RTDB desincronizados o un administrador fuera del panel. Ante la
duda: modificar menos, preguntar antes de asumir, y no alterar la lógica de
autorización ni las convenciones de correo.

---

## 2. Comandos

| Acción | Comando |
|--------|---------|
| Instalar dependencias | `npm install` |
| Dev server | `npm run dev` (por defecto `http://localhost:5173`) |
| Lint | `npm run lint` (Oxlint) |
| Build (typecheck + bundle) | `npm run build` (`tsc -b && vite build`) |
| Preview de build | `npm run preview` |
| Deploy a Hosting | `firebase deploy` (proyecto `burritounmsm`, sirve `dist/`) |

No hay script separado de typecheck: `tsc -b` corre dentro de `npm run build`.
Prettier no está configurado como script; respetá el estilo existente.

---

## 3. Arquitectura mínima

```
src/main.tsx → App.tsx (auth gate)
            → LoginScreen (sin sesión)
            → "No autorizado" / "No se pudo verificar"
            → AdminNavigator (con rol admin)
```

| Archivo | Rol |
|---------|-----|
| `src/App.tsx` | **Crítico**: auth gate (`onAuthStateChanged` + verificación de rol) |
| `src/features/admin/services/admin_service.ts` | **Crítico**: toda la lógica CRUD (Auth + RTDB) |
| `src/features/admin/services/admin_check.ts` | Verificación de rol en `/administradores/{uid}` |
| `src/shared/utils/timeout.ts` | `withTimeout` para reads de RTDB |
| `src/shared/utils/dni.ts` | Normalización y validación de DNI (8 dígitos) |
| `src/shared/config/env.ts` | Validación de las `VITE_FIREBASE_*` al iniciar |

Rutas: `/` (Asignaciones), `/choferes`, `/buses`, `/admins`; `/asignaciones`
redirige a `/`; `*` → `/`. Detalles: `../docs/ARCHITECTURE.md` (sección AdminWeb) y
`../docs/FIREBASE_SCHEMA.md`.

Estilos: CSS propio con tokens en `src/styles/` (importado por `index.css`);
tema claro con cian `#00AEEF`, gris `#F5F5F5`, blanco y texto `#222222`. Lint con
Oxlint.

---

## 4. Flujo de auth y autorización

```
onAuthStateChanged → sin usuario → LoginScreen
                   → con usuario → "checking" mientras existeAdministrador(uid)
                        → nodo existe       → AdminNavigator
                        → PERMISSION_DENIED → "No autorizado"
                        → timeout / red     → "No se pudo verificar"
```

- El acceso requiere que exista el nodo `/administradores/{uid}`.
- Mientras el rol está en `checking` **no** se muestra "No autorizado": es un
  estado pendiente, no una denegación. Evita el flash al iniciar sesión.
- En `/administradores/{uid}` la regla exige ser admin, así que
  `PERMISSION_DENIED` equivale a "no es administrador".
- La verificación tiene un **timeout de 10 s** (`ROLE_TIMEOUT_MS`). Sin red,
  `get()` nunca resuelve ni rechaza. Timeout y errores de red **no** se
  interpretan como denegación.

---

## 5. Reglas críticas

### 5.1 No quitar el timeout del auth gate

`existeAdministrador` corre una sola vez al abrir el panel. Sin `withTimeout`,
un `get()` sin red cuelga indefinidamente y deja un spinner eterno (C4.AUTH). El
timeout habilita la pantalla Reintentar / Cerrar Sesión.

### 5.2 App temporal para gestionar cuentas Auth

Crear cuentas de conductor o de admin usa una **app Firebase temporal por
operación** (`initializeApp(firebaseConfig, 'reg_...' | 'admin_...')`) con
`inMemoryPersistence`. Nunca operes estas cuentas con la sesión del
administrador actual: se cerraría su sesión.

### 5.3 No leer `uid` desde `/choferes_uids`

`/choferes_uids` tiene `.read: false`. Si necesitás el `uid` de un conductor,
leelo de `/choferes/{dni}`. No agregues reads desde `/choferes_uids`.

### 5.4 Convenciones de correo hardcodeadas

Conductores: `{dni}@conductor.com` (contraseña inicial = DNI). Administradores:
`{dni}@admin.com`. Están en `admin_service.ts` y `LoginScreen.tsx`, y deben
coincidir con DriverApp (ADR-025). Cambiarlas rompe el login del conductor.

### 5.5 DNI: exactamente 8 dígitos numéricos

Validá con `shared/utils/dni.ts` (`isValidDni` / `normalizeDni`) tanto en
pantallas como en servicios (`createChofer`, `createAdmin`) antes de operar. Los
inputs solo aceptan dígitos (`sanitizeDniInput`) y usan `maxLength={8}`.

### 5.6 Variables de entorno validadas al iniciar

`shared/config/env.ts` exige las cinco `VITE_FIREBASE_*` antes de inicializar. Si
agregás una variable, sumala ahí y al `.env.example`. No leas ni muestres el
`.env` local (protegido en la raíz).

### 5.7 Asignaciones

`createAsignacion` valida que el conductor no tenga otra asignación activa
**para la misma fecha** (hoy o futura) y que los turnos sean válidos. **No**
valida que el bus esté libre: varios conductores pueden usar el mismo bus.
`hasActiveOrFutureBusAssignment` solo se usa en `BusesScreen` para bloquear la
eliminación de un bus con asignación activa o futura; no está conectado al alta.
No afirmes ni documentes una validación de bus que el código no ejecuta.

`cancelarAsignacion` marca `activo: false`; no borra el nodo. Mantené el
historial de asignaciones del día.

### 5.8 Turnos

Una asignación representa **un solo bus** para un conductor y una fecha. Los
turnos son datos administrativos dentro del mismo `asignacionId`:
`turnos: [{ inicio, fin }]`, en minutos desde medianoche.

- `turnos` es la fuente de verdad; `horaInicio`/`horaFin` se conservan como
  espejo del primer turno por compatibilidad con registros viejos.
- Mínimo un turno, `inicio < fin`, mismo día (sin cruzar medianoche), sin
  solapamientos y ordenados. Consecutivos y separados están permitidos.
- Editar turnos usa `updateTurnos()` sobre el mismo nodo; no crees otra
  asignación.
- La unicidad sigue siendo una asignación activa por conductor + fecha.
- No leas `turnos` desde DriverApp ni cambies el tracking: los turnos no inician
  ni detienen el recorrido. Cambiar de bus requeriría otra fase.

### 5.9 Conductores y administradores

- No existe `deleteChofer`: los conductores se desactivan con
  `toggleChoferStatus(dni, false)` y se reactivan con `true`, sin crear una
  cuenta nueva. Se conservan cuenta Auth, `uid`, `/choferes/{dni}` y
  `/choferes_uids/{uid}`. No reintroduzcas la eliminación física como operación
  habitual.
- Desactivar **no** cancela asignaciones activas ni detiene por sí solo el
  tracking de DriverApp (que no consulta el flag `activo`). Es una limitación
  conocida; no modifiques DriverApp desde este panel.
- `deleteAdmin` borra solo el nodo `/administradores/{uid}`; la cuenta de
  Authentication se borra manualmente en Firebase Console.
- El **primer** administrador se crea manualmente en Firebase Console (cuenta
  Auth + nodo). Los demás se crean desde `AdminsScreen` → `createAdmin()`:
  escribir en `/administradores` exige ser un administrador existente.

### 5.10 Crear bus inicializa `ubicacion_buses`

`createBus` normaliza la placa a mayúsculas y crea `/ubicacion_buses/{placa}`
con `isActive: false`. No lo omitas: DriverApp y la app de usuario dependen de
ese nodo.

### 5.11 Deploy

`firebase.json` sirve `dist/` con rewrites SPA y cache inmutable en `/assets/**`.
El proyecto de Hosting es `burritounmsm`. No versionar `.env` (gitignored).

---

## 6. Verificación

- `npm run lint` sin errores.
- `npm run build` compila (incluye `tsc -b`).
- Sin `console.log` temporales.
- Auth gate intacto (login → verificación de rol → panel → logout).
- Operaciones de Auth vía app temporal.
- Convenciones de correo y validación de DNI sin cambios.
- Sin `deleteChofer`; los conductores se desactivan.
- Documentación sincronizada según `../AGENTS.md` §7.
