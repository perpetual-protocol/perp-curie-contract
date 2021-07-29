import { MockContract, smockit } from "@eth-optimism/smock"
import { ethers } from "hardhat"
import { VirtualToken } from "../../typechain"

interface VirtualTokenFixture {
    virtualToken: VirtualToken
    mockedAggregator: MockContract
}

export async function virtualTokenFixture(): Promise<VirtualTokenFixture> {
    const aggregatorFactory = await ethers.getContractFactory("TestAggregatorV3")
    const aggregator = await aggregatorFactory.deploy()
    const mockedAggregator = await smockit(aggregator)

    mockedAggregator.smocked.decimals.will.return.with(async () => {
        return 6
    })

    const chainlinkPriceFeedFactory = await ethers.getContractFactory("ChainlinkPriceFeed")
    const chainlinkPriceFeed = await chainlinkPriceFeedFactory.deploy(mockedAggregator.address)

    const virtualTokenFactory = await ethers.getContractFactory("VirtualToken")
    const virtualToken = (await virtualTokenFactory.deploy(
        "RandomTestToken0",
        "RandomTestToken0",
        chainlinkPriceFeed.address,
    )) as VirtualToken

    return { virtualToken, mockedAggregator }
}
