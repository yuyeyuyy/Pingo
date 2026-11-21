import { BANK_TEMPLATES, LANGUAGE_QUESTION_TYPES } from './question-bank'
import type { BankTemplate } from './question-bank'

export function conversionPrompt(template: BankTemplate): string {
  const categories =
    template === 'language'
      ? '\n语言分类通过 languageType 表达。以下是分类、显示名称与 kind 的对应关系\n' +
        Object.entries(LANGUAGE_QUESTION_TYPES)
          .map(([type, { label, kind }]) => `- ${type}（${label}）使用 ${kind}`)
          .join('\n') +
        '\n把能明确归类的题目加上 languageType。来源只有通用题型时可省略这个字段。' +
        '\n如果原文件只有词表，优先用能核对的词义生成识别题或拼写题。选择题的干扰项可取自同一词表，须核对只有一个正确答案。多个单词都符合给出的释义时，用来源中的词性或上下文消歧，或跳过并写进报告。'
      : '\n基础模板的题目省略 languageType。'

  return `请为我写并运行一个本地转换脚本，将我提供的题库文件转换成 Pingo 可导入的 UTF-8 JSON。我会把输出追加到已创建的${BANK_TEMPLATES[template]}题库。

先检查输入文件的字段、编码、题型及答案位置。脚本读取完整数据，按源记录顺序处理，保留已有题目的题干、选项顺序、答案和必要上下文。输出 JSON 形如 {"questions":[...]}，每份至少一题，文件上限 32 MiB。超出时按文件大小分片，每份都是独立的完整 JSON。报告须列出输入记录数、成功转换的记录数、输出题数、跳过的记录及原因，并核对记录数。缺失或冲突的答案请保留在报告，避免猜测。保留原始文件。

先给单词分级，再换算题目难度

先通读整份词表，建立一份「目标词 → 单词档位」表。按词的常见程度、使用范围和目标义项是否抽象或专业，将不同单词分为 1 至 4 档。原资料带有词频、教材分级或例句时，可作为辅助依据。只有单词和释义时也直接估级。统一用词典原形归档，例如 borrow 和 borrowed 使用同一个词条。用同一张表处理所有输出分片，按实际难度分档，允许某档为空。把估计档位和依据写进报告，注明资料中可查的分级和 Agent 的估计。

- 单词 1 档。日常最基础、词义直观，如 apple。
- 单词 2 档。常见生活、学习或工作词汇，如 borrow。
- 单词 3 档。跨场景使用、词义较抽象的通用词汇，如 reliable。
- 单词 4 档。正式、专业或较少见的词汇，如 mitigate。

导入 JSON 的 difficulty 是换算后的题目难度，必须是 1 至 5 的整数。选择题沿用目标词的单词档位，独立拼写在该词档位上加 1。单词选释义和释义选单词都按选择题换算，以正确答案对应的目标词为准。词汇填空可按是否需要独立回忆词形来取等级。语法、句子排序等没有单一目标词的题目，可按知识点和作答步骤直接评为 1 至 5 级。题面仍不足以判断时才省略 difficulty，由 Pingo 按题型估计。

同一知识点的不同题可以共用 conceptKey，让循序渐进的练习模式把它们分到不同轮。使用不超过 160 字符的稳定键，语言题可用「词元:词性:词义标识」，例如 apple:n:fruit。apple 的选择题和拼写题可以共用这个键，分别写 difficulty 1 和 2。不同词义使用不同键，无法判断归属时可省略。

添加学习模式资料

如果输入是词表，或我要求先学再练，请在顶层增加 materials 数组，并在每道关联题里填写 materialKey。每份资料介绍一个词或知识点，可以关联多道题，学习模式每轮只取其中一道。可只导入 questions 供练习模式使用。

资料示例 {"key":"apple:n:fruit","title":"apple","explanation":"名词。苹果。","examples":[{"text":"She ate an apple.","translation":"她吃了一个苹果。"}]}。每个关联题填写 "materialKey":"apple:n:fruit"。key 在同一个题库里唯一，最长 160 字符。title 最长 200 字符，explanation 最长 10,000 字符。examples 可省略，最多 5 条，每条的 text 和可选 translation 分别最多 2,000 字符。

优先保留可核对的释义和例句。只有词与释义时，可以围绕目标义项写一条原创例句，在报告注明。只把能够确认考查同一个知识点的题链接到该资料。拆分文件时，每份保留本分片题目引用的资料，跨分片的同一个 key 使用一致内容。

四种题型的数据格式

- 选择题 {"kind":"multiple-choice","prompt":"apple 的中文释义是什么？","options":["苹果","梨"],"correctOptionIndex":0,"optionExplanations":["apple","pear"],"optionPartsOfSpeech":["n","n"],"difficulty":1,"conceptKey":"apple:n:fruit"}。正确选项下标从 0 开始，共 2 至 20 个选项。单词选释义时，optionExplanations 提供每条释义对应的单词，建议填写 headword（如 "apple"）标记题干里可点击发音的单词。headword 必须出现在题干中，最长 80 字符。释义选单词时，optionExplanations 提供每个单词的释义。词性的简写独立填在 optionPartsOfSpeech，如 v、adj、n、adv，按每个选项对应的义项填写。这两个可选数组都要与 options 同序同长，资料无法确认的项填 null。
- 填写题 {"kind":"short-answer","prompt":"输入「苹果」的英文单词。","acceptedAnswers":["apple"],"referenceAnswer":"apple","difficulty":2,"conceptKey":"apple:n:fruit"}。可用 acceptedAnswers 提供 1 至 20 个可接受答案。只有参考答案、需自评的普通填写题可以省略 acceptedAnswers。语言分类中的单词拼写和语法纠错需提供可接受答案。
- 填空题 {"kind":"fill-in","prompt":"She {{blank}} a teacher.","blanks":[["is"]]}。在题干用 {{blank}} 标记 1 至 20 个空，blanks 按空的顺序排列，每个空包含 1 至 20 个可接受答案。
- 排序题 {"kind":"ordering","prompt":"将词语排列成句。","items":["apples","like","I"],"correctOrder":[2,1,0]}。包含 2 至 60 个条目，正确顺序是从 0 开始的不重复下标，涵盖全部条目。排序题至少包含两个不同的条目。
${categories}

导出前校验 JSON、正确答案、释义数量、填空数量和排序下标。跨分片核对同一个词的拼写题难度比选择题高 1 级。在报告分别列出各档单词数、各级题数和省略难度的记录。题干和参考答案最多 10,000 字符，选项、释义、单空答案和排序条目每项最多 2,000 字符。转换结束后告诉我脚本、输出 JSON 和转换报告的路径。`
}
