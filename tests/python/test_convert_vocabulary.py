"""Run with: python3 -m unittest discover -s tests/python -v"""
import copy
import importlib.util
import contextlib
import io
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

SCRIPT = Path(__file__).resolve().parents[2] / 'scripts/convert_vocabulary.py'
spec = importlib.util.spec_from_file_location('convert_vocabulary', SCRIPT)
v = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = v
spec.loader.exec_module(v)


def row(word, meaning, pos='n'):
    return {'word': word, 'translations': [{'translation': meaning, 'type': pos}]}


ROWS = [row('apple', '苹果'), row('desk', '书桌'), row('cloud', '云朵'),
        row('river', '河流'), row('music', '音乐'), row('shoe', '鞋子'),
        row('tiger', '老虎'), row('bread', '面包')]


class ConversionTests(unittest.TestCase):
    def setUp(self):
        self.entries, _ = v.clean_entries(ROWS)
        self.questions, _ = v.generate(self.entries, 'all', 42, None)

    def test_existing_bank_export_strips_metadata_deduplicates_and_preserves_order(self):
        with tempfile.TemporaryDirectory() as temp:
            source = Path(temp) / 'cet4_all.json'
            output = Path(temp) / 'clean'
            source.write_bytes(v.encode_bank('CET4', self.questions + [self.questions[0]]))
            before = source.read_bytes()
            with contextlib.redirect_stdout(io.StringIO()):
                v.export_existing_bank(source.parent, output, True)
                self.assertFalse(output.exists())
                v.export_existing_bank(source.parent, output)
            banks = [json.loads(p.read_bytes()) for p in sorted(output.glob('*.json'))]
            expected = [{k: q[k] for k in ('kind', 'prompt', 'options', 'correctOptionIndex')} for q in self.questions]
            self.assertEqual([q for bank in banks for q in bank['questions']], expected)
            self.assertTrue(all(set(b) == {'name', 'questions'} for b in banks))
            self.assertEqual(source.read_bytes(), before)
            with self.assertRaises(ValueError):
                v.export_existing_bank(source, output)

    def test_existing_bank_unknown_answer_becomes_short_answer(self):
        with tempfile.TemporaryDirectory() as temp:
            source = Path(temp) / 'input.json'
            output = Path(temp) / 'output'
            source.write_bytes(v.encode_bank('测试', [
                {'kind': 'multiple-choice', 'prompt': '未知答案', 'options': ['甲', '乙']},
                {'kind': 'short-answer', 'prompt': '问答', 'referenceAnswer': '原答案', 'id': 'ignored'},
                {'kind': 'short-answer', 'prompt': '无答案'}]))
            with contextlib.redirect_stdout(io.StringIO()):
                v.export_existing_bank(source, output)
            questions = json.loads(next(output.glob('*.json')).read_bytes())['questions']
            self.assertEqual(questions, [
                {'kind': 'short-answer', 'prompt': '未知答案\n\nA. 甲\nB. 乙'},
                {'kind': 'short-answer', 'prompt': '问答', 'referenceAnswer': '原答案'},
                {'kind': 'short-answer', 'prompt': '无答案'}])

    def test_existing_bank_invalid_answer_type_and_long_content(self):
        with tempfile.TemporaryDirectory() as temp:
            source, output = Path(temp) / 'input.json', Path(temp) / 'output'
            source.write_bytes(v.encode_bank('测试', [{'kind': 'short-answer', 'prompt': '题目', 'referenceAnswer': '字' * 10001}]))
            with self.assertRaises(ValueError):
                v.export_existing_bank(source, output)
            self.assertFalse(output.exists())
            source.write_bytes(v.encode_bank('测试', [{'kind': 'multiple-choice', 'prompt': '题目', 'options': ['甲', '乙'], 'correctOptionIndex': True}]))
            with contextlib.redirect_stdout(io.StringIO()):
                v.export_existing_bank(source, output)
            self.assertEqual(json.loads(next(output.glob('*.json')).read_bytes())['questions'][0]['kind'], 'short-answer')

    def test_merge_duplicates_and_all_polysemous_senses(self):
        entries, stats = v.clean_entries([row('bank', '银行'), row('BANK', '河岸'), row('shore', '河岸')])
        bank = next(e for e in entries if e.word == 'bank')
        shore = next(e for e in entries if e.word == 'shore')
        self.assertEqual(bank.senses, {'银行', '河岸'})
        self.assertTrue(v.conflicts(bank, shore))
        self.assertEqual(stats['cleaning_counts']['duplicate_rows_merged'], 1)

    def test_synonyms_without_shared_chinese_characters(self):
        entries, _ = v.clean_entries([row('big', '巨型', 'adj'), row('large', '庞大', 'adj')])
        self.assertTrue(v.conflicts(*entries))

    def test_synonym_bridge_uses_unselected_sense(self):
        entries, _ = v.clean_entries([row('alpha', '完成'), row('beta', '完成；达成'), row('gamma', '达成')])
        lookup = {e.word: e for e in entries}
        self.assertFalse(v.compatible(lookup['alpha'], lookup['gamma'], lookup, v.semantic_neighbours(entries)))

    def test_invalid_records_and_incomplete_definitions(self):
        rows = [None, row('', '空白'), row('abc!', '异常'), row('empty', ''),
                row('bad', '未知\x00'), row('partial', '部分…'), row('unknown', '已知', '???'),
                row('english', 'english'), row('qualified', '取得(资格)'),
                {'word': 'missing'}, row('bad-list', '测试')]
        rows[-1]['translations'] = 'wrong'
        entries, stats = v.clean_entries(rows)
        self.assertEqual(entries, [])
        self.assertEqual(stats['skipped_entries'], len(rows))

    def test_choose_clear_sense_without_stripping_qualifiers(self):
        entries, _ = v.clean_entries([row('test', '取得(资格)；完成；发展')])
        self.assertEqual(entries[0].meaning, '完成')
        self.assertIn('取得资格', entries[0].senses)

    def test_one_character_noun_and_known_source_typo(self):
        entries, _ = v.clean_entries([row('needle', '针，缝补，编织针'), row('portrait', '消像，画像')])
        self.assertEqual({e.word: e.meaning for e in entries}, {'needle': '针', 'portrait': '画像'})

    def test_counts_reconcile_when_invalid_words_have_duplicates(self):
        _, stats = v.clean_entries(ROWS + [row('bad', '未知…'), row('bad', '异常…'), ROWS[0]])
        self.assertEqual(stats['raw_entries'], stats['valid_entries'] + stats['invalid_rows'] + stats['cleaning_counts']['duplicate_rows_merged'])
        self.assertEqual(stats['invalid_rows'], 2)
        self.assertEqual(stats['duplicate_rows_seen'], 2)

    def test_known_overlap_never_appears_in_options(self):
        entries, _ = v.clean_entries(ROWS + [row('fruit', '苹果；果实'), row('orchard', '果园')])
        lookup = {e.word: e for e in entries}
        for seed in range(10):
            questions, _ = v.generate(entries, 'all', seed, None)
            self.assertFalse(v.validate(questions, entries))
            for q in questions:
                words = q['optionWords']
                for i, a in enumerate(words):
                    for b in words[i+1:]:
                        self.assertFalse(v.conflicts(lookup[a], lookup[b]))

    def test_reproducibility_modes_limits_and_answer_positions(self):
        self.assertEqual(self.questions, v.generate(self.entries, 'all', 42, None)[0])
        self.assertNotEqual(self.questions, v.generate(self.entries, 'all', 43, None)[0])
        self.assertEqual(self.questions[:5], v.generate(self.entries, 'all', 42, 5)[0])
        for direction in ('en_to_zh', 'zh_to_en'):
            self.assertEqual([q for q in self.questions if q['direction'] == direction],
                             v.generate(self.entries, direction, 42, None)[0])
        self.assertEqual({q['correctOptionIndex'] for q in self.questions}, {0, 1, 2, 3})
        self.assertFalse(v.validate(self.questions, self.entries))

    def test_duplicate_gloss_prompts_skipped(self):
        entries, _ = v.clean_entries(ROWS + [row('fruit', '苹果')])
        questions, stats = v.generate(entries, 'all', 42, None)
        self.assertFalse(v.validate(questions, entries))
        self.assertTrue(any(x['reason'] == 'duplicate_prompt' for x in stats['generation_skipped']))

    def test_not_enough_distinct_answers_skips_instead_of_padding(self):
        entries, _ = v.clean_entries(ROWS[:3])
        questions, stats = v.generate(entries, 'all', 42, None)
        self.assertEqual(questions, [])
        self.assertEqual(len(stats['generation_skipped']), 3)

    def test_same_pos_preferred(self):
        entries, _ = v.clean_entries(ROWS + [row('jump', '跳跃', 'v')])
        questions, _ = v.generate(entries, 'all', 42, None)
        for q in questions:
            if q['word'] != 'jump':
                self.assertNotIn('jump', q['optionWords'])

    def test_validator_rejects_corrupt_answers_options_ids_and_languages(self):
        edits = [lambda q: q.update(correctOptionIndex=4),
                 lambda q: q.update(correctOptionIndex=True),
                 lambda q: q.update(correctOptionIndex=(q['correctOptionIndex'] + 1) % 4),
                 lambda q: q['options'].__setitem__(0, ''),
                 lambda q: q['options'].__setitem__(0, q['options'][1]),
                 lambda q: q['options'].__setitem__(0, 'english'),
                 lambda q: q.update(meaning='错误'),
                 lambda q: q.update(prompt='错误问题'),
                 lambda q: q.update(direction='invalid')]
        for edit in edits:
            with self.subTest(edit=edit):
                questions = copy.deepcopy(self.questions)
                edit(questions[0])
                self.assertTrue(v.validate(questions, self.entries))
        self.assertTrue(v.validate(self.questions + [self.questions[0]], self.entries))

    def test_validator_detects_semantic_conflict_even_with_correct_answer(self):
        entries, _ = v.clean_entries(ROWS + [row('fruit', '苹果；果实')])
        questions, _ = v.generate(entries, 'en_to_zh', 42, None)
        q = copy.deepcopy(next(q for q in questions if q['word'] == 'apple'))
        idx = (q['correctOptionIndex'] + 1) % 4
        q['optionWords'][idx] = 'fruit'
        q['options'][idx] = '苹果'
        self.assertTrue(v.validate([q], entries))

    def test_export_chunk_count_and_byte_limits(self):
        limits = v.import_limits()
        limits['importQuestions'] = 3
        files, importable = v.plan_exports(self.questions, 'all', limits)
        self.assertNotIn('cet4_all.json', importable)
        chunks = [json.loads(data) for name, data in files.items() if name.startswith('cet4_all.part')]
        self.assertEqual([q for chunk in chunks for q in chunk['questions']], self.questions)
        for name in importable:
            bank = json.loads(files[name])
            self.assertTrue(v.bank_fits(bank['name'], bank['questions'], limits))
        limits['importQuestions'] = 3000
        limits['importBytes'] = len(v.encode_bank('CET4 all 999999', self.questions[:2])) + 10
        files, importable = v.plan_exports(self.questions, 'all', limits)
        self.assertGreater(len([n for n in importable if n.startswith('cet4_all.part')]), 1)
        self.assertTrue(all(len(files[n]) <= limits['importBytes'] for n in importable))

    def test_dry_run_no_writes_source_unchanged_and_no_overwrite(self):
        with tempfile.TemporaryDirectory() as temp:
            source, output = Path(temp) / 'input.json', Path(temp) / 'output'
            source.write_text(json.dumps(ROWS), encoding='utf-8')
            before = source.read_bytes()
            command = [sys.executable, str(SCRIPT), '--input', str(source), '--output', str(output), '--limit', '5']
            result = subprocess.run(command + ['--dry-run'], capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertFalse(output.exists())
            result = subprocess.run(command, capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            report = json.loads((output / 'cet4_report.json').read_text())
            self.assertEqual(report['total_questions'], 5)
            saved = {p: p.read_bytes() for p in output.iterdir()}
            result = subprocess.run(command, capture_output=True, text=True)
            self.assertEqual(result.returncode, 1)
            self.assertEqual(saved, {p: p.read_bytes() for p in output.iterdir()})
            self.assertEqual(source.read_bytes(), before)
            with self.assertRaises(ValueError):
                v.export_files(source.parent, {source.name: b'{}'}, source)

    def test_jsonl_bom_unknown_root_and_empty_bank(self):
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / 'input.jsonl'
            path.write_text('\ufeff' + '\n'.join(json.dumps(r) for r in ROWS), encoding='utf-8')
            self.assertEqual(v.read_source(path), ROWS)
            path.write_text('{}')
            with self.assertRaises(ValueError):
                v.read_source(path)
        self.assertEqual(v.plan_exports([], 'all', v.import_limits()), ({}, []))


if __name__ == '__main__':
    unittest.main()
