#!/usr/bin/env python3
"""Convert local vocabulary/Pingo JSON to appendable language-template questions.

Python 3.9+, standard library only. Never invent answers or overwrite inputs.
"""
from __future__ import annotations

import argparse
from collections import Counter, defaultdict
import hashlib
import json
from pathlib import Path
import re
import sys
import unicodedata

if __package__:
    from . import language_difficulty as grading
    from . import convert_vocabulary as choices
else:
    import language_difficulty as grading
    import convert_vocabulary as choices

ROOT = Path(__file__).resolve().parents[1]
LANGUAGE_KINDS = {
    'word-to-meaning': 'multiple-choice', 'meaning-to-word': 'multiple-choice',
    'word-spelling': 'short-answer', 'word-fill-in': 'fill-in',
    'synonym': 'multiple-choice', 'antonym': 'multiple-choice',
    'grammar-choice': 'multiple-choice', 'grammar-fill-in': 'fill-in',
    'grammar-correction': 'short-answer', 'sentence-ordering': 'ordering',
    'sentence-meaning': 'multiple-choice', 'context-word-choice': 'multiple-choice',
}
PARTS_OF_SPEECH = {**choices.POS_LABELS, 'det': '限定词'}
PART_OF_SPEECH_TAGS = {label: tag for tag, label in PARTS_OF_SPEECH.items()}


def units(value: str) -> int:
    return len(value.encode('utf-16-le')) // 2


def require(ok: bool, reason: str) -> None:
    if not ok:
        raise ValueError(reason)


def limits_from_project() -> dict[str, int]:
    source = (ROOT / 'src/shared/question-bank.ts').read_text(encoding='utf-8')
    result = {}
    for key in ('prompt', 'referenceAnswer', 'option', 'minOptions', 'maxOptions', 'maxBlanks', 'maxItems', 'conceptKey', 'materialKey', 'materialTitle', 'maxExamples', 'importBytes'):
        match = re.search(rf'\b{key}:\s*([\d_]+(?:\s*\*\s*[\d_]+)*)\s*,', source)
        require(match is not None, f'cannot_read_project_limit:{key}')
        value = 1
        for part in match[1].split('*'):
            value *= int(part.strip().replace('_', ''))
        result[key] = value
    result['importBytes'] = min(result['importBytes'], 32 * 1024 * 1024)
    return result


def text(value: object, maximum: int, field: str) -> str:
    require(isinstance(value, str) and bool(value.strip()), f'missing_or_invalid:{field}')
    require(not any(unicodedata.category(c) in ('Cc', 'Cs') and c not in '\n\r\t' for c in value)
            and '\ufffd' not in value, f'abnormal_character:{field}')
    require(units(value) <= maximum, f'too_long:{field}')
    return value  # Preserve source spelling, punctuation, whitespace and option order.


def normalized_key(value, maximum, field):
    require(isinstance(value, str), f'missing_or_invalid:{field}')
    return text(' '.join(unicodedata.normalize('NFKC', value).lower().split()), maximum, field)


def validate_material(row, limits):
    require(isinstance(row, dict), 'invalid_material_object')
    material = {
        'key': normalized_key(row.get('key'), limits['materialKey'], 'materialKey'),
        'title': text(row.get('title'), limits['materialTitle'], 'materialTitle'),
        'explanation': text(row.get('explanation'), limits['referenceAnswer'], 'materialExplanation'),
    }
    examples = row.get('examples', [])
    require(isinstance(examples, list) and len(examples) <= limits['maxExamples'], 'invalid_material_examples')
    for example in examples:
        require(isinstance(example, dict), 'invalid_material_example_object')
        entry = {'text': text(example.get('text'), limits['option'], 'exampleText')}
        if example.get('translation') is not None:
            entry['translation'] = text(example['translation'], limits['option'], 'exampleTranslation')
        material.setdefault('examples', []).append(entry)
    return material


def strings(value: object, minimum: int, maximum: int, length: int, field: str) -> list[str]:
    require(isinstance(value, list) and minimum <= len(value) <= maximum, f'invalid_count:{field}')
    return [text(v, length, field) for v in value]


