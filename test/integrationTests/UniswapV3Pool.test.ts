import { expect } from "chai"
import { waffle } from "hardhat"
import { TestERC20 } from "../../typechain"
import { UniswapV3Pool } from "../../typechain/external"
import { poolFixture } from "../shared/fixtures"

describe("UniswapV3Pool", () => {
    let pool: UniswapV3Pool
    let token0: TestERC20
    let token1: TestERC20

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
})
