# Observabilidad de Service B — proveedor FAKE

## Ciclo de implementación

1. Instalar `@opentelemetry/api` y `@opentelemetry/auto-instrumentations-node`.
   Esta etapa ya se publicó anteriormente como `7c4e05b`; los lockfiles npm/pnpm
   quedaron sincronizados y el Dockerfile sigue usando `npm ci`.
2. Activar el preload de instrumentación automática mediante variables del proceso.
3. Comprobar arranque, HTTP y exportación de trazas/métricas automáticas.
4. Usar `metrics.getMeter('servicio-b.payment-provider', '1.0.0')` para añadir
   métricas de negocio al **mismo proveedor global**.

No hay otro `NodeSDK`, `MeterProvider`, exportador, Collector ni endpoint
Prometheus en el código. Sin preload/proveedor activo, la API es no-op.
La verificación descrita es local; no demuestra despliegue ni recepción en Grafana Cloud.

## Configuración del proceso/Railway

Configurar en **el servicio B**, no modificar las variables del servicio A:

```dotenv
NODE_OPTIONS=--require @opentelemetry/auto-instrumentations-node/register
OTEL_SERVICE_NAME=servicio-b
OTEL_TRACES_EXPORTER=otlp
OTEL_METRICS_EXPORTER=otlp
OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf
OTEL_EXPORTER_OTLP_ENDPOINT=<endpoint OTLP de Grafana Cloud>
OTEL_EXPORTER_OTLP_HEADERS=<credencial privada administrada en Railway>
OTEL_RESOURCE_ATTRIBUTES=service.name=servicio-b,deployment.environment=production
```

Los valores privados no se incluyen en archivos versionados. No reemplazar
otras opciones necesarias de `NODE_OPTIONS`: añadir el preload una sola vez.
Para ejecutar localmente con exportación, estas variables deben existir **antes
de arrancar Node**. `main.ts` carga `.env` después del preload: definir únicamente
`NODE_OPTIONS` o la configuración OTLP en ese archivo no configura retroactivamente
el SDK. La configuración de pagos/HMAC existente se conserva.

## Qué mide B y qué no mide

Service B guarda operaciones **en memoria**, no en PostgreSQL. Recibe
`POST /payments`, calcula un resultado simulado y emite WebHooks firmados.
Por eso sus métricas tienen prefijo `provider_`: un resultado APPROVED en B
no demuestra que A haya recibido/persistido la confirmación.

Todos los contadores usan únicamente `provider=FAKE`. El histograma de entrega
añade `result=DELIVERED|FAILED`, de cardinalidad limitada. No se incluyen IDs,
URLs, suscripciones, montos, firmas, secretos ni mensajes de errores.

| Instrumento OTLP              | Nombre esperado en Grafana/Prometheus | Evento contabilizado                                                            |
| ----------------------------- | ------------------------------------- | ------------------------------------------------------------------------------- |
| `provider_payments_received`  | `provider_payments_received_total`    | Operación válida guardada en el array de pagos, después de validar y almacenar. |
| `provider_payments_approved`  | `provider_payments_approved_total`    | Estado simulado APPROVED registrado en memoria, antes del despacho del WebHook. |
| `provider_payments_rejected`  | `provider_payments_rejected_total`    | Estado simulado REJECTED registrado en memoria.                                 |
| `provider_payments_deferred`  | `provider_payments_deferred_total`    | Estado intermedio DEFERRED registrado en memoria.                               |
| `provider_webhooks_attempts`  | `provider_webhooks_attempts_total`    | Cada intento HTTP real hacia un destino, incluido el primero.                   |
| `provider_webhooks_retries`   | `provider_webhooks_retries_total`     | Intentos segundo/tercero dentro de la misma entrega; no la espera programada.   |
| `provider_webhooks_delivered` | `provider_webhooks_delivered_total`   | Una entrega final exitosa guardada en el registro de entregas.                  |
| `provider_webhooks_failed`    | `provider_webhooks_failed_total`      | Una entrega final fallida, solo después de agotar los tres intentos.            |
| `provider_webhooks_replayed`  | `provider_webhooks_replayed_total`    | Reenvío manual de una entrega existente; no cuenta IDs inexistentes.            |
| `provider_webhooks_skipped`   | `provider_webhooks_skipped_total`     | Un despacho sin suscripciones, sin intento HTTP.                                |

Los instrumentos Counter no incluyen `_total` en el código; Grafana Cloud
habitualmente añade ese sufijo al convertir las sumas monotónicas.

Histogramas, ambos con unidad `s` y límites sugeridos entre 5 ms y 60 s:

