import { IEditorContribution } from 'vs/editor/common/editorCommon';
import { ITextModel } from 'vs/editor/common/model';
import { Event } from 'vs/base/common/event';
import { ICodeEditor } from 'vs/editor/browser/editorBrowser';
import { IModelContentChangedEvent } from 'vs/editor/common/model/textModelEvents';

export interface IRTVDisplayBox {
	getCellContent(): { [k: string]: [HTMLElement] };

	/**
	 * Returns the environments displayed in this PB.
	 * The values are not identical to the result of
	 * `runProgram()`, since the box does some post
	 * processing before displaying its `envs`.
	 */
	getEnvs(): any[];

	/**
	 * Return the ID of the HTML <TD> element at the
	 * given row and column.
	 */
	getCellId(varname: string, idx: number): string;

	/**
	 * Return the HTML <TD> element at the given row and column.
	 */
	getCell(varname: string, idx: number): HTMLTableCellElement | null;

	/**
	 * Updates the box's values, destroys the existing
	 * HTML table and recreates it from the new data.
	 *
	 * @param allEnvs Optional. If provided, these values
	 * will be used to update the box. If not, it reads the
	 * `envs` from its `RTVController`.
	 * @param updateInPlace Optional. If `true`, the table
	 * values will be updated in-place, without destroying
	 * the table and rebuilding it from scratch.
	 */
	updateContent(allEnvs?: any[], updateInPlace?: boolean, outputVars?: string[], prevEnvs?: Map<number, any>): void;
}

export class BoxUpdateEvent {
	constructor(
		public isStart: boolean,
		public isCancel: boolean,
		public isFinish: boolean,
	) {}
}

export interface IRTVController extends IEditorContribution {
	// Utility functions for accessing the editor or PB content
	getBox(lineno: number): IRTVDisplayBox;
	getLineContent(lineno: number): string;
	getProgram(): string;
	getModelForce(): ITextModel;
	envs: { [k: string]: any[]; };
	pythonProcess?: RunProcess;
	onUpdateEvent: Event<BoxUpdateEvent>;

	// Functions for running the program
	updateBoxes(e?: IModelContentChangedEvent, outputVars?: string[], prevEnvs?: Map<number, any>): Promise<any>;
	runProgram(): Promise<any>;
	getId(): string;
	byRowOrCol: RowColMode;

	// Disabling the controller
	enable(): void;
	disable(): void;
	isEnabled(): boolean;

	// Misc.
	viewMode: ViewMode;
	changeViewMode(m: ViewMode): void;
}

/**
 * The Logging interface for RTVDisplay.
 */
export interface IRTVLogger {
	// General Projection Boxes
	projectionBoxCreated(): void;
	projectionBoxDestroyed(): void;
	projectionBoxUpdateStart(program: string): void;
	projectionBoxUpdateEnd(result: string | undefined): void;
	projectionBoxModeChanged(mode: string): void;

	// Image Processing
	imgSummaryStart(lineno: number, variable: string): void;
	imgSummaryEnd(result?: string): void;

	// Output Box
	showOutputBox(): void;
	hideOutputBox(): void;

	// LooPy
	synthProcessStart(): void;
	synthStart(varnames: string[], lineno: number): void;
	synthEnd(): void;
	synthSubmit(problem: SynthProblem): void;
	synthResult(result: SynthResult): void;
	synthStdout(msg: string): void;
	synthStderr(msg: string): void;
	synthProcessEnd(): void;
}

export abstract class ARTVLogger implements IRTVLogger {
	constructor(protected readonly editor: ICodeEditor) {};
	protected abstract log(code: string, msg?: string): number;
	protected abstract write(file: string, content: string): void;

	// ---------------------------------------------------------------
	// General Projection Boxes
	// ---------------------------------------------------------------

	public projectionBoxCreated() {
		this.log('projectionBox.created');
	}

	public projectionBoxDestroyed() {
		this.log('projectionBox.destroyed');
	}

	public projectionBoxUpdateStart(program: string): void {
		const id = this.log('projectionBox.update.start');
		this.write(`${id}_program.py`, program);
	}

