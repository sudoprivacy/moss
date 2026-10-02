export class ResourceAccessError extends Error {
  constructor(readonly statusCode: number, message: string) {
    super(message)
    this.name = 'ResourceAccessError'
  }
}
