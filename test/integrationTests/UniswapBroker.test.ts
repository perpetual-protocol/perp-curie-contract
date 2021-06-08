import { waffle } from "hardhat"
import { TestERC20 } from "../../typechain"
import { UniswapV3Pool } from "../../typechain/uniswap"
import { poolFixture } from "../shared/fixtures"
import { encodePriceSqrt } from "../shared/utilities"

describe("UniswapBroker", () => {
    let pool: UniswapV3Pool
    let token0: TestERC20
    let token1: TestERC20

    beforeEach(async () => {
        const { pool: _pool, token0: _token0, token1: _token1 } = await waffle.loadFixture(poolFixture)
        pool = _pool
        token0 = _token0
        token1 = _token1
        await pool.initialize(encodePriceSqrt(1, 10))
    })

    describe("#mint", () => {
        it("has zero totalSupply", async () => {
            const { base, quote, lpAmount, feeGrowthInsideLastBase, feeGrowthInsideLastQuote } = await broker.mint(
                pool,
                tickLower,
                tickUpper,
                base,
                quote,
            )
            expect(lpAmount).eq("xxx")
        })
    })
})
