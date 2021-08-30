import { MockContract, smockit } from "@eth-optimism/smock"
import { ethers } from "hardhat"
import { BaseToken, VirtualToken } from "../../typechain"

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
    const chainlinkPriceFeed = await chainlinkPriceFeedFactory.deploy(mockedAggregator.address)

    const baseTokenFactory = await ethers.getContractFactory("BaseToken")
    const baseToken = (await baseTokenFactory.deploy(
        "RandomTestToken0",
        "RandomTestToken0",
        chainlinkPriceFeed.address,
    )) as BaseToken

    return { baseToken, mockedAggregator }
}
