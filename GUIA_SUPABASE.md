# Configurar el cotizador con Supabase

Esta versión amplía el cotizador existente: conserva productos, cantidades, tarifas de envío, cálculo exacto con BigInt y cambio editable. Añade acceso del equipo, clientes, almacenamiento, historial, usuarios y auditoría. La versión anterior permanece en `main` mientras configuras la rama `feat/supabase-cotizaciones`.

## 1. Cuenta y proyecto

Entra en https://supabase.com/dashboard y accede a tu cuenta. Para un proyecto nuevo, pulsa **New project**, selecciona la organización y define su nombre y contraseña de base de datos. Guarda esa contraseña en un gestor privado; no la necesita el navegador.

Tu URL de proyecto facilitada es:

```text
https://ejycazhhvtwcuvdxysxg.supabase.co
```

No recrees tu proyecto si ya existe. Si contiene tablas llamadas `profiles`, `clients`, `quotes`, `quote_items`, `quote_revisions` o `audit_events`, revisa el esquema antes de ejecutar la migración. El SQL no elimina tablas existentes; una colisión produce un error. No resuelvas una colisión borrando datos.

## 2. URL y clave pública

En el panel del proyecto, abre **Connect** o **Project Settings → API / API Keys**. Copia la URL y la clave **Publishable** (`sb_publishable_...`). Para proyectos con claves antiguas, puedes usar la clave `anon`.

La clave pública identifica el proyecto; el acceso a los datos lo controlan las sesiones y RLS. Nunca uses `service_role`, una clave `sb_secret_...` o la contraseña de PostgreSQL en `VITE_*`, JavaScript, GitHub Pages o el chat.

## 3. Base de datos y políticas RLS

Abre **SQL Editor → New query**. Copia el contenido completo de:

```text
supabase/migrations/202610090001_cotizador.sql
```

Pulsa **Run** una vez. Se ejecuta en una transacción: si hay un error, no continúes con una instalación parcial. Si ya lo ejecutaste correctamente, no vuelvas a ejecutar los `CREATE` como una migración nueva.

La migración crea las seis tablas, restricciones, índices, políticas y funciones. En **Table Editor**, comprueba que RLS está activado. No desactives RLS para resolver errores.

Las cuentas nuevas empiezan inactivas y como vendedores. La metadata de Auth nunca otorga administración. Las escrituras directas a tablas están prohibidas a vendedores y administradores del navegador: las cotizaciones se guardan mediante funciones que verifican la cuenta y recalculan los importes. Los vendedores leen únicamente sus cotizaciones. Los administradores activos consultan todas y la auditoría. Una cuenta inactiva pierde acceso aunque conserve un JWT sin vencer.

Si prefieres migraciones con CLI, después de instalar dependencias puedes usar:

```bash
npx supabase login
npx supabase link --project-ref ejycazhhvtwcuvdxysxg
npx supabase db push
```

Usa SQL Editor o CLI para esta migración; no ejecutes la misma migración dos veces por ambas vías.

Para las tarifas fijas en colones, aplica después `supabase/migrations/202610110002_envio_fijo.sql`. Si la base ya existe, ejecuta únicamente esta actualización. Reemplaza la función de cálculo de futuros guardados sin modificar las cotizaciones históricas ni sus revisiones. Una cotización antigua conserva su total en el historial; editarla y guardarla crea una revisión con las tarifas actuales.

Aplica también `supabase/migrations/202610110003_reportes.sql` para habilitar los reportes semanales y mensuales por vendedor en Auditoría. Solo administradores activos pueden consultarlos. El reporte usa los registros existentes, fechas de Panamá y semanas de lunes a domingo; no crea cuentas ni modifica cotizaciones.

Para habilitar **Eliminar cotización**, aplica después `supabase/migrations/202610190001_borrar_cotizaciones.sql`. Instala la operación protegida de borrado y actualiza `save_quote` para rechazar autoguardados de IDs ya eliminados. La instalación no elimina registros. Solo administradores activos pueden borrar tras confirmar desde el detalle; se conservan los clientes compartidos y los eventos de auditoría.

