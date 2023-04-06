import { MockContract, smockit } from "@eth-optimism/smock"
import { ethers } from "hardhat"
import { BaseToken } from "../../typechain"
import { ChainlinkPriceFeedV3, PriceFeedDispatcher } from "../../typechain/perp-oracle"
import { CACHED_TWAP_INTERVAL } from "../shared/constant"

interface BaseTokenFixture {
    baseToken: BaseToken
    chainlinkPriceFeedV3: ChainlinkPriceFeedV3
    priceFeedDispatcher: PriceFeedDispatcher
    mockedAggregator: MockContract
}

export async function baseTokenFixture(): Promise<BaseTokenFixture> {
    const aggregatorFactory = await ethers.getContractFactory("TestAggregatorV3")
    const aggregator = await aggregatorFactory.deploy()
    const mockedAggregator = await smockit(aggregator)

    mockedAggregator.smocked.decimals.will.return.with(async () => {
        return 6
    })

    const chainlinkPriceFeedV3Factory = await ethers.getContractFactory("ChainlinkPriceFeedV3")
    const chainlinkPriceFeedV3 = (await chainlinkPriceFeedV3Factory.deploy(
        mockedAggregator.address,
        40 * 60, // 40 mins
        CACHED_TWAP_INTERVAL,
    )) as ChainlinkPriceFeedV3

    const priceFeedDispatcherFactory = await ethers.getContractFactory("PriceFeedDispatcher")
    const priceFeedDispatcher = (await priceFeedDispatcherFactory.deploy(
        chainlinkPriceFeedV3.address,
    )) as PriceFeedDispatcher

    const baseTokenFactory = await ethers.getContractFactory("BaseToken")
    const baseToken = (await baseTokenFactory.deploy()) as BaseToken
    await baseToken.initialize("RandomToken0", "RT0", priceFeedDispatcher.address)

    return { baseToken, chainlinkPriceFeedV3, priceFeedDispatcher, mockedAggregator }
}
