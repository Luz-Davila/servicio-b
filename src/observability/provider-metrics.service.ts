import { Injectable, Logger } from '@nestjs/common';
import { metrics, ValueType } from '@opentelemetry/api';
import type { Counter, Histogram } from '@opentelemetry/api';

type PaymentResult = 'APPROVED' | 'REJECTED' | 'DEFERRED';
type DeliveryResult = 'DELIVERED' | 'FAILED';

const COUNTERS = {
  provider_payments_received:
    'Operaciones de pago aceptadas y guardadas en memoria',
  provider_payments_approved:
    'Resultados de pago APPROVED registrados por el proveedor',
  provider_payments_rejected:
    'Resultados de pago REJECTED registrados por el proveedor',
  provider_payments_deferred:
    'Resultados intermedios DEFERRED registrados por el proveedor',
  provider_webhooks_attempts: 'Intentos HTTP de entrega de WebHooks',
  provider_webhooks_retries:
    'Intentos adicionales dentro de una entrega de WebHook',
  provider_webhooks_delivered:
    'Entregas de WebHook que terminaron con éxito HTTP',
  provider_webhooks_failed:
    'Entregas de WebHook fallidas tras agotar los intentos',
  provider_webhooks_replayed:
    'Reenvíos manuales aceptados de entregas existentes',
  provider_webhooks_skipped:
    'Eventos sin suscripciones; no se intentó entregar un WebHook',
} as const;

@Injectable()
export class ProviderMetricsService {
  private readonly logger = new Logger(ProviderMetricsService.name);
  private warned = false;
  private readonly counters: Partial<Record<keyof typeof COUNTERS, Counter>> =
    {};
  private readonly paymentDuration?: Histogram;
  private readonly webhookDuration?: Histogram;

  constructor() {
    // El preload de auto-instrumentations-node registra el proveedor global.
    // Aquí no se crea ni reemplaza un SDK, MeterProvider o exportador.
    const meter = this.safely(() =>
      metrics.getMeter('servicio-b.payment-provider', '1.0.0'),
    );
    for (const name of Object.keys(COUNTERS) as Array<keyof typeof COUNTERS>) {
      this.counters[name] = this.safely(() =>
        meter?.createCounter(name, {
          description: COUNTERS[name],
          valueType: ValueType.INT,
        }),
      );
    }
    const histogram = (name: string, description: string) =>
      this.safely(() =>
        meter?.createHistogram(name, {
          description,
          unit: 's',
          advice: {
            explicitBucketBoundaries: [
              0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60,
            ],
          },
        }),
      );
    this.paymentDuration = histogram(
      'provider_payment_processing_duration',
      'Procesamiento completo del pago, incluida la entrega de sus WebHooks',
    );
    this.webhookDuration = histogram(
      'provider_webhook_delivery_duration',
      'Duración de una entrega, incluidos intentos y esperas de reintento',
    );
  }

  paymentReceived(): void {
    this.increment('provider_payments_received');
  }

  paymentResult(status: PaymentResult): void {
    const names: Record<PaymentResult, keyof typeof COUNTERS> = {
      APPROVED: 'provider_payments_approved',
      REJECTED: 'provider_payments_rejected',
      DEFERRED: 'provider_payments_deferred',
    };
    this.increment(names[status]);
  }

  webhookAttempt(): void {
    this.increment('provider_webhooks_attempts');
  }
  webhookRetry(): void {
    this.increment('provider_webhooks_retries');
  }
  webhookReplay(): void {
    this.increment('provider_webhooks_replayed');
  }
  webhookSkipped(): void {
    this.increment('provider_webhooks_skipped');
  }

  webhookDelivery(result: DeliveryResult): void {
    this.increment(
      result === 'DELIVERED'
        ? 'provider_webhooks_delivered'
        : 'provider_webhooks_failed',
    );
  }

  recordPaymentDuration(seconds: number): void {
    this.safely(() =>
      this.paymentDuration?.record(seconds, { provider: 'FAKE' }),
    );
  }

  recordWebhookDuration(result: DeliveryResult, seconds: number): void {
    this.safely(() =>
      this.webhookDuration?.record(seconds, { provider: 'FAKE', result }),
    );
  }

  private increment(name: keyof typeof COUNTERS): void {
    this.safely(() => this.counters[name]?.add(1, { provider: 'FAKE' }));
  }

  private safely<T>(operation: () => T): T | undefined {
    try {
      return operation();
    } catch {
      if (!this.warned) {
        this.warned = true;
        // No imprimir excepciones del SDK que puedan incluir configuración privada.
        this.logger.warn(
          'No se pudo registrar una métrica; el proveedor continúa',
        );
      }
      return undefined;
    }
  }
}
