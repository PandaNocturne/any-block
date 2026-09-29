/**
 * C2（card/col/tabs）内联编辑宿主
 * Widget（列表/标题选择器）与 CodeBlock（```anyblock）共用
 */

import { MarkdownView, Notice } from "obsidian"
import type { EditorView } from "@codemirror/view"
import { ABConvertManager } from "@/ABConverter/ABConvertManager"
import { C2ListProcess } from "@/ABConverter/converter/abc_c2list"
import {
  isEmbedEditEnabled,
  isEmbedEditSingleClickEnabled,
  openABEmbedEditor,
  openABTitleTextEditor,
  getEmbedEditPlugin,
  restoreMainEditorContext,
  type ABEmbedEditorHandle,
} from "./ABEmbedEditor"
import { enhanceABTabsChrome, hideABTabsMenu } from "./ABTabsChrome"
import {
  applyC2PairsMutation,
  patchC2ItemInFullSrc,
  resolveContentInFullSrc,
} from "./ABEmbedC2Source"

export interface ABEmbedC2HostOptions {
  /** 包含 .ab-items / .ab-tab-root 的容器（通常为 .ab-note） */
  domNote: HTMLElement
  /** 读取整块源码（含 `[header]\n` + content） */
  getFullSrc: () => string | null
  /** 写回整块源码 */
  saveFullSrc: (fullSrc: string) => void
  /** 处理器 header，如 card / list|tabs */
  header: string
  /** 可选：缓存的 content，便于解析 */
  cachedContent?: string
  selectorHint?: string
  /** 关闭内联编辑后还焦点 */
  hostEditorView?: EditorView | null
  /** 是否挂 tabs 拖拽/添加等 chrome（需可写回） */
  enableTabsChrome?: boolean
}

export function isC2EmbedRenderable(domNote: HTMLElement): boolean {
  return !!domNote.querySelector(".ab-items, .ab-tab-root")
}

/**
 * 在 domNote 上挂载内联编辑与（可选）tabs chrome
 */
