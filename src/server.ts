import { buildApp } from './app.js'
import { config } from './config.js'

const app = await buildApp()
try {
  await app.listen({ host: '0.0.0.0', port: config.port })
} catch (error) {
  app.log.error(error)
  process.exitCode = 1
}
