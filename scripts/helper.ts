import { ExecOptions } from "child_process"
import { resolve } from "path"
import { exec, test } from "shelljs"

export function getNpmBin(cwd?: string) {
    const options: { [key: string]: any } = { silent: true }
    if (cwd) {
        options.cwd = cwd
    }

    return exec("npm bin", options).toString().trim()
}

/**
 * Execute command in in local node_modules directory
 * @param commandAndArgs command with arguments
 */
export function asyncExec(commandAndArgs: string, options?: ExecOptions): Promise<string> {
    const [command, ...args] = commandAndArgs.split(" ")
    const cwd = options ? options.cwd : undefined
    const npmBin = resolve(getNpmBin(cwd), command)
    const realCommand = test("-e", npmBin) ? `${npmBin} ${args.join(" ")}` : commandAndArgs
    console.log(`> ${realCommand}`)
    return new Promise<string>((resolve, reject) => {
        const cb = (code: number, stdout: string, stderr: string) => {
            if (code !== 0) {
                reject(stderr)
            } else {
                resolve(stdout)
            }
        }

        if (options) {
            exec(realCommand, options, cb)
        } else {
            exec(realCommand, cb)
        }
    })
}
