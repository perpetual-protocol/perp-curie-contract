import { asyncExec } from "./helper"

export async function publish(): Promise<void> {
    await asyncExec("npm version patch")

    const packageJson = require("../package.json")
    await asyncExec("git push origin --tags")
    await asyncExec(`gh release create v${packageJson.version} -t "v${packageJson.version}" -F changelog.md`)
}

if (require.main === module) {
    publish()
        .then(() => process.exit(0))
        .catch(error => {
            console.error(error)
            process.exit(1)
        })
}
