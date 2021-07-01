import { MockContract, smockit } from "@eth-optimism/smock"
import { ethers } from "hardhat"
import { TestERC20, UniswapV3Factory, UniswapV3Pool } from "../../typechain"
import { BaseToken } from "../../typechain/BaseToken"
import { isAscendingTokenOrder } from "./utilities"

interface TokensFixture {
    token0: BaseToken
    mockedAggregator0: MockContract
    token1: BaseToken
    mockedAggregator1: MockContract
}

interface PoolFixture {
    factory: UniswapV3Factory
    pool: UniswapV3Pool
    baseToken: TestERC20
    quoteToken: TestERC20
}

interface BaseTokenFixture {
    baseToken: BaseToken
    mockedAggregator: MockContract
}

export function createTokenFixture(name: string, symbol: string): () => Promise<BaseTokenFixture> {
    return async (): Promise<BaseTokenFixture> => {
        const aggregatorFactory = await ethers.getContractFactory("TestAggregatorV3")
        const aggregator = await aggregatorFactory.deploy()
        const mockedAggregator = await smockit(aggregator)

        mockedAggregator.smocked.decimals.will.return.with(async () => {
            return 6
        })

        const chainlinkPriceFeedFactory = await ethers.getContractFactory("ChainlinkPriceFeed")
        const chainlinkPriceFeed = await chainlinkPriceFeedFactory.deploy(mockedAggregator.address)

        const baseTokenFactory = await ethers.getContractFactory("BaseToken")
        const baseToken = (await baseTokenFactory.deploy(name, symbol, chainlinkPriceFeed.address)) as BaseToken

        return { baseToken, mockedAggregator }
    }
}

export async function uniswapV3FactoryFixture(): Promise<UniswapV3Factory> {
    const factoryFactory = await ethers.getContractFactory("UniswapV3Factory")
    return (await factoryFactory.deploy()) as UniswapV3Factory
}

// assume isAscendingTokensOrder() == true/ token0 < token1
export async function tokensFixture(): Promise<TokensFixture> {
    const { baseToken: randomToken0, mockedAggregator: randomMockedAggregator0 } = await createTokenFixture(
        "RandomTestToken0",
        "randomToken0",
    )()
    const { baseToken: randomToken1, mockedAggregator: randomMockedAggregator1 } = await createTokenFixture(
        "RandomTestToken1",
        "randomToken1",
    )()

    let token0: BaseToken
    let token1: BaseToken
    let mockedAggregator0: MockContract
    let mockedAggregator1: MockContract
    if (isAscendingTokenOrder(randomToken0.address, randomToken1.address)) {
        token0 = randomToken0
        mockedAggregator0 = randomMockedAggregator0
        token1 = randomToken1
        mockedAggregator1 = randomMockedAggregator1
    } else {
        token0 = randomToken1
        mockedAggregator0 = randomMockedAggregator1
        token1 = randomToken0
        mockedAggregator1 = randomMockedAggregator0
    }
    return {
        token0,
        mockedAggregator0,
        token1,
        mockedAggregator1,
    }
}

export async function base0Quote1PoolFixture(): Promise<PoolFixture> {
    const { token0, token1 } = await tokensFixture()
    const factory = await uniswapV3FactoryFixture()

    const tx = await factory.createPool(token0.address, token1.address, "10000")
    const receipt = await tx.wait()
    const poolAddress = receipt.events?.[0].args?.pool as string

    const poolFactory = await ethers.getContractFactory("UniswapV3Pool")
    const pool = poolFactory.attach(poolAddress) as UniswapV3Pool

    return { factory, pool, baseToken: token0, quoteToken: token1 }
}

// for cases of reverse tokens order
export async function base1Quote0PoolFixture(): Promise<PoolFixture> {
    const { token0, token1 } = await tokensFixture()
    const factory = await uniswapV3FactoryFixture()

    const tx = await factory.createPool(token0.address, token1.address, "10000")
    const receipt = await tx.wait()
    const poolAddress = receipt.events?.[0].args?.pool as string

    const poolFactory = await ethers.getContractFactory("UniswapV3Pool")
    const pool = poolFactory.attach(poolAddress) as UniswapV3Pool

    return { factory, pool, baseToken: token1, quoteToken: token0 }
}
