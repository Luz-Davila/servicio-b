import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { PaymentsModule } from './payments/payments.module';
import { SuscripcionesModule } from './suscripciones/suscripciones.module';
import { WebhooksModule } from './webhooks/webhooks.module';

@Module({
  imports: [PaymentsModule, SuscripcionesModule, WebhooksModule],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
