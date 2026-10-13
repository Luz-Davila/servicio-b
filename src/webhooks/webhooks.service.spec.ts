import type { HttpService } from '@nestjs/axios';
import { Logger } from '@nestjs/common';
import { metrics as otelMetrics } from '@opentelemetry/api';
import type { Meter } from '@opentelemetry/api';
import { ProviderMetricsService } from '../observability/provider-metrics.service';
import { createHmac } from 'node:crypto';
import { of, throwError } from 'rxjs';
import {
  PAYMENT_UPDATED_EVENT,
  SuscripcionesService,
} from '../suscripciones/suscripciones.service';
import { WebhooksService } from './webhooks.service';

jest.mock('@nestjs/axios', () => ({ HttpService: class HttpService {} }));
jest.mock('node:perf_hooks', () => ({
  performance: { now: () => Date.now() },
}));

describe('WebhooksService', () => {
  const url = 'http://service-a:3000/webhooks/payments';
  const data = {
    paymentId: 'pay-1',
    externalPaymentId: 'ext-1',
    status: 'APPROVED',
  };
  let post: jest.Mock;
  let suscripciones: SuscripcionesService;
  let service: WebhooksService;
  let metrics: {
    webhookAttempt: jest.Mock;
    webhookRetry: jest.Mock;
    webhookDelivery: jest.Mock;
    webhookReplay: jest.Mock;
    webhookSkipped: jest.Mock;
    recordWebhookDuration: jest.Mock;
    paymentResult: jest.Mock;
  };
  let oldDefaultUrl: string | undefined;
  let oldSecret: string | undefined;

  beforeEach(() => {
    oldDefaultUrl = process.env.DEFAULT_WEBHOOK_URL;
    oldSecret = process.env.HMAC_SECRET;
    process.env.HMAC_SECRET = 'provider-unit-test-secret';
    delete process.env.DEFAULT_WEBHOOK_URL;
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    post = jest.fn();
    suscripciones = new SuscripcionesService();
    metrics = {
      webhookAttempt: jest.fn(),
      webhookRetry: jest.fn(),
      webhookDelivery: jest.fn(),
      webhookReplay: jest.fn(),
      webhookSkipped: jest.fn(),
      recordWebhookDuration: jest.fn(),
      paymentResult: jest.fn(),
    };
    service = new WebhooksService(
      { post } as unknown as HttpService,
      suscripciones,
      metrics as unknown as ProviderMetricsService,
    );
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
    if (oldDefaultUrl === undefined) delete process.env.DEFAULT_WEBHOOK_URL;
    else process.env.DEFAULT_WEBHOOK_URL = oldDefaultUrl;
    if (oldSecret === undefined) delete process.env.HMAC_SECRET;
    else process.env.HMAC_SECRET = oldSecret;
  });

  it('firma el cuerpo exacto y lo envía a cada suscripción del evento', async () => {
    suscripciones.create({ url, event: PAYMENT_UPDATED_EVENT });
    post.mockReturnValue(of({ status: 200 }));

    await service.dispatch(PAYMENT_UPDATED_EVENT, data);

    const body = JSON.stringify({ event: PAYMENT_UPDATED_EVENT, ...data });
    const signature = createHmac('sha256', 'provider-unit-test-secret')
      .update(body)
      .digest('hex');
    expect(post).toHaveBeenCalledWith(url, body, {
      headers: {
        'Content-Type': 'application/json',
        'X-Signature': signature,
      },
      timeout: 5000,
    });
    expect(service.findAll()).toMatchObject([
      { url, result: 'DELIVERED', attempts: 1, responseStatus: 200 },
    ]);
    expect(metrics.webhookAttempt).toHaveBeenCalledTimes(1);
    expect(metrics.webhookRetry).not.toHaveBeenCalled();
    expect(metrics.webhookDelivery).toHaveBeenCalledTimes(1);
    expect(metrics.webhookDelivery).toHaveBeenCalledWith('DELIVERED');
    expect(metrics.recordWebhookDuration).toHaveBeenCalledWith(
      'DELIVERED',
      expect.any(Number),
    );
  });

  it('registra la entrega fallida después de agotar los reintentos', async () => {
    suscripciones.create({ url, event: PAYMENT_UPDATED_EVENT });
    post.mockReturnValue(
      throwError(() =>
        Object.assign(new Error('Unauthorized'), { response: { status: 401 } }),
      ),
    );

    await service.dispatch(PAYMENT_UPDATED_EVENT, data);

    expect(post).toHaveBeenCalledTimes(3);
    const [delivery] = service.findAll();
    expect(delivery).toMatchObject({
      result: 'FAILED',
      attempts: 3,
      responseStatus: 401,
    });
    expect(delivery.attemptLog.map((a) => a.responseStatus)).toEqual([
      401, 401, 401,
    ]);
    expect(metrics.webhookAttempt).toHaveBeenCalledTimes(3);
    expect(metrics.webhookRetry).toHaveBeenCalledTimes(2);
    expect(metrics.webhookDelivery).toHaveBeenCalledTimes(1);
    expect(metrics.webhookDelivery).toHaveBeenCalledWith('FAILED');
    expect(metrics.recordWebhookDuration).toHaveBeenCalledWith(
      'FAILED',
      expect.any(Number),
    );
  });

  it('reenvía exactamente los mismos bytes y la misma firma', async () => {
    suscripciones.create({ url, event: PAYMENT_UPDATED_EVENT });
    post.mockReturnValue(
      of({ status: 200, data: { applied: true, message: 'ok' } }),
    );
    await service.dispatch(PAYMENT_UPDATED_EVENT, data);
    const [original] = service.findAll();

    post.mockReturnValue(
      of({ status: 200, data: { applied: false, message: 'ya procesado' } }),
    );
    const replayed = await service.replay(original.id);

    expect(post).toHaveBeenLastCalledWith(
      url,
      original.request.body,
      expect.objectContaining({ headers: original.request.headers }) as object,
    );
    expect(replayed).toMatchObject({
      replayOf: original.id,
      result: 'DELIVERED',
      responseBody: { applied: false, message: 'ya procesado' },
    });
    expect(service.findAll()[0].id).toBe(replayed.id);
    expect(metrics.webhookReplay).toHaveBeenCalledTimes(1);
    expect(metrics.webhookAttempt).toHaveBeenCalledTimes(2);
    expect(metrics.webhookDelivery).toHaveBeenCalledTimes(2);
    expect(metrics.webhookRetry).not.toHaveBeenCalled();
    expect(metrics.paymentResult).not.toHaveBeenCalled();
  });

  it('no reenvía una entrega que no existe', () => {
    expect(() => service.replay('no-existe')).toThrow('No existe la entrega');
    expect(metrics.webhookReplay).not.toHaveBeenCalled();
    expect(metrics.webhookAttempt).not.toHaveBeenCalled();
  });

  it('no envía nada si nadie está suscrito', async () => {
    await service.dispatch(PAYMENT_UPDATED_EVENT, data);
    expect(post).not.toHaveBeenCalled();
    expect(service.findAll()).toEqual([]);
    expect(metrics.webhookSkipped).toHaveBeenCalledTimes(1);
    expect(metrics.webhookAttempt).not.toHaveBeenCalled();
    expect(metrics.webhookDelivery).not.toHaveBeenCalled();
    expect(metrics.recordWebhookDuration).not.toHaveBeenCalled();
  });

  it('cuenta un intento fallido y uno exitoso como una única entrega final', async () => {
    jest.useFakeTimers();
    suscripciones.create({ url, event: PAYMENT_UPDATED_EVENT });
    post
      .mockReturnValueOnce(throwError(() => new Error('network unavailable')))
      .mockReturnValueOnce(of({ status: 200 }));
    const pending = service.dispatch(PAYMENT_UPDATED_EVENT, data);
    await jest.runAllTimersAsync();
    await pending;
    expect(metrics.webhookAttempt).toHaveBeenCalledTimes(2);
    expect(metrics.webhookRetry).toHaveBeenCalledTimes(1);
    expect(metrics.webhookDelivery.mock.calls).toEqual([['DELIVERED']]);
    expect(metrics.recordWebhookDuration).toHaveBeenCalledWith(
      'DELIVERED',
      0.5,
    );
  });

  it('cuenta por destino y no incluye URLs ni IDs en las llamadas a métricas', async () => {
    suscripciones.create({ url, event: PAYMENT_UPDATED_EVENT });
    suscripciones.create({
      url: 'http://another-merchant.test/webhooks',
      event: PAYMENT_UPDATED_EVENT,
    });
    post.mockReturnValue(of({ status: 200 }));
    await service.dispatch(PAYMENT_UPDATED_EVENT, data);
    expect(metrics.webhookAttempt).toHaveBeenCalledTimes(2);
    expect(metrics.webhookDelivery.mock.calls).toEqual([
      ['DELIVERED'],
      ['DELIVERED'],
    ]);
    expect(metrics.paymentResult).not.toHaveBeenCalled();
  });

  it('un fallo de red agota intentos sin confundirlos con tres entregas fallidas', async () => {
    jest.useFakeTimers();
    suscripciones.create({ url, event: PAYMENT_UPDATED_EVENT });
    post.mockReturnValue(throwError(() => new Error('network unavailable')));
    const pending = service.dispatch(PAYMENT_UPDATED_EVENT, data);
    await jest.runAllTimersAsync();
    await pending;
    expect(metrics.webhookAttempt).toHaveBeenCalledTimes(3);
    expect(metrics.webhookRetry).toHaveBeenCalledTimes(2);
    expect(metrics.webhookDelivery.mock.calls).toEqual([['FAILED']]);
    expect(metrics.recordWebhookDuration).toHaveBeenCalledWith('FAILED', 1.5);
  });

  it('un reenvío fallido cuenta replay y entrega FAILED sin volver a resolver pagos', async () => {
    jest.useFakeTimers();
    suscripciones.create({ url, event: PAYMENT_UPDATED_EVENT });
    post.mockReturnValue(of({ status: 200 }));
    await service.dispatch(PAYMENT_UPDATED_EVENT, data);
    const [original] = service.findAll();
    post.mockReturnValue(throwError(() => new Error('network unavailable')));
    const pending = service.replay(original.id);
    await jest.runAllTimersAsync();
    await pending;
    expect(metrics.webhookReplay).toHaveBeenCalledTimes(1);
    expect(metrics.webhookDelivery.mock.calls).toEqual([
      ['DELIVERED'],
      ['FAILED'],
    ]);
    expect(metrics.paymentResult).not.toHaveBeenCalled();
  });

  it('una excepción del instrumento no impide entregar el WebHook', async () => {
    const brokenMeter = {
      createCounter: () => ({
        add: () => {
          throw new Error('telemetry unavailable');
        },
      }),
      createHistogram: () => ({
        record: () => {
          throw new Error('telemetry unavailable');
        },
      }),
    };
    jest
      .spyOn(otelMetrics, 'getMeter')
      .mockReturnValue(brokenMeter as unknown as Meter);
    const resilient = new WebhooksService(
      { post } as unknown as HttpService,
      suscripciones,
      new ProviderMetricsService(),
    );
    suscripciones.create({ url, event: PAYMENT_UPDATED_EVENT });
    post.mockReturnValue(of({ status: 200 }));
    await expect(
      resilient.dispatch(PAYMENT_UPDATED_EVENT, data),
    ).resolves.toBeUndefined();
    expect(resilient.findAll()[0].result).toBe('DELIVERED');
    expect(post).toHaveBeenCalledTimes(1);
  });
});
