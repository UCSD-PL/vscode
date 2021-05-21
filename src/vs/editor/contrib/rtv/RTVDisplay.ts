/* import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
 */

import 'vs/css!./rtv';
import { ICursorPositionChangedEvent } from 'vs/editor/common/controller/cursorEvents';
import { IModelContentChangedEvent } from 'vs/editor/common/model/textModelEvents';
import { IScrollEvent, IModelChangedEvent } from 'vs/editor/common/editorCommon';
import {
	EditorAction,
	registerEditorAction,
	registerEditorContribution,
	ServicesAccessor
} from 'vs/editor/browser/editorExtensions';
import { EditorLayoutInfo, EditorOption, ConfigurationChangedEvent } from 'vs/editor/common/config/editorOptions';
import * as strings from 'vs/base/common/strings';
import { IRange, Range } from 'vs/editor/common/core/range';
import { IOpenerService } from 'vs/platform/opener/common/opener';
import { IModeService } from 'vs/editor/common/services/modeService';
import { ICodeEditor } from 'vs/editor/browser/editorBrowser';
import { MarkdownRenderer } from 'vs/editor/browser/core/markdownRenderer';
import { IPosition, Position } from 'vs/editor/common/core/position';
import { MarkdownString } from 'vs/base/common/htmlContent';
import { IConfigurationChangeEvent, IConfigurationService } from 'vs/platform/configuration/common/configuration';
import { Registry } from 'vs/platform/registry/common/platform';
import { Extensions, IConfigurationNode, IConfigurationRegistry } from 'vs/platform/configuration/common/configurationRegistry';
import { localize } from 'vs/nls';
import { IContextMenuService } from 'vs/platform/contextview/browser/contextView';
import { Action, IAction, Separator, SubmenuAction} from 'vs/base/common/actions';
import { IMouseWheelEvent } from 'vs/base/browser/mouseEvent';
import { IKeyboardEvent } from 'vs/base/browser/keyboardEvent';
import { KeyCode, KeyMod } from 'vs/base/common/keyCodes';
import { KeybindingWeight } from 'vs/platform/keybinding/common/keybindingsRegistry';
import { IThemeService } from 'vs/platform/theme/common/themeService';
import {
	editorWidgetBackground,
	inputBackground,
	inputBorder,
	inputForeground,
	widgetShadow
} from 'vs/platform/theme/common/colorRegistry';
import { IIdentifiedSingleEditOperation, IModelDecorationOptions, ITextModel } from 'vs/editor/common/model';
import { RunProcess, RunResult, IRTVController, IRTVLogger, ViewMode, RowColMode, IRTVDisplayBox, BoxUpdateEvent, Utils } from 'vs/editor/contrib/rtv/RTVInterfaces';
import { getUtils } from 'vs/editor/contrib/rtv/RTVUtils';
import { Button } from 'vs/base/browser/ui/button/button';
import { attachButtonStyler } from 'vs/platform/theme/common/styler';
import { RTVSynth } from './RTVSynth';
import { Emitter, Event } from 'vs/base/common/event';

export const htmlPolicy = window.trustedTypes?.createPolicy('rtv', { createHTML: (value) => value } );

function indent(s: string): number {
	return s.length - s.trimLeft().length;
}

function isHtmlEscape(s: string): boolean {
	return s.startsWith('```html\n') && s.endsWith('```');
}

function removeHtmlEscape(s: string): string {
	let x = '```html\n'.length;
	let y = '```'.length;
	return s.substring(x, s.length - y);
}

function arrayStartsWith<T>(haystack: T[], needle: T[]): boolean {
	if (haystack.length < needle.length) {
		return false;
	}

	if (haystack === needle) {
		return true;
	}

	for (let i = 0; i < needle.length; i++) {
		if (haystack[i] !== needle[i]) {
			return false;
		}
	}

	return true;
}

function isEmpty(str: string) {
	return str.trim() === '';
}

function isSeedLine(str: string) {
	return str.match('#@') !== null;
}

function isLoopStr(str: string) {
	let trimmed = str.trim();
	return trimmed.endsWith(':') &&
		(trimmed.startsWith('for') || trimmed.startsWith('while'));
}

function strNumsToArray(s: string): number[] {
	if (s === '') {
		return [];
	} else {
		return s.split(',').map(e => +e);
	}
}

// returns true if s matches regExp
function regExpMatchEntireString(s: string, regExp: string) {
	let res = s.match(regExp);
	return res !== null && res.index === 0 && res[0] === s;
}

export class DelayedRunAtMostOne {
	private _reject?: () => void;

	public async run(delay: number, c: () => Promise<void>) {
		if (this._reject) {
			this._reject();
		}

		if (delay === 0) {
			this._reject = undefined;
		} else {
			await new Promise((resolve, reject) => {
				let timeout = setTimeout(resolve, delay);
				this._reject = () => {
					clearTimeout(timeout);
					reject();
				};
			});
		}

		await c();
	}

	public cancel() {
		if (this._reject) {
			this._reject();
			this._reject = undefined;
		}
	}
}

class DeltaVarSet {
	private _plus: Set<string>;
	private _minus: Set<string>;
	constructor(other?: DeltaVarSet) {
		if (other === undefined) {
			this._plus = new Set();
			this._minus = new Set();
		} else {
			this._plus = new Set(other._plus);
			this._minus = new Set(other._minus);
		}
	}
	public add(v: string) {
		if (this._minus.has(v)) {
			this._minus.delete(v);
		} else {
			this._plus.add(v);
		}
	}
	public delete(v: string) {
		if (this._plus.has(v)) {
			this._plus.delete(v);
		} else {
			this._minus.add(v);
		}
	}
	public applyTo(s: Set<string>, all: Set<string>) {
		let res = new Set<string>(s);
		this._plus.forEach(v => {
			if (all.has(v)) {
				if (res.has(v)) {
					//this._plus.delete(v);
				} else {
					res.add(v);
				}
			} else {
				//this._plus.delete(v);
			}
		});
		this._minus.forEach(v => {
			if (all.has(v)) {
				if (res.has(v)) {
					res.delete(v);
				} else {
					//this._minus.delete(v);
				}
			} else {
				//this._minus.delete(v);
			}
		});
		return res;
	}
	public clear() {
		this._plus.clear();
		this._minus.clear();
	}
}

class RTVLine {
	private _div: HTMLDivElement;
	constructor(
		editor: ICodeEditor,
		x1: number,
		y1: number,
		x2: number,
		y2: number
	) {
		let editor_div = editor.getDomNode();
		if (editor_div === null) {
			throw new Error('Cannot find Monaco Editor');
		}

		this._div = document.createElement('div');
		this._div.style.position = 'absolute';
		this._div.style.borderTop = '1px solid grey';
		this._div.style.transitionProperty = 'all';
		this._div.style.transitionDuration = '0.3s';
		this._div.style.transitionDelay = '0s';
		this._div.style.transitionTimingFunction = 'ease-in';
		this._div.style.transformOrigin = '0% 0%';
		this.move(x1, y1, x2, y2);
		editor_div.appendChild(this._div);
	}

	public destroy() {
		this._div.remove();
	}

	public move(x1: number, y1: number, x2: number, y2: number) {
		this._div.style.left = x1.toString() + 'px';
		this._div.style.top = y1.toString() + 'px';
		let deltaX = (x2 - x1);
		let deltaY = (y2 - y1);
		let length = Math.sqrt((deltaX * deltaX) + (deltaY * deltaY));
		this._div.style.width = length.toString() + 'px';
		let angle = 0;
		if (length !== 0) {
			angle = Math.atan(deltaY / deltaX) * 180 / Math.PI;
		}
		this._div.style.transform = 'rotate(' + angle.toString() + 'deg)';
	}

	public setOpacity(opacity: number) {
		this._div.style.opacity = opacity.toString();
	}

}

class TableElement {
	constructor(
		public content: string,
		public loopID: string,
		public iter: string,
		public controllingLineNumber: number,
		public vname?: string,
		public env?: any,
		public leftBorder?: boolean
	) {}
}

type MapLoopsToCells = { [k: string]: HTMLTableDataCellElement[]; };

class RTVOutputDisplayBox {
	private _box: HTMLDivElement;
	private _html: string = '<b>Output:</b><br><br><b>Errors:</b><br>';
	private _isOnDiv: boolean = false;
	constructor(
		private readonly _editor: ICodeEditor
	) {

		let editor_div = this._editor.getDomNode();
		if (editor_div === null) {
			throw new Error('Cannot find Monaco Editor');
		}

		this._box = document.createElement('div');
		this._box.style.position = 'absolute';
		this._box.style.top = '30px'; // offset from the run button + border + padding
		this._box.style.bottom = '14px'; // offset from the horizontal scroll bar (if any)
		this._box.style.right = '14px';
		this._box.style.height = 'auto';
		this._box.style.width = '500px';
		this._box.innerHTML = htmlPolicy ? htmlPolicy.createHTML(this._html) as unknown as string : this._html;
		this._box.style.display = 'inline-block';
		this._box.style.overflowY = 'scroll';
		this._box.style.overflowX = 'auto';
		this._box.style.opacity = '0';
		this._box.className = 'monaco-hover';
		this._box.id = 'rtv-output-display-box';
		this._box.style.transitionProperty = 'all';
		this._box.style.transitionDuration = '0.3s';
		this._box.style.transitionDelay = '0s';
		this._box.style.transitionTimingFunction = 'ease-in';

		this._box.addEventListener('transitionend', (e: TransitionEvent) => {
			if (e.propertyName !== 'opacity') {
				return;
			}

			if (this._box.style.opacity === '0') {
				this._box.style.display = 'none';
			}
		});

		this._box.onmouseenter = (e) => {
			this.onMouseEnter(e);
		};
		this._box.onmouseleave = (e) => {
			this.onMouseLeave(e);
		};
		this.hide();
		// editor_div.appendChild(this._box);
	}

	public destroy(): void {
		this._box.remove();
	}

	public setContent(s: string): void {
		this._box.innerHTML = htmlPolicy ? htmlPolicy.createHTML(s) as unknown as string : s;
	}

	public getContent(): string {
		return this._box.innerHTML;
	}

	public clearContent(): void {
		this._box.innerHTML = htmlPolicy ? htmlPolicy.createHTML(this._html) as unknown as string : this._html;
	}

	public show(): void {
		let editor_div = this._editor.getDomNode();
		if (editor_div === null) {
			throw new Error('Cannot find Monaco Editor');
		}

		this._box.style.display = 'inline-block';
		this._box.style.opacity = '1';
		editor_div.appendChild(this._box);
	}

	public hide(): void {
		this._box.style.opacity = '0';
	}

	public isHidden() : boolean {
		return this._box.style.opacity === '0';
	}

	private onMouseEnter(e: MouseEvent): void {
		this._isOnDiv = true;
	}

	private onMouseLeave(e: MouseEvent): void {
		this._isOnDiv = false;
	}

	public mouseOnDiv(): boolean {
		return this._isOnDiv;
	}

