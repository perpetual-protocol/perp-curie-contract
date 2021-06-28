import { defaultAbiCoder } from "@ethersproject/abi"
import { expect } from "chai"
import { BigNumber } from "ethers"
import { waffle } from "hardhat"
import { ClearingHouse, TestERC20, UniswapV3Pool } from "../../typechain"
import { toWei } from "../helper/number"
import { encodePriceSqrt } from "../shared/utilities"
import { BaseQuoteOrdering, createClearingHouseFixture } from "./fixtures"

describe("ClearingHouse", () => {
    const EMPTY_ADDRESS = "0x0000000000000000000000000000000000000000"
    const [admin, alice] = waffle.provider.getWallets()
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

        // prepare collateral
        const amount = toWei(1000, await collateral.decimals())
        await collateral.transfer(alice.address, amount)
        await collateral.connect(alice).approve(clearingHouse.address, amount)
        await clearingHouse.connect(alice).deposit(amount)

        // add pool
        await clearingHouse.addPool(baseToken.address, 10000)

        // mint
        const baseAmount = toWei(100, await baseToken.decimals())
        const quoteAmount = toWei(10000, await quoteToken.decimals())
        await clearingHouse.connect(alice).mint(baseToken.address, baseAmount)
        await clearingHouse.connect(alice).mint(quoteToken.address, quoteAmount)
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
        // @SAMPLE - removeLiquidity
        it("remove liquidity above current price", async () => {
            await pool.initialize(encodePriceSqrt("151.373306858723226651", "1")) // tick = 50199 (1.0001^50199 = 151.373306858723226651)

            const baseBefore = await baseToken.balanceOf(clearingHouse.address)
            const quoteBefore = await quoteToken.balanceOf(clearingHouse.address)

            // assume imRatio = 0.1
            // alice collateral = 1000, freeCollateral = 10,000, mint 100 base
            await clearingHouse.connect(alice).addLiquidity({
                baseToken: baseToken.address,
                base: toWei(100, await baseToken.decimals()),
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

        it("remove liquidity below current price", async () => {
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

        it("remove liquidity at current price", async () => {
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

        it("remove liquidity twice", async () => {
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

        it("remove zero liquidity", async () => {
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
})
