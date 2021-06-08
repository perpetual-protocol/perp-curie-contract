import { expect } from "chai"
import { waffle } from "hardhat"
import { UniswapV3Pool } from "../../typechain"
import { ERC20PresetMinterPauser } from "../../typechain/openzeppelin"
import { poolFixture } from "../shared/fixtures"
import { encodePriceSqrt } from "../shared/utilities"

describe("UniswapV3Pool", () => {
    let pool: UniswapV3Pool
    let token0: ERC20PresetMinterPauser
    let token1: ERC20PresetMinterPauser

    beforeEach(async () => {
        const { pool: _pool, token0: _token0, token1: _token1 } = await waffle.loadFixture(poolFixture)
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
