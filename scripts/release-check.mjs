#!/usr/bin/env node
/**
 * CLI form of the release gate: run before `git tag` (or wire it into your
 * release script). Audits the package in the given directory (default: cwd):
 *
 *   node scripts/release-check.mjs [packageDir] [--profile <profileDir>]
 *
 * `--profile` adds the L3 composition check (needs dshmarket resolvable from
 * that profile's node_modules, e.g. when the plugin is installed there).
 * Exit code: 0 clean (warnings allowed), 1 on any error-level finding.
 * Requires the built `lib/index.js` (the committed artifact) and js-yaml —
 * both ship with dsh-native-hooks; copying this script into another repo
 * works the same way once that repo builds its own lib.
 */

const args = process.argv.slice(2)
let packageDir
let profileDir
for (let index = 0; index < args.length; index++) {
  if (args[index] === '--profile') {
    profileDir = args[++index]
    continue
  }
  if (args[index]?.startsWith('--')) continue
  packageDir ??= args[index]
}
packageDir ??= process.cwd()

const lib = await import(new URL('../lib/index.js', import.meta.url).href)
if (typeof lib.auditPackage !== 'function') {
  console.error('release-check: built lib does not export auditPackage — rebuild (npm run build)')
  process.exit(2)
}

const result = await lib.auditPackage(packageDir, { profileDir })
for (const finding of result.findings) {
  console.log(`[${finding.level}] ${finding.check}: ${finding.message}`)
}
console.log(result.ok
  ? `OK: ${result.packageName} passes the release gate (${result.findings.length} finding(s), no errors)`
  : `FAIL: ${result.packageName} has error-level findings — fix before tagging`)
process.exit(result.ok ? 0 : 1)
