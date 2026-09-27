/**
 * 嵌入编辑器（参考 obsidian-kanban）
 *
 * 通过 embedRegistry 取出 Obsidian 内部 MarkdownEditor，
 * 在 AnyBlock 渲染块内就地编辑，并写回主编辑器对应区间。
 */

import type { App, Plugin, TFile } from "obsidian"
import { EditorSelection, Prec, type Extension } from "@codemirror/state"
import { EditorView, keymap } from "@codemirror/view"

/** 插件实例引用（由 main 在 onload 时注入，避免循环依赖） */
let _pluginRef: Plugin | null = null
/** Obsidian 内部 MarkdownEditor 构造函数 */
let _MarkdownEditorClass: any = null

export function setEmbedEditPlugin(plugin: Plugin) {
  _pluginRef = plugin
}

export function getEmbedEditPlugin(): Plugin | null {
  return _pluginRef
}

export function setMarkdownEditorClass(cls: any) {
  _MarkdownEditorClass = cls
}

/** 是否开启嵌入编辑 */
export function isEmbedEditEnabled(): boolean {
  const p = _pluginRef as any
  return !!(p?.settings?.embed_edit)
}

/** 从 Obsidian 嵌入体系中取出内部 MarkdownEditor 构造函数 */
export function getObsidianMarkdownEditorClass(app: App): any {
  // @ts-expect-error Obsidian 私有 API: embedRegistry
  const md = app.embedRegistry.embedByExtension.md(
    { app, containerEl: document.createElement("div"), state: {} },
    null,
    ""
  )
  md.load()
  md.editable = true
  md.showEditor()
  const MarkdownEditor = Object.getPrototypeOf(Object.getPrototypeOf(md.editMode)).constructor
  md.unload()
  return MarkdownEditor
}

export interface ABEmbedEditorOptions {
  plugin: Plugin
  app: App
  /** 放置编辑器的容器（通常为 .ab-note） */
  containerEl: HTMLElement
  /** 当前笔记文件，用于嵌入编辑器的路径/链接解析 */
  file: TFile | null
  /** 初始文本（整段 AB 块源码，含 header） */
  value: string
  /** 双击坐标，用于定位光标 */
  clickCoords?: { x: number; y: number }
  /** 提交（失焦 / Esc / Ctrl+Enter） */
  onSubmit: (value: string) => void
  /** 取消（可选） */
  onCancel?: () => void
}

export interface ABEmbedEditorHandle {
  destroy: () => void
  getValue: () => string
}

/**
 * 在容器中打开嵌入 Markdown 编辑器
 */
