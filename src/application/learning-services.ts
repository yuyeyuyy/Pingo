export interface StatisticsService {
  getSummary(): Promise<{ completedSessions: number; answeredQuestions: number }>
}
