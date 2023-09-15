import { network } from "hardhat"
import { HardhatRuntimeEnvironment } from "hardhat/types"
import { HARDHAT_CHAINID, isDevelopmentChain } from "../helper.hardhat.config"
import { verify } from "../scripts/verify"
import { Tag } from "./tags"

const deploy = async (hre: HardhatRuntimeEnvironment) => {
    const { log, get, deploy } = hre.deployments
    const { deployer } = await hre.getNamedAccounts()
    const chainId = network.config.chainId || HARDHAT_CHAINID
    log("#########################")
    log(`# Deploying AccountBalance Contract to: ${chainId} ...`)

    const orderbook = await get("OrderBook")
    const clearingHouseConfig = await get("ClearingHouseConfig")
    const accountBalanceContract = await deploy("AccountBalance", {
        from: deployer,
        args: [],
        log: true,
        proxy: {
            owner: deployer,
            proxyContract: "OpenZeppelinTransparentProxy",
            execute: {
                init: {
                    methodName: "initialize",
                    args: [orderbook.address, clearingHouseConfig.address],
                },
            },
        },
    })
    log("# AccountBalance contract deployed at address:", accountBalanceContract.address)
    log("#########################")

    if (!isDevelopmentChain(chainId)) {
        verify(accountBalanceContract.address, [])
    }
}

export default deploy
deploy.tags = [Tag.AccountBalance, Tag.All]
deploy.dependencies = [Tag.OrderBook, Tag.ClearingHouseConfig]
