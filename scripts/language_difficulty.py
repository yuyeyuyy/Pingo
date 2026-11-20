"""Deterministic offline estimates for Pingo language questions."""
from collections import defaultdict
import hashlib
import re
import unicodedata

WORD = re.compile(r"[a-z]+(?:[-' ][a-z]+)*\Z")
# Human-readable anchors for the rubric, not frequency measurements.
ANCHORS = {
    1: """a an the i you he she it we they me us them my your his her our their
        this that these those one two three four five six seven eight nine ten yes no
        and or but in on at to of for with from by as up down out very not is be do have
        apple banana orange pear egg bread rice milk water tea food eat drink
        cat dog bird fish book pen desk chair door window bed house home room school
        mother father sister brother baby friend boy girl man woman child family
        red blue green black white brown yellow big small long short hot cold old new
        good bad happy sad easy hard fast slow day night morning today tomorrow yesterday
        sun moon rain snow tree flower car bus train road street go come see look
        hear say tell ask give take make get put read write run walk sit stand open close
        play work sleep help love like want know think time name hand eye head foot
        shirt shoe bag money shop buy sell wash clean left right here there what who
        where when why how can will all some many much now stop start end week year
        box bowl cup spoon fork knife plate table map clock toy ball cake meat soup
        fruit potato tomato chicken bee cow horse pig duck elephant monkey lion tiger
        rabbit mouse sheep bear sea sky air earth star grass leaf rock stone
        boat ship bike hat coat sock skirt arm leg hair mouth nose ear face tooth
        smile cry laugh sing swim jump throw dry wet tall nice fine sick well cool
        warm round square wrong pink purple grey gray month hour minute half second
        first last next again outside inside""",
    2: """borrow lend return bring carry choose change check answer question learn
        study teach class exam lesson library teacher student homework office company
        meeting job boss staff salary travel ticket airport station hotel market price
        cost pay order dinner meal cook kitchen hospital doctor nurse health beach
        mountain river country city town garden building floor number address letter
        message phone computer internet email picture music movie dance sport football
        holiday weekend breakfast lunch sugar salt police clothes sweater pocket
        need hope plan wait visit move drive ride fly arrive leave stay catch lose
        win finish begin follow listen watch talk speak remember forget agree decide
        explain happen join send receive enjoy spend save share try use turn build
        break repair grow cut cover draw push pull touch wear dress pick drop lift
        quiet busy tired hungry ready angry afraid careful common simple normal
        safe soft strong weak fresh dark bright full empty near far early late
        usually often never always sometimes together instead enough almost
        accept accident activity advice allow announce another apartment area around
        believe bicycle bottle calendar camera cancel celebrate center chance cheap
        collect contact continue cooking corner count cup customer depend describe
        direction discover easy education exercise expect experience famous field
        garden gift guess invite island language list local machine member miss
        museum offer party prepare present problem record report road rule service
        sign smoke special subject smile surprise team test useful usual weather
        adult age album alcohol audience author average awake bake bakery bank
        barber basketball bat bath bathroom battery bean beer bill blanket boot
        branch bridge brush burger butter button cabinet cable campus candle cap
        carpet cartoon cash castle ceiling cellphone channel chat cheese chocolate
        circle coach coffee colleague college complaint concert cookie copy cotton
        cousin crowd culture curtain dictionary document dollar doorway downstairs
        drawer driver duty electricity elevator entrance envelope equipment exit
        factory fan farm farmer fashion fence festival file firefighter fire flag
        flashlight flat flight fog forest freezer fridge fuel garage gas gate
        glasses gloves goal grape guest gym haircut hallway hamburger handbag
        handle headache height hill hobby honey identity jacket jeans juice key
        keyboard kitten lab lake lamp laptop lemon locker lock luggage magazine
        mailbox manager mask medicine menu metal microphone mirror motor newspaper
        notebook oil oven owner packet painter pancake paper parent park passenger
        password passport path patient peanut pepper pet piano picnic pillow pilot
        pizza plant player playground pool poster printer professor puppy puzzle
        radio recipe refrigerator rent restaurant roof rope ruler salad sandwich
        sauce schedule screen seat secretary shower sink soap sofa soda soldier
        stamp standard steak step sticker stomach store stove stranger strawberry
        sunglasses supermarket switch taxi telephone television tent theater
        theatre thermometer thief throat toe towel traffic truck tunnel umbrella
        uniform university upstairs vacation vegetable video village violin wallet
        wall warehouse wheel winter wire wood workplace blind bored brave careless
        cloudy comfortable convenient creative cute daily delicious different dirty
        double excited fair friendly funny heavy helpful honest impatient interesting
        lazy luckily noisy odd pale polite popular pretty proud rainy recent rich
        rude sleepy smart smooth sunny sweet thick thin thirsty ugly unlucky
        unusual worried young advise bite blow boil bother bounce burn climb comb
        complain connect cross damage deliver dig enter escape feed fold freeze
        fry hang hide hit hug hurry introduce knock land lie light marry melt
        mix pack paint pass pour press promise recycle repeat roll rush scare
        search shake shout shut skip smell solve sound spell spill steal stick
        sweep taste thank tie tidy trust unlock wake weigh welcome worry""",
    3: """reliable abandon abrupt abruptly academic access accomplish acquire adapt
        adequate alternative analyze analysis approach assume assess avoid benefit
        challenge circumstance complex concept confirm consistent contrast contribute
        convince create define demonstrate determine develop economy effective effort
        emphasize enable encourage establish evaluate evidence factor feature finance
        flexible function identify improve indicate industry influence interpret issue
        maintain manage measure method observe occur organize participate policy
        potential prevent process progress property promote propose protect publish
        reflect relation relevant require research resolve respond result significant
        similar source strategy structure support survey technology theory trade
        transfer trend valuable vary verify volume""",
    4: """mitigate abate abhor aberration abridge abrogate ambivalent amenable
        anachronism anarchy arbitration archaic benevolent bureaucracy catalyst
        clandestine corroborate creditor curriculum deductible depreciation
        diagnose dissertation eccentric enact enforce entropy epistemology
        exacerbate exonerate fiduciary fluorescence formidable hegemony hypothesis
        jurisprudence legislature litigate malnutrition metastasis mitigate
        neurotic obsolete omnipotent paradox pathogenic placebo pragmatic
        precarious prerequisite protagonist recession recourse redundancy
        referendum remuneration rhetoric semiconductor sovereignty statutory
        stochastic subordinate subsidy substantive theology thermodynamics
        transcend unilateral ubiquitous viscosity vulnerability""",
}
ANCHOR_TIER = {word: tier for tier, words in sorted(ANCHORS.items(), reverse=True)
               for word in words.split()}