export function wireABEmbedC2Host(opts: ABEmbedC2HostOptions) {
  const {
    domNote,
    getFullSrc,
    saveFullSrc,
    header,
    cachedContent = "",
    selectorHint = "",
    hostEditorView = null,
    enableTabsChrome = true,
  } = opts

  if (!isC2EmbedRenderable(domNote)) return

  const softRestoreMarkdownPart = (el: HTMLElement, md: string) => {
    el.empty()
    el.removeClass("ab-embed-editor")
    el.removeClass("ab-embed-title-editor")
    if (md.trim() !== "") {
      ABConvertManager.getInstance().m_renderMarkdownFn(md, el)
    }
  }

  const softRestoreTabContent = (
    itemEl: HTMLElement,
    title: string,
    body: string,
    itemIndex: number,
  ) => {
    itemEl.empty()
    itemEl.removeClass("ab-embed-editor")
    C2ListProcess.stampEmbedItemAttrs(itemEl, itemIndex, title, body)
    if (body.trim() !== "") {
      ABConvertManager.getInstance().m_renderMarkdownFn(body, itemEl)
    } else {
      C2ListProcess.ensureEmptyTabContentPlaceholder(itemEl)
    }
  }

  const patchOptsFrom = (fullSrc: string) => {
    const liveCached =
      resolveContentInFullSrc(fullSrc, cachedContent, header, selectorHint)
      ?? cachedContent
    return { cachedContent: liveCached, header, selectorHint }
  }

  if (enableTabsChrome) {
    const root = domNote.querySelector(".ab-tab-root") as HTMLElement | null
    if (root) {
      enhanceABTabsChrome({
        tabRoot: root,
        force: true,
        onCommit: (mutate, activateIndex) => {
          const fullSrc = getFullSrc()
          if (fullSrc == null || !fullSrc.trim()) {
            new Notice("写入失败：无法读取块内容")
            return
          }
          const newFull = applyC2PairsMutation(fullSrc, mutate, patchOptsFrom(fullSrc))
          if (newFull == null) {
            new Notice("写入失败：无法解析标签结构")
            return
          }
          C2ListProcess.setPendingTabActivateIndex(activateIndex)
          saveFullSrc(newFull)
        },
      })
    }
  }

  if (!isEmbedEditEnabled()) return

  let embedEditing = false
  let activeEmbedHandle: ABEmbedEditorHandle | null = null
  let lastEmbedTap: { key: string; at: number } | null = null

  const isEmbedHitTarget = (t: HTMLElement | null) => {
    if (!t?.closest) return false
    return !!t.closest(
      ".ab-items-title, .ab-items-content, .ab-items-item, .ab-tab-nav-item, .ab-tab-content, .ab-tab-content-item, .ab-tab-content-empty, .ab-embed-title-editor, .ab-embed-editor, .ab-embed-title-input"
    )
  }

  const resolveEmbedHit = (target: HTMLElement) => {
    const titlePart = target.closest(".ab-items-title, .ab-tab-nav-item") as HTMLElement | null
    let contentPart = target.closest(".ab-items-content, .ab-tab-content-item") as HTMLElement | null
    // 空标签内容高度可能为 0，点击常落在 .ab-tab-content / 占位上
    if (!contentPart) {
      const tabContent = target.closest(".ab-tab-content") as HTMLElement | null
      const emptyPh = target.closest(".ab-tab-content-empty") as HTMLElement | null
      if (tabContent || emptyPh) {
        const host = tabContent
          ?? (emptyPh?.closest(".ab-tab-content") as HTMLElement | null)
        contentPart = (host?.querySelector(
          ':scope > .ab-tab-content-item[is_activate="true"]'
        ) as HTMLElement | null)
          ?? (emptyPh?.closest(".ab-tab-content-item") as HTMLElement | null)
      }
    }
    const hitTitle = !!(titlePart && !contentPart)
    const hitContent = !!contentPart
    if (!hitTitle && !hitContent) return null
    const hitEl = (hitTitle ? titlePart : contentPart) as HTMLElement
    if (!domNote.contains(hitEl)) return null
    const attrHost = (hitEl.closest("[data-ab-item-index]") as HTMLElement | null) || hitEl
    const idx = attrHost.getAttribute("data-ab-item-index")
      || attrHost.getAttribute("data-ab-card-index")
      || "?"
    const key = `${idx}:${hitTitle ? "t" : "c"}`
    return { hitEl, hitTitle, hitContent, key }
  }

  const isInsideActiveEmbed = (t: HTMLElement | null) =>
    !!t?.closest?.(".ab-embed-title-input, .ab-embed-editor, .ab-embed-title-editor")

  const onDocEmbedOutside = (e: MouseEvent) => {
    if (!embedEditing || !activeEmbedHandle) return
    const t = e.target as HTMLElement | null
    if (isInsideActiveEmbed(t)) return
    if (t && domNote.contains(t)) return
    exitEmbedOnOutside()
  }
  const armOutsideExit = () => {
    document.addEventListener("mousedown", onDocEmbedOutside, true)
  }
  const disarmOutsideExit = () => {
    document.removeEventListener("mousedown", onDocEmbedOutside, true)
  }

  const exitEmbedOnOutside = () => {
    if (!embedEditing || !activeEmbedHandle) return
    const h = activeEmbedHandle
    activeEmbedHandle = null
    disarmOutsideExit()
    h.submit()
  }

  const startEmbedEdit = (hitEl: HTMLElement, hitTitle: boolean, clientX: number, clientY: number) => {
    if (!isEmbedEditEnabled() || embedEditing) return
    const plugin = getEmbedEditPlugin()
    if (!plugin) return

    const attrHost = (hitEl.closest("[data-ab-item-index]") as HTMLElement | null) || hitEl
    const itemIndex = parseInt(
      attrHost.getAttribute("data-ab-item-index")
        || attrHost.getAttribute("data-ab-card-index")
        || "-1",
      10
    )
    if (itemIndex < 0) return

    // 标题节点可能仍带着空 body 标记；优先从条目容器读完整 title/body
    const itemHost = (hitEl.closest(".ab-items-item") as HTMLElement | null)
      || (hitEl.closest(".ab-tab-root") && attrHost)
      || attrHost
    const title = itemHost.getAttribute("data-ab-item-title")
      ?? itemHost.getAttribute("data-ab-card-title")
      ?? attrHost.getAttribute("data-ab-item-title")
      ?? attrHost.getAttribute("data-ab-card-title")
      ?? ""
    const body = itemHost.getAttribute("data-ab-item-body")
      ?? itemHost.getAttribute("data-ab-card-body")
      ?? attrHost.getAttribute("data-ab-item-body")
      ?? attrHost.getAttribute("data-ab-card-body")
      ?? ""

    const fullSrc = getFullSrc()
    if (fullSrc == null) {
      new Notice("写入失败：无法读取块内容")
      return
    }
    const liveOpts = patchOptsFrom(fullSrc)
    const file = plugin.app.workspace.getActiveViewOfType(MarkdownView)?.file ?? null
    const prevActiveEditor = (plugin.app.workspace as any).activeEditor ?? null

    const commitItem = (newTitle: string, newBody: string): string | null => {
      return patchC2ItemInFullSrc(fullSrc, itemIndex, newTitle, newBody, liveOpts)
    }

    // —— tabs 标题：纯文本 ——
    if (hitTitle && hitEl.classList.contains("ab-tab-nav-item")) {
      embedEditing = true
      activeEmbedHandle = openABTitleTextEditor({
        containerEl: hitEl,
        value: title,
        onSubmit: (newTitleRaw: string) => {
          activeEmbedHandle = null
          embedEditing = false
          disarmOutsideExit()
          restoreMainEditorContext(plugin.app, prevActiveEditor, null, hostEditorView)
          const newTitle = newTitleRaw.trim() || title
          if (newTitle === title) {
            hitEl.textContent = title.slice(0, 20)
            return
          }
          const newFull = commitItem(newTitle, body)
          if (newFull == null) {
            new Notice("写入失败：无法解析条目结构")
            hitEl.textContent = title.slice(0, 20)
            return
          }
          C2ListProcess.setPendingTabActivateIndex(
            C2ListProcess.getActiveTabIndex(domNote, itemIndex)
          )
          saveFullSrc(newFull)
        },
        onCancel: () => {
          activeEmbedHandle = null
          embedEditing = false
          disarmOutsideExit()
          restoreMainEditorContext(plugin.app, prevActiveEditor, null, hostEditorView)
          hitEl.textContent = title.slice(0, 20)
        },
      })
      armOutsideExit()
      return
    }

    const isTabContent = hitEl.classList.contains("ab-tab-content-item")
    const isCardContent = hitEl.classList.contains("ab-items-content")
    const isCardTitle = hitEl.classList.contains("ab-items-title")
    const editValue = hitTitle
      ? title
      : C2ListProcess.normalizeC2BodyForEdit(body)

    /** 打开同条目的内容区编辑（标题回车后切入） */
    const openCardContentEdit = (pendingTitle: string, pendingBody: string) => {
      const itemHost = (hitEl.closest(".ab-items-item") as HTMLElement | null) || attrHost
      let contentEl = itemHost.querySelector(":scope > .ab-items-content") as HTMLElement | null
      // 仅有标题、无 body 时 DOM 可能没有 content 节点，补一个空容器再进编辑
      if (!contentEl) {
        contentEl = document.createElement("div")
        contentEl.classList.add("ab-items-content")
        itemHost.appendChild(contentEl)
      }
      C2ListProcess.stampEmbedItemAttrs(itemHost, itemIndex, pendingTitle, pendingBody)
      C2ListProcess.stampEmbedItemAttrs(hitEl, itemIndex, pendingTitle, pendingBody)
      C2ListProcess.stampEmbedItemAttrs(contentEl, itemIndex, pendingTitle, pendingBody)

      embedEditing = true
      const contentHandle = openABEmbedEditor({
        plugin,
        app: plugin.app,
        containerEl: contentEl,
        file,
        value: C2ListProcess.normalizeC2BodyForEdit(pendingBody),
        escapeToCancel: true,
        hostEditorView,
        onCancel: () => {
          activeEmbedHandle = null
          embedEditing = false
          disarmOutsideExit()
          softRestoreMarkdownPart(contentEl!, pendingBody)
          if (pendingTitle !== title) {
            const newFull = commitItem(pendingTitle, pendingBody)
            if (newFull != null) saveFullSrc(newFull)
          }
        },
        onSubmit: (bodyText: string) => {
          activeEmbedHandle = null
          embedEditing = false
          disarmOutsideExit()
          const newBody = bodyText.replace(/\n$/, "")
          if (pendingTitle === title && newBody === pendingBody.replace(/\n$/, "")) {
            softRestoreMarkdownPart(contentEl!, pendingBody)
            return
          }
          const newFull = commitItem(pendingTitle, newBody)
          if (newFull == null) {
            new Notice("写入失败：无法解析条目结构")
            softRestoreMarkdownPart(contentEl!, pendingBody)
            return
          }
          saveFullSrc(newFull)
        },
      })
      if (!contentHandle) {
        embedEditing = false
        activeEmbedHandle = null
        disarmOutsideExit()
        restoreMainEditorContext(plugin.app, prevActiveEditor, null, hostEditorView)
      } else {
        activeEmbedHandle = contentHandle
        armOutsideExit()
        contentHandle.focus()
        window.setTimeout(() => contentHandle.focus(), 0)
        window.setTimeout(() => contentHandle.focus(), 50)
      }
    }

    embedEditing = true
    const handle = openABEmbedEditor({
      plugin,
      app: plugin.app,
      containerEl: hitEl,
      file,
      value: editValue,
      clickCoords: { x: clientX, y: clientY },
      escapeToCancel: true,
      hostEditorView,
      onEnter: (isCardTitle && hitTitle)
        ? (newText: string, cursorPos?: number) => {
            activeEmbedHandle = null
            const split = C2ListProcess.splitC2TitleAtCursor(newText, cursorPos, body)
            const newTitle = split.title || title
            softRestoreMarkdownPart(hitEl, newTitle)
            openCardContentEdit(newTitle, split.body)
          }
        : undefined,
      onCancel: () => {
        activeEmbedHandle = null
        embedEditing = false
        disarmOutsideExit()
        if (isTabContent) softRestoreTabContent(hitEl, title, body, itemIndex)
        else if (isCardContent || isCardTitle) softRestoreMarkdownPart(hitEl, hitTitle ? title : body)
      },
      onSubmit: (newText: string) => {
        activeEmbedHandle = null
        embedEditing = false
        disarmOutsideExit()
        const trimmed = newText.replace(/\n$/, "")
        if (trimmed === editValue.replace(/\n$/, "")) {
          if (isTabContent) softRestoreTabContent(hitEl, title, body, itemIndex)
          else if (isCardContent || isCardTitle) softRestoreMarkdownPart(hitEl, hitTitle ? title : body)
          return
        }
        let newTitle = title
        let newBody = body
        if (hitTitle) {
          // 首行作标题，其余行并入正文（粘贴多行时不丢内容）
          const split = C2ListProcess.splitC2TitleOverflow(trimmed, body)
          newTitle = split.title || title
          newBody = split.body
        } else {
          newBody = trimmed
        }
        const newFull = commitItem(newTitle, newBody)
        if (newFull == null) {
          new Notice("写入失败：无法解析条目结构")
          if (isTabContent) softRestoreTabContent(hitEl, title, body, itemIndex)
          else if (isCardContent || isCardTitle) softRestoreMarkdownPart(hitEl, hitTitle ? title : body)
          return
        }
        if (isTabContent) {
          if (C2ListProcess.peekPendingTabActivateIndex() == null) {
            C2ListProcess.setPendingTabActivateIndex(
              C2ListProcess.getActiveTabIndex(domNote, itemIndex)
            )
          }
        }
        saveFullSrc(newFull)
      },
    })
    if (!handle) {
      embedEditing = false
      activeEmbedHandle = null
    } else {
      activeEmbedHandle = handle
      armOutsideExit()
    }
  }

  const onEmbedPointerDown = (e: MouseEvent) => {
    const t = e.target as HTMLElement | null
    if (!isEmbedHitTarget(t)) return

    if (t?.closest?.(".ab-button, .ab-tab-nav-add")) {
      hideABTabsMenu()
      if (embedEditing && !isInsideActiveEmbed(t)) exitEmbedOnOutside()
      return
    }

    if (isInsideActiveEmbed(t)) {
      e.stopPropagation()
      return
    }

    if (e.button !== 0) {
      e.stopPropagation()
      return
    }

    hideABTabsMenu()

    const tabNav = t?.closest?.(".ab-tab-nav-item") as HTMLElement | null
    const tabRoot = tabNav?.closest?.(".ab-tab-root") as HTMLElement | null
    const tabIdx = tabNav
      ? parseInt(tabNav.getAttribute("data-ab-item-index") || "-1", 10)
      : -1

    if (tabNav && tabRoot && tabIdx >= 0) {
      e.stopPropagation()

      if (embedEditing) {
        lastEmbedTap = null
        C2ListProcess.setPendingTabActivateIndex(tabIdx)
        exitEmbedOnOutside()
        if (tabRoot.isConnected) {
          C2ListProcess.activateTabIndex(tabRoot, tabIdx)
          C2ListProcess.setPendingTabActivateIndex(null)
        }
        return
      }

      if ((e.ctrlKey || e.metaKey) && isEmbedEditEnabled()) {
        e.preventDefault()
        lastEmbedTap = null
        startEmbedEdit(tabNav, true, e.clientX, e.clientY)
        return
      }

      if (isEmbedEditSingleClickEnabled()) {
        const isActive = tabNav.getAttribute("is_activate") === "true"
        if (isActive) {
          e.preventDefault()
          lastEmbedTap = null
          startEmbedEdit(tabNav, true, e.clientX, e.clientY)
        } else {
          C2ListProcess.activateTabIndex(tabRoot, tabIdx)
          lastEmbedTap = null
        }
        return
      }

      const key = `${tabIdx}:t`
      const now = Date.now()
      const isDouble =
        isEmbedEditEnabled()
        && lastEmbedTap
        && lastEmbedTap.key === key
        && now - lastEmbedTap.at < 550

      if (isDouble) {
        e.preventDefault()
        lastEmbedTap = null
        startEmbedEdit(tabNav, true, e.clientX, e.clientY)
      } else {
        C2ListProcess.activateTabIndex(tabRoot, tabIdx)
        lastEmbedTap = isEmbedEditEnabled() ? { key, at: now } : null
      }
      return
    }

    e.stopPropagation()

    if (embedEditing) {
      e.preventDefault()
      lastEmbedTap = null
      exitEmbedOnOutside()
      return
    }

    if (!isEmbedEditEnabled()) return

    const hit = resolveEmbedHit(t!)
    if (!hit) {
      lastEmbedTap = null
      return
    }

    if (e.ctrlKey || e.metaKey) {
      e.preventDefault()
      lastEmbedTap = null
      startEmbedEdit(hit.hitEl, hit.hitTitle, e.clientX, e.clientY)
      return
    }

    if (isEmbedEditSingleClickEnabled()) {
      e.preventDefault()
      lastEmbedTap = null
      startEmbedEdit(hit.hitEl, hit.hitTitle, e.clientX, e.clientY)
      return
    }

    const now = Date.now()
    const isDouble =
      lastEmbedTap
      && lastEmbedTap.key === hit.key
      && now - lastEmbedTap.at < 550

    if (isDouble) {
      e.preventDefault()
      lastEmbedTap = null
      startEmbedEdit(hit.hitEl, hit.hitTitle, e.clientX, e.clientY)
    } else {
      lastEmbedTap = { key: hit.key, at: now }
    }
  }

  domNote.addEventListener("mousedown", onEmbedPointerDown, true)

  const stopSelectDragToCM = (e: MouseEvent) => {
    if (!(e.buttons & 1)) return
    if (!isEmbedHitTarget(e.target as HTMLElement)) return
    if (isInsideActiveEmbed(e.target as HTMLElement)) return
    e.stopPropagation()
  }
  domNote.addEventListener("mousemove", stopSelectDragToCM, true)

  const stopBubbleToCM = (e: Event) => {
    if (!isEmbedHitTarget(e.target as HTMLElement)) return
    e.stopPropagation()
  }
  for (const type of ["mouseup", "click", "dblclick"] as const) {
    domNote.addEventListener(type, stopBubbleToCM, true)
  }
}
