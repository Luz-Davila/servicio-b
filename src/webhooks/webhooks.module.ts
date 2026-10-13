import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { SuscripcionesModule } from '../suscripciones/suscripciones.module';
import { MetricsModule } from '../observability/metrics.module';
import { WebhooksController } from './webhooks.controller';
import { WebhooksService } from './webhooks.service';

@Module({
  imports: [HttpModule, SuscripcionesModule, MetricsModule],
  controllers: [WebhooksController],
  providers: [WebhooksService],
  exports: [WebhooksService],
})
export class WebhooksModule {}
