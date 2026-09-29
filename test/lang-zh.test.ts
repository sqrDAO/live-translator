import { describe, expect, it } from 'vitest'

import { buildLiveSessionConfig } from '../src/gemini/config'
import { detectOutputLanguage, enVi } from '../src/lang/en-vi'
import { detectEnZh, enZh } from '../src/lang/en-zh'
import { detectViZh, viZh } from '../src/lang/vi-zh'
import { TargetTurnCoordinator } from '../src/transcript/coordinator'
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

describe('translations in a language the session was not asked for', () => {
  // PROBED 2026-09-29: in a VI/ZH feed on Auto, the zh-target session answered
  // Vietnamese speech in English. VI/ZH's own detector abstains on English, so
  // only the pack's output classifier can see it.
  const vi = 'Chào buổi sáng mọi người, chào mừng đến với diễn đàn hôm nay.'
  const english = 'Good morning everyone, welcome to the forum today.'

  function viZhMerger(allowSourceOnly: boolean) {
    return new UtteranceMerger({ pair: viZh.pair, detect: viZh.detect, detectOutput: viZh.detectOutput!, allowSourceOnly })
  }

  it('classifies output across all three bundled languages', () => {
    expect(detectOutputLanguage(english)).toBe('en')
    expect(detectOutputLanguage(vi)).toBe('vi')
    expect(detectOutputLanguage('大家早上好，欢迎来到今天的论坛。')).toBe('zh')
    // Abstains where no pack could decide: a lone kept product name.
    expect(detectOutputLanguage('Solana')).toBeNull()
  })

  it('drops an English translation in VI/ZH, keeping the Vietnamese caption', () => {
    const merger = viZhMerger(true)
    merger.add({ utteranceId: 'u0', targetLang: 'vi', originalText: vi, final: false, receivedAt: now })
    merger.add({ utteranceId: 'u0', targetLang: 'zh', originalText: vi, translatedText: english, final: false, receivedAt: now })
    expect(merger.get('u0')).toMatchObject({ sourceLang: 'vi', original: vi, translated: '' })
  })

  it('publishes nothing for a host that needs a complete pair', () => {
    const merger = viZhMerger(false)
    merger.add({ utteranceId: 'u0', targetLang: 'zh', originalText: vi, translatedText: english, final: true, receivedAt: now })
    expect(merger.get('u0')).toBeNull()
  })

  it('keeps an on-target translation, and one it cannot classify', () => {
    const merger = viZhMerger(true)
    merger.add({ utteranceId: 'u0', targetLang: 'zh', originalText: vi, translatedText: '大家早上好，欢迎来到今天的论坛。', final: false, receivedAt: now })
    expect(merger.get('u0')?.translated).toBe('大家早上好，欢迎来到今天的论坛。')

    // An early partial that is only a kept name abstains, so it streams on.
    merger.add({ utteranceId: 'u1', targetLang: 'zh', originalText: 'Solana là', translatedText: 'Solana', final: false, receivedAt: now })
    expect(merger.get('u1')?.translated).toBe('Solana')
  })

  it('reaches the merge through the coordinator the engine builds', () => {
    const c = new TargetTurnCoordinator(1500, {
      pair: viZh.pair, detect: viZh.detect, detectOutput: viZh.detectOutput!, allowSourceOnly: true,
    })
    const published = [
      ...c.accept('vi', { inputText: vi }, now),
      ...c.accept('zh', { inputText: vi, outputText: english }, now + 1),
      ...c.finalizeIdle(now + 10_000),
    ].flatMap((p) => ('merged' in p ? [p.merged] : []))
    expect(published.length).toBeGreaterThan(0)
    for (const merged of published) {
      expect(merged.sourceLang).toBe('vi')
      expect(merged.translated).toBe('')
    }
  })

  it('also rejects Chinese from a session in EN/VI', () => {
    const merger = new UtteranceMerger({ pair: enVi.pair, detect: enVi.detect, detectOutput: enVi.detectOutput!, allowSourceOnly: true })
    merger.add({ utteranceId: 'u0', targetLang: 'vi', originalText: 'Good morning everyone', translatedText: '大家早上好', final: false, receivedAt: now })
    expect(merger.get('u0')?.translated).toBe('')
  })
})

describe('review findings on PR #10', () => {
  it('reads a Chinese line that keeps a romanized Vietnamese name as Chinese', () => {
    // 4 Han against 3 Latin words failed the old two-to-one bar.
    expect(detectViZh('你好，我是Nguyễn Văn Minh')).toBe('zh')
    expect(detectEnZh('你好，我是Nguyễn Văn Minh')).toBe('zh')
    // And an English line that kept a Chinese name is still English.
    expect(detectEnZh('Welcome to 北京')).toBe('en')
  })

  it('keeps the Vietnamese caption when its Chinese translation keeps the name', () => {
    const merger = new UtteranceMerger({ pair: viZh.pair, detect: viZh.detect, detectOutput: viZh.detectOutput!, allowSourceOnly: true })
    merger.add({ utteranceId: 'u0', targetLang: 'zh', originalText: 'Xin chào, tôi là Nguyễn Văn Minh', translatedText: '你好，我是Nguyễn Văn Minh', final: false, receivedAt: now })
    expect(merger.get('u0')).toMatchObject({ sourceLang: 'vi', translated: '你好，我是Nguyễn Văn Minh' })
  })

  it('does not read English quoting a Vietnamese place as Vietnamese', () => {
    expect(detectViZh('Welcome to Đà Nẵng')).toBeNull()
    expect(detectViZh('Chào mừng đến Đà Nẵng')).toBe('vi')
  })

  it('shows the Vietnamese caption untranslated when the English quotes a place', () => {
    const merger = new UtteranceMerger({ pair: viZh.pair, detect: viZh.detect, detectOutput: viZh.detectOutput!, allowSourceOnly: true })
    merger.add({ utteranceId: 'u0', targetLang: 'zh', originalText: 'Chào mừng đến Đà Nẵng', translatedText: 'Welcome to Đà Nẵng', final: false, receivedAt: now })
    expect(merger.get('u0')).toMatchObject({ sourceLang: 'vi', original: 'Chào mừng đến Đà Nẵng', translated: '', translationRejected: true })
  })

  it('still applies the sentence cap when every translation is rejected', () => {
    const c = new TargetTurnCoordinator(1500, {
      pair: viZh.pair, detect: viZh.detect, detectOutput: viZh.detectOutput!, allowSourceOnly: true, maxUtteranceSentences: 2,
    })
    const published = c.accept(
      'zh',
      { inputText: 'Chào buổi sáng mọi người. Chúng ta sẽ thảo luận về bảo mật. ', outputText: 'Good morning everyone. We will discuss security. ' },
      now,
    )
    const finals = published.filter((p) => p.kind === 'final')
    expect(finals).toHaveLength(1)
    expect(finals[0]).toMatchObject({ merged: { sourceLang: 'vi', translated: '' } })
  })
})
