# Cotizador de pedidos

Versión empresarial del cotizador existente, con Supabase, acceso por usuario y contraseña, clientes, almacenamiento automático y auditoría. Conserva los cálculos, las tarifas y el tipo de cambio editable.

Esta implementación está en `feat/supabase-cotizaciones`. La versión publicada no debe sustituirse hasta configurar y validar el proyecto real de Supabase.

## Configuración completa

Lee [GUIA_SUPABASE.md](GUIA_SUPABASE.md): incluye creación del proyecto, SQL y RLS, primer administrador, usuarios sin correos personales, configuración privada del servidor, pruebas y publicación en GitHub Pages.

Para preparar el proyecto:

```bash
npm ci
```

Copia `.env.example` como `.env`, completa únicamente la URL y la clave pública de Supabase, ejecuta la migración SQL, despliega `admin-users` y crea el primer administrador siguiendo la guía. Nunca pongas `service_role`, claves secretas o contraseñas de base de datos en `VITE_*`.

```bash
npm run dev
```

Esta versión usa Vite; el `index.html` fuente ya no se abre con doble clic. Para producción:

```bash
npm run build
npm run preview
```

## Protección del acceso

El formulario de acceso permanece deshabilitado hasta que la aplicación registra sus manejadores. Si el módulo no carga o falla durante el arranque, se muestra un aviso para recargar y no se habilita la entrada de credenciales. La autenticación normal usa POST a Supabase Auth; nunca una navegación del formulario.

Los formularios de acceso, creación y restablecimiento de contraseña declaran POST. La política CSP `form-action 'none'` bloquea cualquier envío nativo, incluso `form.submit()`. Los campos del acceso no llevan nombres serializables. `public/form-safety.js` se ejecuta independientemente del módulo principal, cancela los envíos nativos y limpia parámetros de credenciales de URLs antiguas. Vite copia ese archivo a `dist` y ajusta su ruta para `/cotizador-pedido/`.

La página declara `no-referrer`; desarrollo y preview lo añaden también como cabecera HTTP. Esto evita reenviar una URL con credenciales como Referer al cargar recursos. Limpiar la barra de direcciones no elimina una petición inicial ya recibida por el servidor ni los registros históricos: una contraseña que haya aparecido en una URL debe restablecerse y su entrada debe eliminarse del historial del navegador.

Esta protección se publica con la interfaz. No necesita migraciones SQL adicionales ni cambios en las Edge Functions.

## Funciones

- Acceso por nombre de usuario y contraseña; cuentas creadas solo por administradores.
- Administrador: usuarios, roles, activación, contraseña, todas las cotizaciones, auditoría y estadísticas.
- Vendedor: cliente, cotizador y consulta de sus propias cotizaciones.
- Guardado automático de pedidos completos, ID estable, reintentos sin duplicados y control de revisiones.
- Historial con cambio e importes originales, productos, exenciones, cliente, peso, envío y estado.
- Búsquedas por cliente, usuario y número, filtros de fechas/estado, orden, paginación y CSV.
- Auditoría protegida con valores anteriores y nuevos; fechas y horas de Panamá.
- Footer discreto: © año automático Erick Gonzalez · Todos los derechos reservados.

Los permisos se comprueban en PostgreSQL y la función de servidor, no solo en la interfaz. Desactivar una cuenta bloquea las operaciones incluso con una sesión antigua.

## Matemáticas conservadas

Las tarifas de envío son fijas en dólares y colones. El tipo de cambio editable se aplica únicamente al subtotal de productos. El total en colones suma productos convertidos + envío fijo del rango de peso; el total en dólares suma productos + envío USD.

| Peso | Envío USD | Envío CRC fijo |
|---|---:|---:|
| 0–10 kg, inclusive | $15.00 | ₡7,500 |
| Más de 10–20 kg, inclusive | $30.00 | ₡15,000 |
| Más de 20 kg | $40.00 | ₡20,000 |

