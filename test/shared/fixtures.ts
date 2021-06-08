import { ethers } from "hardhat"
import { UniswapV3Factory, UniswapV3Pool } from "../../typechain"
import { ERC20PresetMinterPauser } from "../../typechain/openzeppelin"

interface TokensFixture {
    token0: ERC20PresetMinterPauser
    token1: ERC20PresetMinterPauser
}

interface PoolFixture {
    pool: UniswapV3Pool
    token0: ERC20PresetMinterPauser
    token1: ERC20PresetMinterPauser
}

export async function tokensFixture(): Promise<TokensFixture> {
    const tokenFactory = await ethers.getContractFactory("ERC20PresetMinterPauser")
    const tokenA = (await tokenFactory.deploy("TestETH", "tETH")) as ERC20PresetMinterPauser
    const tokenB = (await tokenFactory.deploy("TestUSDC", "tUSDC")) as ERC20PresetMinterPauser

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
