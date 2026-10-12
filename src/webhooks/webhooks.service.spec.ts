import type { HttpService } from '@nestjs/axios';
import { createHmac } from 'node:crypto';
import { of, throwError } from 'rxjs';
import {
  PAYMENT_UPDATED_EVENT,
  SuscripcionesService,
} from '../suscripciones/suscripciones.service';
import { WebhooksService } from './webhooks.service';

jest.mock('@nestjs/axios', () => ({ HttpService: class HttpService {} }));

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

  beforeEach(() => {
    delete process.env.DEFAULT_WEBHOOK_URL;
    post = jest.fn();
    suscripciones = new SuscripcionesService();
    service = new WebhooksService(
      { post } as unknown as HttpService,
      suscripciones,
    );
  });

  it('firma el cuerpo exacto y lo envía a cada suscripción del evento', async () => {
    suscripciones.create({ url, event: PAYMENT_UPDATED_EVENT });
    post.mockReturnValue(of({ status: 200 }));

    await service.dispatch(PAYMENT_UPDATED_EVENT, data);

    const body = JSON.stringify({ event: PAYMENT_UPDATED_EVENT, ...data });
    const signature = createHmac('sha256', 'desarrollo-secret')
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
  });

  it('no reenvía una entrega que no existe', () => {
    expect(() => service.replay('no-existe')).toThrow('No existe la entrega');
  });

  it('no envía nada si nadie está suscrito', async () => {
    await service.dispatch(PAYMENT_UPDATED_EVENT, data);
    expect(post).not.toHaveBeenCalled();
    expect(service.findAll()).toEqual([]);
  });
});
