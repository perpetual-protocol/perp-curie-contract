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
    log(`# Deploying Orderbook Contract to: ${chainId} ...`)

    const marketRegistry = await get("MarketRegistry")
    const orderbookContract = await deploy("OrderBook", {
        from: deployer,
        args: [],
        log: true,
        proxy: {
            owner: deployer,
            proxyContract: "OpenZeppelinTransparentProxy",
            execute: {
                init: {
                    methodName: "initialize",
                    args: [marketRegistry.address],
                },
            },
        },
    })
    log("# Orderbook contract deployed at address:", orderbookContract.address)
    log("#########################")

    if (!isDevelopmentChain(chainId)) {
        verify(orderbookContract.address, [])
    }
}

export default deploy
deploy.tags = [Tag.OrderBook, Tag.All]
deploy.dependencies = [Tag.MarketRegistry]
