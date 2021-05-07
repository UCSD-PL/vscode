/* eslint-disable code-import-patterns */
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { spawn, ChildProcessWithoutNullStreams } from 'child_process';
import { Utils, RunResult, IRTVLogger, SynthProblem, SynthResult, SynthProcess, RunProcess } from 'vs/editor/contrib/rtv/RTVInterfaces';
import { RTVLogger } from 'vs/editor/contrib/rtv/RTVLogger';
import { ICodeEditor } from 'vs/editor/browser/editorBrowser';

// Helper functions
export function getOSEnvVariable(v: string): string {
	let result = process.env[v];
	if (result === undefined) {
		throw new Error('OS environment variable ' + v + ' is not defined.');
	}
	return result;
}

const PY3 = getOSEnvVariable('PYTHON3');
const RUNPY = getOSEnvVariable('RUNPY');
const IMGSUM = getOSEnvVariable('IMGSUM');
const SYNTH = getOSEnvVariable('SYNTH');
const JAVA = getOSEnvVariable('JAVA');
const HEAP = process.env['HEAP'];
const SNIPPY_UTILS = getOSEnvVariable('SNIPPY_UTILS');

class LocalRunProcess implements RunProcess {
	protected _reject?: () => void;
	protected _promise: Promise<RunResult> = new Promise(() => {});

	public stdout: string = '';
	public stderr: string = '';

	constructor(
		protected _file: string,
		protected _process: ChildProcessWithoutNullStreams) {
		this._promise = new Promise((resolve, reject) => {
			this._reject = reject;

			this._process.stdout.on('data', (data) => this.stdout += data);
			this._process.stderr.on('data', (data) => this.stderr += data);
			this._process.on('exit', (exitCode) => {
				let result = undefined;
				if (exitCode !== null) {
					result = fs.readFileSync(this._file + '.out').toString();
				}
				resolve(new RunResult(this.stdout, this.stderr, exitCode, result));
			});
		});
	}

	kill(): boolean {
		this._process.kill();
		if (this._reject) {
			this._reject();
			this._reject = undefined;
		}
		return true;
	}

	async then<TResult1 = RunResult, TResult2 = never>(
		onfulfilled?: ((value: RunResult) => TResult1 | PromiseLike<TResult1>) | undefined | null,
		onrejected?: ((reason: any) => TResult2 | PromiseLike<TResult2>) | undefined | null): Promise<TResult1 | TResult2> {
		return this._promise.then(onfulfilled, onrejected);
	}

	async catch<TResult = never>(
		onrejected?: ((reason: any) => TResult | PromiseLike<TResult>) | undefined | null): Promise<any | TResult> {
		return this._promise.catch(onrejected);
	}
}

class LocalSynthProcess implements SynthProcess {
	private _resolve?: (value: SynthResult) => void = undefined;
	private _reject?: () => void = undefined;
	private _problemIdx: number;
	private process: ChildProcessWithoutNullStreams;

	constructor(protected logger?: IRTVLogger) {
		this._problemIdx = -1;

		this.logger?.synthProcessStart();
		if (HEAP) {
			this.process = spawn(JAVA, [`-Xmx${HEAP}`, '-jar', SYNTH]);
		} else {
			this.process = spawn(JAVA, ['-jar', SYNTH]);
		}

		this.process.stdout.on('data', data => this.logger?.synthStdout(data));
		this.process.stderr.on('data', data => this.logger?.synthStderr(data));

		// Set up the listeners we use to communicate with the synth
		this.process.stdout.on('data', (data) => {
			const resultStr = String.fromCharCode.apply(null, data);

			if (this._resolve && this._reject) {
				try {
					// TODO Check result id
					const rs = JSON.parse(resultStr) as SynthResult;
					this._resolve(rs);
					this._resolve = undefined;
					this._reject = undefined;
				} catch (e) {
					console.error('Failed to parse synth output: ' + String.fromCharCode.apply(null, data));
				}
			} else {
				console.error('Synth output when not waiting on promise: ');
				console.error(resultStr);
			}
		});
	}

	public synthesize(problem: SynthProblem): Promise<SynthResult> {
		if (this._reject) {
			this._reject();
			this._resolve = undefined;
			this._reject = undefined;
		}

		// First, create the promise we're returning.
		const rs: Promise<SynthResult> = new Promise((resolve, reject) => {
			this._resolve = resolve;
			this._reject = reject;
		});

		// Then send the problem to the synth
		problem.id = ++this._problemIdx;
		this.process.stdin.write(JSON.stringify(problem) + '\n');

		// And we can return!
		return rs;
	}

	public stop(): boolean {
		if (this._reject) {
			// TODO Actually stop the synthesizer.
			this._reject();
			this._reject = undefined;
			this._resolve = undefined;
			return true;
		}
		return false;
	}

	public dispose() {
		if (this._reject) {
			this._reject();
		}
		this.process?.kill();
	}

	public connected(): boolean {
		return this.process && this.process.connected;
	}
}


class LocalUtils implements Utils {
	readonly EOL: string = os.EOL;
	_logger?: IRTVLogger;
	_synth?: SynthProcess;

	logger(editor: ICodeEditor): IRTVLogger {
		if (!this._logger) {
			this._logger = new RTVLogger(editor);
		}
		return this._logger;
	}

	runProgram(program: string, values?: any): RunProcess {
		const file: string = os.tmpdir() + path.sep + 'tmp.py';
		fs.writeFileSync(file, program);

		let local_process;

		if (values) {
			const values_file: string = os.tmpdir() + path.sep + 'tmp_values.json';
			fs.writeFileSync(values_file, JSON.stringify(values));
			local_process = spawn(PY3, [RUNPY, file, values_file]);
		} else {
			local_process = spawn(PY3, [RUNPY, file]);
		}

		return new LocalRunProcess(file, local_process);
	}

	runImgSummary(program: string, line: number, varname: string): RunProcess {
		const file: string = os.tmpdir() + path.sep + 'tmp.py';
		fs.writeFileSync(file, program);
		const local_process = spawn(PY3, [IMGSUM, file, line.toString(), varname]);
		return new LocalRunProcess(file, local_process);
	}

	async validate(input: string): Promise<string | undefined> {
		return new Promise((resolve, reject) => {
			const process = spawn(SNIPPY_UTILS, ['validate', input]);
			let output: string = '';
			let error: string = '';
			process.stdout.on('data', (data: string) => output += data);
			process.stderr.on('data', (data: string) => error += data);

			process.on('exit', (exitCode: number) => {
				if (exitCode !== 0) {
					reject(error);
				} else {
					resolve(output);
				}
			});
		});
	}

	synthesizer(): SynthProcess {
		if (!this._synth || !this._synth.connected) {
			this._synth = new LocalSynthProcess(this._logger);
		}
		return this._synth;
	}
}

let utils: LocalUtils | undefined = undefined;
export function getUtils(): Utils {
	if (!utils) {
		utils = new LocalUtils();
	}
	return utils;
}
