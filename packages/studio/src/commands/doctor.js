import { doctor, scanAssetRefs } from '../doctor.js';

export const name = 'doctor';
export const summary = '分级体检 shared/mirror/lfs/budget/kb/vault(/assets)：degraded 仍 exit 0，fail 才非 0';
export const usage = 'studio doctor [--require shared,kb] [--assets [--write-manifest]] [--out <path>] [--json]';

export async function run({ paths, config, args }) {
  const requireList = String(args.require || '').split(',').map((s) => s.trim()).filter(Boolean);
  const assets = !!args.assets;
  const outPath = args.out || null;
  const writeManifest = !!args['write-manifest'];
  if (assets && writeManifest) {
    // 基线登记：把当前断链写入 .asset-manifest.json 作为 known_debt；
    // 之后门禁判据 = 新增断链 0（存量可见但不判红）。
    const written = scanAssetRefs(paths, { writeManifest: true });
    const { report, exitCode } = await doctor({ paths, config, assets: false, requireList, outPath });
    report.assets = { ...written, baseline_created: true };
    return { exitCode, report: { command: 'doctor', ...report } };
  }
  const { report, exitCode } = await doctor({ paths, config, assets, requireList, outPath });
  return { exitCode, report: { command: 'doctor', ...report } };
}
