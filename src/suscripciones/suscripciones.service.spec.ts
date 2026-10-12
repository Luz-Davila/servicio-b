import {
  PAYMENT_UPDATED_EVENT,
  SuscripcionesService,
} from './suscripciones.service';

describe('SuscripcionesService', () => {
  const url = 'http://service-a:3000/webhooks/payments';

  afterEach(() => {
    delete process.env.DEFAULT_WEBHOOK_URL;
  });

  it('registra la URL de la tienda por defecto desde DEFAULT_WEBHOOK_URL', () => {
    process.env.DEFAULT_WEBHOOK_URL = url;
    const service = new SuscripcionesService();
    expect(service.findByEvent(PAYMENT_UPDATED_EVENT)).toMatchObject([
      { id: 1, url },
    ]);
  });

  it('no duplica la misma URL para el mismo evento', () => {
    const service = new SuscripcionesService();
    const first = service.create({ url, event: PAYMENT_UPDATED_EVENT });
    const second = service.create({ url, event: PAYMENT_UPDATED_EVENT });
    expect(second).toBe(first);
    expect(service.findAll()).toHaveLength(1);
  });

  it.each([
    { url: 'no-es-url' },
    { url: 'ftp://service-a/webhooks' },
    { url, event: 'pedido.creado' },
    {},
  ])('rechaza datos inválidos (%o)', (input) => {
    const service = new SuscripcionesService();
    expect(() => service.create(input)).toThrow();
  });

  it('elimina una suscripción y responde 404 si no existe', () => {
    const service = new SuscripcionesService();
    const { id } = service.create({ url });
    expect(service.remove(id)).toMatchObject({ id });
    expect(() => service.remove(id)).toThrow('Suscripción no encontrada');
  });
});
