import type { Editor, MarkdownPostProcessorContext } from "obsidian"
import {
  sanitizeHTMLToDom,
  MarkdownView,
  Notice,
} from "obsidian";
import type { EditorView } from "@codemirror/view"
import { ABConvertManager } from "@/ABConverter/ABConvertManager";
import { abConvertEvent } from "@/ABConverter/ABConvertEvent";
import { ABCSetting, ABReg } from "@/ABConverter/ABSetting";
import { ABReplacer_Widget } from "../abm_cm/ABReplacer_Widget";
import { isC2EmbedRenderable, wireABEmbedC2Host } from "../abm_cm/ABEmbedC2Host";
import { getEmbedEditPlugin } from "../abm_cm/ABEmbedEditor";

export class ABReplacer_CodeBlock{
  static processor(
    // plugin_this: AnyBlockPlugin,             // 使用bind方法被绑进来的
    src: string,                                // 代码块内容 (带代码块整体的缩进)
    blockEl: HTMLElement,                       // 代码块渲染的元素
    ctx: MarkdownPostProcessorContext,
  ) {
    ABCSetting.obsidian.global_ctx = ctx;

    const root_div = document.createElement("div");  blockEl.appendChild(root_div); root_div.classList.add("ab-replace");
    const list_src = src.split("\n")

    // 判断是否AnyBlock块
    let header: string = ""
    let header_indent_prefix: string = "" // 头部缩进前缀，后面的内容统一减掉这个前缀
    if (list_src.length) {
      const match = list_src[0].match(ABReg.reg_header_noprefix)
      if (match && match[5]) {
        header = match[5];
        header_indent_prefix = match[1];
      }
    }
    
    // 代码块缩进处理 (由于 obsidian 是无缩进和嵌套的，他为了渲染结果正确故src保留了缩进。列表嵌套代码块时src默认是带缩进的，引用块更是无法嵌套代码块)
    const src_without_indent: string = list_src.slice(1).map((line) =>
      line.startsWith(header_indent_prefix) ? line.substring(header_indent_prefix.length) : line
    ).join("\n")
    const calc_margin: number = header_indent_prefix.replace(/\t/g, '    ').length; // TODO 粗略假设一个tab等于四空格，应该从配置中获取
    root_div.setAttribute("style", "margin-left: " + calc_margin*0.5 + "rem;")

    // AnyBlock主体部分
    const dom_note = root_div.createDiv({
      cls: ["ab-note", "drop-shadow"]
    })
    let dom_replaceEl = dom_note.createDiv({
      cls: ["ab-replaceEl"]
    })
    if (header != "") { // b1. 规范的AnyBlock
      ABConvertManager.autoABConvert(dom_replaceEl, header, src_without_indent)
    }
    else { // b2. 非法内容，普通渲染处理
      ABConvertManager.getInstance().m_renderMarkdownFn(src, dom_replaceEl, ctx)
    }

    // 编辑按钮部分
    // codeblock自带编辑按钮，不需要额外追加

    // 刷新按钮部分
    let dom_edit: HTMLDivElement = root_div.createEl("div", {
      cls: ["ab-button", "ab-button-2", "edit-block-button"],
      attr: {"aria-label": "Refresh the block"}
    });
    dom_edit.empty(); dom_edit.appendChild(sanitizeHTMLToDom(ABReplacer_Widget.STR_ICON_REFRESH));
    dom_edit.onclick = ()=>{abConvertEvent(root_div);}

    // 控件部分的隐藏
    const button_show = ()=>{dom_edit.show()}
    const button_hide  = ()=>{dom_edit.hide()}
    button_hide()
    dom_note.onmouseover = button_show
    dom_note.onmouseout = button_hide
    dom_edit.onmouseover = button_show
    dom_edit.onmouseout = button_hide

    // codeblock 模式：card / col / tabs 内联编辑 + tabs chrome
    if (header !== "" && isC2EmbedRenderable(dom_note)) {
      ABReplacer_CodeBlock.wireEmbedIfPossible(
        dom_note,
        blockEl,
        ctx,
        header,
        src_without_indent,
        header_indent_prefix,
        src,
      )
    }
  }

  /**
   * 将 fence 内正文（含 `[header]` 行）与编辑器 SectionInfo 对齐后挂载内联编辑
   */
  private static wireEmbedIfPossible(
    dom_note: HTMLElement,
    blockEl: HTMLElement,
    ctx: MarkdownPostProcessorContext,
    header: string,
    contentWithoutIndent: string,
    indentPrefix: string,
    fallbackSrcWithIndent: string,
  ) {
    const buildFullSrcFromParts = (content: string) => {
      // 与列表选择器 Widget 一致：`[header]\ncontent`
      const headLine = fallbackSrcWithIndent.split("\n")[0] ?? `[${header}]`
      const headTrimmed = indentPrefix && headLine.startsWith(indentPrefix)
        ? headLine.substring(indentPrefix.length)
        : headLine
      return content.length ? `${headTrimmed}\n${content}` : headTrimmed
    }

    const initialFullSrc = buildFullSrcFromParts(contentWithoutIndent)

    const getEditor = (): Editor | null => {
      const plugin = getEmbedEditPlugin()
      const app = plugin?.app
      if (!app) return null
      const mv = app.workspace.getActiveViewOfType(MarkdownView)
      return mv?.editor ?? null
    }

    const getHostEditorView = (): EditorView | null => {
      const ed = getEditor() as any
      return (ed?.cm as EditorView | undefined) ?? null
    }

    /** 读取 fence 内正文（去公共缩进），失败则回退缓存 */
    const readFenceInner = (): string | null => {
      const editor = getEditor()
      const section = ctx.getSectionInfo(blockEl)
      if (!editor || !section) return null
      const { lineStart, lineEnd } = section
      if (lineEnd <= lineStart + 1) return ""
      const lines: string[] = []
      for (let i = lineStart + 1; i < lineEnd; i++) {
        let line = editor.getLine(i)
        if (indentPrefix && line.startsWith(indentPrefix)) {
          line = line.substring(indentPrefix.length)
        }
        lines.push(line)
      }
      return lines.join("\n")
    }

    const getFullSrc = (): string | null => {
      const inner = readFenceInner()
      if (inner != null) return inner
      return initialFullSrc
    }

    const saveFullSrc = (fullSrc: string) => {
      const editor = getEditor()
      const section = ctx.getSectionInfo(blockEl)
      if (!editor || !section) {
        new Notice("写入失败：无法定位代码块位置")
        return
      }
      const { lineStart, lineEnd } = section
      const openLine = editor.getLine(lineStart)
      const closeLine = editor.getLine(lineEnd)
      const innerLines = fullSrc.length
        ? fullSrc.split("\n").map((l) => indentPrefix + l)
        : []
      const text = [openLine, ...innerLines, closeLine].join("\n")
      editor.replaceRange(
        text,
        { line: lineStart, ch: 0 },
        { line: lineEnd, ch: closeLine.length },
      )
    }

    wireABEmbedC2Host({
      domNote: dom_note,
      getFullSrc,
      saveFullSrc,
      header,
      cachedContent: contentWithoutIndent,
      hostEditorView: getHostEditorView(),
      enableTabsChrome: true,
    })
  }
}
