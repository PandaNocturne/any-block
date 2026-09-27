import { Platform, sanitizeHTMLToDom, MarkdownView, type Editor, type EditorPosition, Notice } from 'obsidian';
import {
  EditorView,
  WidgetType  // 装饰器部件
} from "@codemirror/view"

import { ABCSetting } from '@/ABConverter/ABSetting'
import {ABConvertManager} from "@/ABConverter/ABConvertManager"
import { C2ListProcess, type List_C2ListItem } from "@/ABConverter/converter/abc_c2list"
import type {MdSelectorRangeSpec} from "../../../CodeMirror2/ABSelector_Md"
import { abConvertEvent } from '@/ABConverter/ABConvertEvent'
import { isEmbedEditEnabled, openABEmbedEditor, openABTitleTextEditor, getEmbedEditPlugin, restoreMainEditorContext, isForceRenderEnabled, type ABEmbedEditorHandle } from './ABEmbedEditor'
import { enhanceABTabsChrome, hideABTabsMenu } from './ABTabsChrome'
import type { C2ListPair } from "@/ABConverter/converter/abc_c2list"

export class ABReplacer_Widget extends WidgetType {
  rangeSpec: MdSelectorRangeSpec
  global_editor: Editor|null
  div: HTMLDivElement
  content_withPrefix_length: number = 0

  // 缓存上一次动态获取的pos。主要是obsidian环境失焦那一下getPos会失败，可以使用最后oninput getPos的结果
  // oninput策略时，一些情况下可以忽略这个失焦的保存，但一些环境不行，如包含表格数据的保存。
  //   此时拥有旧数据的Widget类会重复触发toDOM，导致渲染出错误的结果
  // TODO WARNING onchange策略这里会有bug
  lastFromPos: number|null = null

  // 构造函数
  constructor(rangeSpec: MdSelectorRangeSpec, editor: Editor|null,
    public customData: { cancelFlag: number[], updateMode: string|number }
  ){
    super()
    this.content_withPrefix_length = rangeSpec.to_ch - rangeSpec.from_ch
    this.rangeSpec = rangeSpec
    this.global_editor = editor
  }

  /**
   * 阻止 CM 处理块内鼠标事件，避免双击标题/内容时光标落入块源码区
   */
  ignoreEvent(): boolean {
    return true
  }

