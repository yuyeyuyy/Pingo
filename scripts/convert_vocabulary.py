#!/usr/bin/env python3
"""Offline vocabulary -> Pingo banks. Python 3.9+, standard library only."""
from __future__ import annotations

import argparse
from collections import Counter, defaultdict
from dataclasses import dataclass
import hashlib
import json
from pathlib import Path
import random
import re
import sys
import unicodedata

ROOT = Path(__file__).resolve().parents[1]
WORD = re.compile(r"[a-z]+(?:[-' ][a-z]+)*\Z")
HAN = re.compile(r"[\u3400-\u9fff]")
PURE_HAN = re.compile(r"[\u3400-\u9fff]{1,14}\Z")
POS_ALIASES = {'vt': 'v', 'vi': 'v', 'a': 'adj', 'ad': 'adv', 'interjection': 'int'}
POS_LABELS = {'n': '名词', 'v': '动词', 'adj': '形容词', 'adv': '副词',
              'prep': '介词', 'pron': '代词', 'num': '数词', 'conj': '连词',
              'int': '感叹词', 'aux': '助动词', 'art': '冠词'}
# Deliberately conservative and extensible; these are exclusion hints, not a dictionary.
SYNONYM_GROUPS = [
    'big large huge enormous giant vast', 'small little tiny minute',
    'happy glad joyful cheerful delighted pleased', 'sad unhappy sorrowful miserable',
    'smart clever intelligent bright', 'begin start commence initiate',
    'end finish complete accomplish achieve', 'get obtain acquire gain receive',
    'abandon quit leave desert forsake give-up', 'buy purchase', 'look see watch view observe',
    'speak talk say tell utter', 'house home residence dwelling',
    'job work occupation profession career', 'fast quick rapid swift speedy',
    'difficult hard tough challenging', 'easy simple plain', 'beautiful pretty attractive lovely',
    'angry mad furious annoyed', 'help aid assist support', 'important significant major essential',
    'keep retain maintain preserve hold', 'increase grow rise raise expand add',
    'decrease reduce decline lessen drop fall', 'allow permit let authorize',
    'refuse reject deny decline', 'answer reply respond', 'mistake error fault',
    'freedom liberty', 'ill sick', 'illness disease sickness', 'dead deceased',
    'rich wealthy affluent', 'poor needy impoverished', 'near close nearby',
    'maybe perhaps possibly', 'almost nearly', 'also too additionally',
    'usually normally generally commonly', 'choose select pick', 'correct right accurate exact',
    'find discover detect', 'understand comprehend grasp', 'show display exhibit reveal',
    'stop cease halt pause', 'use employ utilize', 'make create produce manufacture',
    'fear fright terror dread', 'love like enjoy adore', 'hate dislike detest',
]
STOP_CHARS = set('的地得使是有于一人事物某所和与及或其以为着了')
# Source issues discovered during manual spot checks; skip, never silently repair.
UNRELIABLE_SENSES = {('portrait', '消像'), ('needle', '缝补'), ('series', '连续')}
BROAD_MEANINGS = {'东西', '事情', '事物', '某人', '某事', '使得', '进行', '成为', '关于', '有关'}


@dataclass(frozen=True)
class Entry:
    word: str
    meaning: str
    pos: str
    senses: frozenset[str]
    chars: frozenset[str]
    groups: frozenset[int]


def normalized(value: str) -> str:
    return unicodedata.normalize('NFKC', value).strip()


def read_source(path: Path) -> list:
    """Accept the actual source's JSON array, or one entry per JSONL line."""
    raw = path.read_text(encoding='utf-8-sig')
    try:
        result = json.loads(raw)
    except json.JSONDecodeError:
        result = [json.loads(line) for line in raw.splitlines() if line.strip()]
    if not isinstance(result, list):
        raise ValueError('源数据必须为 JSON 数组或 JSONL 词条，不猜测未知字段结构。')
    return result


def parse_pos(value: object) -> tuple[str, ...]:
    if not isinstance(value, str):
        return ()
    parts = re.split(r'\s*&\s*', value.strip().lower().rstrip('.'))
    parts = [POS_ALIASES.get(p, p) for p in parts]
    return tuple(dict.fromkeys(parts)) if all(p in POS_LABELS for p in parts) else ()


