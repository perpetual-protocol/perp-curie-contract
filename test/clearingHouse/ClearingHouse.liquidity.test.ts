import { BaseQuoteOrdering, createClearingHouseFixture } from "./fixtures"
import { ClearingHouse, TestERC20, UniswapV3Pool } from "../../typechain"

import { BigNumber } from "ethers"
import { defaultAbiCoder } from "@ethersproject/abi"
import { encodePriceSqrt } from "../shared/utilities"
import { expect } from "chai"
import { parseEther } from "ethers/lib/utils"
import { toWei } from "../helper/number"
import { waffle } from "hardhat"

describe("ClearingHouse", () => {
    const EMPTY_ADDRESS = "0x0000000000000000000000000000000000000000"
    const [admin, alice, bob] = waffle.provider.getWallets()
    const loadFixture: ReturnType<typeof waffle.createFixtureLoader> = waffle.createFixtureLoader([admin])
    let clearingHouse: ClearingHouse
    let collateral: TestERC20
    let baseToken: TestERC20
    let quoteToken: TestERC20
    let pool: UniswapV3Pool

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
        const amount = toWei(1000, await collateral.decimals())
        await collateral.transfer(alice.address, amount)
        await collateral.connect(alice).approve(clearingHouse.address, amount)
        await clearingHouse.connect(alice).deposit(amount)

        // prepare collateral for bob
        await collateral.transfer(bob.address, amount)
        await collateral.connect(bob).approve(clearingHouse.address, amount)
        await clearingHouse.connect(bob).deposit(amount)

        // add pool
        await clearingHouse.addPool(baseToken.address, 10000)

        // mint
        const baseAmount = toWei(100, await baseToken.decimals())
        const quoteAmount = toWei(10000, await quoteToken.decimals())
        await clearingHouse.connect(alice).mint(baseToken.address, baseAmount)
        await clearingHouse.connect(alice).mint(quoteToken.address, quoteAmount)
        await clearingHouse.connect(bob).mint(baseToken.address, baseAmount)
        await clearingHouse.connect(bob).mint(quoteToken.address, quoteAmount)
    })

    // simulation results:
    //   https://docs.google.com/spreadsheets/d/1xcWBBcQYwWuWRdlHtNv64tOjrBCnnvj_t1WEJaQv8EY/edit#gid=1155466937
    describe("# addLiquidity", () => {
        // TODO remove this unnecessary desc
        describe("base0, quote1", () => {
            // @SAMPLE - addLiquidity
            it("add liquidity below price with only quote token", async () => {
                await pool.initialize(encodePriceSqrt("151.373306858723226652", "1")) // tick = 50200 (1.0001^50200 = 151.373306858723226652)

                const baseBefore = await baseToken.balanceOf(clearingHouse.address)
                const quoteBefore = await quoteToken.balanceOf(clearingHouse.address)

                // assume imRatio = 0.1
                // alice collateral = 1000, freeCollateral = 10,000, mint 10,000 quote
                await expect(
                    clearingHouse.connect(alice).addLiquidity({
                        baseToken: baseToken.address,
                        base: 0,
                        quote: toWei(10000, await quoteToken.decimals()),
                        lowerTick: 50000,
                        upperTick: 50200,
                    }),
                )
                    .to.emit(clearingHouse, "LiquidityChanged")
                    .withArgs(
                        alice.address,
                        baseToken.address,
                        quoteToken.address,
                        50000,
                        50200,
                        0,
                        toWei(10000, await quoteToken.decimals()),
                        "81689571696303801037492",
                        0,
                        0,
                    )

                // verify account states
                expect(await clearingHouse.getTokenInfo(alice.address, baseToken.address)).to.deep.eq([
                    toWei(100, await baseToken.decimals()), // available
                    toWei(100, await baseToken.decimals()), // debt
                ])
                expect(await clearingHouse.getTokenInfo(alice.address, quoteToken.address)).to.deep.eq([
                    toWei(0, await quoteToken.decimals()), // available
                    toWei(10000, await quoteToken.decimals()), // debt
                ])
                expect(await clearingHouse.getOpenOrder(alice.address, baseToken.address, 50000, 50200)).to.deep.eq([
                    BigNumber.from("81689571696303801037492"), // liquidity
                    50000, // lowerTick
                    50200, // upperTick
                    toWei(0, await baseToken.decimals()), // feeGrowthInsideLastBase
                    toWei(0, await quoteToken.decimals()), // feeGrowthInsideLastQuote
                ])

                // verify CH balance changes
                expect(await baseToken.balanceOf(clearingHouse.address)).to.eq(baseBefore)
                expect(quoteBefore.sub(await quoteToken.balanceOf(clearingHouse.address))).to.eq(
                    toWei(10000, await quoteToken.decimals()),
                )
            })

            it("add liquidity below price with both tokens but expecting only quote token to be added", async () => {
                await pool.initialize(encodePriceSqrt("151.373306858723226652", "1")) // tick = 50200 (1.0001^50200 = 151.373306858723226652)

                const baseBefore = await baseToken.balanceOf(clearingHouse.address)
                const quoteBefore = await quoteToken.balanceOf(clearingHouse.address)

                // assume imRatio = 0.1
                // alice collateral = 1000, freeCollateral = 10,000, mint 10,000 quote
                await expect(
                    clearingHouse.connect(alice).addLiquidity({
                        baseToken: baseToken.address,
                        base: toWei(1, await quoteToken.decimals()),
                        quote: toWei(10000, await quoteToken.decimals()),
                        lowerTick: 50000,
                        upperTick: 50200,
                    }),
                )
                    .to.emit(clearingHouse, "LiquidityChanged")
                    .withArgs(
                        alice.address,
                        baseToken.address,
                        quoteToken.address,
                        50000,
                        50200,
                        0,
                        toWei(10000, await quoteToken.decimals()),
                        "81689571696303801037492",
                        0,
                        0,
                    )

                // verify account states
                expect(await clearingHouse.getTokenInfo(alice.address, baseToken.address)).to.deep.eq([
                    toWei(100, await baseToken.decimals()), // available
                    toWei(100, await baseToken.decimals()), // debt
                ])
                expect(await clearingHouse.getTokenInfo(alice.address, quoteToken.address)).to.deep.eq([
                    toWei(0, await quoteToken.decimals()), // available
                    toWei(10000, await quoteToken.decimals()), // debt
                ])
                expect(await clearingHouse.getOpenOrder(alice.address, baseToken.address, 50000, 50200)).to.deep.eq([
                    BigNumber.from("81689571696303801037492"), // liquidity
                    50000, // lowerTick
                    50200, // upperTick
                    toWei(0, await baseToken.decimals()), // feeGrowthInsideLastBase
                    toWei(0, await quoteToken.decimals()), // feeGrowthInsideLastQuote
                ])

                // verify CH balance changes
                expect(await baseToken.balanceOf(clearingHouse.address)).to.eq(baseBefore)
                expect(quoteBefore.sub(await quoteToken.balanceOf(clearingHouse.address))).to.eq(
                    toWei(10000, await quoteToken.decimals()),
                )
            })

            // @SAMPLE - addLiquidity
            it("add liquidity above price with only base token", async () => {
                await pool.initialize(encodePriceSqrt("151.373306858723226651", "1")) // tick = 50199 (1.0001^50199 = 151.373306858723226651)

                const baseBefore = await baseToken.balanceOf(clearingHouse.address)
                const quoteBefore = await quoteToken.balanceOf(clearingHouse.address)

                // assume imRatio = 0.1
                // alice collateral = 1000, freeCollateral = 10,000, mint 100 base
                await expect(
                    clearingHouse.connect(alice).addLiquidity({
                        baseToken: baseToken.address,
                        base: toWei(100, await baseToken.decimals()),
                        quote: 0,
                        lowerTick: 50200,
                        upperTick: 50400,
                    }),
                )
                    .to.emit(clearingHouse, "LiquidityChanged")
                    .withArgs(
                        alice.address,
                        baseToken.address,
                        quoteToken.address,
                        50200,
                        50400,
                        toWei(100, await baseToken.decimals()),
                        0,
                        "123656206035422669342231",
                        0,
                        0,
                    )

                // verify account states
                expect(await clearingHouse.getTokenInfo(alice.address, baseToken.address)).to.deep.eq([
                    toWei(0, await baseToken.decimals()), // available
                    toWei(100, await baseToken.decimals()), // debt
                ])
                expect(await clearingHouse.getTokenInfo(alice.address, quoteToken.address)).to.deep.eq([
                    toWei(10000, await quoteToken.decimals()), // available
                    toWei(10000, await quoteToken.decimals()), // debt
                ])
                expect(await clearingHouse.getOpenOrder(alice.address, baseToken.address, 50200, 50400)).to.deep.eq([
                    BigNumber.from("123656206035422669342231"), // liquidity
                    50200, // lowerTick
                    50400, // upperTick
                    toWei(0, await baseToken.decimals()), // feeGrowthInsideLastBase
                    toWei(0, await quoteToken.decimals()), // feeGrowthInsideLastQuote
                ])

                // verify CH balance changes
                expect(baseBefore.sub(await baseToken.balanceOf(clearingHouse.address))).to.eq(
                    toWei(100, await baseToken.decimals()),
                )
                expect(await quoteToken.balanceOf(clearingHouse.address)).to.eq(quoteBefore)
            })

            it("add liquidity above price with both tokens but expecting only base token to be added", async () => {
                await pool.initialize(encodePriceSqrt("151.373306858723226651", "1")) // tick = 50199 (1.0001^50199 = 151.373306858723226651)

                const baseBefore = await baseToken.balanceOf(clearingHouse.address)
                const quoteBefore = await quoteToken.balanceOf(clearingHouse.address)

                // assume imRatio = 0.1
                // alice collateral = 1000, freeCollateral = 10,000, mint 100 base
                await expect(
                    clearingHouse.connect(alice).addLiquidity({
                        baseToken: baseToken.address,
                        base: toWei(100, await baseToken.decimals()),
                        quote: toWei(1, await baseToken.decimals()),
                        lowerTick: 50200,
                        upperTick: 50400,
                    }),
                )
                    .to.emit(clearingHouse, "LiquidityChanged")
                    .withArgs(
                        alice.address,
                        baseToken.address,
                        quoteToken.address,
                        50200,
                        50400,
                        toWei(100, await baseToken.decimals()),
                        0,
                        "123656206035422669342231",
                        0,
                        0,
                    )

                // verify account states
                expect(await clearingHouse.getTokenInfo(alice.address, baseToken.address)).to.deep.eq([
                    toWei(0, await baseToken.decimals()), // available
                    toWei(100, await baseToken.decimals()), // debt
                ])
                expect(await clearingHouse.getTokenInfo(alice.address, quoteToken.address)).to.deep.eq([
                    toWei(10000, await quoteToken.decimals()), // available
                    toWei(10000, await quoteToken.decimals()), // debt
                ])
                expect(await clearingHouse.getOpenOrder(alice.address, baseToken.address, 50200, 50400)).to.deep.eq([
                    BigNumber.from("123656206035422669342231"), // liquidity
                    50200, // lowerTick
                    50400, // upperTick
                    toWei(0, await baseToken.decimals()), // feeGrowthInsideLastBase
                    toWei(0, await quoteToken.decimals()), // feeGrowthInsideLastQuote
                ])

                // verify CH balance changes
                expect(baseBefore.sub(await baseToken.balanceOf(clearingHouse.address))).to.eq(
                    toWei(100, await baseToken.decimals()),
                )
                expect(await quoteToken.balanceOf(clearingHouse.address)).to.eq(quoteBefore)
            })

            it("add liquidity with both tokens, over commit base", async () => {
                await pool.initialize(encodePriceSqrt("151.373306858723226652", "1")) // tick = 50200 (1.0001^50200 = 151.373306858723226652)

                const baseBefore = await baseToken.balanceOf(clearingHouse.address)
                const quoteBefore = await quoteToken.balanceOf(clearingHouse.address)

                // assume imRatio = 0.1
                // alice collateral = 1000, freeCollateral = 10,000, mint 100 base and 10000 quote
                await expect(
                    clearingHouse.connect(alice).addLiquidity({
                        baseToken: baseToken.address,
                        base: toWei("100", await baseToken.decimals()),
                        quote: toWei(10000, await quoteToken.decimals()),
                        lowerTick: 50000,
                        upperTick: 50400,
                    }),
                )
                    .to.emit(clearingHouse, "LiquidityChanged")
                    .withArgs(
                        alice.address,
                        baseToken.address,
                        quoteToken.address,
                        50000,
                        50400,
                        toWei("66.061845430469484023", await baseToken.decimals()),
                        toWei(10000, await quoteToken.decimals()),
                        "81689571696303801018159",
                        0,
                        0,
                    )

                // verify account states
                expect(await clearingHouse.getTokenInfo(alice.address, baseToken.address)).to.deep.eq([
                    toWei("33.938154569530515977", await baseToken.decimals()), // available
                    toWei(100, await baseToken.decimals()), // debt
                ])
                expect(await clearingHouse.getTokenInfo(alice.address, quoteToken.address)).to.deep.eq([
                    toWei(0, await quoteToken.decimals()), // available
                    toWei(10000, await quoteToken.decimals()), // debt
                ])
                expect(await clearingHouse.getOpenOrder(alice.address, baseToken.address, 50000, 50400)).to.deep.eq([
                    BigNumber.from("81689571696303801018159"), // liquidity
                    50000, // lowerTick
                    50400, // upperTick
                    toWei(0, await baseToken.decimals()), // feeGrowthInsideLastBase
                    toWei(0, await quoteToken.decimals()), // feeGrowthInsideLastQuote
                ])

                // verify CH balance changes
                expect(baseBefore.sub(await baseToken.balanceOf(clearingHouse.address))).to.eq(
                    toWei("66.061845430469484023", await baseToken.decimals()),
                )
                expect(quoteBefore.sub(await quoteToken.balanceOf(clearingHouse.address))).to.eq(
                    toWei(10000, await quoteToken.decimals()),
                )
            })

            it("add liquidity with both tokens, over commit quote", async () => {
                await pool.initialize(encodePriceSqrt("151.373306858723226652", "1")) // tick = 50200 (1.0001^50200 = 151.373306858723226652)

                const baseBefore = await baseToken.balanceOf(clearingHouse.address)
                const quoteBefore = await quoteToken.balanceOf(clearingHouse.address)

                // assume imRatio = 0.1
                // alice collateral = 1000, freeCollateral = 10,000, mint 50 base and 10000 quote
                await expect(
                    clearingHouse.connect(alice).addLiquidity({
                        baseToken: baseToken.address,
                        base: toWei(50, await baseToken.decimals()),
                        quote: toWei(10000, await quoteToken.decimals()),
                        lowerTick: 50000,
                        upperTick: 50400,
                    }),
                )
                    .to.emit(clearingHouse, "LiquidityChanged")
                    .withArgs(
                        alice.address,
                        baseToken.address,
                        quoteToken.address,
                        50000,
                        50400,
                        toWei(50, await baseToken.decimals()),
                        "7568665342936161336147",
                        "61828103017711334685748",
                        0,
                        0,
                    )

                // verify account states
                expect(await clearingHouse.getTokenInfo(alice.address, baseToken.address)).to.deep.eq([
                    toWei(50, await baseToken.decimals()), // available
                    toWei(100, await baseToken.decimals()), // debt
                ])
                expect(await clearingHouse.getTokenInfo(alice.address, quoteToken.address)).to.deep.eq([
                    toWei("2431.334657063838663853", await baseToken.decimals()), // available
                    toWei(10000, await quoteToken.decimals()), // debt
                ])
                expect(await clearingHouse.getOpenOrder(alice.address, baseToken.address, 50000, 50400)).to.deep.eq([
                    BigNumber.from("61828103017711334685748"), // liquidity
                    50000, // lowerTick
                    50400, // upperTick
                    toWei(0, await baseToken.decimals()), // feeGrowthInsideLastBase
                    toWei(0, await quoteToken.decimals()), // feeGrowthInsideLastQuote
                ])

                // verify CH balance changes
                expect(baseBefore.sub(await baseToken.balanceOf(clearingHouse.address))).to.eq(
                    toWei(50, await baseToken.decimals()),
                )
                expect(quoteBefore.sub(await quoteToken.balanceOf(clearingHouse.address))).to.eq(
                    "7568665342936161336147",
                )
            })

            it("add liquidity twice", async () => {
                await pool.initialize(encodePriceSqrt("151.373306858723226652", "1")) // tick = 50200 (1.0001^50200 = 151.373306858723226652)

                let baseBefore = await baseToken.balanceOf(clearingHouse.address)
                let quoteBefore = await quoteToken.balanceOf(clearingHouse.address)

                // assume imRatio = 0.1
                // alice collateral = 1000, freeCollateral = 10,000, mint 66.06184541 base and 10000 quote
                await clearingHouse.connect(alice).addLiquidity({
                    baseToken: baseToken.address,
                    base: toWei("33.030922715234742012", await baseToken.decimals()),
                    quote: toWei(5000, await quoteToken.decimals()),
                    lowerTick: 50000, // from CH's perspective, lowerTick & upperTick is still based on quote/base price, so the number is positive in our test case
                    upperTick: 50400,
                })

                await clearingHouse.connect(alice).addLiquidity({
                    baseToken: baseToken.address,
                    base: toWei("33.030922715234742012", await baseToken.decimals()),
                    quote: toWei(5000, await quoteToken.decimals()),
                    lowerTick: 50000, // from CH's perspective, lowerTick & upperTick is still based on quote/base price, so the number is positive in our test case
                    upperTick: 50400,
                })

                // verify account states
                expect(await clearingHouse.getTokenInfo(alice.address, baseToken.address)).to.deep.eq([
                    toWei("33.938154569530515976", await baseToken.decimals()), // available
                    toWei(100, await baseToken.decimals()), // debt
                ])
                expect(await clearingHouse.getTokenInfo(alice.address, quoteToken.address)).to.deep.eq([
                    toWei(0, await quoteToken.decimals()), // available
                    toWei(10000, await quoteToken.decimals()), // debt
                ])
                expect(await clearingHouse.getOpenOrder(alice.address, baseToken.address, 50000, 50400)).to.deep.eq([
                    BigNumber.from("81689571696303801018158"), // liquidity
                    50000, // lowerTick
                    50400, // upperTick
                    toWei(0, await baseToken.decimals()), // feeGrowthInsideLastBase
                    toWei(0, await quoteToken.decimals()), // feeGrowthInsideLastQuote
                ])

                // verify CH balance changes
                expect(baseBefore.sub(await baseToken.balanceOf(clearingHouse.address))).to.eq(
                    toWei("66.061845430469484024", await baseToken.decimals()),
                )
                expect(quoteBefore.sub(await quoteToken.balanceOf(clearingHouse.address))).to.eq(
                    toWei(10000, await quoteToken.decimals()),
                )
            })

            // TODO add test case with fees

            it("force error, add nothing", async () => {
                await pool.initialize(encodePriceSqrt("151.373306858723226652", "1")) // tick = 50200 (1.0001^50200 = 151.373306858723226652)
                await expect(
                    clearingHouse.connect(alice).addLiquidity({
                        baseToken: baseToken.address,
                        base: 0,
                        quote: 0,
                        lowerTick: 50000,
                        upperTick: 50200,
                    }),
                ).to.be.revertedWith("UB_ZIs")
            })

            it("force error, add base-only liquidity below price", async () => {
                await pool.initialize(encodePriceSqrt("151.373306858723226652", "1")) // tick = 50200 (1.0001^50200 = 151.373306858723226652)
                await expect(
                    clearingHouse.connect(alice).addLiquidity({
                        baseToken: baseToken.address,
                        base: toWei(1, await baseToken.decimals()),
                        quote: 0,
                        lowerTick: 50000,
                        upperTick: 50200,
                    }),
                ).to.be.revertedWith("UB_ZL")
            })

            it("force error, add quote-only liquidity above price", async () => {
                await pool.initialize(encodePriceSqrt("151.373306858723226651", "1")) // tick = 50199 (1.0001^50200 = 151.373306858723226651)
                await expect(
                    clearingHouse.connect(alice).addLiquidity({
                        baseToken: baseToken.address,
                        base: 0,
                        quote: toWei(1, await quoteToken.decimals()),
                        lowerTick: 50200,
                        upperTick: 50400,
                    }),
                ).to.be.revertedWith("UB_ZL")
            })

            it("force error, add base-only liquidity in price", async () => {
                await pool.initialize(encodePriceSqrt("151.373306858723226652", "1")) // tick = 50200 (1.0001^50200 = 151.373306858723226652)
                await expect(
                    clearingHouse.connect(alice).addLiquidity({
                        baseToken: baseToken.address,
                        base: toWei(50, await baseToken.decimals()),
                        quote: 0,
                        lowerTick: 50000,
                        upperTick: 50400,
                    }),
                ).to.be.revertedWith("UB_ZL")
            })

            it("force error, add quote-only liquidity in price", async () => {
                await pool.initialize(encodePriceSqrt("151.373306858723226652", "1")) // tick = 50200 (1.0001^50200 = 151.373306858723226652)
                await expect(
                    clearingHouse.connect(alice).addLiquidity({
                        baseToken: baseToken.address,
                        base: 0,
                        quote: toWei(10001, await quoteToken.decimals()),
                        lowerTick: 50000,
                        upperTick: 50400,
                    }),
                ).to.be.revertedWith("CH_NEQ")
            })

            it("force error, add quote over minted quote", async () => {
                await pool.initialize(encodePriceSqrt("151.373306858723226652", "1")) // tick = 50200 (1.0001^50200 = 151.373306858723226652)
                await expect(
                    clearingHouse.connect(alice).addLiquidity({
                        baseToken: baseToken.address,
                        base: toWei(101, await quoteToken.decimals()),
                        quote: 0,
                        lowerTick: 50000,
                        upperTick: 50400,
                    }),
                ).to.be.revertedWith("CH_NEB")
            })

            it("force error, add base over minted base", async () => {
                await pool.initialize(encodePriceSqrt("151.373306858723226652", "1")) // tick = 50200 (1.0001^50200 = 151.373306858723226652)
                await expect(
                    clearingHouse.connect(alice).addLiquidity({
                        baseToken: baseToken.address,
                        base: 0,
                        quote: toWei(1, await quoteToken.decimals()),
                        lowerTick: 50000,
                        upperTick: 50400,
                    }),
                ).to.be.revertedWith("UB_ZL")
            })

            it("force error, non-registered pool calls mint callback", async () => {
                const encodedData = defaultAbiCoder.encode(["address"], [baseToken.address])
                await expect(clearingHouse.uniswapV3MintCallback(123, 456, encodedData)).to.be.revertedWith("CH_FMV")
            })
        })
    })

    describe("# removeLiquidity", () => {
        describe("remove non-zero liquidity", () => {
            // @SAMPLE - removeLiquidity
            it("above current price", async () => {
                await pool.initialize(encodePriceSqrt("151.373306858723226651", "1")) // tick = 50199 (1.0001^50199 = 151.373306858723226651)

                const baseBefore = await baseToken.balanceOf(clearingHouse.address)
                const quoteBefore = await quoteToken.balanceOf(clearingHouse.address)

                // assume imRatio = 0.1
                // alice collateral = 1000, freeCollateral = 10,000, mint 100 base
                await clearingHouse.connect(alice).addLiquidity({
                    baseToken: baseToken.address,
                    base: parseEther("100"),
                    quote: 0,
                    lowerTick: 50200,
                    upperTick: 50400,
                })

                const liquidity = (await clearingHouse.getOpenOrder(alice.address, baseToken.address, 50200, 50400))
                    .liquidity

                await expect(
                    clearingHouse.connect(alice).removeLiquidity({
                        baseToken: baseToken.address,
                        lowerTick: 50200,
                        upperTick: 50400,
                        liquidity,
                    }),
                )
                    .to.emit(clearingHouse, "LiquidityChanged")
                    .withArgs(
                        alice.address,
                        baseToken.address,
                        quoteToken.address,
                        50200,
                        50400,
                        "-99999999999999999999",
                        0,
                        "-123656206035422669342231",
                        0,
                        0,
                    )

                // WIP verify account states
                expect(await clearingHouse.getTokenInfo(alice.address, baseToken.address)).to.deep.eq([
                    BigNumber.from("99999999999999999999"), // available
                    toWei(100, await baseToken.decimals()), // debt
                ])
                expect(await clearingHouse.getTokenInfo(alice.address, quoteToken.address)).to.deep.eq([
                    toWei(10000, await quoteToken.decimals()), // available
                    toWei(10000, await quoteToken.decimals()), // debt
                ])
                expect(await clearingHouse.getOpenOrder(alice.address, baseToken.address, 50200, 50400)).to.deep.eq([
                    BigNumber.from(0), // liquidity
                    0, // lowerTick
                    0, // upperTick
                    toWei(0, await baseToken.decimals()), // feeGrowthInsideLastBase
                    toWei(0, await quoteToken.decimals()), // feeGrowthInsideLastQuote
                ])

                // verify CH balance changes
                // TODO somehow Alice received 1 wei less than she deposited, it could be a problem for closing positions
                expect(baseBefore.sub(await baseToken.balanceOf(clearingHouse.address))).to.eq(1)
                expect(await quoteToken.balanceOf(clearingHouse.address)).to.eq(quoteBefore)
            })

            it("below current price", async () => {
                await pool.initialize(encodePriceSqrt("151.373306858723226652", "1")) // tick = 50200 (1.0001^50200 = 151.373306858723226652)

                const baseBefore = await baseToken.balanceOf(clearingHouse.address)
                const quoteBefore = await quoteToken.balanceOf(clearingHouse.address)

                // assume imRatio = 0.1
                // alice collateral = 1000, freeCollateral = 10,000, mint 10,000 quote
                await clearingHouse.connect(alice).addLiquidity({
                    baseToken: baseToken.address,
                    base: 0,
                    quote: toWei(10000, await quoteToken.decimals()),
                    lowerTick: 50000,
                    upperTick: 50200,
                })

                const liquidity = (await clearingHouse.getOpenOrder(alice.address, baseToken.address, 50000, 50200))
                    .liquidity

                await expect(
                    clearingHouse.connect(alice).removeLiquidity({
                        baseToken: baseToken.address,
                        lowerTick: 50000,
                        upperTick: 50200,
                        liquidity,
                    }),
                )
                    .to.emit(clearingHouse, "LiquidityChanged")
                    .withArgs(
                        alice.address,
                        baseToken.address,
                        quoteToken.address,
                        50000,
                        50200,
                        0,
                        "-9999999999999999999999", // ~= -10,000
                        "-81689571696303801037492",
                        0,
                        0,
                    )

                // verify account states
                expect(await clearingHouse.getTokenInfo(alice.address, baseToken.address)).to.deep.eq([
                    toWei(100, await baseToken.decimals()), // available
                    toWei(100, await baseToken.decimals()), // debt
                ])
                expect(await clearingHouse.getTokenInfo(alice.address, quoteToken.address)).to.deep.eq([
                    BigNumber.from("9999999999999999999999"), // available, ~= -10,000
                    toWei(10000, await quoteToken.decimals()), // debt
                ])
                expect(await clearingHouse.getOpenOrder(alice.address, baseToken.address, 50000, 50200)).to.deep.eq([
                    BigNumber.from(0), // liquidity
                    0, // lowerTick
                    0, // upperTick
                    toWei(0, await baseToken.decimals()), // feeGrowthInsideLastBase
                    toWei(0, await quoteToken.decimals()), // feeGrowthInsideLastQuote
                ])

                // verify CH balance changes
                expect(await baseToken.balanceOf(clearingHouse.address)).to.eq(baseBefore)
                expect(quoteBefore.sub(await quoteToken.balanceOf(clearingHouse.address))).to.eq(1)
            })

            it("at current price", async () => {
                await pool.initialize(encodePriceSqrt("151.373306858723226652", "1")) // tick = 50200 (1.0001^50200 = 151.373306858723226652)

                const baseBefore = await baseToken.balanceOf(clearingHouse.address)
                const quoteBefore = await quoteToken.balanceOf(clearingHouse.address)

                // assume imRatio = 0.1
                // alice collateral = 1000, freeCollateral = 10,000, mint 100 base and 10000 quote
                await clearingHouse.connect(alice).addLiquidity({
                    baseToken: baseToken.address,
                    base: toWei("100", await baseToken.decimals()),
                    quote: toWei(10000, await quoteToken.decimals()),
                    lowerTick: 50000,
                    upperTick: 50400,
                })

                const liquidity = (await clearingHouse.getOpenOrder(alice.address, baseToken.address, 50000, 50400))
                    .liquidity

                await expect(
                    clearingHouse.connect(alice).removeLiquidity({
                        baseToken: baseToken.address,
                        lowerTick: 50000,
                        upperTick: 50400,
                        liquidity,
                    }),
                )
                    .to.emit(clearingHouse, "LiquidityChanged")
                    .withArgs(
                        alice.address,
                        baseToken.address,
                        quoteToken.address,
                        50000,
                        50400,
                        toWei("-66.061845430469484022", await baseToken.decimals()),
                        "-9999999999999999999999",
                        "-81689571696303801018159",
                        0,
                        0,
                    )

                // verify account states
                expect(await clearingHouse.getTokenInfo(alice.address, baseToken.address)).to.deep.eq([
                    BigNumber.from("99999999999999999999"), // available
                    toWei(100, await baseToken.decimals()), // debt
                ])
                expect(await clearingHouse.getTokenInfo(alice.address, quoteToken.address)).to.deep.eq([
                    BigNumber.from("9999999999999999999999"), // available
                    toWei(10000, await quoteToken.decimals()), // debt
                ])
                expect(await clearingHouse.getOpenOrder(alice.address, baseToken.address, 50000, 50400)).to.deep.eq([
                    BigNumber.from(0), // liquidity
                    0, // lowerTick
                    0, // upperTick
                    toWei(0, await baseToken.decimals()), // feeGrowthInsideLastBase
                    toWei(0, await quoteToken.decimals()), // feeGrowthInsideLastQuote
                ])

                // verify CH balance changes
                expect(baseBefore.sub(await baseToken.balanceOf(clearingHouse.address))).to.eq(1)
                expect(quoteBefore.sub(await quoteToken.balanceOf(clearingHouse.address))).to.eq(1)
            })

            it("twice", async () => {
                await pool.initialize(encodePriceSqrt("151.373306858723226652", "1")) // tick = 50200 (1.0001^50200 = 151.373306858723226652)

                const baseBefore = await baseToken.balanceOf(clearingHouse.address)
                const quoteBefore = await quoteToken.balanceOf(clearingHouse.address)

                // assume imRatio = 0.1
                // alice collateral = 1000, freeCollateral = 10,000, mint 100 base and 10000 quote
                await clearingHouse.connect(alice).addLiquidity({
                    baseToken: baseToken.address,
                    base: toWei("100", await baseToken.decimals()),
                    quote: toWei(10000, await quoteToken.decimals()),
                    lowerTick: 50000,
                    upperTick: 50400,
                })

                const liquidity = (await clearingHouse.getOpenOrder(alice.address, baseToken.address, 50000, 50400))
                    .liquidity

                const firstRemoveLiquidity = liquidity.div(2)
                await clearingHouse.connect(alice).removeLiquidity({
                    baseToken: baseToken.address,
                    lowerTick: 50000,
                    upperTick: 50400,
                    liquidity: firstRemoveLiquidity,
                })

                const secondRemoveLiquidity = liquidity.sub(firstRemoveLiquidity)
                await clearingHouse.connect(alice).removeLiquidity({
                    baseToken: baseToken.address,
                    lowerTick: 50000,
                    upperTick: 50400,
                    liquidity: secondRemoveLiquidity,
                })

                // verify account states
                expect(await clearingHouse.getTokenInfo(alice.address, baseToken.address)).to.deep.eq([
                    BigNumber.from("99999999999999999999"), // available, ~= 100
                    toWei(100, await baseToken.decimals()), // debt
                ])
                expect(await clearingHouse.getTokenInfo(alice.address, quoteToken.address)).to.deep.eq([
                    BigNumber.from("9999999999999999999999"), // available ~= 10,000
                    toWei(10000, await quoteToken.decimals()), // debt
                ])
                expect(await clearingHouse.getOpenOrder(alice.address, baseToken.address, 50000, 50400)).to.deep.eq([
                    BigNumber.from(0), // liquidity
                    0, // lowerTick
                    0, // upperTick
                    toWei(0, await baseToken.decimals()), // feeGrowthInsideLastBase
                    toWei(0, await quoteToken.decimals()), // feeGrowthInsideLastQuote
                ])

                // verify CH balance changes
                expect(baseBefore.sub(await baseToken.balanceOf(clearingHouse.address))).to.eq(1)
                expect(quoteBefore.sub(await quoteToken.balanceOf(clearingHouse.address))).to.eq(1)
            })

            it("force error, remove too much liquidity", async () => {
                await pool.initialize(encodePriceSqrt("151.373306858723226652", "1")) // tick = 50200 (1.0001^50200 = 151.373306858723226652)

                const baseBefore = await baseToken.balanceOf(clearingHouse.address)
                const quoteBefore = await quoteToken.balanceOf(clearingHouse.address)

                // assume imRatio = 0.1
                // alice collateral = 1000, freeCollateral = 10,000, mint 100 base and 10000 quote
                await clearingHouse.connect(alice).addLiquidity({
                    baseToken: baseToken.address,
                    base: toWei("100", await baseToken.decimals()),
                    quote: toWei(10000, await quoteToken.decimals()),
                    lowerTick: 50000,
                    upperTick: 50400,
                })
                const liquidity = (await clearingHouse.getOpenOrder(alice.address, baseToken.address, 50000, 50400))
                    .liquidity

                await expect(
                    clearingHouse.connect(alice).removeLiquidity({
                        baseToken: baseToken.address,
                        lowerTick: 50000,
                        upperTick: 50400,
                        liquidity: liquidity.add(1),
                    }),
                ).to.be.revertedWith("CH_NEL")
            })

            it("force error, pool does not exist", async () => {
                await expect(
                    clearingHouse.connect(alice).removeLiquidity({
                        baseToken: quoteToken.address,
                        lowerTick: 0,
                        upperTick: 200,
                        liquidity: BigNumber.from(1),
                    }),
                ).to.be.revertedWith("CH_ZL")
            })

            it("force error, range does not exist", async () => {
                await pool.initialize(encodePriceSqrt("151.373306858723226652", "1")) // tick = 50200 (1.0001^50200 = 151.373306858723226652)

                // assume imRatio = 0.1
                // alice collateral = 1000, freeCollateral = 10,000, mint 100 base and 10000 quote
                await clearingHouse.connect(alice).addLiquidity({
                    baseToken: baseToken.address,
                    base: toWei("100", await baseToken.decimals()),
                    quote: toWei(10000, await quoteToken.decimals()),
                    lowerTick: 50000,
                    upperTick: 50400,
                })

                await expect(
                    clearingHouse.connect(alice).removeLiquidity({
                        baseToken: baseToken.address,
                        lowerTick: 50000,
                        upperTick: 50200,
                        liquidity: BigNumber.from(1),
                    }),
                ).to.be.revertedWith("CH_ZL")
            })
        })

        describe("remove zero liquidity, expect to collect fee", () => {
            it("no swap, no fee, the amounts are not changed", async () => {
                await pool.initialize(encodePriceSqrt("151.373306858723226652", "1")) // tick = 50200 (1.0001^50200 = 151.373306858723226652)

                const baseBefore = await baseToken.balanceOf(clearingHouse.address)
                const quoteBefore = await quoteToken.balanceOf(clearingHouse.address)

                // assume imRatio = 0.1
                // alice collateral = 1000, freeCollateral = 10,000, mint 100 base and 10000 quote
                await clearingHouse.connect(alice).addLiquidity({
                    baseToken: baseToken.address,
                    base: toWei("100", await baseToken.decimals()),
                    quote: toWei(10000, await quoteToken.decimals()),
                    lowerTick: 50000,
                    upperTick: 50400,
                })
                const liquidity = (await clearingHouse.getOpenOrder(alice.address, baseToken.address, 50000, 50400))
                    .liquidity

                await expect(
                    clearingHouse.connect(alice).removeLiquidity({
                        baseToken: baseToken.address,
                        lowerTick: 50000,
                        upperTick: 50400,
                        liquidity: 0,
                    }),
                )
                    .to.emit(clearingHouse, "LiquidityChanged")
                    .withArgs(alice.address, baseToken.address, quoteToken.address, 50000, 50400, 0, 0, 0, 0, 0)

                // verify account states
                expect(await clearingHouse.getTokenInfo(alice.address, baseToken.address)).to.deep.eq([
                    BigNumber.from("33938154569530515977"), // available
                    toWei(100, await baseToken.decimals()), // debt
                ])
                expect(await clearingHouse.getTokenInfo(alice.address, quoteToken.address)).to.deep.eq([
                    BigNumber.from(0), // available
                    toWei(10000, await quoteToken.decimals()), // debt
                ])
                expect(await clearingHouse.getOpenOrder(alice.address, baseToken.address, 50000, 50400)).to.deep.eq([
                    liquidity,
                    50000, // lowerTick
                    50400, // upperTick
                    toWei(0, await baseToken.decimals()), // feeGrowthInsideLastBase
                    toWei(0, await quoteToken.decimals()), // feeGrowthInsideLastQuote
                ])

                // verify CH balance changes
                expect(baseBefore.sub(await baseToken.balanceOf(clearingHouse.address))).to.eq(
                    BigNumber.from("66061845430469484023"),
                )
                expect(quoteBefore.sub(await quoteToken.balanceOf(clearingHouse.address))).to.eq(
                    toWei(10000, await quoteToken.decimals()),
                )
            })

            describe("one maker; current price is in maker's range", () => {
                it("received 0.000004125357782999 base as fee, if a trader swaps 0.0004125357783 base to 0.06151334176 quote in maker's range", async () => {
                    await pool.initialize(encodePriceSqrt(151.3733069, 1))
                    const baseBefore = await baseToken.balanceOf(clearingHouse.address)
                    const quoteBefore = await quoteToken.balanceOf(clearingHouse.address)

                    const lowerTick = "50000"
                    const upperTick = "50200"

                    // alice add liquidity
                    const addLiquidityParams = {
                        baseToken: baseToken.address,
                        base: "0",
                        quote: parseEther("0.122414646"),
                        lowerTick, // 148.3760629
                        upperTick, // 151.3733069
                    }
                    await clearingHouse.connect(alice).addLiquidity(addLiquidityParams)

                    // liquidity ~= 1
                    const liquidity = (
                        await clearingHouse.getOpenOrder(alice.address, baseToken.address, lowerTick, upperTick)
                    ).liquidity

                    // bob swap
                    // base: 0.0004084104205 / 0.99 = 0.0004125357783
                    // to quote: 0.06151334176
                    const swapParams = {
                        baseToken: baseToken.address,
                        quoteToken: quoteToken.address,
                        isBaseToQuote: true,
                        isExactInput: true,
                        amount: parseEther("0.0004125357783"),
                        sqrtPriceLimitX96: "0",
                    }
                    await clearingHouse.connect(bob).swap(swapParams)

                    // alice remove liq 0, alice should collect fee
                    const removeLiquidityParams = {
                        baseToken: baseToken.address,
                        lowerTick,
                        upperTick,
                        liquidity: "0",
                    }
                    // expect 1% of base = 0.000004125357783
                    // there's one wei of imprecision, thus expecting 0.000004125357782999
                    await expect(clearingHouse.connect(alice).removeLiquidity(removeLiquidityParams))
                        .to.emit(clearingHouse, "LiquidityChanged")
                        .withArgs(
                            alice.address,
                            baseToken.address,
                            quoteToken.address,
                            Number(lowerTick),
                            Number(upperTick),
                            "0",
                            "0",
                            "0",
                            "4125357782999",
                            "0",
                        )

                    // 100 + 0.000004125357782999 = 100.000004125357782999
                    expect(await clearingHouse.getTokenInfo(alice.address, baseToken.address)).to.deep.eq([
                        parseEther("100.000004125357782999"), // available
                        parseEther("100"), // debt
                    ])
                    // 10000 - 0.122414646 = 9999.877585354
                    expect(await clearingHouse.getTokenInfo(alice.address, quoteToken.address)).to.deep.eq([
                        parseEther("9999.877585354"), // available
                        parseEther("10000"), // debt
                    ])
                    // FIXME: skipping Bob's balances as currently the logic of swap() does not include balance updates

                    // there is only fee in base
                    // 0.000004125357782999 * 2 ^ 128 = 1.403786511E33
                    // = 1403786511000000000000000000000000
                    // ~= 1403786510641289842386614013865363
                    expect(
                        await clearingHouse.getOpenOrder(alice.address, baseToken.address, lowerTick, upperTick),
                    ).to.deep.eq([
                        liquidity,
                        Number(lowerTick), // lowerTick
                        Number(upperTick), // upperTick
                        // add the decimal point to prevent overflow, according to the following 10^18 comparison
                        // 1403786510641289842386614013865363
                        //                1000000000000000000
                        parseEther("1403786510641289.842386614013865363"), // feeGrowthInsideLastBase
                        parseEther("0"), // feeGrowthInsideLastQuote
                    ])

                    // verify CH balance changes
                    // base diff: 0.0004125357783 (bob swaps) - 0.000004125357782999 (alice removeLiquidity) = 0.0004084104205
                    expect(baseBefore.sub(await baseToken.balanceOf(clearingHouse.address))).to.eq(
                        parseEther("0.000408410420517001"),
                    )
                    // quote diff: 0.122414646 (alice addLiquidity) - 0.06151334176 (bob gets (from swap)) = 0.06090130424
                    expect(quoteBefore.sub(await quoteToken.balanceOf(clearingHouse.address))).to.eq(
                        parseEther("0.060901304240202072"),
                    )
                })

                it("received 0.001135501475 quote as fee, if a trader swaps 0.1135501475 quote to 0.0007507052579 base in maker's range", async () => {
                    await pool.initialize(encodePriceSqrt(148.3760629, 1))
                    const baseBefore = await baseToken.balanceOf(clearingHouse.address)
                    const quoteBefore = await quoteToken.balanceOf(clearingHouse.address)

                    const lowerTick = "50000"
                    const upperTick = "50200"

                    // add base liquidity
                    const addLiquidityParams = {
                        baseToken: baseToken.address,
                        lowerTick, // 148.3760629
                        upperTick, // 151.3733069
                        base: parseEther("0.000816820841"),
                        quote: "0",
                    }
                    await clearingHouse.connect(alice).addLiquidity(addLiquidityParams)

                    // liquidity ~= 1
                    const liquidity = (
                        await clearingHouse.getOpenOrder(alice.address, baseToken.address, lowerTick, upperTick)
                    ).liquidity

                    // bob swap
                    // quote: 0.112414646 / 0.99 = 0.1135501475
                    // to base: 0.0007507052579
                    const swapParams = {
                        baseToken: baseToken.address,
                        quoteToken: quoteToken.address,
                        isBaseToQuote: false,
                        isExactInput: true,
                        amount: parseEther("0.1135501475"),
                        sqrtPriceLimitX96: "0",
                    }
                    await clearingHouse.connect(bob).swap(swapParams)

                    // alice remove liq 0, alice should collect fee
                    const removeLiquidityParams = {
                        baseToken: baseToken.address,
                        lowerTick,
                        upperTick,
                        liquidity: "0",
                    }

                    // expect 1% of quote = 0.001135501475
                    // there's one wei of imprecision, thus expecting 0.001135501474999999
                    await expect(clearingHouse.connect(alice).removeLiquidity(removeLiquidityParams))
                        .to.emit(clearingHouse, "LiquidityChanged")
                        .withArgs(
                            alice.address,
                            baseToken.address,
                            quoteToken.address,
                            Number(lowerTick),
                            Number(upperTick),
                            "0",
                            "0",
                            "0",
                            "0",
                            parseEther("0.001135501474999999"),
                        )

                    // 10000 + 0.001135501474999999 = 10000.001135501474999999
                    expect(await clearingHouse.getTokenInfo(alice.address, quoteToken.address)).to.deep.eq([
                        parseEther("10000.001135501474999999"), // available
                        parseEther("10000"), // debt
                    ])
                    // FIXME: skipping Bob's balances as currently the logic of swap() does not include balance updates

                    // there is only fee in base
                    // 0.001135501474999999 * 2 ^ 128 = 3.863911296E35
                    expect(
                        await clearingHouse.getOpenOrder(alice.address, baseToken.address, lowerTick, upperTick),
                    ).to.deep.eq([
                        liquidity,
                        Number(lowerTick), // lowerTick
                        Number(upperTick), // upperTick
                        // add the decimal point to prevent overflow, according to the following 10^18 comparison
                        // 386391129557376066102652522378417873
                        //                  1000000000000000000
                        parseEther("0"), // feeGrowthInsideLastBase
                        parseEther("386391129557376066.102652522378417873"), // feeGrowthInsideLastQuote
                    ])

                    // verify CH balance changes
                    // base diff: 0.000816820841 (alice addLiquidity) - 0.0007507052579 (bob swap) = 0.0000661155831
                    expect(baseBefore.sub(await baseToken.balanceOf(clearingHouse.address))).to.eq(
                        parseEther("0.000066115582885348"),
                    )
                    // quote diff: 0.1135501475 (bob swap) - 0.001135501475 (alice removeLiquidity) = 0.112414646
                    expect(quoteBefore.sub(await quoteToken.balanceOf(clearingHouse.address))).to.eq(
                        parseEther("0.112414646025000001"),
                    )
                })

                it.only("received ? quote and ? base as fee, if a trader swaps ? quote -> ? base and ? base -> ? quote happened in maker's range", async () => {
                    await pool.initialize(encodePriceSqrt(148.3760629, 1))
                    const baseBefore = await baseToken.balanceOf(clearingHouse.address)
                    const quoteBefore = await quoteToken.balanceOf(clearingHouse.address)

                    const lowerTick = "50000"
                    const upperTick = "50200"

                    // add base liquidity
                    const addLiquidityParams = {
                        baseToken: baseToken.address,
                        lowerTick, // 148.3760629
                        upperTick, // 151.3733069
                        base: parseEther("0.000816820841"),
                        quote: "0",
                    }
                    await clearingHouse.connect(alice).addLiquidity(addLiquidityParams)

                    // liquidity ~= 1
                    const liquidity = (
                        await clearingHouse.getOpenOrder(alice.address, baseToken.address, lowerTick, upperTick)
                    ).liquidity

                    // bob swap
                    // quote: 0.112414646 / 0.99 = 0.1135501475
                    // to base: 0.0007507052579
                    const swapParams = {
                        baseToken: baseToken.address,
                        quoteToken: quoteToken.address,
                        isBaseToQuote: false,
                        isExactInput: true,
                        amount: parseEther("0.1135501475"),
                        sqrtPriceLimitX96: "0",
                    }
                    await clearingHouse.connect(bob).swap(swapParams)

                    // alice remove liq 0, alice should collect fee
                    const removeLiquidityParams = {
                        baseToken: baseToken.address,
                        lowerTick,
                        upperTick,
                        liquidity: "0",
                    }

                    // expect 1% of quote = 0.001135501475
                    // there's one wei of imprecision, thus expecting 0.001135501474999999
                    await expect(clearingHouse.connect(alice).removeLiquidity(removeLiquidityParams))
                        .to.emit(clearingHouse, "LiquidityChanged")
                        .withArgs(
                            alice.address,
                            baseToken.address,
                            quoteToken.address,
                            Number(lowerTick),
                            Number(upperTick),
                            "0",
                            "0",
                            "0",
                            "0",
                            parseEther("0.001135501474999999"),
                        )

                    // verify account states
                    console.log("alice, base, available")
                    console.log((await clearingHouse.getTokenInfo(alice.address, baseToken.address))[0].toString())
                    console.log("alice, base, debt")
                    console.log((await clearingHouse.getTokenInfo(alice.address, baseToken.address))[1].toString())
                    console.log("alice, quote, available")
                    console.log((await clearingHouse.getTokenInfo(alice.address, quoteToken.address))[0].toString())
                    console.log("alice, quote, debt")
                    console.log((await clearingHouse.getTokenInfo(alice.address, quoteToken.address))[1].toString())
                    console.log("feeGrowthInsideLastBase")
                    console.log(
                        (
                            await clearingHouse.getOpenOrder(alice.address, baseToken.address, lowerTick, upperTick)
                        )[3].toString(),
                    )
                    console.log("feeGrowthInsideLastQuote")
                    console.log(
                        (
                            await clearingHouse.getOpenOrder(alice.address, baseToken.address, lowerTick, upperTick)
                        )[4].toString(),
                    )
                    console.log("base diff")
                    console.log(baseBefore.sub(await baseToken.balanceOf(clearingHouse.address)).toString())
                    console.log("quote diff")
                    console.log(quoteBefore.sub(await quoteToken.balanceOf(clearingHouse.address)).toString())

                    // 100 - 0.000816820841 = 99.999183179159000000
                    expect(await clearingHouse.getTokenInfo(alice.address, baseToken.address)).to.deep.eq([
                        parseEther("99.999183179159000000"), // available
                        parseEther("100"), // debt
                    ])
                    // 10000 + 0.001135501474999999 = 10000.001135501474999999
                    expect(await clearingHouse.getTokenInfo(alice.address, quoteToken.address)).to.deep.eq([
                        parseEther("10000.001135501474999999"), // available
                        parseEther("10000"), // debt
                    ])
                    // FIXME: skipping Bob's balances as currently the logic of swap() does not include balance updates

                    // there is only fee in base
                    // 0.001135501474999999 * 2 ^ 128 = 3.863911296E35
                    expect(
                        await clearingHouse.getOpenOrder(alice.address, baseToken.address, lowerTick, upperTick),
                    ).to.deep.eq([
                        liquidity,
                        Number(lowerTick), // lowerTick
                        Number(upperTick), // upperTick
                        // add the decimal point to prevent overflow, according to the following 10^18 comparison
                        // 386391129557376066102652522378417873
                        //                  1000000000000000000
                        parseEther("0"), // feeGrowthInsideLastBase
                        parseEther("386391129557376066.102652522378417873"), // feeGrowthInsideLastQuote
                    ])

                    // verify CH balance changes
                    // base diff: 0.000816820841 (alice addLiquidity) - 0.0007507052579 (bob swap) = 0.0000661155831
                    expect(baseBefore.sub(await baseToken.balanceOf(clearingHouse.address))).to.eq(
                        parseEther("0.000066115582885348"),
                    )
                    // quote diff: 0.1135501475 (bob swap) - 0.001135501475 (alice removeLiquidity) = 0.112414646
                    expect(quoteBefore.sub(await quoteToken.balanceOf(clearingHouse.address))).to.eq(
                        parseEther("0.112414646025000001"),
                    )
                })
            })

            describe("multi makers", () => {
                describe("current price is in maker's range", () => {
                    it("received quote and base, if swap quote -> base and base -> quote happened in my range", async () => {})

                    it("cannot receive tx fee after removed liquidity", async () => {})
                })

                describe("out of maker's range", () => {
                    it("received nothing, if a trader swap 1000 quote to base in my range", async () => {})
                })
            })
        })
    })
})
