import { expect } from "chai"
import { waffle } from "hardhat"
import { UniswapV3Pool, VirtualToken } from "../../typechain"
import { base0Quote1PoolFixture } from "../shared/fixtures"
import { encodePriceSqrt, sortedTokens } from "../shared/utilities"

describe("UniswapV3Pool", () => {
    const [wallet] = waffle.provider.getWallets()
    const loadFixture: ReturnType<typeof waffle.createFixtureLoader> = waffle.createFixtureLoader([wallet])
    let pool: UniswapV3Pool
    let token0: VirtualToken
    let token1: VirtualToken

    beforeEach(async () => {
        const { pool: _pool, baseToken, quoteToken } = await loadFixture(base0Quote1PoolFixture)
        const { token0: _token0, token1: _token1 } = sortedTokens(baseToken, quoteToken)
        pool = _pool
        token0 = _token0
        token1 = _token1
    })

    it("has zero totalSupply", async () => {
        expect(await token0.totalSupply()).eq("0")
        expect(await token1.totalSupply()).eq("0")
    })

    it("has token0 and token1", async () => {
        expect(await pool.token0()).eq(token0.address)
        expect(await pool.token1()).eq(token1.address)
    })

    it("has price after initialization", async () => {
        const price = encodePriceSqrt(1, 2)
        await pool.initialize(price)

        const { sqrtPriceX96, observationIndex } = await pool.slot0()
        expect(sqrtPriceX96).to.eq(price)
        expect(observationIndex).to.eq(0)
        expect((await pool.slot0()).tick).to.eq(-6932)
    })
})
