import * as child_process from "child_process"
import * as fs from "fs"
import { join } from "path"
import { mkdir } from "shelljs"
import { flattenAll } from "./flatten"

export const FLATTEN_BASE_DIR = "./flattened"

enum IncludeOptions {
    LOW = "Low",
    MEDIUM = "Medium",
    HIGH = "High",
}

export async function slither(
    fromDir: string,
    toDir: string,
    filename: string,
    includeOption: IncludeOptions,
    toFilename: string = filename,
): Promise<void> {
    const from = join(fromDir, filename)
    mkdir("-p", toDir)

    let excludeOptions: string
    const excludeLow: string = "--exclude-low"
    const excludeMedium: string = "--exclude-medium"
    const excludeHigh: string = "--exclude-high"
    if (includeOption === IncludeOptions.LOW) {
        excludeOptions = excludeMedium.concat(" ").concat(excludeHigh)
    } else if (includeOption === IncludeOptions.MEDIUM) {
        excludeOptions = excludeLow.concat(" ").concat(excludeHigh)
    } else {
        excludeOptions = excludeLow.concat(" ").concat(excludeMedium)
    }

    const arr = toFilename.split(".")
    arr[0] = arr[0].concat(`-${includeOption}`)
    arr[1] = "txt"
    const outputFileName = arr.join(".")
    const to = join(toDir, outputFileName)

    const cmd = `slither ${from} --exclude-optimization --exclude-informational ${excludeOptions} &> ${to}`
    await new Promise((res, rej) => {
        child_process.exec(cmd, (err, out) => res(out))
    })
    console.log(`${includeOption} impact concerns of ${filename} scanned!`)
}

async function runAll(): Promise<void> {
    // can skip this step if there are already flattened files
    await flattenAll()
    const filesArr = fs.readdirSync("./flattened")

    for (let i = 0; i < filesArr.length; i++) {
        const file = filesArr[i]
        await slither("./flattened", "./slither", file, IncludeOptions.MEDIUM)
        await slither("./flattened", "./slither", file, IncludeOptions.HIGH)
    }
}

// The following steps are required to use this script:
// 1. pip3 install slither-analyzer
// 2. pip3 install solc-select
// 3. solc-select install 0.7.6 (check hardhat.config.ts)
// 4. solc-select use 0.7.6
if (require.main === module) {
    runAll()
        .then(() => process.exit(0))
        .catch(error => {
            console.error(error)
            process.exit(1)
        })
}
