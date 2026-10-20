#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const OS_REPO = 'aiverse-filmmakers/AI-Verse-OS';
const DISTRIBUTION_CATALOG = 'aiverse-filmmakers/ai-verse-distribution';
const CATALOG_ROOT = `https://raw.githubusercontent.com/${DISTRIBUTION_CATALOG}/main/src/aiverse_distribution/catalog`;
const DEFAULT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SHA40 = /^[a-f0-9]{40}$/;

function commandResult(command, args, timeout = 10_000) {
  const result = spawnSync(command, args, { encoding: 'utf8', shell: false, timeout, windowsHide: true });
  if (result.error || result.status !== 0) return null;
  try {
    const value = JSON.parse(result.stdout || '');
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

function readLocalDescriptor(root) {
  const file = path.join(root, 'release', 'component-release.json');
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink()) return null;
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (data.component_id !== 'ai-verse-os') return null;
    return {
      version: typeof data.version === 'string' ? data.version : null,
      revision: typeof data.revision === 'string' && SHA40.test(data.revision) ? data.revision : null,
    };
  } catch {
    return null;
  }
}

function distributionState(run) {
  const status = run('aiverse', ['status', '--json']);
  const os = status?.components?.['ai-verse-os'];
  const revision = typeof os?.revision === 'string' && SHA40.test(os.revision) ? os.revision : null;
  if (!status || !revision || !status.release_set_id) return null;
  const plan = run('aiverse', ['update', '--plan', '--json']);
  return {
    releaseSet: status.release_set_id,
    revision,
    state: typeof os.state === 'string' ? os.state : 'unknown',
    updatePlan: plan && typeof plan.to === 'string' ? plan : null,
    root: typeof status.root === 'string' ? status.root : null,
  };
}