	public setOutAndErrMsg(outputMsg: string, errorMsg: string) {

		function escapeHTML(unsafe: string) : string {
			return unsafe
				.replace(/&/g, '&amp;')
				.replace(/</g, '&lt;')
				.replace(/>/g, '&gt;')
				.replace(/"/g, '&quot;')
				.replace(/'/g, '&#039;');
		}

		setTimeout(() => {
			let errorMsgStyled = '';
			if (errorMsg !== '') {
				let errors = escapeHTML(errorMsg).split('\n'); // errorMsg can be null
				let errorStartIndex = 0;
				let i = 0;

				for (i = errors.length-1; i >= 0; i--) {
					let line = errors[i];
					if (line.match(/line \d+/g) !== null) { // returns an Array object
						errorStartIndex = i;
						break;
					}
				}

				let errorStartLine = errors[i];
				errors[i] = errorStartLine.split(',').slice(1,).join(',');
				let err = `<div style='color:red;'>${errors[errors.length - 2]}</div>`;
				errors[errors.length-2] = err;
				errorMsgStyled = errors.slice(errorStartIndex, -1).join('\n'); // related error starts from the fifth to the last substring
			}

			this.setContent(`<b>Output:</b><pre>${escapeHTML(outputMsg)}</pre><b>Errors:</b><pre>${errorMsgStyled}</pre>`);

		}, 50);

	}
}

class RTVRunButton {
	private _box: HTMLDivElement;
	private _button: Button;
	constructor(
		private readonly _editor: ICodeEditor,
		private readonly _controller: RTVController
	) {

		let editor_div = this._editor.getDomNode();
		if (editor_div === null) {
			throw new Error('Cannot find Monaco Editor');
		}
		this._box = document.createElement('div');
		this._box.style.position = 'absolute';
		this._box.style.top = '0px';
		this._box.style.right = '18px'; // not covering the navigation bar (14px) + padding (4px); assuming the minimap is disabled
		this._box.style.height = '20px';
		this._box.style.width = '60px';
		this._button = new Button(this._box);
		// TODO: localize
		this._button.label = 'Run';
		attachButtonStyler(this._button, this._controller._themeService);
		editor_div.appendChild(this._box);
		this._button.onDidClick(e => {
			this.onClick();
		});
	}

	public destroy(): void {
		this._box.remove();
	}

	public setButtonToRun(): void {
		this._button.label = 'Run';
	}

	public setButtonToHide(): void {
		this._button.label = 'Hide';
	}

	public show(): void {
		this._box.style.opacity = '1';
		this._box.style.display = '';
		// editor_div.appendChild(this._box);
	}

	public hide(): void {
		this._box.style.opacity = '0';
		this._box.style.display = 'none';
	}

	public isHidden() : boolean {
		return this._box.style.display === 'none' ||
			this._box.style.opacity === '0';
	}

	private onClick(): void {
		this._controller.flipOutputBoxVisibility();
	}

}

class RTVDisplayBox implements IRTVDisplayBox {
	private _box: HTMLDivElement;
	private _line: RTVLine;
	private _zoom: number = 1;
	private _opacity: number = 1;
	private _hasContent: boolean = false;
	private _allEnvs: any[] = [];
	private _allVars: Set<string> = new Set<string>();
	private _displayedVars: Set<string> = new Set<string>();
	private _deltaVarSet: DeltaVarSet;
	private _cellDictionary: { [k: string]: [HTMLElement] } = {};

	constructor(
		private readonly _controller: RTVController,
		private readonly _editor: ICodeEditor,
		private readonly _modeService: IModeService,
		private readonly _openerService: IOpenerService,
		public lineNumber: number,
		deltaVarSet: DeltaVarSet
	) {
		// if (this._controller.displayOnlyModifiedVars) {
		// 	this._displayedVars = new ModVarSet(this);
		// } else {
		// 	this._displayedVars = new FullVarSet(this);
		// }
		let editor_div = this._editor.getDomNode();
		if (editor_div === null) {
			throw new Error('Cannot find Monaco Editor');
		}
		this._box = document.createElement('div');
		this._box.textContent = '';
		this._box.style.position = 'absolute';
		this._box.style.top = '100px';
		this._box.style.left = '800px';
		this._box.style.maxWidth = '1400px';
		this._box.style.maxHeight = '400px';
		this._box.style.overflow = 'auto';
		this._box.style.transitionProperty = 'all';
		this._box.style.transitionDuration = '0.3s';
		this._box.style.transitionDelay = '0s';
		this._box.style.transitionTimingFunction = 'ease-in';
		this._box.style.maxHeight = '500px';
		this._box.style.zIndex = '1'; // Prevents it from covering the error dialog.
		this._box.style.paddingLeft = '13px';
		this._box.style.paddingRight = '13px';
		this._box.className = 'monaco-hover';
		this._box.id = 'rtv-display-box';

		// Update the font in case it's changed
		const fontInfo = this._editor.getOption(EditorOption.fontInfo);
		this._box.style.fontFamily = fontInfo.fontFamily;
		this._box.style.fontWeight = fontInfo.fontWeight;
		this._box.style.fontSize = `${fontInfo.fontSize}px`;

		this._editor.onDidChangeConfiguration((e: ConfigurationChangedEvent) =>
		{
			if (e.hasChanged(EditorOption.fontInfo))
			{
				const fontInfo = this._editor.getOption(EditorOption.fontInfo);
				this._box.style.fontFamily = fontInfo.fontFamily;
				this._box.style.fontWeight = fontInfo.fontWeight;
				this._box.style.fontSize = `${fontInfo.fontSize}px`;
			}
		});

		if (!this._controller.supportSynthesis && this._controller.mouseShortcuts) {
			this._box.onauxclick = (e) => {
				this.onClick(e);
			};
			this._box.onclick = (e) => {
				this.onClick(e);
			};
		}
		editor_div.appendChild(this._box);
		this._line = new RTVLine(this._editor, 800, 100, 800, 100);
		this.setContentFalse();
		this._deltaVarSet = new DeltaVarSet(deltaVarSet);
	}

	public getEnvs(): any[] {
		return this._allEnvs;
	}

	public getCellContent() {
		return this._cellDictionary;
	}

	public hasContent() {
		return this._hasContent;
	}

	public destroy() {
		this._box.remove();
		this._line.destroy();
	}

	public setContentFalse() {
		// Set content to false. Boxes with no content don't get processed during layout pass,
		// so we take care of layout here, which is to make  invisible (opacity 0).
		this._allEnvs = [];
		this._hasContent = false;
		this._box.textContent = '';
		this._box.style.opacity = '0';
		this._line.setOpacity(0);
	}

	public setContentTrue() {
		// Set content to true. All other layout properties will be set during
		// layout pass
		this._hasContent = true;
	}

	public modVars() {
		let writesAtLine = this._controller.writes[this.lineNumber - 1];
		if (writesAtLine === undefined) {
			writesAtLine = [];
		}
		let result = new Set<string>(writesAtLine);
		if (this._allVars.has('rv')) {
			result.add('rv');
		}
		if (this._allVars.has('Exception Thrown')) {
			result.add('Exception Thrown');
		}
		return result;
	}

	public allVars() {
		return this._allVars;
	}

	public notDisplayedVars() {
		let result = new Set<string>();
		let displayed = this._displayedVars;
		this._allVars.forEach((v: string) => {
			if (!displayed.has(v)) {
				result.add(v);
			}
		});
		return result;
	}

	public getLineContent(): string {
		return this._controller.getLineContent(this.lineNumber);
	}

	public getLoopID(): string {
		if (this._allEnvs.length === 0) {
			return '';
		}
		return this._allEnvs[0]['$'];
	}

	public getFirstLoopIter(): string {
		if (this._allEnvs.length === 0) {
			return '';
		}
		return this._allEnvs[0]['#'];
	}

	public getNextLoopIter(loopID: string, iter: string, delta: number): string {
		if (delta === 0) {
			return iter;
		}

		let first = '';
		let envs = this._allEnvs;
		if (delta < 0) {
			envs = envs.slice(0, envs.length).reverse();
		}

		for (let i = 0; i < envs.length; i++) {
			let env = envs[i];

			if (env['$'] !== loopID) {
				throw Error('Error');
			}
			if (first === '') {
				if (env['$'] === loopID) {
					first = env['#'];
				}
			}

			if (env['$'] === loopID && env['#'] === iter) {
				let nexti = i + 1;
				if (nexti >= envs.length) {
					return first;
				}
				let nextEnv = envs[nexti];
				if (nextEnv['$'] !== loopID) {
					throw Error('Error');
				}
				if (nextEnv['$'] === loopID) {
					return nextEnv['#'];
				} else {
					return first;
				}
			}
		}

		return first;
	}

	private onClick(e: MouseEvent) {
		let c = this._controller;
		let currViewMode = c.viewMode;

		let viewModes = [ViewMode.Full, ViewMode.CursorAndReturn, ViewMode.Compact, ViewMode.Stealth];
		let viewModeActions = viewModes.map((v) => {
			let action = this.newAction(v, () => {
				c.changeViewMode(v);
			});
			if (currViewMode === v) {
				action.checked = true;
			}
			return action;
		});

		c.contextMenuService.showContextMenu({
			getAnchor: () => ({ x: e.clientX, y: e.clientY }),
			getActions: () => [
				this.newAction('Hide This Box', () => {
					c.hideBox(this);
				}),
				this.newAction('Hide All Other Boxes', () => {
					c.hideAllOtherBoxes(this);
				}),
				new Separator(),
				this.newAction('Restore This Box to Default', () => {
					c.restoreBoxToDefault(this);
				}),
				this.newAction('Restore All Boxes to Default', () => {
					c.restoreAllBoxesToDefault();
				}),
				new Separator(),
				new SubmenuAction('id', 'Appearance of All Boxes', viewModeActions, ''),
				new Separator(),
				this.newAction('See All Loop Iterations', () => {
					c.loopFocusController = null;
				}),
			],
			onHide: () => { },
			autoSelectFirstItem: true
		});
	}

	private isEmptyLine(): boolean {
		let lineContent = this._controller.getLineContent(this.lineNumber).trim();
		return lineContent.trim().length === 0;
	}

	private isConditionalLine(): boolean {
		let lineContent = this._controller.getLineContent(this.lineNumber).trim();
		return lineContent.endsWith(':') &&
			(lineContent.startsWith('if') ||
				lineContent.startsWith('else'));
	}

	private isLoopLine(): boolean {
		let lineContent = this._controller.getLineContent(this.lineNumber).trim();
		return lineContent.endsWith(':') &&
			(lineContent.startsWith('for') ||
				lineContent.startsWith('while'));
	}

	public isBreakLine(): boolean {
		let lineContent = this._controller.getLineContent(this.lineNumber).trim();
		return lineContent.startsWith('break');
	}

	public isReturnLine(): boolean {
		let lineContent = this._controller.getLineContent(this.lineNumber).trim();
		return lineContent.startsWith('return');
	}

	private bringToLoopCount(envs: any[], active_loop_iters: number[], loopId: string, iterCount: number) {
		while (active_loop_iters[active_loop_iters.length - 1] < iterCount) {
			envs.push({ '#': active_loop_iters.join(','), '$': loopId });
			active_loop_iters[active_loop_iters.length - 1]++;
		}
	}

	private addMissingLines(envs: any[]): any[] {
		let last = function <T>(a: T[]): T { return a[a.length - 1]; };
		let active_loop_iters: number[] = [];
		let active_loop_ids: string[] = [];
		let envs2: any[] = [];
		for (let i = 0; i < envs.length; i++) {
			let env = envs[i];
			if (env.begin_loop !== undefined) {
				if (active_loop_iters.length > 0) {
					let loop_iters: string[] = env.begin_loop.split(',');
					this.bringToLoopCount(envs2, active_loop_iters, last(active_loop_ids), +loop_iters[loop_iters.length - 2]);
				}
				active_loop_ids.push(env['$']);
				active_loop_iters.push(0);
			} else if (env.end_loop !== undefined) {
				let loop_iters: string[] = env.end_loop.split(',');
				this.bringToLoopCount(envs2, active_loop_iters, last(active_loop_ids), +last(loop_iters));
				active_loop_ids.pop();
				active_loop_iters.pop();
				active_loop_iters[active_loop_iters.length - 1]++;
			} else {
				let loop_iters: string[] = env['#'].split(',');
				this.bringToLoopCount(envs2, active_loop_iters, last(active_loop_ids), +last(loop_iters));
				envs2.push(env);
				active_loop_iters[active_loop_iters.length - 1]++;
			}
		}
		return envs2;
	}

	private filterLoops(envs: any[]): any[] {
		if (this._controller.loopFocusController === null) {
			return envs;
		}

		let focusCtrl = this._controller.loopFocusController;

		return envs.filter((e, i, a) => focusCtrl.matches(e['$'], e['#']));
	}

	private addCellContentAndStyle(cell: HTMLTableCellElement, elmt: TableElement, r: MarkdownRenderer) {
		if (this._controller.colBorder || elmt.leftBorder) {
			cell.style.borderLeft = '1px solid #454545';
		}
		let padding = this._controller.cellPadding + 'px';
		cell.style.paddingLeft = padding;
		cell.style.paddingRight = padding;
		cell.style.paddingTop = '0';
		cell.style.paddingBottom = '0';
		cell.style.boxSizing = 'content-box';

		cell.align = 'center';

		/* if (this._controller.byRowOrCol === RowColMode.ByCol) {
			cell.align = 'center';
		} else {
			cell.align = 'center';
		} */

		this.addCellContent(cell, elmt, r);
	}

	private addCellContent(cell: HTMLTableCellElement, elmt: TableElement, r: MarkdownRenderer) {
		let s = elmt.content;
		let cellContent: HTMLElement;
		if (s === '') {
			// Make empty strings into a space to make sure it's allocated a space
			// Otherwise, the divs in a row could become invisible if they are
			// all empty
			cellContent = document.createElement('div');
			cellContent.innerHTML = htmlPolicy ? htmlPolicy.createHTML('&nbsp') as unknown as string : '&nbsp';
		}
		else if (isHtmlEscape(s)) {
			cellContent = document.createElement('div');
			const innerHTML = removeHtmlEscape(s);
			cellContent.innerHTML = htmlPolicy ? htmlPolicy.createHTML(innerHTML) as unknown as string : innerHTML;
		} else {
			let renderedText = r.render(new MarkdownString(s));
			cellContent = renderedText.element;
		}

		if (this._controller.mouseShortcuts) {
			if (elmt.iter === 'header') {
				cellContent = this.wrapAsVarMenuButton(cellContent, s.substr(2, s.length - 4));
			} else if (elmt.iter !== '') {
				cellContent = this.wrapAsLoopMenuButton(cellContent, elmt.iter);
			}
		}

		if (this.lineNumber === elmt.controllingLineNumber) {
			const name = elmt.vname!;
			if (name in this._cellDictionary) {
				this._cellDictionary[name].push(cellContent);
			} else {
				this._cellDictionary[name] = [cellContent];
			}
		}

		// Remove any existing content
		cell.childNodes.forEach((child) => cell.removeChild(child));

		// Add the new content
		cell.appendChild(cellContent);
	}

	public getCellId(varname: string, idx: number): string {
		return `${this.lineNumber}-${varname}-${idx}`;
	}

	public getCell(varname: string, idx: number): HTMLTableCellElement | null {
		return document.getElementById(this.getCellId(varname, idx)) as HTMLTableCellElement;
	}

	private updateTableByRows(table: HTMLTableElement, renderer: MarkdownRenderer, rows: TableElement[][]) {
		for (let colIdx = 0; colIdx < rows[0].length; colIdx++) {
			for (let rowIdx = 1; rowIdx < rows.length; rowIdx++) {
				let elmt = rows[rowIdx][colIdx];
				// Get the cell
				let cell = this.getCell(elmt.vname!, rowIdx - 1)!;
				this.addCellContent(cell, elmt, renderer);
			}
		}
	}

	private updateTableByCols(table: HTMLTableElement, renderer: MarkdownRenderer, rows: TableElement[][]) {
		rows.forEach((row: TableElement[], rowIdx: number) => {
			if (rowIdx === 0) {
				// Skip the header.
				return;
			}
			row.forEach((elmt: TableElement, colIdx: number) => {
				// Get the cell
				let cell = this.getCell(elmt.vname!, rowIdx - 1)!;
				this.addCellContent(cell, elmt, renderer);
			});
		});
	}

	private populateTableByCols(table: HTMLTableElement, renderer: MarkdownRenderer, rows: TableElement[][]) {
		rows.forEach((row: TableElement[], rowIdx: number) => {
			let newRow = table.insertRow(-1);
			row.forEach((elmt: TableElement, colIdx: number) => {
				let newCell = newRow.insertCell(-1);

				// Skip the headers
				if (rowIdx > 0) {
					// The first row (header) has the varname!
					newCell.id = this.getCellId(elmt.vname!, rowIdx - 1);
				}

				this.addCellContentAndStyle(newCell, elmt, renderer);
			});
		});
	}

	private populateTableByRows(table: HTMLTableElement, renderer: MarkdownRenderer, rows: TableElement[][]) {
		let tableCellsByLoop = this._controller.tableCellsByLoop;
		for (let colIdx = 0; colIdx < rows[0].length; colIdx++) {
			let newRow = table.insertRow(-1);
			for (let rowIdx = 0; rowIdx < rows.length; rowIdx++) {
				let elmt = rows[rowIdx][colIdx];
				let newCell = newRow.insertCell(-1);

				if (rowIdx > 0 && colIdx > 0) {
					let varname = rows[0][colIdx].content;
					varname = varname.substr(2, varname.length - 4);
					newCell.id = this.getCellId(varname, rowIdx - 1);
				}

				this.addCellContentAndStyle(newCell, elmt, renderer);
				if (elmt.iter !== '') {
					if (tableCellsByLoop[elmt.iter] === undefined) {
						tableCellsByLoop[elmt.iter] = [];
					}
					tableCellsByLoop[elmt.iter].push(newCell);
				}
			}
		}
	}

	// private createTableByRows2(rows: TableElement[][]) {
	// 	this._box.textContent = '';
	// 	let tableCellsByLoop = this._coordinator.tableCellsByLoop;
	// 	const renderer = new MarkdownRenderer(this._editor, this._modeService, this._openerService);
	// 	let table = document.createElement('div');
	// 	table.style.display = 'table';
	// 	for (let colIdx = 0; colIdx < rows[0].length; colIdx++) {
	// 		let newRow = document.createElement('div');
	// 		newRow.style.display = 'table-row';
	// 		table.appendChild(newRow);
	// 		for (let rowIdx = 0; rowIdx < rows.length; rowIdx++) {
	// 			let elmt = rows[rowIdx][colIdx];
	// 			let newCell = this.computeCellContent(elmt.content, renderer)
	// 			newCell.style.display = 'table-cell';
	// 			newCell.style.width = '120px';
	// 			newRow.appendChild(newCell);
	// 		}
	// 	}
	// 	this._box.appendChild(table);
	// }

	public indentAtLine(lineno: number): number {
		return indent(this._controller.getLineContent(lineno));
	}

	public setContentForLineNotExecuted() {
		if (this._controller.showBoxWhenNotExecuted) {
			this._allEnvs = [];
			this._hasContent = true;
			this._box.textContent = 'Line not executed';
			this._box.style.paddingLeft = '8px';
			this._box.style.paddingRight = '8px';
			this._box.style.paddingBottom = '0px';
			this._box.style.paddingTop = '0px';
		} else {
			this.setContentFalse();
		}
	}

	public computeEnvs(allEnvs?: any[]) {

		let count = 0;
		if (this._controller.changedLinesWhenOutOfDate !== null) {
			count = this._controller.changedLinesWhenOutOfDate.size;
		}

		if (count > 4) {
			this.setContentFalse();
			return true;
		}

		if (!this._controller.showBoxAtEmptyLine && this.isEmptyLine()) {
			this.setContentFalse();
			return true;
		}

		// Get all envs at this line number
		let envs;

		if (allEnvs) {
			envs = allEnvs[this.lineNumber-1];
		} else {
			envs = this._controller.envs[this.lineNumber - 1];
		}

		if (envs === undefined) {
			this.setContentForLineNotExecuted();
			return true;
		}

		if (this.isConditionalLine() ||
			this.isBreakLine() ||
			(!this._controller.showBoxAtLoopStmt && this.isLoopLine())) {
			let exception = false;
			envs.forEach((env: any) => {
				if (env['Exception Thrown'] !== undefined) {
					exception = true;
				}
			});
			if (!exception) {
				this.setContentFalse();
				return true;
			}
		}


		let count_countent_envs = 0;
		envs.forEach((env: any) => {
			if (env.end_loop === undefined && env.begin_loop === undefined) {
				count_countent_envs++;
			}
		});

		if (count_countent_envs === 0) {
			this.setContentForLineNotExecuted();
			return true;
		}

		//envs = this.adjustToNextTimeStep(envs);
		envs = this.addMissingLines(envs);

		this._allEnvs = envs;

		this.setContentTrue();

		return false;
	}

	public updateContent(allEnvs?: any[], updateInPlace?: boolean, outputVars?: string[], prevEnvs?: Map<number, any>) {

		// if computeEnvs returns false, there is no content to display
		let done = this.computeEnvs(allEnvs);
		if (done) {
			return;
		}

		let outVarNames: string[];
		if (!outputVars) {
			outVarNames = [];
		} else {
			outVarNames = outputVars!;
		}

		let envs = this._allEnvs;

		// Compute set of vars in all envs
		this._allVars = new Set<string>();
		let added_loop_vars = false;
		let added_loop_iter = false;
		for (const env of envs) {
			// always add "#" first, if we haven't done it already
			if (!added_loop_iter && env['#'] !== '') {
				added_loop_iter = true;
				this._allVars.add('#');
			}

			// then add active loop variables, if we haven't done it already
			if (!added_loop_vars && env['$'] !== '') {
				added_loop_vars = true;
				// env['$'] is a comma-seperated list of line numbers
				let loop_ids: string[] = env['$'].split(',');
				loop_ids.forEach( loop_lineno => {
					let loop_vars = this._controller.writes[loop_lineno];
					if (loop_vars !== undefined) {
						loop_vars.forEach( v => {
							this._allVars.add(v);
						});
					}
				});
			}

			// then add everything else
			for (let key in env) {
				if (key !== 'prev_lineno' &&
					key !== 'next_lineno' &&
					key !== 'lineno' &&
					key !== 'time' &&
					key !== '$' &&
					key !== '#') {
					this._allVars.add(key);
				}
			}
		}

		let startingVars: Set<string>;
		if (this._controller.displayOnlyModifiedVars) {
			startingVars = this.modVars();
		} else {
			startingVars = this._allVars;
		}

		envs = this.filterLoops(envs);

		if (envs.length === 0) {
			this.setContentFalse();
			return;
		}

		let vars = this._deltaVarSet
			.applyTo(startingVars, this._allVars)

		if (prevEnvs) {
			const oldVars = vars;
			vars = new Set();
			for (const v of oldVars) {
				// remove any variables newly defined by the synthsizer
				let rs = true;
				if (outVarNames.includes(v)) {
					for (const env of envs) {
						const time = env['time'];
						const prev = prevEnvs.get(time);
						if (prev) {
							rs = v in prev;
						}
					}
				}

				if (rs) {
					vars.add(v);
				}
			}
		}

		this._displayedVars = vars;

		if (vars.size === 0) {
			this.setContentFalse();
			return;
		}

		// Generate header
		let rows: TableElement[][] = [];
		let header: TableElement[] = [];
		vars.forEach((v: string) => {
			let name = '**' + v + '**';
			if (outVarNames.includes(v)) {
				name = '```html\n<strong>' + v + '</strong><sub>in</sub>```'
			} else {
				name = '**' + v + '**'
			}
			header.push(new TableElement(name, 'header', 'header', 0, ''));
		});
		outVarNames.forEach((ov: string, i: number) => {
			header.push(new TableElement('```html\n<strong>' + ov + '</strong><sub>out</sub>```', 'header', 'header', 0, '', undefined, i === 0));
		});

		rows.push(header);

		// Generate all rows
		for (let i = 0; i < envs.length; i++) {
			let env = envs[i];
			let loopID = env['$'];
			let iter = env['#'];
			let row: TableElement[] = [];
			vars.forEach((v: string) => {
				let v_str: string;
				let varName = v;
				let varEnv = env;

				if (outVarNames.includes(v)) {
					varName += '_in';
					if (prevEnvs && prevEnvs.has(env['time'])) {
						varEnv = prevEnvs.get(env['time']);
					}
				}

				if (varEnv[v] === undefined) {
					v_str = '';
				} else if (isHtmlEscape(varEnv[v])) {
					v_str = varEnv[v];
				} else {
					v_str = '```python\n' + varEnv[v] + '\n```';
				}

				row.push(new TableElement(v_str, loopID, iter, this.lineNumber, varName, varEnv));
			});
			outVarNames.forEach((v: string, i: number) => {
				let v_str: string;
				if (env[v] === undefined) {
					v_str = '';
				} else if (isHtmlEscape(env[v])) {
					v_str = env[v];
				} else {
					v_str = '```python\n' + env[v] + '\n```';
				}
				row.push(new TableElement(v_str, loopID, iter, this.lineNumber, v, env, i === 0));
			});
			rows.push(row);
		}

		// Set border
		if (this._controller.boxBorder) {
			this._box.style.border = '';
		} else {
			this._box.style.border = '0';
		}

		const renderer = new MarkdownRenderer(
			{ 'editor': this._editor },
			this._modeService,
			this._openerService);

		if (updateInPlace) {
			this._cellDictionary = {};
			if (this._controller.byRowOrCol === RowColMode.ByRow) {
				this.updateTableByRows(this._box.firstElementChild as HTMLTableElement, renderer, rows);
			} else {
				this.updateTableByCols(this._box.firstElementChild as HTMLTableElement, renderer, rows);
			}
		} else {
			// Remove the contents
			this._box.textContent = '';

			// Create html table from rows
			let table = document.createElement('table');
			table.style.borderSpacing = '0px';

			// TODO Delete me: We do this for the whole box now.
			// table.style.paddingLeft = '13px';
			// table.style.paddingRight = '13px';

			this._cellDictionary = {};
			if (this._controller.byRowOrCol === RowColMode.ByRow) {
				this.populateTableByRows(table, renderer, rows);
			} else {
				this.populateTableByCols(table, renderer, rows);
			}
			this._box.appendChild(table);

			this.addStalenessIndicator();

			//this.addConfigButton();
			if (this._controller.mouseShortcuts) {
				this.addPlusButton();
			}
		}

	}

	private addStalenessIndicator() {
		// Add green/red dot to show out of date status
		let stalenessIndicator = document.createElement('div');
		stalenessIndicator.style.width = '5px';
		stalenessIndicator.style.height = '5px';
		stalenessIndicator.style.position = 'absolute';
		stalenessIndicator.style.top = '5px';
		stalenessIndicator.style.left = '3px';
		stalenessIndicator.style.borderRadius = '50%';
		let x = this._controller.changedLinesWhenOutOfDate;
		if (x === null) {
			stalenessIndicator.style.backgroundColor = 'green';
		} else {
			let green = 165 - (x.size - 1) * 35;
			if (green < 0) {
				green = 0;
			}
			stalenessIndicator.style.backgroundColor = 'rgb(255,' + green.toString() + ',0)';
		}

		this._box.appendChild(stalenessIndicator);
	}

	public varRemove(regExp: string, removed?: Set<string>) {
		if (regExp === '*') {
			regExp = '.*';
		}
		this.allVars().forEach((v) => {
			if (regExpMatchEntireString(v, regExp) && this._displayedVars.has(v)) {
				this._deltaVarSet.delete(v);
				if (removed !== undefined) {
					removed.add(v);
				}
			}
		});
	}

	public varRemoveAll(removed?: Set<string>) {
		this.varRemove('*', removed);
	}

	public varAdd(regExp: string, added?: Set<string>) {
		if (regExp === '*') {
			regExp = '.*';
		}
		this.allVars().forEach((v) => {
			if (regExpMatchEntireString(v, regExp) && !this._displayedVars.has(v)) {
				this._deltaVarSet.add(v);
				if (added !== undefined) {
					added.add(v);
				}
			}
		});
	}

	public varKeepOnly(regExp: string, added?: Set<string>, removed?: Set<string>) {
		this.varRemoveAll(removed);
		this._displayedVars.clear();
		this.varAdd(regExp, added);
	}

	public varAddAll(added?: Set<string>) {
		this.varAdd('*', added);
	}

	public varRestoreToDefault() {
		this._deltaVarSet.clear();
	}

	public varMakeVisible() {
		if (this._displayedVars.size === 0) {
			this.varRestoreToDefault();
		}
	}

	private newAction(label: string, actionCallBack: () => void): Action {
		return new Action('id', label, '', true, (event?) => {
			actionCallBack();
			return new Promise<void>((resolve, reject) => {
				resolve();
			});
		});
	}

	private wrapAsVarMenuButton(elmt: HTMLElement, varname: string): HTMLDivElement {
		let menubar = document.createElement('div');
		menubar.className = 'menubar';
		if (this._controller.byRowOrCol === RowColMode.ByCol) {
			menubar.style.height = '23px';
		} else {
			menubar.style.height = '19.5px';
		}
		menubar.appendChild(elmt);
		elmt.className = 'menubar-menu-button';
		let c = this._controller;
		elmt.onclick = (e) => {
			e.stopImmediatePropagation();
			c.contextMenuService.showContextMenu({
				getAnchor: () => elmt,
				getActions: () => [
					this.newAction('Remove ' + varname + ' in This Box', () => {
						c.varRemoveInThisBox(varname, this);
					}),
					this.newAction('Remove ' + varname + ' in All Boxes', () => {
						c.varRemoveInAllBoxes(varname);
					}),
					this.newAction('Only ' + varname + ' in This Box', () => {
						c.varKeepOnlyInThisBox(varname, this);
					}),
					this.newAction('Only ' + varname + ' in All Boxes', () => {
						c.varKeepOnlyInAllBoxes(varname);
					})
				],
				onHide: () => { },
				autoSelectFirstItem: true
			});
		};
		return menubar;
	}

	private wrapAsLoopMenuButton(elmt: HTMLElement, iter: string): HTMLDivElement {
		let menubar = document.createElement('div');
		menubar.className = 'menubar';
		menubar.style.height = '19.5px';
		// if (this._controller.byRowOrCol === RowColMode.ByCol) {
		// 	menubar.style.height = '23px';
		// } else {
		// 	menubar.style.height = '19.5px';
		// }
		menubar.appendChild(elmt);
		elmt.className = 'menubar-menu-button';
		elmt.style.padding = '0px';
		let c = this._controller;
		elmt.onclick = (e) => {
			e.stopImmediatePropagation();
			c.contextMenuService.showContextMenu({
				getAnchor: () => elmt,
				getActions: () => [
					this.newAction('Focus on This Loop Iteration', () => {
						c.loopFocusController = new LoopFocusController(this._controller, this, iter);
					})
				],
				onHide: () => { },
				autoSelectFirstItem: true
			});
		};
		return menubar;
	}

	private addPlusButton() {
		let menubar = document.createElement('div');
		menubar.className = 'menubar';
		menubar.style.height = '23px';
		menubar.style.position = 'absolute';
		menubar.style.top = '0px';
		menubar.style.right = '0px';
		let addButton = document.createElement('div');
		menubar.appendChild(addButton);
		addButton.className = 'menubar-menu-button';
		addButton.innerHTML = htmlPolicy ? htmlPolicy.createHTML('+') as unknown as string : '+';
		addButton.onclick = (e) => {
			e.stopImmediatePropagation();
			this._controller.contextMenuService.showContextMenu({
				getAnchor: () => addButton,
				getActions: () => this.createActionsForPlusMenu(),
				onHide: () => { },
				autoSelectFirstItem: true
			});

		};
		this._box.appendChild(menubar);

	}

	private createActionsForPlusMenu(): (IAction )[] {
		let res: IAction[] = [];
		this.notDisplayedVars().forEach((v) => {
			res.push(new SubmenuAction('id', 'Add ' + v, [
				this.newAction('to This Box', () => {
					this._controller.varAddInThisBox(v, this);
				}),
				this.newAction('to All Boxes', () => {
					this._controller.varAddInAllBoxes(v);
				})
			]));
		});
		res.push(new SubmenuAction('id', 'Add All Vars ', [
			this.newAction('to This Box', () => {
				this._controller.varAddAllInThisBox(this);
			}),
			this.newAction('to All Boxes', () => {
				this._controller.varAddAllInAllBoxes();
			})
		]));
		return res;
	}


	// public addConfigButton() {
	// 	let configButton = document.createElement('div');
	// 	let lines: HTMLElement[] = [];

	// 	for(let i = 0; i < 3; i++){
	// 		let hamburgerIconLine = document.createElement('div');
	// 		hamburgerIconLine.style.width = '90%';
	// 		hamburgerIconLine.style.height = '10%';
	// 		hamburgerIconLine.style.margin =  '20% 0%';
	// 		hamburgerIconLine.style.backgroundColor = 'black';
	// 		configButton.appendChild(hamburgerIconLine);
	// 		lines.push(hamburgerIconLine);
	// 	}
	// 	lines[0].style.transition = 'transform 0.2s';
	// 	lines[2].style.transition = 'transform 0.2s';

	// 	configButton.style.width = '10px';
	// 	configButton.style.height = '10px';
	// 	configButton.style.position = 'absolute';
	// 	configButton.style.top = '5px';
	// 	configButton.style.right = '2px';
	// 	if(configButton){
	// 		configButton.onclick = (e) =>{
	// 			e.stopPropagation();
	// 			if(this._coordinator._configBox){
	// 				console.log(this._coordinator._configBox.style.display);
	// 				this._coordinator.showOrHideConfigDialogBox();
	// 			}
	// 			else{
	// 				this._coordinator.addConfigDialogBox();
	// 			}
	// 			if(lines[1].style.opacity !== '0'){
	// 				lines[0].style.transform = 'translate(0%, 3px) rotate(-45deg)';
	// 				lines[2].style.transform = 'translate(0%, -3px) rotate(45deg)';
	// 				lines[1].style.opacity = '0';
	// 				console.log(lines[2]);
	// 			}else{
	// 				lines[0].style.transform = 'translate(0%, 0px) rotate(0deg)';
	// 				lines[1].style.opacity = '1';
	// 				lines[2].style.transform = 'translate(0%, 0px) rotate(0deg)';
	// 			}

	// 		};
	// 	}
	// 	this._box.appendChild(configButton);
	// }


	public getHeight() {
		return this._box.offsetHeight * this._zoom;
	}

	public updateLayout(top: number) {
		let pixelPosAtLine = this._controller.getLinePixelPos(this.lineNumber);

		let boxTop = top;
		if (this._controller.boxAlignsToTopOfLine) {
			boxTop = boxTop - (pixelPosAtLine.height / 2);
		}
		//let left = this._controller.maxPixelCol+50;
		let left = this._controller.maxPixelCol + 130;
		let zoom_adjusted_left = left - ((1 - this._zoom) * (this._box.offsetWidth / 2));
		let zoom_adjusted_top = boxTop - ((1 - this._zoom) * (this._box.offsetHeight / 2));
		this._box.style.top = zoom_adjusted_top.toString() + 'px';
		this._box.style.left = zoom_adjusted_left.toString() + 'px';
		this._box.style.transform = 'scale(' + this._zoom.toString() + ')';
		this._box.style.opacity = this._opacity.toString();

		let maxWidth = this._editor.getScrollWidth()-left-10;
		this._box.style.maxWidth = maxWidth.toString() + 'px';

		// update the line
		let midPointTop = pixelPosAtLine.top + (pixelPosAtLine.height / 2);

		//this._line.move(this._controller.maxPixelCol-50, midPointTop, left, top);
		this._line.move(this._controller.maxPixelCol + 30, midPointTop, left, top);

	}

	public updateZoomAndOpacity(dist: number, opacityMult: number) {
		let distAbs = Math.abs(dist);
		let zoom_upper = 1;
		let zoom_lower = 1 / (distAbs * 0.5 + 1);
		this._zoom = zoom_lower + (zoom_upper - zoom_lower) * this._controller.zoomLevel;

		this._opacity = 1;
		if (distAbs !== 0) {
			let opacity_upper = 1;
			let opacity_lower = 1 / distAbs;
			this._opacity = opacity_lower + (opacity_upper - opacity_lower) * this._controller.opacityLevel;
		}
		this._opacity = this._opacity * opacityMult;
		this._line.setOpacity(this._opacity);
	}

	public fade() {
		let oldOpacity = this._box.style.opacity === '' ? '1' : this._box.style.opacity;
		if (oldOpacity) {
			let newOpacity = parseFloat(oldOpacity) * 0.9;
			this._box.style.opacity = newOpacity.toString();
			this._line.setOpacity(newOpacity);
			this._opacity = newOpacity;
		}
	}

}

enum ChangeVarsWhere {
	Here = 'here',
	All = 'all',
}

enum ChangeVarsOp {
	Add = 'add',
	Del = 'del',
	Keep = 'keep'
}

class LoopFocusController {

	private _loopIDArr: number[];
	private _iterArr: number[];
	private _decoration1?: string;
	private _decoration2?: string;
	private _decoration3?: string;
	constructor(
		private readonly _controller: RTVController,
		public readonly controllingBox: RTVDisplayBox,
		public readonly iter: string,
	) {
		this._iterArr = strNumsToArray(iter);
		this._loopIDArr = strNumsToArray(controllingBox.getLoopID());
		this.resetDecorations(true);
	}

	public resetDecorations(addEndToken = false) {
		this.destroyDecorations();
		if (this.hasSeed()) {
			let seedLineno = this.controllingBox.lineNumber;
			let model = this._controller.getModelForce();
			let lines = model.getLinesContent();
			let currIndent = indent(lines[seedLineno - 1]);
			let start = seedLineno;
			function isStillInLoop(s: string) {
				return isEmpty(s) || indent(s) >= currIndent;
			}
			while (start >= 1 && isStillInLoop(lines[start - 1])) {
				start = start - 1;
			}
			let end = seedLineno;
			while (end < lines.length + 1 && isStillInLoop(lines[end - 1])) {
				end = end + 1;
			}

			let range1 = new Range(1, 1, start, model.getLineMaxColumn(start));
			let maxline = lines.length;
			let range2 = new Range(end, 1, maxline, model.getLineMaxColumn(maxline));
			let seedLineContent = lines[seedLineno - 1];
			let range3 = new Range(seedLineno, indent(seedLineContent) + 1, seedLineno, seedLineContent.length + 1);
			this._decoration1 = this._controller.addDecoration(range1, { inlineClassName: 'rtv-code-fade' });
			this._decoration2 = this._controller.addDecoration(range2, { inlineClassName: 'rtv-code-fade' });
			this._decoration3 = this._controller.addDecoration(range3, { className: 'squiggly-info' });

			let endToken = '## END LOOP';
			if (addEndToken && !lines[end - 2].endsWith(endToken)) {
				let endCol = model.getLineMaxColumn(end - 1);
				let range4 = new Range(end - 1, endCol, end - 1, endCol);
				this._controller.executeEdits([{ range: range4, text: '\n' + seedLineContent.substr(0, currIndent) + endToken }]);
			}
		}
	}

	public destroyDecorations() {
		if (this._decoration1) {
			this._controller.removeDecoration(this._decoration1);
		}
		if (this._decoration2) {
			this._controller.removeDecoration(this._decoration2);
		}
		if (this._decoration3) {
			this._controller.removeDecoration(this._decoration3);
		}
	}

	public hasSeed(): boolean {
		return isSeedLine(this.controllingBox.getLineContent());
	}

	public matchesIter(otherIter: string): boolean {
		let otherIterArr = strNumsToArray(otherIter);
		return arrayStartsWith(otherIterArr, this._iterArr);
	}

	public matchesID(otherLoopID: string): boolean {
		let otherLoopsLinenoArr = strNumsToArray(otherLoopID);
		return arrayStartsWith(otherLoopsLinenoArr, this._loopIDArr);
	}

	public matches(otherLoopID: string, otherIter: string): boolean {
		this._loopIDArr = strNumsToArray(this.controllingBox.getLoopID());
		return this.matchesID(otherLoopID) && this.matchesIter(otherIter);
	}

}


type VisibilityPolicy = (b: RTVDisplayBox, cursorLineNumber: number) => boolean;

function visibilityAll(b: RTVDisplayBox, cursorLineNumber: number) {
	return true;
}

function visibilityNone(b: RTVDisplayBox, cursorLineNumber: number) {
	return false;
}

function visibilityCursor(b: RTVDisplayBox, cursorLineNumber: number) {
	return b.lineNumber === cursorLineNumber;
}

function visibilityCursorAndReturn(b: RTVDisplayBox, cursorLineNumber: number) {
	return b.lineNumber === cursorLineNumber || b.isReturnLine();
}

// enum LangId {
// 	NotSupported = 0,
// 	Python = 1,
// 	Haskell = 2
// }

export class RTVController implements IRTVController {
	public envs: { [k: string]: any[]; } = {};
	public writes: { [k: string]: string[]; } = {};
	public changedLinesWhenOutOfDate: Set<number> | null = null;
	public _configBox: HTMLDivElement | null = null;
	public tableCellsByLoop: MapLoopsToCells = {};
	public logger: IRTVLogger;
	public pythonProcess?: RunProcess = undefined;
	public utils: Utils = getUtils();
	public runProgramDelay: DelayedRunAtMostOne = new DelayedRunAtMostOne();
	private _eventEmitter: Emitter<BoxUpdateEvent> = new Emitter<BoxUpdateEvent>();
	private _boxes: RTVDisplayBox[] = [];
	private _maxPixelCol = 0;
	private _prevModel: string[] = [];
	private _config: ConfigurationServiceCache;
	private _makeNewBoxesVisible: boolean = true;
	private _loopFocusController: LoopFocusController | null = null;
	private _errorDecorationID: string | null = null;
	private _visibilityPolicy: VisibilityPolicy = visibilityAll;
	private _peekCounter: number = 0;
	private _peekTimer: ReturnType<typeof setTimeout> | null = null;
	private _globalDeltaVarSet: DeltaVarSet = new DeltaVarSet();
	private _showErrorDelay: DelayedRunAtMostOne = new DelayedRunAtMostOne();
	private _outputBox: RTVOutputDisplayBox| null = null;
	private _runButton: RTVRunButton | null = null;
	private _synthesis: RTVSynth;
	private enabled: boolean = true;

	get onUpdateEvent(): Event<BoxUpdateEvent> {
		return this._eventEmitter.event;
	}

	public static readonly ID = 'editor.contrib.rtv';

	constructor(
		private readonly _editor: ICodeEditor,
		@IOpenerService private readonly _openerService: IOpenerService,
		@IModeService private readonly _modeService: IModeService,
		@IConfigurationService configurationService: IConfigurationService,
		@IContextMenuService public readonly contextMenuService: IContextMenuService,
		@IThemeService readonly _themeService: IThemeService,
		//@IModelService private readonly _modelService: IModelService,
	) {
		// let isReadOnly=undefined;
		// setTimeout(()=>{isReadOnly = this._editor.getRawOptions().readOnly;}, 500);
		// setTimeout(() => {console.log(this._editor.getRawOptions().readOnly);}, 500);
		this._editor.onDidChangeCursorPosition((e) => { this.onDidChangeCursorPosition(e); });
		this._editor.onDidScrollChange((e) => { this.onDidScrollChange(e); });
		this._editor.onDidLayoutChange((e) => { this.onDidLayoutChange(e); });
		this._editor.onDidChangeModel((e) => { this.onDidChangeModel(e); });
		this._editor.onDidChangeModelContent((e) => { this.onDidChangeModelContent(e); });
		this._editor.onDidChangeModelLanguage((e) => { this.updateBoxes(); });
		this._editor.onMouseWheel((e) => { this.onMouseWheel(e); });
		this._editor.onKeyUp((e) => { this.onKeyUp(e); });
		this._editor.onKeyDown((e) => { this.onKeyDown(e); });
		//this._modelService.onModelModeChanged((e) => { console.log('BBBB');  });

		this._synthesis = new RTVSynth(_editor, this, this._themeService);
		this.logger = this.utils.logger(this._editor);

		this.updateMaxPixelCol();

		this._config = new ConfigurationServiceCache(configurationService);
		this._config.onDidUserChangeConfiguration = (e) => {
			this.onUserChangeConfiguration(e);
		};
		// this.changeViewMode(this.viewMode);

		//this._modVarsInputField.getDomNode().style.width = '300px';
		this.logger.projectionBoxCreated();
	}

	public static get(editor: ICodeEditor): RTVController {
		return editor.getContribution<RTVController>(RTVController.ID);
	}

	public getId(): string {
		return RTVController.ID;
	}

	public enable() {
		this.enabled = true;
	}

	public disable() {
		this.enabled = false;
	}

	public isEnabled(): boolean {
		return this.enabled;
	}

	public dispose(): void {
		this.logger.projectionBoxDestroyed();
	}

	public restoreViewState(state: any): void {
	}

	// Configurable properties
	get boxAlignsToTopOfLine(): boolean {
		return this._config.getValue(boxAlignsToTopOfLineKey);
	}
	set boxAlignsToTopOfLine(v: boolean) {
		this._config.updateValue(boxAlignsToTopOfLineKey, v);
	}

	get boxBorder(): boolean {
		return this._config.getValue(boxBorderKey);
	}
	set boxBorder(v: boolean) {
		this._config.updateValue(boxBorderKey, v);
	}

	get byRowOrCol(): RowColMode {
		return this._config.getValue(byRowOrColKey);
	}
	set byRowOrCol(v: RowColMode) {
		this._config.updateValue(byRowOrColKey, v);
	}

	get cellPadding(): number {
		return this._config.getValue(cellPaddingKey);
	}
	set cellPadding(v: number) {
		this._config.updateValue(cellPaddingKey, v);
	}

	get colBorder(): boolean {
		return this._config.getValue(colBorderKey);
	}
	set colBorder(v: boolean) {
		this._config.updateValue(colBorderKey, v);
	}

	get displayOnlyModifiedVars(): boolean {
		return this._config.getValue(displayOnlyModifiedVarsKey);
	}
	set displayOnlyModifiedVars(v: boolean) {
		this._config.updateValue(displayOnlyModifiedVarsKey, v);
	}

	get opacityLevel(): number {
		return this._config.getValue(opacityKey);
	}
	set opacityLevel(v: number) {
		this._config.updateValue(opacityKey, v);
	}

	get showBoxAtLoopStmt(): boolean {
		return this._config.getValue(showBoxAtLoopStmtKey);
	}
	set showBoxAtLoopStmt(v: boolean) {
		this._config.updateValue(showBoxAtLoopStmtKey, v);
	}

	get showBoxAtEmptyLine(): boolean {
		return this._config.getValue(showBoxAtEmptyLineKey);
	}
	set showBoxAtEmptyLine(v: boolean) {
		this._config.updateValue(showBoxAtEmptyLineKey, v);
	}

	get showBoxWhenNotExecuted(): boolean {
		return this._config.getValue(showBoxWhenNotExecutedKey);
	}
	set showBoxWhenNotExecuted(v: boolean) {
		this._config.updateValue(showBoxWhenNotExecutedKey, v);
	}

	get spaceBetweenBoxes(): number {
		return this._config.getValue(spaceBetweenBoxesKey);
	}
	set spaceBetweenBoxes(v: number) {
		this._config.updateValue(spaceBetweenBoxesKey, v);
	}

	get zoomLevel(): number {
		return this._config.getValue(zoomKey);
	}
	set zoomLevel(v: number) {
		this._config.updateValue(zoomKey, v);
	}

	get viewMode(): ViewMode {
		return this._config.getValue(viewModeKey);
	}
	set viewMode(v: ViewMode) {
		this._config.updateValue(viewModeKey, v);
	}

	get mouseShortcuts(): boolean {
		return this._config.getValue(mouseShortcutsKey);
	}
	set mouseShortcuts(v: boolean) {
		this._config.updateValue(mouseShortcutsKey, v);
	}

	get supportSynthesis(): boolean {
		return this._config.getValue(supportSynthesisKey);
	}
	set supportSynthesis(v: boolean) {
		this._config.updateValue(supportSynthesisKey, v);
	}

	// End of configurable properties

	get maxPixelCol() {
		return this._maxPixelCol;
	}

	get loopFocusController(): LoopFocusController | null {
		return this._loopFocusController;
	}

	set loopFocusController(lc: LoopFocusController | null) {
		this._loopFocusController?.destroyDecorations();
		this._loopFocusController = lc;
		this.updateContentAndLayout();
	}

	public changeToCompactView() {
		this.boxAlignsToTopOfLine = true;
		this.boxBorder = false;
		this.byRowOrCol = RowColMode.ByRow;
		this.cellPadding = 6;
		this.colBorder = true;
		this.displayOnlyModifiedVars = true;
		this.showBoxAtLoopStmt = true;
		this.spaceBetweenBoxes = -4;
		this.zoomLevel = 1;
		this.opacityLevel = 1;
		this.restoreAllBoxesToDefault();
	}

	public changeToFullView(zoom?: 0 | 1) {
		this.boxAlignsToTopOfLine = false;
		this.boxBorder = true;
		this.byRowOrCol = RowColMode.ByCol;
		this.cellPadding = 6;
		this.colBorder = false;
		this.displayOnlyModifiedVars = false;
		this.showBoxAtLoopStmt = false;
		this.spaceBetweenBoxes = 20;
		if (zoom === 1) {
			this.zoomLevel = 1;
			this.opacityLevel = 1;
		} else {
			this.zoomLevel = 0;
			this.opacityLevel = 0;
		}
		this.restoreAllBoxesToDefault();
	}

	private onUserChangeConfiguration(e: IConfigurationChangeEvent) {
		if (e.affectedKeys.indexOf(viewModeKey) !== -1) {
			this.changeViewMode(this.viewMode);
		} else if (e.affectedKeys.some((s) => s.startsWith('rtv'))) {
			this.viewMode = ViewMode.Custom;
		}
	}

	public getModelForce(): ITextModel {
		let model = this._editor.getModel();
		if (model === null) {
			throw Error('Expecting a model');
		}
		return model;
	}

	private getLineCount(): number {
		let model = this._editor.getModel();
		if (model === null) {
			return 0;
		}
		return model.getLineCount();
	}

	public getLineContent(lineNumber: number): string {
		let model = this._editor.getModel();
		if (model === null) {
			return '';
		}
		return model.getLineContent(lineNumber);
	}

	// private getLangId(): LangId {
	// 	let model = this._editor.getModel();
	// 	if (model === null) {
	// 		return LangId.NotSupported;
	// 	}
	// 	let uri = model.uri;
	// 	if (uri.scheme !== 'file') {
	// 		return LangId.NotSupported;
	// 	}
	// 	if (strings.endsWith(uri.path, '.py')) {
	// 		return LangId.Python;
	// 	}
	// 	if (strings.endsWith(uri.path, '.hs')) {
	// 		return LangId.Haskell
	// 	}
	// 	return LangId.NotSupported;
	// }

	private updateMaxPixelCol() {
		let model = this._editor.getModel();
		if (model === null) {
			return;
		}
		let max = 0;
		let lineCount = model.getLineCount();
		for (let line = 1; line <= lineCount; line++) {
			let s = model.getLineContent(line);
			if (s.length > 0 && s[0] === '#') {
				continue;
			}
			let col = model.getLineMaxColumn(line);
			let pixelPos = this._editor.getScrolledVisiblePosition(new Position(line, col));
			if (pixelPos !== null && pixelPos.left > max) {
				max = pixelPos.left;
			}
		}
		this._maxPixelCol = max;
	}

	public showOrHideConfigDialogBox() {
		if (!this._configBox) {
			return;
		}
		this._configBox.style.display = this._configBox.style.display === 'block' ? 'none' : 'block';
	}

	public addConfigDialogBox() {
		let editor_div = this._editor.getDomNode();
		if (!editor_div) {
			return;
		}
		let div = document.createElement('div');
		div.textContent = '';
		div.style.position = 'absolute';
		div.style.top = '200px';
		div.style.left = '800px';
		div.style.width = '100px';
		div.style.textAlign = 'left';
		div.style.transitionProperty = 'all';
		div.style.transitionDuration = '0.3s';
		div.style.transitionDelay = '0s';
		div.style.transitionTimingFunction = 'ease-in';
		div.style.boxShadow = '0px 2px 8px black';
		div.className = 'monaco-hover';
		div.style.display = 'block';
		div.id = 'rtv-config-dialog-box';

		/*Creates the row selector
		let row = document.createElement('div');
		let currColor = '#9effb1';
		row.textContent = 'Row';
		row.style.backgroundColor = this._row ? currColor : 'transparent';
		row.onclick = (e) => {
			e.stopImmediatePropagation();
			//Change row
			this._row = true;
			row.style.backgroundColor = this._row ? currColor : 'transparent';
			column.style.backgroundColor = this._row ? 'transparent' : currColor;
		};
		row.style.cssFloat = 'left';
		row.style.width = '35%';
		row.style.margin = '8px';
		row.style.padding = '5px';
		div.appendChild(row);

		//Creates the column selector
		let column = document.createElement('div');
		column.textContent = 'Column';
		column.style.backgroundColor = this._row ? 'transparent' : currColor;
		column.onclick = (e) => {
			e.stopImmediatePropagation();
			//Change col
			this._row = false;
			column.style.backgroundColor = this._row ? 'transparent' : currColor;
			row.style.backgroundColor = this._row ? currColor : 'transparent';
		};
		column.style.width = '35%';
		column.style.margin = '8px';
		column.style.cssFloat = 'right';
		column.style.padding = '5px';
		div.appendChild(column);*/

		let row = document.createElement('input');
		row.type = 'radio';
		row.name = 'row-or-col';
		row.value = 'row';
		row.textContent = 'Row';

		let rowText = document.createElement('label');
		rowText.innerText = 'Row';

		div.appendChild(row);
		div.appendChild(rowText);
		div.appendChild(document.createElement('br'));

		let col = document.createElement('input');
		col.type = 'radio';
		col.name = 'row-or-col';
		col.value = 'col';

		let colText = document.createElement('label');
		colText.innerText = 'Col';
		div.appendChild(col);
		div.appendChild(colText);
		div.appendChild(document.createElement('br'));

		editor_div.appendChild(div);
		this._configBox = div;
	}

	private updateLinesWhenOutOfDate(returnCode: number | null, e?: IModelContentChangedEvent) {
		if (e === undefined) {
			return;
		}
		if (returnCode === 0 || returnCode === 2) {
			this.changedLinesWhenOutOfDate = null;
			return;
		}
		if (this.changedLinesWhenOutOfDate === null) {
			this.changedLinesWhenOutOfDate = new Set();
		}
		let s = this.changedLinesWhenOutOfDate;
		e.changes.forEach((change) => {
			for (let i = change.range.startLineNumber; i <= change.range.endLineNumber; i++) {
				s.add(i);
			}
		});
	}

	public getBox(lineNumber: number): RTVDisplayBox {
		let i = lineNumber - 1;
		if (i >= this._boxes.length) {
			for (let j = this._boxes.length; j <= i; j++) {
				this._boxes[j] = new RTVDisplayBox(this, this._editor, this._modeService, this._openerService, j + 1, this._globalDeltaVarSet);
			}
		}
		return this._boxes[i];
	}

	private getOutputBox() {
		if (this._outputBox === null) {
			this._outputBox = new RTVOutputDisplayBox(this._editor);
		}
		return this._outputBox;
	}

	private getRunButton() {
		if (this._runButton === null) {
			this._runButton = new RTVRunButton(this._editor, this);
		}
		return this._runButton;
	}

	private isTextEditor() {
		let editorMode = this._editor.getModel()?.getModeId();
		return editorMode !== undefined && editorMode !== 'Log'; //'Log' is the language identifier for the output editor
	}

	public showOutputBox() {
		this.getRunButton().setButtonToHide();
		this.getOutputBox().show();
	}

	public hideOutputBox() {
		this.getOutputBox().hide();
		this.getRunButton().setButtonToRun();
		this.getRunButton().show(); // always show RunButton by default
	}

	public flipOutputBoxVisibility() {
		if (this.getOutputBox().isHidden()) {
			this.showOutputBox();
			this.logger.showOutputBox();
		} else {
			this.hideOutputBox();
			this.logger.hideOutputBox();
		}
	}

	public getBoxAtCurrLine() {
		let cursorPos = this._editor.getPosition();
		if (cursorPos === null) {
			throw new Error('No position to get box at');
		}

		return this.getBox(cursorPos.lineNumber);
	}

	private padBoxArray() {
		let lineCount = this.getLineCount();
		if (lineCount > this._boxes.length) {
			for (let j = this._boxes.length; j < lineCount; j++) {
				this._boxes[j] = new RTVDisplayBox(this, this._editor, this._modeService, this._openerService, j + 1, this._globalDeltaVarSet);
			}
		}
	}


	private onDidChangeCursorPosition(e: ICursorPositionChangedEvent) {
		this.updateLayout();
	}

	private onDidScrollChange(e: IScrollEvent) {
		if (e.scrollHeightChanged || e.scrollWidthChanged) {
			// this means the content also changed, so we will let the onChangeModelContent event handle it
			return;
		}
		// if (this.getOutputBox().mouseOnDiv()) {
		// 	// this means the cursor is within the output box; let onScroll handle it
		// 	// console.log('scroll in outputbox');
		// 	return;
		// }
		// console.log(e);
		this.updateMaxPixelCol();
		this.updateLayout();
		// console.log('scrolling');
	}

	private onDidLayoutChange(e: EditorLayoutInfo) {
		this.updateMaxPixelCol();
		this.updateLayout();
		// console.log('changing layout');
	}

	private onDidChangeModel(e: IModelChangedEvent) {
		if (this._editor.getModel() !== null) {
			this._boxes = [];
			this._outputBox?.destroy();
			this._outputBox = null;
			this._runButton?.destroy();
			this._runButton = null;
			this.envs = {};
			this.writes = {};
			this.updateBoxes();
		}
	}

	private async onDidChangeModelContent(e: IModelContentChangedEvent) {
		this.updateMaxPixelCol();
		await this.updateBoxes(e);

		let cursorPos = this._editor.getPosition();
		if (cursorPos === null) {
			return;
		}
		let lineno = cursorPos.lineNumber;
		if (e.changes.length > 0) {
			let range = e.changes[0].range;
			let lineCount = this.getLineCount();
			for (let i = range.startLineNumber; i <= range.endLineNumber; i++) {
				if (i <= lineCount && i === lineno) {
					if (isSeedLine(this.getLineContent(i))) {
						this.focusOnLoopWithSeed();
					}
					if (this.supportSynthesis) {
						const lineContent = this.getLineContent(i).trim();

						if (lineContent.endsWith('??') &&
							(lineContent.startsWith('return ') || lineContent.split('=').length === 2)) {
								this._synthesis.startSynthesis(i)
									.catch((e) => {
										console.error('Synthesis failed with exception:');
										console.error(e);
										this._synthesis.stopSynthesis();
									});
								return;
						}
					}
				}
			}
		}
		if (this.loopFocusController !== null) {
			this.loopFocusController.resetDecorations();
		}
	}

	private updateCellSizesForNewContent() {
		if (this.byRowOrCol !== RowColMode.ByRow) {
			return;
		}

		// Compute set of loop iterations
		let loops: string[] = [];
		for (let loop in this.tableCellsByLoop) {
			loops.push(loop);
		}
		// sort by deeper iterations first
		loops = loops.sort((a, b) => b.split(',').length - a.split(',').length);

		let widths: { [k: string]: number; } = {};
		loops.forEach((loop: string) => {
			widths[loop] = Math.max(...this.tableCellsByLoop[loop].map(e => e.offsetWidth));
			//console.log('Max for ' + loop + ' :' + widths[loop]);
		});

		let spaceBetweenCells = 2 * this.cellPadding;
		if (this.colBorder) {
			spaceBetweenCells = spaceBetweenCells + 1;
		}
		for (let i = 1; i < loops.length; i++) {
			let width = 0;
			let parent_loop = loops[i];
			for (let j = 0; j < i; j++) {
				let child_loop = loops[j];
				if (child_loop.split(',').length === 1 + parent_loop.split(',').length &&
					child_loop.startsWith(parent_loop)) {
					width = width + widths[child_loop];
					//width = width + widths[child_loop] + spaceBetweenCells;
				}
			}
			if (width !== 0) {
				//width = width - spaceBetweenCells;
				widths[parent_loop] = width;
			}
		}

		loops.forEach((loop: string) => {
			// console.log('Computed width for ' + loop + ': ' + widths[loop]);
			this.tableCellsByLoop[loop].forEach(e => { e.width = (widths[loop] - spaceBetweenCells) + 'px'; });
		});

	}
	public async updateContentAndLayout(outputVars?: string[], prevEnvs?: Map<number, any>): Promise<void> {
		this.tableCellsByLoop = {};
		this.updateContent(outputVars, prevEnvs);
		// The 0 timeout seems odd, but it's really a thing in browsers.
		// We need to let layout threads catch up after we updated content to
		// get the correct sizes for boxes.

		return new Promise((resolve, _reject) => {
			setTimeout(() => {
				this.updateCellSizesForNewContent();
				this.updateLayout();
				resolve();
			}, 0);
		});
	}

	private updateContent(outputVars?: string[], prevEnvs?: Map<number, any>) {
		this.padBoxArray();
		if (this.loopFocusController !== null) {
			// if we are focused on a loop, compute envs at the controlling box first
			// so that it's loop iterations are set properly, so that getLoopID works
			this.loopFocusController.controllingBox.computeEnvs();
		}
		this._boxes.forEach((b) => {
			b.updateContent(undefined, undefined, outputVars, prevEnvs);
		});
	}

	private updateLayoutHelper(toProcess: (b: RTVDisplayBox) => boolean, opacityMult: number) {
		this.padBoxArray();

		let cursorPos = this._editor.getPosition();
		if (cursorPos === null) {
			return;
		}

		// Compute focused line, which is the closest line to the cursor with a visible box
		let minDist = Infinity;
		let focusedLine = 0;
		for (let line = 1; line <= this.getLineCount(); line++) {
			if (toProcess(this.getBox(line))) {
				let dist = Math.abs(cursorPos.lineNumber - line);
				if (dist < minDist) {
					minDist = dist;
					focusedLine = line;
				}
			}
		}
		// this can happen if no boxes are to be processed
		if (minDist === Infinity) {
			return;
		}

		// compute distances from focused line, ignoring hidden lines.
		// Start from focused line and go outward.
		let distancesFromFocus: number[] = new Array(this._boxes.length);
		let dist = 0;
		for (let line = focusedLine; line >= 1; line--) {
			if (toProcess(this.getBox(line))) {
				distancesFromFocus[line - 1] = dist;
				dist = dist - 1;
			}
		}
		dist = 1;
		for (let line = focusedLine + 1; line <= this.getLineCount(); line++) {
			if (toProcess(this.getBox(line))) {
				distancesFromFocus[line - 1] = dist;
				dist = dist + 1;
			}
		}

		for (let line = 1; line <= this.getLineCount(); line++) {
			let box = this.getBox(line);
			if (toProcess(this.getBox(line))) {
				box.updateZoomAndOpacity(distancesFromFocus[line - 1], opacityMult);
			}
		}
		// let cursorPixelPos = this._editor.getScrolledVisiblePosition(cursorPos);
		// let nextLinePixelPos = this._editor.getScrolledVisiblePosition(new Position(cursorPos.lineNumber+1,cursorPos.column));
		// if (cursorPixelPos === null || nextLinePixelPos === null) {
		// 	return;
		// }

		let focusedLinePixelPos = this._editor.getScrolledVisiblePosition(new Position(focusedLine, 1));
		let nextLinePixelPos = this._editor.getScrolledVisiblePosition(new Position(focusedLine + 1, 1));
		if (focusedLinePixelPos === null || nextLinePixelPos === null) {
			return;
		}

		let spaceBetweenBoxes = this.spaceBetweenBoxes;
		// let top_start = focusedLinePixelPos.top + (focusedLinePixelPos.height / 2);
		//let top_start = (focusedLinePixelPos.top + nextLinePixelPos.top) / 2;
		//let top_start = focusedLinePixelPos.top;
		let top_start = this.getLinePixelMid(focusedLine);
		let top = top_start;
		for (let line = focusedLine - 1; line >= 1; line--) {
			let box = this.getBox(line);
			if (toProcess(box)) {
				top = top - spaceBetweenBoxes - box.getHeight();
				let lineMidPoint = this.getLinePixelMid(line);
				if (lineMidPoint < top) {
					top = lineMidPoint;
				}
				box.updateLayout(top);
			}
		}
		top = top_start;
		for (let line = focusedLine; line <= this.getLineCount(); line++) {
			let box = this.getBox(line);
			if (toProcess(box)) {
				let lineMidPoint = this.getLinePixelMid(line);
				if (lineMidPoint > top) {
					top = lineMidPoint;
				}
				box.updateLayout(top);
				top = top + box.getHeight() + spaceBetweenBoxes;
			}
		}

	}

	private updateLayout() {
		let cursorPos = this._editor.getPosition();
		if (cursorPos === null) {
			return;
		}
		let curr = cursorPos.lineNumber;
		this.updateLayoutHelper(b => b.hasContent(), 0);
		this.updateLayoutHelper(b => b.hasContent() && this._visibilityPolicy(b, curr), 1);
	}


	public getLinePixelPos(line: number): { top: number; left: number; height: number; } {
		// let result = this._editor.getScrolledVisiblePosition(new Position(line, 1));
		// if (result === null) {
		// 	throw new Error();
		// }
		// return result;
		return this.getLineColPixelPos(new Position(line, 1));
	}

	public getLineColPixelPos(position: IPosition): { top: number; left: number; height: number; } {
		let result = this._editor.getScrolledVisiblePosition(position);
		if (result === null) {
			throw new Error();
		}
		return result;
	}

	public getLinePixelMid(line: number): number {
		let pixelPos = this.getLinePixelPos(line);
		return pixelPos.top + (pixelPos.height / 2);
	}

	private updatePrevModel() {
		let model = this._editor.getModel();
		if (model !== null) {
			this._prevModel = model.getLinesContent().map((x) => x);
		}
	}

	public lastNonWhitespaceCol(lineNumber: number, lines?: string[]): number {
		let line = (lines === undefined) ? this.getLineContent(lineNumber) : lines[lineNumber - 1];
		const result = strings.lastNonWhitespaceIndex(line);
		if (result === -1) {
			return 0;
		}
		return result + 2;
	}

	public firstNonWhitespaceCol(lineNumber: number, lines?: string[]): number {
		let line = (lines === undefined) ? this.getLineContent(lineNumber) : lines[lineNumber - 1];
		const result = strings.firstNonWhitespaceIndex(line);
		if (result === -1) {
			return 0;
		}
		return result + 1;
	}

	private addRemoveBoxes(e?: IModelContentChangedEvent) {
		if (e === undefined) {
			this.updatePrevModel();
			return;
		}
		let orig = this._boxes;
		let changes = e.changes.sort((a, b) => Range.compareRangesUsingStarts(a.range, b.range));
		let changeIdx = 0;
		let origIdx = 0;
		let i = 0;
		this._boxes = [];
		let lineCount = this.getLineCount();
		while (i < lineCount) {
			if (changeIdx >= changes.length) {
				this._boxes[i++] = orig[origIdx++];
				this._boxes[i - 1].lineNumber = i;
			} else {
				let line = i + 1;
				let change = changes[changeIdx];
				let numAddedLines = change.text.split('\n').length - 1;
				let changeStartLine = change.range.startLineNumber;
				let changeEndLine = change.range.endLineNumber;
				let numRemovedLines = changeEndLine - changeStartLine;
				let deltaNumLines = numAddedLines - numRemovedLines;
				let changeStartCol = change.range.startColumn;
				if ((deltaNumLines <= 0 && changeStartLine === line) ||
					(deltaNumLines > 0 && ((changeStartLine === line && changeStartCol < this.lastNonWhitespaceCol(line, this._prevModel)) ||
						(changeStartLine === line - 1 && changeStartCol >= this.lastNonWhitespaceCol(line - 1, this._prevModel))))) {
					changeIdx++;
					if (deltaNumLines === 0) {
						// nothing to do
					} else if (deltaNumLines > 0) {
						for (let j = 0; j < deltaNumLines; j++) {
							let new_box = new RTVDisplayBox(this, this._editor, this._modeService, this._openerService, i + 1, this._globalDeltaVarSet);
							if (!this._makeNewBoxesVisible) {
								new_box.varRemoveAll();
							}
							this._boxes[i++] = new_box;
						}
					} else {
						for (let j = origIdx; j < origIdx + (-deltaNumLines); j++) {
							orig[j].destroy();
						}
						// need to make the removed boxes disappear
						origIdx = origIdx + (-deltaNumLines);
					}
				}
				else {
					this._boxes[i++] = orig[origIdx++];
					this._boxes[i - 1].lineNumber = i;
				}
			}
		}
		this.updatePrevModel();
	}

	public addDecoration(range: IRange, options: IModelDecorationOptions) {
		let result = '';
		this._editor.changeDecorations((c) => {
			result = c.addDecoration(range, options);
		});
		return result;
	}

	public removeDecoration(id: string) {
		this._editor.changeDecorations((c) => {
			c.removeDecoration(id);
		});
	}

	private showErrorWithDelay(returnCode: number, errorMsg: string) {
		this._showErrorDelay.run(1500, async () => {
			this.clearError();
			this.showError(errorMsg);
		})
		.catch((_err) => {});
	}

	private showError(errorMsg: string) {
		// There are two kinds of errors:
		//
		// I. Runtime errors, which end like this:
		//
		// File '<string>', line 4, in mean_average'
		// TypeError: list indices must be integers or slices, not float
		//
		// II. Parse errors, which end like this:
		//
		// File '<unknown>', line 4
		//    median = a[int(mid ]
		//                       ^
		// SyntaxError: invalid syntax

		let lineNumber = 0;
		let colStart = 0;
		let colEnd = 0;

		let errorLines = errorMsg.split(this.utils.EOL);
		errorLines.pop(); // last element is empty line

		// The error description is always the last line
		let description = errorLines.pop();
		if (description === undefined) {
			return;
		}

		// Let's look at the next-to-last line, and try to parse as
		// a runtime error, in which case there should be a line number
		let lineno = errorLines.pop();
		if (lineno === undefined) {
			return;
		}
		let linenoRE = 'line ([0-9]*)';
		let match = lineno.match(linenoRE);

		if (match !== null) {
			// found a line number here, so this is a runtime error)
			// match[0] is entire 'line N' match, match[1] is just the number N
			lineNumber = +match[1];

			try {
				colStart = this.firstNonWhitespaceCol(lineNumber);
				colEnd = this.lastNonWhitespaceCol(lineNumber);
			} catch (e) {
				console.error(e);
				return;
			}

		} else {
			// No line number here so this is a syntax error, so we in fact
			// didn't get the error line number, we got the line with the caret
			let caret = lineno;

			let caretIndex = caret.indexOf('^');
			if (caretIndex === -1) {
				// can't figure out the format, give up
				return;
			}

			// It's always indented 4 extra spaces
			caretIndex = caretIndex - 4;

			// Next line going backwards is the line of code above the caret
			errorLines.pop();

			// this should now be the line number
			lineno = errorLines.pop();
			if (lineno === undefined) {
				return;
			}

			match = lineno.match(linenoRE);
			if (match === null) {
				// can't figure out the format, give up
				return;
			}
			// found a line number here for the syntax error
			// match[0] is entire 'line N' match, match[1] is just the number N
			lineNumber = +match[1];
			colStart = this.firstNonWhitespaceCol(lineNumber) + caretIndex;
			if (colStart < 1) {
				colStart = 1;
			}
			colEnd = colStart + 1;

			// expand by one on each side to make it easier to see
			colStart = colStart - 1;
			colEnd = colEnd + 1;

		}
		let range = new Range(lineNumber, colStart, lineNumber, colEnd);
		let options = { className: 'squiggly-error', hoverMessage: new MarkdownString(description) };
		this._errorDecorationID = this.addDecoration(range, options);
	}

	private clearError() {
		this._showErrorDelay.cancel();
		if (this._errorDecorationID !== null) {
			this.removeDecoration(this._errorDecorationID);
			this._errorDecorationID = null;
		}
	}

	public getProgram(): string {
		let lines = this.getModelForce().getLinesContent();
		this.removeSeeds(lines);
		return lines.join('\n');
	}

	public async runProgram(): Promise<[string, string, any?]> {
		const program = this.getProgram();

		if (this.pythonProcess !== undefined) {
			this.pythonProcess.kill();
		}

		this.logger.projectionBoxUpdateStart(program);
		this.pythonProcess = this.utils.runProgram(program);

		let runResults: RunResult = await this.pythonProcess;
		const outputMsg = runResults.stdout;
		const errorMsg = runResults.stderr;
		const exitCode = runResults.exitCode;
		const result = runResults.result;

		if (!result) {
			console.error('runProgram() process returned: ', runResults);
			return [outputMsg, errorMsg];
		}

		this.logger.projectionBoxUpdateEnd(result);

		// onExit renders enough delay to update the positioning of the boxes
		this.updateMaxPixelCol();

		// When exitCode === null, it means the process was killed,
		// so there is nothing else to do
		if (exitCode === null) {
			return [outputMsg, errorMsg];
		}

		this.pythonProcess = undefined;

		return [outputMsg, errorMsg, JSON.parse(result!)];
	}

	public async updateBoxes(e?: IModelContentChangedEvent, outputVars?: string[], prevEnvs?: Map<number, any>): Promise<any> {

		if (!this.enabled) {
			// We shouldn't change anything. Just return the results
			return;
		}

		function runImmediately(e?: IModelContentChangedEvent): boolean {
			if (e === undefined) {
				return true;
			}
			// We run immediately when any of the changes span multi-lines.
			// In this case, we will be either removing or adding projection boxes,
			// and we want to process this change immediately.
			for (let i = 0; i < e.changes.length; i++) {
				let change = e.changes[i];
				if (change.range.endLineNumber - change.range.startLineNumber > 0) {
					return true;
				}
				if (change.text.split('\n').length > 1) {
					return true;
				}
			}
			// we get here only if all changes are a single line at a time, and do not introduce new lines
			return false;
		}

		// avoid creating projection boxes/panels for the built-in output panel
		if (!this.isTextEditor()) {
			return;
		}

		this.padBoxArray();
		this.addRemoveBoxes(e);

		let delay: number = this._config.getValue(boxUpdateDelayKey);
		if (runImmediately(e)) {
			delay = 0;
		}

		try {
			// Just delay
			await this.runProgramDelay.run(delay, async () => {});
		} catch (_err) {
			// The timer was cancelled. Just return.
			this._eventEmitter.fire(new BoxUpdateEvent(false, true, false));
			return;
		}

		this._eventEmitter.fire(new BoxUpdateEvent(true, false, false));

		this.hideOutputBox();

		let [outputMsg, errorMsg, parsedResult] = await this.runProgram();
		let returnCode = parsedResult[0];

		this.updateLinesWhenOutOfDate(returnCode, e);

		if (returnCode === 0 || returnCode === 2) {
			this.updateData(parsedResult);
			this.clearError();
		} else {
			this.showErrorWithDelay(returnCode, errorMsg!);
		}

		// Wait for the layout to finish
		await this.updateContentAndLayout(outputVars, prevEnvs);
		this.getOutputBox().setOutAndErrMsg(outputMsg, errorMsg);

		this._eventEmitter.fire(new BoxUpdateEvent(false, false, true));

		return parsedResult;
	}

	private updateData(parsedResult: any) {
		this.writes = parsedResult[1];
		this.envs = parsedResult[2];
	}

	public getEnvAtNextTimeStep(env: any): any | null {
		let result: any | null = null;
		let nextEnvs = this.envs[env.next_lineno];
		if (nextEnvs !== undefined) {
			nextEnvs.forEach((nextEnv) => {
				if (nextEnv.time === env.time + 1) {
					if (result !== null) {
						throw new Error('Should not have more than one next time step');
					}
					result = nextEnv;
				}
			});
		}
		return result;
	}

	public varRemoveInThisBox(varname: string, box: RTVDisplayBox) {
		box.varRemove(varname);
		this.updateContentAndLayout();
	}

	public varRemoveInAllBoxes(varname: string) {
		let removed = new Set<string>();
		this._boxes.forEach((box) => {
			box.varRemove(varname, removed);
		});
		removed.forEach((v) => {
			this._globalDeltaVarSet.delete(v);
		});
		this.updateContentAndLayout();
	}

	public varKeepOnlyInThisBox(varname: string, box: RTVDisplayBox) {
		box.varKeepOnly(varname);
		this.updateContentAndLayout();
	}

	public varKeepOnlyInAllBoxes(varname: string) {
		let removed = new Set<string>();
		let added = new Set<string>();
		this._boxes.forEach((box) => {
			box.varKeepOnly(varname, added, removed);
		});
		removed.forEach((v) => {
			this._globalDeltaVarSet.delete(v);
		});
		added.forEach((v) => {
			this._globalDeltaVarSet.add(v);
		});
		this.updateContentAndLayout();
	}

	public varAddInThisBox(varname: string, box: RTVDisplayBox) {
		box.varAdd(varname);
		this.updateContentAndLayout();
	}

	public varAddInAllBoxes(regExp: string) {
		let added = new Set<string>();
		this._boxes.forEach((box) => {
			box.varAdd(regExp, added);
		});
		if (!this.displayOnlyModifiedVars && (regExp === '*' || regExp === '.*')) {
			this._globalDeltaVarSet.clear();
		} else {
			added.forEach((v) => {
				this._globalDeltaVarSet.add(v);
			});
		}
		this.updateContentAndLayout();
	}

	public varAddAllInThisBox(box: RTVDisplayBox) {
		box.varAddAll();
		this.updateContentAndLayout();
	}

	public varAddAllInAllBoxes() {
		this._boxes.forEach((box) => {
			box.varAddAll();
		});
		this.updateContentAndLayout();
	}

	public hideBox(box: RTVDisplayBox) {
		this._makeNewBoxesVisible = false;
		box.varRemoveAll();
		this.updateContentAndLayout();
	}

	public hideAllOtherBoxes(box: RTVDisplayBox) {
		this._makeNewBoxesVisible = false;
		this._boxes.forEach((b) => {
			if (b !== box) {
				b.varRemoveAll();
			}
		});
		this.updateContentAndLayout();
	}

	public restoreBoxToDefault(box: RTVDisplayBox) {
		box.varRestoreToDefault();
		this.updateContentAndLayout();
	}

	public restoreAllBoxesToDefault() {
		this._makeNewBoxesVisible = true;
		this._globalDeltaVarSet.clear();
		this._boxes.forEach((box) => {
			box.varRestoreToDefault();
		});
		this.updateContentAndLayout();
	}

	public showBoxAtCurrLine() {
		this.getBoxAtCurrLine().varMakeVisible();
		this.updateContentAndLayout();
	}

	public setVisibilityAll() {
		this._visibilityPolicy = visibilityAll;
	}

	public setVisibilityNone() {
		this._visibilityPolicy = visibilityNone;
	}

	public setVisibilityCursor() {
		this._visibilityPolicy = visibilityCursor;
	}

	public setVisibilityCursorAndReturn() {
		this._visibilityPolicy = visibilityCursorAndReturn;
	}

	public setVisibilityRange(startLineNumber: number, endLineNumber: number) {
		this._visibilityPolicy = (b: RTVDisplayBox, cursorLineNumber: number) => (b.lineNumber >= startLineNumber && b.lineNumber <= endLineNumber);
	}

	public flipThroughViewModes() {
		function computeNextViewMode(v: ViewMode) {
			let rs: ViewMode;

			switch (v) {
				case ViewMode.Full:
					rs = ViewMode.CursorAndReturn;
					break;
				case ViewMode.CursorAndReturn:
					rs = ViewMode.Compact;
					break;
				case ViewMode.Compact:
					rs = ViewMode.Stealth;
					break;
				case ViewMode.Stealth:
					rs = ViewMode.Full;
					break;
				default:
					rs = ViewMode.Full;
					break;
			}

			return rs;
		}

		this.changeViewMode(computeNextViewMode(this.viewMode));
	}

	public flipBetweenFullAndCursor() {
		function computeNextViewMode(v: ViewMode) {
			let rs: ViewMode;

			switch (v) {
				case ViewMode.Full:
					rs = ViewMode.CursorAndReturn;
					break;
				case ViewMode.CursorAndReturn:
					rs = ViewMode.Full;
					break;
				default:
					rs = ViewMode.Full;
					break;
			}

			return rs;
		}

		this.changeViewMode(computeNextViewMode(this.viewMode));
	}

	public changeViewMode(m: ViewMode) {

		if (m) {
			this.logger.projectionBoxModeChanged(m.toString());
		}

		this.viewMode = m;
		let editor_div = this._editor.getDomNode();
		if (editor_div !== null && this.isTextEditor()) {
			this.hideOutputBox();
			this.getRunButton().setButtonToRun();
		}
		switch (m) {
			case ViewMode.Full:
				this.setVisibilityAll();
				this.changeToFullView();
				break;
			case ViewMode.CursorAndReturn:
				this.setVisibilityCursorAndReturn();
				this.changeToFullView(1);
				break;
			case ViewMode.Cursor:
				this.setVisibilityCursor();
				this.changeToFullView(1);
				break;
			case ViewMode.Compact:
				this.setVisibilityAll();
				this.changeToCompactView();
				break;
			case ViewMode.Stealth:
				this.setVisibilityNone();
				this.updateLayout();
				setTimeout(() => { this.changeToFullView(); }, 300);
				break;
			case ViewMode.Focused:
				this.setVisibilityAll();
				this.changeToFullView(1);
				break;
		}
	}

	public flipZoom() {
		if (this.zoomLevel === 0) {
			this.zoomLevel = 1;
			this.opacityLevel = 1;
		} else {
			this.zoomLevel = 0;
			this.opacityLevel = 0;
		}
		this.updateLayout();
	}


	public zoomIn() {
		if (this.byRowOrCol === RowColMode.ByCol) {
			let newZoom = this.zoomLevel + 0.1;
			if (newZoom > 1) {
				newZoom = 1;
			}
			this.zoomLevel = newZoom;
			let newOpacity = this.opacityLevel + 0.1;
			if (newOpacity > 1) {
				newOpacity = 1;
			}
			this.opacityLevel = newOpacity;
			this.updateLayout();
		}
	}

	public zoomOut() {
		if (this.byRowOrCol === RowColMode.ByCol) {
			let newZoom = this.zoomLevel - 0.1;
			if (newZoom < 0) {
				newZoom = 0;
			}
			this.zoomLevel = newZoom;
			let newOpacity = this.opacityLevel - 0.1;
			if (newOpacity < 0) {
				newOpacity = 0;
			}
			this.opacityLevel = newOpacity;
			this.updateLayout();
		}
	}

	public changeVars(op?: ChangeVarsOp, where?: ChangeVarsWhere) {
		let text: string;
		let selectionEnd: number;
		let selectionStart: number;

		if (op !== undefined && where !== undefined) {
			text = op;
			if (where === ChangeVarsWhere.All) {
				text = text + '@' + ChangeVarsWhere.All;
			}
			let varNameText = '<VarNameRegExp>';
			text = text + ' ' + varNameText;

			selectionEnd = text.length;
			selectionStart = selectionEnd - varNameText.length;
		} else {
			text = 'add|del|keep [@all] <RegExp>';
			selectionStart = 0;
			selectionEnd = text.length;
		}

		this.getUserInputAndDo(text, selectionStart, selectionEnd, (n: string) => {
			this.runChangeVarsCommand(n);
		});
	}

	private getUserInputAndDo(value: string, selectionStart: number, selectionEnd: number, onEnter: (n: string) => void) {
		let cursorPos = this._editor.getPosition();
		if (cursorPos === null) {
			return;
		}

		let pixelPos = this.getLineColPixelPos(cursorPos);
		//let range = new Range(cursorPos.lineNumber-1, cursorPos.column, cursorPos.lineNumber-1, cursorPos.column + 40);

		let editor_div = this._editor.getDomNode();
		if (editor_div === null) {
			throw new Error('Cannot find Monaco Editor');
		}

		// The following code is adapted from getDomNode in the RenameInputField class
		let domNode = document.createElement('div');

		domNode.className = 'monaco-editor rename-box';

		let input = document.createElement('input');
		input.className = 'rename-input';
		input.type = 'text';
		input.setAttribute('aria-label', localize('renameAriaLabel', 'Rename input. Type new name and press Enter to commit.'));
		domNode.appendChild(input);

		const fontInfo = this._editor.getOption(EditorOption.fontInfo);
		input.style.fontFamily = fontInfo.fontFamily;
		input.style.fontWeight = fontInfo.fontWeight;
		input.style.fontSize = `${fontInfo.fontSize}px`;
		input.value = value;
		input.selectionStart = selectionStart;
		input.selectionEnd = selectionEnd;
		input.size = value.length;

		let theme = this._themeService.getColorTheme();
		const widgetShadowColor = theme.getColor(widgetShadow);
		domNode.style.backgroundColor = String(theme.getColor(editorWidgetBackground) ?? '');
		domNode.style.boxShadow = widgetShadowColor ? ` 0 2px 8px ${widgetShadowColor}` : '';
		domNode.style.color = String(theme.getColor(inputForeground) ?? '');

		domNode.style.position = 'absolute';
		domNode.style.top = pixelPos.top + 'px';
		domNode.style.left = pixelPos.left + 'px';

		input.style.backgroundColor = String(theme.getColor(inputBackground) ?? '');
		const border = theme.getColor(inputBorder);
		input.style.borderWidth = border ? '1px' : '0px';
		input.style.borderStyle = border ? 'solid' : 'none';
		input.style.borderColor = border?.toString() ?? 'none';

		editor_div.appendChild(domNode);

		setTimeout(() => {
			input.focus();
		}, 100);

		input.onkeydown = (e) => {
			if (e.key === 'Enter') {
				onEnter(input.value);
				domNode.remove();
				setTimeout(() => {
					this._editor.focus();
				}, 100);
			} else if (e.key === 'Escape') {
				domNode.remove();
				this._editor.focus();
			}
		};

	}

	private runChangeVarsCommand(cmd: string) {
		let a = cmd.split(/[ ]+/);
		if (a.length === 2) {
			let op = a[0].trim();
			let varName = a[1].trim();
			switch (op) {
				case ChangeVarsOp.Add:
					this.varAddInThisBox(varName, this.getBoxAtCurrLine());
					break;
				case ChangeVarsOp.Add + '@' + ChangeVarsWhere.All:
					this.varAddInAllBoxes(varName);
					break;
				case ChangeVarsOp.Del:
					this.varRemoveInThisBox(varName, this.getBoxAtCurrLine());
					break;
				case ChangeVarsOp.Del + '@' + ChangeVarsWhere.All:
					this.varRemoveInAllBoxes(varName);
					break;
				case ChangeVarsOp.Keep:
					this.varKeepOnlyInThisBox(varName, this.getBoxAtCurrLine());
					break;
				case ChangeVarsOp.Keep + '@' + ChangeVarsWhere.All:
					this.varKeepOnlyInAllBoxes(varName);
					break;
			}
			//console.log(this._globalDeltaVarSet);
		}
	}

	public setVisiblityToSelectionOnly() {
		let selection = this._editor.getSelection();
		if (selection === null) {
			return;
		}

		this.setVisibilityRange(selection.startLineNumber, selection.endLineNumber);
		this.updateLayout();
	}

	private onMouseWheel(e: IMouseWheelEvent) {
		let outputBox = this.getOutputBox();
		if (!(outputBox.isHidden()) && outputBox.mouseOnDiv()) {
			e.stopImmediatePropagation();
			return;
		}
		if (this.loopFocusController !== null) {
			e.stopImmediatePropagation();
			this.scrollLoopFocusIter(e.deltaY);
		}
	}

	private onKeyUp(e: IKeyboardEvent) {
		if (e.keyCode === KeyCode.Escape) {
			if (this.loopFocusController !== null) {
				e.stopPropagation();
				this.stopFocus();
			}
		}
		if (e.keyCode === KeyCode.KEY_P) {
			this._peekCounter = 0;
			if (this._peekTimer !== null) {
				clearTimeout(this._peekTimer);
			}
			if (this.viewMode === ViewMode.Stealth) {
				this.setVisibilityNone();
				this.updateLayout();
			}
		}
	}

	private onKeyDown(e: IKeyboardEvent) {
		if (e.keyCode === KeyCode.Escape) {
			if (this._editor.getSelection()?.isEmpty() === true) {
				this.changeViewMode(this.viewMode);
			} else {
				this.setVisiblityToSelectionOnly();
			}
		}

		if (e.keyCode === KeyCode.KEY_P && e.altKey && e.ctrlKey) { // test this out
			this._peekCounter = this._peekCounter + 1;
			if (this._peekCounter > 1) {
				if (this._peekTimer !== null) {
					clearTimeout(this._peekTimer);
				}
				this._peekTimer = setTimeout(() => {
					this._peekTimer = null;
					this._peekCounter = 0;
					if (this.viewMode === ViewMode.Stealth) {
						this.setVisibilityNone();
						this.updateLayout();
					}
				}, 500);
				if (this._peekCounter === 2) {
					if (this.viewMode === ViewMode.Stealth) {
						this.setVisibilityCursor();
						this.updateLayout();
					}
				}
			}
		}
	}

	// Support for localized live programming

	private removeSeeds(lines: string[]) {
		if (this.loopFocusController !== null) {
			for (let i = 0; i < lines.length; i++) {
				if (lines[i].match('#@') !== null) {
					lines[i] = lines[i].replace(/#@\s*/, '');
				}
			}
		}
	}

	public scrollLoopFocusIter(deltaY: number) {
		if (this.loopFocusController !== null) {
			let iter = this.loopFocusController.iter;
			let box = this.loopFocusController.controllingBox;
			let nextIter = box.getNextLoopIter(box.getLoopID(), iter, deltaY);
			this.loopFocusController = new LoopFocusController(this, box, nextIter);
		}
	}

	private findSeed(lines: string[], currLineNumber: number) {
		let minIndent = Infinity;
		let i = currLineNumber;
		while (i >= 1) {
			let currLine = lines[i - 1];
			if (isSeedLine(currLine)) {
				if (indent(currLine) <= minIndent) {
					return i;
				}
			}
			if (isLoopStr(currLine)) {
				let currIndent = indent(currLine);
				if (currIndent < minIndent) {
					minIndent = currIndent;
				}
			}
			i = i - 1;
		}
		return 0;
	}

	public focusOnLoopWithSeed() {
		let cursorPos = this._editor.getPosition();
		if (cursorPos === null) {
			return;
		}
		let lines = this.getModelForce().getLinesContent();
		let seed = this.findSeed(lines, cursorPos.lineNumber);
		if (seed === 0) {
			this.focusOnLoopAtCurrLine();
		} else {
			let seedBox = this.getBox(seed);
			this.focusOnLoopAtBox(seedBox);
		}
	}

	public focusOnLoopAtCurrLine() {
		this.focusOnLoopAtBox(this.getBoxAtCurrLine());
	}

	public focusOnLoopAtBox(box: RTVDisplayBox) {
		this.loopFocusController = new LoopFocusController(this, box, box.getFirstLoopIter());
		this.updateBoxes();
		this.changeViewMode(ViewMode.Focused);
	}

	public stopFocus() {
		this.loopFocusController = null;
		this.updateBoxes();
		this.changeViewMode(ViewMode.Full);
	}

	public executeEdits(edits: IIdentifiedSingleEditOperation[]) {
		//this.getModelForce().applyEdits(edits);
		this._editor.executeEdits(this.getId(), edits);
	}

	public increaseDelay() {
		const newValue = this._config.getValue(boxUpdateDelayKey) as number + 100;
		console.log(`Setting box update delay to ${newValue}`);
		this._config.updateValue(boxUpdateDelayKey, newValue);
	}

	public decreaseDelay() {
		let val: number = this._config.getValue(boxUpdateDelayKey) as number - 100;

		if (val < 0) {
			val = 0;
		} else if (val > 5000) {
			val = 5000;
		}

		console.log(`Setting box update delay to ${val}`);
		this._config.updateValue(boxUpdateDelayKey, val);
	}
}

registerEditorContribution(RTVController.ID, RTVController);

const boxAlignsToTopOfLineKey = 'rtv.box.alignsToTopOfLine';
const boxBorderKey = 'rtv.box.border';
const byRowOrColKey = 'rtv.box.byRowOrColumn';
const cellPaddingKey = 'rtv.box.cellPadding';
const colBorderKey = 'rtv.box.colBorder';
const displayOnlyModifiedVarsKey = 'rtv.box.displayOnlyModifiedVars';
const opacityKey = 'rtv.box.opacity';
const showBoxAtLoopStmtKey = 'rtv.box.showBoxAtLoopStatements';
const showBoxAtEmptyLineKey = 'rtv.box.showBoxAtEmptyLines';
const showBoxWhenNotExecutedKey = 'rtv.box.showBoxWhenNotExecuted';
const spaceBetweenBoxesKey = 'rtv.box.spaceBetweenBoxes';
const zoomKey = 'rtv.box.zoom';
const viewModeKey = 'rtv.viewMode';
const mouseShortcutsKey = 'rtv.box.mouseShortcuts';
const supportSynthesisKey = 'rtv.box.supportSynthesis';
const boxUpdateDelayKey = 'rtv.box.updateDelay';

const configurations: IConfigurationNode = {
	'id': 'rtv',
	'order': 110,
	'type': 'object',
	'title': localize('rtvConfigurationTitle', 'RTV'),
	'properties': {
		[viewModeKey]: {
			'type': 'string',
			'enum': [ViewMode.Full, ViewMode.CursorAndReturn, ViewMode.Compact, ViewMode.Stealth, ViewMode.Custom],
			'enumDescriptions': [
				localize('rtv.viewMode.full', 'All boxes are visible'),
				localize('rtv.viewMode.cursor', 'Boxes are visible at cursor and return'),
				localize('rtv.viewMode.compact', 'All boxes are visible and they are in compact view'),
				localize('rtv.viewMode.stealth', 'All boxes are invisible (hold ctrl to see box at cursor)')
			],
			'default': ViewMode.Full,
			'description': localize('rtv.viewMode', 'Allows you to choose different view modes')
		},
		[boxAlignsToTopOfLineKey]: {
			'type': 'boolean',
			'default': false,
			'description': localize('rtv.boxalignstop', 'Controls whether box aligns to top of line (true: align to top of line; false: align to middle of line )')
		},
		[boxBorderKey]: {
			'type': 'boolean',
			'default': true,
			'description': localize('rtv.boxborder', 'Controls whether boxes have a border')
		},
		[byRowOrColKey]: {
			'type': 'string',
			'enum': [RowColMode.ByCol, RowColMode.ByRow],
			'enumDescriptions': [
				localize('rtv.byRowOrColumn.byCol', 'Each column is a variable'),
				localize('rtv.byRowOrColumn.byRow', 'Each row is a variable')
			],
			'default': RowColMode.ByCol,
			'description': localize('rtv.byroworcol', 'Controls if variables are displayed in rows or columns')
		},
		[cellPaddingKey]: {
			'type': 'number',
			'default': 6,
			'description': localize('rtv.padding', 'Controls padding for each data cell')
		},
		[colBorderKey]: {
			'type': 'boolean',
			'default': false,
			'description': localize('rtv.colborder', 'Controls whether columns in box have a border')
		},
		[displayOnlyModifiedVarsKey]: {
			'type': 'boolean',
			'default': false,
			'description': localize('rtv.modvarsonly', 'Controls whether only modified vars are shown (true: display only mod vars; false: display all vars)')
		},
		[opacityKey]: {
			'type': 'number',
			'default': 0,
			'description': localize('rtv.opacity', 'Controls opacity level (value between 0 and 1; 0: see-through; 1: no see-through)')
		},
		[showBoxAtLoopStmtKey]: {
			'type': 'boolean',
			'default': false,
			'description': localize('rtv.showboxatloop', 'Controls whether boxes are displayed at loop statements')
		},
		[showBoxAtEmptyLineKey]: {
			'type': 'boolean',
			'default': false,
			'description': localize('rtv.showboxatempty', 'Controls whether boxes are displayed at empty lines')
		},
		[showBoxWhenNotExecutedKey]: {
			'type': 'boolean',
			'default': false,
			'description': localize('rtv.showboxwhennotexecuted', 'Controls whether a box is displayed for statements that are not executed')
		},
		[spaceBetweenBoxesKey]: {
			'type': 'number',
			'default': 20,
			'description': localize('rtv.boxspace', 'Controls spacing between boxes')
		},
		[zoomKey]: {
			'type': 'number',
			'default': 0,
			'description': localize('rtv.zoom', 'Controls zoom level (value between 0 and 1; 0 means shrink; 1 means no shrinking)')
		},
		[mouseShortcutsKey]: {
			'type': 'boolean',
			'default': false,
			'description': localize('rtv.mouseshortcuts', 'Controls whether mouse shortcuts are added')
		},
		[supportSynthesisKey]: {
			'type': 'boolean',
			'default': true,
			'description': localize('rtv.supportsynth', 'Controls whether synthesis is supported')
		},
		[boxUpdateDelayKey]: {
			type: 'number',
			default: 100,
			description: localize('rtv.boxupdatedelay', 'Controls the delay (in ms) between a change in the code and the projection boxes updating.')
		}
	}
};

Registry.as<IConfigurationRegistry>(Extensions.Configuration).registerConfiguration(configurations);


class ConfigurationServiceCache {
	private _vals: { [k: string]: any; } = {};
	public onDidUserChangeConfiguration: ((e: IConfigurationChangeEvent) => void) | undefined = undefined;
	constructor(private readonly configurationService: IConfigurationService) {
		this.configurationService.onDidChangeConfiguration((e) => { this.onChangeConfiguration(e); });
	}

	public getValue<T>(key: string): T {
		let result = this._vals[key];

		if (result === undefined) {
			// Read it from the configurations
			result = this.configurationService.getValue(key);
			this._vals[key] = result;
		}

		if (result === undefined) {
			// Read it from the defaults
			result = configurations.properties![key].default;
			this.configurationService.updateValue(key, result);
			this._vals[key] = result;
		}

		return result;
	}

	public updateValue(key: string, value: any) {
		this._vals[key] = value;
		this.configurationService.updateValue(key, value);
	}

	private onChangeConfiguration(e: IConfigurationChangeEvent) {
		e.affectedKeys.forEach((key: string) => {
			if (key.startsWith('rtv')) {
				let v = this.configurationService.getValue(key);
				if (v !== this._vals[key]) {
					this._vals[key] = v;
					if (this.onDidUserChangeConfiguration !== undefined) {
						this.onDidUserChangeConfiguration(e);
					}
				}
			}
		});
	}
}

function createRTVAction(id: string, name: string, key: number, label: string, callback: (c: RTVController) => void) {
	class RTVAction extends EditorAction {
		private _callback: (c: RTVController) => void;
		constructor() {
			super({
				id: id,
				// eslint complains that we shouldn't call `localize` with a non-literal argument.
				// eslint-disable-next-line code-no-unexternalized-strings
				label: label,
				alias: name,
				precondition: undefined,
				// menuOpts: {
				// 	menuId: MenuId.GlobalActivity,
				// 	group: 'navigation',
				// 	order: 1,
				// 	title: localize('rtv.blerg', 'Blerg'),
				// },
				kbOpts: {
					kbExpr: null,
					primary: key,
					weight: KeybindingWeight.EditorCore
				}
			});
			this._callback = callback;
		}
		public run(accessor: ServicesAccessor, editor: ICodeEditor): void {
			let controller = RTVController.get(editor);
			if (controller) {
				this._callback(controller);
			}
		}
	}

	registerEditorAction(RTVAction);
}

// Another way to register keyboard shortcuts. Not sure which is best.
// function registerKeyShortcut(id: string, key: number, callback: (c:RTVController) => void) {
// 	KeybindingsRegistry.registerCommandAndKeybindingRule({
// 		id: id,
// 		weight: KeybindingWeight.EditorCore,
// 		when: undefined,
// 		primary: key,
// 		handler: (accessor, args: any) => {
// 			const codeEditorService = accessor.get(ICodeEditorService);

// 			// Find the editor with text focus or active
// 			const editor = codeEditorService.getFocusedCodeEditor() || codeEditorService.getActiveCodeEditor();
// 			if (!editor) {
// 				return;
// 			}
// 			let controller = RTVController.get(editor);
// 			if (controller) {
// 				callback(controller);
// 			}
// 		}
// 	});
// }

// createRTVAction(
// 	'rtv.flipview',
// 	'Flip View Mode',
// 	KeyMod.Alt | KeyCode.Enter,
// 	localize('rtv.flipview', 'Flip View Mode'),
// 	(c) => {
// 		c.flipThroughViewModes();
// 	}
// );

createRTVAction(
	'rtv.quickflip',
	'Flip Between Full View and Cursor View',
	KeyMod.Alt | KeyCode.Enter,
	localize('rtv.quickflip', 'Flip Between Full View and Cursor View'),
	(c) => {
		c.flipBetweenFullAndCursor();
	}
);

createRTVAction(
	'rtv.fullview',
	'Full View',
	KeyMod.Alt | KeyCode.KEY_1,
	localize('rtv.fullview', 'Full View'),
	(c) => {
		c.changeViewMode(ViewMode.Full);
	}
);

createRTVAction(
	'rtv.cursorview',
	'Cursor and Return View',
	KeyMod.Alt | KeyCode.KEY_2,
	localize('rtv.cursorview', 'Cursor and Return View'),
	(c) => {
		c.changeViewMode(ViewMode.CursorAndReturn);
	}
);

createRTVAction(
	'rtv.compactview',
	'Compact View',
	KeyMod.Alt | KeyCode.KEY_3,
	localize('rtv.compactview', 'Compact View'),
	(c) => {
		c.changeViewMode(ViewMode.Compact);
	}
);

createRTVAction(
	'rtv.stealthview',
	'Stealth View',
	KeyMod.Alt | KeyCode.KEY_4,
	localize('rtv.stealthview', 'Stealth View'),
	(c) => {
		c.changeViewMode(ViewMode.Stealth);
	}
);

createRTVAction(
	'rtv.zoomin',
	'Flip Zoom',
	KeyMod.Alt | KeyCode.US_BACKSLASH,
	localize('rtv.zoomin', 'Flip Zoom'),
	(c) => {
		c.flipZoom();
	}
);

createRTVAction(
	'rtv.changevars',
	'Add/Remove/Keep Vars',
	KeyMod.Alt | KeyCode.Backspace,
	localize('rtv.changevars', 'Add/Remove/Keep Vars'),
	(c) => {
		c.changeVars();
	}
);

createRTVAction(
	'rtv.addVarHere',
	'Add Var to This Box',
	KeyMod.Alt | KeyCode.Insert,
	localize('rtv.addVarHere', 'Add Var to This Box'),
	(c) => {
		c.changeVars(ChangeVarsOp.Add, ChangeVarsWhere.Here);
	}
);

createRTVAction(
	'rtv.addVarEverywhere',
	'Add Var to All Boxes',
	KeyMod.Alt | KeyMod.Shift | KeyCode.Insert,
	localize('rtv.addVarEverywhere', 'Add Var to All Boxes'),
	(c) => {
		c.changeVars(ChangeVarsOp.Add, ChangeVarsWhere.All);
	}
);

createRTVAction(
	'rtv.delVarHere',
	'Delete Var from This Box',
	KeyMod.Alt | KeyCode.Delete,
	localize('rtv.delVarHere', 'Delete Var from This Box'),
	(c) => {
		c.changeVars(ChangeVarsOp.Del, ChangeVarsWhere.Here);
	}
);

createRTVAction(
	'rtv.delVarEverywhere',
	'Delete Var from All Boxes',
	KeyMod.Alt | KeyMod.Shift | KeyCode.Delete,
	localize('rtv.delVarEverywhere', 'Delete Var from All Boxes'),
	(c) => {
		c.changeVars(ChangeVarsOp.Del, ChangeVarsWhere.All);
	}
);

createRTVAction(
	'rtv.keepVarHere',
	'Keep Only Var in This Box',
	KeyMod.Alt | KeyCode.End,
	localize('rtv.keepVarHere', 'Keep Only Var in This Box'),
	(c) => {
		c.changeVars(ChangeVarsOp.Keep, ChangeVarsWhere.Here);
	}
);

createRTVAction(
	'rtv.keepVarEverywhere',
	'Keep Only Var in All Boxes',
	KeyMod.Alt | KeyMod.Shift | KeyCode.End,
	localize('rtv.keepVarEverywhere', 'Keep Only Var in All Boxes'),
	(c) => {
		c.changeVars(ChangeVarsOp.Keep, ChangeVarsWhere.All);
	}
);

createRTVAction(
	'rtv.focusOnLoop',
	'Focus on Loop using Localized Live Programming',
	KeyMod.Alt | KeyCode.US_DOT,
	localize('rtv.focusOnLoop', 'Focus on Loop using Localized Live Programming'),
	(c) => {
		c.focusOnLoopWithSeed();
	}
);

// Not ready yet -- can't figure out how to make these shortcuts
// higher priority than standard VSCode shortcuts
// registerKeyShortcut(
// 	'zzzz',
// 	KeyMod.CtrlCmd | KeyCode.UpArrow,
// 	(c) => {
// 		c.scrollLoopFocusIter(-1);
// 	}
// );

// registerKeyShortcut(
// 	'rtv.ScrollLoopIterDown',
// 	KeyMod.CtrlCmd | KeyCode.DownArrow,
// 	(c) => {
// 		c.scrollLoopFocusIter(1);
// 	}
// );

createRTVAction(
	'rtv.addDelay',
	'Increase the projection box delay',
	KeyMod.Alt | KeyCode.US_EQUAL,
	localize('rtv.addDelay', 'Increase the projection box delay'),
	(c) => {
		c.increaseDelay();
	}
);

createRTVAction(
	'rtv.subDelay',
	'Decrease the projection box delay',
	KeyMod.Alt | KeyCode.US_MINUS,
	localize('rtv.subDelay', 'Decrease the projection box delay'),
	(c) => {
		c.decreaseDelay();
	}
);
