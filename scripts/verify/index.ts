import fs from "fs"
import { NomicLabsHardhatPluginError } from "hardhat/plugins"
import { HardhatRuntimeEnvironment } from "hardhat/types"
import { resolve } from "path"

interface ContractInfo {
    name: string
    address: string
    args?: string[]
}

export function getContractsInfo(network: String, contractName?: string): Array<ContractInfo> {
    // contract has no proxy
    const noProxyContract = [
        "DefaultProxyAdmin",
        "UniswapV3Factory",
        "BTCUSDChainlinkPriceFeed",
        "ETHUSDChainlinkPriceFeed",
    ]

    const contractsInfo = []
    const metadata = `./metadata/${network}.json`
    const jsonStr = fs.readFileSync(resolve(metadata), "utf8")
    const { contracts } = JSON.parse(jsonStr)

    for (const [name] of Object.entries(contracts)) {
        let path

        if (noProxyContract.includes(name)) {
            path = `./deployments/${network}/${name}.json`
        } else {
            path = `./deployments/${network}/${name}_Implementation.json`
        }
        const jsonStr = fs.readFileSync(resolve(path), "utf8")
        const { address, args } = JSON.parse(jsonStr)
        contractsInfo.push({
            name,
            address,
            args,
        })
    }
    if (typeof contractName !== "undefined") {
        return contractsInfo.filter(contract => contract.name == contractName)
    }
    return contractsInfo
}

export async function verifyOnTenderly(hre: HardhatRuntimeEnvironment, contractName?: string): Promise<void> {
    const network = hre.network.name
    const contractsInfo = getContractsInfo(network, contractName)

    for (const { name, address } of contractsInfo) {
        console.log(`verifying contract ${name} on ${address}`)
        await hre.tenderly
            .verify({
                name,
                address,
            })
            .catch(e => {
                console.log(e)
            })
        console.log(`pushing contract ${name}`)
        await hre.tenderly
            .push({
                name,
                address,
            })
            .catch(e => {
                console.log(e)
            })
    }
}

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
