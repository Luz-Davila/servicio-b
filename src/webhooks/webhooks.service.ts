import { Injectable, Logger } from '@nestjs/common';
import { createHmac, timingSafeEqual } from 'node:crypto';

export interface WebhookEvent {
  id: string;
  producto: string;
  monto: number;
  fecha: string;
  receivedAt: string;
}

@Injectable()
export class WebhooksService {
  private readonly logger = new Logger(WebhooksService.name);
  private readonly hmacSecret = process.env.HMAC_SECRET ?? 'desarrollo-secret';
  private readonly receivedEvents: WebhookEvent[] = [];

  verifyAndProcess(rawBody: Buffer, signature: string | undefined): { valid: boolean; event?: WebhookEvent; error?: string } {
    if (!signature) {
      return { valid: false, error: 'Falta header X-Signature' };
    }

    const expectedSignature = createHmac('sha256', this.hmacSecret)
      .update(rawBody)
      .digest('hex');

    const expected = Buffer.from(expectedSignature, 'utf8');
    const actual = Buffer.from(signature, 'utf8');

    if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
      this.logger.warn('Firma HMAC inválida - webhook rechazado');
      return { valid: false, error: 'Firma inválida' };
    }

    const payload = JSON.parse(rawBody.toString('utf8'));
    const event: WebhookEvent = {
      ...payload,
      receivedAt: new Date().toISOString(),
    };

    this.receivedEvents.push(event);
    this.logger.log(`Webhook recibido y verificado: ${JSON.stringify(event)}`);

    return { valid: true, event };
  }

  findAll(): WebhookEvent[] {
    return this.receivedEvents;
  }
}
