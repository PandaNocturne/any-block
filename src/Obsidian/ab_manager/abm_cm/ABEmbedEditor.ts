/**
 * 嵌入编辑器（参考 obsidian-kanban）
 *
 * 通过 embedRegistry 取出 Obsidian 内部 MarkdownEditor，
 * 在 AnyBlock 渲染块内就地编辑，并写回主编辑器对应区间。
 */

import type { App, Plugin, TFile } from "obsidian"
import { MarkdownView } from "obsidian"
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

/** 是否单击即可进入内联编辑（需同时开启 embed_edit） */
export function isEmbedEditSingleClickEnabled(): boolean {
  const p = _pluginRef as any
  return !!(p?.settings?.embed_edit && p?.settings?.embed_edit_single_click)
}

/** 是否强制渲染（禁止光标误入还原源码，仅控件可还原） */
export function isForceRenderEnabled(): boolean {
  const p = _pluginRef as any
  return !!(p?.settings?.force_render)
}

/** 是否开启匹配高亮（光标进入块时下划线标出源码范围） */
export function isMatchHighlightEnabled(): boolean {
  const p = _pluginRef as any
  // 默认开启：旧配置无此字段时视为 true
  return p?.settings?.match_highlight !== false
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
  /** 提交（失焦 / Ctrl+Enter；Esc 在未开启 escapeToCancel 时） */
  onSubmit: (value: string) => void
  /** 取消（Esc，需 escapeToCancel） */
  onCancel?: () => void
  /**
   * Enter 键回调（若提供则 Enter 不换行而触发此回调，且不抢回主编辑区焦点）
   * 用于 card/col 标题编辑回车后切到内容区
   */
  onEnter?: (value: string) => void
  /** Esc 走取消而非提交，默认 false */
  escapeToCancel?: boolean
  /** 关闭后可选：把焦点还给主编辑区 EditorView */
  hostEditorView?: EditorView | null
}

/**
 * 恢复主编辑区的 activeEditor / 焦点，避免内联 MarkdownEditor 关掉后快捷键失效
 * （与 obsidian-kanban 同类问题：workspace.activeEditor 残留在已销毁的 controller 上）
 */
export function restoreMainEditorContext(
  app: App,
  prevActiveEditor: any,
  embedOwner: any,
  hostEditorView?: EditorView | null,
) {
  const ws = app.workspace as any
  const mv = app.workspace.getActiveViewOfType(MarkdownView)

  try {
    const ae = ws.activeEditor
    // 卸掉指向嵌入编辑器的残留（controller / editMode / 已失效引用）
    if (
      ae == null
      || ae === embedOwner
      || (embedOwner && ae === embedOwner.editMode)
      || (embedOwner && ae?.editor && ae.editor === embedOwner.editor)
      || (prevActiveEditor && ae === prevActiveEditor && prevActiveEditor === embedOwner)
    ) {
      ws.activeEditor = null
    }
  } catch (_) { /* ignore */ }

  // 弹掉可能残留的 keymap scope（Obsidian MarkdownEditor 聚焦时会 push）
  try {
    const scope = embedOwner?.editMode?.scope || embedOwner?.scope
    if (scope && ws.app?.keymap) {
      app.keymap.popScope(scope)
    } else if (scope) {
      app.keymap.popScope(scope)
    }
  } catch (_) { /* ignore */ }

  const reclaim = () => {
    try {
      const view = app.workspace.getActiveViewOfType(MarkdownView) ?? mv
      if (view) {
        // 通过 setActiveLeaf 走 Obsidian 正式激活路径
        const leaf = (view as any).leaf
        if (leaf) {
          try {
            app.workspace.setActiveLeaf(leaf, { focus: true })
          } catch (_) {
            try { app.workspace.setActiveLeaf(leaf, true as any) } catch (__) { /* ignore */ }
          }
        }
        ws.activeEditor = view
        // 部分版本把 currentMode / editMode 当作 activeEditor
        if ((view as any).editMode && ws.activeEditor !== view) {
          /* keep view */
        }
      } else if (prevActiveEditor && prevActiveEditor !== embedOwner) {
        ws.activeEditor = prevActiveEditor
      }

      if (hostEditorView) {
        hostEditorView.focus()
      } else {
        view?.editor?.focus()
      }
    } catch (_) { /* ignore */ }
  }

  // 立刻一次 + 下一帧再一次（写回/重渲染后焦点常被冲掉）
  reclaim()
  window.setTimeout(reclaim, 0)
  window.setTimeout(reclaim, 50)
}

export interface ABEmbedEditorHandle {
  destroy: () => void
  getValue: () => string
  /** 主动提交并关闭 */
  submit: () => void
  /** 主动取消并关闭（无 onCancel 时等同 destroy） */
  cancel: () => void
  /** 抢回嵌入编辑器焦点（标题→内容切换时防主区抢焦） */
  focus: () => void
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

