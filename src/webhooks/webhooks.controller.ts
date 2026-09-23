import { Controller, Post, Get, Req, Headers, UnauthorizedException } from '@nestjs/common';
import type { RawBodyRequest } from '@nestjs/common';
import type { Request } from 'express';
import { WebhooksService } from './webhooks.service';

@Controller('webhooks')
export class WebhooksController {
  constructor(private readonly webhooksService: WebhooksService) {}

  @Post('pedido')
  receiveWebhook(
    @Req() req: RawBodyRequest<Request>,
    @Headers('x-signature') signature: string,
  ) {
    if (!req.rawBody) {
      throw new UnauthorizedException('Body vacío');
    }

    const result = this.webhooksService.verifyAndProcess(req.rawBody, signature);

    if (!result.valid) {
      throw new UnauthorizedException(result.error);
    }

    return { message: 'Webhook recibido y verificado', pedido: result.event };
  }

  @Get('recibidos')
  findAll() {
    return this.webhooksService.findAll();
  }
}
