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
| `src/navigation/AdminNavigator.tsx` | Rutas: `/`, `/choferes`, `/buses`, `/asignaciones`, `/admins`, `*`→`/` |
| `src/features/admin/services/admin_service.ts` | **Crítico**: toda la lógica CRUD (Auth + RTDB) |
| `src/features/admin/services/admin_check.ts` | Verificación de rol en `/administradores/{uid}` |
| `src/shared/config/firebase.ts` | Inicialización Firebase (Auth + RTDB) desde `VITE_FIREBASE_*` |
| `src/shared/utils/timeout.ts` | `withTimeout` para reads de RTDB |

Para detalles de datos y flujos: `docs/ARCHITECTURE.md` (sección AdminWeb) y
`docs/FIREBASE_SCHEMA.md`.

---

## 5. Flujo de auth y autorización

```
onAuthStateChanged → sin usuario → LoginScreen
                   → con usuario → existeAdministrador(uid)
                        → true  → AdminNavigator
                        → false → "No autorizado"
                        → error/timeout → "No se pudo verificar" (Reintentar / Cerrar Sesión)
```

- El acceso requiere que exista el nodo `/administradores/{uid}`.
- La verificación de rol tiene un **timeout de 10s** (`ROLE_TIMEOUT_MS`).
  Sin red, `get()` de RTDB nunca resuelve ni rechaza.

---

## 6. Reglas críticas

### 6.1 No quitar el timeout del auth gate

`existeAdministrador` corre una sola vez al abrir el panel. Sin `withTimeout`,
un `get()` sin red cuelga indefinidamente y deja un spinner eterno (C4.AUTH).
El timeout es lo que permite mostrar la pantalla Reintentar/Cerrar Sesión.

### 6.2 Usar app temporal para gestionar cuentas Auth

Crear/eliminar cuentas de conductor o de admin usa una **app Firebase temporal
por operación** (`initializeApp(firebaseConfig, 'reg_...' | 'del_...' | 'admin_...')`)
con `inMemoryPersistence`. Nunca operar estas cuentas con la app/sesión del
administrador actual: se cerraría su sesión.

### 6.3 No leer `uid` desde `/choferes_uids`

`/choferes_uids` tiene `.read: false`. El `uid` del conductor se lee de
`/choferes/{dni}`. `deleteChofer` ya lo hace así; no lo cambies.

### 6.4 Convenciones de correo hardcodeadas

Conductores: `{dni}@conductor.com` (contraseña inicial = DNI).
Administradores: `{dni}@admin.com`.
Están hardcodeadas en `admin_service.ts` y `LoginScreen.tsx` y deben
coincidir con DriverApp (ADR-025). Cambiarlas rompe el login del conductor.

### 6.5 No asumir validación de bus duplicado

`createAsignacion` **solo valida que el conductor no tenga otra asignación
activa hoy**. `hasActiveBusAssignment` existe en el servicio pero no está
conectado al flujo de creación. No afirmes ni documentes una validación de
bus que el código no ejecuta.

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
| Estilos | CSS en `index.css` (clases) |
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
