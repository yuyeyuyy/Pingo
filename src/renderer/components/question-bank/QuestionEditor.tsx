import { Plus, X } from 'lucide-react'
import { useState } from 'react'
import { BANK_LIMITS } from '../../../shared/question-bank'
import type { Question, QuestionDraft } from '../../../shared/question-bank'
import { ActionDialog } from './ActionDialog'

function optionRow(text = '') {
  return { key: crypto.randomUUID(), text }
}

interface QuestionEditorProps {
  question?: Question
  onSave(question: QuestionDraft): Promise<void>
  onClose(): void
}

export function QuestionEditor({ question, onSave, onClose }: QuestionEditorProps) {
  const [kind, setKind] = useState<QuestionDraft['kind']>(question?.kind ?? 'multiple-choice')
  const [prompt, setPrompt] = useState(question?.prompt ?? '')
  const [referenceAnswer, setReferenceAnswer] = useState(
    question?.kind === 'short-answer' ? (question.referenceAnswer ?? '') : '',
  )
  const [options, setOptions] = useState(() =>
    (question?.kind === 'multiple-choice' ? question.options : ['', '']).map((text) =>
      optionRow(text),
    ),
  )
  const [correctKey, setCorrectKey] = useState(
    question?.kind === 'multiple-choice' ? options[question.correctOptionIndex]?.key : undefined,
  )

  function save(): Promise<void> {
    if (kind === 'short-answer') return onSave({ kind, prompt, referenceAnswer })
    const correctOptionIndex = options.findIndex((option) => option.key === correctKey)
    if (correctOptionIndex < 0) throw new Error('请选择一个正确选项。')
    return onSave({
      kind,
      prompt,
      options: options.map((option) => option.text),
      correctOptionIndex,
    })
  }

  return (
    <ActionDialog
      title={question ? '编辑题目' : '添加题目'}
      label="保存题目"
      onSubmit={save}
      onClose={onClose}
    >
      <label className="bank-field">
        题型
        <select
          value={kind}
          onChange={(event) =>
            setKind(event.target.value === 'short-answer' ? 'short-answer' : 'multiple-choice')
          }
        >
          <option value="multiple-choice">选择题</option>
          <option value="short-answer">简答题</option>
        </select>
      </label>
      <label className="bank-field">
        题干
        <textarea
          value={prompt}
          rows={3}
          required
          maxLength={BANK_LIMITS.prompt}
          onChange={(event) => setPrompt(event.target.value)}
        />
      </label>
      {kind === 'short-answer' ? (
        <label className="bank-field">
          参考答案（可选）
          <textarea
            value={referenceAnswer}
            rows={3}
            maxLength={BANK_LIMITS.referenceAnswer}
            onChange={(event) => setReferenceAnswer(event.target.value)}
          />
        </label>
      ) : (
        <fieldset className="question-options">
          <legend>选项与正确答案</legend>
          <p className="bank-hint">勾选正确答案旁的圆形按钮。</p>
          {options.map((option, index) => (
            <div className="question-option" key={option.key}>
              <input
                type="radio"
                name="correct-option"
                aria-label={`选项 ${index + 1} 为正确答案`}
                checked={option.key === correctKey}
                onChange={() => setCorrectKey(option.key)}
              />
              <input
                type="text"
                aria-label={`选项 ${index + 1}`}
                placeholder={`选项 ${index + 1}`}
                value={option.text}
                maxLength={BANK_LIMITS.option}
                required
                onChange={(event) =>
                  setOptions(
                    options.map((item) =>
                      item.key === option.key ? { ...item, text: event.target.value } : item,
                    ),
                  )
                }
              />
              <button
                type="button"
                className="icon-button"
                aria-label={`移除选项 ${index + 1}`}
                disabled={options.length <= BANK_LIMITS.minOptions}
                onClick={() => setOptions(options.filter((item) => item.key !== option.key))}
              >
                <X size={15} aria-hidden="true" />
              </button>
            </div>
          ))}
          <button
            type="button"
            className="secondary-button button-with-icon"
            disabled={options.length >= BANK_LIMITS.maxOptions}
            onClick={() => setOptions([...options, optionRow()])}
          >
            <Plus size={15} aria-hidden="true" />
            添加选项
          </button>
        </fieldset>
      )}
    </ActionDialog>
  )
}
