import * as fs from 'node:fs';
import * as path from 'node:path';

/** Written into the extension folder, which VS Code deletes with the extension, so it only ever lists storage that belongs to this installation. */
const MARKER = 'storage-paths.json';

function readMarker(extensionDir: string): string[] {
	try {
		const parsed: unknown = JSON.parse(fs.readFileSync(path.join(extensionDir, MARKER), 'utf8'));
		return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [];
	} catch {
		return [];
	}
}

/** Notes where this installation keeps its global storage, so the uninstall hook can find it. Never throws: a read-only extension folder just means no cleanup. */
export function recordStoragePath(extensionDir: string, storagePath: string): void {
	try {
		const known = readMarker(extensionDir);
		if (!known.includes(storagePath)) {
			fs.writeFileSync(path.join(extensionDir, MARKER), JSON.stringify([...known, storagePath]));
		}
	} catch { /* Cleanup on uninstall is best effort. */ }
}

/** Only a folder named after the extension inside a `globalStorage` folder is deleted, whatever the marker says. */
function isOwnStorage(storagePath: string, extensionId: string): boolean {
	return path.basename(storagePath).toLowerCase() === extensionId.toLowerCase()
		&& path.basename(path.dirname(storagePath)) === 'globalStorage';
}

/** Deletes the global storage recorded by {@link recordStoragePath}; returns the folders removed. Synchronous, as VS Code's uninstall hook requires. */
export function removeRecordedStorage(extensionDir: string, extensionId: string): string[] {
	const removed: string[] = [];
	for (const storagePath of readMarker(extensionDir)) {
		if (!isOwnStorage(storagePath, extensionId)) {
			continue;
		}
		try {
			fs.rmSync(storagePath, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
			removed.push(storagePath);
		} catch { /* Another process may still hold a file; nothing more to do from a hook. */ }
	}
	return removed;
}
