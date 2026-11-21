import { BookOpen, ChartNoAxesColumnIncreasing, House, LaptopMinimal, Settings } from 'lucide-react'
import { useDesktopValue } from './components/reminders/useDesktopValue'
import { HomePage } from './pages/HomePage'
import { QuestionBankPage } from './pages/QuestionBankPage'
import { SettingsPage } from './pages/SettingsPage'
import { StatisticsPage } from './pages/StatisticsPage'
import { useNavigation } from './stores/navigation'
import type { Page } from './stores/navigation'

const pages = {
  home: { label: '首页', icon: House, component: HomePage },
  'question-bank': { label: '题库', icon: BookOpen, component: QuestionBankPage },
  statistics: { label: '学习统计', icon: ChartNoAxesColumnIncreasing, component: StatisticsPage },
  settings: { label: '设置', icon: Settings, component: SettingsPage },
}
const pageIds = Object.keys(pages) as Page[]

export function App() {
  const page = useNavigation((state) => state.page)
  const navigate = useNavigation((state) => state.navigate)
  const CurrentPage = pages[page].component
  const mac = navigator.userAgent.includes('Macintosh')
  const api = window.pingo
  const { value: reminders } = useDesktopValue(api?.getReminderStatus, api?.onReminderStatus)

  return (
    <div className={mac ? 'workspace workspace--mac' : 'workspace'}>
      {mac && <div className="window-drag" aria-hidden="true" />}
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true">
            P
          </span>
          <span>Pingo</span>
        </div>
        <nav aria-label="主导航" className="navigation">
          {pageIds.map((id) => {
            const { label, icon: Icon } = pages[id]
            return (
              <button
                key={id}
                type="button"
                aria-current={page === id ? 'page' : undefined}
                onClick={() => navigate(id)}
              >
                <Icon size={17} aria-hidden="true" />
                {label}
              </button>
            )
          })}
        </nav>
        {(reminders?.pendingSessionId || reminders?.notice) && (
          <button
            className="secondary-button sidebar-reminder"
            type="button"
            onClick={() =>
              navigate(reminders.notice === 'empty-bank' ? 'question-bank' : 'settings')
            }
          >
            {reminders.pendingSessionId
              ? '有一轮学习待开始'
              : reminders.notice === 'empty-favorites'
                ? '收藏本暂无题目'
                : reminders.notice === 'nothing-due'
                  ? '暂无可安排的题目'
                  : reminders.notice === 'empty-study'
                    ? '暂无带学习资料的题目'
                    : reminders.notice === 'empty-materials'
                      ? '所选范围暂无学习资料'
                      : '所选题库暂无题目'}
          </button>
        )}
        <div className="sidebar-footer">
          <LaptopMinimal size={15} aria-hidden="true" />
          本地工作区
        </div>
      </aside>
      <main className="workspace-main" aria-labelledby="page-title" key={page}>
        <div className="page">
          <CurrentPage />
        </div>
      </main>
    </div>
  )
}
