import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';

export const PAYMENT_UPDATED_EVENT = 'payment.updated';
const SUPPORTED_EVENTS = [PAYMENT_UPDATED_EVENT];

export interface Suscripcion {
  id: number;
  url: string;
  event: string;
  createdAt: string;
}

@Injectable()
export class SuscripcionesService {
  private readonly logger = new Logger(SuscripcionesService.name);
  private readonly suscripciones: Suscripcion[] = [];
  private nextId = 1;

  // Las suscripciones viven en memoria; DEFAULT_WEBHOOK_URL evita perder la de la tienda al reiniciar.
  constructor() {
    const defaultUrl = process.env.DEFAULT_WEBHOOK_URL;
    if (defaultUrl) {
      const suscripcion = this.create({
        url: defaultUrl,
        event: PAYMENT_UPDATED_EVENT,
      });
      this.logger.log(
        `Suscripción por defecto registrada: ${suscripcion.event} -> ${suscripcion.url}`,
      );
    }
  }

  create(input: { url?: unknown; event?: unknown }): Suscripcion {
    const url = this.parseUrl(input.url);
    const event = input.event ?? PAYMENT_UPDATED_EVENT;
    if (typeof event !== 'string' || !SUPPORTED_EVENTS.includes(event)) {
      throw new BadRequestException(
        `Evento no soportado. Usa: ${SUPPORTED_EVENTS.join(', ')}`,
      );
    }

    const existing = this.suscripciones.find(
      (s) => s.url === url && s.event === event,
    );
    if (existing) {
      return existing;
    }

    const suscripcion: Suscripcion = {
      id: this.nextId++,
      url,
      event,
      createdAt: new Date().toISOString(),
    };
    this.suscripciones.push(suscripcion);
    return suscripcion;
  }

  findAll() {
    return this.suscripciones;
  }

  findByEvent(event: string) {
    return this.suscripciones.filter((s) => s.event === event);
  }

  remove(id: number) {
    const index = this.suscripciones.findIndex((s) => s.id === id);
    if (index === -1) {
      throw new NotFoundException('Suscripción no encontrada');
    }
    return this.suscripciones.splice(index, 1)[0];
  }

  private parseUrl(value: unknown): string {
    if (typeof value !== 'string') {
      throw new BadRequestException('La url es obligatoria');
    }
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      throw new BadRequestException('La url no es válida');
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new BadRequestException('La url debe usar http o https');
    }
    return url.toString();
  }
}
