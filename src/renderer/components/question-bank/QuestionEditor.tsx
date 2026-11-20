import { Plus, X } from 'lucide-react'
import { useState } from 'react'
import {
  BANK_LIMITS,
  BLANK_MARKER,
  LANGUAGE_QUESTION_TYPES,
  PARTS_OF_SPEECH,
  QUESTION_KINDS,
} from '../../../shared/question-bank'
import type {
  BankTemplate,
  Difficulty,
  LanguageQuestionType,
  PartOfSpeech,
  Question,
  QuestionDraft,
  QuestionKind,
} from '../../../shared/question-bank'
import { ActionDialog } from './ActionDialog'

function optionRow(text = '', explanation = '', part: PartOfSpeech | '' = '') {
  return { key: crypto.randomUUID(), text, explanation, part }
}

function lines(value: string): string[] {
  return value
    .split('\n')
    .map((item) => item.trim())
    .filter(Boolean)
}

interface QuestionEditorProps {
  template: BankTemplate
  question?: Question
  onSave(question: QuestionDraft): Promise<void>
  onClose(): void
}

export function QuestionEditor({ template, question, onSave, onClose }: QuestionEditorProps) {
  const [type, setType] = useState<string>(
    question?.languageType ??
      question?.kind ??
      (template === 'language' ? 'word-to-meaning' : 'multiple-choice'),
  )
  const classification = Object.hasOwn(LANGUAGE_QUESTION_TYPES, type)
    ? (type as LanguageQuestionType)
    : undefined
  const kind = classification
    ? LANGUAGE_QUESTION_TYPES[classification].kind
    : (type as QuestionKind)
  const kinds =
    template === 'language'
      ? Object.entries(LANGUAGE_QUESTION_TYPES).map(([id, option]) => [id, option.label] as const)
      : Object.entries(QUESTION_KINDS)
  const [prompt, setPrompt] = useState(question?.prompt ?? '')
  const [difficulty, setDifficulty] = useState(question?.difficulty?.toString() ?? '')
  const [conceptKey, setConceptKey] = useState(question?.conceptKey ?? '')
  const [materialKey, setMaterialKey] = useState(question?.materialKey ?? '')
  const [referenceAnswer, setReferenceAnswer] = useState(
    question?.kind === 'short-answer' ? (question.referenceAnswer ?? '') : '',
  )
  const [accepted, setAccepted] = useState(
    question?.kind === 'short-answer' ? (question.acceptedAnswers?.join('\n') ?? '') : '',
  )
  const [blankAnswers, setBlankAnswers] = useState(() =>
    question?.kind === 'fill-in' ? question.blanks.map((answer) => answer.join('\n')) : [],
  )
  const [order, setOrder] = useState(() =>
    question?.kind === 'ordering'
      ? question.correctOrder.map((index) => question.items[index]).join('\n')
      : '',
  )
  const [options, setOptions] = useState(() =>
    question?.kind === 'multiple-choice'
      ? question.options.map((text, index) =>
          optionRow(
            text,
            question.optionExplanations?.[index] ?? '',
            question.optionPartsOfSpeech?.[index] ?? '',
          ),
        )
      : [optionRow(), optionRow()],
  )
  const [correctKey, setCorrectKey] = useState(
    question?.kind === 'multiple-choice' ? options[question.correctOptionIndex]?.key : undefined,
  )
  const blankCount = prompt.split(BLANK_MARKER).length - 1

  function updateOption(key: string, patch: Partial<Omit<ReturnType<typeof optionRow>, 'key'>>) {
    setOptions((current) =>
      current.map((option) => (option.key === key ? { ...option, ...patch } : option)),
    )
  }

  function save(): Promise<void> {
    const base = {
      prompt,
      ...(classification ? { languageType: classification } : {}),
      ...(difficulty ? { difficulty: Number(difficulty) as Difficulty } : {}),
      ...(conceptKey.trim() ? { conceptKey: conceptKey.trim() } : {}),
      ...(materialKey.trim() ? { materialKey: materialKey.trim() } : {}),
    }
    switch (kind) {
      case 'short-answer': {
        const acceptedAnswers = lines(accepted)
        return onSave({
          ...base,
          kind,
          referenceAnswer,
          ...(acceptedAnswers.length ? { acceptedAnswers } : {}),
        })
      }
      case 'fill-in':
        if (blankCount === 0 || blankCount > BANK_LIMITS.maxBlanks)
          throw new Error('请在题干添加 1 至 20 个空格。')
        return onSave({
          ...base,
          kind,
          blanks: Array.from({ length: blankCount }, (_, index) =>
            lines(blankAnswers[index] ?? ''),
          ),
        })
      case 'ordering': {
        const items = lines(order)
        return onSave({ ...base, kind, items, correctOrder: items.map((_, index) => index) })
      }
      case 'multiple-choice': {
        const correctOptionIndex = options.findIndex((option) => option.key === correctKey)
        if (correctOptionIndex < 0) throw new Error('请选择一个正确选项。')
        const optionExplanations = options.map((option) => option.explanation.trim() || null)
        const optionPartsOfSpeech = options.map((option) => option.part || null)
        return onSave({
          ...base,
          kind,
          options: options.map((option) => option.text),
          correctOptionIndex,
          ...(optionExplanations.some(Boolean) ? { optionExplanations } : {}),
          ...(optionPartsOfSpeech.some(Boolean) ? { optionPartsOfSpeech } : {}),
        })
      }
    }
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
        <select value={type} onChange={(event) => setType(event.target.value)}>
          {template === 'language' && question && !question.languageType && (
            <option value={question.kind}>{QUESTION_KINDS[question.kind]}（通用）</option>
          )}
          {kinds.map(([id, label]) => (
            <option value={id} key={id}>
              {label}
            </option>
          ))}
        </select>
      </label>
      <div className="reminder-fields">
        <label className="bank-field">
          难度
          <select value={difficulty} onChange={(event) => setDifficulty(event.target.value)}>
            <option value="">按题型估计</option>
            {[1, 2, 3, 4, 5].map((level) => (
              <option key={level} value={level}>
                {level} 级
              </option>
            ))}
          </select>
        </label>
        <label className="bank-field">
          知识点分组（可选）
          <input
            type="text"
            maxLength={BANK_LIMITS.conceptKey}
            value={conceptKey}
            placeholder="apple:n:fruit"
            onChange={(event) => setConceptKey(event.target.value)}
          />
          <span className="bank-hint">循序渐进的练习模式会错开同组题目。</span>
        </label>
      </div>
      <label className="bank-field">
        学习资料标识（可选）
        <input
          type="text"
          maxLength={BANK_LIMITS.materialKey}
          value={materialKey}
          placeholder="apple:n:fruit"
          onChange={(event) => setMaterialKey(event.target.value)}
        />
        <span className="bank-hint">填写当前题库导入文件里的资料 key。</span>
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
      {kind === 'fill-in' && (
        <>
          <div className="bank-actions">
            <button
              type="button"
              className="secondary-button"
              disabled={
                blankCount >= BANK_LIMITS.maxBlanks ||
                prompt.length + BLANK_MARKER.length > BANK_LIMITS.prompt
              }
              onClick={() => setPrompt((value) => value + BLANK_MARKER)}
            >
              插入空格
            </button>
            <p className="bank-hint">在题干中用 {BLANK_MARKER} 标记空格。</p>
          </div>
          {Array.from({ length: Math.min(blankCount, BANK_LIMITS.maxBlanks) }, (_, index) => (
            <label className="bank-field" key={index}>
              第 {index + 1} 空的答案（每行一个）
              <textarea
                rows={2}
                required
                value={blankAnswers[index] ?? ''}
                onChange={(event) => {
                  const value = event.target.value
                  setBlankAnswers((answers) =>
                    Array.from({ length: Math.max(answers.length, index + 1) }, (_, position) =>
                      position === index ? value : (answers[position] ?? ''),
                    ),
                  )
                }}
              />
            </label>
          ))}
        </>
      )}
      {kind === 'ordering' && (
        <label className="bank-field">
          正确顺序（每行一个条目）
          <textarea
            rows={6}
            required
            value={order}
            onChange={(event) => setOrder(event.target.value)}
          />
        </label>
      )}
      {kind === 'short-answer' && (
        <>
          <label className="bank-field">
            {classification ? '可接受答案（每行一个）' : '可接受答案（可选，每行一个）'}
            <textarea
              rows={3}
              required={!!classification}
              value={accepted}
              onChange={(event) => setAccepted(event.target.value)}
            />
          </label>
          <label className="bank-field">
            参考答案（可选）
            <textarea
              value={referenceAnswer}
              rows={3}
              maxLength={BANK_LIMITS.referenceAnswer}
              onChange={(event) => setReferenceAnswer(event.target.value)}
            />
          </label>
        </>
      )}
      {kind === 'multiple-choice' && (
        <fieldset className="question-options">
          <legend>选项与正确答案</legend>
          <p className="bank-hint">勾选正确答案。填写的释义和词性会在提交后展示。</p>
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
                onChange={(event) => updateOption(option.key, { text: event.target.value })}
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
              <div className="question-option-details">
                <input
                  type="text"
                  aria-label={`选项 ${index + 1} 的释义`}
                  placeholder="释义或对应单词（可选）"
                  value={option.explanation}
                  maxLength={BANK_LIMITS.option}
                  onChange={(event) =>
                    updateOption(option.key, { explanation: event.target.value })
                  }
                />
                <select
                  aria-label={`选项 ${index + 1} 的词性`}
                  value={option.part}
                  onChange={(event) =>
                    updateOption(option.key, { part: event.target.value as PartOfSpeech | '' })
                  }
                >
                  <option value="">词性（可选）</option>
                  {Object.entries(PARTS_OF_SPEECH).map(([part, label]) => (
                    <option key={part} value={part}>
                      {part}. {label}
                    </option>
                  ))}
                </select>
              </div>
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
