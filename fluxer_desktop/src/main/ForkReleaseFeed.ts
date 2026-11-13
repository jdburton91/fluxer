// SPDX-License-Identifier: AGPL-3.0-or-later

// Fork patch (jdburton91/fluxer): the fork's desktop builds update from the fork's own GitHub
// releases, never from Fluxer's update feed (which serves the official build and would drop the
// fork's fixes). This file reads the GitHub releases list; it has no Electron imports so it can
// be tested on its own.

export const FORK_REPOSITORY = 'jdburton91/fluxer';
export const FORK_RELEASES_API_URL = `https://api.github.com/repos/${FORK_REPOSITORY}/releases?per_page=50`;
const DESKTOP_TAG_PREFIX = 'desktop-';
const SHA256_DIGEST_PATTERN = /^sha256:([0-9a-f]{64})$/u;

export interface ForkReleaseAsset {
	readonly name: string;
	readonly url: string;
	readonly size: number;
	readonly sha256: string | null;
}

export interface ForkDesktopRelease {
	readonly version: string;
	readonly tag: string;
	readonly pageUrl: string;
	readonly publishedAt: string | null;
	readonly assets: ReadonlyArray<ForkReleaseAsset>;
}

export type ForkDesktopFile = 'appimage' | 'windows-zip';

function isObject(value: unknown): value is Record<string, unknown> {
	return value != null && typeof value === 'object' && !Array.isArray(value);
}

function readAsset(value: unknown): ForkReleaseAsset | null {
	if (!isObject(value)) return null;
	const {name, browser_download_url: url, size, digest, state} = value;
	if (typeof name !== 'string' || typeof url !== 'string') return null;
	if (state != null && state !== 'uploaded') return null;
	const match = typeof digest === 'string' ? SHA256_DIGEST_PATTERN.exec(digest.trim().toLowerCase()) : null;
	return {name, url, size: typeof size === 'number' ? size : 0, sha256: match?.[1] ?? null};
}

function readRelease(value: unknown, isVersion: (version: string) => boolean): ForkDesktopRelease | null {
	if (!isObject(value) || value.draft === true || value.prerelease === true) return null;
	const {tag_name: tag, html_url: pageUrl, published_at: publishedAt, assets} = value;
	if (typeof tag !== 'string' || !tag.startsWith(DESKTOP_TAG_PREFIX) || typeof pageUrl !== 'string') return null;
	const version = tag.slice(DESKTOP_TAG_PREFIX.length);
	if (!isVersion(version)) return null;
	return {
		version,
		tag,
		pageUrl,
		publishedAt: typeof publishedAt === 'string' ? publishedAt : null,
		assets: Array.isArray(assets) ? assets.map(readAsset).filter((asset) => asset != null) : [],
	};
}

// The newest published desktop-<version> release. Drafts, prereleases and the fork's web client
// releases (app-proxy-<version>) are skipped.
export function pickLatestForkDesktopRelease(
	payload: unknown,
	compareVersions: (left: string, right: string) => number,
): ForkDesktopRelease | null {
	if (!Array.isArray(payload)) {
		throw new Error('The fork releases response is not a list');
	}
	const isVersion = (version: string): boolean => {
		try {
			compareVersions(version, version);
			return true;
		} catch {
			return false;
		}
	};
	let latest: ForkDesktopRelease | null = null;
	for (const entry of payload) {
		const release = readRelease(entry, isVersion);
		if (release != null && (latest == null || compareVersions(release.version, latest.version) > 0)) {
			latest = release;
		}
	}
	return latest;
}

// File names come from electron-builder in the fork's jd-desktop workflow, for example
// Fluxer-2026.1111.91559-linux-x86_64.AppImage and Fluxer-2026.1111.91559-portable-win-x64.zip.
export function findForkDesktopAsset(
	release: ForkDesktopRelease,
	file: ForkDesktopFile,
	arch: NodeJS.Architecture,
): ForkReleaseAsset | null {
	const suffix =
		file === 'appimage'
			? `-linux-${arch === 'arm64' ? 'arm64' : 'x86_64'}.AppImage`
			: `-portable-win-${arch === 'arm64' ? 'arm64' : 'x64'}.zip`;
	return release.assets.find((asset) => asset.name.endsWith(suffix)) ?? null;
}
