import { IEditorContribution } from 'vs/editor/common/editorCommon';
import { registerEditorContribution } from 'vs/editor/browser/editorExtensions';
import { ICodeEditor, IEditorMouseEvent } from 'vs/editor/browser/editorBrowser';
import { DelayedRunAtMostOne } from 'vs/editor/contrib/rtv/RTVDisplay';
import { ITextModel } from 'vs/editor/common/model';
import { Process } from 'vs/editor/contrib/rtv/RTVInterfaces';

import * as utils from 'vs/editor/contrib/rtv/RTVUtils';
import { RTVLogger } from 'vs/editor/contrib/rtv/RTVLogger';

class RTVImgDisplayBox {
	private _box: HTMLDivElement;
	constructor(
		private readonly _editor: ICodeEditor,
		html: string,
		top: number,
		left: number
	) {
		let editor_div = this._editor.getDomNode();
		if (editor_div === null) {
			throw new Error('Cannot find Monaco Editor');
		}
		this._box = document.createElement('div');
		this._box.innerHTML = html;
		this._box.style.position = 'absolute';
		this._box.style.top = top + 'px';
		this._box.style.left = left + 'px';
		this._box.className = 'monaco-hover';
		editor_div.appendChild(this._box);
	}

	public destroy() {
		this._box.remove();
	}
}

class RTVImgController implements IEditorContribution {

	public static readonly ID = 'editor.contrib.rtvImgDisplay';
	private _displayImg: DelayedRunAtMostOne = new DelayedRunAtMostOne();
	private _pythonProcess?: Process = undefined;
	private _imgDisplayBox: RTVImgDisplayBox | undefined;
	public logger: RTVLogger;

	constructor(
		private readonly _editor: ICodeEditor,
	) {
		this._editor.onMouseMove(e => this.onMouseMove(e));
		this.logger = utils.getLogger(_editor);
	}

	private onMouseMove(e: IEditorMouseEvent): void {
		if (this._imgDisplayBox) {
			this._imgDisplayBox.destroy();
		}
		this._displayImg.cancel();

		let position = e.target.position;

		if (position === null) {
			return;
		}

		let result = this._editor.getScrolledVisiblePosition(position);
		if (result === null) {
			return;
		}

		let top = result.top + result.height;
		let left = result.left;
		let lineNumber = position.lineNumber;
		let word = this._editor.getConfiguredWordAtPosition(position);

		if (word === null) {
			return;
		}

		let varname = word.word;
		this._displayImg.run(500, () => {
			console.log(`(${e.event.posx},${e.event.posy})`);

			let lines = this.getModelForce().getLinesContent();

			const program = lines.join('\n');

			if (this._pythonProcess !== undefined) {
				this._pythonProcess.kill();
			}

			this.logger.imgSummaryStart();
			let c = utils.runImgSummary(program, lineNumber, varname);
			this._pythonProcess = c;


			c.onExit((exitCode, result) => {
				this.logger.imgSummaryEnd();
				// When exitCode === null, it means the process was killed,
				// so there is nothing else to do
				if (exitCode !== null) {
					this._pythonProcess = undefined;
					if (exitCode === 0 && result !== undefined) {
						if (this._imgDisplayBox) {
							this._imgDisplayBox.destroy();
						}
						this._imgDisplayBox = new RTVImgDisplayBox(this._editor, result,  top, left);
					}
					else {
					}
				}
			});

		});
	}

	public getModelForce(): ITextModel {
		let model = this._editor.getModel();
		if (model === null) {
			throw Error('Expecting a model');
		}
		return model;
	}


	public static get(editor: ICodeEditor): RTVImgController {
		return editor.getContribution<RTVImgController>(RTVImgController.ID);
	}

	public getId(): string {
		return RTVImgController.ID;
	}

	public dispose(): void {
	}

	public restoreViewState(state: any): void {
	}
}

registerEditorContribution(RTVImgController.ID, RTVImgController);
