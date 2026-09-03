# AdminWeb — Panel de Administración Web

Panel web para la gestión de conductores, buses y asignaciones diarias del sistema **El Burrito**. Permitido solo para usuarios cuyo UID existe en `/administradores/` en Firebase RTDB.

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
├── App.tsx                          ← Auth gate: sesión → admin check → role error
├── screen/
│   └── LoginScreen.tsx              ← Formulario de login (email + password)
├── navigation/
│   └── AdminNavigator.tsx           ← Rutas del panel
├── features/admin/
│   ├── screen/
│   │   ├── AdminPanelScreen.tsx     ← Menú principal del admin
│   │   ├── ChoferesScreen.tsx       ← CRUD de conductores
│   │   ├── BusesScreen.tsx          ← CRUD de buses
│   │   ├── AsignacionesScreen.tsx   ← Asignaciones diarias conductor ↔ bus
│   │   └── AdminsScreen.tsx         ← Gestión de administradores
│   └── services/
│       ├── admin_service.ts         ← Toda la lógica CRUD (Firebase Auth + RTDB)
│       └── admin_check.ts           ← Verificación de rol admin en /administradores/{uid}
└── shared/
    ├── config/
    │   └── firebase.ts              ← Inicialización de Firebase (Auth + RTDB)
    └── utils/
        └── timeout.ts               ← Helper con timeout para reads de RTDB
```

## Autenticación y autorización

1. El usuario ingresa email y password (Firebase Auth).
2. Al autenticarse, `App.tsx` llama `existeAdministrador(uid)` que lee `/administradores/{uid}`.
3. Si el nodo existe → acceso al panel. Si no → pantalla "No autorizado".
4. La verificación tiene un timeout de 10s para evitar spinners infinitos sin red (ADR-04, C4.AUTH).

Solo los UIDs registrados en `/administradores/` pueden acceder al panel. Conductores y estudiantes no pueden entrar.

## Módulos del panel

| Módulo | Ruta | Descripción |
|--------|------|-------------|
| **Panel de Control** | `/` | Menú principal con acceso a los 4 módulos |
| **Choferes** | `/choferes` | Crear, listar, editar, activar/desactivar y eliminar conductores. Cada creación genera una cuenta Firebase Auth (`{dni}@conductor.com`) y el nodo en `/choferes/{dni}` |
| **Buses** | `/buses` | Crear, listar, activar/desactivar y eliminar buses. Al crear, se inicializa `/ubicacion_buses/{placa}` con `isActive: false` |
| **Asignaciones** | `/asignaciones` | Vincular un conductor con un bus para el día actual. Valida que ni el conductor ni el bus tengan otra asignación activa hoy. Cancelar desactiva sin eliminar |
| **Administradores** | `/admins` | Crear, editar y eliminar cuentas de administrador. Crear genera cuenta Firebase Auth (`{dni}@admin.com`) y nodo en `/administradores/{uid}` |

## Nodos Firebase involucrados

| Nodo | Lectura | Escritura | Descripción |
|------|---------|-----------|-------------|
| `/choferes/{dni}` | Admin | Admin | Datos del conductor (nombre, apellidos, activo, uid, creadoEn) |
| `/choferes_uids/{uid}` | — | Admin | Vínculo uid → dni para RTDB auth en ubicacion_buses |
| `/buses/{placa}` | Admin | Admin | Datos del bus (activo, creadoEn) |
| `/ubicacion_buses/{placa}` | — | Admin (solo init) | Se inicializa al crear bus; tracking lo escribe la DriverApp |
| `/asignaciones/{id}` | Admin | Admin | Asignación diaria (choferId, busId, fecha, activo, createdBy) |
| `/administradores/{uid}` | Admin | Admin | Nodo de autorización del admin |

## Variables de entorno

Copia `.env.example` a `.env` y completa los valores de tu proyecto Firebase:

```bash
VITE_FIREBASE_API_KEY=
VITE_FIREBASE_AUTH_DOMAIN=
VITE_FIREBASE_DATABASE_URL=
VITE_FIREBASE_PROJECT_ID=
VITE_FIREBASE_APP_ID=
```

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

- `admin_service.ts` usa una **app temporal por operación** (`initializeApp(..., 'reg_${Date.now()}')`) con `inMemoryPersistence` para crear/eliminar cuentas Auth de conductores y otros admins sin cerrar la sesión del admin actual.
- `admin_check.ts` tiene un timeout de 10s para el read de `/administradores/{uid}`. Esto es intencional (C4.AUTH): sin red, `get()` de RTDB nunca resuelve ni rechaza.
- Los correos de conductores son `{dni}@conductor.com` y los de admins son `{dni}@admin.com`. Estas convenciones están hardcodeadas en `admin_service.ts`.