def validate_question(row: dict, limits: dict) -> dict:
    """Normalize supported fields; reject missing or contradictory answer structures."""
    require(isinstance(row, dict), 'invalid_question_object')
    kind = row.get('kind')
    q = {'kind': kind, 'prompt': text(row.get('prompt'), limits['prompt'], 'prompt')}
    category = row.get('languageType')
    if category is None and kind == 'multiple-choice':
        category = {'en_to_zh': 'word-to-meaning', 'zh_to_en': 'meaning-to-word'}.get(
            row.get('direction') if isinstance(row.get('direction'), str) else None)
    if 'difficulty' in row:
        difficulty = row['difficulty']
        require(type(difficulty) is int and 1 <= difficulty <= 5, 'invalid_difficulty')
        q['difficulty'] = difficulty
    if 'materialKey' in row:
        q['materialKey'] = normalized_key(row['materialKey'], limits['materialKey'], 'materialKey')
    if 'conceptKey' in row:
        key = text(row['conceptKey'], limits['conceptKey'], 'conceptKey')
        text(grading.normalize(key), limits['conceptKey'], 'normalized_conceptKey')
        q['conceptKey'] = key
    if category is not None:
        require(isinstance(category, str) and LANGUAGE_KINDS.get(category) == kind,
                'language_type_kind_mismatch')
        q['languageType'] = category
    if kind == 'multiple-choice':
        opts = strings(row.get('options'), limits['minOptions'], limits['maxOptions'], limits['option'], 'options')
        require(len({o.strip() for o in opts}) == len(opts), 'duplicate_options')
        correct = row.get('correctOptionIndex')
        require(type(correct) is int and 0 <= correct < len(opts), 'missing_or_invalid_correct_answer')
        q.update(options=opts, correctOptionIndex=correct)
        explanations = row.get('optionExplanations')
        if explanations is not None:
            require(isinstance(explanations, list) and len(explanations) == len(opts), 'explanation_count_mismatch')
            q['optionExplanations'] = [None if e is None else text(e, limits['option'], 'optionExplanations') for e in explanations]
        elif category == 'word-to-meaning' and 'optionWords' in row:
            q['optionExplanations'] = strings(row['optionWords'], len(opts), len(opts), limits['option'], 'optionWords')
        elif category in ('word-to-meaning', 'meaning-to-word'):
            q['optionExplanations'] = [None] * len(opts)
            if category == 'meaning-to-word' and isinstance(row.get('meaning'), str):
                q['optionExplanations'][correct] = text(row['meaning'], limits['option'], 'meaning')
        if 'optionPartsOfSpeech' in row:
            parts = row['optionPartsOfSpeech']
            require(isinstance(parts, list) and len(parts) == len(opts), 'part_of_speech_count_mismatch')
            tags = []
            for part in parts:
                if part is None:
                    tags.append(None)
                    continue
                require(isinstance(part, str), 'invalid_part_of_speech')
                tag = unicodedata.normalize('NFKC', part).strip().lower().removesuffix('.')
                tag = PART_OF_SPEECH_TAGS.get(tag, choices.POS_ALIASES.get(tag, tag))
                require(tag in PARTS_OF_SPEECH, 'invalid_part_of_speech')
                tags.append(tag)
            q['optionPartsOfSpeech'] = tags
    elif kind == 'short-answer':
        accepted = row.get('acceptedAnswers')
        reference = row.get('referenceAnswer')
        if accepted is not None:
            q['acceptedAnswers'] = strings(accepted, 1, limits['maxOptions'], limits['referenceAnswer'], 'acceptedAnswers')
        if reference is not None:
            q['referenceAnswer'] = text(reference, limits['referenceAnswer'], 'referenceAnswer')
        if category in ('word-spelling', 'grammar-correction'):
            require(accepted is not None, 'missing_accepted_answers')
        require(accepted is not None or reference is not None, 'missing_answer')
        # A reference answer can be an explanation for generic self-assessment questions.
        if category == 'word-spelling' and accepted is not None and reference is not None:
            require(reference in accepted, 'conflicting_reference_answer')
    elif kind == 'fill-in':
        count = q['prompt'].count('{{blank}}')
        require(1 <= count <= limits['maxBlanks'], 'invalid_blank_marker_count')
        blanks = row.get('blanks')
        require(isinstance(blanks, list) and len(blanks) == count, 'blank_answer_count_mismatch')
        q['blanks'] = [strings(b, 1, limits['maxOptions'], limits['option'], 'blanks') for b in blanks]
    elif kind == 'ordering':
        items = strings(row.get('items'), 2, limits['maxItems'], limits['option'], 'items')
        require(len({item.strip() for item in items}) >= 2, 'ordering_needs_distinct_items')
        order = row.get('correctOrder')
        require(isinstance(order, list) and len(order) == len(items)
                and all(type(i) is int for i in order)
                and sorted(order) == list(range(len(items))), 'invalid_order_permutation')
        q.update(items=items, correctOrder=order)
    else:
        raise ValueError('unsupported_kind')
    return q


