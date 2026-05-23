import { pinyin as pinyinLib } from 'pinyin'

export function textToPinyin(text: string): string {
  const result = pinyinLib(text, { style: 'NORMAL' })
  const py = result.flat().join('').toLowerCase()
  return py || `item_${Date.now()}`
}
