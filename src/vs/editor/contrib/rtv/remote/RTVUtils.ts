import { IRTVLogger, Utils, RunProcess, RunResult, SynthProcess, SynthResult, SynthProblem, IRTVController } from 'vs/editor/contrib/rtv/RTVInterfaces';
import { RTVLogger } from 'vs/editor/contrib/rtv/RTVLogger';
import { ICodeEditor } from 'vs/editor/browser/editorBrowser';

declare const window: {
	editor: ICodeEditor
};

class IDGenerator {
	private next: number;

	constructor() {
		this.next = 0;
	}

	getId(): number {
		return this.next++;
	}
}

const idGen: IDGenerator = new IDGenerator();

enum ResponseType {
	// Responses related to the running program
	STDOUT = 1,
	STDERR = 2,
	RESULT = 3,
	EXCEPTION = 4,

	// Responses related to the web worker itself
	ERROR = 5,
	LOADED = 6
}

enum RequestType {
	RUNPY = 1,
	IMGSUM = 2,
	SNIPPY = 3,
}

class PyodideWorkerResponse {
	constructor(
		public id: number,
		public type: ResponseType,
		public readonly stdout: string,
		public readonly stderr: string,
		public readonly exitCode: number | null,
		public readonly result: string | undefined) {}
}

abstract class PyodideRequest {
	public id: number = idGen.getId();

	constructor(public type: RequestType) {}
}

class RunpyRequest extends PyodideRequest {
	public name: string;

	constructor(
		public program: string,
		public values?: string
	) {
		super(RequestType.RUNPY);
		this.name = `program_${this.id}.py`;
	}
}

class ImgSumRequest extends PyodideRequest {
	public name: string;
	constructor(
		public content: string,
		public line: number,
		public varname: string
	) {
		super(RequestType.IMGSUM);
		this.name = `imgum_${this.id}.py`;
	}
}

class SnipPyRequest extends PyodideRequest {
	constructor(public readonly action: string,
				public readonly parameter: string) {
		super(RequestType.SNIPPY);
	}
}

class RemoteSynthProcess implements SynthProcess {
	protected _controller = new AbortController();

	async synthesize(problem: SynthProblem): Promise<SynthResult> {
		// First cancel any previous call
		this._controller.abort();
		this._controller = new AbortController();

		return fetch(
			'/synthesize',
			{
				method: 'POST',
				body: JSON.stringify(problem),
				signal: this._controller.signal,
				mode: 'same-origin',
				headers: headers()
			}).
			then(response => {
				if (response && response.status < 200 || response.status >= 300 || response.redirected) {
					// TODO Error handling
					console.error(response);
				}

				return response.json();
			}).
			catch(err => {
				// TODO Error handling
				console.error(err);
			});
	}

	stop(): boolean {
		this._controller.abort();
		return true;
	}

	connected(): boolean {
		return true;
	}
}

function headers(): Headers {
	const headers = new Headers();
	headers.append('Content-Type', 'application/json;charset=UTF-8');

	// We need this for CSRF protection on the server
	const csrfInput = document.getElementById('csrf-parameter') as HTMLInputElement;
	const csrfToken = csrfInput.value;
	const csrfHeaderName = csrfInput.name;
	if (csrfHeaderName) {
		headers.append(csrfHeaderName, csrfToken);
	}

	return headers;
}

class RemoteRunProcess implements RunProcess {
	protected _promise: Promise<RunResult>;
	private resolve: (rs: RunResult) => void = (_: RunResult) => console.error('resolve() called before it was set!');
	private reject: () => void = () => {};
	private id: number;
	private eventListener: (this: Worker, event: MessageEvent) => void;

	constructor(request: PyodideRequest) {
		this.id = request.id;

		this.eventListener = (event: MessageEvent) =>
		{
			let msg: PyodideWorkerResponse = event.data;

			if (msg.id !== this.id) {
				console.error(`Received message for id ${msg.id}, but this process id is ${this.id}.`);
				console.error(msg);
				return;
			}

			switch (msg.type)
			{
				case ResponseType.RESULT:
					this.resolve(msg);
					pyodideWorker.removeEventListener('message', this.eventListener);
					break;
				default:
					console.error('WebWorker message not recognized: ');
					console.error(msg);
					break;
			}
		};

		pyodideWorker.addEventListener('message', this.eventListener);

		this._promise = loadPyodide
			.then(() => {
				// First, make sure resolve and reject are set.
				let rs: Promise<RunResult> = new Promise((resolve, reject) => {
					this.resolve = resolve;
					this.reject = reject;
				});

				// Send the message!
				pyodideWorker.postMessage(request);

				return rs;
			});
	}

	kill(): boolean {
		// TODO _can_ we cancel this?
		this.reject();
		return false;
	}

	then<TResult1>(
		onfulfilled?: ((value: RunResult) => TResult1 | PromiseLike<TResult1>) | undefined | null,
		onrejected?: ((reason: any) => never | PromiseLike<never>) | undefined | null): PromiseLike<TResult1 | never>
	{
		return this._promise.then(onfulfilled, onrejected);
	}
}


class RemoteUtils implements Utils {
	readonly EOL: string = '\n'; // Assuming the server is running on a unix system
	protected _logger?: IRTVLogger;
	protected _synthProcess = new RemoteSynthProcess();

	logger(editor: ICodeEditor): IRTVLogger {
		if (!this._logger) {
			this._logger = new RTVLogger(editor);
		}
		return this._logger;
	}

	runProgram(program: string, values?: any): RunProcess {
		return new RemoteRunProcess(new RunpyRequest(program, JSON.stringify(values)));
	}

	runImgSummary(program: string, line: number, varname: string): RunProcess {
		// TODO Make this feature optional in the web version.
		return new RemoteRunProcess(new ImgSumRequest(program, line, varname));
	}

	async validate(input: string): Promise<string | undefined> {
		let rs = await new RemoteRunProcess(new SnipPyRequest('validate', input));
		return rs.stdout;
	}

	synthesizer(): SynthProcess {
		return this._synthProcess;
	}
}

let utils = new RemoteUtils();
export function getUtils(): Utils {
	return utils;
}

// Start the web worker
const pyodideWorker = new Worker('pyodide/webworker.js');
let resolvePyodide: (value?: unknown) => void;
let loadPyodide = new Promise(resolve => resolvePyodide = resolve);

const pyodideWorkerInitListener = (event: MessageEvent) =>
{
	let msg = event.data as PyodideWorkerResponse;

	if (msg.type === ResponseType.LOADED)
	{
		console.log('Pyodide loaded!');
		resolvePyodide();
		pyodideWorker.removeEventListener('message', pyodideWorkerInitListener);

		const program = window.editor.getModel()!!.getLinesContent().join('\n');
		utils.runProgram(program).then(() =>
		{
			(window.editor.getContribution('editor.contrib.rtv') as IRTVController).runProgram();
			(document.getElementById('spinner') as HTMLInputElement).style.display = 'none';
		});
	}
	else
	{
		console.error('First message from pyodide worker was not a load message!');
		console.error(msg.type);
		console.error(ResponseType.LOADED);
	}
};

pyodideWorker.onerror = console.error;
pyodideWorker.addEventListener('message', pyodideWorkerInitListener);
