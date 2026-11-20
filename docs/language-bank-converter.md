# 语言学习模板追加题库转换

带学习资料的当前产物位于 `data/cet4-study`。重新生成：

```bash
python3 scripts/convert_language_bank.py --with-recognition \
  --input '题库/3-CET4-顺序.json' \
  --output data/cet4-study-new
```

词表输入默认输出 `materials` 和题目的 `materialKey`。明确考查同一单一义项的题可以共用资料。保留多条释义的拼写题使用与其题面范围一致的资料。双语短语仅在来源的单词和释义均能匹配资料时保留。每个分片携带其引用的资料，相同键在各分片中使用相同内容。加上 `--questions-only` 可改为只输出练习题。

需要同时生成英译中、中译英和拼写题时，加上 `--with-recognition`：

```bash
python3 scripts/convert_language_bank.py --with-recognition \
  --input '题库/3-CET4-顺序.json' \
  --output data/cet4-mixed-new
```

`data/cet4-mixed` 已包含本次输出。选择题的四个选项来自同一词表，经本地释义冲突规则筛查。报告分别统计成功转换的记录和实际输出的题目，因为一条记录可以产生多种题型。

当前带难度的 CET4 产物在 `data/cet4-leveled`。可用下列命令从项目内的原词表重新生成：

```bash
python3 scripts/convert_language_bank.py \
  --input '题库/3-CET4-顺序.json' \
  --output data/cet4-leveled-new
```

脚本先为整份输入建立词元档位表，再给所有题目赋值并分片。档位表记录原词形、释义、估级依据和来源。如果来源提供合法且一致的 `wordTier`，按来源分级。CET4 原文件没有该字段，档位由本地规则估计。规则使用基础和常用词锚点、正式或专业释义、抽象或具象语义线索。缺少足够线索的词暂估 3 档。词元归并采用常见屈折映射或源释义与词性支持的词形关系。

识别题使用词档，独立拼写和词形填空加一级。同词同词性且能识别单一义项时，生成与档位无关的稳定 `conceptKey`。报告列出分布、低证据估计、原题难度调整、未赋难度的题目及选择与拼写配对的校验数量。实际 CET4 输出全部为拼写题，跨分片配对规则通过测试样例验证。

```bash
python3 scripts/convert_language_bank.py \
  --input '/path/to/3-CET4-顺序.json' \
  --output data/cet4-language-append-new
```

仅用 Python 3.9+ 标准库，不联网、不调用模型，不修改原始文件或用户数据库，拒绝覆盖已有输出。`--dry-run` 只统计，不写文件；`--max-bytes` 可降低分片上限。默认使用项目当前字节限制（最多 32 MiB），不再采用旧版的每文件 3,000 题限制。

## 本次来源与转换策略

输入为 UTF-8 无 BOM 的 JSON 数组，包含 7,508 条词条，并非已有选择题。每条 `word` 是明确英文答案，`translations[].translation` 为中文释义，`translations[].type` 为词性；没有题号、章节、选项或单独答案表。报告中以原数组的一基序号标记来源记录。

每条记录映射为一道 `short-answer` / `word-spelling` 题，使用全部原始释义和词性组成题干，来源英文单词同时写入 `acceptedAnswers` 和 `referenceAnswer`，不随机添加选项或猜测同义答案。短语 `phrases` 是附加例句资料，不是单词本身的独立释义，不扩展为额外题目。保留源顺序；完全相同的转换结果只保留第一次。相同题干和条件对应不同答案时，将所有冲突记录跳过并报告，避免擅自选择答案。

原资料中的省略号等内容不被擅自删改，列在报告 `source_review` 中供复核。源词库本身的错译、遗漏同义词或其他语义问题没有经过独立词典审核，格式校验不代表语义完全正确。

本次导出：7,381 题；跳过 127 条，其中答案冲突 102 条、重复 18 条、无中文释义 7 条。`7,508 = 7,381 + 127`。文件约 1.98 MiB，因此只有一个分片。

## 输出与校验

每个 `cet4_language.partNNN.json` 都是 UTF-8 的独立完整 `{"questions":[...]}` 对象，仅含题目及其题型允许的字段。转换报告 `conversion_report.json` 单独保存输入编码、来源 SHA-256、题型策略、计数核平、输出大小、跳过的原始序号/记录/原因，以及需人工复核的来源信息。请在已创建的**语言学习模板题库中选择追加导入**，不要使用需要 `name` 的旧建库导入入口。

脚本也接受现有 `{"questions":[...]}` JSON，保留四种题型及其答案。校验语言分类与题型匹配、答案下标、选项释义同长、acceptedAnswers、填空标记和答案数量、排序排列覆盖范围，以及各字段长度。缺失答案或冲突记录只进入报告，不猜测答案；没有任何有效题目时仍输出报告，不生成空题库，退出码为 1。无法识别的源结构直接报错，脚本不自动解析 Word/PDF 或猜测未知字段。

字段长度按 UTF-16 代码单元计算，与 Pingo 一致；字节大小按实际 UTF-8 JSON 序列化结果计算。超过上限按顺序拆分，所有分片各含至少一题。输出后回读 JSON，并再次核对源文件哈希。

## 测试

```bash
python3 -m unittest discover -s tests/python -p test_convert_language_bank.py -v
./node_modules/.bin/vitest run tests/language-bank-converter.test.ts tests/question-forms.test.ts tests/question-bank.test.ts
```

Python 测试覆盖全部四种题型、释义/填空/排序校验、缺失和冲突答案、源顺序、重复、UTF-16 长度、按 UTF-8 大小分片、无有效题目、BOM、dry-run 与拒绝覆盖。TypeScript 测试通过真实 CLI 与当前追加导入器，并将本次整份题库追加到临时语言学习题库，核对原有题目不变和新增题目内容一致，不接触用户数据库。
