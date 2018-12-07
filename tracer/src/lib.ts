import { execFile } from 'child_process'
import { Stats } from 'fs'
import path from 'path'
import { promisify } from 'util'
import npmBundle = require('npm-bundle')
import shell, {ShellString} from 'shelljs'
import tar from 'tar'
import { objectify } from './utils'
import { performance } from 'perf_hooks'

const asyncExecFile = promisify(execFile)
const asyncNpmBundle = promisify(npmBundle)

/**
 * Pulls the specified package from npm and extracts it into the working
 * directory.
 */
export const pullPackage = async (packageName: string): Promise<{packageFile: string, extractedFolder: string}> => {
  const {file: packStdout} = await asyncNpmBundle([packageName, `--ignore-scripts`], {verbose: false})
  const packageFile = packStdout.trim()
  const precontents = new Set(shell.ls())
  await tar.extract({file: packageFile})
  const postcontents = shell.ls()
  const potentialFolderPaths = postcontents.filter(x => !precontents.has(x))
  if (potentialFolderPaths.length > 1)
    throw new Error(`Multiple bundle outputs detected: ${potentialFolderPaths}`)
  return {packageFile, extractedFolder: './' + potentialFolderPaths[0]}
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
