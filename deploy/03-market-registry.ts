import { smockit } from "@eth-optimism/smock"
import { ethers, network } from "hardhat"
import { HardhatRuntimeEnvironment } from "hardhat/types"
import { HARDHAT_CHAINID, isDevelopmentChain, networkConfigHelper } from "../helper.hardhat.config"
import { verify } from "../scripts/verify"
import { CHAINLINK_AGGREGATOR_DECIMALS } from "../test/shared/constant"
import { UniswapV3Factory } from "../typechain"
import { Tag } from "./tags"

// 2. MarketRegistry -> uniV3Factory.address & quoteToken.address
//    2.1. For each market, we deploy a pair of two virtual tokens (with no real value) and initiate a new Uniswap V3 pool to provide liquidity to.
//       2.1.1. Base token: the virtual underlying asset users are trading for, such as vETH, vBTC
//       2.1.2. Quote token: the counter currency of base token, which is always vUSDC for any base token

const deploy = async (hre: HardhatRuntimeEnvironment) => {
    const { log, deploy } = hre.deployments
    const { deployer } = await hre.getNamedAccounts()
    const chainId = network.config.chainId || HARDHAT_CHAINID
    log("#########################")
    log("# MarketRegistry Contract #")

    // I'm not sure about quote & base token deployment, so I just use USDC & vETH for now
    // Looks like we need to deploy quote & base token for each market
    const quoteTokenAddress = await deployQuoteToken(hre, chainId)
    const baseTokenAddress = await deployBaseToken(chainId)

    const uniV3Factory = await deployUniswapV3Factory(hre)
    log("# Creating pool...")
    await createPool(uniV3Factory, quoteTokenAddress, baseTokenAddress)

    log(`# Deploying MarketRegistry Contract to: ${chainId} ...`)
    // const marketRegistryFactory = await ethers.getContractFactory("MarketRegistry")
    const marketRegistryContract = await deploy("MarketRegistry", {
        from: deployer,
        args: [],
        log: true,
        proxy: {
            owner: deployer,
            proxyContract: "OpenZeppelinTransparentProxy",
            execute: {
                init: {
                    methodName: "initialize",
                    args: [uniV3Factory.address, quoteTokenAddress],
                },
            },
        },
    })
    log("# MarketRegistry contract deployed at address:", marketRegistryContract.address)
    log("#########################")

    if (!isDevelopmentChain(chainId)) {
        verify(marketRegistryContract.address, [])
    }
}

export default deploy
deploy.tags = [Tag.MarketRegistry, Tag.All]

async function deployQuoteToken(hre: HardhatRuntimeEnvironment, chainId: number) {
    if (isDevelopmentChain(chainId)) {
        const { log, deploy } = hre.deployments
        const { deployer } = await hre.getNamedAccounts()
        log("# Deploying QuoteToken...")
        const quoteToken = await deploy("QuoteToken", {
            from: deployer,
            args: [],
            log: true,
            proxy: {
                owner: deployer,
                proxyContract: "OpenZeppelinTransparentProxy",
                execute: {
                    init: {
                        methodName: "initialize",
                        args: ["TestUSDC", "USDC"],
                    },
                },
            },
        })
        log(`# Deployed QuoteToken at address: ${quoteToken.address}`)
        networkConfigHelper[chainId].usdc = quoteToken.address
    }

    return networkConfigHelper[chainId].usdc
}

async function deployBaseToken(chainId: number) {
    let priceFeedAddress
    let aggregatorAddress

    if (isDevelopmentChain(chainId)) {
        console.log("# Deploying TestAggregatorV3...")
        const aggregatorFactory = await ethers.getContractFactory("TestAggregatorV3")
        const aggregator = await aggregatorFactory.deploy()
        const mockedAggregator = await smockit(aggregator)
        mockedAggregator.smocked.decimals.will.return.with(async () => {
            return CHAINLINK_AGGREGATOR_DECIMALS
        })
        aggregatorAddress = mockedAggregator.address
        console.log(`# Deployed TestAggregatorV3 at address: ${aggregatorAddress}}`)
    }

    if (isDevelopmentChain(chainId)) {
        const fortyMinutes = 60 * 40
        const fifteenMinutes = 60 * 15
        console.log("# Deploying ChainlinkPriceFeedV3...")
        const chainlinkPriceFeedV3Factory = await ethers.getContractFactory("ChainlinkPriceFeedV3")
        const chainlinkPriceFeedV3 = await chainlinkPriceFeedV3Factory.deploy(
            aggregatorAddress,
            fortyMinutes,
            fifteenMinutes,
        )
        priceFeedAddress = chainlinkPriceFeedV3.address
        console.log(`# Deployed ChainlinkPriceFeedV3 at address: ${chainlinkPriceFeedV3.address}}`)
    } else {
        priceFeedAddress = networkConfigHelper[chainId].ethusdPriceFeed
    }

    console.log("# Deploying PriceFeedDispatcher...")
    // This one is from perp-curie-contracts
    const priceFeedDispatcherFactory = await ethers.getContractFactory("PriceFeedDispatcher")
    const priceFeedDispatcher = await priceFeedDispatcherFactory.deploy(priceFeedAddress)
    console.log(`# Deployed priceFeedDispatcher at address: ${priceFeedDispatcher.address}}`)

    if (isDevelopmentChain(chainId)) {
        console.log("# Deploying BaseToken...")
        const baseTokenFactory = await ethers.getContractFactory("BaseToken")
        const baseToken = await baseTokenFactory.deploy()
        await baseToken.initialize("VirtualETH", "vETH", priceFeedDispatcher.address)
        console.log(`# Deployed BaseToken at address: ${baseToken.address}}`)
        networkConfigHelper[chainId].veth = baseToken.address
    }

    return networkConfigHelper[chainId].veth
}

async function deployUniswapV3Factory(hre: HardhatRuntimeEnvironment): Promise<UniswapV3Factory> {
    const { log, deploy } = hre.deployments
    const { deployer } = await hre.getNamedAccounts()
    const uniV3Factory = await deploy("UniswapV3Factory", {
        from: deployer,
        args: [],
        log: true,
    })
    log(`# Deployed UniswapV3Factory at address: ${uniV3Factory.address}`)
    const uniV3ContractFactory = await ethers.getContractAt("UniswapV3Factory", uniV3Factory.address)
    const uniV3Contract = uniV3ContractFactory.attach(uniV3ContractFactory.address)
    return uniV3Contract as UniswapV3Factory
}

async function createPool(uniV3Factory: UniswapV3Factory, quoteTokenAddress: string, baseTokenAddress: string) {
    const uniFee = 3000
    console.log(`# With quote token "${quoteTokenAddress}" and base token "${baseTokenAddress}"}`)
    await uniV3Factory.createPool(baseTokenAddress, quoteTokenAddress, uniFee)
    console.log(`# Pool created`)
}