| Instrumento                            | Nombre esperado                                | Alcance                                                                                                                                                          |
| -------------------------------------- | ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `provider_payment_processing_duration` | `provider_payment_processing_duration_seconds` | Desde el inicio del procesamiento asíncrono hasta su finalización, incluyendo las demoras simuladas, DEFERRED y la espera de entregas; se registra en `finally`. |
| `provider_webhook_delivery_duration`   | `provider_webhook_delivery_duration_seconds`   | Desde el inicio de una entrega hasta registrar DELIVERED/FAILED, incluyendo HTTP y backoff. Una muestra por destino y ejecución, no por intento.                 |

## Reintentos, reenvíos y errores

- Fallo + fallo + éxito: **3 intentos, 2 reintentos, 1 entrega exitosa**.
- Tres fallos: **3 intentos, 2 reintentos, 1 entrega fallida**, no tres.
- Cada suscripción representa una entrega separada; dos destinatarios exitosos
  producen dos entregas y no dos resultados de pago.
- `POST /webhooks/entregas/:id/reenviar` cuenta un replay y otra ejecución de
  entrega. Puede generar reintentos si falla; no vuelve a resolver el pago.
- Un ACK HTTP exitoso con `applied: false` de A sigue siendo una entrega exitosa.
- B no recibe WebHooks de confirmación ni verifica autenticidad entrante. No se
  agrega un contador de firmas inválidas. Un 401 devuelto por A se maneja con
  los reintentos/fallo existentes, al igual que otros errores de entrega.
- Sin suscripciones no hay entrega fallida: se cuenta `skipped` una vez por
  despacho, mientras el resultado del pago permanece registrado en B.
- Los errores síncronos de instrumentos se absorben y emiten un aviso genérico
  una sola vez por instancia, sin detalles sensibles. Los errores de exportación
  asíncrona los administra el SDK existente.

No se cambiaron las reglas de paridad, el umbral DEFERRED, el HMAC sobre los
bytes originales, los timeouts, el número de intentos ni el contenido de respuestas.

## Pruebas locales

Desde `servicio-b/`:

```powershell
npm ci
npm run build
npm test -- --runInBand
node test/verify-otlp.cjs
node test/verify-otlp.cjs --business
npm run test:e2e -- --runInBand
```

La prueba OTLP arranca la aplicación compilada con el preload real y verifica
`GET /` (200), trazas HTTP/NestJS y métricas HTTP. En modo `--business` registra
eventos sintéticos de los diez contadores y ambos histogramas y comprueba los
valores recibidos. No representa un pago real ni realiza entregas a merchants.

El proceso hijo no lee `.env`, elimina la configuración OTLP heredada y desactiva
la suscripción por defecto. Exporta solo a `127.0.0.1`, sin credenciales reales.
Usa HTTP/JSON para inspeccionar el payload: **no comprueba HTTP/protobuf de
Railway ni la recepción en Grafana Cloud**. Solo el preload inicia el SDK.

### Resultados verificados

- Compilación: correcta.
- Pruebas unitarias: **40 aprobadas en 5 suites**.
- ESLint de archivos TypeScript afectados: sin errores.
- OTLP local automático y personalizado: correcto; diez contadores monotónicos
  y dos histogramas en segundos recibidos, junto con la instrumentación automática.
- E2E de Jest: no ejecutó casos por carga ESM de `@nestjs/axios`, problema presente
  antes de las métricas. No se cambiaron dependencias/configuración de Jest para
  ocultarlo. El proceso Node aislado sí comprobó el arranque real.
- La instalación anterior reportó 26 vulnerabilidades npm (21 moderadas, 3 altas,
  2 críticas). No se ejecutó `npm audit fix --force`; la revisión de dependencias
  queda pendiente y no se atribuyen automáticamente todos los avisos a OTel.

## Generar eventos de demostración

Preferir crear pagos FAKE desde **Service A**, con suscripciones/configuración
de la demo existentes: así A crea primero un pago real antes de que B lo confirme.
No inventar IDs y enviar a merchants de producción. En una instancia **aislada**
de B sin suscripciones, se puede usar:

```powershell
$base = 'http://localhost:3001'
$id = [guid]::NewGuid().ToString()
Invoke-RestMethod -Method Post -Uri "$base/payments" -ContentType 'application/json' `
  -Body (@{paymentId=$id;amount=2} | ConvertTo-Json -Compress)
