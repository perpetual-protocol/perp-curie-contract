import { network } from "hardhat"
import { HardhatRuntimeEnvironment } from "hardhat/types"
import { HARDHAT_CHAINID, isDevelopmentChain } from "../helper.hardhat.config"
import { verify } from "../scripts/verify"
import { Tag } from "./tags"

const deploy = async (hre: HardhatRuntimeEnvironment) => {
    const { log, deploy } = hre.deployments
    const { deployer } = await hre.getNamedAccounts()
    const chainId = network.config.chainId || HARDHAT_CHAINID

    log("#########################")
    log(`# Deploying DelegateApproval Contract to: ${chainId} ...`)

    const delegateApprovalContract = await deploy("DelegateApproval", {
        from: deployer,
        args: [],
        log: true,
        proxy: {
            owner: deployer,
            proxyContract: "OpenZeppelinTransparentProxy",
            execute: {
                init: {
                    methodName: "initialize",
                    args: [],
                },
            },
        },
    })

    log("# DelegateApproval contract deployed at address:", delegateApprovalContract.address)
    log("#########################")

    if (!isDevelopmentChain(chainId)) {
        verify(delegateApprovalContract.address, [])
    }
}

export default deploy
deploy.tags = [Tag.DelegateApproval, Tag.All]