Para varios bultos, aplica después `supabase/migrations/202610190002_varios_bultos.sql` y luego publica la interfaz correspondiente. Si las actualizaciones anteriores ya están instaladas, ejecuta solo este archivo nuevo. Cada bulto tiene peso y tarifa calculada por el servidor; el total de envío suma todas las tarifas fijas. Las cotizaciones antiguas permanecen intactas. Un navegador con la interfaz anterior debe actualizarse antes de editar una cotización que ya tenga varios bultos.

Para los descuentos individuales, aplica después `supabase/migrations/202611120001_descuentos_productos.sql` **antes de publicar la interfaz nueva**. Ejecuta únicamente esta migración si ya instalaste las anteriores. Añade los campos de descuento por producto y actualiza el guardado del servidor; no recalcula cotizaciones históricas. El cliente comprueba que esté instalada antes de guardar. Para este entorno, el proyecto seleccionado es `dmrgbwimauiwawyxpmvp`; las referencias anteriores a otro proyecto en esta guía son históricas y deben sustituirse por la URL del proyecto que estés usando.

## 4. Usuarios sin correos electrónicos

En **Authentication → Providers**, mantén habilitado el proveedor **Email/password**, pero desactiva **Allow new users to sign up**. No hay registro abierto en esta aplicación.

Los empleados escriben únicamente usuario y contraseña. Internamente, `erick` se transforma en `erick@usuarios.cotizador.invalid`. Es un identificador técnico, no un correo personal ni una dirección que reciba mensajes. Supabase Auth administra los hashes y las sesiones; no se guardan contraseñas en perfiles.

Los usuarios tienen de 3 a 32 caracteres: letras sin acentos, números, punto, guion o guion bajo, sin puntos consecutivos ni punto final. Se convierten a minúsculas; no pueden duplicarse. El administrador crea las cuentas con `email_confirm: true` exclusivamente en el servidor. No hace falta enviar correos de confirmación a los empleados.

La recuperación de contraseñas se hace desde **Usuarios → Restablecer contraseña**, no por correo. Las contraseñas nuevas deben tener de 12 a 128 caracteres y cumplir cualquier regla adicional del proyecto. El nombre visible puede cambiarse; el nombre de acceso permanece estable.

## 5. Instalar dependencias en Visual Studio Code

Instala Node.js 24. Abre la carpeta del repositorio en VS Code y una terminal en esa carpeta:

```bash
npm ci
```

`package-lock.json` fija las dependencias. No necesitas rehacer la aplicación ni instalar una base local para usar tu proyecto de Supabase.

## 6. Configuración pública local

Copia `.env.example` como `.env` en la raíz. En Windows PowerShell:

```powershell
Copy-Item .env.example .env
```

En macOS/Linux:

```bash
cp .env.example .env
```

Abre `.env` y completa:

```dotenv
VITE_SUPABASE_URL=https://ejycazhhvtwcuvdxysxg.supabase.co
VITE_SUPABASE_PUBLISHABLE_KEY=TU_CLAVE_PUBLICA_PUBLISHABLE
```

Para una clave antigua puedes sustituir la segunda línea por `VITE_SUPABASE_ANON_KEY=TU_CLAVE_ANON`. Reinicia Vite después de modificar `.env`. Las variables `VITE_*` se incluyen en el sitio compilado; solo pueden contener configuración pública. `.env` está ignorado por Git.

## 7. Función segura de administración

La función `supabase/functions/admin-users/index.ts` crea usuarios, cambia roles, activa/desactiva cuentas y restablece contraseñas. Verifica el token en Supabase Auth y después vuelve a comprobar el perfil y el rol actuales en PostgreSQL. El navegador no recibe su clave administrativa.

En la terminal del proyecto, con la CLI autenticada en tu propia cuenta:

```bash
npx supabase secrets set ALLOWED_ORIGINS="https://megaregalon72-bot.github.io,http://127.0.0.1:5173,http://localhost:5173" --project-ref ejycazhhvtwcuvdxysxg
npx supabase functions deploy admin-users --project-ref ejycazhhvtwcuvdxysxg
```