```

- Monto `2`: APPROVED; `3`: REJECTED con las reglas actuales.
- Monto `50000`: DEFERRED y después APPROVED con el umbral por defecto.
- Sin suscripciones: aumenta `skipped`; no hay intentos/entregas.
- Para comprobar HTTP exitoso/fallido usar un receptor local de pruebas. Los
  escenarios de 401, fallos de red, reintentos y reenvíos están cubiertos con mocks.
- Consultar `GET /payments` y `GET /webhooks/entregas`. Un replay debe hacerse
  solo sobre una entrega propia del entorno de pruebas.

## Grafana Cloud y consultas

Después de configurar/deployar B y generar eventos, esperar al menos dos ciclos
de exportación (intervalo por defecto 60 s) y la ingestión. Abrir **Explore**,
seleccionar la fuente **Prometheus/métricas**, no Tempo/Loki, y buscar:

```promql
{__name__=~"provider_payments_.*|provider_webhooks_.*|provider_payment_processing_.*|provider_webhook_delivery_.*"}
```

Los nombres de esta guía son esperados según la traducción habitual, no observados
en producción. Inspeccionar los nombres y las etiquetas reales antes de consultar.
El filtro de servicio puede ser `service_name`, `job` u otra representación de
`service.name`; usar la que realmente esté presente. El prefijo `provider_` evita
mezclar estas métricas con las confirmaciones del merchant A.

```promql
sum(increase(provider_payments_received_total[1h]))
sum(increase(provider_payments_approved_total[1h]))
sum(increase(provider_payments_rejected_total[1h]))
sum(increase(provider_payments_deferred_total[1h]))
sum(increase(provider_webhooks_attempts_total[1h]))
sum(increase(provider_webhooks_retries_total[1h]))
sum(increase(provider_webhooks_delivered_total[1h]))
sum(increase(provider_webhooks_failed_total[1h]))
sum(increase(provider_webhooks_replayed_total[1h]))
sum(increase(provider_webhooks_skipped_total[1h]))
```

Para valores actuales (no históricos) usar, por ejemplo:

```promql
sum by (provider) (provider_payments_received_total)
```

`increase()` requiere muestras y puede no reflejar eventos anteriores a la
primera exportación; comprobar primero los contadores directos y generar eventos
adicionales. Las series normalmente aparecen al registrar su primer evento.
`increase()` extrapola, por lo que puede mostrar decimales.

P95 para histogramas clásicos, conservando el bucket `le`:

```promql
histogram_quantile(
  0.95,
  sum by (le) (rate(provider_payment_processing_duration_seconds_bucket[5m]))
)
```

```promql
histogram_quantile(
  0.95,
  sum by (le, result) (rate(provider_webhook_delivery_duration_seconds_bucket[5m]))
)
```

Si Grafana entrega histogramas nativos, usar el nombre observado sin `_bucket`
y agregar por `result` en vez de `le, result` para el histograma de entrega.

Dashboard posterior: **MONITOREO DEL PROVEEDOR — SERVICE B**, con Stat de pagos
recibidos/aprobados/rechazados/diferidos, entregas exitosas/fallidas, reintentos,
replays y eventos sin suscripciones. Time series de resultados de pago, intentos
vs entregas, reintentos, fallos y P95 de procesamiento/entrega. En dashboards usar
`[$__range]` para totales del período y `[$__rate_interval]` para tasas.
No se creó un dashboard programáticamente.

## Archivos

- `metrics.module.ts`: servicio singleton compartido por los módulos de pagos/WebHooks.
- `provider-metrics.service.ts`: diez contadores, dos histogramas y aislamiento de errores.
- `provider-metrics.service.spec.ts`: instrumentos, atributos, duraciones y fallos de observabilidad.
- `../payments/payments.service.ts`: recepción después de guardar, resultados después de actualizar
  el estado y duración del trabajo asíncrono.
- `../payments/payments.service.spec.ts`: validación, paridad, DEFERRED, operaciones repetidas y errores de instrumentos.
- `../webhooks/webhooks.service.ts`: intentos, retries, replay, ausencia de destinatarios y entregas finales.
- `../webhooks/webhooks.service.spec.ts`: HMAC preservado, éxito/fallo, reintentos, múltiples destinos y replay.
- Ambos módulos importan `MetricsModule`; no se cambia `main.ts` ni el flujo de arranque.
- `../../test/verify-otlp.cjs`: arranque real y receptor OTLP local aislado.
- `../../.env.example`: nombres/plantillas de variables; sin valores privados reales.

## Limitaciones

- Contadores de eventos desde el inicio de instrumentación, no auditoría durable.
  Los arrays de B retienen como máximo 100 registros y se pierden al reiniciar;
  los contadores no reconstruyen el histórico.
- Se conserva la conducta actual de POST repetidos con el mismo `paymentId`:
  B los acepta como operaciones independientes. No hay deduplicación de creación.
  Los replays de entregas sí se separan de las resoluciones de pagos.
- Un resultado favorable en B no demuestra confirmación ni cobro real en A.
- Best-effort: fallos del proceso/exportación pueden perder eventos.
- No se modificaron A, el frontend, PostgreSQL, HMAC ni infraestructura.
- La recepción en Grafana Cloud y el despliegue de estas métricas están pendientes.
