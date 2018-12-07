import { execFile } from 'child_process'
import { Stats } from 'fs'
import path from 'path'
import { promisify } from 'util'
import shell, {ShellString} from 'shelljs'
import tar from 'tar'
import { objectify } from './utils'
import { performance } from 'perf_hooks'

const asyncExecFile = promisify(execFile)

/**
 * Pulls the specified package from npm and extracts it into the working
 * directory.
 */
export const pullPackage = async (packageName: string): Promise<{packageFile: string, extractedFolder: string}> => {
  const {stdout: packStdout} = await asyncExecFile('npm', ['pack', packageName])
  const packageFile = packStdout.trim()
  const precontents = new Set(shell.ls())
  await tar.extract({file: packageFile})
  const postcontents = shell.ls()
  const potentialFolderPaths = postcontents.filter(x => !precontents.has(x))
  if (potentialFolderPaths.length > 1)
    throw new Error(`Multiple bundle outputs detected: ${potentialFolderPaths}`)
  return {packageFile, extractedFolder: './' + potentialFolderPaths[0]}
}

// Regex to retrieve the number of installed packages from `npm install` stdout
const RE_NUM_PACKAGES = /added (\d+) packages from/

/**
 * Resolve dependencies requested by a packge.json file in a given directory. Effectively,
 * this just runs `npm install` in that directory.
 *
 * NOTE: this will run the install scripts of the package's dependencies
 */
export const resolveDependencies = async (packageDir: string): Promise<{numPackages: number}> => {
  const {stdout} = await asyncExecFile('npm', [
    'install',
    '--no-audit', // Disable running audit checking for the install (uncertain speedup)
    '--no-package-lock', // Don't create a package-lock.json file (uncertain speedup)
    '--only=prod', // Only install prod dependencies (variable ~25% speedup)
    '--legacy-bundling', // Don't deduplicate packages (variable ~10% speedup)
  ], {cwd: packageDir})
  return {
    numPackages: Number((RE_NUM_PACKAGES.exec(stdout) || [])[1]),
  }
}

/**
 * Hooks that a package can register to for auto execution
 */
export type InstallHook = 'preinstall' | 'install' | 'postinstall' | 'preuninstall' | 'uninstall' | 'postuninstall'
export const INSTALL_HOOKS: Array<InstallHook> = [
  'preinstall', 'install', 'postinstall',
  'preuninstall', 'uninstall', 'postuninstall',
]

/**
 * Hooks with registered scripts
 */
export type RegisteredHooks = {
  [k in InstallHook]: string
}

/**
 * List the hooks that a package has registered for, along with the
 * registered actions.
 */
export const listRegisteredHooks = (packageJson: {scripts: object}): RegisteredHooks => {
  return Object.entries(packageJson.scripts || {})
    .filter(([k, v]: [string, string]) => INSTALL_HOOKS.includes(k as any))
    .reduce(objectify, {} as RegisteredHooks)
}

/**
 * Run the provided script with strace attached
 */
export const straceScript = async (
  traceFilePrefix: string,
  scriptCmd: string,
  packageDir: string,
): Promise<{traceFiles: Stats[], stdout: string, stderr: string, runtime: number}> => {
  const start = performance.now()
  const {stdout, stderr} = await asyncExecFile('strace', [
    '-o', traceFilePrefix,
    '-e', 'trace=file,network', // Trace all file and network activity
    '-s8192', // Show 8k output of each trace record
    '-ff', // Follow child processes
    '-ttt', // Print microsecond timestamps with each command
    'sh', '-c', scriptCmd
  ], {
    maxBuffer: 50 * 1024 * 1024, // Max amount of bytes allowed on stdout and stderr
    cwd: packageDir,
  })
  const traceFiles = shell.ls('-l', `${traceFilePrefix}*`) as any as Stats[]
  return {traceFiles, stdout, stderr, runtime: performance.now() - start}
}
