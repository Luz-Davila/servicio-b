import { Controller, Get, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { WebhooksService } from './webhooks.service';

@Controller('webhooks')
export class WebhooksController {
  constructor(private readonly webhooksService: WebhooksService) {}

  // Evidencia de cada webhook enviado a la tienda, del más reciente al más antiguo.
  @Get('entregas')
  findAll() {
    return this.webhooksService.findAll();
  }

  @Post('entregas/:id/reenviar')
  replay(@Param('id', ParseUUIDPipe) id: string) {
    return this.webhooksService.replay(id);
  }
}
