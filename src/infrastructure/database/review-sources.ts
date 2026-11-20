import type { PracticeSource } from '../../domain/review'

export const REVIEW_SOURCE_JOINS: Readonly<Record<PracticeSource, string>> = {
  all: '',
  mistakes: 'JOIN wrong_questions w ON w.question_id = q.id',
  favorites: 'JOIN favorite_questions f ON f.question_id = q.id',
}
