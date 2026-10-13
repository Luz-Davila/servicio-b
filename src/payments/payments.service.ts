import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { ProviderMetricsService } from '../observability/provider-metrics.service';
import { PAYMENT_UPDATED_EVENT } from '../suscripciones/suscripciones.service';
import { WebhooksService } from '../webhooks/webhooks.service';
import { CreatePaymentDto } from './dto/create-payment.dto';

export type PaymentResult = 'APPROVED' | 'REJECTED' | 'DEFERRED';

export interface ProviderPayment {
  paymentId: string;
  externalPaymentId: string;
  amount: number;
  status: 'PROCESSING' | PaymentResult;
  receivedAt: string;
  updatedAt: string;
}

const MAX_PAYMENTS = 100;

@Injectable()
export class PaymentsService {
  private readonly logger = new Logger(PaymentsService.name);
  private readonly delayMs = Number(process.env.PROCESSING_DELAY_MS ?? 3000);
  private readonly deferredThreshold = Number(
    process.env.DEFERRED_THRESHOLD ?? 50000,
  );
  private readonly payments: ProviderPayment[] = [];

  constructor(
    private readonly webhooksService: WebhooksService,
    private readonly metrics: ProviderMetricsService,
  ) {}

  create(createPaymentDto: CreatePaymentDto) {
    const { paymentId, amount } = createPaymentDto ?? {};
    if (typeof paymentId !== 'string' || !paymentId) {
      throw new BadRequestException('paymentId es obligatorio');
    }
    if (typeof amount !== 'number' || !Number.isFinite(amount) || amount <= 0) {
      throw new BadRequestException('amount debe ser un número mayor a 0');
    }

    const externalPaymentId = randomUUID();
    this.logger.log(
      `Pago recibido: paymentId=${paymentId} amount=${amount} externalPaymentId=${externalPaymentId}`,
    );

    const now = new Date().toISOString();
    const payment: ProviderPayment = {
      paymentId,
      externalPaymentId,
      amount,
      status: 'PROCESSING',
      receivedAt: now,
      updatedAt: now,
    };
    this.payments.push(payment);
    if (this.payments.length > MAX_PAYMENTS) {
      this.payments.shift();
    }
    this.metrics.paymentReceived();

    void this.processPayment(payment);

    return {
      paymentId,
      externalPaymentId,
      status: payment.status,
    };
  }

  // Lo que el proveedor sabe de cada cobro, del más reciente al más antiguo.
  findAll(): ProviderPayment[] {
    return [...this.payments].reverse();
  }

  // Reglas de la simulación: montos >= DEFERRED_THRESHOLD pasan primero por DEFERRED
  // (como una transferencia pendiente); la parte entera par se aprueba y la impar se rechaza.
  private async processPayment(payment: ProviderPayment) {
    const started = performance.now();
    try {
      await this.simulateProcessing(payment.externalPaymentId);

      if (payment.amount >= this.deferredThreshold) {
        await this.finish(payment, 'DEFERRED');
        await this.simulateProcessing(payment.externalPaymentId);
      }

      await this.finish(
        payment,
        Math.trunc(payment.amount) % 2 === 0 ? 'APPROVED' : 'REJECTED',
      );
    } finally {
      this.metrics.recordPaymentDuration((performance.now() - started) / 1000);
    }
  }

  private async simulateProcessing(externalPaymentId: string) {
    this.logger.log(
      `Procesando pago ${externalPaymentId} (simulando demora de ${this.delayMs}ms)...`,
    );
    await new Promise((resolve) => setTimeout(resolve, this.delayMs));
  }

  private finish(payment: ProviderPayment, status: PaymentResult) {
    this.logger.log(`Pago ${payment.externalPaymentId} resultado: ${status}`);
    payment.status = status;
    payment.updatedAt = new Date().toISOString();
    this.metrics.paymentResult(status);
    return this.webhooksService.dispatch(PAYMENT_UPDATED_EVENT, {
      paymentId: payment.paymentId,
      externalPaymentId: payment.externalPaymentId,
      status,
    });
  }
}
