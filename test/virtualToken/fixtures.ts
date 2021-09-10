import { MockContract, smockit } from "@eth-optimism/smock"
import { ethers } from "hardhat"
import { BaseToken, ChainlinkPriceFeed } from "../../typechain"

interface BaseTokenFixture {
    baseToken: BaseToken
    mockedAggregator: MockContract
}

export async function baseTokenFixture(): Promise<BaseTokenFixture> {
    const aggregatorFactory = await ethers.getContractFactory("TestAggregatorV3")
    const aggregator = await aggregatorFactory.deploy()
    const mockedAggregator = await smockit(aggregator)

    mockedAggregator.smocked.decimals.will.return.with(async () => {
        return 6
    })

    const chainlinkPriceFeedFactory = await ethers.getContractFactory("ChainlinkPriceFeed")
    const chainlinkPriceFeed = (await chainlinkPriceFeedFactory.deploy()) as ChainlinkPriceFeed
    await chainlinkPriceFeed.initialize(mockedAggregator.address)

    const baseTokenFactory = await ethers.getContractFactory("BaseToken")
    const baseToken = (await baseTokenFactory.deploy()) as BaseToken
    await baseToken.initialize("RandomTestToken0", "RandomTestToken0", chainlinkPriceFeed.address)

    return { baseToken, mockedAggregator }
}