async function getJson(url, fetchImpl) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8_000);
  try {
    const response = await fetchImpl(url, {
      headers: { accept: 'application/json', 'cache-control': 'no-cache' },
      redirect: 'error',
      signal: controller.signal,
    });
    if (!response?.ok) throw new Error(`HTTP ${response?.status ?? 'unavailable'}`);
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

function findRelease(releaseId, ...catalogs) {
  for (const catalog of catalogs) {
    const release = catalog?.release_sets?.find((item) => item?.id === releaseId);
    if (release) return release;
  }
  return null;
}

async function latestAcceptedCore(fetchImpl) {
  const promotions = await getJson(`${CATALOG_ROOT}/core_promotions.json`, fetchImpl);
  const lineage = await getJson(`${CATALOG_ROOT}/core_lineage.json`, fetchImpl);
  const releaseSets = await getJson(`${CATALOG_ROOT}/release_sets.json`, fetchImpl);
  const releaseId = promotions.current_release || lineage.current_release || releaseSets.channels?.core;
  if (typeof releaseId !== 'string' || !releaseId) throw new Error('GitHub has no current Core release pointer');

  const release = findRelease(releaseId, promotions, lineage, releaseSets);
  if (!release || release.status !== 'released' || release.profile !== 'core') {
    throw new Error('GitHub Core release pointer does not identify a released Core set');
  }
  const osComponent = release.components?.find((component) => component?.id === 'ai-verse-os');
  if (!osComponent || !SHA40.test(osComponent.revision || '')) {
    throw new Error('accepted Core release does not pin a valid AI-Verse OS revision');
  }

  const latest = { releaseSet: releaseId, version: null, revision: osComponent.revision, descriptorWarning: null };
  // Release metadata is published after the source commit it describes. A commit
  // cannot contain a descriptor naming its own hash. Prefer immutable metadata
  // when present, then consult the owner's current descriptor with the SAME exact
  // revision check. A newer descriptor can never relabel a different revision.
  const descriptorUrls = [
    `https://raw.githubusercontent.com/${OS_REPO}/${osComponent.revision}/release/component-release.json`,
    `https://raw.githubusercontent.com/${OS_REPO}/main/release/component-release.json`,
  ];
  latest.descriptorWarning = 'the accepted OS version label could not be verified';
  for (const descriptorUrl of descriptorUrls) {
    try {
      const descriptor = await getJson(descriptorUrl, fetchImpl);
      if (
        descriptor.component_id === 'ai-verse-os' &&
        descriptor.revision === osComponent.revision &&
        descriptor.release_status === 'accepted' &&
        typeof descriptor.version === 'string' && descriptor.version
      ) {
        latest.version = descriptor.version;
        latest.descriptorWarning = null;
        break;
      }
    } catch {
      // Keep the exact release/revision report available when metadata is offline.
    }
  }
  return latest;
}

function updateStatus(installed, latest) {
  if (!installed || !latest) return 'unknown';
  if (installed.revision === latest.revision) return 'up-to-date';
  const plannedOsChange = installed.updatePlan?.changes?.some((change) =>
    change.component === 'ai-verse-os' && change.to === latest.revision,
  );
  return installed.updatePlan?.to === latest.releaseSet && plannedOsChange ? 'update-available' : 'unconfirmed';
}

function formatReport(report) {
  const lines = ['AI-Verse OS version'];
  if (report.installed) {
    const label = report.installed.version ? `v${report.installed.version}` : 'version label unavailable';
    lines.push(`Installed: ${label} (OS revision ${report.installed.revision.slice(0, 8)}; Core release ${report.installed.releaseSet})`);
  } else {
    const local = report.localMetadata?.version ? ` Local source metadata: v${report.localMetadata.version}.` : '';
    lines.push(`Installed: couldn't verify a Distribution installation.${local}`);
  }

  if (report.latest) {
    const latestLabel = report.latest.version ? `v${report.latest.version}` : 'version label unavailable';
    lines.push(`Latest accepted: ${latestLabel} (OS revision ${report.latest.revision.slice(0, 8)}; Core release ${report.latest.releaseSet})`);
    if (report.latest.descriptorWarning) lines.push('Note: the accepted OS revision is verified, but its friendly version label is not.');
    if (report.update === 'up-to-date') lines.push('Status: your installed OS version is up to date.');
    else if (report.update === 'update-available') lines.push('Status: an accepted OS update is available through AI-Verse Update.');
    else if (report.update === 'unconfirmed') lines.push('Status: a newer accepted version exists, but your installed updater could not confirm it can apply that release.');
    else lines.push('Status: installed version could not be compared.');
  } else {
    lines.push("Latest accepted: couldn't check GitHub.");
    lines.push('Status: latest version unknown; your local installation was not changed.');
  }
  lines.push(`GitHub check: ${report.checkedAt}`);
  return lines.join('\n');
}

export async function getVersionReport({ root = DEFAULT_ROOT, fetchImpl = globalThis.fetch, run = commandResult, now = () => new Date() } = {}) {
  const checkedAt = now().toISOString();
  const installed = distributionState(run);
  let localMetadata = readLocalDescriptor(root);
  let installedReport = null;
  if (installed) {
    const receiptRootMatches = installed.root && path.resolve(installed.root) === path.resolve(root);
    if (receiptRootMatches) {
      installedReport = {
        releaseSet: installed.releaseSet,
        revision: installed.revision,
        version: localMetadata?.revision === installed.revision ? localMetadata.version : null,
        updatePlan: installed.updatePlan,
      };
    }
  }

  let latest = null;
  let latestError = null;
  try {
    if (typeof fetchImpl !== 'function') throw new Error('network fetch is unavailable');
    latest = await latestAcceptedCore(fetchImpl);
  } catch (error) {
    latestError = error instanceof Error ? error.message : String(error);
  }

  if (installedReport && latest?.version && installedReport.revision === latest.revision) {
    installedReport.version = latest.version;
  }

  const report = {
    installed: installedReport,
    localMetadata,
    latest,
    update: updateStatus(installedReport, latest),
    checkedAt,
    latestError,
  };
  return { ...report, message: formatReport(report) };
}

async function main(argv) {
  const args = [...argv];
  let root = DEFAULT_ROOT;
  let json = false;
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === '--root') {
      if (!args[index + 1]) throw new Error('--root requires a path');
      root = path.resolve(args[++index]);
    } else if (args[index] === '--json') {
      json = true;
    } else {
      throw new Error(`unknown option: ${args[index]}`);
    }
  }
  const report = await getVersionReport({ root });
  if (json) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  else process.stdout.write(`${report.message}\n`);
}

if (process.argv[1] && fs.realpathSync(path.resolve(process.argv[1])) === fs.realpathSync(fileURLToPath(import.meta.url))) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`AI-Verse OS version check failed: ${error.message}\n`);
    process.exitCode = 1;
  });
}
