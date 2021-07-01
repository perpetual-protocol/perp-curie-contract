import { join } from "path"
import { mkdir, ShellString } from "shelljs"
import { asyncExec } from "./helper"
import { allDeployedContractsNamesAndDirs, ContractNameAndDir } from "./path"

export const FLATTEN_BASE_DIR = "./flattened"

export async function flatten(
    fromDir: string,
    toDir: string,
    filename: string,
    toFilename: string = filename,
): Promise<void> {
    let licenseDeclared = false
    let versionDeclared = false
    let abiV2ExpDeclared = false
    let abiV2Declared = false

    const fromFile = join(fromDir, filename)
    const toFile = join(toDir, toFilename)

    mkdir("-p", toDir)
    const flattened = await asyncExec(`truffle-flattener ${fromFile}`)
    // console.log(flattened)

    const trimmed = flattened.split("\n").filter(line => {
        if (line.indexOf("SPDX-License-Identifier") !== -1) {
            if (!licenseDeclared) {
                licenseDeclared = true
                return true
            } else {
                return false
            }
        } else if (line.indexOf("pragma solidity") !== -1) {
            if (!versionDeclared) {
                versionDeclared = true
                return true
            } else {
                return false
            }
        } else if (line.indexOf("pragma experimental ABIEncoderV2") !== -1) {
            if (!abiV2ExpDeclared) {
                abiV2ExpDeclared = true
                return true
            } else {
                return false
            }
        } else if (line.indexOf("pragma abicoder v2") !== -1) {
            if (!abiV2Declared) {
                abiV2Declared = true
                return true
            } else {
                return false
            }
        } else {
            return true
        }
    })

    ShellString(trimmed.join("\n")).to(toFile)
}

export async function flattenAll() {
    const filesArr: ContractNameAndDir[] = allDeployedContractsNamesAndDirs

    for (let i = 0; i < filesArr.length; i++) {
        const file = filesArr[i]
        await flatten(file.dir, "./flattened", file.name)
    }
}

async function main(): Promise<void> {
    const fileNameAndDir: string = process.argv[2] as string
    // toDir is not necessary, thus placing as the last one
    const toDir: string = (process.argv[3] as string) ? process.argv[3] : "./flattened"

    // split file name and dir
    const arr = fileNameAndDir.split("/")
    const fileName = arr[arr.length - 1]
    arr.splice(arr.length - 1)
    const fromDir = arr.join("/")

    await flatten(fromDir, toDir, fileName)
}

if (require.main === module) {
    main()
        .then(() => process.exit(0))
        .catch(error => {
            console.error(error)
            process.exit(1)
        })
}