  /**
   *  div.ab-replace.cm-embed-block.markdown-rendered.show-indentation-guide[type_header=`${}`]
   *      div.drop-shadow.ab-note
   *      div.ab-button.edit-block-button[aria-label="Edit this block"]
   */
  toDOM(view: EditorView): HTMLElement {
    // 根元素
    this.div = document.createElement("div");
    this.div.setAttribute("type_header", this.rangeSpec.header)
    this.div.addClasses(["ab-replace", "cm-embed-block"]) // , "show-indentation-guide"
    if (ABCSetting.is_debug) { // 调试模式经常需要观测块更新频率
      const id = `${Date.now()}`.replace(/(\d{3})$/, '.$1');
      this.div.setAttribute("id", id)
      const el_id = document.createElement('div'); this.div.appendChild(el_id); el_id.className = 'ab-id' ;el_id.textContent = id;
    }
    // 特殊 - callout选择器要用css消除外部的引用块样式、取消动态缩进
    if (this.rangeSpec.selector == 'callout') this.div.setAttribute("selector", "callout")

    // #region 可视化编辑部分

    const getPos = (): {fromPos: number; toPos: number}|null => {
      let fromPos: number

      // TODO 有个可能发生的bug: ctx 他不一定是实时编辑根部的那个ctx，view也是
      // try {
      //   const t = (ABCSetting.obsidian.global_ctx as MarkdownPostProcessorContext).getSectionInfo(this.div)
      //   console.log('getSectionInfo', t, this.div, ABCSetting.obsidian.global_ctx)
      // } catch (e) {
      //   console.warn('getSectionInfo failed:', e)
      // }

      try {
        fromPos = view.posAtDOM(this.div, 0)
      } catch (_) {
        // 似乎是脱离eb块后 (并多次触发?) 会存在这种情况，有表格会加重这种情况
        console.warn('get cursor pos failed:', this.div)
        return null
      }
      const pos = {
        fromPos: fromPos,
        toPos: fromPos + this.content_withPrefix_length
      }
      return pos
    }

    const save = (str_with_prefix: string, force_refresh: boolean = false) => {
      let pos = getPos(); 
      if (!pos) {
        if (this.lastFromPos == null) return Promise.resolve()
        else pos = {
          fromPos: this.lastFromPos,
          toPos: this.lastFromPos + this.content_withPrefix_length
        }
      } else {
        this.lastFromPos = pos.fromPos
      }
      this.content_withPrefix_length = str_with_prefix.length

      if (force_refresh) {
        this.customData.updateMode = pos.fromPos // 原 'force'
      }

      const new_state = view.state
      const transaction = new_state.update({
        changes: {
          from: pos.fromPos,
          to: pos.toPos,
          insert: str_with_prefix,
        },
        userEvent: "input",
      })
      view.dispatch(transaction)

      return Promise.resolve()
    }

    /** 用 DOM 实时位置刷新 rangeSpec（装饰 map 后 from_ch 会过期） */
    const syncRangeFromDom = (): boolean => {
      const pos = getPos()
      if (!pos) {
        if (this.lastFromPos == null) return false
        this.rangeSpec.from_ch = this.lastFromPos
        this.rangeSpec.to_ch = this.lastFromPos + this.content_withPrefix_length
        return true
      }
      this.lastFromPos = pos.fromPos
      this.rangeSpec.from_ch = pos.fromPos
      this.rangeSpec.to_ch = pos.toPos
      this.content_withPrefix_length = pos.toPos - pos.fromPos
      return true
    }

    // #endregion

    // AnyBlock主体部分，内容替换元素
    let dom_note = document.createElement("div"); this.div.appendChild(dom_note); dom_note.classList.add("ab-note", "drop-shadow");
    ABConvertManager.autoABConvert(dom_note, this.rangeSpec.header, this.rangeSpec.content, this.rangeSpec.selector,
      (ABCSetting.env != 'obsidian-pro') ? undefined : {
        save,
        rangeSpec: {
          type: 'anyblock',
          text_content: this.rangeSpec.content,
          fromPos: this.rangeSpec.from_ch,
          toPos: this.rangeSpec.to_ch,
          header: this.rangeSpec.header,
          selector: this.rangeSpec.selector,
          parent_prefix: this.rangeSpec.prefix,
        },      
        setting: {},
        ctx: ABCSetting.obsidian.global_ctx,
        app: ABCSetting.obsidian.global_app,
      }
    )

    if (!this.global_editor) return this.div // 非有效的实时编辑环境

    const wireTabsChrome = () => {
      const root = dom_note.querySelector(".ab-tab-root") as HTMLElement | null
      if (!root || !this.global_editor) return
      enhanceABTabsChrome({
        tabRoot: root,
        onCommit: (mutate, activateIndex) => {
          if (!this.global_editor) return
          if (!syncRangeFromDom()) {
            new Notice("写入失败：无法定位块位置")
            return
          }
          const from = this.global_editor.offsetToPos(this.rangeSpec.from_ch)
          const to = this.global_editor.offsetToPos(this.rangeSpec.to_ch)
          const fullSrc = this.global_editor.getRange(from, to)
          if (!fullSrc.trim()) {
            new Notice("写入失败：块内容为空")
            return
          }
          const newFull = this.applyC2PairsMutation(fullSrc, mutate)
          if (newFull == null) {
            new Notice("写入失败：无法解析标签结构")
            return
          }
          C2ListProcess.setPendingTabActivateIndex(activateIndex)
          save(newFull, true)
        },
      })
    }
    wireTabsChrome()

    // 嵌入编辑：设置默认关闭
    // - tabs 标题：纯文本；card/col 标题与内容：Obsidian MarkdownEditor
    // - 进入：Ctrl/Cmd+点击 或 双击（合成，因 mousedown preventDefault 无原生 dblclick）
    // - 退出：Esc 取消；Ctrl/Cmd+Enter / 失焦 / 点击编辑区外 提交
    let embedEditing = false
    let activeEmbedHandle: ABEmbedEditorHandle | null = null
    let lastEmbedTap: { key: string; at: number } | null = null

    const isEmbedHitTarget = (t: HTMLElement | null) => {
      if (!t?.closest) return false
      return !!t.closest(
        ".ab-items-title, .ab-items-content, .ab-items-item, .ab-tab-nav-item, .ab-tab-content-item, .ab-embed-title-editor, .ab-embed-editor, .ab-embed-title-input"
      )
    }

    const resolveEmbedHit = (target: HTMLElement) => {
      const titlePart = target.closest(".ab-items-title, .ab-tab-nav-item") as HTMLElement | null
      const contentPart = target.closest(".ab-items-content, .ab-tab-content-item") as HTMLElement | null
      const hitTitle = !!(titlePart && !contentPart)
      const hitContent = !!contentPart
      if (!hitTitle && !hitContent) return null
      const hitEl = (hitTitle ? titlePart : contentPart) as HTMLElement
      if (!dom_note.contains(hitEl)) return null
      const attrHost = (hitEl.closest("[data-ab-item-index]") as HTMLElement | null) || hitEl
      const idx = attrHost.getAttribute("data-ab-item-index")
        || attrHost.getAttribute("data-ab-card-index")
        || "?"
      const key = `${idx}:${hitTitle ? "t" : "c"}`
      return { hitEl, hitTitle, hitContent, key }
    }

    const isInsideActiveEmbed = (t: HTMLElement | null) =>
      !!t?.closest?.(".ab-embed-title-input, .ab-embed-editor, .ab-embed-title-editor")

    /** 点到 AB 块外（正文其他位置）：自动退出编辑 */
    const onDocEmbedOutside = (e: MouseEvent) => {
      if (!embedEditing || !activeEmbedHandle) return
      const t = e.target as HTMLElement | null
      if (isInsideActiveEmbed(t)) return
      if (t && dom_note.contains(t)) return // 块内由 onEmbedPointerDown 处理
      exitEmbedOnOutside()
    }
    const armOutsideExit = () => {
      document.addEventListener("mousedown", onDocEmbedOutside, true)
    }
    const disarmOutsideExit = () => {
      document.removeEventListener("mousedown", onDocEmbedOutside, true)
    }

    /** 点编辑区外：主动提交退出（mousedown preventDefault 会挡住原生失焦） */
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
      if (!plugin || !this.global_editor) return

      const attrHost = (hitEl.closest("[data-ab-item-index]") as HTMLElement | null) || hitEl
      const itemIndex = parseInt(
        attrHost.getAttribute("data-ab-item-index")
          || attrHost.getAttribute("data-ab-card-index")
          || "-1",
        10
      )
      if (itemIndex < 0) return

      const title = attrHost.getAttribute("data-ab-item-title")
        ?? attrHost.getAttribute("data-ab-card-title")
        ?? ""
      const body = attrHost.getAttribute("data-ab-item-body")
        ?? attrHost.getAttribute("data-ab-card-body")
        ?? ""

      syncRangeFromDom()
      const from = this.global_editor.offsetToPos(this.rangeSpec.from_ch)
      const to = this.global_editor.offsetToPos(this.rangeSpec.to_ch)
      const fullSrc = this.global_editor.getRange(from, to)
      const file = plugin.app.workspace.getActiveViewOfType(MarkdownView)?.file ?? null
      const prevActiveEditor = (plugin.app.workspace as any).activeEditor ?? null

      // —— tabs 标题：仍用纯文本（button 内不宜嵌 OB 编辑器）——
      if (hitTitle && hitEl.classList.contains("ab-tab-nav-item")) {
        embedEditing = true
        activeEmbedHandle = openABTitleTextEditor({
          containerEl: hitEl,
          value: title,
          onSubmit: (newTitleRaw: string) => {
            activeEmbedHandle = null
            embedEditing = false
            disarmOutsideExit()
            restoreMainEditorContext(plugin.app, prevActiveEditor, null, view)
            const newTitle = newTitleRaw.trim() || title
            if (newTitle === title) {
              hitEl.textContent = title.slice(0, 20)
              return
            }
            const newFull = this.patchC2ItemInBlockSource(fullSrc, itemIndex, newTitle, body)
            if (newFull == null) {
              new Notice("写入失败：无法解析条目结构")
              hitEl.textContent = title.slice(0, 20)
              return
            }
            C2ListProcess.setPendingTabActivateIndex(
              C2ListProcess.getActiveTabIndex(dom_note, itemIndex)
            )
            save(newFull, true)
          },
          onCancel: () => {
            activeEmbedHandle = null
            embedEditing = false
            disarmOutsideExit()
            restoreMainEditorContext(plugin.app, prevActiveEditor, null, view)
            hitEl.textContent = title.slice(0, 20)
          },
        })
        armOutsideExit()
        return
      }

      // —— card/col 标题 或 任意内容：Obsidian MarkdownEditor ——
      const isTabContent = hitEl.classList.contains("ab-tab-content-item")
      const isCardContent = hitEl.classList.contains("ab-items-content")
      const isCardTitle = hitEl.classList.contains("ab-items-title")
      const editValue = hitTitle
        ? title
        : C2ListProcess.normalizeC2BodyForEdit(body)

      embedEditing = true
      const handle = openABEmbedEditor({
        plugin,
        app: plugin.app,
        containerEl: hitEl,
        file,
        value: editValue,
        clickCoords: { x: clientX, y: clientY },
        escapeToCancel: true,
        hostEditorView: view,
        onCancel: () => {
          activeEmbedHandle = null
          embedEditing = false
          disarmOutsideExit()
          if (isTabContent) this.softRestoreTabContent(hitEl, title, body, itemIndex)
          else if (isCardContent || isCardTitle) this.softRestoreMarkdownPart(hitEl, hitTitle ? title : body)
          else this.restoreEmbedItemView(dom_note, wireTabsChrome)
        },
        onSubmit: (newText: string) => {
          activeEmbedHandle = null
          embedEditing = false
          disarmOutsideExit()
          const trimmed = newText.replace(/\n$/, "")
          if (trimmed === editValue.replace(/\n$/, "")) {
            if (isTabContent) this.softRestoreTabContent(hitEl, title, body, itemIndex)
            else if (isCardContent || isCardTitle) this.softRestoreMarkdownPart(hitEl, hitTitle ? title : body)
            else this.restoreEmbedItemView(dom_note, wireTabsChrome)
            return
          }
          let newTitle = title
          let newBody = body
          if (hitTitle) {
            // 标题：合并为单行写回
            newTitle = trimmed.split("\n").map((l) => l.trim()).filter(Boolean).join(" ") || title
          } else {
            newBody = trimmed
          }
          const newFull = this.patchC2ItemInBlockSource(fullSrc, itemIndex, newTitle, newBody)
          if (newFull == null) {
            new Notice("写入失败：无法解析条目结构")
            if (isTabContent) this.softRestoreTabContent(hitEl, title, body, itemIndex)
            else if (isCardContent || isCardTitle) this.softRestoreMarkdownPart(hitEl, hitTitle ? title : body)
            else this.restoreEmbedItemView(dom_note, wireTabsChrome)
            return
          }
          if (isTabContent) {
            // 外部已点到其他标签时保留其 pending，勿覆盖
            if (C2ListProcess.peekPendingTabActivateIndex() == null) {
              C2ListProcess.setPendingTabActivateIndex(
                C2ListProcess.getActiveTabIndex(dom_note, itemIndex)
              )
            }
          }
          save(newFull, true)
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

    // 捕获：挡住 CM 落点；单击切 tab；Ctrl/Cmd+点击 / 双击进入嵌入编辑
    // - 标签页 mousedown 不可 preventDefault，否则 HTML5 拖拽无法开始
    // - 右键不可 preventDefault，否则 contextmenu 异常
    // - 正文/标题单击不可 preventDefault，否则无法按住框选
    const onEmbedPointerDown = (e: MouseEvent) => {
      const t = e.target as HTMLElement | null
      if (!isEmbedHitTarget(t)) return

      // 工具栏 / 添加按钮：编辑中则先退出
      if (t?.closest?.(".ab-button, .ab-tab-nav-add")) {
        hideABTabsMenu()
        if (embedEditing && !isInsideActiveEmbed(t)) exitEmbedOnOutside()
        return
      }

      // 编辑器内部：只挡 CM，不 preventDefault，便于聚焦/点选
      if (isInsideActiveEmbed(t)) {
        e.stopPropagation()
        return
      }

      // 右键：只挡 CM，交给 contextmenu
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

      // 标签页：只 stopPropagation，不 preventDefault（保留拖拽）
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

        // Ctrl/Cmd / 双击进入嵌入编辑；单击切换
        if ((e.ctrlKey || e.metaKey) && isEmbedEditEnabled()) {
          e.preventDefault()
          lastEmbedTap = null
          startEmbedEdit(tabNav, true, e.clientX, e.clientY)
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

      // 非标签区域：只挡 CM 冒泡；默认不 preventDefault，允许按住框选
      e.stopPropagation()

      // 编辑中点外部：主动提交退出
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

      // Ctrl/Cmd+点击：一键进入编辑
      if (e.ctrlKey || e.metaKey) {
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
        // 单击 / 拖选：不 preventDefault
        lastEmbedTap = { key: hit.key, at: now }
      }
    }

    dom_note.addEventListener("mousedown", onEmbedPointerDown, true)

    // 框选拖动时也别让 mousemove 冒泡到 CM（否则 CM 可能跟着选中源码）
    const stopSelectDragToCM = (e: MouseEvent) => {
      if (!(e.buttons & 1)) return
      if (!isEmbedHitTarget(e.target as HTMLElement)) return
      if (isInsideActiveEmbed(e.target as HTMLElement)) return
      e.stopPropagation()
    }
    dom_note.addEventListener("mousemove", stopSelectDragToCM, true)

    const stopBubbleToCM = (e: Event) => {
      if (!isEmbedHitTarget(e.target as HTMLElement)) return
      e.stopPropagation()
    }
    for (const type of ["mouseup", "click", "dblclick"] as const) {
      dom_note.addEventListener(type, stopBubbleToCM, true)
    }

    // 菜单按钮1 - 编辑
    const btn_edit: HTMLDivElement = this.div.createEl("div", {
      cls: ["ab-button", "ab-button-1", "edit-block-button"], // cm-embed-block和edit-block-button是自带的js样式，用来悬浮显示的，不是我写的
      attr: {"aria-label": "Edit the block - "+this.rangeSpec.header},
    })
    if (Platform.isMobileApp || Platform.isPhone || Platform.isTablet) {
      btn_edit.classList.remove("edit-block-button"); // 移动端这里的编辑按钮有个独立逻辑，他会自动将你的编辑按钮替换掉
    }
    btn_edit.empty(); btn_edit.appendChild(sanitizeHTMLToDom(ABReplacer_Widget.STR_ICON_CODE2));
    btn_edit.onclick = (e: MouseEvent) => {
      e.preventDefault()
      e.stopPropagation()
      switch_more(false)
      syncRangeFromDom()
      // 强制渲染：仅控件可还原源码 —— 先写入 cancelFlag，再移入光标
      if (isForceRenderEnabled()) {
        const from = this.rangeSpec.from_ch
        if (!this.customData.cancelFlag.includes(from)) {
          this.customData.cancelFlag.push(from)
        }
      }
      this.moveCursor()
    }

    // 菜单按钮3 - 复制
    const btn_copy: HTMLDivElement = this.div.createEl("div", {
      cls: ["ab-button", "ab-button-3", "edit-block-button"],
      attr: {"aria-label": "Copy source content"}
    })
    btn_copy.empty(); btn_copy.appendChild(sanitizeHTMLToDom(ABReplacer_Widget.STR_ICON_COPY));
    btn_copy.onclick = (e: MouseEvent) => {
      e.preventDefault()
      e.stopPropagation()
      if (!this.global_editor) return
      switch_more(false)
      syncRangeFromDom()

      // 这里的content有两种思路
      // - 一是最原本的fromPos-toPos。但可能包含不应该被包含的前缀，需要使用 parent_prefix 去除
      // - 二是使用 rangeSpec.content + header + selector 还原。但还原过程中可能存在一些差别 (如可选空行等)，也需要 pro 模块
      // 旧: let content = this.rangeSpec.content
      // 这里采用方案一
      let content = this.global_editor.getRange(
        this.global_editor.offsetToPos(this.rangeSpec.from_ch),
        this.global_editor.offsetToPos(this.rangeSpec.to_ch)
      )
      if (this.rangeSpec.prefix.length > 0) { content = content.replaceAll("\n" + this.rangeSpec.prefix, "\n") }
      if (!content.endsWith("\n")) content += "\n"
      navigator.clipboard.writeText(content)
      new Notice("Copied to clipboard")
    }

    // 菜单按钮4 - 让块更宽
    const btn_wider: HTMLDivElement = this.div.createEl("div", {
      cls: ["ab-button", "ab-button-4", "edit-block-button"],
      attr: {"aria-label": "Make the block wider"}
    })
    btn_wider.empty(); btn_wider.appendChild(sanitizeHTMLToDom(ABReplacer_Widget.STR_ICON_WIDER));
    btn_wider.onclick = (e: MouseEvent) => {
      e.preventDefault()
      e.stopPropagation()
      if (dom_note.classList.contains("ab-super-width")) {
        dom_note.classList.remove("ab-super-width")
        this.div.classList.remove("ab-super-width-p")
      }
      else {
        dom_note.classList.add("ab-super-width")
        this.div.classList.add("ab-super-width-p")
      }
    }

    // 菜单按钮5 - 刷新
    const btn_refresh: HTMLDivElement = this.div.createEl("div", {
      cls: ["ab-button", "ab-button-5", "edit-block-button"],
      attr: {"aria-label": "Refresh the block"}
    })
    btn_refresh.empty(); btn_refresh.appendChild(sanitizeHTMLToDom(ABReplacer_Widget.STR_ICON_REFRESH));
    btn_refresh.onclick = (e: MouseEvent) => {
      e.preventDefault()
      e.stopPropagation()
      switch_more(false)
      abConvertEvent(this.div)
      syncRangeFromDom()
      this.moveCursor(-1)
    }

    // 菜单按钮2 - 展开更多 (2要后置)
    const btn_more: HTMLDivElement = this.div.createEl("div", {
      cls: ["ab-button", "ab-button-2", "edit-block-button"],
      attr: {"aria-label": "More option"}
    })
    btn_more.empty(); btn_more.appendChild(sanitizeHTMLToDom(ABReplacer_Widget.STR_ICON_ELLIPSIS));
    let is_show = false
    switch_more(false)
    btn_more.onclick = (e: MouseEvent) => {
      e.preventDefault()
      e.stopPropagation()
      switch_more()
    }
    /** 是否显示更多工具栏项 */
    function switch_more(_is_show?: boolean): void {
      if (_is_show !== undefined) is_show = _is_show
      else is_show = !is_show
      if (is_show) {
        btn_copy.classList.remove("ab-hide")
        btn_refresh.classList.remove("ab-hide")
        btn_wider.classList.remove("ab-hide")
      } else {
        btn_copy.classList.add("ab-hide")
        btn_refresh.classList.add("ab-hide")
        btn_wider.classList.add("ab-hide")
      }
    }

    // 控件部分的隐藏
    // 不需要，.edit-block-button 自带非悬浮隐藏的特性

    return this.div;
  }

  /**
   * 将单个 c2 条目（卡片/标签/时间线）的修改写回整块 AnyBlock 源码
   * 自动识别列表源 / 标题源
   */
  private patchC2ItemInBlockSource(
    fullSrc: string,
    itemIndex: number,
    newTitle: string,
    newBody: string,
  ): string | null {
    return this.applyC2PairsMutation(fullSrc, (pairs) => {
      if (itemIndex < 0 || itemIndex >= pairs.length) return pairs
      const next = pairs.slice()
      next[itemIndex] = { title: newTitle, body: newBody }
      return next
    })
  }

  /** 对整块 c2 条目对做变换后写回源码 */
  private applyC2PairsMutation(
    fullSrc: string,
    mutate: (pairs: C2ListPair[]) => C2ListPair[],
  ): string | null {
    // 以编辑器当前区间文本为准刷新 content，避免装饰 remap 后 rangeSpec.content 过期导致「写入失败」
    const oldContent = this.resolveContentInFullSrc(fullSrc)
    if (oldContent == null) return null
    this.rangeSpec.content = oldContent

    const isTitleSrc = this.isTitleC2Source(oldContent)
    let data: List_C2ListItem
    try {
      data = isTitleSrc
        ? C2ListProcess.title2c2data(oldContent)
        : C2ListProcess.list2c2data(oldContent)
    } catch (_) {
      return null
    }
    if (!data.length) return null
    const pairs = mutate(C2ListProcess.c2dataToPairs(data))
    if (!pairs.length) return null
    const newData = C2ListProcess.pairsToC2data(pairs)
    const newContent = isTitleSrc
      ? C2ListProcess.c2data2title(newData)
      : C2ListProcess.c2data2list(newData)
    return this.replaceContentInFullSrc(fullSrc, oldContent, newContent)
  }

  /**
   * 从当前 fullSrc 解析出可替换的 content 段。
   * 优先匹配缓存的 rangeSpec.content；对不上则按选择器从 fullSrc 剥离 header。
   */
  private resolveContentInFullSrc(fullSrc: string): string | null {
    const cached = this.rangeSpec.content
    if (cached) {
      if (fullSrc.includes(cached)) return cached
      const alt = cached.replace(/\n$/, "")
      if (alt && fullSrc.includes(alt)) return alt
      const withNl = cached.endsWith("\n") ? cached : cached + "\n"
      if (fullSrc.includes(withNl)) return withNl
    }

    // 列表/括号头：首行是 [header]，其余为 content
    const lines = fullSrc.split("\n")
    if (lines.length >= 2) {
      const first = lines[0]
      const looksBraceHeader = /^\s*[`\[].*[\]`]\s*$/.test(first)
        || (this.rangeSpec.header && first.includes("[") && first.includes("]"))
      if (looksBraceHeader) {
        return lines.slice(1).join("\n")
      }
      // mdit ::: header
      if (/^\s*:{3,}/.test(first)) {
        // 去掉首尾 ::: 行
        let end = lines.length
        for (let i = lines.length - 1; i > 0; i--) {
          if (/^\s*:{3,}/.test(lines[i])) { end = i; break }
        }
        return lines.slice(1, end).join("\n")
      }
    }

    // heading 源：整段即 content
    if (this.rangeSpec.selector === "heading" || /^#{1,6}\s/.test(fullSrc.trimStart())) {
      return fullSrc
    }

    // 兜底：若首行是列表项，整段当 content
    if (/^\s*[-*+]\s/.test(fullSrc)) return fullSrc

    return null
  }

  /** 判断内容是否为标题大纲源（title2card / title2tabs / title2timeline） */
  private isTitleC2Source(content: string): boolean {
    const first = content.trimStart().split("\n")[0] ?? ""
    if (/^#{1,6}\s/.test(first)) return true
    if (this.rangeSpec.selector === "heading") return true
    if (/title2(card|col|tabs?|timeline)/i.test(this.rangeSpec.header)) return true
    return false
  }

  private replaceContentInFullSrc(fullSrc: string, oldContent: string, newContent: string): string | null {
    const idx = fullSrc.lastIndexOf(oldContent)
    if (idx >= 0) {
      return fullSrc.slice(0, idx) + newContent + fullSrc.slice(idx + oldContent.length)
    }
    const alt = oldContent.replace(/\n$/, "")
    const idx2 = fullSrc.lastIndexOf(alt)
    if (idx2 < 0) return null
    return fullSrc.slice(0, idx2) + newContent + fullSrc.slice(idx2 + alt.length)
  }

  /** 取消编辑时整体重渲染预览；可重新挂上 tabs chrome */
  private restoreEmbedItemView(dom_note: HTMLElement, wireTabsChrome?: () => void) {
    const hadTabs = !!dom_note.querySelector(".ab-tab-root")
    if (hadTabs) {
      C2ListProcess.setPendingTabActivateIndex(
        C2ListProcess.getActiveTabIndex(dom_note, 0)
      )
    }
    dom_note.empty()
    dom_note.removeClass("ab-embed-editor")
    ABConvertManager.autoABConvert(
      dom_note as HTMLDivElement,
      this.rangeSpec.header,
      this.rangeSpec.content,
      this.rangeSpec.selector
    )
    wireTabsChrome?.()
  }

  /** tabs 内容无改动退出：只恢复该面板，不整块重渲染 */
  private softRestoreTabContent(
    itemEl: HTMLElement,
    title: string,
    body: string,
    itemIndex: number,
  ) {
    itemEl.empty()
    itemEl.removeClass("ab-embed-editor")
    C2ListProcess.stampEmbedItemAttrs(itemEl, itemIndex, title, body)
    if (body.trim() !== "") {
      ABConvertManager.getInstance().m_renderMarkdownFn(body, itemEl)
    }
  }

  /** card/col 标题或内容无改动退出：按 md 重渲染该局部 */
  private softRestoreMarkdownPart(el: HTMLElement, md: string) {
    el.empty()
    el.removeClass("ab-embed-editor")
    el.removeClass("ab-embed-title-editor")
    if (md.trim() !== "") {
      ABConvertManager.getInstance().m_renderMarkdownFn(md, el)
    }
  }

  /**
   * 通过控制光标移动间接取消显示块
   * 
   * @detail
   * 当line_offset为0时，相当于将光标移到AB块的第一行
   * 否则则相当于向上/向下偏移
   */
  private moveCursor(line_offset:number = 0): void{
    /** @warning 注意这里千万不能用 toDOM 方法给的 view 参数
     * const editor: Editor = view.editor
     * 否则editor是undefined
     */
    if (this.global_editor){
      const editor: Editor = this.global_editor
      let pos = getCursorPos(editor, this.rangeSpec.from_ch)
      if (pos) {
        pos.line+=line_offset
        if (line_offset<0) {
          pos.ch = 0
          editor.setCursor(pos)
        }
        // 如果是>=0，则表示将光标移动到AB块所在范围，那么需要重新渲染State
        else {
          editor.setCursor(pos)
          editor.replaceRange("OF", pos) // 这里相当于将光标移出再内移，间接使之重新渲染
          editor.replaceRange("", pos, {line:pos.line, ch:pos.ch+2})
        }
      }
    }
    return

    function getCursorPos(editor:Editor, total_ch:number): EditorPosition|null{
      let count_ch = 0
      let list_text: string[] = editor.getValue().split("\n")
      for (let i=0; i<list_text.length; i++){
        if (count_ch+list_text[i].length >= total_ch) return {line:i, ch:total_ch-count_ch}
        count_ch = count_ch + list_text[i].length + 1
      }
      return null
    }
  }

  // 移动端似乎会强制替换掉edit-block-button，大小设置不生效。不过触控位置和z-index似乎可以正常工作
  // 编辑图标
  static STR_ICON_CODE2 = `<svg xmlns="http://www.w3.org/2000/svg" stroke-linecap="round"
      stroke-linejoin="round" data-darkreader-inline-stroke="" stroke-width="2"
      viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" style="--darkreader-inline-stroke:currentColor;">
    <path d="m18 16 4-4-4-4"></path>
    <path d="m6 8-4 4 4 4"></path>
    <path d="m14.5 4-5 16"></path>
  </svg>`
  // 刷新图标
  // https://www.svgrepo.com/svg/18461/refresh, 原viewBox: 0 0 489.698 489.698, 原size 800
  static STR_ICON_REFRESH = `<svg version="1.1" id="Capa_1" xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" 
      xml:space="preserve"
      viewBox="-80 -80 650 650" width="24" height="24" fill="currentColor" stroke="currentColor" style="--darkreader-inline-stroke:currentColor;">
    <g>
      <g>
        <path d="M468.999,227.774c-11.4,0-20.8,8.3-20.8,19.8c-1,74.9-44.2,142.6-110.3,178.9c-99.6,54.7-216,5.6-260.6-61l62.9,13.1
          c10.4,2.1,21.8-4.2,23.9-15.6c2.1-10.4-4.2-21.8-15.6-23.9l-123.7-26c-7.2-1.7-26.1,3.5-23.9,22.9l15.6,124.8
          c1,10.4,9.4,17.7,19.8,17.7c15.5,0,21.8-11.4,20.8-22.9l-7.3-60.9c101.1,121.3,229.4,104.4,306.8,69.3
          c80.1-42.7,131.1-124.8,132.1-215.4C488.799,237.174,480.399,227.774,468.999,227.774z"/>
        <path d="M20.599,261.874c11.4,0,20.8-8.3,20.8-19.8c1-74.9,44.2-142.6,110.3-178.9c99.6-54.7,216-5.6,260.6,61l-62.9-13.1
          c-10.4-2.1-21.8,4.2-23.9,15.6c-2.1,10.4,4.2,21.8,15.6,23.9l123.8,26c7.2,1.7,26.1-3.5,23.9-22.9l-15.6-124.8
          c-1-10.4-9.4-17.7-19.8-17.7c-15.5,0-21.8,11.4-20.8,22.9l7.2,60.9c-101.1-121.2-229.4-104.4-306.8-69.2
          c-80.1,42.6-131.1,124.8-132.2,215.3C0.799,252.574,9.199,261.874,20.599,261.874z"/>
      </g>
    </g>
  </svg>`
  // 复制图标
  // https://lucide.dev/icons/copy
  static STR_ICON_COPY = `<svg xmlns="http://www.w3.org/2000/svg"
    width="24" height="24" viewBox="0 0 24 24" fill="none"
    stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"
    class="lucide lucide-copy-icon lucide-copy"
  >
    <rect width="14" height="14" x="8" y="8" rx="2" ry="2"/>
    <path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>
  </svg>`
  // 更宽图标
  // https://lucide.dev/icons/move-horizontal
  static STR_ICON_WIDER = `<svg xmlns="http://www.w3.org/2000/svg"
    width="24" height="24" viewBox="0 0 24 24" fill="none"
    stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"
    class="lucide lucide-move-horizontal-icon lucide-move-horizontal"
  >
    <path d="m18 8 4 4-4 4"/>
    <path d="M2 12h20"/>
    <path d="m6 8-4 4 4 4"/>
  </svg>
  `
  // 更多/横省略号图标
  // https://lucide.dev/icons/ellipsis
  static STR_ICON_ELLIPSIS = `<svg xmlns="http://www.w3.org/2000/svg"
    width="24" height="24" viewBox="0 0 24 24" fill="none"
    stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"
    class="lucide lucide-ellipsis-icon lucide-ellipsis"
  >
    <circle cx="12" cy="12" r="1"/>
    <circle cx="19" cy="12" r="1"/>
    <circle cx="5" cy="12" r="1"/>
  </svg>`
}
