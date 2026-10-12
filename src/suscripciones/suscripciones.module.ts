import { Module } from '@nestjs/common';
import { SuscripcionesController } from './suscripciones.controller';
import { SuscripcionesService } from './suscripciones.service';

@Module({
  controllers: [SuscripcionesController],
  providers: [SuscripcionesService],
  exports: [SuscripcionesService],
})
export class SuscripcionesModule {}