# Specific attested inflections. Homographs such as 'saw' need sense evidence.
INFLECTIONS = {
    'borrowed': 'borrow', 'borrowing': 'borrow', 'borrows': 'borrow',
    'children': 'child', 'mice': 'mouse', 'teeth': 'tooth',
    'went': 'go', 'bought': 'buy', 'brought': 'bring', 'taught': 'teach',
    'wrote': 'write', 'written': 'write', 'ran': 'run', 'eaten': 'eat',
}
TECHNICAL = re.compile(r'\[(?:医|化|物|法|经|计|数|生|律|核|天文|解剖)\]|'
                       r'电磁|光谱|半导体|细胞|氧化|分子|染色体|神经元|税率|诉讼|'
                       r'代谢|聚合|流体|微生物|通货膨胀|磁场|货币政策|地质|定理|方程|酶|'
                       r'侵权|海拔气压|证券|递归|量子|离子|熵|声呐|发酵|合金|胚胎|特许经营')
ABSTRACT = re.compile(r'概念|抽象|原则|理论|制度|意识|特征|性质|现象|观念|关系|'
                      r'能力|态度|假设|推断|倾向|过程|程度|因素|评估|价值|意义|机制|政策')
CONCRETE = re.compile(r'司机|驾驶员|麦克风|地图|碟子|电梯|毛巾|鞋带|篮子|牙刷|冰箱|窗帘|蛋糕|'
                      r'啤酒|糖果|咖啡|公园|路灯|水果|蔬菜|动物|衣服|鞋|房间|学校|商店|车站|桌子|椅子|杯子|'
                      r'天气|颜色|食物|鱼|鸟|树|花|面包|餐具|玩具|海滩')
FORMAL = re.compile(r'\[(?:正式|古|罕|书面)\]|(?:正式|罕用|古语|书面语)')


def normalize(value):
    return ' '.join(unicodedata.normalize('NFKC', value).casefold().split())


def word_form(value):
    if isinstance(value, str):
        word = normalize(value)
        if WORD.fullmatch(word):
            return word
    return None


def gloss(value):
    return normalize(value).rstrip('。.;；')


def lexical_target(row, question, vocabulary):
    if vocabulary:
        return word_form(row.get('word'))
    category = question.get('languageType')
    if category == 'meaning-to-word':
        return word_form(question['options'][question['correctOptionIndex']])
    if category == 'word-to-meaning':
        # In this direction the correct option's explanation may be the source word.
        explanations = question.get('optionExplanations') or []
        correct = question['correctOptionIndex']
        explanation = word_form(explanations[correct]) if correct < len(explanations) else None
        prompt_word = re.match(r"""^\s*[「“"'\x60]?([A-Za-z]+(?:[-' ][A-Za-z]+)*)[」”"'\x60]?\s*(?:[（(][^）)]*[）)]\s*)?的""", question['prompt'])
        candidates = {word for word in (explanation, word_form(row.get('word')),
                                        word_form(prompt_word[1]) if prompt_word else None) if word}
        return next(iter(candidates)) if len(candidates) == 1 else None
    if category in ('word-spelling', 'word-fill-in'):
        answers = question.get('acceptedAnswers', []) if category == 'word-spelling' else (
            question['blanks'][0] if len(question['blanks']) == 1 else [])
        words = [word_form(a) for a in answers]
        if words and all(words) and len({INFLECTIONS.get(w, w) for w in words}) == 1:
            return words[0]
    if category in ('synonym', 'antonym', 'context-word-choice'):
        return word_form(row.get('word')) or word_form(question['options'][question['correctOptionIndex']])
    return None