  // 高度按原文锁定，宽度跟父级 100%；编辑期清零 padding，避免相对原选区缩进/偏一侧
  const rect = opts.containerEl.getBoundingClientRect()
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
  opts.containerEl.style.boxSizing = "border-box"
  opts.containerEl.style.width = "100%"
  opts.containerEl.style.minWidth = "0"
  opts.containerEl.style.maxWidth = "100%"
  opts.containerEl.style.minHeight = `${lockedHeight}px`
  // 高度至少与原文一致，内容变长时可自然增高
  opts.containerEl.style.height = "auto"
  opts.containerEl.style.padding = "0"
  opts.containerEl.style.margin = "0"
  // 覆盖父级「可读行宽 / 页边距」，否则 .cm-content 居中留白、无法全覆盖
  opts.containerEl.style.setProperty("--file-line-width", "100%")
  opts.containerEl.style.setProperty("--file-margins", "0px")
  opts.containerEl.style.setProperty("--line-width", "100%")
  opts.containerEl.style.setProperty("--content-max-width", "100%")
  opts.containerEl.style.setProperty("--file-line-width-mobile", "100%")

  opts.containerEl.empty()
  opts.containerEl.addClass("ab-embed-editor")

  const editorEl = opts.containerEl.createDiv({ cls: ["cm-table-widget", "ab-embed-editor-inner"] })
  editorEl.style.minHeight = `${lockedHeight}px`
  editorEl.style.height = "100%"
  editorEl.style.width = "100%"
  editorEl.style.maxWidth = "100%"
  editorEl.style.boxSizing = "border-box"
  editorEl.style.padding = "0"
  editorEl.style.margin = "0"
  editorEl.style.setProperty("--file-line-width", "100%")
  editorEl.style.setProperty("--file-margins", "0px")
  editorEl.style.setProperty("--line-width", "100%")
  editorEl.style.setProperty("--content-max-width", "100%")

  let destroyed = false
  let cm: EditorView | null = null
  let editorInstance: any = null
  const openedAt = Date.now()
  // 打开前记下主编辑区 activeEditor，关闭时还原（否则快捷键失效）
  const prevActiveEditor = (opts.app.workspace as any).activeEditor ?? null

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

  const getValue = (): string => {
    return cm?.state.doc.toString() ?? opts.value
  }

