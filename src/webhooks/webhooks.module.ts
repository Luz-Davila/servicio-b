import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { SuscripcionesModule } from '../suscripciones/suscripciones.module';
import { WebhooksController } from './webhooks.controller';
import { WebhooksService } from './webhooks.service';

@Module({
  imports: [HttpModule, SuscripcionesModule],
  controllers: [WebhooksController],
  providers: [WebhooksService],
  exports: [WebhooksService],
})
export class WebhooksModule {}