export function openABEmbedEditor(opts: ABEmbedEditorOptions): ABEmbedEditorHandle | null {
  const MarkdownEditorClass = _MarkdownEditorClass
  if (!MarkdownEditorClass) {
    console.warn("[AnyBlock] MarkdownEditor 未初始化，无法使用嵌入编辑")
    return null
  }

  // 先测量原渲染尺寸，empty 前锁定，避免双击后宽高塌缩/跳动
  const rect = opts.containerEl.getBoundingClientRect()
  const cs = window.getComputedStyle(opts.containerEl)
  const lockedWidth = Math.max(rect.width, 80)
  const lockedHeight = Math.max(rect.height, 48)
  const prevInline = {
    width: opts.containerEl.style.width,
    minWidth: opts.containerEl.style.minWidth,
    height: opts.containerEl.style.height,
    minHeight: opts.containerEl.style.minHeight,
    maxWidth: opts.containerEl.style.maxWidth,
    boxSizing: opts.containerEl.style.boxSizing,
    padding: opts.containerEl.style.padding,
    margin: opts.containerEl.style.margin,
  }
  // 用 outline 提示编辑态，不挤占布局尺寸；保留原 padding/margin 观感
  opts.containerEl.style.boxSizing = "border-box"
  opts.containerEl.style.width = `${lockedWidth}px`
  opts.containerEl.style.minWidth = `${lockedWidth}px`
  opts.containerEl.style.minHeight = `${lockedHeight}px`
  // 高度至少与原文一致，内容变长时可自然增高
  opts.containerEl.style.height = "auto"
  if (!opts.containerEl.style.padding && cs.padding && cs.padding !== "0px") {
    opts.containerEl.style.padding = cs.padding
  }

  opts.containerEl.empty()
  opts.containerEl.addClass("ab-embed-editor")

  const editorEl = opts.containerEl.createDiv({ cls: ["cm-table-widget", "ab-embed-editor-inner"] })
  editorEl.style.minHeight = `${Math.max(lockedHeight - 8, 40)}px`
  editorEl.style.width = "100%"
  editorEl.style.boxSizing = "border-box"

  let destroyed = false
  let cm: EditorView | null = null
  let editorInstance: any = null

  const getValue = (): string => {
    return cm?.state.doc.toString() ?? opts.value
  }

  const restoreBox = () => {
    opts.containerEl.style.width = prevInline.width
    opts.containerEl.style.minWidth = prevInline.minWidth
    opts.containerEl.style.height = prevInline.height
    opts.containerEl.style.minHeight = prevInline.minHeight
    opts.containerEl.style.maxWidth = prevInline.maxWidth
    opts.containerEl.style.boxSizing = prevInline.boxSizing
    opts.containerEl.style.padding = prevInline.padding
    opts.containerEl.style.margin = prevInline.margin
  }

  const destroy = () => {
    if (destroyed) return
    destroyed = true
    try {
      if (editorInstance) {
        opts.plugin.removeChild(editorInstance)
        editorInstance = null
      }
    } catch (_) { /* ignore */ }
    cm = null
    opts.containerEl.removeClass("ab-embed-editor")
    restoreBox()
  }

  const submit = () => {
    if (destroyed) return
    const text = getValue()
    destroy()
    opts.onSubmit(text)
  }

  // 伪造 markdown controller，让内部 Editor 以为处于源码模式
  const controller: Record<string, any> = {
    app: opts.app,
    showSearch: () => {},
    toggleMode: () => {},
    onMarkdownScroll: () => {},
    getMode: () => "source",
    scroll: 0,
    editMode: null,
    get editor() {
      return editorInstance?.editor
    },
    get file() {
      return opts.file
    },
    get path() {
      return opts.file?.path ?? ""
    },
  }

  class ABInlineEditor extends MarkdownEditorClass {
    isAnyBlockEmbedEditor = true

    updateBottomPadding() {}

    buildLocalExtensions(): Extension[] {
      const extensions: Extension[] = super.buildLocalExtensions()
      // 贴近原文排版：紧凑行高，避免默认编辑器把块撑得过大
      extensions.push(
        EditorView.theme({
          "&": {
            height: "100%",
            fontSize: "inherit",
          },
          ".cm-scroller": {
            fontFamily: "inherit",
            lineHeight: "inherit",
            overflow: "auto",
          },
          ".cm-content": {
            padding: "0",
            caretColor: "var(--text-normal)",
          },
          "&.cm-focused": {
            outline: "none",
          },
        })
      )
      extensions.push(
        Prec.highest(
          keymap.of([
            {
              key: "Escape",
              run: () => {
                submit()
                return true
              },
              preventDefault: true,
            },
            {
              key: "Mod-Enter",
              run: () => {
                submit()
                return true
              },
              preventDefault: true,
            },
          ])
        )
      )
      extensions.push(
        Prec.highest(
          EditorView.domEventHandlers({
            blur: () => {
              // 延后，避免点击工具栏等导致误提交
              window.setTimeout(() => {
                if (destroyed) return
                if (opts.containerEl.contains(document.activeElement)) return
                submit()
              }, 150)
              return true
            },
          })
        )
      )
      return extensions
    }
  }

  editorInstance = opts.plugin.addChild(new (ABInlineEditor as any)(opts.app, editorEl, controller))
  cm = editorInstance.cm as EditorView
  controller.editMode = editorInstance
  editorInstance.set(opts.value || "")

  // 按双击坐标放置光标
  if (opts.clickCoords && cm) {
    try {
      const pos = cm.posAtCoords(opts.clickCoords, false)
      if (typeof pos === "number" && pos >= 0) {
        cm.dispatch({
          userEvent: "select.pointer",
          selection: EditorSelection.single(pos),
        })
      }
    } catch (_) { /* ignore */ }
  }

  window.setTimeout(() => {
    cm?.focus()
    // 再次请求布局，确保 scroller 填满锁定高度
    cm?.requestMeasure()
  }, 0)

  return { destroy, getValue }
}

