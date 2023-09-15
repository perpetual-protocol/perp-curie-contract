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
    log(`# Deploying ClearingHouse Contract to: ${chainId} ...`)

    const clearingHouseConfig = await get("ClearingHouseConfig")
    const vault = await get("Vault")
    const quoteToken = await get("QuoteToken")
    const uniV3Factory = await get("UniswapV3Factory")
    const exchange = await get("Exchange")
    const accountBalance = await get("AccountBalance")
    const insuranceFund = await get("InsuranceFund")

    const collateralManagerContract = await deploy("ClearingHouse", {
        from: deployer,
        args: [],
        log: true,
        proxy: {
            owner: deployer,
            proxyContract: "OpenZeppelinTransparentProxy",
            execute: {
                init: {
                    methodName: "initialize",
                    args: [
                        clearingHouseConfig.address,
                        vault.address,
                        quoteToken.address,
                        uniV3Factory.address,
                        exchange.address,
                        accountBalance.address,
                        insuranceFund.address,
                    ],
                },
            },
        },
    })
    log("# Vault ClearingHouse deployed at address:", collateralManagerContract.address)
    log("#########################")

    if (!isDevelopmentChain(chainId)) {
        verify(collateralManagerContract.address, [])
    }
}

export default deploy
deploy.tags = [Tag.ClearingHouse, Tag.All]
deploy.dependencies = [
    Tag.ClearingHouseConfig,
    Tag.Vault,
    Tag.MarketRegistry,
    Tag.Exchange,
    Tag.AccountBalance,
    Tag.InsuranceFund,
]
deploy.runAtTheEnd = true
