# AdminWeb — Panel de Administración Web

Panel web para la gestión de conductores, buses y asignaciones por fecha del sistema **El Burrito**. Permitido solo para usuarios cuyo UID existe en `/administradores/` en Firebase RTDB.

## Stack

| Tecnología | Versión | Propósito |
|------------|---------|-----------|
| React | 19.x | Framework UI |
| TypeScript | 6.x | Tipado estricto |
| Vite | 8.x | Build tool y dev server |
| Firebase JS SDK | 12.x | Auth + Realtime Database |
| react-router-dom | 7.x | Navegación SPA |
| Zustand | 5.x | Estado global |
| Oxlint | 1.75+ | Linting |

## Arquitectura

```
src/
├── App.tsx                          ← Auth gate: sesión → verificación de rol (checking/admin/denied/error)
├── index.css                        ← Punto de entrada de estilos (importa src/styles/*)
├── styles/                          ← Sistema de diseño (tokens + layout + componentes + overlays + pantallas)
├── screen/
│   └── LoginScreen.tsx              ← Formulario de login (DNI + contraseña)
├── navigation/
│   └── AdminNavigator.tsx           ← Rutas del panel (envueltas por el AppShell)
├── features/admin/
│   ├── screen/
│   │   ├── AdminPanelScreen.tsx     ← Dashboard: métricas de hoy + accesos a módulos
│   │   ├── ChoferesScreen.tsx       ← Gestión de conductores (crear, editar, activar/desactivar)
│   │   ├── BusesScreen.tsx          ← Gestión de buses (crear, activar/desactivar, eliminar)
│   │   ├── AsignacionesScreen.tsx   ← Asignaciones por fecha conductor ↔ bus (multi-turno)
│   │   └── AdminsScreen.tsx         ← Gestión de administradores
│   ├── components/
│   │   └── TurnosEditor.tsx         ← Editor reutilizable de turnos
│   ├── services/
│   │   ├── admin_service.ts         ← Toda la lógica CRUD (Firebase Auth + RTDB)
│   │   └── admin_check.ts           ← Verificación de rol admin en /administradores/{uid}
│   └── utils/
│       ├── turno.ts                 ← Modelo/validación/format de turnos
│       └── turnoDraft.ts            ← Estado de edición de turnos
└── shared/
    ├── config/
    │   ├── env.ts                   ← Validación de variables VITE_FIREBASE_*
    │   └── firebase.ts              ← Inicialización de Firebase (Auth + RTDB)
    ├── layout/
    │   ├── AppShell.tsx             ← Sidebar + topbar + drawer móvil; provee la sesión (admin)
    │   └── SessionContext.tsx       ← Contexto con los datos del admin en sesión
    ├── ui/                          ← Primitivas reutilizables (Button, Field, Card, Modal, Toast…)
    └── utils/
        ├── dni.ts                   ← Normalización y validación de DNI (8 dígitos)
        ├── format.ts                ← Formateo de fechas y nombres de admin
        ├── date.ts                  ← Fechas de calendario America/Lima
        └── timeout.ts               ← Helper con timeout para reads de RTDB
```

## Interfaz y diseño

La interfaz usa un **sistema de diseño propio basado en CSS con tokens** (sin dependencias de UI). `src/index.css` solo importa las hojas de `src/styles/`:

| Hoja | Contenido |
|------|-----------|
| `tokens.css` | Variables de diseño (colores, espaciado, radios, sombras, tipografía) |
| `base.css` | Reset, tipografía base e interacciones globales |
| `layout.css` | App shell: sidebar, topbar, contenido y drawer móvil |
| `components.css` | Primitivas reutilizables (botones, campos, cards, badges, etc.) |
| `overlays.css` | Modal, diálogo de confirmación y toasts |
| `screens.css` | Login, pantallas de auth y detalles de vistas |

- **Paleta "Operations Blue", solo tema claro:** primario `#2563EB`, complementario cian `#06B6D4`, sidebar oscuro `#0F172A`, fondo `#F8FAFC`.
- **App shell** (`shared/layout/AppShell.tsx`): sidebar + topbar en escritorio; drawer en móvil. Muestra la identidad del admin en sesión y expone los datos vía `SessionContext`/`useSession`. Las rutas (`AdminNavigator`) se renderizan dentro del shell.
- **Primitivas** (`shared/ui/`): `Button`, `Field`, `Card`/`CardHeader`, `StatCard`, `StatusBadge`/`Badge`, `ToggleSwitch`, `Modal`/`ConfirmDialog`, `Toast` (+ `useToast` en `toastContext.ts`), `EmptyState`/`Spinner`/`LoadingScreen`, `PageHeader` e `Icon` (set de iconos SVG propio).
- **Confirmaciones y avisos:** no se usa `window.confirm`; las acciones se confirman con `ConfirmDialog` y los resultados se comunican con toasts.

## Autenticación y autorización

1. El usuario ingresa su DNI y contraseña. El correo interno es `{dni}@admin.com` (Firebase Auth).
2. Al autenticarse, `App.tsx` pasa por un estado explícito mientras llama `existeAdministrador(uid)`, que lee `/administradores/{uid}`.
3. Si el nodo existe → acceso al panel. Si `PERMISSION_DENIED` (la regla exige ser admin) → pantalla "No autorizado".
4. Un fallo de red o el timeout de 10s (C4.AUTH) no se interpretan como denegación: muestran la pantalla recuperable "No se pudo verificar" con Reintentar.

