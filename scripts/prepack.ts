import { asyncExec } from "./helper"

async function main(): Promise<void> {
    await asyncExec("rm -rf artifacts/contracts/test/")
    await asyncExec("rm -rf artifacts/contracts/uniswap/")
    await asyncExec("find artifacts/contracts/ -name '*.dbg.json' -delete")
    await asyncExec("rm -rf contracts/test")
}

if (require.main === module) {
    main()
        .then(() => process.exit(0))
        .catch(error => {
            console.error(error)
            process.exit(1)
        })
}
