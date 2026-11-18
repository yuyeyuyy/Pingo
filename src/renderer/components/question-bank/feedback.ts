export function requestMessage(error: unknown): string {
  return error instanceof Error ? error.message : '题库操作失败，请重试。'
}
