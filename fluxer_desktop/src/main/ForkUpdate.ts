// SPDX-License-Identifier: AGPL-3.0-or-later

// Fork patch (jdburton91/fluxer): fork builds update themselves from the fork's GitHub releases.
//
// Fluxer's own updater only runs inside its module system, which fork builds turn off so they
// keep the web client built into them. This arms the same update gate (DesktopUpdateGate) with a
// controller that reads the fork's releases, so the tray item, the in-app update notice and
// "Check for updates" all work as upstream intends.
//
// A packaged AppImage downloads a newer release in the background, checks it against the
// SHA-256 digest GitHub lists for the file, and swaps it in place of the running AppImage. The
// running app is untouched (it keeps its open copy); the new version starts at the next launch,
// or at once when the user picks "Update now". Other formats are told about the new release by
// Updater.ts and download it by hand.

import {errorMessage} from '@electron/common/ErrorMessage';
import {createChildLogger} from '@electron/common/Logger';
import {
	type AppImageTarget,
	applyStagedAppImageUpdate,
	stageAppImageUpdate,
	sweepAbandonedAppImageUpdates,
} from '@electron/main/AppImageUpdate';
import {
	armDesktopUpdate,
	checkDesktopUpdateNow,
	type DesktopUpdateCheck,
	publishDesktopUpdateCheck,
} from '@electron/main/DesktopUpdateGate';
import {armDesktopUpdatePoll} from '@electron/main/DesktopUpdatePoll';
import {
	FORK_RELEASES_API_URL,
	type ForkDesktopRelease,
	findForkDesktopAsset,
	pickLatestForkDesktopRelease,
} from '@electron/main/ForkReleaseFeed';
import {relaunchStableLaunchPath} from '@electron/main/LinuxLaunchPath';
import {moduleNetworkFetch} from '@electron/main/ModuleNetworkFetch';
import {compareShellVersions} from '@electron/main/ModuleVersion';
import {resolveShellUpdatePlan, ShellUpdateCapability} from '@electron/main/ShellUpdateCapability';
import {app, net} from 'electron';

const logger = createChildLogger('ForkUpdate');

const RELEASES_CACHE_TTL_MS = 5 * 60_000;
// GitHub allows 60 unauthenticated API requests an hour from one address, so poll hourly rather
// than at Fluxer's 90 second module poll.
const FORK_UPDATE_POLL_PLAN = {intervalMs: 60 * 60_000, jitterRatio: 0.15} as const;
const NO_UPDATE: DesktopUpdateCheck = {shellNewer: false, modulesChanged: false};

let releasesCache: {readonly at: number; readonly release: ForkDesktopRelease | null} | null = null;
let releasesInFlight: Promise<ForkDesktopRelease | null> | null = null;

async function requestLatestForkDesktopRelease(): Promise<ForkDesktopRelease | null> {
	const response = await net.fetch(FORK_RELEASES_API_URL, {
		cache: 'no-store',
		headers: {
			Accept: 'application/vnd.github+json',
			'X-GitHub-Api-Version': '2022-11-28',
			'User-Agent': `Fluxer/${app.getVersion()} (${process.platform}: ${process.arch}) fork-updater`,
		},
	});
	if (!response.ok) {
		throw new Error(`The fork releases request failed: ${response.status}`);
	}
	const release = pickLatestForkDesktopRelease(await response.json(), compareShellVersions);
	releasesCache = {at: Date.now(), release};
	return release;
}

export async function fetchLatestForkDesktopRelease({
	forceRefresh = false,
}: {
	readonly forceRefresh?: boolean;
} = {}): Promise<ForkDesktopRelease | null> {
	const cached = releasesCache;
	if (!forceRefresh && cached != null && Date.now() - cached.at < RELEASES_CACHE_TTL_MS) {
		return cached.release;
	}
	releasesInFlight ??= requestLatestForkDesktopRelease().finally(() => {
		releasesInFlight = null;
	});
	return await releasesInFlight;
}

function isNewerThanRunning(release: ForkDesktopRelease | null): release is ForkDesktopRelease {
	return release != null && compareShellVersions(release.version, app.getVersion()) > 0;
}

class ForkAppImageUpdater {
	private readonly target: AppImageTarget;
	private installedVersion: string | null = null;
	private installing: {readonly version: string; readonly done: Promise<void>} | null = null;

