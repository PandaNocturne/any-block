/**
 * C2（card/col/tabs）源码变换纯函数
 * 供 Widget / CodeBlock 内联编辑写回共用
 */

import { C2ListProcess, type C2ListPair, type List_C2ListItem } from "@/ABConverter/converter/abc_c2list"

export function isTitleC2Source(
  content: string,
  header = "",
  selectorHint = "",
): boolean {
  const first = content.trimStart().split("\n")[0] ?? ""
  if (/^#{1,6}\s/.test(first)) return true
  if (selectorHint === "heading") return true
  if (/title2(card|col|tabs?|timeline)/i.test(header)) return true
  return false
}

/** 从 fullSrc（通常为 `[header]\ncontent`）解析可替换 content 段 */
export function resolveContentInFullSrc(
  fullSrc: string,
  cachedContent = "",
  header = "",
  selectorHint = "",
): string | null {
  if (cachedContent) {
    if (fullSrc.includes(cachedContent)) return cachedContent
    const alt = cachedContent.replace(/\n$/, "")
    if (alt && fullSrc.includes(alt)) return alt
    const withNl = cachedContent.endsWith("\n") ? cachedContent : cachedContent + "\n"
    if (fullSrc.includes(withNl)) return withNl
  }

  const lines = fullSrc.split("\n")
  if (lines.length >= 2) {
    const first = lines[0]
    const looksBraceHeader = /^\s*[`\[].*[\]`]\s*$/.test(first)
      || (header && first.includes("[") && first.includes("]"))
    if (looksBraceHeader) {
      return lines.slice(1).join("\n")
    }
    if (/^\s*:{3,}/.test(first)) {
      let end = lines.length
      for (let i = lines.length - 1; i > 0; i--) {
        if (/^\s*:{3,}/.test(lines[i])) { end = i; break }
      }
      return lines.slice(1, end).join("\n")
    }
  }

  if (selectorHint === "heading" || /^#{1,6}\s/.test(fullSrc.trimStart())) {
    return fullSrc
  }
  if (/^\s*[-*+]\s/.test(fullSrc)) return fullSrc
  return null
}

export function replaceContentInFullSrc(
  fullSrc: string,
  oldContent: string,
  newContent: string,
): string | null {
  const idx = fullSrc.lastIndexOf(oldContent)
  if (idx >= 0) {
    return fullSrc.slice(0, idx) + newContent + fullSrc.slice(idx + oldContent.length)
  }
  const alt = oldContent.replace(/\n$/, "")
  const idx2 = fullSrc.lastIndexOf(alt)
  if (idx2 < 0) return null
  return fullSrc.slice(0, idx2) + newContent + fullSrc.slice(idx2 + alt.length)
}

export function applyC2PairsMutation(
  fullSrc: string,
  mutate: (pairs: C2ListPair[]) => C2ListPair[],
  opts?: {
    cachedContent?: string
    header?: string
    selectorHint?: string
  },
): string | null {
  const header = opts?.header ?? ""
  const selectorHint = opts?.selectorHint ?? ""
  const oldContent = resolveContentInFullSrc(
    fullSrc,
    opts?.cachedContent ?? "",
    header,
    selectorHint,
  )
  if (oldContent == null) return null

  const titleSrc = isTitleC2Source(oldContent, header, selectorHint)
  let data: List_C2ListItem
  try {
    data = titleSrc
      ? C2ListProcess.title2c2data(oldContent)
      : C2ListProcess.list2c2data(oldContent)
  } catch (_) {
    return null
  }
  if (!data.length) return null
  const pairs = mutate(C2ListProcess.c2dataToPairs(data))
  if (!pairs.length) return null
  const newData = C2ListProcess.pairsToC2data(pairs)
  const newContent = titleSrc
    ? C2ListProcess.c2data2title(
        newData,
        C2ListProcess.detectC2TitleHeadingLevel(oldContent),
      )
    : C2ListProcess.c2data2list(newData)
  return replaceContentInFullSrc(fullSrc, oldContent, newContent)
}

export function patchC2ItemInFullSrc(
  fullSrc: string,
  itemIndex: number,
  newTitle: string,
  newBody: string,
  opts?: {
    cachedContent?: string
    header?: string
    selectorHint?: string
  },
): string | null {
  return applyC2PairsMutation(
    fullSrc,
    (pairs) => {
      if (itemIndex < 0 || itemIndex >= pairs.length) return pairs
      const next = pairs.slice()
      next[itemIndex] = { title: newTitle, body: newBody }
      return next
    },
    opts,
  )
}