def clean_entries(rows: list) -> tuple[list[Entry], dict]:
    counts: Counter = Counter()
    grouped: dict[str, list] = defaultdict(list)
    skipped = []
    for index, row in enumerate(rows):
        if not isinstance(row, dict) or not isinstance(row.get('word'), str):
            counts['invalid_record'] += 1
            skipped.append({'row': index + 1, 'reason': 'invalid_record'})
            continue
        word = normalized(row['word']).lower()
        if not WORD.fullmatch(word) or len(word) > 80:
            counts['invalid_word'] += 1
            skipped.append({'row': index + 1, 'word': word, 'reason': 'invalid_word'})
            continue
        grouped[word].append(row)
    duplicate_rows_seen = sum(len(items) - 1 for items in grouped.values())
    excluded_senses = []
    entries = []
    for word, items in grouped.items():
        senses: set[str] = set()
        candidates = []
        raw_senses = []
        reason = None
        for item in items:
            translations = item.get('translations')
            if not isinstance(translations, list) or not translations:
                reason = 'missing_translations'
                break
            for trans in translations:
                if not isinstance(trans, dict) or not isinstance(trans.get('translation'), str):
                    reason = 'invalid_translation'
                    break
                text = normalized(trans['translation'])
                pos = parse_pos(trans.get('type'))
                if not text or not HAN.search(text):
                    reason = 'empty_or_non_chinese_translation'
                    break
                if any(unicodedata.category(c).startswith('C') for c in text) or re.search(r'[�…]|\.{2,}', text):
                    reason = 'abnormal_or_incomplete_translation'
                    break
                raw_senses.append(text)
                for part in re.split(r'[,;、/]', text):
                    part = part.strip()
                    key = ''.join(HAN.findall(part))
                    if key:
                        senses.add(key)
                    if (word, part) in UNRELIABLE_SENSES:
                        excluded_senses.append({'word': word, 'meaning': part, 'reason': 'manually_identified_unreliable_sense'})
                        continue
                    # Keep qualifiers intact: never delete parentheses to invent a new sense.
                    if (PURE_HAN.fullmatch(part) and part not in BROAD_MEANINGS
                            and (len(part) > 1 or (pos and pos[0] == 'n' and part not in STOP_CHARS))
                            and not part.endswith(('以及', '或者', '及', '与', '和', '于')) and pos):
                        candidates.append((part, pos[0]))
            if reason:
                break
        if reason is None and not candidates:
            reason = 'no_clear_meaning_or_pos'
        if reason:
            counts[reason] += len(items)
            skipped.append({'word': word, 'rows': len(items), 'reason': reason})
            continue
        counts['duplicate_rows_merged'] += len(items) - 1
        meaning, pos = candidates[0]
        chars = frozenset(''.join(HAN.findall(''.join(raw_senses)))) - STOP_CHARS
        groups = frozenset(i for i, group in enumerate(SYNONYM_GROUPS) if word in group.split())
        entries.append(Entry(word, meaning, pos, frozenset(senses), chars, groups))
    # Stable lexical order for generation; sense precedence follows source order.
    return sorted(entries, key=lambda e: e.word), {
        'raw_entries': len(rows), 'unique_words': len(grouped), 'valid_entries': len(entries),
        'duplicate_rows_seen': duplicate_rows_seen,
        'invalid_rows': sum(n for k, n in counts.items() if k != 'duplicate_rows_merged'),
        'invalid_unique_words': len(grouped) - len(entries),
        'excluded_senses': excluded_senses,
        'skipped_entries': len(rows) - len(entries),
        'cleaning_counts': dict(counts), 'skipped_details': skipped,
    }


def conflicts(a: Entry, b: Entry) -> bool:
    """Exclude overlaps across ALL senses, even senses not selected for the prompt."""
    if a.word == b.word or a.groups & b.groups or a.chars & b.chars:
        return True
    if any(x in y or y in x for x in a.senses for y in b.senses):
        return True
    # Related inflections/derivations also make poor distractors.
    wa, wb = a.word.replace(' ', ''), b.word.replace(' ', '')
    return len(wa) >= 4 and len(wb) >= 4 and (wa.startswith(wb) or wb.startswith(wa))


def semantic_neighbours(entries: list[Entry]) -> dict[str, frozenset[str]]:
    """One-hop synonym bridge: shared dictionary gloss -> all that word's senses."""
    by_sense: dict[str, set[str]] = defaultdict(set)
    for entry in entries:
        for sense in entry.senses:
            by_sense[sense].add(entry.word)
    return {e.word: frozenset().union(*(by_sense[s] for s in e.senses)) for e in entries}


