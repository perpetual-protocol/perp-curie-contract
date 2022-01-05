import { MockContract, smockit } from "@eth-optimism/smock"
import { ethers } from "hardhat"
import { BaseToken } from "../../typechain"
import { BandPriceFeed, ChainlinkPriceFeed } from "../../typechain/perp-oracle"

interface BaseTokenFixture {
    baseToken: BaseToken
    chainlinkPriceFeed: ChainlinkPriceFeed
    mockedAggregator: MockContract
    bandPriceFeed: BandPriceFeed
    mockedStdReference: MockContract
}

export async function baseTokenFixture(): Promise<BaseTokenFixture> {
    // ChainlinkPriceFeed
    const aggregatorFactory = await ethers.getContractFactory("TestAggregatorV3")
    const aggregator = await aggregatorFactory.deploy()
    const mockedAggregator = await smockit(aggregator)

    mockedAggregator.smocked.decimals.will.return.with(async () => {
        return 6
    })

    const chainlinkPriceFeedFactory = await ethers.getContractFactory("ChainlinkPriceFeed")
    const chainlinkPriceFeed = (await chainlinkPriceFeedFactory.deploy(mockedAggregator.address)) as ChainlinkPriceFeed

    // BandPriceFeed
    const stdReferenceFactory = await ethers.getContractFactory("TestStdReference")
    const stdReference = await stdReferenceFactory.deploy()
    const mockedStdReference = await smockit(stdReference)

    const baseAsset = "ETH"
    const bandPriceFeedFactory = await ethers.getContractFactory("BandPriceFeed")
    const bandPriceFeed = (await bandPriceFeedFactory.deploy(mockedStdReference.address, baseAsset)) as BandPriceFeed

    const baseTokenFactory = await ethers.getContractFactory("BaseToken")
    const baseToken = (await baseTokenFactory.deploy()) as BaseToken
    await baseToken.initialize("RandomTestToken0", "RandomTestToken0", chainlinkPriceFeed.address)

    return { baseToken, chainlinkPriceFeed, mockedAggregator, bandPriceFeed, mockedStdReference }
}