def vocabulary_question(row: dict, limits: dict) -> dict:
    require(isinstance(row, dict), 'invalid_vocabulary_record')
    word = text(row.get('word'), limits['referenceAnswer'], 'word')
    require(re.fullmatch(r"[A-Za-z]+(?:[-' ][A-Za-z]+)*", word) is not None, 'invalid_english_word')
    translations = row.get('translations')
    require(isinstance(translations, list) and bool(translations), 'missing_translations')
    lines = []
    for translation in translations:
        require(isinstance(translation, dict), 'invalid_translation_object')
        meaning = text(translation.get('translation'), limits['prompt'], 'translation')
        require(re.search(r'[\u3400-\u9fff]', meaning) is not None, 'missing_chinese_translation')
        pos = translation.get('type')
        if pos is not None:
            pos = text(pos, limits['option'], 'part_of_speech')
        lines.append((f'[{pos}] ' if pos else '') + meaning)
    # Every translation and its original POS are preserved, without selecting a sense.
    return validate_question({
        'kind': 'short-answer', 'languageType': 'word-spelling',
        'prompt': '根据以下中文释义，输入对应的英文单词。\n' + '\n'.join(lines),
        'acceptedAnswers': [word], 'referenceAnswer': word,
    }, limits)


def signature(q: dict) -> str:
    return json.dumps(q, ensure_ascii=False, sort_keys=True, separators=(',', ':'))


def convert(rows: list, vocabulary: bool, limits: dict) -> tuple[list[dict], list[dict], list[dict]]:
    pending, skipped, review = [], [], []
    for number, row in enumerate(rows, 1):
        try:
            q = vocabulary_question(row, limits) if vocabulary else validate_question(row, limits)
            pending.append((number, q))
            if vocabulary and any(re.search(r'[�…]|\.{2,}', t['translation']) for t in row['translations']):
                review.append({'source_number': number, 'word': row['word'], 'reason': 'ellipsis_in_source_translation',
                               'source_record': row})
        except (ValueError, TypeError) as exc:
            skipped.append({'source_number': number, 'reason': str(exc), 'source_record': row})
    # The same full prompt and choices cannot safely carry differing answer keys.
    groups = defaultdict(list)
    for number, q in pending:
        context = {k: q[k] for k in ('kind', 'prompt', 'languageType', 'options', 'items') if k in q}
        groups[signature(context)].append((number, q))
    conflicts = {}
    for group in groups.values():
        answers = {signature({k: q[k] for k in ('acceptedAnswers', 'referenceAnswer', 'correctOptionIndex', 'blanks', 'correctOrder') if k in q}) for _, q in group}
        if len(answers) > 1:
            for number, _ in group:
                conflicts[number] = [n for n, _ in group]
    questions, seen = [], {}
    for number, q in pending:
        if number in conflicts:
            skipped.append({'source_number': number, 'reason': 'conflicting_answers_for_same_question',
                            'conflicting_source_numbers': conflicts[number], 'source_record': rows[number - 1]})
            continue
        key = signature({k: v for k, v in q.items() if k not in ('difficulty', 'conceptKey')})
        if key in seen:
            skipped.append({'source_number': number, 'reason': 'exact_duplicate',
                            'duplicate_of_source_number': seen[key], 'source_record': rows[number - 1]})
            continue
        seen[key] = number
        questions.append(q)
    skipped.sort(key=lambda x: x['source_number'])
    require(len(rows) == len(questions) + len(skipped), 'input_output_count_mismatch')
    return questions, skipped, review


