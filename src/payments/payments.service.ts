import { Injectable, Logger } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { firstValueFrom } from 'rxjs';
import { createHmac, randomUUID } from 'node:crypto';
import { CreatePaymentDto } from './dto/create-payment.dto';

export type PaymentResult = 'APPROVED' | 'REJECTED';

@Injectable()
export class PaymentsService {
  private readonly logger = new Logger(PaymentsService.name);
  private readonly hmacSecret = process.env.HMAC_SECRET ?? 'desarrollo-secret';
  private readonly serviceAUrl =
    process.env.SERVICE_A_URL ?? 'http://service-a:3000';
  private readonly maxAttempts = 3;
  private readonly delayMs = 3000;

  constructor(private readonly httpService: HttpService) {}

  async create(createPaymentDto: CreatePaymentDto) {
    const externalPaymentId = randomUUID();
    const { paymentId, amount } = createPaymentDto;

    this.logger.log(
      `Pago recibido: paymentId=${paymentId} amount=${amount} externalPaymentId=${externalPaymentId}`,
    );

    void this.processPayment(paymentId, amount, externalPaymentId);

    return {
      paymentId,
      externalPaymentId,
      status: 'PROCESSING',
    };
  }

  private async processPayment(
    paymentId: string,
    amount: number,
    externalPaymentId: string,
  ) {
    this.logger.log(
      `Procesando pago ${externalPaymentId} (simulando demora de ${this.delayMs}ms)...`,
    );

    await new Promise((resolve) => setTimeout(resolve, this.delayMs));

    const result: PaymentResult = amount % 2 === 0 ? 'APPROVED' : 'REJECTED';
    this.logger.log(`Pago ${externalPaymentId} resultado: ${result}`);

    await this.sendWebhook(paymentId, result);
  }

  private async sendWebhook(paymentId: string, status: PaymentResult) {
    const body = JSON.stringify({ paymentId, status });
    const signature = createHmac('sha256', this.hmacSecret)
      .update(body)
      .digest('hex');
    const url = `${this.serviceAUrl.replace(/\/$/, '')}/webhooks/fake`;

    for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
      try {
        await firstValueFrom(
          this.httpService.post(url, body, {
            headers: {
              'Content-Type': 'application/json',
              'X-Signature': signature,
            },
            timeout: 5000,
          }),
        );
        this.logger.log(
          `Webhook entregado a Service A (intento ${attempt}): ${status}`,
        );
        return;
      } catch (error) {
        if (attempt === this.maxAttempts) {
          this.logger.error(
            `No se pudo entregar el webhook a ${url} tras ${this.maxAttempts} intentos`,
            error,
          );
          return;
        }

        this.logger.warn(
          `Intento ${attempt} falló, reintentando en ${250 * attempt}ms...`,
        );
        await new Promise((resolve) => setTimeout(resolve, 250 * attempt));
      }
    }
  }
}
