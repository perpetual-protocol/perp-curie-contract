import { ethers } from "hardhat"
import { TestERC20, UniswapV3Factory, UniswapV3Pool } from "../../typechain"

interface TokensFixture {
    base: TestERC20
    quote: TestERC20
}

interface PoolFixture {
    factory: UniswapV3Factory
    pool: UniswapV3Pool
    base: TestERC20
    quote: TestERC20
}

export async function tokensFixture(): Promise<TokensFixture> {
    const tokenFactory = await ethers.getContractFactory("TestERC20")
    const base = (await tokenFactory.deploy("TestETH", "tETH")) as TestERC20
    const quote = (await tokenFactory.deploy("TestUSDC", "tUSDC")) as TestERC20
    return { base, quote }
}

export async function poolFixture(): Promise<PoolFixture> {
    const { base, quote } = await tokensFixture()

    const factoryFactory = await ethers.getContractFactory("UniswapV3Factory")
    const factory = (await factoryFactory.deploy()) as UniswapV3Factory
    const tx = await factory.createPool(base.address, quote.address, "10000")
    const receipt = await tx.wait()
    const poolAddress = receipt.events?.[0].args?.pool as string

    const poolFactory = await ethers.getContractFactory("UniswapV3Pool")
    const pool = poolFactory.attach(poolAddress) as UniswapV3Pool

    console.log(`factory: ${factory.address}`)
    console.log(`pool: ${pool.address}`)

    return { factory, pool, base, quote }
}