Solo los UIDs registrados en `/administradores/` pueden acceder al panel. Conductores y estudiantes no pueden entrar.

## Módulos del panel

| Módulo | Ruta | Descripción |
|--------|------|-------------|
| **Panel de Control** | `/` | Dashboard con métricas de hoy (conductores activos, buses activos, asignaciones) y accesos a los 4 módulos |
| **Choferes** | `/choferes` | Crear, listar, editar y activar/desactivar conductores. Desactivar conserva su cuenta y su historial (no se elimina). Cada creación genera una cuenta Firebase Auth (`{dni}@conductor.com`) y el nodo en `/choferes/{dni}` |
| **Buses** | `/buses` | Crear, listar, activar/desactivar y eliminar buses. Al crear, se inicializa `/ubicacion_buses/{placa}` con `isActive: false` |
| **Asignaciones** | `/asignaciones` | Vincular un conductor con un bus para hoy o fechas futuras. Cada asignación puede tener uno o varios turnos informativos. Valida exclusividad conductor + fecha; el bus no se valida al crear. Cancelar desactiva sin eliminar |
| **Administradores** | `/admins` | Crear, editar y eliminar cuentas de administrador. Crear genera cuenta Firebase Auth (`{dni}@admin.com`) y nodo en `/administradores/{uid}` |

### Asignaciones y turnos

- Una asignación activa por conductor + fecha; un solo bus.
- `turnos` es un array de intervalos `{ inicio, fin }` en minutos; mínimo uno, mismo día, sin solapamientos y ordenado.
- `horaInicio`/`horaFin` se mantienen como espejo del primer turno para compatibilidad.
- Los turnos no inician ni detienen el tracking del conductor; el conductor sigue usando el bus asignado.
- El bus no se valida al crear; la protección de buses se aplica al intentar eliminar uno con asignación activa o futura.

## Nodos Firebase involucrados

| Nodo | Lectura | Escritura | Descripción |
|------|---------|-----------|-------------|
| `/choferes/{dni}` | Admin | Admin | Datos del conductor (nombre, apellidos, activo, uid, creadoEn, creadoPor) |
| `/choferes_uids/{uid}` | — | Admin | Vínculo uid → dni para RTDB auth en ubicacion_buses |
| `/buses/{placa}` | Admin | Admin | Datos del bus (activo, creadoEn, creadoPor) |
| `/ubicacion_buses/{placa}` | — | Admin (solo init) | Se inicializa al crear bus; tracking lo escribe la DriverApp |
| `/asignaciones/{id}` | Admin | Admin | Asignación por fecha (choferId, busId, fecha, activo, turnos, horaInicio, horaFin, createdAt, createdBy) |
| `/administradores/{uid}` | Admin | Admin existente | Autorización del admin. Los administradores se crean desde el panel; el primero se crea en Firebase Console |

## Variables de entorno

Copia `.env.example` a `.env` y completa los valores de tu proyecto Firebase:

```bash
VITE_FIREBASE_API_KEY=
VITE_FIREBASE_AUTH_DOMAIN=
VITE_FIREBASE_DATABASE_URL=
VITE_FIREBASE_PROJECT_ID=
VITE_FIREBASE_APP_ID=
```

Al iniciar, `shared/config/env.ts` valida que las cinco variables existan. Si falta alguna, la app falla de inmediato con un mensaje que indica cuáles faltan (sin imprimir valores). Las variables `VITE_*` forman parte del bundle cliente: no son secretos.

## Desarrollo

```bash
cd AdminWeb
npm install
npm run dev
```

El dev server arranca en `http://localhost:5173`.

## Build y deploy

```bash
npm run build          # genera dist/
npm run preview        # preview local de la build
firebase deploy        # deploy a Firebase Hosting (proyecto: burritounmsm)
```

La configuración de Firebase Hosting (`firebase.json`) sirve desde `dist/` con rewrites SPA y cache de assets.

## Linting

```bash
npm run lint           # ejecuta Oxlint
```

## Compatibilidad

- **Plataforma:** web (cualquier navegador moderno)
- **No es móvil:** este panel es exclusivamente web, no tiene versión móvil
- **Firebase Hosting:** desplegado en `burritounmsm.web.app` (o el dominio configurado)

## Notas para IA

- `admin_service.ts` usa una **app temporal por operación** (`initializeApp(..., 'reg_${Date.now()}')`) con `inMemoryPersistence` para crear cuentas Auth de conductores y otros admins sin cerrar la sesión del admin actual.
- `admin_check.ts` tiene un timeout de 10s para el read de `/administradores/{uid}`. Esto es intencional (C4.AUTH): sin red, `get()` de RTDB nunca resuelve ni rechaza. Un `PERMISSION_DENIED` en esa ruta se interpreta como "no es administrador"; los fallos de red se propagan.
- Los conductores se **desactivan**, no se eliminan: no existe `deleteChofer`. Desactivar solo cambia `activo`, conservando cuenta Auth, `uid` e historial.
- El DNI se normaliza y valida con `shared/utils/dni.ts` (exactamente 8 dígitos) en pantallas y servicios.
- Los correos de conductores son `{dni}@conductor.com` y los de admins son `{dni}@admin.com`. Estas convenciones están hardcodeadas en `admin_service.ts` y `LoginScreen.tsx`.
