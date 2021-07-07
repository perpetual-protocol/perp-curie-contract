import { expect } from "chai"
import { waffle } from "hardhat"
import { ClearingHouse, TestERC20, UniswapV3Pool } from "../../typechain"
import { toWei } from "../helper/number"
import { encodePriceSqrt } from "../shared/utilities"
import { BaseQuoteOrdering, createClearingHouseFixture } from "./fixtures"

describe.only("ClearingHouse openPosition", () => {
    const [admin, maker, taker] = waffle.provider.getWallets()
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
        collateralDecimals = await collateral.decimals()

        // add pool
        await clearingHouse.addPool(baseToken.address, 10000)
        await pool.initialize(encodePriceSqrt("151.373306858723226652", "1")) // tick = 50200 (1.0001^50200 = 151.373306858723226652)

        // prepare collateral for taker
        const makerCollateralAmount = toWei(10000, collateralDecimals)
        await collateral.mint(maker.address, makerCollateralAmount)
        await collateral.connect(maker).approve(clearingHouse.address, makerCollateralAmount)
        await clearingHouse.connect(maker).deposit(makerCollateralAmount)

        // maker add liquidity
        await clearingHouse.connect(maker).mint(baseToken.address, toWei(100))
        await clearingHouse.connect(maker).mint(quoteToken.address, toWei(10000))
        await clearingHouse.connect(maker).addLiquidity({
            baseToken: baseToken.address,
            base: toWei(100),
            quote: toWei(10000),
            lowerTick: 50000,
            upperTick: 54000,
        })

        // prepare collateral for taker
        const takerCollateral = toWei(1000, collateralDecimals)
        await collateral.mint(taker.address, takerCollateral)
        await collateral.connect(taker).approve(clearingHouse.address, takerCollateral)
    })

    describe("invalid input", () => {
        describe("enough collateral", () => {
            beforeEach(async () => {
                await clearingHouse.connect(taker).deposit(toWei(1000, collateralDecimals))
            })

            it("force error due to invalid baseToken", async () => {
                await expect(
                    clearingHouse.connect(taker).openPosition({
                        baseToken: pool.address,
                        isBaseToQuote: true,
                        isExactInput: true,
                        amount: 1,
                        sqrtPriceLimitX96: 0,
                    }),
                ).to.be.revertedWith("CH_TNF")
            })

            it("force error due to invalid amount (0)", async () => {
                await expect(
                    clearingHouse.connect(taker).openPosition({
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
                    clearingHouse.connect(taker).openPosition({
                        baseToken: baseToken.address,
                        isBaseToQuote: false,
                        isExactInput: false,
                        amount: 1,
                        sqrtPriceLimitX96: encodePriceSqrt("151.373306858723226652", "1"),
                    }),
                ).to.be.revertedWith("SPL")
            })

            it("force error due to not enough liquidity", async () => {
                // empty the liquidity
                const order = await clearingHouse.getOpenOrder(maker.address, baseToken.address, 50000, 54000)
                await clearingHouse.connect(maker).removeLiquidity({
                    baseToken: baseToken.address,
                    lowerTick: 50000,
                    upperTick: 54000,
                    liquidity: order.liquidity,
                })

                // trade
                await expect(
                    clearingHouse.connect(taker).openPosition({
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
            it("force error due to not enough collateral for mint", async () => {
                await expect(
                    clearingHouse.connect(taker).openPosition({
                        baseToken: baseToken.address,
                        isBaseToQuote: false,
                        isExactInput: true,
                        amount: toWei(10000000),
                        sqrtPriceLimitX96: 0,
                    }),
                ).to.be.revertedWith("CH_NEAV")
            })
        })
    })

    describe.only("taker open position from zero", async () => {
        beforeEach(async () => {
            // deposit
            await clearingHouse.connect(taker).deposit(toWei(1000, collateralDecimals))

            // expect all available and debt are zero
            const baseInfo = await clearingHouse.getTokenInfo(taker.address, baseToken.address)
            const quoteInfo = await clearingHouse.getTokenInfo(taker.address, quoteToken.address)
            expect(baseInfo.available.eq(0)).to.be.true
            expect(baseInfo.debt.eq(0)).to.be.true
            expect(quoteInfo.available.eq(0)).to.be.true
            expect(quoteInfo.debt.eq(0)).to.be.true
        })

        describe("taker opens long ", () => {
            it("settle funding payment")

            it("increase position from 0", async () => {
                // taker swap 1 USD for ? ETH
                await clearingHouse.connect(taker).openPosition({
                    baseToken: baseToken.address,
                    isBaseToQuote: false,
                    isExactInput: true,
                    amount: toWei(1),
                    sqrtPriceLimitX96: 0,
                })
                const baseInfo = await clearingHouse.getTokenInfo(taker.address, baseToken.address)
                const quoteInfo = await clearingHouse.getTokenInfo(taker.address, quoteToken.address)
                expect(baseInfo.available.gt(toWei(0))).to.be.true
                expect(baseInfo.debt.eq(toWei(0))).to.be.true
                expect(quoteInfo.available.eq(toWei(0))).to.be.true
                expect(quoteInfo.debt.eq(toWei(1))).to.be.true
            })

            it("mint missing amount of vUSD for swapping", async () => {
                await clearingHouse.connect(taker).mint(quoteToken.address, toWei(1))

                // taker swap 2 USD for ? ETH
                // it will mint 1 more USD
                await expect(
                    clearingHouse.connect(taker).openPosition({
                        baseToken: baseToken.address,
                        isBaseToQuote: false,
                        isExactInput: true,
                        amount: toWei(2),
                        sqrtPriceLimitX96: 0,
                    }),
                )
                    .to.emit(clearingHouse, "Minted")
                    .withArgs(quoteToken.address, toWei(1))

                const baseInfo = await clearingHouse.getTokenInfo(taker.address, baseToken.address)
                const quoteInfo = await clearingHouse.getTokenInfo(taker.address, quoteToken.address)
                expect(baseInfo.available.gt(toWei(0))).to.be.true
                expect(baseInfo.debt.eq(toWei(0))).to.be.true
                expect(quoteInfo.available.eq(toWei(0))).to.be.true
                expect(quoteInfo.debt.eq(toWei(2))).to.be.true
            })

            it("does not mint anything if the vUSD is sufficient", async () => {
                await clearingHouse.connect(taker).mint(quoteToken.address, toWei(1))

                // taker swap 1 USD for ? ETH
                // wont mint anything
                await expect(
                    clearingHouse.connect(taker).openPosition({
                        baseToken: baseToken.address,
                        isBaseToQuote: false,
                        isExactInput: true,
                        amount: toWei(1),
                        sqrtPriceLimitX96: 0,
                    }),
                ).to.not.emit(clearingHouse, "Minted")

                const baseInfo = await clearingHouse.getTokenInfo(taker.address, baseToken.address)
                const quoteInfo = await clearingHouse.getTokenInfo(taker.address, quoteToken.address)
                expect(baseInfo.available.gt(toWei(0))).to.be.true
                expect(baseInfo.debt.eq(toWei(0))).to.be.true
                expect(quoteInfo.available.eq(toWei(0))).to.be.true
                expect(quoteInfo.debt.eq(toWei(1))).to.be.true
            })
        })

        describe("taker opens short from scratch", () => {
            it("settle funding payment")
            it("increase position from 0", async () => {
                // taker swap 1 ETH for ? USD
                await clearingHouse.connect(taker).openPosition({
                    baseToken: baseToken.address,
                    isBaseToQuote: true,
                    isExactInput: true,
                    amount: toWei(1),
                    sqrtPriceLimitX96: 0,
                })
                const baseInfo = await clearingHouse.getTokenInfo(taker.address, baseToken.address)
                const quoteInfo = await clearingHouse.getTokenInfo(taker.address, quoteToken.address)
                expect(baseInfo.available.eq(toWei(0))).to.be.true
                expect(baseInfo.debt.eq(toWei(1))).to.be.true
                expect(quoteInfo.available.gt(toWei(0))).to.be.true
                expect(quoteInfo.debt.eq(toWei(0))).to.be.true
            })
            it("mint missing amount of vETH for swapping", async () => {
                await clearingHouse.connect(taker).mint(baseToken.address, toWei(1))

                // taker swap 2 ETH for ? USD
                // it will mint 1 more ETH
                await expect(
                    clearingHouse.connect(taker).openPosition({
                        baseToken: baseToken.address,
                        isBaseToQuote: true,
                        isExactInput: true,
                        amount: toWei(2),
                        sqrtPriceLimitX96: 0,
                    }),
                )
                    .to.emit(clearingHouse, "Minted")
                    .withArgs(baseToken.address, toWei(1))

                const baseInfo = await clearingHouse.getTokenInfo(taker.address, baseToken.address)
                const quoteInfo = await clearingHouse.getTokenInfo(taker.address, quoteToken.address)
                expect(baseInfo.available.eq(toWei(0))).to.be.true
                expect(baseInfo.debt.eq(toWei(2))).to.be.true
                expect(quoteInfo.available.gt(toWei(0))).to.be.true
                expect(quoteInfo.debt.eq(toWei(0))).to.be.true
            })

            it("will not mint anything if vETH is sufficient", async () => {
                await clearingHouse.connect(taker).mint(baseToken.address, toWei(1))

                // taker swap 1 ETH for ? USD
                // wont mint anything
                await expect(
                    clearingHouse.connect(taker).openPosition({
                        baseToken: baseToken.address,
                        isBaseToQuote: true,
                        isExactInput: true,
                        amount: toWei(1),
                        sqrtPriceLimitX96: 0,
                    }),
                ).to.not.emit(clearingHouse, "Minted")

                const baseInfo = await clearingHouse.getTokenInfo(taker.address, baseToken.address)
                const quoteInfo = await clearingHouse.getTokenInfo(taker.address, quoteToken.address)
                expect(baseInfo.available.eq(toWei(0))).to.be.true
                expect(baseInfo.debt.eq(toWei(1))).to.be.true
                expect(quoteInfo.available.gt(toWei(0))).to.be.true
                expect(quoteInfo.debt.eq(toWei(0))).to.be.true
            })
        })
    })

    // https://docs.google.com/spreadsheets/d/1xcWBBcQYwWuWRdlHtNv64tOjrBCnnvj_t1WEJaQv8EY/edit#gid=1258612497
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