Los orígenes no incluyen rutas: usa `https://megaregalon72-bot.github.io`, sin `/cotizador-pedido/`. Quita los orígenes locales cuando no los necesites. Si usas otro dominio, añádelo explícitamente. CORS complementa la autenticación, no la sustituye.

Supabase proporciona `SUPABASE_URL` y `SUPABASE_SERVICE_ROLE_KEY` a la función de servidor. No copies esas claves en el frontend. `verify_jwt = false` en el archivo de configuración no deja la función abierta: permite el formato actual de tokens y la función ejecuta su propia validación obligatoria con `Auth.getUser` y la comprobación de administrador activo.

## 8. Crear el primer administrador

Esta operación requiere acceso administrativo al proyecto y se ejecuta una sola vez desde Node.js, nunca en el navegador.

Crea un archivo privado `.env.bootstrap` en la raíz. Está ignorado por Git y no lo carga Vite en desarrollo o producción. Incluye:

```dotenv
SUPABASE_URL=https://ejycazhhvtwcuvdxysxg.supabase.co
SUPABASE_SERVICE_ROLE_KEY=CLAVE_SERVICE_ROLE_SOLO_PARA_ESTE_PROCESO
BOOTSTRAP_USERNAME=administrador
BOOTSTRAP_PASSWORD=UNA_CONTRASENA_LARGA_Y_UNICA
```

La clave `service_role` se obtiene en el panel administrativo de Supabase, no se comparte con empleados y no se añade a variables `VITE_*` ni a GitHub Pages. Ejecuta:

```bash
node --env-file=.env.bootstrap scripts/bootstrap-admin.mjs
```

El script crea el identificador técnico y llama a una función SQL solo disponible para el servidor. La base impide repetir el bootstrap si ya existe un administrador y evita desactivar al último administrador activo.

Después de crear la cuenta, elimina el archivo privado `.env.bootstrap` o guárdalo fuera del proyecto en un lugar seguro. No se necesita para iniciar el sitio. Si el Auth user se creó pero el bootstrap falló, revisa la migración y, desde SQL Editor como propietario, ejecuta `select public.bootstrap_admin('ID_DEL_AUTH_USER');` con el ID mostrado en **Authentication → Users**, sin crear otra cuenta duplicada.

## 9. Iniciar el proyecto

```bash
npm run dev
```

Abre la dirección que muestra Vite y accede con `administrador` y la contraseña que configuraste. El formulario solicita usuario y contraseña; nunca un correo electrónico.

Esta versión necesita Vite o los archivos compilados: no abras el `index.html` fuente con doble clic. Para comprobar el sitio listo para publicar:

```bash
npm run build
npm run preview
```

El resultado está en `dist/`. Sus archivos tienen nombres con hash para evitar mezclar JavaScript antiguo con HTML nuevo.

## 10. Crear empleados y comprobar sesiones

Entra como administrador, abre **Usuarios** y crea un vendedor. Prueba su acceso en una ventana privada. Debe ver **Cotizador** y **Mis cotizaciones**, sin gestión de usuarios ni auditoría.

La sesión se mantiene mediante tokens de Supabase y renovación automática. El almacenamiento local contiene tokens, nunca la contraseña. La aplicación utiliza CSP, renderizado de datos como texto y controles de permisos en PostgreSQL. Como en cualquier aplicación con tokens en el navegador, un script malicioso ejecutado en ese mismo origen podría robarlos: no añadas scripts externos no confiables ni desactives estas protecciones. Para equipos compartidos, usa **Cerrar sesión** al terminar.

Si el navegador bloquea el almacenamiento local, se puede trabajar durante esa sesión, pero no se garantiza que sobreviva a una recarga. Al desactivar un usuario, la base bloquea inmediatamente sus consultas y escrituras; la interfaz revisa su perfil cada 30 segundos y cierra el acceso visual.

## 11. Comprobar almacenamiento y matemáticas

Con un vendedor:

