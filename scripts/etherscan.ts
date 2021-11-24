import hre from "hardhat"
import { NomicLabsHardhatPluginError } from "hardhat/plugins"
import { getContractsInfo } from "./tenderly"

export async function verifyAndPushContract(): Promise<void> {
    const network = hre.network.name
    const contractsInfo = getContractsInfo(network)

    for (const { name, address, args } of contractsInfo) {
        console.log(`Verifying contract ${name} on ${address}`)
        await hre
            .run("verify:verify", {
                address: address,
                constructorArguments: args,
            })
            .catch(e => {
                if (e instanceof NomicLabsHardhatPluginError) {
                    console.error(`NomicLabsHardhatPluginError: ${(e as NomicLabsHardhatPluginError).message}`)
                } else {
                    console.error(e)
                }
            })
    }
}

if (require.main === module) {
    verifyAndPushContract()
        .then(() => process.exit(0))
        .catch(error => {
            console.error(error)
            process.exit(1)
        })
}
