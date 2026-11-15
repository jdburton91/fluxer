// SPDX-License-Identifier: AGPL-3.0-or-later

// Fork patch (jdburton91/fluxer): on Linux PCs where an NVIDIA card does the rendering and built-in
// Intel or AMD graphics is also present, Chromium sends VA-API video work to the NVIDIA card, which
// has no VA-API encoder (nvidia-vaapi-driver only decodes), so screen share falls back to software
// encoding. This points Chromium's VA-API at the built-in graphics instead, which can encode.
//
// Two halves, because Chromium starts its GPU process from a zygote forked before this code runs,
// so the GPU process keeps the environment the app was launched with:
// - the app's own launchers (menu entry, its actions, autostart) start it with LIBVA_DRIVER_NAME
//   set for the built-in graphics (getLinuxVideoEncodeLaunchEnvPrefix);
// - at start, the app adds --render-node-override for that device, but only when the launch
//   environment allows VA-API to use it (LIBVA_DRIVER_NAME unset or already that driver).
// Opt out with FLUXER_DISABLE_IGPU_VIDEO_ENCODE=1, or by passing --render-node-override yourself.

import fs from 'node:fs';
import path from 'node:path';
import {isFlatpakRuntime} from '@electron/main/LinuxSandbox';
import {app} from 'electron';
import log from 'electron-log';

const PCI_VENDOR_NVIDIA = 0x10de;
const PCI_VENDOR_AMD = 0x1002;
const PCI_VENDOR_INTEL = 0x8086;
// VA-API drivers that can encode, in the order to try them.
const VA_DRIVERS_BY_VENDOR: ReadonlyMap<number, ReadonlyArray<string>> = new Map([
	[PCI_VENDOR_INTEL, ['iHD', 'i965']],
	[PCI_VENDOR_AMD, ['radeonsi']],
]);
const RENDER_NODE_OVERRIDE_SWITCH = 'render-node-override';
const OPT_OUT_ENV = 'FLUXER_DISABLE_IGPU_VIDEO_ENCODE';
const DEFAULT_VA_DRIVER_DIRS = [
	'/usr/lib/dri',
	'/usr/lib64/dri',
	'/usr/lib/x86_64-linux-gnu/dri',
	'/usr/lib/aarch64-linux-gnu/dri',
	'/usr/lib/dri-nonfree',
	'/usr/lib/x86_64-linux-gnu/dri-nonfree',
];

export interface RenderNodeInfo {
	devicePath: string;
	vendorId: number;
}

export interface VideoEncodeGpuTargetInput {
	renderNodes: ReadonlyArray<RenderNodeInfo>;
	optOut: boolean;
	vaDriverAvailable: (driverName: string) => boolean;
}

export interface VideoEncodeGpuTarget {
	devicePath: string;
	libvaDriverName: string;
	vendor: 'intel' | 'amd';
}

export type VideoEncodeGpuTargetResult = {target: VideoEncodeGpuTarget} | {target: null; reason: string};

export function findVideoEncodeGpuTarget(input: VideoEncodeGpuTargetInput): VideoEncodeGpuTargetResult {
	if (input.optOut) return {target: null, reason: 'opted out'};
	if (!input.renderNodes.some((node) => node.vendorId === PCI_VENDOR_NVIDIA)) {
		return {target: null, reason: 'no NVIDIA render node'};
	}
	for (const node of input.renderNodes) {
		const candidates = VA_DRIVERS_BY_VENDOR.get(node.vendorId) ?? [];
		const driver = candidates.find((name) => input.vaDriverAvailable(name));
		if (driver) {
			return {
				target: {
					devicePath: node.devicePath,
					libvaDriverName: driver,
					vendor: node.vendorId === PCI_VENDOR_INTEL ? 'intel' : 'amd',
				},
			};
		}
	}
	return {target: null, reason: 'no built-in Intel or AMD graphics with a VA-API driver'};
}

export type RenderNodeOverrideDecision = {apply: true} | {apply: false; reason: string};

