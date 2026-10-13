// Receptor OTLP aislado: no lee .env ni contacta merchants/Grafana.
// Primero verifica instrumentación automática; --business añade las métricas de negocio.
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { createServer } = require('node:http');
const { resolve } = require('node:path');

async function main() {
  const business = process.argv.includes('--business');
  const requests = [];
  const receiver = createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      try {
        assert.ok(['/v1/traces', '/v1/metrics'].includes(req.url));
        requests.push({
          path: req.url,
          body: JSON.parse(Buffer.concat(chunks).toString('utf8')),
        });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{}');
      } catch {
        res.writeHead(400);
        res.end();
      }
    });
  });
  await new Promise((done) => receiver.listen(0, '127.0.0.1', done));
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) => !/^OTEL_|^NODE_OPTIONS$/i.test(key),
    ),
  );
  Object.assign(env, {
    DEFAULT_WEBHOOK_URL: '',
    HMAC_SECRET: 'local-otel-test-not-a-production-secret',
    OTEL_SERVICE_NAME: 'servicio-b-otlp-local-check',
    OTEL_TRACES_EXPORTER: 'otlp',
    OTEL_METRICS_EXPORTER: 'otlp',
    OTEL_LOGS_EXPORTER: 'none',
    OTEL_EXPORTER_OTLP_PROTOCOL: 'http/json',
    OTEL_EXPORTER_OTLP_ENDPOINT: `http://127.0.0.1:${receiver.address().port}`,
    OTEL_METRIC_EXPORT_INTERVAL: '1000',
    OTEL_METRIC_EXPORT_TIMEOUT: '1000',
    OTEL_BSP_SCHEDULE_DELAY: '1000',
    OTEL_LOG_LEVEL: 'none',
  });
  const code = `
    console.log('SMOKE_PHASE:loading_application');
    const { NestFactory } = require('@nestjs/core');
    const { AppModule } = require('./dist/app.module');
    async function run() {
      const app = await NestFactory.create(AppModule, { logger: false });
      console.log('SMOKE_PHASE:application_created');
      await app.listen(0, '127.0.0.1');
      console.log('SMOKE_PHASE:listening');
      const response = await fetch('http://127.0.0.1:' + app.getHttpServer().address().port + '/', { signal: AbortSignal.timeout(10000) });
      if (response.status !== 200 || await response.text() !== 'Hello World!') throw new Error('HTTP smoke failed');
      console.log('SMOKE_PHASE:http_checked');
      if (${business}) {
        const { ProviderMetricsService } = require('./dist/observability/provider-metrics.service');
        const metrics = app.get(ProviderMetricsService);
        metrics.paymentReceived();
        for (const status of ['APPROVED', 'REJECTED', 'DEFERRED']) metrics.paymentResult(status);
        metrics.recordPaymentDuration(0.125);
        metrics.webhookAttempt();
        metrics.webhookRetry();
        metrics.webhookDelivery('DELIVERED');
        metrics.webhookDelivery('FAILED');
        metrics.webhookReplay();
        metrics.webhookSkipped();
        metrics.recordWebhookDuration('DELIVERED', 0.25);
      }
      await new Promise(resolve => setTimeout(resolve, 4500));
      console.log('SMOKE_PHASE:closing');
      await app.close();
    }
    run().then(() => process.exit(0)).catch(() => {
      console.error('Isolated application smoke failed'); process.exit(1);
    });
  `;
  try {
    const child = spawn(
      process.execPath,
      [
        '--require',
        '@opentelemetry/auto-instrumentations-node/register',
        '-e',
        code,
      ],
      { cwd: resolve(__dirname, '..'), env, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let phase = 'preloading_instrumentation';
    child.stdout.on('data', (chunk) => {
      const match = /SMOKE_PHASE:(\w+)/.exec(chunk.toString());
      if (match) phase = match[1];
    });
    let errors = '';
    child.stderr.on('data', (chunk) => {
      errors += chunk.toString();
    });
    const timeout = setTimeout(() => child.kill(), 60000);
    try {
      const exitCode = await new Promise((done, reject) => {
        child.once('error', reject);
        child.once('exit', done);
      });
      assert.equal(
        exitCode,
        0,
        errors || `Isolated application timed out in phase: ${phase}`,
      );
    } finally {
      clearTimeout(timeout);
    }
    const metrics = new Map();
    const spans = [];
    for (const request of requests) {
      for (const resource of request.body.resourceMetrics ?? []) {
        assert.ok(
          resource.resource.attributes.some(
            (attribute) =>
              attribute.key === 'service.name' &&
              attribute.value.stringValue === 'servicio-b-otlp-local-check',
          ),
        );
        for (const scope of resource.scopeMetrics ?? []) {
          for (const metric of scope.metrics ?? [])
            metrics.set(metric.name, metric);
        }
      }
      for (const resource of request.body.resourceSpans ?? []) {
        for (const scope of resource.scopeSpans ?? []) {
          spans.push(
            ...(scope.spans ?? []).map((span) => ({
              ...span,
              scope: scope.scope.name,
            })),
          );
        }
      }
    }
    assert.ok(
      spans.some(
        (span) =>
          span.scope === '@opentelemetry/instrumentation-http' &&
          span.kind === 2,
      ),
      'No automatic HTTP server span exported',
    );
    assert.ok(
      spans.some(
        (span) => span.scope === '@opentelemetry/instrumentation-nestjs-core',
      ),
      'No automatic NestJS span exported',
    );
    assert.ok(
      [...metrics.keys()].some((name) => /^http\.server\./.test(name)),
      'No automatic HTTP metric exported',
    );
    console.log(
      'AUTO OTLP local OK: aplicación real, HTTP 200, trazas HTTP/NestJS y métricas HTTP.',
    );
    if (business) {
      for (const name of [
        'provider_payments_received',
        'provider_payments_approved',
        'provider_payments_rejected',
        'provider_payments_deferred',
        'provider_webhooks_attempts',
        'provider_webhooks_retries',
        'provider_webhooks_delivered',
        'provider_webhooks_failed',
        'provider_webhooks_replayed',
        'provider_webhooks_skipped',
      ]) {
        const metric = metrics.get(name);
        assert.ok(metric?.sum?.isMonotonic, `Missing counter ${name}`);
        assert.equal(metric.sum.dataPoints.length, 1);
        const point = metric.sum.dataPoints[0];
        assert.equal(Number(point.asInt ?? point.asDouble), 1);
        assert.deepEqual(point.attributes, [
          { key: 'provider', value: { stringValue: 'FAKE' } },
        ]);
      }
      for (const [name, sum] of [
        ['provider_payment_processing_duration', 0.125],
        ['provider_webhook_delivery_duration', 0.25],
      ]) {
        const metric = metrics.get(name);
        assert.equal(metric?.unit, 's');
        assert.equal(Number(metric.histogram.dataPoints[0].count), 1);
        assert.equal(metric.histogram.dataPoints[0].sum, sum);
      }
      console.log(
        'BUSINESS OTLP local OK: diez contadores y dos histogramas reutilizando el mismo proveedor.',
      );
    }
    console.log(
      'No verifica Grafana Cloud ni el transporte http/protobuf de producción.',
    );
  } finally {
    await new Promise((done) => receiver.close(done));
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
