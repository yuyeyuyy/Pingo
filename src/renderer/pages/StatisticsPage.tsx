import { ChartNoAxesColumnIncreasing } from 'lucide-react'
import { EmptyState } from '../components/EmptyState'

export function StatisticsPage() {
  return (
    <>
      <header className="page-header">
        <h1 id="page-title">学习统计</h1>
        <p>回顾练习记录与学习进度。</p>
      </header>
      <EmptyState
        icon={ChartNoAxesColumnIncreasing}
        title="学习统计尚未开放"
        description="提交的答案会保存在本机，学习统计和错题复习将在后续开放。"
      />
    </>
  )
}
