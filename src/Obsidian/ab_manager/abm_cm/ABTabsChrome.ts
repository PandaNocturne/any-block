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

export function hideABTabsMenu() {
  try { activeTabMenu?.hide() } catch (_) { /* ignore */ }
  activeTabMenu = null
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
      item.classList.add("ab-dragging")
      e.dataTransfer?.setData("text/ab-tab-index", String(idx))
      if (e.dataTransfer) e.dataTransfer.effectAllowed = "move"
    })

    item.addEventListener("dragend", () => {
      item.classList.remove("ab-dragging")
      for (const el of navItems()) el.classList.remove("ab-drag-over")
      // 拖拽结束后抑制一次 click，避免误切换
      if (dragging) {
        item.classList.add("ab-just-dragged")
        window.setTimeout(() => item.classList.remove("ab-just-dragged"), 0)
      }
      dragging = false
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

    item.addEventListener("dragleave", () => {
      item.classList.remove("ab-drag-over")
    })

    item.addEventListener("drop", (e: DragEvent) => {
      e.preventDefault()
      e.stopPropagation()
      item.classList.remove("ab-drag-over")
      const fromRaw = e.dataTransfer?.getData("text/ab-tab-index") ?? ""
      const from = parseInt(fromRaw, 10)
      const to = parseInt(item.getAttribute("data-ab-item-index") || "-1", 10)
      if (isNaN(from) || isNaN(to) || from < 0 || to < 0 || from === to) return
      onCommit((pairs) => {
        if (from >= pairs.length || to >= pairs.length) return pairs
        const next = pairs.slice()
        const [moved] = next.splice(from, 1)
        next.splice(to, 0, moved)
        return next
      }, to)
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
