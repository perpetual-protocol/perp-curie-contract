import hre, { ethers } from "hardhat"
import { CONTRACT_FILES, DeploymentsKey } from "../scripts/deploy"

export async function transferOwner(): Promise<void> {
    const { deployments, getNamedAccounts, network } = hre
    const { gnosisSafeAddress } = await getNamedAccounts()
    const deployer = await ethers.getNamedSigner("deployer")
    const contractsToCheck = Object.keys(CONTRACT_FILES)

    if (network.name === "arbitrumRinkeby" || network.name === "rinkeby") {
        contractsToCheck.push(DeploymentsKey.USDC)
    }
    const proxyAdminDeployment = await deployments.get(DeploymentsKey.DefaultProxyAdmin)
    const proxyAdmin = await ethers.getContractAt(proxyAdminDeployment.abi, proxyAdminDeployment.address)

    if ((await proxyAdmin.owner()) === deployer.address) {
        await (await proxyAdmin.transferOwnership(gnosisSafeAddress)).wait()
        console.log("Transfer ProxyAdmin owner")
    }

    for (const deploymentKey of contractsToCheck) {
        try {
            const deployment = await deployments.get(`${deploymentKey}`)
            const contract = await ethers.getContractAt(deployment.abi, deployment.address)
            if ((await contract.owner()) === deployer.address) {
                await (await contract.setOwner(gnosisSafeAddress)).wait()
                console.log(`${deploymentKey} contract.setOwner`)
            }
        } catch (e) {
            if (e.message.includes("owner is not a function")) {
                console.log(`${deploymentKey} is not safeOwnable, skip`)
            } else if (e.error.message.includes("SO_SAC")) {
                console.log(`${deploymentKey} has already set, skip`)
            } else {
                throw e
            }
        }
    }
}

async function main(): Promise<void> {
    await transferOwner()
}

if (require.main === module) {
    main()
        .then(() => process.exit(0))
        .catch(error => {
            console.error(error)
            process.exit(1)
        })
}
