import contextlib
import copy
import importlib.util
import io
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

SCRIPT = Path(__file__).resolve().parents[2] / 'scripts/convert_language_bank.py'
sys.path.insert(0, str(SCRIPT.parent))
spec = importlib.util.spec_from_file_location('convert_language_bank', SCRIPT)
v = importlib.util.module_from_spec(spec)
spec.loader.exec_module(v)


class LanguageConversionTests(unittest.TestCase):
    def setUp(self):
        self.limits = v.limits_from_project()
        self.vocab = {'word': 'apple', 'translations': [
            {'translation': '苹果，苹果树', 'type': 'n'},
            {'translation': '原始附加义项（保留限定语）', 'type': 'n'}]}
        self.samples = [
            {'kind': 'multiple-choice', 'languageType': 'word-to-meaning', 'prompt': 'apple?',
             'options': ['苹果', '梨'], 'correctOptionIndex': 0, 'optionExplanations': ['apple', None]},
            {'kind': 'short-answer', 'languageType': 'word-spelling', 'prompt': '苹果的英文？',
             'acceptedAnswers': ['apple'], 'referenceAnswer': 'apple'},
            {'kind': 'fill-in', 'languageType': 'grammar-fill-in', 'prompt': 'She {{blank}} a teacher.', 'blanks': [['is']]},
            {'kind': 'ordering', 'languageType': 'sentence-ordering', 'prompt': '排序',
             'items': ['apples', 'like', 'I'], 'correctOrder': [2, 1, 0]},
        ]

    def test_all_four_kinds_preserve_answers_options_and_explanations(self):
        questions, skipped, _ = v.convert(self.samples, False, self.limits)
        self.assertEqual(questions, self.samples)
        self.assertFalse(skipped)

    def test_vocabulary_preserves_full_meanings_pos_and_source_word(self):
        q = v.vocabulary_question(self.vocab, self.limits)
        self.assertEqual(q['acceptedAnswers'], ['apple'])
        self.assertEqual(q['referenceAnswer'], 'apple')
        self.assertEqual(q['languageType'], 'word-spelling')
        self.assertIn('[n] 苹果，苹果树', q['prompt'])
        self.assertIn('原始附加义项（保留限定语）', q['prompt'])

    def test_invalid_counts_answers_and_permutations_are_reported(self):
        changes = [(0, {'correctOptionIndex': True}), (0, {'correctOptionIndex': 2}),
                   (0, {'optionExplanations': ['apple']}), (1, {'acceptedAnswers': None}),
                   (1, {'referenceAnswer': 'pear'}), (2, {'blanks': []}),
                   (2, {'prompt': 'no blank'}), (3, {'correctOrder': [0, 0, 1]}),
                   (3, {'items': ['same', 'same'], 'correctOrder': [0, 1]})]
        for index, change in changes:
            with self.subTest(change=change):
                q = {**self.samples[index], **change}
                questions, skipped, _ = v.convert([q], False, self.limits)
                self.assertFalse(questions)
                self.assertEqual(skipped[0]['source_number'], 1)
                self.assertEqual(skipped[0]['source_record'], q)

    def test_conflicts_duplicates_and_counts_keep_order(self):
        pear = copy.deepcopy(self.vocab)
        pear['word'] = 'pear'
        unique = {'word': 'desk', 'translations': [{'translation': '桌子', 'type': 'n'}]}
        rows = [self.vocab, unique, pear, unique, {'word': 'missing'}]
        questions, skipped, _ = v.convert(rows, True, self.limits)
        self.assertEqual([q['referenceAnswer'] for q in questions], ['desk'])
        self.assertEqual([s['source_number'] for s in skipped], [1, 3, 4, 5])
        self.assertEqual(len(rows), len(questions) + len(skipped))
        self.assertEqual(skipped[0]['conflicting_source_numbers'], [1, 3])

    def test_unknown_option_explanations_are_null_without_guessing(self):
        q = copy.deepcopy(self.samples[0]); q.pop('optionExplanations')
        self.assertEqual(v.validate_question(q, self.limits)['optionExplanations'], [None, None])

    def test_unicode_limits_and_file_byte_splitting(self):
        q = v.validate_question(self.samples[1], self.limits)
        q['prompt'] = '😀' * 5001
        with self.assertRaises(ValueError):
            v.validate_question(q, self.limits)
        maximum = max(len(v.encode([q])) for q in self.samples) + 5
        files = v.split_files(self.samples, maximum)
        self.assertGreater(len(files), 1)
        self.assertEqual([q for data in files.values() for q in json.loads(data)['questions']], self.samples)
        self.assertTrue(all(len(d) <= maximum for d in files.values()))
        self.assertTrue(all(set(json.loads(d)) == {'questions'} for d in files.values()))
        with self.assertRaises(ValueError):
            v.split_files(self.samples, 10)

    def test_shared_lemma_concept_and_difficulty_survive_separate_files(self):
        choice = {**self.samples[0], 'prompt': 'borrow 的中文意思是什么？',
                  'options': ['借用', '归还'], 'optionExplanations': ['borrow', 'return'],
                  'partOfSpeech': 'v'}
        spelling = {**self.samples[1], 'prompt': '写出「借用」的英文。',
                    'acceptedAnswers': ['borrowed'], 'referenceAnswer': 'borrowed',
                    'meaning': '借用', 'partOfSpeech': 'vt'}
        rows = [choice, spelling]
        questions, skipped, _ = v.convert(rows, False, self.limits)
        report = v.grade(rows, questions, skipped, False, self.limits)
        cap = max(len(v.encode([q])) for q in questions)
        files = v.split_files(questions, cap)
        self.assertEqual(len(files), 2)
        first, second = [json.loads(data)['questions'][0] for data in files.values()]
        self.assertEqual(report['word_tiers_by_lemma']['borrow']['forms'], ['borrow', 'borrowed'])
        self.assertEqual(report['lemmas_checked_in_both_choice_and_spelling'], 1)
        self.assertEqual((first['difficulty'], second['difficulty']), (2, 3))
        self.assertEqual(first['conceptKey'], second['conceptKey'])

    def test_anchor_tiers_and_source_tier_provenance(self):
        rows = [
            {'word': 'apple', 'translations': [{'type': 'n', 'translation': '苹果'}]},
            {'word': 'reliable', 'translations': [{'type': 'adj', 'translation': '可靠的'}]},
            {'word': 'mitigate', 'translations': [{'type': 'v', 'translation': '缓和'}]},
            {'word': 'pear', 'wordTier': 2, 'translations': [{'type': 'n', 'translation': '梨'}]},
        ]
        questions, skipped, _ = v.convert(rows, True, self.limits)
        report = v.grade(rows, questions, skipped, True, self.limits)
        self.assertEqual([q['difficulty'] for q in questions], [2, 4, 5, 3])
        self.assertEqual(questions[0]['conceptKey'], 'apple:n:fruit')
        self.assertEqual(report['word_tiers_by_lemma']['pear']['provenance'], 'source')
        self.assertEqual(report['word_tiers_by_lemma']['apple']['provenance'], 'agent_estimate')

    def test_learning_materials_share_only_attested_sense_and_repeat_on_split(self):
        row = {'word': 'apple', 'translations': [{'type': 'n', 'translation': '苹果'}],
               'phrases': [{'phrase': 'apple juice', 'translation': '苹果汁'},
                           {'phrase': 'apple of my eye', 'translation': '掌上明珠'}]}
        questions, skipped, _ = v.convert([row], True, self.limits)
        choice = {**self.samples[0], 'partOfSpeech': 'n'}
        materials = {}
        v.grade([row], questions, skipped, True, self.limits, {1: [(choice, choice.copy())]}, materials)
        self.assertEqual([q['materialKey'] for q in questions], ['apple:n:fruit'] * 2)
        self.assertEqual(materials['apple:n:fruit']['examples'], [
            {'text': 'apple juice', 'translation': '苹果汁'}])
        size = max(len(next(iter(v.split_files([q], 10000, materials).values()))) for q in questions)
        banks = [json.loads(data) for data in v.split_files(questions, size, materials).values()]
        self.assertEqual(len(banks), 2)
        self.assertEqual(banks[0]['materials'], banks[1]['materials'])
        with self.assertRaisesRegex(ValueError, 'missing_material'):
            v.split_files(questions, 10000)

        row['translations'].append({'type': 'n', 'translation': '苹果树'})
        questions, skipped, _ = v.convert([row], True, self.limits)
        v.grade([row], questions, skipped, True, self.limits, {1: [(choice, choice.copy())]}, materials)
        self.assertNotEqual(questions[0]['materialKey'], questions[1]['materialKey'])

    def test_cli_report_no_overwrite_source_hash_and_dry_run(self):
        with tempfile.TemporaryDirectory() as temp:
            source, output = Path(temp) / 'source.json', Path(temp) / 'output'
            source.write_text('\ufeff' + json.dumps([self.vocab, {'word': 'missing'}], ensure_ascii=False), encoding='utf-8')
            before = source.read_bytes()
            command = [sys.executable, str(SCRIPT), '--input', str(source), '--output', str(output)]
            dry = subprocess.run(command + ['--dry-run'], capture_output=True, text=True)
            self.assertEqual(dry.returncode, 0, dry.stderr)
            self.assertFalse(output.exists())
            run = subprocess.run(command, capture_output=True, text=True)
            self.assertEqual(run.returncode, 0, run.stderr)
            report = json.loads((output / 'conversion_report.json').read_text())
            self.assertEqual(report['input_records'], report['output_questions'] + report['skipped_records'])
            self.assertEqual(report['skipped'][0]['source_number'], 2)
            self.assertEqual(report['encoding'], 'UTF-8 with BOM')
            self.assertEqual(source.read_bytes(), before)
            self.assertNotEqual(subprocess.run(command, capture_output=True).returncode, 0)

    def test_all_invalid_still_writes_report_but_no_empty_bank(self):
        with tempfile.TemporaryDirectory() as temp:
            source, output = Path(temp) / 'source.json', Path(temp) / 'output'
            source.write_text('[{}]')
            run = subprocess.run([sys.executable, str(SCRIPT), '--input', str(source), '--output', str(output)], capture_output=True)
            self.assertEqual(run.returncode, 1)
            self.assertEqual([p.name for p in output.iterdir()], ['conversion_report.json'])


if __name__ == '__main__':
    unittest.main()
