import fs from "fs"
import hre from "hardhat"
import { resolve } from "path"

const exceptionList = ["DefaultProxyAdmin", "UniswapV3Factory", "BTCUSDChainlinkPriceFeed", "ETHUSDChainlinkPriceFeed"]

interface ContractInfo {
    name: string
    address: string
    args: any[]
}

export function getContractsInfo(network: String): Array<ContractInfo> {
    const contractsInfo = []
    const metadata = `./metadata/${network}.json`
    const jsonStr = fs.readFileSync(resolve(metadata), "utf8")
    const { contracts } = JSON.parse(jsonStr)

    for (const [name] of Object.entries(contracts)) {
        let path

        if (exceptionList.includes(name)) {
            path = `./deployments/${network}/${name}.json`
        } else {
            path = `./deployments/${network}/${name}_Implementation.json`
        }
        const jsonStr = fs.readFileSync(resolve(path), "utf8")
        const { address } = JSON.parse(jsonStr)
        contractsInfo.push({
            name,
            address,
        })
    }
    return contractsInfo
}

export async function verifyAndPushContract(): Promise<void> {
    const network = hre.network.name
    const contractsInfo = getContractsInfo(network)

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

if (require.main === module) {
    verifyAndPushContract()
        .then(() => process.exit(0))
        .catch(error => {
            console.error(error)
            process.exit(1)
        })
}
