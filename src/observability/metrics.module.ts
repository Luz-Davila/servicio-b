import { Module } from '@nestjs/common';
import { ProviderMetricsService } from './provider-metrics.service';

@Module({
  providers: [ProviderMetricsService],
  exports: [ProviderMetricsService],
})
export class MetricsModule {}