Por ejemplo, $10 × 2 y 5 kg dan $35.00; con cambio 500 son ₡17,500 y con 600 son ₡19,500 (₡12,000 de productos + ₡7,500 de envío). El cambio admite hasta 2 decimales, se recuerda en el navegador y permanece fijado en cada cotización almacenada. Los importes se calculan y serializan como centavos enteros, sin perder precisión en JSON. Las cotizaciones históricas conservan sus importes originales; editar y volver a guardar una antigua crea una revisión con las tarifas actuales.

El IVA sigue sin tasa comercial definida. Las exenciones se registran y no añaden recargos. No se cambian los precios finales existentes.

## Envíos con varios bultos

En **Bultos y envíos**, escribe el peso del primer bulto y usa **Agregar bulto** para cada paquete adicional del mismo pedido y cliente. Cada bulto aplica su tarifa por separado: 0–10 kg, $15 / ₡7,500; más de 10–20 kg, $30 / ₡15,000; más de 20 kg, $40 / ₡20,000. Por ejemplo, 5 kg + 15 kg son $45 / ₡22,500 de envío; no se cobra una sola tarifa sobre los 20 kg combinados. Puedes quitar bultos adicionales. Se admiten hasta 100 y todos deben tener peso válido para guardar o copiar. Un peso escrito de cero conserva la tarifa del primer rango.

El desglose se guarda dentro de la misma cotización y aparece en su detalle, edición y resumen para copiar. Los envíos siguen fijos en colones; solo los productos usan el cambio editable. Las cotizaciones anteriores se conservan y se abren con su único bulto. La actualización `supabase/migrations/202610190002_varios_bultos.sql` reemplaza la función de futuros guardados, mantiene la protección de cotizaciones eliminadas y no modifica registros existentes.

## Descuentos individuales y guardado

Cada producto tiene un selector de **porcentaje (%)** o **monto fijo (USD)**. El descuento se aplica una vez al subtotal de su línea (`precio unitario × cantidad`), nunca al envío ni a los otros productos. El porcentaje admite dos decimales, hasta 100 %; el monto fijo admite dos decimales y no puede superar ese subtotal. Vacío equivale a cero. Los campos inválidos se señalan y bloquean el guardado y la copia.

Por ejemplo, $20.00 × 2 con 10 % queda en $36.00; otro producto de $15.00 sin descuento da **$51.00 en productos**. Al indicar un bulto de 5 kg se conserva el envío de $15.00 / ₡7,500.00: total $66.00 / ₡33,000.00 con cambio 500. Las tarifas de envío existentes siguen aplicándose por bulto.

La interfaz y PostgreSQL usan cantidades enteras: centavos USD para descuentos fijos y puntos básicos para porcentajes (10 % = 1000). Se redondea el descuento de cada línea al centavo, con mitades hacia arriba. El tipo de cambio se aplica a la suma de productos después de descuentos, conservando el envío fijo en CRC. Los importes visibles y el CSV usan dos decimales. El resumen en CRC distribuye el centavo de redondeo para que subtotal original − descuentos + envío coincida con el total.

El tipo, el valor y el importe calculado se guardan en `quote_items`, el pedido normalizado, su snapshot y las revisiones. El historial, la edición, las copias, el resumen para compartir y el CSV conservan el desglose. Los registros anteriores se muestran sin descuento y mantienen sus importes históricos; esta migración no los recalcula.

**Antes de publicar esta interfaz:**

1. En el SQL Editor del proyecto de Supabase que utiliza la aplicación (en este entorno, `dmrgbwimauiwawyxpmvp`), ejecutar una vez `supabase/migrations/202611120001_descuentos_productos.sql`, después de las cinco migraciones anteriores.
2. La migración añade columnas de descuento y reemplaza `save_quote`, manteniendo permisos, conflictos de revisión y protección de cotizaciones eliminadas. Añade la consulta de compatibilidad `quote_discount_version`, disponible solo para cuentas activas autenticadas.
3. Publicar la interfaz después de aplicar el SQL. El cliente comprueba la compatibilidad antes de guardar para impedir que un servidor antiguo ignore los descuentos. Los clientes anteriores tampoco pueden sobrescribir pedidos con descuentos sin actualizarse.

