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

  opts.containerEl.empty()
  opts.containerEl.addClass("ab-embed-editor")

  const editorEl = opts.containerEl.createDiv({ cls: ["cm-table-widget", "ab-embed-editor-inner"] })

  let destroyed = false
  let cm: EditorView | null = null
  let editorInstance: any = null

  const getValue = (): string => {
    return cm?.state.doc.toString() ?? opts.value
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
  }, 0)

  return { destroy, getValue }
}