def generate_recognition(rows, skipped, limits):
    """Use the vetted vocabulary generator, then link each generated item to its source record."""
    entries, _ = choices.clean_entries(rows)
    generated, info = choices.generate(entries, 'all', 42, None)
    require(not choices.validate(generated, entries), 'generated_choice_validation_failed')
    vocabulary = {entry.word: entry for entry in entries}
    rejected = {item['source_number'] for item in skipped}
    locations = {}
    for number, row in enumerate(rows, 1):
        if number in rejected:
            continue
        word = choices.normalized(row['word']).lower()
        if word not in vocabulary or word in locations:
            continue
        if any(vocabulary[word].meaning in {
            part.strip() for part in re.split(r'[,;、/]', choices.normalized(t['translation']))
        } and choices.parse_pos(t.get('type'))
            for t in row['translations']):
            locations[word] = number
    by_record = defaultdict(list)
    unlinked = []
    for row in generated:
        number = locations.get(row['word'])
        if number is None:
            unlinked.append({'word': row['word'], 'direction': row['direction'],
                             'reason': 'no_accepted_source_record_for_selected_gloss'})
            continue
        row['optionExplanations'] = (row['optionWords'] if row['direction'] == 'en_to_zh'
                                     else [vocabulary[word].meaning for word in row['optionWords']])
        row['optionPartsOfSpeech'] = [vocabulary[word].pos for word in row['optionWords']]
        by_record[number].append((row, validate_question(row, limits)))
    return by_record, {
        'source_words_in_distractor_pool': len(entries),
        'seed': 42,
        'recognition_not_exported': info['generation_skipped'] + unlinked,
        'semantic_review': 'Distractors passed the local overlap and synonym checks. Unlisted semantic relationships may still need review.',
    }


