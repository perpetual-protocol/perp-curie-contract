import UniswapV3FactoryArtifacts from "@uniswap/v3-core/artifacts/contracts/UniswapV3Factory.sol/UniswapV3Factory.json"
import UniswapV3PoolArtifacts from "@uniswap/v3-core/artifacts/contracts/UniswapV3Pool.sol/UniswapV3Pool.json"
import { expect } from "chai"
import { ethers, waffle } from "hardhat"
import { TestERC20 } from "../../typechain"
import { UniswapV3Factory, UniswapV3Pool } from "../../typechain/external"

interface TokensFixture {
    token0: TestERC20
    token1: TestERC20
}

async function tokensFixture(): Promise<TokensFixture> {
    const tokenFactory = await ethers.getContractFactory("TestERC20")
    const tokenA = (await tokenFactory.deploy("TestETH", "tETH")) as TestERC20
    const tokenB = (await tokenFactory.deploy("TestUSDC", "tUSDC")) as TestERC20

    const [token0, token1] = [tokenA, tokenB].sort((tokenA, tokenB) =>
        tokenA.address.toLowerCase() < tokenB.address.toLowerCase() ? -1 : 1,
    )

    return { token0, token1 }
}

describe("uniswapV3Pool-helper", () => {
    let token0: TestERC20
    let token1: TestERC20

    beforeEach(async () => {
        const [wallet, other] = waffle.provider.getWallets()
        const { token0: _token0, token1: _token1 } = await tokensFixture()
        token0 = _token0
        token1 = _token1
    })

    it("deploy ERC20 tokens", async () => {
        expect(await token0.totalSupply()).eq("0")
        expect(await token1.totalSupply()).eq("0")
    })

    it("create a pool", async () => {
        const [wallet, other] = waffle.provider.getWallets()
        const factoryFactory = new ethers.ContractFactory(
            UniswapV3FactoryArtifacts.abi,
            UniswapV3FactoryArtifacts.bytecode,
            wallet,
        )
        const factory = (await factoryFactory.deploy()) as UniswapV3Factory
        const tx = await factory.createPool(token0.address, token1.address, "3000")
        const receipt = await tx.wait()
        const poolAddress = receipt.events?.[0].args?.pool as string

        const poolFactory = new ethers.ContractFactory(
            UniswapV3PoolArtifacts.abi,
            UniswapV3PoolArtifacts.bytecode,
            wallet,
        )
        const pool = poolFactory.attach(poolAddress) as UniswapV3Pool
        expect(await pool.token0()).eq(token0.address)
    })
})