export interface ABTitleTextEditorOptions {
  /** 通常为 .ab-tab-nav-item 按钮 */
  containerEl: HTMLElement
  /** 完整标题文本（非截断显示） */
  value: string
  onSubmit: (value: string) => void
  onCancel?: () => void
}

/**
 * 标题纯文本就地编辑（contenteditable，非 MarkdownEditor）
 * 避免在 button 内嵌 input（非法 HTML / 点击冒泡问题）
 */
export function openABTitleTextEditor(opts: ABTitleTextEditorOptions): ABEmbedEditorHandle {
  const el = opts.containerEl
  const prevText = el.textContent ?? ""
  const prevEditable = el.getAttribute("contenteditable")
  const prevOnClick = el.onclick
  el.addClass("ab-embed-title-editor")
  el.textContent = opts.value
  el.setAttribute("contenteditable", "plaintext-only")
  // 部分浏览器不支持 plaintext-only，回退
  if (el.contentEditable !== "plaintext-only" && el.contentEditable !== "true") {
    el.contentEditable = "true"
  }
  el.style.cursor = "text"
  // 编辑期间禁止 tab 切换
  el.onclick = (ev) => {
    ev.stopPropagation()
    ev.preventDefault()
  }

  let destroyed = false

  const cleanupStyle = () => {
    el.removeClass("ab-embed-title-editor")
    el.style.cursor = ""
    el.onclick = prevOnClick
    if (prevEditable == null) el.removeAttribute("contenteditable")
    else el.setAttribute("contenteditable", prevEditable)
  }

  const destroy = () => {
    if (destroyed) return
    destroyed = true
    cleanupStyle()
  }

  const getText = () => (el.textContent ?? "").replace(/\u00a0/g, " ")

  const submit = () => {
    if (destroyed) return
    const text = getText()
    destroy()
    opts.onSubmit(text)
  }

  const cancel = () => {
    if (destroyed) return
    destroy()
    el.textContent = prevText
    opts.onCancel?.()
  }

  const stop = (e: Event) => {
    e.stopPropagation()
  }
  el.addEventListener("mousedown", stop)
  el.addEventListener("click", stop)

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Enter") {
      e.preventDefault()
      e.stopPropagation()
      submit()
    } else if (e.key === "Escape") {
      e.preventDefault()
      e.stopPropagation()
      cancel()
    }
  }
  el.addEventListener("keydown", onKeyDown)

  const onBlur = () => {
    window.setTimeout(() => {
      if (destroyed) return
      if (el.contains(document.activeElement) || document.activeElement === el) return
      submit()
    }, 80)
  }
  el.addEventListener("blur", onBlur)

  // 选中全文
  window.setTimeout(() => {
    el.focus()
    try {
      const range = document.createRange()
      range.selectNodeContents(el)
      const sel = window.getSelection()
      sel?.removeAllRanges()
      sel?.addRange(range)
    } catch (_) { /* ignore */ }
  }, 0)

  return {
    destroy: () => {
      el.removeEventListener("mousedown", stop)
      el.removeEventListener("click", stop)
      el.removeEventListener("keydown", onKeyDown)
      el.removeEventListener("blur", onBlur)
      cancel()
    },
    getValue: () => (destroyed ? opts.value : getText()),
  }
}
