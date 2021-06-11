import { ethers } from "hardhat"
import { TestERC20, UniswapV3Factory, UniswapV3Pool } from "../../typechain"

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

export async function tokensFixture(): Promise<TokensFixture> {
    const tokenFactory = await ethers.getContractFactory("TestERC20")
    const baseToken = (await tokenFactory.deploy("TestETH", "tETH")) as TestERC20
    const quoteToken = (await tokenFactory.deploy("TestUSDC", "tUSDC")) as TestERC20
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
