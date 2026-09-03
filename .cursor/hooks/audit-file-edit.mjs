#!/usr/bin/env node
/**
 * Cursor afterFileEdit / afterTabFileEdit / postToolUse hook.
 * Audits completed edits and injects additional_context when suppressions slip through.
 */
import { readFileSync } from 'node:fs';
import process from 'node:process';
import console from 'node:console';
import { auditEdits, auditToolInput } from './_suppression.mjs';

function readStdinJson() {
	const text = readFileSync(0, 'utf8').trim();
	if (!text) return {};
	return JSON.parse(text);
}

function buildContext(hit) {
	const fileLabel = hit.filePath || '(unknown file)';
	const snippet = hit.snippet.split('\n').slice(0, 3).join('\n');
	return [
		'**Lint suppression audit:** a recent edit introduced a forbidden change.',
		`- File: \`${fileLabel}\``,
		`- Issue: ${hit.reason}`,
		'Revert the suppression and fix the underlying lint issue. Do not bypass linters.',
		snippet ? `\`\`\`\n${snippet}\n\`\`\`` : '',
	].join('\n');
}

function respondWithContext(context) {
	process.stdout.write(JSON.stringify({ additional_context: context }));
}

function respondEmpty() {
	process.stdout.write('{}');
}

function main() {
	let payload;
	try {
		payload = readStdinJson();
	} catch (error) {
		console.error('[audit-file-edit] invalid stdin JSON:', error);
		respondEmpty();
		return;
	}

	const hookEvent = payload.hook_event_name ?? '';

	if (hookEvent === 'postToolUse') {
		const writeTools = new Set(['Write', 'StrReplace', 'EditNotebook', 'ApplyPatch', 'search_replace', 'TabWrite']);
		if (!writeTools.has(payload.tool_name ?? '')) {
			respondEmpty();
			return;
		}
		const hit = auditToolInput(payload.tool_name, payload.tool_input);
		if (hit) {
			respondWithContext(buildContext(hit));
			return;
		}
		respondEmpty();
		return;
	}

	if (hookEvent === 'afterFileEdit' || hookEvent === 'afterTabFileEdit') {
		const hit = auditEdits(payload.file_path ?? '', payload.edits);
		if (hit) {
			// Documented output is empty for these events; additional_context works in practice
			// and postToolUse above covers the same edits when this path is ignored.
			respondWithContext(buildContext(hit));
			return;
		}
		respondEmpty();
		return;
	}

	respondEmpty();
}

main();
