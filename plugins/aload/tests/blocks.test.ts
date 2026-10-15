import { expect, test } from 'claude-code/testing'

import { locate, speechFrom, splitChunks, toSpeech } from '../hooks/blocks'

const DOC = [
  '## 结论',
  '先说**结论**：这个方案可行。',
  '',
  '- 第一条理由',
  '- 第二条理由，很重要',
  '',
  '```bash',
  'npm test',
  '```',
  '',
  '| 名字 | 结果 |',
  '|---|---|',
  '| 装 mpv | 0.41.0 |',
  '',
  '最后说一句。',
].join('\n')

test('locate finds what was selected on screen in the markdown source', async () => {
  // 屏幕上看不到 ** 和 - ，选中的文字和原文的符号对不上，只比字母、数字和汉字
  expect(locate(DOC, '结论：这个方案可行')).toBe(DOC.indexOf('结论**：'))
  expect(locate(DOC, '第二条理由，很重要')).toBe(DOC.indexOf('第二条'))
  expect(locate(DOC, '装 mpv │ 0.41.0')).toBe(DOC.indexOf('装 mpv'))
  expect(locate(DOC, '根本没有这句话')).toBe(-1)
  expect(locate(DOC, '：，。')).toBe(-1)
})

test('speechFrom reads from a position to the end', async () => {
  expect(speechFrom(DOC)).toEqual(['结论\n先说结论：这个方案可行。', '第一条理由', '第二条理由，很重要', '装 mpv，结果：0.41.0。', '最后说一句。'])
  // 落在一段中间：从那里念起
  expect(speechFrom(DOC, DOC.indexOf('这个方案'))[0]).toBe('这个方案可行。')
  // 落在代码块里：从下一段念
  expect(speechFrom(DOC, DOC.indexOf('npm test'))).toEqual(['装 mpv，结果：0.41.0。', '最后说一句。'])
  // 落在表格里：整张表念（要用表头）
  expect(speechFrom(DOC, DOC.indexOf('0.41.0'))).toEqual(['装 mpv，结果：0.41.0。', '最后说一句。'])
})

test('paragraphs, list items, quotes and tables are separate chunks', async () => {
  const md = [
    '第一段，**加粗**和 `code`。',
    '还是第一段。',
    '',
    '- 条目一',
    '  - 子条目',
    '- 条目二',
    '',
    '> 引用',
    '',
    '| 名字 | 结果 |',
    '|---|---|',
    '| 装 mpv | 0.41.0 |',
  ].join('\n')
  const chunks = splitChunks(md)
  expect(chunks.map(c => c.kind)).toEqual(['para', 'item', 'item', 'quote', 'table'])
  expect(chunks[0]?.md).toBe('第一段，**加粗**和 `code`。\n还是第一段。')
  expect(chunks[0]?.speech).toBe('第一段，加粗和 code。\n还是第一段。')
  expect(chunks[1]?.md).toBe('- 条目一\n  - 子条目')
  expect(chunks[1]?.speech).toBe('条目一\n子条目')
  expect(chunks[4]?.speech).toBe('装 mpv，结果：0.41.0。')
})

test('code blocks and rules get no speech; headings join the next chunk', async () => {
  const md = ['## 标题', '正文。', '', '```ts', 'const a = 1', '', 'const b = 2', '```', '', '---', '', '## 结尾标题'].join('\n')
  const chunks = splitChunks(md)
  expect(chunks.map(c => c.kind)).toEqual(['para', 'code', 'rule', 'heading'])
  expect(chunks[0]?.md).toBe('## 标题\n正文。')
  expect(chunks[0]?.speech).toBe('标题\n正文。')
  expect(chunks[1]?.md).toBe('```ts\nconst a = 1\n\nconst b = 2\n```')
  expect(chunks[1]?.speech).toBe('')
  expect(chunks[2]?.speech).toBe('')
  expect(chunks[3]?.speech).toBe('结尾标题')
})

test('a fenced block inside a list item stays in the item', async () => {
  const md = ['1. 先运行：', '   ```bash', '   npm test', '   ```', '2. 再看结果'].join('\n')
  const chunks = splitChunks(md)
  expect(chunks.map(c => c.kind)).toEqual(['item', 'item'])
  expect(chunks[0]?.speech).toBe('先运行：\n（这里有一段代码）')
})

test('an unclosed fence runs to the end without losing text', async () => {
  const chunks = splitChunks('前面。\n\n```\n没收尾的代码')
  expect(chunks.map(c => c.kind)).toEqual(['para', 'code'])
  expect(chunks[1]?.md).toBe('```\n没收尾的代码')
})

test('speech drops links, paths, emoji and markup', async () => {
  expect(toSpeech('看 [文档](https://example.com/a) 和 https://x.y/z')).toBe('看 文档 和 链接')
  expect(toSpeech('改了 `/Users/me/proj/src/main.ts:12` 和 ~/a/b/c.txt')).toBe('改了 main.ts 和 c.txt')
  expect(toSpeech('✅ 通过 ⚠️ 部分 🔊')).toBe('通过 部分')
  expect(toSpeech('- [x] 已完成的事')).toBe('已完成的事')
  expect(toSpeech('a | b | c')).toBe('a，b，c')
  expect(toSpeech('*斜体* 和 snake_case_name')).toBe('斜体 和 snake_case_name')
})

test('a long inline code is not spelled out', async () => {
  expect(toSpeech('运行 `npx -y -p typescript@5.6.3 tsc -p ./tsconfig.json --noEmit` 即可')).toBe('运行 一段代码 即可')
})
