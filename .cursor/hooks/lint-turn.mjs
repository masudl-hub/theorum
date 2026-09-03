#!/usr/bin/env node
/**
 * Cursor stop / subagentStop hook.
 * Runs full lint, then deno tests for theorum roots. Returns followup_message on failure.
 */
import { readFileSync, constants } from 'node:fs';
import { access, mkdir, open, unlink } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { Buffer } from 'node:buffer';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import console from 'node:console';

/** Must match loop_limit in hooks.json */
const LOOP_LIMIT = 12;

const MAX_OUTPUT_CHARS = 16_000;
const LOCK_DIR = path.join(os.tmpdir(), 'cursor-lint-turn-locks');

function sanitizePath() {
	const skip = ['.cursor-server', '.vscode-server'];
	process.env.PATH = (process.env.PATH ?? '')
		.split(':')
		.filter((entry) => entry && !skip.some((fragment) => entry.includes(fragment)))
		.join(':');
}

async function readStdinJson() {
	const chunks = [];
	for await (const chunk of process.stdin) {
		chunks.push(chunk);
	}
	const text = Buffer.concat(chunks).toString('utf8').trim();
	if (!text) return {};
	return JSON.parse(text);
}

async function readPackageJson(root) {
	const pkgPath = path.join(root, 'package.json');
	try {
		await access(pkgPath, constants.R_OK);
	} catch {
		return null;
	}
	try {
		return JSON.parse(readFileSync(pkgPath, 'utf8'));
	} catch {
		return null;
	}
}

async function hasLintScript(root) {
	const pkg = await readPackageJson(root);
	return typeof pkg?.scripts?.lint === 'string';
}

async function isTheorumTestRoot(root) {
	const pkg = await readPackageJson(root);
	if (!pkg || typeof pkg.scripts?.test !== 'string') return false;
	if (pkg.name === 'theorum') return true;
	try {
		await access(path.join(root, 'deno.json'), constants.R_OK);
		return true;
	} catch {
		return false;
	}
}

function runCommand(root, command, args) {
	return new Promise((resolve) => {
		const child = spawn(command, args, {
			cwd: root,
			env: process.env,
			stdio: ['ignore', 'pipe', 'pipe'],
		});

		let output = '';
		child.stdout.on('data', (chunk) => {
			output += chunk;
		});
		child.stderr.on('data', (chunk) => {
			output += chunk;
		});
		child.on('error', (error) => {
			resolve({ code: 1, output: String(error) });
		});
		child.on('close', (code) => {
			resolve({ code: code ?? 1, output });
		});
	});
}

function runLint(root) {
	return runCommand(root, 'npm', ['run', 'lint']);
}

function runTests(root) {
	return runCommand(root, 'npm', ['run', 'test']);
}

function truncate(text) {
	if (text.length <= MAX_OUTPUT_CHARS) return text;
	return `${text.slice(0, MAX_OUTPUT_CHARS)}\n\n[… output truncated …]`;
}

function focusDiagnostics(output) {
	const lines = output.split('\n');
	const focused = lines.filter((line) => {
		if (/npm warn|deprecated/i.test(line)) return false;
		return /(?:^|\s)(?:error|warning|×|✖|FAIL|FAILED)\b|:\d+:\d+|:\d+\s/.test(line);
	});
	return focused.length > 0 ? focused.join('\n') : output;
}

async function tryAcquireRunLock(payload) {
	const conversationId = payload.conversation_id ?? 'unknown';
	const generationId = payload.generation_id ?? 'unknown';
	await mkdir(LOCK_DIR, { recursive: true });
	const lockPath = path.join(LOCK_DIR, `${conversationId}-${generationId}.lock`);

	try {
		const handle = await open(lockPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY);
		await handle.writeFile(String(process.pid));
		await handle.close();
		return { acquired: true, lockPath };
	} catch {
		return { acquired: false, lockPath: null };
	}
}

async function releaseRunLock(lockPath) {
	if (!lockPath) return;
	try {
		await unlink(lockPath);
	} catch {
		// Another hook instance owns cleanup.
	}
}

function buildFollowup(failures, loopCount) {
	const finalAttempt = loopCount >= LOOP_LIMIT - 1;
	const sections = failures.map(({ root, step, code, output }) => {
		const label = path.basename(root);
		return `### \`${label}\` — ${step} (exit ${code})\n\`\`\`text\n${truncate(focusDiagnostics(output))}\n\`\`\``;
	});

	const body = [
		'**Verification hook failed** after your last turn.',
		`Automatic fix loop: ${loopCount + 1} of ${LOOP_LIMIT}.`,
		'',
		finalAttempt
			? '**Last automatic attempt.** Fix every cited file:line, or ask the user — lint/tests are still failing and auto-fix is exhausted.'
			: 'Fix every reported file:line. Do **not** ignore, suppress, or reconfigure linters to pass.',
		'If a failure is genuinely wrong, ask the user — do not bypass the rule.',
		'When behavior or APIs change, update relevant documentation references before finishing.',
		'',
		...sections,
		'',
		finalAttempt
			? '**Required:** ask the user for help if you cannot fix these failures at the root cause.'
			: '**Required next step:** fix root causes at each cited location, then continue.',
	].join('\n');

	return { followup_message: body };
}

async function main() {
	sanitizePath();

	let payload;
	try {
		payload = await readStdinJson();
	} catch (error) {
		console.error('[lint-turn] invalid stdin JSON:', error);
		process.stdout.write('{}\n');
		return;
	}

	const status = payload.status ?? 'completed';
	if (status === 'aborted') {
		process.stdout.write('{}\n');
		return;
	}

	const loopCount = payload.loop_count ?? 0;
	if (loopCount >= LOOP_LIMIT) {
		console.error(`[lint-turn] loop_limit (${LOOP_LIMIT}) reached — not emitting followup`);
		process.stdout.write('{}\n');
		return;
	}

	const { acquired, lockPath } = await tryAcquireRunLock(payload);
	if (!acquired) {
		console.error('[lint-turn] duplicate hook invocation skipped (multi-root)');
		process.stdout.write('{}\n');
		return;
	}

	try {
		const roots = payload.workspace_roots?.length
			? payload.workspace_roots.map((root) => path.resolve(root))
			: [process.cwd()];

		const lintRoots = [];
		const testRoots = [];
		for (const root of roots) {
			if (await hasLintScript(root)) lintRoots.push(root);
			if (await isTheorumTestRoot(root)) testRoots.push(root);
		}

		if (lintRoots.length === 0 && testRoots.length === 0) {
			process.stdout.write('{}\n');
			return;
		}

		const failures = [];

		for (const root of lintRoots) {
			console.error(`[lint-turn] running npm run lint in ${root}`);
			const result = await runLint(root);
			if (result.code !== 0) {
				failures.push({ root, step: 'lint', code: result.code, output: result.output });
			}
		}

		if (failures.length === 0) {
			for (const root of testRoots) {
				console.error(`[lint-turn] running npm run test in ${root}`);
				const result = await runTests(root);
				if (result.code !== 0) {
					failures.push({ root, step: 'test', code: result.code, output: result.output });
				}
			}
		}

		if (failures.length === 0) {
			process.stdout.write('{}\n');
			return;
		}

		process.stdout.write(`${JSON.stringify(buildFollowup(failures, loopCount))}\n`);
	} finally {
		await releaseRunLock(lockPath);
	}
}

main().catch((error) => {
	console.error('[lint-turn] hook crashed:', error);
	process.stdout.write('{}\n');
});
