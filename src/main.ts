import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module';

async function bootstrap() {
  // Sin Docker: primero el .env compartido de la carpeta raíz y luego el propio, igual que el Servicio A.
  // loadEnvFile no pisa variables ya definidas, así que en Docker mandan las de docker-compose.
  for (const file of ['../.env', '.env']) {
    try {
      process.loadEnvFile(file);
    } catch {
      // El archivo no existe (por ejemplo, dentro del contenedor).
    }
  }

  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    rawBody: true,
  });
  app.enableCors();
  await app.listen(process.env.PORT ?? 3001);
}
bootstrap();
