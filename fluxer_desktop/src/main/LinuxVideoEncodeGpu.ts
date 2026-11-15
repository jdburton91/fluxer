// SPDX-License-Identifier: AGPL-3.0-or-later

// Fork patch (jdburton91/fluxer): on Linux PCs where an NVIDIA card does the rendering and built-in
// Intel or AMD graphics is also present, Chromium sends VA-API video work to the NVIDIA card, which
// has no VA-API encoder (nvidia-vaapi-driver only decodes), so screen share falls back to software
// encoding. This points Chromium's VA-API at the built-in graphics instead, which can encode.
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

export interface LinuxVideoEncodeGpuInput {
	renderNodes: ReadonlyArray<RenderNodeInfo>;
	libvaDriverName: string | undefined;
	optOut: boolean;
	renderNodeOverrideAlreadySet: boolean;
	vaDriverAvailable: (driverName: string) => boolean;
}

export type LinuxVideoEncodeGpuPlan =
	| {apply: true; devicePath: string; libvaDriverName: string; vendor: 'intel' | 'amd'}
	| {apply: false; reason: string};

export function planLinuxVideoEncodeGpu(input: LinuxVideoEncodeGpuInput): LinuxVideoEncodeGpuPlan {
	if (input.optOut) return {apply: false, reason: 'opted out'};
	if (input.renderNodeOverrideAlreadySet) return {apply: false, reason: 'render node override already set'};
	const configuredDriver = input.libvaDriverName?.trim().toLowerCase() ?? '';
	if (configuredDriver !== '' && configuredDriver !== 'nvidia') {
		return {apply: false, reason: `LIBVA_DRIVER_NAME is set to ${configuredDriver}`};
	}
	if (!input.renderNodes.some((node) => node.vendorId === PCI_VENDOR_NVIDIA)) {
		return {apply: false, reason: 'no NVIDIA render node'};
	}
	for (const node of input.renderNodes) {
		const candidates = VA_DRIVERS_BY_VENDOR.get(node.vendorId) ?? [];
		const driver = candidates.find((name) => input.vaDriverAvailable(name));
		if (driver) {
			return {
				apply: true,
				devicePath: node.devicePath,
				libvaDriverName: driver,
				vendor: node.vendorId === PCI_VENDOR_INTEL ? 'intel' : 'amd',
			};
		}
	}
	return {apply: false, reason: 'no built-in Intel or AMD graphics with a VA-API driver'};
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

// Must run before the app is ready: the GPU process reads the switch and inherits the environment.
export function applyLinuxVideoEncodeGpu(): void {
	if (process.platform !== 'linux' || isFlatpakRuntime()) return;
	try {
		const plan = planLinuxVideoEncodeGpu({
			renderNodes: readRenderNodes(),
			libvaDriverName: process.env.LIBVA_DRIVER_NAME,
			optOut: process.env[OPT_OUT_ENV] === '1',
			renderNodeOverrideAlreadySet: app.commandLine.hasSwitch(RENDER_NODE_OVERRIDE_SWITCH),
			vaDriverAvailable,
		});
		if (!plan.apply) {
			log.debug('[VideoEncodeGpu] Leaving VA-API on its default device', {reason: plan.reason});
			return;
		}
		app.commandLine.appendSwitch(RENDER_NODE_OVERRIDE_SWITCH, plan.devicePath);
		process.env.LIBVA_DRIVER_NAME = plan.libvaDriverName;
		log.info('[VideoEncodeGpu] Using built-in graphics for VA-API video encoding', {
			devicePath: plan.devicePath,
			libvaDriverName: plan.libvaDriverName,
			vendor: plan.vendor,
		});
	} catch (error) {
		log.warn('[VideoEncodeGpu] Failed to choose a VA-API device', {error});
	}
}