**Guardar pedido** está dentro de **Total del pedido**, debajo del total. Comparte el mismo guardado automático e ID estable; se desactiva durante la petición y muestra progreso, éxito o error. La validación enfoca el primer campo que debe corregirse. Las tarjetas, controles de al menos 44 px y tablas adaptadas se verifican a 360, 375, 390, 414, 430, 768, 1024 y 1440 px.

## Eliminar cotizaciones

Un administrador activo puede eliminar una cotización desde **Mis cotizaciones → Ver detalles → Eliminar cotización**. Para cotizaciones de otros vendedores, usa **Auditoría → Ver todas las cotizaciones**. La confirmación elimina definitivamente la cotización, sus productos y revisiones; conserva los clientes y la auditoría, que registra el administrador responsable. La cotización deja de sumar en los reportes. Si otra sesión la modificó, hay que volver a consultar el detalle antes de confirmar. Un autoguardado tardío no puede recrear el mismo ID eliminado. Esta función requiere `supabase/migrations/202610190001_borrar_cotizaciones.sql`; aplicarla solo instala la función, no borra cotizaciones existentes.

## Reportes por vendedor

En **Auditoría → Cotizaciones y ventas por vendedor**, selecciona **Mes** o **Semana**, define un rango de hasta un año y pulsa **Consultar reporte**. Los administradores ven nombre/usuario del vendedor, cantidad de cotizaciones, montos históricos USD/CRC, unidades cotizadas, cotizaciones confirmadas y unidades vendidas. Las cotizaciones se agrupan por fecha de creación; las ventas por su última confirmación vigente. Se usan fechas de Panamá y semanas de lunes a domingo. Las revisiones no duplican registros. Los montos y unidades cotizadas excluyen canceladas; las unidades vendidas pertenecen a cotizaciones actualmente confirmadas. La información se conserva en las cotizaciones y revisiones de Supabase, sin mantener copias de los totales que puedan quedar desactualizadas.

La actualización `supabase/migrations/202610110003_reportes.sql` añade la función protegida del reporte sin modificar datos existentes.

## Pruebas

```bash
npm test
npm run check:functions
npx playwright install chromium
npm run test:ui
```

Las pruebas de base de datos ejecutan SQL y RLS en PostgreSQL local con PGlite. Las pruebas de interfaz y de administración usan un servicio de prueba controlado. No sustituyen la validación de Supabase Auth, la Edge Function y las cuentas en tu proyecto real.

Consulta [VERIFICACION.txt](VERIFICACION.txt) para conocer las comprobaciones ejecutadas y sus límites.

## Publicación

Configura las variables públicas de Actions y Source = GitHub Actions en Pages. El workflow prueba y publica `dist`, con archivos que llevan hash para evitar caché antigua. Los pasos exactos están en la guía. Un build local o un push a la rama de trabajo no confirman una publicación.

## Estructura

- `index.html`, `style.css`, `script.js`: interfaz y motor del cotizador original ampliados.
- `src/`: integración, sesiones, historial, administración, guardado y exportación.
- `supabase/migrations/`: tablas, funciones, RLS y auditoría.
- `supabase/functions/`: administración segura y nombres de usuario técnicos.
- `scripts/bootstrap-admin.mjs`: primer administrador desde un proceso privado.
- `tests/`: regresiones de cálculos, PostgreSQL, seguridad y navegador.
- `.env.example`: configuración pública sin secretos.

La guía HTML anterior se conserva como referencia histórica y no describe la instalación de esta versión.
