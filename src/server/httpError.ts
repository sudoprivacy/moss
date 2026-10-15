/** Shared HTTP error identity without importing the server or runtime. */
export class HttpError extends Error {
  constructor(readonly statusCode: number, message: string) {
    super(message)
    this.name = 'HttpError'
  }
}