def compatible(a: Entry, b: Entry, lookup: dict[str, Entry], neighbours: dict) -> bool:
    return (not conflicts(a, b)
            and not any(conflicts(lookup[w], b) for w in neighbours[a.word])
            and not any(conflicts(a, lookup[w]) for w in neighbours[b.word]))


def prompt_for(entry: Entry, direction: str) -> str:
    label = POS_LABELS[entry.pos]
    if direction == 'en_to_zh':
        return f'{entry.word}（{label}）的中文意思是什么？'
    return f'以下哪个单词表示「{entry.meaning}」（{label}）？'


def generate(entries: list[Entry], mode: str, seed: int, limit: int | None) -> tuple[list[dict], dict]:
    lookup = {e.word: e for e in entries}
    neighbours = semantic_neighbours(entries)
    by_pos: dict[str, list[Entry]] = defaultdict(list)
    for e in entries:
        by_pos[e.pos].append(e)
    questions = []
    seen_prompts = set()
    skipped = []
    directions = ['en_to_zh', 'zh_to_en'] if mode == 'all' else [mode]
    for e in entries:
        if limit is not None and len(questions) >= limit:
            break
        # Seed per word keeps selection and option order stable across modes / limits.
        rng = random.Random(f'{seed}:{e.word}:distractors')
        same = [x for x in by_pos[e.pos] if x.word != e.word]
        other = [x for x in entries if x.pos != e.pos]
        rng.shuffle(same)
        rng.shuffle(other)
        chosen = [e]
        for candidate in same + other:
            if all(compatible(x, candidate, lookup, neighbours) for x in chosen):
                chosen.append(candidate)
            if len(chosen) == 4:
                break
        if len(chosen) != 4:
            skipped.append({'word': e.word, 'reason': 'insufficient_unambiguous_distractors'})
            continue
        for direction in directions:
            if limit is not None and len(questions) >= limit:
                break
            prompt = prompt_for(e, direction)
            if prompt in seen_prompts:
                skipped.append({'word': e.word, 'direction': direction, 'reason': 'duplicate_prompt'})
                continue
            seen_prompts.add(prompt)
            options_entries = chosen.copy()
            random.Random(f'{seed}:{e.word}:{direction}').shuffle(options_entries)
            options = [x.meaning if direction == 'en_to_zh' else x.word for x in options_entries]
            digest = hashlib.sha256(f'{e.word}:{direction}'.encode()).hexdigest()[:20]
            questions.append({
                'id': f'cet4_{digest}', 'kind': 'multiple-choice',
                'prompt': prompt, 'options': options,
                'correctOptionIndex': options_entries.index(e),
                'category': 'CET4', 'direction': direction, 'word': e.word,
                'meaning': e.meaning, 'partOfSpeech': e.pos,
                'optionWords': [x.word for x in options_entries],
                'semanticReview': 'needs_manual_review',
            })
    return questions, {'generation_skipped': skipped, 'words_not_generated': len(entries) - len({q['word'] for q in questions})}


def require(condition: bool, message: str) -> None:
    # Explicit checks remain active under python -O.
    if not condition:
        raise ValueError(message)


def validate(questions: list[dict], entries: list[Entry]) -> list[dict]:
    lookup = {e.word: e for e in entries}
    neighbours = semantic_neighbours(entries)
    ids, prompts, pairs = set(), set(), set()
    errors = []
    for q in questions:
        try:
            e = lookup[q['word']]
            direction = q['direction']
            require(direction in ('en_to_zh', 'zh_to_en'), 'invalid direction')
            require(q['kind'] == 'multiple-choice', 'invalid kind')
            require(q['category'] == 'CET4' and q['meaning'] == e.meaning, 'wrong metadata')
            require(q['partOfSpeech'] == e.pos, 'wrong part of speech')
            require(q['prompt'] == prompt_for(e, direction), 'wrong prompt')
            opts, idx, words = q['options'], q['correctOptionIndex'], q['optionWords']
            require(len(opts) == 4 and all((isinstance(x, str) and x.strip() == x and x for x in opts)), 'four nonempty options required')
            require(len(set(opts)) == 4 and len(set(words)) == len(words) == 4, 'duplicate options')
            require(type(idx) is int and 0 <= idx < 4, 'invalid correct index')
            require(words[idx] == e.word, 'wrong answer word')
            selected = [lookup[w] for w in words]
            expected = [x.meaning if direction == 'en_to_zh' else x.word for x in selected]
            require(opts == expected, 'options do not match source')
            require(all(((PURE_HAN if direction == 'en_to_zh' else WORD).fullmatch(x) for x in opts)), 'wrong option language')
            require(all((compatible(a, b, lookup, neighbours) for (i, a) in enumerate(selected) for b in selected[i + 1:])), 'semantic conflict')
            require(q['id'] not in ids, 'duplicate id')
            require(q['prompt'] not in prompts, 'duplicate prompt')
            require((e.word, direction) not in pairs, 'duplicate word/direction')
            ids.add(q['id']); prompts.add(q['prompt']); pairs.add((e.word, direction))
        except (AssertionError, KeyError, TypeError, ValueError, IndexError) as exc:
            errors.append({'id': q.get('id'), 'error': str(exc)})
    return errors