def grade(rows, questions, skipped, vocabulary, limits, recognition=None, materials=None):
    """Build the full lexeme table before assigning any question difficulty."""
    evidence = defaultdict(list)
    explicit_tiers = defaultdict(set)
    rejected = {s['source_number'] for s in skipped}
    targets = []
    output = iter(questions)
    for number, row in enumerate(rows, 1):
        if not isinstance(row, dict):
            continue
        if number in rejected:
            if vocabulary and grading.word_form(row.get('word')) is not None:
                evidence[grading.word_form(row['word'])].extend(grading.translation_items(row, {}, True))
                if type(row.get('wordTier')) is int and 1 <= row['wordTier'] <= 4:
                    explicit_tiers[grading.word_form(row['word'])].add(row['wordTier'])
            continue
        q = next(output)
        word = grading.lexical_target(row, q, vocabulary)
        items = grading.translation_items(row, q, vocabulary)
        for choice_row, choice_question in (recognition or {}).get(number, []):
            targets.append((number, choice_question, word,
                            grading.translation_items(choice_row, choice_question, False)))
        targets.append((number, q, word, items))
        if word is not None:
            evidence[word].extend(items)
            tier = row.get('wordTier')
            if type(tier) is int and 1 <= tier <= 4:
                explicit_tiers[word].add(tier)

    lemmas = grading.lemma_table(evidence)
    by_lemma = defaultdict(list)
    forms = defaultdict(list)
    source_tiers = defaultdict(set)
    for word, lemma in lemmas.items():
        forms[lemma].append(word)
        by_lemma[lemma].extend(evidence[word])
        source_tiers[lemma].update(explicit_tiers[word])
    # Use an attested gloss to fill missing option explanations only when the
    # same surface form has a single unambiguous gloss in this input.
    attested = {}
    for word, items in evidence.items():
        meanings = {grading.gloss(t['translation']): t['translation'] for t in items
                    if re.search(r'[\u3400-\u9fff]', t['translation'])}
        if len(meanings) == 1:
            meaning = next(iter(meanings.values()))
            if units(meaning) <= limits['option']:
                attested[word] = meaning

    table = {}
    for lemma, items in sorted(by_lemma.items()):
        distinct_items = {(grading.gloss(t['translation']), grading.pos(t)): t for t in items}
        tiers = source_tiers[lemma]
        tier, basis = grading.estimate(lemma, list(distinct_items.values()), tiers)
        table[lemma] = {
            'tier': tier, 'basis': basis, 'forms': sorted(forms[lemma]),
            'source_tiers': sorted(tiers),
            'provenance': 'source' if len(tiers) == 1 else 'agent_estimate',
            'source_glosses': sorted({t['translation'] for t in items}),
        }

    omitted, overrides = [], []
    by_type = defaultdict(lambda: defaultdict(set))
    for number, q, word, items in targets:
        if q.get('languageType') == 'meaning-to-word':
            q['optionExplanations'] = [
                explanation if explanation is not None else attested.get(grading.word_form(option))
                for option, explanation in zip(q['options'], q['optionExplanations'])
            ]
        old = q.get('difficulty')
        lemma = lemmas.get(word)
        kind = q['kind']
        if lemma is not None:
            offset = int(kind in ('short-answer', 'fill-in'))
            difficulty = table[lemma]['tier'] + offset
            basis = 'word_tier_plus_independent_recall' if offset else 'word_tier'
            if kind == 'multiple-choice' or q.get('languageType') == 'word-spelling':
                by_type[lemma][kind].add(difficulty)
            key = grading.concept_key(lemma, items)
            if key and units(key) <= limits['conceptKey']:
                q.setdefault('conceptKey', key)
            if vocabulary and materials is not None:
                attach_vocabulary_material(q, items, lemma, word, rows[number - 1], key, materials, limits)
        elif old is not None:
            difficulty, basis = old, 'source_question_difficulty'
        else:
            difficulty, basis = grading.direct_difficulty(q)
        if difficulty is None:
            omitted.append({'source_number': number, 'reason': basis, 'prompt': q['prompt']})
        else:
            q['difficulty'] = difficulty
            if old is not None and old != difficulty:
                overrides.append({'source_number': number, 'source_difficulty': old,
                                  'output_difficulty': difficulty, 'reason': basis})
        validate_question(q, limits)

    compared = 0
    for lemma, kinds in by_type.items():
        if 'multiple-choice' in kinds and 'short-answer' in kinds:
            require(kinds['multiple-choice'] == {table[lemma]['tier']}
                    and kinds['short-answer'] == {table[lemma]['tier'] + 1},
                    f'cross_file_difficulty_mismatch:{lemma}')
            compared += 1
    word_counts = Counter(item['tier'] for item in table.values())
    questions[:] = [q for _, q, _, _ in targets]
    question_counts = Counter(q.get('difficulty') for q in questions)
    return {
        'method': 'Local rubric anchors, source POS and gloss cues. Unlisted words without sufficient cues use a provisional general tier 3. Estimates are not measured frequencies or official textbook levels.',
        'word_tiers_by_lemma': table,
        'word_tier_counts': {i: word_counts[i] for i in range(1, 5)},
        'question_difficulty_counts': {i: question_counts[i] for i in range(1, 6)},
        'questions_without_difficulty': omitted,
        'source_difficulty_overrides': overrides,
        'lemmas_checked_in_both_choice_and_spelling': compared,
    }


def attach_vocabulary_material(q, items, lemma, word, row, concept, materials, limits):
    if concept and units(concept) <= limits['materialKey']:
        key = concept
        title = lemma
    else:
        # Full-gloss spelling prompts use a separate card from a single selected sense.
        # Include the surface form so distinct inflections cannot share an ambiguous card.
        scope = sorted({(grading.pos(item), grading.gloss(item['translation'])) for item in items})
        digest = hashlib.sha256(signature([word, scope]).encode('utf-8')).hexdigest()[:24]
        key = f'cet4:gloss-set:{digest}'
        title = row['word']
    if key not in materials:
        explanation = '\n'.join(
            (f"[{item['type']}] " if item.get('type') else '') + item['translation']
            for item in items
        )
        materials[key] = validate_material(
            {'key': key, 'title': title, 'explanation': explanation}, limits)
    # The source has bilingual phrases rather than sentence examples. Keep a phrase
    # only if its translation explicitly includes an attested gloss for this card.
    phrases = row.get('phrases')
    if isinstance(phrases, list):
        glosses = {grading.gloss(item['translation']) for item in items}
        examples = materials[key].get('examples', [])
        for phrase in phrases:
            if len(examples) >= limits['maxExamples']:
                break
            if not isinstance(phrase, dict):
                continue
            form, translation = phrase.get('phrase'), phrase.get('translation')
            if not isinstance(form, str) or not isinstance(translation, str):
                continue
            form_words = re.findall(r"[a-z]+", grading.normalize(form))
            if ' ' in word or word not in form_words:
                continue
            meaning = grading.gloss(translation)
            if not any(len(g) >= 2 and g in meaning for g in glosses):
                continue
            try:
                example = {'text': text(form, limits['option'], 'exampleText'),
                           'translation': text(translation, limits['option'], 'exampleTranslation')}
            except ValueError:
                continue
            if example not in examples:
                examples.append(example)
        if examples:
            materials[key]['examples'] = examples
    q['materialKey'] = key