export function decideRenderNodeOverride(
	target: VideoEncodeGpuTarget,
	launchLibvaDriverName: string | undefined,
	renderNodeOverrideAlreadySet: boolean,
): RenderNodeOverrideDecision {
	if (renderNodeOverrideAlreadySet) return {apply: false, reason: 'render node override already set'};
	const launchDriver = launchLibvaDriverName?.trim() ?? '';
	if (launchDriver === '' || launchDriver.toLowerCase() === target.libvaDriverName.toLowerCase()) return {apply: true};
	return {
		apply: false,
		reason: `launched with LIBVA_DRIVER_NAME=${launchDriver}; start Fluxer from its menu entry to encode on the built-in graphics`,
	};
}

function readRenderNodes(): Array<RenderNodeInfo> {
	const nodes: Array<RenderNodeInfo> = [];
	let entries: Array<string>;
	try {
		entries = fs.readdirSync('/sys/class/drm').filter((name) => /^renderD\d+$/.test(name));
	} catch {
		return nodes;
	}
	entries.sort((a, b) => Number(a.slice(7)) - Number(b.slice(7)));
	for (const name of entries) {
		try {
			const vendor = fs.readFileSync(path.join('/sys/class/drm', name, 'device', 'vendor'), 'utf8').trim();
			const vendorId = Number.parseInt(vendor, 16);
			const devicePath = path.join('/dev/dri', name);
			if (Number.isFinite(vendorId) && fs.existsSync(devicePath)) nodes.push({devicePath, vendorId});
		} catch {}
	}
	return nodes;
}

function vaDriverAvailable(driverName: string): boolean {
	const configuredDirs = (process.env.LIBVA_DRIVERS_PATH ?? '').split(':').filter((dir) => dir !== '');
	const dirs = configuredDirs.length > 0 ? configuredDirs : DEFAULT_VA_DRIVER_DIRS;
	return dirs.some((dir) => fs.existsSync(path.join(dir, `${driverName}_drv_video.so`)));
}

let cachedTarget: VideoEncodeGpuTargetResult | undefined;

function getVideoEncodeGpuTarget(): VideoEncodeGpuTargetResult {
	if (cachedTarget) return cachedTarget;
	if (process.platform !== 'linux' || isFlatpakRuntime()) {
		cachedTarget = {target: null, reason: 'not a Linux package outside Flatpak'};
		return cachedTarget;
	}
	try {
		cachedTarget = findVideoEncodeGpuTarget({
			renderNodes: readRenderNodes(),
			optOut: process.env[OPT_OUT_ENV] === '1',
			vaDriverAvailable,
		});
	} catch (error) {
		log.warn('[VideoEncodeGpu] Failed to look for built-in graphics', {error});
		cachedTarget = {target: null, reason: 'lookup failed'};
	}
	return cachedTarget;
}

// For the app's own .desktop Exec lines: "env LIBVA_DRIVER_NAME=<driver> " or "".
export function getLinuxVideoEncodeLaunchEnvPrefix(): string {
	const {target} = getVideoEncodeGpuTarget();
	return target ? `env LIBVA_DRIVER_NAME=${target.libvaDriverName} ` : '';
}

// Must run before the app is ready: the GPU process reads the switch from its command line.
export function applyLinuxVideoEncodeGpu(): void {
	const result = getVideoEncodeGpuTarget();
	if (!result.target) {
		log.debug('[VideoEncodeGpu] Leaving VA-API on its default device', {reason: result.reason});
		return;
	}
	const decision = decideRenderNodeOverride(
		result.target,
		process.env.LIBVA_DRIVER_NAME,
		app.commandLine.hasSwitch(RENDER_NODE_OVERRIDE_SWITCH),
	);
	if (!decision.apply) {
		log.info('[VideoEncodeGpu] Not using built-in graphics for video encoding', {reason: decision.reason});
		return;
	}
	app.commandLine.appendSwitch(RENDER_NODE_OVERRIDE_SWITCH, result.target.devicePath);
	log.info('[VideoEncodeGpu] Using built-in graphics for VA-API video encoding', {...result.target});
}
