import { describe, expect, it } from 'vitest'

import { buildLiveSessionConfig } from '../src/gemini/config'
import { detectEnZh, enZh } from '../src/lang/en-zh'
import { detectViZh, viZh } from '../src/lang/vi-zh'
import { UtteranceMerger, countSentences, inferSourceLanguage, type IncomingFragment } from '../src/transcript/merge'

const MODEL = 'gemini-3.5-live-translate-preview'
const now = 1_760_000_000_000

function instruction(config: Record<string, unknown>): string {
  return (config.systemInstruction as { parts: Array<{ text: string }> }).parts[0]!.text
}

describe('the EN/ZH detector', () => {
  it('reads Chinese by script, even around a kept product name', () => {
    expect(detectEnZh('大家早上好')).toBe('zh')
    expect(detectEnZh('我们在 Solana 上部署智能合约')).toBe('zh')
    expect(detectEnZh('好')).toBe('zh')
  })

  it('does not let a Chinese proper noun flip an English line', () => {
    expect(detectEnZh('Welcome to 北京')).toBe('en')
    expect(detectEnZh('the CEO of the bank in 上海')).toBe('en')
  })

  it('reads English by function word or by morphology', () => {
    expect(detectEnZh('Good morning everyone')).toBe('en')
    expect(detectEnZh('Solana validators')).toBe('en')
  })

  it('abstains on romanized names, pinyin and digits', () => {
    expect(detectEnZh('Zhang Wei')).toBeNull()
    expect(detectEnZh('Xiamen Shenzhen')).toBeNull()
    expect(detectEnZh('Blockchain Summit 2026')).toBeNull()
    expect(detectEnZh('2026')).toBeNull()
    expect(detectEnZh('')).toBeNull()
  })
})

describe('the VI/ZH detector', () => {
  it('reads each script, Chinese first', () => {
    expect(detectViZh('大家早上好')).toBe('zh')
    expect(detectViZh('Chào buổi sáng mọi người')).toBe('vi')
    expect(detectViZh('欢迎来到岘港 Đà Nẵng')).toBe('zh')
  })

  it('abstains on text neither script claims', () => {
    expect(detectViZh('Solana validators')).toBeNull()
    expect(detectViZh('Da Nang 2026')).toBeNull()
    expect(detectViZh('')).toBeNull()
  })

  it('never answers a tag outside its pair', () => {
    for (const text of ['Hello everyone', 'Welcome to the forum', 'Transaction throughput matters']) {
      expect(detectViZh(text)).not.toBe('en')
    }
  })
})

describe('the Chinese pinned instruction', () => {
  it('names the pair and pins Simplified script', () => {
    const text = instruction(buildLiveSessionConfig({ model: MODEL, languages: enZh, target: 'zh' }))
    expect(text).toContain('bilingual English/Chinese event')
    expect(text).toContain('Every word of your output must be in Chinese — never respond in English.')
    expect(text).toContain('Write Chinese in Simplified characters only, never Traditional.')
  })

  it('keeps the diacritics order when Vietnamese is in the pair', () => {
    const text = instruction(
      buildLiveSessionConfig({ model: MODEL, languages: viZh, target: 'vi', speakerLang: 'zh' }),
    )
    expect(text).toContain('bilingual Vietnamese/Chinese event')
    expect(text).toContain('The speaker is speaking Chinese. Translate everything they say into Vietnamese.')
    expect(text).toContain(
      'Preserve Vietnamese diacritics exactly. Write Chinese in Simplified characters only, never Traditional. Preserve proper nouns',
    )
  })
})

describe('Chinese in the transcript merge', () => {
  it('counts full-width sentence ends, which take no space after them', () => {
    expect(countSentences('大家好。今天我们讨论区块链！有问题吗？')).toBe(3)
    expect(countSentences('目标是2026。')).toBe(1)
    // The Latin digit guard is unchanged.
    expect(countSentences('About 1.5 to 2.5 seconds')).toBe(0)
  })

  it('reads a near-verbatim Chinese echo as an echo, not a translation', () => {
    // Without per-character tokens the whole clause is one token, and an echo
    // that differs by a character shares nothing with its input.
    const fragments: IncomingFragment[] = [
      { utteranceId: 'u0', targetLang: 'zh', originalText: '今天我们讨论区块链技术', translatedText: '今天我们来讨论区块链技术', final: false, receivedAt: now },
    ]
    expect(inferSourceLanguage(fragments, enZh.pair)).toBe('zh')
  })

  it('publishes a Chinese utterance with its English translation', () => {
    const merger = new UtteranceMerger({ pair: enZh.pair, detect: enZh.detect })
    merger.add({ utteranceId: 'u0', targetLang: 'zh', originalText: '大家早上好，欢迎来到论坛。', final: false, receivedAt: now })
    merger.add({
      utteranceId: 'u0',
      targetLang: 'en',
      originalText: '大家早上好，欢迎来到论坛。',
      translatedText: 'Good morning everyone, welcome to the forum.',
      final: false,
      receivedAt: now,
    })
    const merged = merger.get('u0')
    expect(merged?.sourceLang).toBe('zh')
    expect(merged?.translated).toBe('Good morning everyone, welcome to the forum.')
  })
})
