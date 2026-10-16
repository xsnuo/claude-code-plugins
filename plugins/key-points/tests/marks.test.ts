import { expect, test } from 'claude-code/testing'

import { DEFAULT_STYLES, analyze, findSentence, findWords, paint, parseInline, parseItems, pick, place, textStyle } from '../hooks/marks'

test('parseInline drops the markdown marks and keeps their looks', async () => {
  expect(parseInline('先说**结论**：跑 `npm test`，见 [文档](https://example.com)。')).toEqual([
    { text: '先说' },
    { text: '结论', bold: true },
    { text: '：跑 ' },
    { text: 'npm test', code: true },
    { text: '，见 ' },
    { text: '文档', href: 'https://example.com' },
    { text: '。' },
  ])
  // snake_case 里的下划线、单独的星号都不是强调
  expect(parseInline('改 key_points_link 和 a * b')).toEqual([{ text: '改 key_points_link 和 a * b' }])
  expect(parseInline('*斜体里有 **粗体***')).toEqual([{ text: '斜体里有 ', italic: true }, { text: '粗体', italic: true, bold: true }])
})

test('a quote is found by its letters, whatever markdown and spacing the reply has', async () => {
  const text = '结论：这个方案**可行**，但要先改 aload。'
  const [unit] = analyze(text)
  expect(unit!.text).toBe('结论：这个方案可行，但要先改 aload。')
  const at = findSentence(unit!.text, '这个方案可行，但要先改 aload。')
  expect(at && unit!.text.slice(...at)).toBe('这个方案可行，但要先改 aload。') // 句号也算进去
  expect(findSentence(unit!.text, '根本没有这句')).toBeUndefined()
})

test('a word is marked everywhere it appears, never inside a longer English word', async () => {
  const text = 'Run test, then testing. TEST again.'
  expect(findWords(text, 'test').map(([a, b]) => text.slice(a, b))).toEqual(['test', 'TEST'])
  expect(findWords('先装插件，再装一个插件', '插件')).toHaveLength(2)
})

test('code blocks are neither marked nor counted; tables count but are not marked', async () => {
  const md = ['第一段话。', '', '```', 'const 插件 = 1', '```', '', '| 名字 | 结果 |', '|---|---|', '| 插件 | 好 |'].join('\n')
  const units = analyze(md)
  expect(units.map(u => [u.kind, u.size, !!u.lines])).toEqual([
    ['para', 5, true],
    ['code', 0, false],
    ['table', 7, false],
  ])
  const ranges = place(units, [{ type: 'word', text: '插件' }])
  expect(ranges.map(r => r.length)).toEqual([0, 0, 0])
})

test('pick keeps the most important ones until 25% of the reply is marked', async () => {
  // 正文 40 个字（空白不算），25% 是 10 个字
  const md = '甲乙丙丁戊己庚辛壬癸 子丑寅卯辰巳午未申酉 东南西北中前后左右上 一二三四五六七八九十'
  const kept = pick(md, [
    { type: 'sentence', text: '甲乙丙丁戊己庚辛壬癸 子' }, // 11 个字：超了，跳过
    { type: 'word', text: '子丑寅卯' }, // 4
    { type: 'sentence', text: '一二三四五' }, // 5
    { type: 'word', text: '二三' }, // 落在已标的句子里，不多占
    { type: 'word', text: '东南西北' }, // 再加 4 就超了，跳过
    { type: 'word', text: '中' }, // 1：正好 10
    { type: 'word', text: '没有这个词' }, // 原文里没有
  ])
  expect(kept).toEqual([
    { type: 'word', text: '子丑寅卯' },
    { type: 'sentence', text: '一二三四五' },
    { type: 'word', text: '二三' },
    { type: 'word', text: '中' },
  ])
})

test('parseItems reads a JSON array, with or without fences or chatter', async () => {
  const items = [{ type: 'sentence', text: '要先改 aload' }, { type: 'word', text: '25%' }]
  expect(parseItems(JSON.stringify(items))).toEqual(items)
  expect(parseItems('```json\n' + JSON.stringify(items) + '\n```')).toEqual(items)
  expect(parseItems('好的：' + JSON.stringify(items))).toEqual(items)
  expect(parseItems('{"sentences":["要先改 aload"],"words":["25%"]}')).toEqual(items)
  expect(parseItems('[{"type":"other","text":"x"},{"type":"word","text":"  "}]')).toEqual([])
  expect(parseItems('没有找到重点')).toBeNull()
})

test('paint cuts a line where marks start and end; a word inside a sentence carries both', async () => {
  const [unit] = analyze('- 重点是 **aload** 要先改，然后再发版')
  const ranges = place([unit!], [
    { type: 'sentence', text: '重点是 aload 要先改' },
    { type: 'word', text: 'aload' },
  ])[0]!
  const [line] = paint(unit!, ranges)
  expect(line!.prefix).toBe('- ')
  expect(line!.parts).toEqual([
    { text: '重点是 ', sentence: true },
    { text: 'aload', bold: true, sentence: true, word: true },
    { text: ' 要先改', sentence: true },
    { text: '，然后再发版' },
  ])
  const word = textStyle(line!.parts[1]!, line!, DEFAULT_STYLES)
  expect(word).toEqual({ weight: 'bold', color: '#000000', backgroundColor: '#FFFF00' })
  expect(textStyle(line!.parts[0]!, line!, DEFAULT_STYLES)).toEqual({ color: 'warning' })
})
