import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseIntPipe,
  Post,
} from '@nestjs/common';
import { SuscripcionesService } from './suscripciones.service';

// La tienda registra aquí la URL donde quiere recibir los webhooks: { "url": "...", "event": "payment.updated" }
@Controller('suscripciones')
export class SuscripcionesController {
  constructor(private readonly suscripcionesService: SuscripcionesService) {}

  @Post()
  create(@Body() body: { url?: unknown; event?: unknown }) {
    return this.suscripcionesService.create(body ?? {});
  }

  @Get()
  findAll() {
    return this.suscripcionesService.findAll();
  }

  @Delete(':id')
  remove(@Param('id', ParseIntPipe) id: number) {
    return this.suscripcionesService.remove(id);
  }
}