def import_limits() -> dict[str, int]:
    """Read Pingo field limits and retain the converter's existing shard size."""
    source = (ROOT / 'src/shared/question-bank.ts').read_text()
    limits = {'importQuestions': 3_000}  # Export batching preference, not an importer limit.
    for key in ('name', 'prompt', 'referenceAnswer', 'option', 'minOptions', 'maxOptions', 'importBytes'):
        match = re.search(rf'\b{key}:\s*([\d_]+(?:\s*\*\s*[\d_]+)*)\s*,', source)
        if not match:
            raise ValueError(f'无法读取 Pingo 限制 {key}，请检查字段规范是否已改变。')
        value = 1
        for part in match[1].split('*'):
            value *= int(part.strip().replace('_', ''))
        limits[key] = value
    return limits


def encode_bank(name: str, questions: list[dict]) -> bytes:
    return (json.dumps({'name': name, 'questions': questions}, ensure_ascii=False, indent=2) + '\n').encode('utf-8')


def utf16_length(value: str) -> int:
    return len(value.encode('utf-16-le')) // 2


def bank_fits(name: str, questions: list[dict], limits: dict) -> bool:
    return (0 < len(questions) <= limits['importQuestions']
            and utf16_length(name) <= limits['name']
            and len(encode_bank(name, questions)) <= limits['importBytes'])


def plan_exports(questions: list[dict], mode: str, limits: dict) -> tuple[dict[str, bytes], list[str]]:
    files = {}
    importable = []
    modes = ['en_to_zh', 'zh_to_en', 'all'] if mode == 'all' else [mode]
    for direction in modes:
        subset = [q for q in questions if direction == 'all' or q['direction'] == direction]
        if not subset:
            continue  # Pingo rejects empty banks; never present one as importable.
        name = f'CET4 {direction}'
        filename = f'cet4_{direction}.json'
        files[filename] = encode_bank(name, subset)
        if bank_fits(name, subset, limits):
            importable.append(filename)
            continue
        # Incremental exact byte accounting, including pretty-print overhead of the wrapper.
        chunks, chunk = [], []
        overhead = len(encode_bank(name + ' 999999', []))
        size = overhead
        for question in subset:
            single_size = len(encode_bank(name, [question])) - len(encode_bank(name, [])) + 2
            if chunk and (len(chunk) >= limits['importQuestions'] or size + single_size > limits['importBytes']):
                chunks.append(chunk)
                chunk, size = [], overhead
            chunk.append(question)
            size += single_size
        if chunk:
            chunks.append(chunk)
        for i, chunk in enumerate(chunks, 1):
            chunk_name = f'{name} {i}'
            if not bank_fits(chunk_name, chunk, limits):
                raise ValueError('单题或分片超过 Pingo 导入限制。')
            chunk_file = f'cet4_{direction}.part{i:03d}.json'
            files[chunk_file] = encode_bank(chunk_name, chunk)
            importable.append(chunk_file)
    return files, importable


def export_files(output: Path, files: dict[str, bytes], source: Path) -> list[str]:
    # Preflight every destination; never overwrite source or existing generated/user files.
    targets = [output / name for name in files]
    for target in targets:
        if target.resolve() == source.resolve():
            raise ValueError('输出路径指向原始词库。')
        if target.exists():
            raise ValueError(f'拒绝覆盖已有文件：{target}；请指定新的输出目录。')
    output.mkdir(parents=True, exist_ok=True)
    paths = []
    for target, data in zip(targets, files.values()):
        with target.open('xb') as handle:
            handle.write(data)
        require(json.loads(target.read_bytes()) == json.loads(data), 'JSON 回读不一致')
        paths.append(str(target.resolve()))
    return paths


