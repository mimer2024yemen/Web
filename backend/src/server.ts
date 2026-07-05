import { buildApp } from './app.js';
import { env } from './env.js';

const app = await buildApp();

try {
  await app.listen({ port: env.port, host: '0.0.0.0' });
  app.log.info(`NewsHub Pro API listening on ${env.port}`);
} catch (error) {
  app.log.error(error);
  process.exit(1);
}
