import { ethers } from "hardhat"
import { TestERC20, UniswapV3Factory, UniswapV3Pool } from "../../typechain"
import { isBase0Quote1 } from "./utilities"

interface TokensFixture {
    baseToken: TestERC20
    quoteToken: TestERC20
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

// assume isBase0Quote1/ token0 == base
export async function tokensFixture(): Promise<TokensFixture> {
    const tokenFactory = await ethers.getContractFactory("TestERC20")
    const tETH = (await tokenFactory.deploy("TestETH", "tETH")) as TestERC20
    const tUSDC = (await tokenFactory.deploy("TestUSDC", "tUSDC")) as TestERC20
    let baseToken: TestERC20
    let quoteToken: TestERC20
    if (isBase0Quote1(tETH.address, tUSDC.address)) {
        baseToken = tETH
        quoteToken = tUSDC
    } else {
        baseToken = tUSDC
        quoteToken = tETH
    }
    return { baseToken, quoteToken }
}

// assume !isBase0Quote1/ token0 == quote
export async function reverseTokensFixture(): Promise<TokensFixture> {
    const tokenFactory = await ethers.getContractFactory("TestERC20")
    const tETH = (await tokenFactory.deploy("TestETH", "tETH")) as TestERC20
    const tUSDC = (await tokenFactory.deploy("TestUSDC", "tUSDC")) as TestERC20
    let baseToken: TestERC20
    let quoteToken: TestERC20
    if (isBase0Quote1(tETH.address, tUSDC.address)) {
        baseToken = tUSDC
        quoteToken = tETH
    } else {
        baseToken = tETH
        quoteToken = tUSDC
    }
    return { baseToken, quoteToken }
}

export async function poolFixture(): Promise<PoolFixture> {
    const { baseToken, quoteToken } = await tokensFixture()
    const factory = await uniswapV3FactoryFixture()

    const tx = await factory.createPool(baseToken.address, quoteToken.address, "10000")
    const receipt = await tx.wait()
    const poolAddress = receipt.events?.[0].args?.pool as string

    const poolFactory = await ethers.getContractFactory("UniswapV3Pool")
    const pool = poolFactory.attach(poolAddress) as UniswapV3Pool

    return { factory, pool, baseToken, quoteToken }
}

// for cases of reverse tokens order
export async function reversePoolFixture(): Promise<PoolFixture> {
    const { baseToken, quoteToken } = await reverseTokensFixture()
    const factory = await uniswapV3FactoryFixture()

    const tx = await factory.createPool(baseToken.address, quoteToken.address, "10000")
    const receipt = await tx.wait()
    const poolAddress = receipt.events?.[0].args?.pool as string

    const poolFactory = await ethers.getContractFactory("UniswapV3Pool")
    const pool = poolFactory.attach(poolAddress) as UniswapV3Pool

    return { factory, pool, baseToken, quoteToken }
}