def fragment(value) -> bytes:
    return json.dumps(value, ensure_ascii=False, separators=(',', ':'), allow_nan=False).encode('utf-8')


def render(questions, materials):
    data = b'{"questions":[' + b',\n'.join(questions) + b']'
    if materials:
        data += b',\n"materials":[' + b',\n'.join(materials) + b']'
    return data + b'}\n'


def encode(questions: list[dict]) -> bytes:
    return render(map(fragment, questions), [])


def split_files(questions: list[dict], maximum: int, materials=None) -> dict[str, bytes]:
    require(bool(questions), 'no_convertible_questions')
    encoded_materials = {key: fragment(value) for key, value in (materials or {}).items()}
    files, chunk, attached = {}, [], {}
    empty_size = len(render([], []))
    size = empty_size
    material_overhead = len(b',\n"materials":[]')
    for question in questions:
        q = fragment(question)
        key = question.get('materialKey')
        require(key is None or key in encoded_materials, f'missing_material:{key}')
        m = encoded_materials.get(key)
        delta = len(q) + (2 if chunk else 0)
        if m is not None and key not in attached:
            delta += len(m) + (2 if attached else material_overhead)
        if chunk and size + delta > maximum:
            files[f'cet4_language.part{len(files)+1:03d}.json'] = render(chunk, attached.values())
            chunk, attached, size = [], {}, empty_size
            delta = len(q) + (len(m) + material_overhead if m is not None else 0)
        require(size + delta <= maximum, 'single_question_exceeds_file_limit')
        chunk.append(q)
        if m is not None:
            attached[key] = m
        size += delta
    if chunk:
        files[f'cet4_language.part{len(files)+1:03d}.json'] = render(chunk, attached.values())
    for data in files.values():
        bank = json.loads(data)
        require(len(data) <= maximum and bool(bank['questions']), 'invalid_output_file')
        keys = {q['materialKey'] for q in bank['questions'] if 'materialKey' in q}
        require(keys == {m['key'] for m in bank.get('materials', [])}, 'material_reference_mismatch')
    return files


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--input', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--max-bytes', type=int, help='可降低分片字节上限，不可超过项目限制或 32 MiB')
    parser.add_argument('--with-recognition', action='store_true', help='词表输入额外生成英译中和中译英选择题')
    parser.add_argument('--questions-only', action='store_true', help='仅导出练习题，移除学习资料及引用')
    parser.add_argument('--dry-run', action='store_true')
    args = parser.parse_args(argv)
    try:
        raw = args.input.read_bytes()
        document = json.loads(raw.decode('utf-8-sig'))
        if isinstance(document, dict):
            rows, vocabulary = document.get('questions'), False
        else:
            rows, vocabulary = document, isinstance(document, list) and any(isinstance(r, dict) and 'word' in r and 'kind' not in r for r in document)
        require(isinstance(rows, list), 'expected_vocabulary_array_or_questions_object')
        limits = limits_from_project()
        maximum = args.max_bytes if args.max_bytes is not None else limits['importBytes']
        require(0 < maximum <= limits['importBytes'], 'invalid_file_byte_limit')
        questions, skipped, review = convert(rows, vocabulary, limits)
        converted_records = len(questions)
        recognition, recognition_report = {}, None
        if args.with_recognition:
            require(vocabulary, '--with-recognition requires a vocabulary array')
            recognition, recognition_report = generate_recognition(rows, skipped, limits)
        materials = {}
        if isinstance(document, dict) and 'materials' in document:
            require(isinstance(document['materials'], list), 'invalid_materials_array')
            for original in document['materials']:
                material = validate_material(original, limits)
                key = material['key']
                require(key not in materials, f'duplicate_material_key:{key}')
                materials[key] = material
        difficulty_report = grade(rows, questions, skipped, vocabulary, limits, recognition,
                                  materials if not args.questions_only else None)
        if args.questions_only:
            for question in questions:
                question.pop('materialKey', None)
            materials.clear()
        files = split_files(questions, maximum, materials) if questions else {}
        exported = [q for data in files.values() for q in json.loads(data)['questions']]
        require(exported == questions, 'export_order_or_content_mismatch')
        referenced_materials = {q['materialKey'] for q in questions if 'materialKey' in q}
        report = {
            'input_file': str(args.input.resolve()), 'encoding': 'UTF-8 with BOM' if raw.startswith(b'\xef\xbb\xbf') else 'UTF-8',
            'source_sha256': hashlib.sha256(raw).hexdigest(),
            'source_format': 'vocabulary_array' if vocabulary else 'pingo_questions',
            'answer_location': 'word (translations supply prompt/context)' if vocabulary else 'per-question answer fields',
            'conversion_strategy': ('word-spelling plus screened recognition choices' if args.with_recognition
                                     else 'one word-spelling question per converted record') if vocabulary
                                    else 'preserve existing question and answer order',
            'input_records': len(rows), 'converted_records': converted_records, 'output_questions': len(questions), 'skipped_records': len(skipped),
            'counts_match': len(rows) == converted_records + len(skipped),
            'question_counts_by_type': dict(Counter(q.get('languageType', q['kind']) for q in questions)),
            'recognition': recognition_report,
            'learning_materials': {
                'unique_exported': len(referenced_materials),
                'linked_questions': sum('materialKey' in q for q in questions),
                'with_examples': sum(bool(material.get('examples')) for material in materials.values()
                                     if material['key'] in referenced_materials),
                'original_examples_written': 0,
                'example_policy': 'Preserve supplied examples. For vocabulary, retain source bilingual phrases only when the word and a card gloss can be matched.',
            },
            'skip_reason_counts': dict(Counter(s['reason'] for s in skipped)), 'skipped': skipped,
            'source_review': review,
            'difficulty': difficulty_report,
            'semantic_review_note': 'Uses only explicit source answers. Exact prompt/answer conflicts are excluded; source translation correctness and unlisted synonyms have not been independently verified.',
            'phrases_policy': 'Vocabulary phrases are supplementary examples, not standalone answers; all standalone translations and POS are preserved.',
            'validation': {'failures_exported': 0, 'length_unit': 'UTF-16 code units (matches Pingo)', 'file_limit_bytes': maximum},
            'files': [{'path': str((args.output / name).resolve()), 'questions': len(json.loads(data)['questions']), 'bytes': len(data)} for name, data in files.items()],
        }
        files['conversion_report.json'] = (json.dumps(report, ensure_ascii=False, indent=2) + '\n').encode('utf-8')
        for name in files:
            target = args.output / name
            require(target.resolve() != args.input.resolve(), 'output_is_source_file')
            require(not target.exists(), f'refuse_to_overwrite:{target}')
        if not args.dry_run:
            args.output.mkdir(parents=True, exist_ok=True)
            for name, data in files.items():
                target = args.output / name
                with target.open('xb') as handle:
                    handle.write(data)
                require(json.loads(target.read_bytes()) == json.loads(data), 'json_readback_mismatch')
        require(hashlib.sha256(args.input.read_bytes()).hexdigest() == report['source_sha256'], 'source_changed_during_conversion')
        print(json.dumps({k: report[k] for k in ('input_records', 'converted_records', 'output_questions', 'skipped_records', 'counts_match', 'question_counts_by_type', 'skip_reason_counts', 'files')}, ensure_ascii=False, indent=2))
        print('报告:', (args.output / 'conversion_report.json').resolve(), '(dry-run 未写文件)' if args.dry_run else '')
        return 0 if questions else 1
    except (OSError, ValueError) as exc:
        print(f'转换失败: {exc}', file=sys.stderr)
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
