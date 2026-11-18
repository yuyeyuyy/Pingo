import {
  ArrowUpRight,
  BookOpen,
  ChartNoAxesColumnIncreasing,
  ChevronRight,
  Settings,
} from 'lucide-react'
import { useNavigation } from '../stores/navigation'

const destinations = [
  { id: 'question-bank', title: '题库', description: '整理想要练习的题目', icon: BookOpen },
  {
    id: 'statistics',
    title: '学习统计',
    description: '查看答题记录与学习进度',
    icon: ChartNoAxesColumnIncreasing,
  },
] as const

export function HomePage() {
  const navigate = useNavigation((state) => state.navigate)

  return (
    <>
      <header className="page-header">
        <h1 id="page-title">学习概览</h1>
        <p>从自己的题库出发，把学习融入日常。</p>
      </header>
      <div className="home-grid">
        {destinations.map(({ id, title, description, icon: Icon }) => (
          <button key={id} className="destination-card" type="button" onClick={() => navigate(id)}>
            <span className="card-top">
              <span className="icon-tile">
                <Icon size={23} aria-hidden="true" />
              </span>
              <ArrowUpRight size={17} aria-hidden="true" />
            </span>
            <span className="destination-title">{title}</span>
            <span className="destination-description">{description}</span>
          </button>
        ))}
      </div>
      <button className="settings-link" type="button" onClick={() => navigate('settings')}>
        <span className="icon-tile">
          <Settings size={19} aria-hidden="true" />
        </span>
        <span>
          <span className="destination-title">设置</span>
          <span className="destination-description">查看应用信息与后台运行方式</span>
        </span>
        <ChevronRight size={17} aria-hidden="true" />
      </button>
    </>
  )
}
