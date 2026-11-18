# CET4 词库转换脚本

离线词库转换工具使用 Python 3.9 或更新版本，仅依赖标准库。请自行准备原始词库，输入文件和生成的题库数据保存在本机。

## 使用

已有题库（例如 `data/cet4-new`）可直接精简并分片导出，无需重新抽取干扰项：

```bash
python3 scripts/convert_vocabulary.py --from-bank \
  --input data/cet4-new --output data/cet4-import-new
```

`--from-bank` 支持指定合并 JSON 文件，或含 `cet4_all.json` 的目录；目录内其他题型文件和分片是重复集合，不会重复读取。只保留顶层 `name`、`questions` 和各题型规定的字段，按原顺序合并完全重复题目，保留原选项顺序及答案。不再进行单词题目生成或语义审核。单选缺少合法答案下标时转为保留选项的无参考答案简答题；格式错误或字段超长会报错，不截断内容。此模式不支持筛选 mode、limit 或更换 seed。

输出 `cet4_import.part001.json` 等文件，每份均满足项目的题数、字节数和字段长度限制，可全部依次导入。支持 `--dry-run`，并拒绝覆盖任何已有文件。首次实际导出的 8,084 道题保存在 `data/cet4-import`，三批数量为 3,000、3,000、2,084。

从原始词库生成题目：

```bash
python3 scripts/convert_vocabulary.py \
  --input '题库/3-CET4-顺序.json' \
  --output data/cet4-new \
  --mode all --seed 42
```

- `--mode`：`en_to_zh`、`zh_to_en`、`all`（默认）。
- `--limit 100`：最终题目总数上限，非单词数量、非每种题型数量；默认不限。按单词字母序尝试生成，all 模式每个单词先英译中再中译英。
- `--dry-run`：仍然执行清洗、生成、验证、文件规划和预览，但不创建目录或写文件。
- `--seed`：默认 42。同一输入与脚本版本、相同 seed 输出可复现；切换 mode 不改变相同题目的选项顺序。
- 拒绝覆盖任何已有目标文件，重复运行请指定新输出目录；原始词库始终只读。失败时退出码非 0；无可生成题目也返回非 0。

## 输入及清洗

实际文件为 JSON 数组，7,508 行记录、4,544 个不同单词。也支持相同条目结构的 JSONL、UTF-8 BOM：

```json
{ "word": "abuse", "translations": [{ "translation": "滥用，虐待", "type": "v" }], "phrases": [] }
```

只用 `word`、`translations[].translation`、`translations[].type`。`phrases` 是短语释义，不能作为单词本身的释义，不用于出题。同一英文单词（NFKC、去首尾空白、转小写）合并全部记录，保留全部义项用于冲突检测，而不是只保留第一行。已知词性别名如 vt/vi→v、a→adj 会归一化。

排除空释义、异常控制字符、替换字符、省略号等不完整数据、无清晰中文义项/词性的数据。遇到不完整的释义时保守跳过整个单词。按源顺序选择第一条可独立作答的短中文释义；不擅自删除括号限定语。仅名词允许有明确实义的单字释义，避免把 needle 的「针」跳过而选到来源中错误归类的「缝补」。已发现的少量不可靠释义列在 `UNRELIABLE_SENSES`，仅排除，不自动猜测修正。未选用的原始释义仍参与语义排除。

## 题目与语义策略

四个选项从清洗后的同一词库抽取，优先选择选定词性相同的单词；同词性安全选项不足时尝试其他词性，仍不足则跳过。题干标明选定词性，以减少多词性歧义。四个选项两两执行：

1. 全部已知释义的汉字重叠检查（除少量虚词）、释义包含检查。
2. 常见英文同义组、词形前缀关系排除。
3. 共享完全相同释义的词条之间，扩展一跳检查其其他义项。

这些规则比较保守，也会排除实际并不冲突的干扰项。相同中文释义和词性的中译英题干只保留一道，避免重复题干；这不影响其他单词生成英译中题。

**所有题目均为待人工复核。** 无联网词典或语境时，规则无法识别全部同义关系、缺失义项、错字和错误词性，不保证语义完全正确。`semanticReview: "needs_manual_review"` 与报告中的 `semantic_review_required` 明确记录这一点。已知冲突不会被保留；未知关系不会被宣称验证完毕。仍建议正式学习使用前抽检或审核，尤其是多义词。规则只复用原词库的译文，不凭空补译。

## Pingo 格式与导入

采用项目现有格式（不是顶层题目数组）：

```json
{
  "name": "CET4 en_to_zh",
  "questions": [
    {
      "id": "cet4_...",
      "kind": "multiple-choice",
      "prompt": "abandon（动词）的中文意思是什么？",
      "options": ["保持", "放弃", "发展", "发现"],
      "correctOptionIndex": 1,
      "category": "CET4",
      "direction": "en_to_zh",
      "word": "abandon",
      "meaning": "放弃",
      "partOfSpeech": "v",
      "optionWords": ["keep", "abandon", "develop", "discover"],
      "semanticReview": "needs_manual_review"
    }
  ]
}
```

额外元数据用于审计；Pingo 导入器仅持久化它认识的题目字段，并重新生成 UUID，原始 `id`、词性、方向、审计信息不会进入当前数据库。稳定 ID 来源为 word + direction 的 SHA-256 摘要。

脚本读取 `src/shared/question-bank.ts` 中的限制，不重复硬编码。现有单次导入最多 3,000 题、4 MiB；超过时额外生成 `.part001.json` 等分片。三份完整文件保留供离线处理：

- `cet4_en_to_zh.json`
- `cet4_zh_to_en.json`
- `cet4_all.json`

完整文件当前都超过单次导入题数限制；**在 Pingo「导入题库」中依次选择 `cet4_all.part001.json`、`cet4_all.part002.json`、`cet4_all.part003.json` 即可导入全部题目**，会建立三个题库。也可以选择各方向分片建立单向题库，但不要同时导入 all 和两种单向集合，否则内容重复。脚本的 `direct_import_files` 包含所有可选集合，不代表必须全部导入。

`cet4_report.json` 不是题库：包含原始计数、无效数据及原因、重复合并、跳过记录、人工复核范围、正确答案位置分布、seed、来源 SHA-256、文件规划、可导入文件和两种题型各 5 道随机样例。

计数口径：`skipped_entries = raw_entries - valid_entries`（包含有效单词被合并的重复行及无效行）。`invalid_rows`、有效单词的 `duplicate_rows_merged`、`valid_entries` 三者之和等于原始行数。`duplicate_rows_seen` 包括无效单词的重复行，仅作观察，不重复相加。中译英重复题干的跳过次数另计，不是清洗失败。

读取、清洗、语义比较、生成、验证、导出均为独立函数；将来六级/考研使用相同源结构时可复用这些函数，并调整分类及文件名前缀。当前 CLI 分类与文件名按本任务固定为 CET4。

## 验证与测试

```bash
python3 -m unittest discover -s tests/python -v
npm test
```

Python 测试覆盖重复合并、多义词和同义桥接、括号/空释义/异常数据、已发现的源错误、四个唯一选项、不足四项跳过、错误答案及元数据、重复题、seed、mode/limit、随机答案位置、dry-run、不覆盖源文件及已有输出、JSONL/BOM、按字节/题数分片。

TypeScript 集成测试会使用自包含的示例数据调用 Python CLI，再通过 Pingo 的 JSON 导入器。对应的本地 CET4 数据齐备时，测试还会将实际分片导入隔离的临时数据库，核对题目总量。
