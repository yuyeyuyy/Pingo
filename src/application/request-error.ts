export class RequestError extends Error {
  constructor(
    readonly code: 'INVALID_ARGUMENTS' | 'NOT_FOUND',
    message: string,
  ) {
    super(message)
  }
}
