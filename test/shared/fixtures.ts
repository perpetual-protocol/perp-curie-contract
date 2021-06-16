import { ethers } from "hardhat"
import { TestERC20, UniswapV3Factory, UniswapV3Pool } from "../../typechain"
import { isAscendingTokensOrder } from "./utilities"

interface TokensFixture {
    token0: TestERC20
    token1: TestERC20
}

interface PoolFixture {
    factory: UniswapV3Factory
    pool: UniswapV3Pool
    baseToken: TestERC20
    quoteToken: TestERC20
}

export async function uniswapV3FactoryFixture(): Promise<UniswapV3Factory> {
    const factoryFactory = await ethers.getContractFactory("UniswapV3Factory")
    return (await factoryFactory.deploy()) as UniswapV3Factory
}

// assume isAscendingTokensOrder() == true/ token0 < token1
export async function tokensFixture(): Promise<TokensFixture> {
    const tokenFactory = await ethers.getContractFactory("TestERC20")
    const randomToken0 = (await tokenFactory.deploy("RandomTestToken0", "randomToken0")) as TestERC20
    const randomToken1 = (await tokenFactory.deploy("RandomTestToken1", "randomToken1")) as TestERC20
    let token0: TestERC20
    let token1: TestERC20
    if (isAscendingTokensOrder(randomToken0.address, randomToken1.address)) {
        token0 = randomToken0
        token1 = randomToken1
    } else {
        token0 = randomToken1
        token1 = randomToken0
    }
    return { token0, token1 }
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