	public constructor(target: AppImageTarget) {
		this.target = target;
	}

	public async check(manual: boolean): Promise<DesktopUpdateCheck> {
		const release = await fetchLatestForkDesktopRelease({forceRefresh: manual});
		if (!isNewerThanRunning(release)) {
			return NO_UPDATE;
		}
		this.install(release).catch((error: unknown) => {
			logger.warn('The fork desktop update did not install in the background, retrying at the next check', {
				version: release.version,
				error: errorMessage(error),
			});
		});
		return {shellNewer: true, modulesChanged: false};
	}

	public async start(): Promise<void> {
		const release = await fetchLatestForkDesktopRelease();
		if (!isNewerThanRunning(release)) {
			publishDesktopUpdateCheck(NO_UPDATE);
			return;
		}
		try {
			await this.install(release);
		} catch (error) {
			logger.error('The fork desktop update failed to install', {version: release.version, error});
			void import('@electron/main/DesktopUpdatePrompt')
				.then(({reportDesktopUpdateFailure}) =>
					reportDesktopUpdateFailure({reason: 'download-failed', detail: errorMessage(error)}),
				)
				.catch((promptError: unknown) => {
					logger.error('Failed to report the fork desktop update failure', promptError);
				});
			return;
		}
		logger.info('Restarting into the fork desktop update', {version: release.version});
		relaunchStableLaunchPath();
		app.quit();
	}

	private isInstalled(version: string): boolean {
		return this.installedVersion != null && compareShellVersions(this.installedVersion, version) >= 0;
	}

	private install(release: ForkDesktopRelease): Promise<void> {
		if (this.isInstalled(release.version)) {
			return Promise.resolve();
		}
		const previous = this.installing;
		if (previous?.version === release.version) {
			return previous.done;
		}
		const done = (async () => {
			await previous?.done.catch(() => {});
			if (this.isInstalled(release.version)) {
				return;
			}
			const asset = findForkDesktopAsset(release, 'appimage', process.arch);
			if (asset == null) {
				throw new Error(`Release ${release.tag} has no AppImage for ${process.arch}`);
			}
			if (asset.sha256 == null) {
				throw new Error(`Release ${release.tag} lists no SHA-256 digest for ${asset.name}`);
			}
			logger.info('Downloading the fork desktop update', {
				version: release.version,
				file: asset.name,
				bytes: asset.size,
			});
			const staged = await stageAppImageUpdate({
				target: this.target,
				url: asset.url,
				expectedSha256: asset.sha256,
				fetchImpl: moduleNetworkFetch,
			});
			applyStagedAppImageUpdate(this.target, staged);
			this.installedVersion = release.version;
			logger.info('Installed the fork desktop update, it starts at the next launch', {
				version: release.version,
				path: this.target.installedPath,
			});
		})();
		const installing = {version: release.version, done};
		this.installing = installing;
		done
			.finally(() => {
				if (this.installing === installing) this.installing = null;
			})
			.catch(() => {});
		return done;
	}
}

let armed = false;

// Called once from the main process when the module system is off (every fork build).
export function armForkDesktopUpdate(): void {
	if (armed) return;
	armed = true;
	const plan = resolveShellUpdatePlan();
	if (plan.capability !== ShellUpdateCapability.SELF_UPDATE || plan.updater !== 'appimage') {
		logger.info('This build cannot replace itself, new fork releases are offered as downloads', {
			capability: plan.capability,
		});
		return;
	}
	try {
		const reclaimed = sweepAbandonedAppImageUpdates(plan.target);
		if (reclaimed.length > 0) {
			logger.info('Reclaimed abandoned AppImage staging directories', {count: reclaimed.length});
		}
	} catch (error) {
		logger.warn('Failed to reclaim abandoned AppImage staging directories', error);
	}
	const updater = new ForkAppImageUpdater(plan.target);
	armDesktopUpdate({
		check: (manual) => updater.check(manual),
		start: () => updater.start(),
	});
	armDesktopUpdatePoll({plan: FORK_UPDATE_POLL_PLAN, check: () => checkDesktopUpdateNow(), logger}, true);
	logger.info('Fork builds update from the fork releases', {path: plan.target.installedPath});
}