	public projectionBoxUpdateEnd(result: string | undefined): void {
		const id = this.log('projectionBox.update.end');
		this.write(`${id}_result.json`, result ? result : 'undefined');
	}

	public projectionBoxModeChanged(mode: string): void {
		this.log(`projectionBox.mode.${mode}`);
	}

	// ---------------------------------------------------------------
	// Image Processing
	// ---------------------------------------------------------------

	public imgSummaryStart(lineno: number, variable: string) {
		this.log('img.start',`${lineno},${variable}`);
	}

	public imgSummaryEnd() {
		this.log('img.end');
	}

	// ---------------------------------------------------------------
	// Output Box
	// ---------------------------------------------------------------

	public showOutputBox(): void {
		this.log(`outputBox.show`);
	}

	public hideOutputBox(): void {
		this.log(`outputBox.hide`);
	}

	// ---------------------------------------------------------------
	// Synthesis
	// ---------------------------------------------------------------

	synthProcessStart(): void {
		this.log('synth.process.start')
	}

	synthStart(varnames: string[], lineno: number): void {
		this.log('synth.start', `${varnames},${lineno}`);
	}

	synthEnd(): void {
		this.log('synth.end');
	}

	synthSubmit(problem: SynthProblem): void {
		const id = this.log('synth.submit');
		this.write(`${id}_problem.json`, JSON.stringify(problem, undefined, '\t'));
	}

	synthResult(result: SynthResult): void {
		const id = this.log('synth.result');
		this.write(`${id}_result.json`, JSON.stringify(result, undefined, '\t'));
	}

	synthStdout(msg: string): void {
		this.log('synth.stdout', msg.toString());
	}

	synthStderr(msg: string): void {
		this.log('synth.stderr', msg.toString());
	}

	synthProcessEnd(): void {
		this.log('synth.process.end');
	}
}

export interface Utils {
	readonly EOL: string;
	logger(editor: ICodeEditor): IRTVLogger;
	runProgram(program: string, values?: any): RunProcess;
	runImgSummary(program: string, line: number, varname: string): RunProcess;
	validate(input: string): Promise<string | undefined>;
	synthesizer(): SynthProcess;
}

/**
 * This class is used to return the result of running
 * a run.py or img-summary.py file.
 **/
export class RunResult {
	constructor(
		public readonly stdout: string,
		public readonly stderr: string,
		public readonly exitCode: number | null,
		public readonly result: string | undefined,
	) {}
}

export class SynthResult {
	constructor(
		public id: number,
		public success: boolean,
		public program?: string
	) {}
}

export class SynthProblem {
	public id: number = -1;
	constructor(
		public varNames: string[],
		public previousEnvs: {[t: string]: any},
		public envs: any[]
	) {}
}

/**
 * A "Process" interface that lets us share the API
 * between the local and remote versions of RTVDisplay.
 */
export interface RunProcess extends PromiseLike<RunResult> {
	kill(): boolean;
}

export interface SynthProcess {
	synthesize(problem: SynthProblem): Promise<SynthResult>;
	stop(): boolean;
	connected(): boolean;
}


/**
 * An empty implementation of Process. Can be used in place of the
 * actual process until initial setups are completed. Resolves
 * immediately.
 */
// export class EmptyProcess implements Process {
// 	onExit(_fn: (exitCode: any, result?: string) => void): void {}
// 	onStdout(_fn: (data: any) => void): void {}
// 	onStderr(_fn: (data: any) => void): void {}
// 	toStdin(msg: string): void {}
// 	kill(): void {}
// 	toPromise(): Promise<any> {
// 		return new Promise((resolve) => {
// 			resolve('[]');
// 		});
// 	}
// }

/**
 * The Projection Box view modes.
 */
export enum ViewMode {
	Full = 'Full',
	CursorAndReturn = 'Cursor and Return',
	Cursor = 'Cursor',
	Compact = 'Compact',
	Stealth = 'Stealth',
	Focused = 'Focused',
	Custom = 'Custom'
}

/**
 * Whether 'time' in the projection boxes is
 * displayed as a row or as a column.
 */
export enum RowColMode {
	ByRow = 'By Row',
	ByCol = 'By Col'
}
