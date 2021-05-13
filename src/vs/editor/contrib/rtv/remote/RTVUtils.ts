import { IRTVLogger, Utils, RunProcess, RunResult, SynthProcess, SynthResult, SynthProblem } from 'vs/editor/contrib/rtv/RTVInterfaces';
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

enum RequestType {
	RUNPY = 1,
	IMGSUM = 2,
	SNIPPY = 3,
}

abstract class PyodideRequest {
	public id: number = idGen.getId();

	constructor(public type: RequestType) {}
}

class RunpyRequest extends PyodideRequest {
	public name: string;

	constructor(
		public program: string,
		public values?: any
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

class RemoteSynthProcess implements SynthProcess {
	protected _controller = new AbortController();

	async synthesize(problem: SynthProblem): Promise<SynthResult> {
		// First cancel any previous call
		this._controller.abort();

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
	protected _controller: AbortController = new AbortController();

	constructor(
		protected url: string,
		protected body?: string,
		protected method: string = 'POST',
	) {
		this._promise = fetch(
			url,
			{
				method: method,
				body: body,
				signal: this._controller.signal,
				// mode: 'cors',
				headers: headers()
			}).
			then(response => {
				if (response && response.status < 200 || response.status >= 300 || response.redirected) {
					// TODO Error handling
					console.error(response);
				}

				return response.json();
			});
		this._promise.
			catch(err => {
				// TODO Error handling
				console.error(err);
			});
	}

	kill(): boolean {
		this._controller.abort();
		return true;
	}

	then<TResult1>(
		onfulfilled?: ((value: RunResult) => TResult1 | PromiseLike<TResult1>) | undefined | null,
		onrejected?: ((reason: any) => never | PromiseLike<never>) | undefined | null): PromiseLike<TResult1 | never>
	{
		return this._promise.then(onfulfilled, onrejected);
	}

	// WTF?!!
	// then<TResult1>(
	// 	onfulfilled?: ((value: RunResult) => TResult1 | PromiseLike<TResult1>) | undefined | null,
	// 	onrejected?: ((reason: any) => never | PromiseLike<never>) | undefined | null): PromiseLike<TResult1 | never>
	// {
	// 	return this._promise.then(onfulfilled, onrejected);
	// }

	// catch<TResult = never>(
	// 	onrejected?: ((reason: any) => TResult | PromiseLike<TResult>) | undefined | null): Promise<any | TResult> {
	// 	return this._promise.catch(onrejected);
	// }
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
		const url = '/runPy';
		const body = JSON.stringify(new RunpyRequest(program, values));
		return new RemoteRunProcess(url, body);
	}

	runImgSummary(program: string, line: number, varname: string): RunProcess {
		const url = '/imgSummary';
		const body = JSON.stringify(new ImgSumRequest(program, line, varname));
		return new RemoteRunProcess(url, body);
	}

	async validate(input: string): Promise<string | undefined> {
		let rs = fetch(
			'/validate',
			{
				method: 'POST',
				body: input,
				mode: 'same-origin',
				headers: headers()
			}).
			then(response => {
				if (response && response.status < 200 || response.status >= 300 || response.redirected) {
					// TODO Error handling
					console.error(response);
				}

				return response.text();
			});
		rs.catch(err => console.error(err));
		return rs;
	}

	synthesizer(): SynthProcess {
		return this._synthProcess;
	}
}

let utils = new RemoteUtils();
export function getUtils(): Utils {
	return utils;
}
