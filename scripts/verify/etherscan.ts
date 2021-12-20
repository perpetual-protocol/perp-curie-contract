import { NomicLabsHardhatPluginError } from "hardhat/plugins"
import { HardhatRuntimeEnvironment } from "hardhat/types"
import { getContractsInfo } from "./tenderly"

export async function verifyOnEtherscan(hre: HardhatRuntimeEnvironment, contractName?: string): Promise<void> {
    const network = hre.network.name
    const contractsInfo = getContractsInfo(network, contractName)

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