1. Ingresa `María González` como cliente.
2. Precio `10`, cantidad `2`, peso `5`, cambio `500`: $35.00 / ₡17,500.
3. Cambia a `600`: $35.00 / ₡19,500 (₡12,000 de productos + ₡7,500 de envío fijo).
4. Espera el mensaje **COT-… guardada**. También puedes pulsar **Guardar ahora**.
5. En Supabase → Table Editor, comprueba `quotes`, `clients`, `quote_items`, `quote_revisions` y `audit_events`.
6. Recarga o cierra y vuelve a iniciar sesión; abre **Mis cotizaciones**.
7. Cambia el cambio del formulario a `700` y abre el detalle de la cotización guardada: debe conservar 600 y ₡19,500.
8. Edita la cotización: aumenta su revisión. En el detalle, abre el historial y comprueba valores anteriores y nuevos.

El guardado automático ocurre 900 ms después del último cambio, cuando existen cliente, productos válidos y peso. El ID permanece igual mientras editas un pedido; los reintentos no crean otro registro. **Limpiar cotización** guarda primero un pedido completo pendiente y comienza otro ID. No se borran cotizaciones históricas.

Los campos vacíos o inválidos no se guardan como pedidos completos. Si falla la red, se muestran el error y los datos siguen en el formulario para reintentar; no cierres esa pestaña antes de guardar. El sistema avisa al intentar salir con cambios completos pendientes. No se promete almacenamiento offline permanente.

Los productos pueden registrar una exención. Actualmente no hay una tasa comercial de IVA definida, igual que en el cotizador original: se conserva esa información sin inventar impuestos ni añadir recargos. Las tarifas finales son $15 / ₡7,500, $30 / ₡15,000 y $40 / ₡20,000, según el rango de peso. Solo el subtotal de productos se convierte con el cambio editable. El peso cero escrito aplica $15 / ₡7,500; el peso vacío no permite guardar. Se admiten hasta 100 productos por pedido.

## 12. Auditoría, filtros y exportación

Entra como administrador y abre **Auditoría**. Los indicadores suman importes históricos, excluyendo canceladas de los totales. Usa **Ver todas las cotizaciones** para consultar la tabla principal.

Busca por cliente, usuario o número; filtra fechas y estado, cambia el orden y usa la paginación. Las fechas son de Panamá (`America/Panama`); PostgreSQL guarda `timestamptz`. **Exportar resultados a CSV** exporta todos los resultados de los filtros, no solo la página visible. Excel puede abrir el CSV con codificación UTF-8.

El detalle conserva productos, cantidades, precio, exenciones, peso, envío, cambio, totales y revisiones. Vendedores pueden cambiar sus borradores/enviadas o cancelar; confirmar y reabrir cotizaciones cerradas requiere administrador. El cambio de estado también crea una revisión y un evento. Un administrador puede editar cotizaciones autorizadas de otros empleados sin cambiar el autor original.

Los eventos registran actor, acción, fecha, hora y recurso. Login/logout se registran cuando existe conexión y una sesión válida; cerrar una pestaña o perder la red no equivale a un evento de logout garantizado. Los intentos y confirmaciones de restablecimiento de contraseña se distinguen. Los registros de auditoría no admiten edición ni eliminación desde la aplicación.

## 13. Publicar en GitHub Pages

Completa y prueba Supabase antes de fusionar `feat/supabase-cotizaciones` en `main`. La nueva versión necesita compilación; no sirve publicar los archivos fuente como antes.

En GitHub → repositorio → **Settings → Secrets and variables → Actions → Variables**, crea estas **Repository variables** públicas:

```text
VITE_SUPABASE_URL
VITE_SUPABASE_PUBLISHABLE_KEY
```

Introduce la URL y la clave pública. No pongas `service_role` ni claves secretas aquí. Si tienes una clave antigua `anon`, puedes guardarla en la variable pública `VITE_SUPABASE_PUBLISHABLE_KEY` del workflow.

Después ve a **Settings → Pages → Source → GitHub Actions**. El workflow `.github/workflows/pages.yml` instala dependencias, ejecuta pruebas, compila y publica `dist`. Rechaza una compilación de publicación si faltan las variables. Fusionar o enviar cambios a `main` inicia el workflow; revisa **Actions** y espera que termine en verde antes de comprobar el sitio.

La dirección del sitio conserva el nombre de tu repositorio. Ninguna operación local o push a la rama de trabajo confirma por sí sola una publicación en Pages.