def translation_items(row, q, vocabulary):
    if vocabulary:
        translations = row.get('translations')
        return [t for t in translations if isinstance(t, dict) and isinstance(t.get('translation'), str)
                and t['translation'].strip()] if isinstance(translations, list) else []
    category = q.get('languageType')
    if category in ('word-to-meaning', 'meaning-to-word'):
        index = q['correctOptionIndex']
        explanations = q.get('optionExplanations') or [None] * len(q['options'])
        meaning = q['options'][index] if category == 'word-to-meaning' else explanations[index]
    else:
        meaning = row.get('meaning')
    if not isinstance(meaning, str) or not meaning.strip():
        return []
    return [{'translation': meaning, 'type': row.get('partOfSpeech', row.get('pos'))}]


def lemma_table(evidence):
    """Morphology is accepted only with corroborating source gloss and POS."""
    lemmas = {}
    for word, translations in evidence.items():
        if word in INFLECTIONS:
            lemmas[word] = INFLECTIONS[word]
            continue
        candidates = set()
        senses = {(gloss(t['translation']), pos(t)) for t in translations}
        for suffix, endings, part in [
            ('ies', ('y',), 'n'), ('es', ('', 'e'), 'n'), ('s', ('',), 'n'),
            ('ed', ('', 'e'), 'v'), ('ied', ('y',), 'v'), ('ing', ('', 'e'), 'v'),
            ('s', ('',), 'v'), ('es', ('', 'e'), 'v'),
        ]:
            if not word.endswith(suffix):
                continue
            stem = word[:-len(suffix)]
            for base in (stem + ending for ending in endings):
                if any((gloss(t['translation']), part) in senses and pos(t) == part
                       for t in evidence.get(base, [])):
                    candidates.add(base)
        lemmas[word] = next(iter(candidates)) if len(candidates) == 1 else word
    return lemmas


def pos(item):
    value = item.get('type')
    if not isinstance(value, str):
        return ''
    value = value.strip().lower().rstrip('.')
    return {'vt': 'v', 'vi': 'v', 'a': 'adj', 'ad': 'adv', 'vt&vi': 'v'}.get(value, value)


def estimate(lemma, items, source_tiers):
    if len(source_tiers) == 1:
        return next(iter(source_tiers)), 'source_wordTier'
    meanings = [t['translation'] for t in items]
    specialized = [m for m in meanings if TECHNICAL.search(m) or FORMAL.search(m)]
    if meanings and len(specialized) == len(meanings):
        return 4, 'all_available_glosses_marked_formal_or_specialized'
    if lemma in ANCHOR_TIER:
        return ANCHOR_TIER[lemma], 'agent_rubric_anchor'
    if meanings and sum(bool(ABSTRACT.search(m)) for m in meanings) * 2 >= len(meanings):
        return 3, 'abstract_glosses'
    if any(CONCRETE.search(m) for m in meanings):
        return 2, 'concrete_or_everyday_gloss'
    for suffix in ('ly', 'ness', 'less', 'ful'):
        if lemma.endswith(suffix) and ANCHOR_TIER.get(lemma[:-len(suffix)]) in (1, 2):
            return 2, 'transparent_derivative_of_everyday_anchor'
    if ' ' in lemma or re.search(r'(?:ization|ological|ography|metry|pathy|aceous|escent)$', lemma):
        return 3, 'multiword_or_formal_formation'
    return 3, 'unlisted_general_vocabulary_estimate'


def concept_key(lemma, items):
    if len(items) != 1:
        return None
    item = items[0]
    meaning, part = gloss(item['translation']), pos(item)
    if not re.fullmatch(r'[a-z]+', part) or re.search(r'[,，、;/；…]|\s+[/／]|\bor\b', meaning):
        return None
    if lemma == 'apple' and part == 'n' and meaning == '苹果':
        return 'apple:n:fruit'
    digest = hashlib.sha256(meaning.encode()).hexdigest()[:20]
    return f'{lemma}:{part}:{digest}'


def direct_difficulty(q):
    category = q.get('languageType')
    if category == 'grammar-fill-in':
        return min(5, 2 + (len(q['blanks']) - 1) // 2), 'grammar_blank_count'
    if category == 'grammar-correction':
        return 3, 'independent_grammar_correction'
    if category == 'grammar-choice':
        return 2, 'grammar_recognition'
    if q['kind'] == 'ordering':
        return min(5, 1 + (len(q['items']) - 1) // 3), 'ordering_item_count'
    if category == 'sentence-meaning':
        return 2 + min(3, len(q['prompt'].split()) // 12), 'sentence_reading_length'
    return None, 'insufficient_evidence'
