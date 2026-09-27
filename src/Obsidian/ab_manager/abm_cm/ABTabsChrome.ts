/**
 * Tabs 导航增强：拖拽排序、添加、右键删除/重命名
 * 仅在可写回源码的实时预览环境启用
 */

import { Menu, Notice } from "obsidian"
import type { C2ListPair } from "@/ABConverter/converter/abc_c2list"
import { t } from "@/ABConverter/locales/helper"
import { openABTitleTextEditor } from "./ABEmbedEditor"

export type ABTabsCommitFn = (
  mutate: (pairs: C2ListPair[]) => C2ListPair[],
  activateIndex: number,
) => void

export interface ABTabsChromeOptions {
  tabRoot: HTMLElement
  onCommit: ABTabsCommitFn
  /** 强制重新绑定（软恢复后 DOM 可能仍带旧标记） */
  force?: boolean
}

/** 当前打开的标签右键菜单（全局单例，避免叠开且关不掉） */
let activeTabMenu: Menu | null = null

/** 拖拽来源下标：部分浏览器 drop 时 getData 自定义类型会空，用此兜底 */
let draggingTabFrom = -1
let dragCommitLock = false

export function hideABTabsMenu() {
  try { activeTabMenu?.hide() } catch (_) { /* ignore */ }
  activeTabMenu = null
}

/** 列表重排：from → to（to 为放下时目标项的原始下标） */
export function reorderPairs(pairs: C2ListPair[], from: number, to: number): C2ListPair[] {
  if (from < 0 || to < 0 || from >= pairs.length || to >= pairs.length || from === to) {
    return pairs
  }
  const next = pairs.slice()
  const [moved] = next.splice(from, 1)
  // 先删后插：from < to 时目标下标左移一位
  const insertAt = from < to ? to - 1 : to
  next.splice(insertAt, 0, moved)
  return next
}

/**
 * 为 .ab-tab-root 挂上交互控件（默认幂等；force 时可重绑）
 */
