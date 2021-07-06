import { expect } from "chai"
import { waffle } from "hardhat"
import { ClearingHouse, TestERC20, UniswapV3Pool } from "../../typechain"
import { toWei } from "../helper/number"
import { encodePriceSqrt } from "../shared/utilities"
import { BaseQuoteOrdering, createClearingHouseFixture } from "./fixtures"

describe("ClearingHouse openPosition", () => {
    const [admin, alice] = waffle.provider.getWallets()
    const loadFixture: ReturnType<typeof waffle.createFixtureLoader> = waffle.createFixtureLoader([admin])
    let clearingHouse: ClearingHouse
    let collateral: TestERC20
    let baseToken: TestERC20
    let quoteToken: TestERC20
    let pool: UniswapV3Pool
    let collateralDecimals: number

    beforeEach(async () => {
        const _clearingHouseFixture = await loadFixture(createClearingHouseFixture(BaseQuoteOrdering.BASE_0_QUOTE_1))
        clearingHouse = _clearingHouseFixture.clearingHouse
        collateral = _clearingHouseFixture.USDC
        baseToken = _clearingHouseFixture.baseToken
        quoteToken = _clearingHouseFixture.quoteToken
        pool = _clearingHouseFixture.pool

        // mint
        collateral.mint(admin.address, toWei(10000))

        // prepare collateral for alice
        collateralDecimals = await collateral.decimals()
        const amount = toWei(1000, collateralDecimals)
        await collateral.transfer(alice.address, amount)
        await collateral.connect(alice).approve(clearingHouse.address, amount)

        // add pool
        await clearingHouse.addPool(baseToken.address, 10000)
    })

    describe("invalid input", () => {
        beforeEach(async () => {
            await pool.initialize(encodePriceSqrt("154.4310961", "1"))
        })

        describe("enough collateral", () => {
            beforeEach(async () => {
                await clearingHouse.connect(alice).deposit(toWei(1000, collateralDecimals))
            })

            it("force error due to invalid baseToken", async () => {
                await expect(
                    clearingHouse.connect(alice).openPosition({
                        baseToken: pool.address,
                        isBaseToQuote: true,
                        isExactInput: true,
                        amount: 1,
                        sqrtPriceLimitX96: 0,
                    }),
                ).to.be.revertedWith("CH_PNF")
            })
            it("force error due to invalid amount (0)", async () => {
                await expect(
                    clearingHouse.connect(alice).openPosition({
                        baseToken: baseToken.address,
                        isBaseToQuote: true,
                        isExactInput: true,
                        amount: 0,
                        sqrtPriceLimitX96: 0,
                    }),
                ).to.be.revertedWith("UB_ZI")
            })

            it("force error due to slippage protection", async () => {
                // taker want to get 1 vETH in exact current price which is not possible
                await expect(
                    clearingHouse.connect(alice).openPosition({
                        baseToken: baseToken.address,
                        isBaseToQuote: false,
                        isExactInput: false,
                        amount: 1,
                        sqrtPriceLimitX96: encodePriceSqrt("154.4310961", "1"),
                    }),
                ).to.be.revertedWith("SPL")
            })
            it("force error due to not enough liquidity", async () => {
                await expect(
                    clearingHouse.connect(alice).openPosition({
                        baseToken: baseToken.address,
                        isBaseToQuote: false,
                        isExactInput: false,
                        amount: 1,
                        sqrtPriceLimitX96: 0,
                    }),
                ).to.be.revertedWith("CH_F0S")
            })
        })

        describe("no collateral", () => {
            it("force error due to not enough collateral", async () => {
                await expect(
                    clearingHouse.connect(alice).openPosition({
                        baseToken: baseToken.address,
                        isBaseToQuote: false,
                        isExactInput: false,
                        amount: toWei(1000),
                        sqrtPriceLimitX96: 0,
                    }),
                ).to.be.revertedWith("CH_F0S")
            })
        })
    })

    // https://docs.google.com/spreadsheets/d/1xcWBBcQYwWuWRdlHtNv64tOjrBCnnvj_t1WEJaQv8EY/edit#gid=1258612497
    describe("taker opens long from scratch", () => {
        it("settle funding payment")
        it("mint missing amount of vUSD for swapping")
        it("does not mint anything if the vUSD is sufficient")
    })

    describe("taker opens short from scratch", () => {
        it("settle funding payment")
        it("mint missing amount of vETH for swapping")
        it("will not mint anything if vETH is sufficient")
    })

    describe("opening long first", () => {
        it("increase position")
        it("reduce position")
        it("close position")
        it("open larger reverse position")
    })

    describe("opening short first", () => {
        it("increase position")
        it("reduce position")
        it("close position")
        it("open larger reverse position")
    })

    describe("maker has order out of price range", () => {
        it("will not affect her range order")
    })

    describe("maker has order within price range", () => {
        it("will not affect her range order")
        it("force error if she is going to liquidate herself")
    })
})