def export_existing_bank(source: Path, output: Path, dry_run: bool = False) -> int:
    """Strip audit metadata from an existing bank, preserving order and answers."""
    if source.is_dir():
        # Other files in this directory are overlapping direction/shard copies.
        source = source / 'cet4_all.json'
    bank = json.loads(source.read_text(encoding='utf-8-sig'))
    require(isinstance(bank, dict), '题库必须为 JSON 对象')
    limits = import_limits()
    name = bank.get('name')
    require(isinstance(name, str) and 0 < utf16_length(name.strip()) <= limits['name'], '题库名称无效或超长')
    source_questions = bank.get('questions')
    require(isinstance(source_questions, list) and bool(source_questions), '题库缺少 questions 数组或没有题目')
    questions, seen = [], set()
    for index, question in enumerate(source_questions, 1):
        require(isinstance(question, dict), f'第 {index} 题必须为对象')
        kind, prompt = question.get('kind'), question.get('prompt')
        require(isinstance(prompt, str) and bool(prompt.strip()) and '\0' not in prompt
                and utf16_length(prompt) <= limits['prompt'], f'第 {index} 题题干无效或超长')
        result = {'kind': kind, 'prompt': prompt}
        if kind == 'multiple-choice':
            options, correct = question.get('options'), question.get('correctOptionIndex')
            require(isinstance(options, list) and limits['minOptions'] <= len(options) <= limits['maxOptions'], f'第 {index} 题选项数量无效')
            require(all(isinstance(o, str) and bool(o.strip()) and '\0' not in o
                        and utf16_length(o) <= limits['option'] for o in options), f'第 {index} 题选项无效或超长')
            require(len(set(o.strip() for o in options)) == len(options), f'第 {index} 题有重复选项')
            if type(correct) is int and 0 <= correct < len(options):
                result.update(options=options.copy(), correctOptionIndex=correct)
            else:
                # An absent/unreliable answer is never guessed.
                result['kind'] = 'short-answer'
                result['prompt'] += '\n\n' + '\n'.join(f'{chr(65+i)}. {o}' for i, o in enumerate(options))
                require(utf16_length(result['prompt']) <= limits['prompt'], f'第 {index} 题保留选项后题干超长')
        elif kind == 'short-answer':
            answer = question.get('referenceAnswer')
            if answer is not None:
                require(isinstance(answer, str) and '\0' not in answer
                        and utf16_length(answer) <= limits['referenceAnswer'], f'第 {index} 题参考答案无效或超长')
                if answer.strip():
                    result['referenceAnswer'] = answer
        else:
            raise ValueError(f'第 {index} 题题型不受支持：{kind}')
        key = json.dumps(result, ensure_ascii=False, sort_keys=True)
        if key not in seen:
            seen.add(key)
            questions.append(result)

    files, chunk = {}, []
    batch = 1

    def batch_name(number: int) -> str:
        suffix = f' 第{number}批'
        title = name.strip()
        while utf16_length(title + suffix) > limits['name']:
            title = title[:-1]
        return title + suffix

    def save_chunk() -> None:
        title = batch_name(batch)
        require(bank_fits(title, chunk, limits), '单题或分片超过 Pingo 导入限制')
        files[f'cet4_import.part{batch:03d}.json'] = encode_bank(title, chunk)

    # Keep exact JSON byte accounting without repeatedly serializing whole banks.
    size = len(encode_bank(batch_name(batch), []))
    for question in questions:
        title = batch_name(batch)
        delta = len(encode_bank(title, [question])) - len(encode_bank(title, [])) + (2 if chunk else 0)
        if chunk and (len(chunk) >= limits['importQuestions'] or size + delta > limits['importBytes']):
            save_chunk()
            batch += 1
            chunk = []
            size = len(encode_bank(batch_name(batch), []))
            delta = len(encode_bank(batch_name(batch), [question])) - size
        chunk.append(question)
        size += delta
    if chunk:
        save_chunk()
    paths = [] if dry_run else export_files(output, files, source)
    print(f'输入题目: {len(source_questions)}；去重后: {len(questions)}；分片: {len(files)}')
    print('保留原题顺序、选项顺序和已提供的答案；语义正确性未重新审核。')
    print('输出文件:\n' + ('\n'.join(paths) if paths else '\n'.join(files) + '\n（dry-run，未写文件）'))
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--input', type=Path, required=True)
    parser.add_argument('--output', type=Path, default=ROOT / 'data/cet4')
    parser.add_argument('--mode', choices=['en_to_zh', 'zh_to_en', 'all'], default='all')
    parser.add_argument('--seed', type=int, default=42)
    parser.add_argument('--limit', type=int, help='总题数上限（非每种题型的数量），正整数')
    parser.add_argument('--dry-run', action='store_true')
    parser.add_argument('--from-bank', action='store_true', help='精简并分片已有 Pingo JSON；input 可为合并文件或含 cet4_all.json 的目录，不重新生成题目')
    args = parser.parse_args(argv)
    if args.limit is not None and args.limit <= 0:
        parser.error('--limit 必须为正整数')
    try:
        if args.from_bank:
            require(args.mode == 'all' and args.limit is None and args.seed == 42,
                    '--from-bank 保留全部原题，不支持 --mode、--limit 或非默认 --seed')
            return export_existing_bank(args.input, args.output, args.dry_run)
        rows = read_source(args.input)
        entries, stats = clean_entries(rows)
        questions, generation = generate(entries, args.mode, args.seed, args.limit)
        failures = validate(questions, entries)
        limits = import_limits()
        for q in questions:
            if (utf16_length(q['prompt']) > limits['prompt']
                    or any(utf16_length(o) > limits['option'] for o in q['options'])):
                failures.append({'id': q['id'], 'error': 'Pingo 字段超长'})
        stats.update(generation)
        stats.update({'seed': args.seed, 'mode': args.mode, 'limit': args.limit,
                      'en_to_zh': sum(q['direction'] == 'en_to_zh' for q in questions),
                      'zh_to_en': sum(q['direction'] == 'zh_to_en' for q in questions),
                      'total_questions': len(questions), 'validation_failures': failures,
                      'answer_position_counts': dict(Counter(q['correctOptionIndex'] for q in questions)),
                      'source_sha256': hashlib.sha256(args.input.read_bytes()).hexdigest(),
                      'semantic_review_required': len(questions),
                      'semantic_review_note': '全部题目仅通过离线启发式检查，未人工审核。源词库可能缺失义项或包含错误；同义词规则非完备词典，不能保证不存在语义歧义。',
                      'semantic_rules': ['合并重复单词的全部释义', '排除全部释义中的汉字重叠（去除少量虚词）及包含关系',
                                         '排除常见英文同义组、词形前缀关系', '排除共享释义词条的一跳语义冲突',
                                         '四个选项两两检查，优先同词性，括号限定语不擅自删除'],
                      'pingo_limits': limits})
        if failures:
            print(json.dumps(stats, ensure_ascii=False, indent=2))
            return 1  # Fail closed: never export a bank with known validation failures.
        files, importable = plan_exports(questions, args.mode, limits)
        stats['direct_import_files'] = importable
        stats['planned_files'] = list(files)
        # Detect invalid serialized JSON before any disk mutation, including dry run.
        for data in files.values():
            json.loads(data)
        stats['previews'] = {}
        for direction in ('en_to_zh', 'zh_to_en'):
            subset = [q for q in questions if q['direction'] == direction]
            stats['previews'][direction] = random.Random(f'{args.seed}:preview:{direction}').sample(subset, min(5, len(subset)))
        if not args.dry_run:
            files['cet4_report.json'] = (json.dumps(stats, ensure_ascii=False, indent=2) + '\n').encode()
            paths = export_files(args.output, files, args.input)
        else:
            paths = []
        for key in ('raw_entries', 'unique_words', 'valid_entries', 'invalid_rows', 'invalid_unique_words', 'en_to_zh', 'zh_to_en', 'total_questions', 'skipped_entries', 'words_not_generated'):
            print(f'{key}: {stats[key]}')
        print('清洗原因（互斥行数，duplicate_rows_merged 仅含有效单词的重复行）:', json.dumps(stats['cleaning_counts'], ensure_ascii=False))
        print('生成跳过原因:', dict(Counter(x['reason'] for x in stats['generation_skipped'])))
        print('校验失败: 0')
        print('人工语义复核:', stats['semantic_review_note'])
        print('可直接导入（各题型与 all 为替代集合，请勿重复导入）:', ', '.join(importable) or '无')
        print('生成文件:', '\n'.join(paths) or 'dry-run：未写文件')
        for direction, preview in stats['previews'].items():
            print(f'\n{direction} 随机预览:')
            for q in preview:
                print(q['prompt'])
                print(' / '.join(f'{chr(65+i)}. {o}' for i, o in enumerate(q['options'])))
                print('答案:', chr(65 + q['correctOptionIndex']))
        return 0 if questions else 1
    except (OSError, ValueError) as exc:
        print(f'转换失败：{exc}', file=sys.stderr)
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