export function enhanceABTabsChrome(opts: ABTabsChromeOptions) {
  const { tabRoot, onCommit, force } = opts
  if (!force && tabRoot.getAttribute("data-ab-tabs-chrome") === "1") return
  tabRoot.setAttribute("data-ab-tabs-chrome", "1")

  const nav = tabRoot.querySelector(":scope > .ab-tab-nav") as HTMLElement | null
  if (!nav) return

  const navItems = () =>
    Array.from(nav.querySelectorAll(":scope > .ab-tab-nav-item")) as HTMLElement[]

  // —— 添加按钮 ——
  let addBtn = nav.querySelector(":scope > .ab-tab-nav-add") as HTMLButtonElement | null
  if (!addBtn) {
    addBtn = document.createElement("button")
    addBtn.className = "ab-tab-nav-add"
    addBtn.type = "button"
    addBtn.setAttribute("aria-label", t("Tab add"))
    addBtn.textContent = "+"
    nav.appendChild(addBtn)
  }
  addBtn.onclick = (e) => {
    e.preventDefault()
    e.stopPropagation()
    hideABTabsMenu()
    const count = navItems().length
    onCommit((pairs) => {
      return [...pairs, { title: t("New tab"), body: "" }]
    }, count)
  }

  // —— 每项：拖拽 + 右键菜单 ——
  for (const item of navItems()) {
    if (force) item.removeAttribute("data-ab-tabs-wired")
    wireNavItem(item)
  }

  function commitReorder(from: number, to: number) {
    if (from < 0 || to < 0 || from === to) return
    if (dragCommitLock) return
    dragCommitLock = true
    try {
      // 放下后激活目标落点（重排后的下标）
      const activate = from < to ? to - 1 : to
      onCommit((pairs) => reorderPairs(pairs, from, to), activate)
    } finally {
      window.setTimeout(() => { dragCommitLock = false }, 100)
    }
  }

  function wireNavItem(item: HTMLElement) {
    if (item.getAttribute("data-ab-tabs-wired") === "1") return
    item.setAttribute("data-ab-tabs-wired", "1")
    item.setAttribute("draggable", "true")

    let dragging = false

    // 左键按下时关掉菜单（块内 click 被捕获拦截，Menu 收不到 document 冒泡）
    item.addEventListener("mousedown", (e: MouseEvent) => {
      if (e.button === 0) hideABTabsMenu()
    }, true)

    item.addEventListener("dragstart", (e: DragEvent) => {
      hideABTabsMenu()
      const idx = parseInt(item.getAttribute("data-ab-item-index") || "-1", 10)
      if (idx < 0) {
        e.preventDefault()
        return
      }
      dragging = true
      draggingTabFrom = idx
      item.classList.add("ab-dragging")
      // text/plain 兜底：部分环境自定义 MIME 在 drop 时读不到
      e.dataTransfer?.setData("text/plain", String(idx))
      e.dataTransfer?.setData("text/ab-tab-index", String(idx))
      if (e.dataTransfer) {
        e.dataTransfer.effectAllowed = "move"
      }
    })

    item.addEventListener("dragend", () => {
      item.classList.remove("ab-dragging")
      for (const el of navItems()) el.classList.remove("ab-drag-over")
      if (dragging) {
        item.classList.add("ab-just-dragged")
        window.setTimeout(() => item.classList.remove("ab-just-dragged"), 0)
      }
      dragging = false
      draggingTabFrom = -1
    })

    item.addEventListener(
      "click",
      (e) => {
        if (item.classList.contains("ab-just-dragged")) {
          e.preventDefault()
          e.stopImmediatePropagation()
          item.classList.remove("ab-just-dragged")
        }
      },
      true,
    )

    item.addEventListener("dragover", (e: DragEvent) => {
      e.preventDefault()
      e.stopPropagation()
      if (e.dataTransfer) e.dataTransfer.dropEffect = "move"
      for (const el of navItems()) el.classList.remove("ab-drag-over")
      if (!item.classList.contains("ab-dragging")) item.classList.add("ab-drag-over")
    })

    item.addEventListener("dragleave", (e: DragEvent) => {
      // 只在真正离开当前项时清样式（避免子节点触发误清）
      const related = e.relatedTarget as Node | null
      if (related && item.contains(related)) return
      item.classList.remove("ab-drag-over")
    })

    item.addEventListener("drop", (e: DragEvent) => {
      e.preventDefault()
      e.stopPropagation()
      item.classList.remove("ab-drag-over")
      const fromRaw =
        e.dataTransfer?.getData("text/ab-tab-index")
        || e.dataTransfer?.getData("text/plain")
        || ""
      let from = parseInt(fromRaw, 10)
      if (isNaN(from) || from < 0) from = draggingTabFrom
      const to = parseInt(item.getAttribute("data-ab-item-index") || "-1", 10)
      draggingTabFrom = -1
      if (isNaN(from) || isNaN(to) || from < 0 || to < 0 || from === to) return
      commitReorder(from, to)
    })

    item.addEventListener("contextmenu", (e: MouseEvent) => {
      e.preventDefault()
      e.stopPropagation()
      const idx = parseInt(item.getAttribute("data-ab-item-index") || "-1", 10)
      if (idx < 0) return
      const title = item.getAttribute("data-ab-item-title") ?? item.textContent ?? ""

      hideABTabsMenu()
      const menu = new Menu()
      activeTabMenu = menu
      menu.addItem((mi) => {
        mi.setTitle(t("Tab rename"))
        mi.onClick(() => {
          openABTitleTextEditor({
            containerEl: item,
            value: title,
            onSubmit: (raw) => {
              const newTitle = raw.trim() || title
              if (newTitle === title) {
                item.textContent = title.slice(0, 20)
                return
              }
              onCommit((pairs) => {
                if (idx >= pairs.length) return pairs
                const next = pairs.slice()
                next[idx] = { ...next[idx], title: newTitle }
                return next
              }, idx)
            },
            onCancel: () => {
              item.textContent = title.slice(0, 20)
            },
          })
        })
      })
      menu.addItem((mi) => {
        mi.setTitle(t("Tab delete"))
        mi.setWarning(true)
        mi.onClick(() => {
          const total = navItems().length
          if (total <= 1) {
            new Notice(t("Tab delete last warn"))
            return
          }
          const activate = Math.max(0, idx - 1)
          onCommit((pairs) => {
            if (idx >= pairs.length) return pairs
            const next = pairs.slice()
            next.splice(idx, 1)
            return next
          }, Math.min(activate, total - 2))
        })
      })
      menu.showAtMouseEvent(e)
    })
  }
}
