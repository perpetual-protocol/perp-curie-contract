import { ethers } from "hardhat"
import { TestERC20 } from "../../typechain"
import { UniswapV3Factory, UniswapV3Pool } from "../../typechain/uniswap"

interface TokensFixture {
    token0: TestERC20
    token1: TestERC20
}

interface PoolFixture {
    pool: UniswapV3Pool
    token0: TestERC20
    token1: TestERC20
}

export async function tokensFixture(): Promise<TokensFixture> {
    const tokenFactory = await ethers.getContractFactory("TestERC20")
    const tokenA = (await tokenFactory.deploy("TestETH", "tETH")) as TestERC20
    const tokenB = (await tokenFactory.deploy("TestUSDC", "tUSDC")) as TestERC20

    const [token0, token1] = [tokenA, tokenB].sort((tokenA, tokenB) =>
        tokenA.address.toLowerCase() < tokenB.address.toLowerCase() ? -1 : 1,
    )

    return { token0, token1 }
}

export async function poolFixture(): Promise<PoolFixture> {
    const { token0, token1 } = await tokensFixture()

    const factoryFactory = await ethers.getContractFactory("UniswapV3Factory")
    const factory = (await factoryFactory.deploy()) as UniswapV3Factory
    const tx = await factory.createPool(token0.address, token1.address, "10000")
    const receipt = await tx.wait()
    const poolAddress = receipt.events?.[0].args?.pool as string

    const poolFactory = await ethers.getContractFactory("UniswapV3Pool")
    const pool = poolFactory.attach(poolAddress) as UniswapV3Pool

    return { pool, token0, token1 }
}
