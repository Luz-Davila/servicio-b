import { Logger } from '@nestjs/common';
import { metrics } from '@opentelemetry/api';
import type { Meter } from '@opentelemetry/api';
import { ProviderMetricsService } from './provider-metrics.service';

describe('ProviderMetricsService', () => {
  let counters: Record<string, jest.Mock>;
  let histograms: Record<string, jest.Mock>;
  let meter: { createCounter: jest.Mock; createHistogram: jest.Mock };
  let getMeter: jest.SpyInstance;
  let warn: jest.SpyInstance;
  let service: ProviderMetricsService;

  beforeEach(() => {
    counters = {};
    histograms = {};
    meter = {
      createCounter: jest.fn((name: string) => {
        counters[name] = jest.fn();
        return { add: counters[name] };
      }),
      createHistogram: jest.fn((name: string) => {
        histograms[name] = jest.fn();
        return { record: histograms[name] };
      }),
    };
    getMeter = jest
      .spyOn(metrics, 'getMeter')
      .mockReturnValue(meter as unknown as Meter);
    warn = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
    service = new ProviderMetricsService();
  });

  afterEach(() => jest.restoreAllMocks());

  it('reutiliza el meter global y crea diez contadores sin sufijo _total', () => {
    expect(getMeter).toHaveBeenCalledWith(
      'servicio-b.payment-provider',
      '1.0.0',
    );
    expect(Object.keys(counters)).toEqual([
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
    ]);
    for (const call of meter.createCounter.mock.calls as [
      string,
      { unit?: string },
    ][]) {
      expect(call[0]).not.toMatch(/_total$/);
      expect(call[1].unit).toBeUndefined();
    }
    expect(meter.createHistogram).toHaveBeenCalledTimes(2);
    for (const call of meter.createHistogram.mock.calls as [
      string,
      { unit: string; advice: { explicitBucketBoundaries: number[] } },
    ][]) {
      expect(call[1].unit).toBe('s');
      expect(call[1].advice.explicitBucketBoundaries).toContain(0.005);
      expect(call[1].advice.explicitBucketBoundaries).toContain(60);
    }
  });

  it('registra todos los contadores con provider=FAKE y sin identificadores', () => {
    service.paymentReceived();
    service.paymentResult('APPROVED');
    service.paymentResult('REJECTED');
    service.paymentResult('DEFERRED');
    service.webhookAttempt();
    service.webhookRetry();
    service.webhookReplay();
    service.webhookSkipped();
    service.webhookDelivery('DELIVERED');
    service.webhookDelivery('FAILED');
    for (const add of Object.values(counters)) {
      expect(add).toHaveBeenCalledTimes(1);
      expect(add).toHaveBeenCalledWith(1, { provider: 'FAKE' });
    }
  });

  it('registra duraciones en segundos con resultado de entrega de cardinalidad limitada', () => {
    service.recordPaymentDuration(3);
    service.recordWebhookDuration('DELIVERED', 0.125);
    service.recordWebhookDuration('FAILED', 16.5);
    expect(
      histograms.provider_payment_processing_duration,
    ).toHaveBeenCalledWith(3, { provider: 'FAKE' });
    expect(
      histograms.provider_webhook_delivery_duration,
    ).toHaveBeenNthCalledWith(1, 0.125, {
      provider: 'FAKE',
      result: 'DELIVERED',
    });
    expect(
      histograms.provider_webhook_delivery_duration,
    ).toHaveBeenNthCalledWith(2, 16.5, { provider: 'FAKE', result: 'FAILED' });
  });

  it('no falla si el meter global arroja un error', () => {
    getMeter.mockImplementation(() => {
      throw new Error('private configuration');
    });
    const unavailable = new ProviderMetricsService();
    expect(() => {
      unavailable.paymentReceived();
      unavailable.paymentResult('APPROVED');
      unavailable.webhookAttempt();
      unavailable.recordPaymentDuration(1);
      unavailable.recordWebhookDuration('FAILED', 1);
    }).not.toThrow();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).not.toHaveBeenCalledWith(expect.stringContaining('private'));
  });

  it('no falla si crear instrumentos arroja errores', () => {
    meter.createCounter.mockImplementation(() => {
      throw new Error('counter unavailable');
    });
    meter.createHistogram.mockImplementation(() => {
      throw new Error('histogram unavailable');
    });
    const unavailable = new ProviderMetricsService();
    expect(() => unavailable.paymentReceived()).not.toThrow();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('absorbe fallos de registro y emite solo un aviso sin información sensible', () => {
    for (const method of [
      ...Object.values(counters),
      ...Object.values(histograms),
    ]) {
      method.mockImplementation(() => {
        throw new Error('private credential');
      });
    }
    expect(() => {
      service.paymentReceived();
      service.paymentResult('REJECTED');
      service.webhookAttempt();
      service.webhookRetry();
      service.webhookReplay();
      service.webhookSkipped();
      service.webhookDelivery('DELIVERED');
      service.recordPaymentDuration(1);
      service.recordWebhookDuration('FAILED', 1);
    }).not.toThrow();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).not.toHaveBeenCalledWith(expect.stringContaining('private'));
  });
});