  const focusEmbed = () => {
    if (destroyed) return
    try { cm?.focus() } catch (_) { /* ignore */ }
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

  /**
   * @param silent Enter 切下一区：不 blur、不清 activeEditor，避免主编辑区抢焦
   */
  const destroy = (silent = false) => {
    if (destroyed) return
    destroyed = true
    if (!silent) {
      try {
        cm?.contentDOM?.blur?.()
      } catch (_) { /* ignore */ }
      // 嵌入编辑会把 activeEditor 切走；先清空（kanban 同款），再由 reclaim 设回 MarkdownView
      try {
        const ws = opts.app.workspace as any
        const ae = ws.activeEditor
        if (
          ae == null
          || ae === controller
          || ae === editorInstance
          || ae === controller.editMode
          || (ae && !(ae instanceof MarkdownView) && ae !== prevActiveEditor)
        ) {
          ws.activeEditor = null
        }
      } catch (_) { /* ignore */ }
    }
    // 弹出 MarkdownEditor 可能 push 的 keymap scope
    try {
      const scope = (editorInstance as any)?.scope
      if (scope) opts.app.keymap.popScope(scope)
    } catch (_) { /* ignore */ }
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

  const finishAndRestore = (after: () => void) => {
    destroy(false)
    try { after() } catch (_) { /* ignore */ }
    // 写回/软恢复之后再抢回主编辑区上下文（否则快捷键仍指向已销毁 editor）
    restoreMainEditorContext(opts.app, prevActiveEditor, controller, opts.hostEditorView)
  }

  const submit = () => {
    if (destroyed) return
    const text = getValue()
    finishAndRestore(() => opts.onSubmit(text))
  }

  const cancel = () => {
    if (destroyed) return
    finishAndRestore(() => opts.onCancel?.())
  }

  /** Enter 切下一编辑区：静默销毁，不抢回主编辑区焦点 */
  const enterNext = () => {
    if (destroyed || !opts.onEnter) return
    const text = getValue()
    destroy(true)
    try { opts.onEnter(text) } catch (_) { /* ignore */ }
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
            width: "100%",
            maxWidth: "100%",
            fontSize: "inherit",
          },
          ".cm-gutters": {
            display: "none",
          },
          ".cm-scroller": {
            fontFamily: "inherit",
            lineHeight: "inherit",
            overflow: "auto",
            width: "100%",
            padding: "0",
          },
          ".cm-sizer": {
            maxWidth: "none",
            width: "100%",
            margin: "0",
          },
          ".cm-contentContainer": {
            maxWidth: "none",
            width: "100%",
            margin: "0",
          },
          ".cm-content": {
            // 勿清 padding：Obsidian 有序/无序列表缩进与列表符依赖 content/line 的 padding
            maxWidth: "none",
            width: "100%",
            marginLeft: "0",
            marginRight: "0",
            caretColor: "var(--text-normal)",
            boxSizing: "border-box",
          },
          ".cm-line": {
            maxWidth: "none",
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
                if (opts.escapeToCancel && opts.onCancel) cancel()
                else submit()
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
            ...(opts.onEnter
              ? [{
                  key: "Enter",
                  run: () => {
                    enterNext()
                    return true
                  },
                  preventDefault: true,
                }]
              : []),
          ])
        )
      )
      extensions.push(
        Prec.highest(
          EditorView.domEventHandlers({
            focus: () => {
              // 记录：Obsidian 内部也可能把 activeEditor 设为 this.owner(controller)
              // 关闭时靠 finishAndRestore 强制抢回 MarkdownView
              return false
            },
            blur: () => {
              // 延后提交；return false 让 Obsidian 走完自身 blur（含 keymap scope 清理）
              window.setTimeout(() => {
                if (destroyed) return
                if (opts.containerEl.contains(document.activeElement)) return
                // 切到同页其他嵌入编辑器时不提交
                const ae = document.activeElement as HTMLElement | null
                if (ae?.closest?.(".ab-embed-editor, .ab-embed-title-editor, .ab-embed-title-input")) return
                // 刚打开时主区常抢焦：抢回而非提交（标题 Enter→内容竞态）
                if (Date.now() - openedAt < 300) {
                  focusEmbed()
                  return
                }
                submit()
              }, 150)
              return false
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

  // 清掉可读行宽 / file-margins 造成的居中留白；勿动 .cm-content/.cm-line 的 padding（列表缩进依赖）
  const squashEmbedWidth = () => {
    if (!cm) return
    const setImp = (el: HTMLElement | null | undefined, prop: string, value: string) => {
      el?.style.setProperty(prop, value, "important")
    }
    const fillWidth = (el: HTMLElement | null | undefined, clearPad = false) => {
      if (!el) return
      setImp(el, "max-width", "none")
      setImp(el, "width", "100%")
      setImp(el, "min-width", "0")
      setImp(el, "margin-left", "0")
      setImp(el, "margin-right", "0")
      setImp(el, "box-sizing", "border-box")
      if (clearPad) {
        setImp(el, "padding-left", "0")
        setImp(el, "padding-right", "0")
      }
    }

    fillWidth(cm.dom, true)
    fillWidth(cm.scrollDOM, true)
    // content 只去 max-width/居中 margin，保留列表用的 padding
    fillWidth(cm.contentDOM, false)
    setImp(cm.scrollDOM, "padding-top", "0")
    setImp(cm.scrollDOM, "padding-bottom", "0")
    setImp(cm.dom, "height", "100%")
    setImp(cm.dom, "min-height", `${lockedHeight}px`)

    opts.containerEl.querySelectorAll<HTMLElement>(
      ".ab-embed-editor-inner, .markdown-source-view, .cm-sizer, .cm-contentContainer"
    ).forEach((el) => {
      fillWidth(el, el.classList.contains("ab-embed-editor-inner") || el.classList.contains("markdown-source-view"))
      setImp(el, "margin", "0")
    })

    const inner = opts.containerEl.querySelector(".ab-embed-editor-inner") as HTMLElement | null
    setImp(inner, "min-height", `${lockedHeight}px`)
    setImp(inner, "height", "100%")
    setImp(inner, "padding", "0")
  }
  squashEmbedWidth()

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

  // 打开时不要把 activeEditor 切到假 controller。
  // Obsidian MarkdownEditor 聚焦时仍可能自行写入 owner；关闭路径必须清掉并抢回 MarkdownView。
  focusEmbed()
  window.setTimeout(() => {
    squashEmbedWidth()
    focusEmbed()
    cm?.requestMeasure()
    window.setTimeout(() => {
      squashEmbedWidth()
      focusEmbed()
    }, 50)
  }, 0)

  return { destroy, getValue, submit, cancel, focus: focusEmbed }
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
 * 标题纯文本就地编辑
 * - button（tabs）：contenteditable（button 内嵌 input 不合法）
 * - 普通 div（card/col）：用 input，避免 contenteditable 抢焦点导致 CM 退回源码
 */
export function openABTitleTextEditor(opts: ABTitleTextEditorOptions): ABEmbedEditorHandle {
  if (opts.containerEl.tagName === "BUTTON") {
    return openABTitleContentEditable(opts)
  }
  return openABTitleInputEditor(opts)
}

/** card/col 标题：input 编辑，事件全部拦住不传给 CodeMirror */
function openABTitleInputEditor(opts: ABTitleTextEditorOptions): ABEmbedEditorHandle {
  const el = opts.containerEl
  const prevHtml = el.innerHTML
  el.addClass("ab-embed-title-editor")
  el.empty()

  const input = document.createElement("input")
  input.type = "text"
  input.className = "ab-embed-title-input"
  input.value = opts.value
  input.setAttribute("spellcheck", "false")
  input.style.cssText = [
    "width:100%",
    "box-sizing:border-box",
    "margin:0",
    "padding:0 2px",
    "border:none",
    "outline:none",
    "background:transparent",
    "color:inherit",
    "font:inherit",
    "font-size:inherit",
    "line-height:inherit",
  ].join(";")
  el.appendChild(input)

  let destroyed = false

  const destroy = () => {
    if (destroyed) return
    destroyed = true
    el.removeClass("ab-embed-title-editor")
  }

  const submit = () => {
    if (destroyed) return
    const text = input.value
    destroy()
    opts.onSubmit(text)
  }

  const cancel = () => {
    if (destroyed) return
    destroy()
    el.innerHTML = prevHtml
    opts.onCancel?.()
  }

  const stopCM = (e: Event) => {
    e.stopPropagation()
  }
  const stopCMBubble = (e: Event) => {
    e.stopPropagation()
    // click/dblclick 挡默认即可；mousedown 不可 preventDefault，否则无法点选取消全选、放置光标
  }

  for (const type of ["mousedown", "pointerdown", "mouseup"] as const) {
    input.addEventListener(type, stopCM, true)
    el.addEventListener(type, stopCM, true)
  }
  for (const type of ["click", "dblclick"] as const) {
    input.addEventListener(type, stopCMBubble, true)
    el.addEventListener(type, stopCMBubble, true)
  }

  input.addEventListener("keydown", (e: KeyboardEvent) => {
    e.stopPropagation()
    if (e.key === "Enter") {
      e.preventDefault()
      submit()
    } else if (e.key === "Escape") {
      e.preventDefault()
      cancel()
    }
  })

  input.addEventListener("blur", () => {
    window.setTimeout(() => {
      if (destroyed) return
      if (el.contains(document.activeElement) || document.activeElement === input) return
      submit()
    }, 80)
  })

  // 等 dblclick 序列结束再聚焦，避免第二次 click 落到 CM
  window.setTimeout(() => {
    input.focus()
    input.select()
  }, 0)

  return {
    destroy: cancel,
    getValue: () => (destroyed ? opts.value : input.value),
    submit,
    cancel,
    focus: () => { try { input.focus() } catch (_) { /* ignore */ } },
  }
}

/** tabs 标题按钮：contenteditable */
function openABTitleContentEditable(opts: ABTitleTextEditorOptions): ABEmbedEditorHandle {
  const el = opts.containerEl
  const prevText = el.textContent ?? ""
  const prevEditable = el.getAttribute("contenteditable")
  const prevOnClick = el.onclick
  el.addClass("ab-embed-title-editor")
  el.textContent = opts.value
  el.setAttribute("contenteditable", "plaintext-only")
  if (el.contentEditable !== "plaintext-only" && el.contentEditable !== "true") {
    el.contentEditable = "true"
  }
  el.style.cursor = "text"
  el.onclick = (ev) => {
    // 挡 button 默认激活；不在 mousedown 上 preventDefault，否则无法点选取消全选
    ev.stopPropagation()
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

  // 只 stopPropagation，勿 preventDefault(mousedown)：否则全选后无法点击放置光标
  const stopCM = (e: Event) => {
    e.stopPropagation()
  }
  for (const type of ["mousedown", "pointerdown", "mouseup", "click", "dblclick"] as const) {
    el.addEventListener(type, stopCM, true)
  }

  const onKeyDown = (e: KeyboardEvent) => {
    e.stopPropagation()
    if (e.key === "Enter") {
      e.preventDefault()
      submit()
    } else if (e.key === "Escape") {
      e.preventDefault()
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
      for (const type of ["mousedown", "pointerdown", "mouseup", "click", "dblclick"] as const) {
        el.removeEventListener(type, stopCM, true)
      }
      el.removeEventListener("keydown", onKeyDown)
      el.removeEventListener("blur", onBlur)
      cancel()
    },
    getValue: () => (destroyed ? opts.value : getText()),
    submit,
    cancel,
    focus: () => { try { el.focus() } catch (_) { /* ignore */ } },
  }
}
