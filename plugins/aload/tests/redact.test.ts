import { expect, test } from 'claude-code/testing'

import { ID_MAX, applySpans, idLength, localRedact, parseSpans, redactAll, redactPrompt } from '../hooks/redact'

test('local rules mask well-known key formats and the value after "password:" or "token="', async () => {
  expect(localRedact('Key 是 sk-ant-api03-AbCdEfGhIjKlMnOp_1234 别外传')).toBe('Key 是 【密钥】 别外传')
  expect(localRedact('AWS：AKIAIOSFODNN7EXAMPLE')).toBe('AWS：【密钥】')
  expect(localRedact('ghp_0123456789abcdefghijklmnopqrstuvwxyz')).toBe('【密钥】')
  expect(localRedact('password: hunter22，然后登录')).toBe('password: 【密码】，然后登录')
  expect(localRedact('密码：Abc@12345。')).toBe('密码：【密码】。')
  expect(localRedact('api_key="x9Y8z7W6"')).toBe('api_key=【密钥】')
  expect(localRedact('一长串 Q2xhdWRlQ29kZVBsdWdpblNlY3JldEtleTEyMzQ1 是什么')).toBe('一长串 【密钥】 是什么')
})

test('local rules leave ordinary text alone', async () => {
  for (const text of [
    '密码：请到设置里修改',
    '上下文用了 token：12k',
    '提交 3f2a9c1b8e7d6c5b4a39281706f5e4d3c2b1a090 已推送', // 只有小写和数字的哈希
    'TurnStepEngineChunkWithAVeryLongNameButNoDigits',
    '把 YOUR_API_KEY 换成你自己的',
  ]) {
    expect(localRedact(text)).toBe(text)
  }
})

test('spans from Claude replace every occurrence, longest first', async () => {
  const spans = [
    { text: 'abc', label: '密钥' },
    { text: 'abc-123', label: '密码' },
  ]
  expect(applySpans('abc-123 和 abc 和 abc-123', spans)).toBe('【密码】 和 【密钥】 和 【密码】')
  expect(redactAll(['UID 是 2087654321'], [{ text: '2087654321', label: 'UID' }])).toEqual(['UID 是 【UID】'])
})

test('parseSpans reads a JSON array, tidies labels, and drops what it cannot use', async () => {
  expect(parseSpans('[]')).toEqual([])
  expect(parseSpans('```json\n[{"text":"ak-1","label":"【密钥】"}]\n```')).toEqual([{ text: 'ak-1', label: '密钥' }])
  expect(parseSpans('结果：[{"text":"x","label":"密钥"},{"text":"13800138000","label":""}]')).toEqual([
    { text: '13800138000', label: '敏感信息' },
  ])
  expect(parseSpans('没有发现')).toBeNull()
})

test('IDs of at most 8 characters are read as they are; longer ones are masked', async () => {
  expect(ID_MAX).toBe(8)
  const spans = parseSpans(
    JSON.stringify([
      { text: '10086', label: 'UID' },
      { text: 'u_123456', label: '用户ID' }, // 正好 8 个
      { text: 'UID：2087', label: 'UID' }, // 前面带了字：只看 ID 本身
      { text: '208765432', label: 'UID' }, // 9 个
      { text: '550e8400-e29b-41d4-a716-446655440000', label: 'OpenID' },
      { text: '1234', label: '密码' }, // 不是 ID：再短也屏蔽
    ]),
  )
  expect(spans).toEqual([
    { text: '208765432', label: 'UID' },
    { text: '550e8400-e29b-41d4-a716-446655440000', label: 'OpenID' },
    { text: '1234', label: '密码' },
  ])
  expect(redactAll(['账号 10086，用户 208765432'], spans!)).toEqual(['账号 10086，用户 【UID】'])
  expect(idLength('UID: 123456789')).toBe(9)
  expect(idLength('一二三')).toBe(3)
})

test('the request tells Claude which numbers are not IDs: commits, issues, numbers in URLs', async () => {
  const prompt = redactPrompt(['提交 3f2a9c1，修了 #1513'])
  expect(prompt).toContain('只列超过 8 个字符的')
  for (const word of ['git 的提交号', 'issue、PR', '网址里带的编号']) expect(prompt).toContain(word)
})
