import type { FastifyInstance } from 'fastify'

export class ApiError extends Error {
  constructor(public statusCode: number, public code: string, message: string, public currentRevision?: number) { super(message) }
}

export function registerErrors(app: FastifyInstance) {
  app.setErrorHandler((error, request, reply) => {
    const known = error instanceof ApiError
    const httpError = error as { statusCode?: number; message?: string }
    const status = known ? error.statusCode : (httpError.statusCode && httpError.statusCode < 500 ? httpError.statusCode : 500)
    const code = known ? error.code : status === 400 ? 'INVALID_REQUEST' : status === 413 ? 'FILE_TOO_LARGE' : 'INTERNAL_ERROR'
    if (status >= 500) request.log.error({ err: error }, 'request failed')
    reply.status(status).send({ code, message: status >= 500 ? 'Internal server error' : httpError.message, requestId: request.id, ...(known && error.currentRevision !== undefined ? { currentRevision: error.currentRevision } : {}) })
  })
}
