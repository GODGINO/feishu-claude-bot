/**
 * ADB application management: install, list, launch.
 */

import { adbExec } from './adb-runner';

export async function adbInstall(apkPath: string, serial?: string): Promise<{ installed: string }> {
  const r = await adbExec(['install', '-r', apkPath], serial, 120_000);
  if (r.code !== 0) throw new Error(r.stderr || `install failed`);
  if (!r.stdout.includes('Success')) {
    throw new Error(`install reported failure: ${r.stdout}`);
  }
  return { installed: apkPath };
}

export async function adbAppList(serial?: string, includeSystem = false): Promise<{ packages: string[] }> {
  const args = ['shell', 'pm', 'list', 'packages'];
  if (!includeSystem) args.push('-3'); // third-party only

  const r = await adbExec(args, serial);
  if (r.code !== 0) throw new Error(r.stderr || `list failed`);

  const packages = r.stdout
    .split('\n')
    .map((line) => line.replace(/^package:/, '').trim())
    .filter(Boolean);

  return { packages };
}

export async function adbAppLaunch(
  packageName: string,
  activity?: string,
  serial?: string,
): Promise<{ launched: string }> {
  let r;
  if (activity) {
    r = await adbExec(['shell', 'am', 'start', '-n', `${packageName}/${activity}`], serial);
  } else {
    // Use monkey to launch by package name (auto-detects launcher activity)
    r = await adbExec(['shell', 'monkey', '-p', packageName, '-c', 'android.intent.category.LAUNCHER', '1'], serial);
  }
  if (r.code !== 0) throw new Error(r.stderr || `launch failed`);
  return { launched: packageName };
}

export async function adbAppForceStop(packageName: string, serial?: string): Promise<{ stopped: string }> {
  const r = await adbExec(['shell', 'am', 'force-stop', packageName], serial);
  if (r.code !== 0) throw new Error(r.stderr || `force-stop failed`);
  return { stopped: packageName };
}
