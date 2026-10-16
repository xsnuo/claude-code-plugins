import { expect, test } from 'claude-code/testing'

import { applySpans, localRedact, parseSpans, redactAll } from '../hooks/redact'

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
  expect(redactAll(['UID 是 10086'], [{ text: '10086', label: 'UID' }])).toEqual(['UID 是 【UID】'])
})

test('parseSpans reads a JSON array, tidies labels, and drops what it cannot use', async () => {
  expect(parseSpans('[]')).toEqual([])
  expect(parseSpans('```json\n[{"text":"ak-1","label":"【密钥】"}]\n```')).toEqual([{ text: 'ak-1', label: '密钥' }])
  expect(parseSpans('结果：[{"text":"x","label":"密钥"},{"text":"13800138000","label":""}]')).toEqual([
    { text: '13800138000', label: '敏感信息' },
  ])
  expect(parseSpans('没有发现')).toBeNull()
})
