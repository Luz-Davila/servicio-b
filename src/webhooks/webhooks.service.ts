import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { firstValueFrom } from 'rxjs';
import { createHmac, randomUUID } from 'node:crypto';
import {
  Suscripcion,
  SuscripcionesService,
} from '../suscripciones/suscripciones.service';

export interface DeliveryAttempt {
  attempt: number;
  at: string;
  durationMs: number;
  responseStatus: number | null;
  error?: string;
}

export interface WebhookDelivery {
  id: string;
  subscriptionId: number;
  url: string;
  event: string;
  payload: Record<string, unknown>;
  // Exactamente lo que viajó por la red: el cuerpo firmado byte a byte y sus cabeceras.
  request: { method: 'POST'; headers: Record<string, string>; body: string };
  responseBody: unknown;
  result: 'DELIVERED' | 'FAILED';
  attempts: number;
  attemptLog: DeliveryAttempt[];
  responseStatus: number | null;
  error?: string;
  sentAt: string;
  completedAt: string;
  replayOf: string | null;
}

type Target = Pick<Suscripcion, 'id' | 'url' | 'event'>;

const MAX_DELIVERIES = 100;
const RETRY_BASE_MS = 500;

@Injectable()
export class WebhooksService {
  private readonly logger = new Logger(WebhooksService.name);
  private readonly hmacSecret = process.env.HMAC_SECRET ?? 'desarrollo-secret';
  private readonly maxAttempts = 3;
  private readonly deliveries: WebhookDelivery[] = [];

  constructor(
    private readonly httpService: HttpService,
    private readonly suscripcionesService: SuscripcionesService,
  ) {}

  async dispatch(event: string, data: Record<string, unknown>) {
    const subscriptions = this.suscripcionesService.findByEvent(event);
    if (!subscriptions.length) {
      this.logger.warn(
        `No hay suscripciones para ${event}; webhook no enviado`,
      );
      return;
    }

    const payload = { event, ...data };
    const body = JSON.stringify(payload);
    const signature = createHmac('sha256', this.hmacSecret)
      .update(body)
      .digest('hex');

    await Promise.all(
      subscriptions.map((subscription) =>
        this.deliver(subscription, payload, body, signature, null),
      ),
    );
  }

  findAll(): WebhookDelivery[] {
    return [...this.deliveries].reverse();
  }

  // Reenvía los mismos bytes con la misma firma, como haría un proveedor real al reintentar
  // manualmente. La tienda debe tolerarlo: si ya lo procesó, responde 2xx sin aplicar cambios.
  replay(id: string): Promise<WebhookDelivery> {
    const original = this.deliveries.find((d) => d.id === id);
    if (!original) {
      throw new NotFoundException(`No existe la entrega ${id}`);
    }
    this.logger.log(`Reenviando la entrega ${id} a ${original.url}`);
    return this.deliver(
      { id: original.subscriptionId, url: original.url, event: original.event },
      original.payload,
      original.request.body,
      original.request.headers['X-Signature'],
      original.id,
    );
  }

  private async deliver(
    target: Target,
    payload: Record<string, unknown>,
    body: string,
    signature: string,
    replayOf: string | null,
  ): Promise<WebhookDelivery> {
    const headers = {
      'Content-Type': 'application/json',
      'X-Signature': signature,
    };
    const attemptLog: DeliveryAttempt[] = [];
    const sentAt = new Date().toISOString();
    let responseStatus: number | null = null;
    let responseBody: unknown = null;
    let lastError = '';

    for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
      const startedAt = Date.now();
      try {
        const response = await firstValueFrom(
          this.httpService.post(target.url, body, { headers, timeout: 5000 }),
        );
        attemptLog.push({
          attempt,
          at: new Date(startedAt).toISOString(),
          durationMs: Date.now() - startedAt,
          responseStatus: response.status,
        });
        this.logger.log(
          `Webhook ${target.event} (${String(payload.status)}) entregado a ${target.url} en el intento ${attempt}`,
        );
        return this.record({
          target,
          payload,
          request: { method: 'POST', headers, body },
          responseBody: response.data as unknown,
          result: 'DELIVERED',
          attemptLog,
          responseStatus: response.status,
          sentAt,
          replayOf,
        });
      } catch (error) {
        const response = (
          error as { response?: { status?: number; data?: unknown } }
        ).response;
        responseStatus = response?.status ?? null;
        responseBody = response?.data ?? null;
        lastError = error instanceof Error ? error.message : String(error);
        attemptLog.push({
          attempt,
          at: new Date(startedAt).toISOString(),
          durationMs: Date.now() - startedAt,
          responseStatus,
          error: lastError,
        });
        if (attempt < this.maxAttempts) {
          const waitMs = RETRY_BASE_MS * attempt;
          this.logger.warn(
            `Intento ${attempt} a ${target.url} falló (${lastError}), reintentando en ${waitMs}ms...`,
          );
          await new Promise((resolve) => setTimeout(resolve, waitMs));
        }
      }
    }

    this.logger.error(
      `No se pudo entregar el webhook a ${target.url} tras ${this.maxAttempts} intentos`,
    );
    return this.record({
      target,
      payload,
      request: { method: 'POST', headers, body },
      responseBody,
      result: 'FAILED',
      attemptLog,
      responseStatus,
      error: lastError,
      sentAt,
      replayOf,
    });
  }

  private record(entry: {
    target: Target;
    payload: Record<string, unknown>;
    request: WebhookDelivery['request'];
    responseBody: unknown;
    result: WebhookDelivery['result'];
    attemptLog: DeliveryAttempt[];
    responseStatus: number | null;
    error?: string;
    sentAt: string;
    replayOf: string | null;
  }): WebhookDelivery {
    const delivery: WebhookDelivery = {
      id: randomUUID(),
      subscriptionId: entry.target.id,
      url: entry.target.url,
      event: entry.target.event,
      payload: entry.payload,
      request: entry.request,
      responseBody: entry.responseBody,
      result: entry.result,
      attempts: entry.attemptLog.length,
      attemptLog: entry.attemptLog,
      responseStatus: entry.responseStatus,
      error: entry.error,
      sentAt: entry.sentAt,
      completedAt: new Date().toISOString(),
      replayOf: entry.replayOf,
    };
    this.deliveries.push(delivery);
    if (this.deliveries.length > MAX_DELIVERIES) {
      this.deliveries.shift();
    }
    return delivery;
  }
}