## 14. Pruebas disponibles

```bash
npm test
npm run check:functions
npx playwright install chromium
npm run test:ui
```

`npm test` ejecuta la migración y políticas en PostgreSQL local mediante PGlite y prueba cálculos, historial, duplicados, filtros, estados, permisos y desactivación. En esas pruebas se simula únicamente la identidad que Supabase normalmente entrega a PostgreSQL.

Las pruebas de interfaz utilizan respuestas controladas de la API para validar formularios y flujos. Las pruebas de la función verifican sus controles usando un cliente Auth de prueba y también hay comprobación estática de TypeScript. No sustituyen una conexión real a tu proyecto ni comprueban el hash de contraseñas de Supabase Auth o el despliegue real de la Edge Function. Los pasos 10–12 son la comprobación completa contra el proyecto configurado.

Si Chromium ya está instalado en el entorno, puedes usar en Linux:

```bash
PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium npm run test:ui
```

## 15. Errores habituales

| Mensaje o síntoma | Comprobación |
|---|---|
| Conexión pendiente | URL y clave pública en `.env`; reinicia Vite o recompila Pages. |
| Usuario o contraseña incorrectos | Usuario técnico creado, contraseña correcta y dominio interno sin modificar. No uses un correo personal en el formulario. |
| Perfil inexistente / relación inexistente | Ejecuta la migración antes de crear cuentas y comprueba el trigger de Auth. |
| Cuenta desactivada | Reactívala desde otro administrador. No alteres RLS ni el token. |
| Usuario duplicado | El nombre es único e inmutable; revisa Usuarios antes de crear otro. |
| No funciona gestión de usuarios | Despliega `admin-users`; configura ALLOWED_ORIGINS y accede como administrador activo. |
| CORS / origen no autorizado | Añade el origen completo, sin ruta, a ALLOWED_ORIGINS y vuelve a desplegar si cambió el código. |
| Conflicto al guardar | Otra pestaña actualizó la revisión. Abre la versión actual en el historial antes de continuar. |
| No cambia CRC / contenido anterior | Espera el workflow de Pages y recarga. El build nuevo usa archivos con hash. |
| Pages queda en rojo | Revisa Variables de Actions, Source = GitHub Actions y la salida del workflow. |
| La cuenta se creó inactiva pero no pudo activarse | Completa rol y activación desde Usuarios después de corregir SQL/permisos. |
| No permite borrar un usuario en Auth | Los perfiles históricos conservan referencias. Desactiva la cuenta en la aplicación para mantener la auditoría. |
| Codex no puede acceder al proyecto | En la configuración del entorno permite `ejycazhhvtwcuvdxysxg.supabase.co`. Para revisar Pages también necesita `api.github.com` y `megaregalon72-bot.github.io`. No desactives TLS ni extraigas tokens. |

## Archivos y decisiones

- `script.js`: cálculo existente, descripción/exención y puente de snapshots hacia el módulo empresarial.
- `index.html` / `style.css`: acceso, cliente, historial, administración, detalle y footer automático discreto.
- `src/app.js`: sesión, guardado automático, historial, filtros, estados y gestión conectados a Supabase.
- `src/backend.js`: cliente con configuración pública, almacenamiento de sesión y llamadas reales.
- `src/format.js`: importes, fechas de Panamá, validación y CSV seguro.
- `supabase/migrations/202610090001_cotizador.sql`: modelo, RLS, cálculos del servidor y auditoría inmutable.
- `supabase/functions/admin-users/`: operaciones privilegiadas de usuarios.
- `scripts/bootstrap-admin.mjs`: primer administrador desde un proceso privado.
- `.env.example`, `package*.json`, `vite.config.js`: configuración y compilación reproducibles.
- `tests/` y `.github/workflows/pages.yml`: pruebas y publicación de la versión compilada.

Vite añade una compilación a los archivos existentes; no sustituye el cotizador por otra aplicación. Las claves administrativas permanecen exclusivamente en la función de servidor o el proceso privado de bootstrap. Los importes se serializan como cadenas de centavos para evitar perder precisión al guardar BigInt en JSON.
