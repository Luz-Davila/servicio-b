import { Logger } from '@nestjs/common';
import { metrics as otelMetrics } from '@opentelemetry/api';
import type { Meter } from '@opentelemetry/api';
import { ProviderMetricsService } from '../observability/provider-metrics.service';
import { PAYMENT_UPDATED_EVENT } from '../suscripciones/suscripciones.service';
import { WebhooksService } from '../webhooks/webhooks.service';
import { CreatePaymentDto } from './dto/create-payment.dto';
import { PaymentsService } from './payments.service';

jest.mock('@nestjs/axios', () => ({ HttpService: class HttpService {} }));
jest.mock('node:perf_hooks', () => ({
  performance: { now: () => Date.now() },
}));

describe('PaymentsService: métricas del proveedor', () => {
  let dispatch: jest.Mock;
  let metrics: {
    paymentReceived: jest.Mock;
    paymentResult: jest.Mock;
    recordPaymentDuration: jest.Mock;
  };
  let service: PaymentsService;
  let oldDelay: string | undefined;
  let oldThreshold: string | undefined;

  beforeEach(() => {
    oldDelay = process.env.PROCESSING_DELAY_MS;
    oldThreshold = process.env.DEFERRED_THRESHOLD;
    process.env.PROCESSING_DELAY_MS = '10';
    process.env.DEFERRED_THRESHOLD = '100';
    jest.useFakeTimers();
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    dispatch = jest.fn().mockResolvedValue(undefined);
    metrics = {
      paymentReceived: jest.fn(),
      paymentResult: jest.fn(),
      recordPaymentDuration: jest.fn(),
    };
    service = new PaymentsService(
      { dispatch } as unknown as WebhooksService,
      metrics as unknown as ProviderMetricsService,
    );
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
    if (oldDelay === undefined) delete process.env.PROCESSING_DELAY_MS;
    else process.env.PROCESSING_DELAY_MS = oldDelay;
    if (oldThreshold === undefined) delete process.env.DEFERRED_THRESHOLD;
    else process.env.DEFERRED_THRESHOLD = oldThreshold;
  });

  it.each([
    {},
    { paymentId: '', amount: 2 },
    { paymentId: 123, amount: 2 },
    { paymentId: 'test', amount: 0 },
    { paymentId: 'test', amount: -1 },
    { paymentId: 'test', amount: NaN },
    { paymentId: 'test', amount: Infinity },
    { paymentId: 'test', amount: '2' },
  ])('no cuenta ni procesa entradas inválidas: %j', (input) => {
    expect(() => service.create(input as CreatePaymentDto)).toThrow();
    expect(service.findAll()).toEqual([]);
    expect(metrics.paymentReceived).not.toHaveBeenCalled();
    expect(metrics.paymentResult).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('cuenta recepción únicamente después de almacenar la operación', async () => {
    metrics.paymentReceived.mockImplementation(() => {
      expect(service.findAll()).toHaveLength(1);
      expect(service.findAll()[0].status).toBe('PROCESSING');
    });
    const response = service.create({ paymentId: 'merchant-test', amount: 2 });
    expect(response.status).toBe('PROCESSING');
    expect(metrics.paymentReceived).toHaveBeenCalledTimes(1);
    expect(metrics.paymentResult).not.toHaveBeenCalled();
    await jest.runAllTimersAsync();
    expect(metrics.paymentResult).toHaveBeenCalledWith('APPROVED');
  });

  it.each([
    [2, 'APPROVED'],
    [3, 'REJECTED'],
  ] as const)(
    'registra una sola resolución para monto %s y estado %s',
    async (amount, status) => {
      const response = service.create({ paymentId: 'merchant-test', amount });
      await jest.runAllTimersAsync();
      expect(service.findAll()[0].status).toBe(status);
      expect(metrics.paymentResult).toHaveBeenCalledTimes(1);
      expect(metrics.paymentResult).toHaveBeenCalledWith(status);
      expect(dispatch).toHaveBeenCalledWith(PAYMENT_UPDATED_EVENT, {
        paymentId: 'merchant-test',
        externalPaymentId: response.externalPaymentId,
        status,
      });
      expect(metrics.recordPaymentDuration).toHaveBeenCalledTimes(1);
      expect(metrics.recordPaymentDuration).toHaveBeenCalledWith(
        expect.any(Number),
      );
    },
  );

  it.each([
    [100, 'APPROVED'],
    [101, 'REJECTED'],
  ] as const)(
    'el monto %s genera DEFERRED y luego %s sin duplicar recepción',
    async (amount, status) => {
      service.create({ paymentId: 'merchant-test', amount });
      await jest.advanceTimersByTimeAsync(10);
      expect(service.findAll()[0].status).toBe('DEFERRED');
      expect(metrics.paymentResult.mock.calls).toEqual([['DEFERRED']]);
      expect(metrics.recordPaymentDuration).not.toHaveBeenCalled();
      await jest.runAllTimersAsync();
      expect(metrics.paymentResult.mock.calls).toEqual([
        ['DEFERRED'],
        [status],
      ]);
      expect(metrics.paymentReceived).toHaveBeenCalledTimes(1);
      expect(metrics.recordPaymentDuration).toHaveBeenCalledWith(0.02);
      expect(dispatch).toHaveBeenCalledTimes(2);
    },
  );

  it('un resultado del proveedor no depende del éxito de entrega del WebHook', async () => {
    // dispatch() normalmente resuelve también cuando registra FAILED en la entrega.
    dispatch.mockResolvedValue(undefined);
    service.create({ paymentId: 'merchant-test', amount: 2 });
    await jest.runAllTimersAsync();
    expect(metrics.paymentResult).toHaveBeenCalledWith('APPROVED');
    expect(service.findAll()[0].status).toBe('APPROVED');
  });

  it('preserva la aceptación actual de POST repetidos como operaciones independientes', async () => {
    service.create({ paymentId: 'merchant-test', amount: 2 });
    service.create({ paymentId: 'merchant-test', amount: 2 });
    await jest.runAllTimersAsync();
    expect(service.findAll()).toHaveLength(2);
    expect(metrics.paymentReceived).toHaveBeenCalledTimes(2);
    expect(metrics.paymentResult).toHaveBeenCalledTimes(2);
  });

  it('instrumentos fallidos no impiden recibir ni resolver el pago', async () => {
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
    const resilient = new PaymentsService(
      { dispatch } as unknown as WebhooksService,
      new ProviderMetricsService(),
    );
    expect(() =>
      resilient.create({ paymentId: 'merchant-test', amount: 2 }),
    ).not.toThrow();
    await jest.runAllTimersAsync();
    expect(resilient.findAll()[0].status).toBe('APPROVED');
  });
});
