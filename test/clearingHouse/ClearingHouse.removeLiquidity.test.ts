import { keccak256 } from "@ethersproject/solidity"
import { expect } from "chai"
import { BigNumber } from "ethers"
import { parseEther } from "ethers/lib/utils"
import { waffle } from "hardhat"
import { ClearingHouse, TestERC20, UniswapV3Pool } from "../../typechain"
import { toWei } from "../helper/number"
import { encodePriceSqrt } from "../shared/utilities"
import { BaseQuoteOrdering, createClearingHouseFixture } from "./fixtures"

describe("ClearingHouse", () => {
    const EMPTY_ADDRESS = "0x0000000000000000000000000000000000000000"
    const [admin, alice, bob, carol] = waffle.provider.getWallets()
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

        // prepare collateral for carol
        await collateral.transfer(carol.address, amount)
        await collateral.connect(carol).approve(clearingHouse.address, amount)
        await clearingHouse.connect(carol).deposit(amount)

        // add pool
        await clearingHouse.addPool(baseToken.address, 10000)

        // mint
        const baseAmount = toWei(100, await baseToken.decimals())
        const quoteAmount = toWei(10000, await quoteToken.decimals())
        await clearingHouse.connect(alice).mint(baseToken.address, baseAmount)
        await clearingHouse.connect(alice).mint(quoteToken.address, quoteAmount)
        await clearingHouse.connect(bob).mint(baseToken.address, baseAmount)
        await clearingHouse.connect(bob).mint(quoteToken.address, quoteAmount)
        await clearingHouse.connect(carol).mint(baseToken.address, baseAmount)
        await clearingHouse.connect(carol).mint(quoteToken.address, quoteAmount)
    })

    // simulation results:
    // https://docs.google.com/spreadsheets/d/1xcWBBcQYwWuWRdlHtNv64tOjrBCnnvj_t1WEJaQv8EY/edit#gid=1155466937
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
                expect(await clearingHouse.getOpenOrderIds(alice.address, baseToken.address)).to.be.empty
                expect(await clearingHouse.getOpenOrder(alice.address, baseToken.address, 50200, 50400)).to.deep.eq([
                    BigNumber.from(0), // liquidity
                    0, // lowerTick
                    0, // upperTick
                    toWei(0, await baseToken.decimals()), // feeGrowthInsideLastBase
                    toWei(0, await quoteToken.decimals()), // feeGrowthInsideLastQuote
                ])

                // verify CH balance changes
                // TODO somehow Alice receives 1 wei less than she deposited, it could be a problem for closing positions
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
                expect(await clearingHouse.getOpenOrderIds(alice.address, baseToken.address)).to.be.empty
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
                expect(await clearingHouse.getOpenOrderIds(alice.address, baseToken.address)).to.be.empty
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
                expect(await clearingHouse.getOpenOrderIds(alice.address, baseToken.address)).to.be.empty
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
                        baseToken: collateral.address, // can't use quote token because _settleFunding would revert first
                        lowerTick: 0,
                        upperTick: 200,
                        liquidity: BigNumber.from(1),
                    }),
                ).to.be.revertedWith("CH_TNF")
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
                ).to.be.revertedWith("CH_NEO")
            })
        })

        describe("remove zero liquidity, expect to collect fee", () => {
            it("no swap no fee", async () => {
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
                expect(await clearingHouse.getOpenOrderIds(alice.address, baseToken.address)).to.deep.eq([
                    keccak256(
                        ["address", "address", "int24", "int24"],
                        [alice.address, baseToken.address, 50000, 50400],
                    ),
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
                it("receives 0.000004125357782999 base as fee, if a trader swaps 0.0004125357783 base to 0.06151334176 quote", async () => {
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

                it("receives 0.001135501475 quote as fee, if a trader swaps 0.1135501475 quote to 0.0007507052579 base", async () => {
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
                    // base diff: 0.000816820841 (alice addLiquidity) - 0.0007507052579 (bob gets (from swap)) = 0.0000661155831
                    expect(baseBefore.sub(await baseToken.balanceOf(clearingHouse.address))).to.eq(
                        parseEther("0.000066115582885348"),
                    )
                    // quote diff: 0.1135501475 (bob swap) - 0.001135501475 (alice removeLiquidity) = 0.112414646
                    expect(quoteBefore.sub(await quoteToken.balanceOf(clearingHouse.address))).to.eq(
                        parseEther("0.112414646025000001"),
                    )
                })

                it("receives 0.000007582881393 base and 0.001135501475 quote as fee, if a trader swaps 0.1135501475 quote -> 0.0007507052579 base and 0.0007582881392 base -> 0.112414646 quote", async () => {
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
                    const swapParams1 = {
                        baseToken: baseToken.address,
                        isBaseToQuote: false,
                        isExactInput: true,
                        amount: parseEther("0.1135501475"),
                        sqrtPriceLimitX96: "0",
                    }
                    await clearingHouse.connect(bob).swap(swapParams1)

                    // To achieve the same price after two swaps, Bob is using more base than he gets from the previous swap
                    // base: 0.0007507052579 / 0.99 = 0.0007582881393 (> 0.0007507052579)
                    // to quote: ~= 0.112414646
                    const swapParams2 = {
                        baseToken: baseToken.address,
                        isBaseToQuote: true,
                        isExactInput: true,
                        amount: parseEther("0.0007582881393"),
                        sqrtPriceLimitX96: "0",
                    }
                    await clearingHouse.connect(bob).swap(swapParams2)

                    // alice remove liq 0, alice should collect fee
                    const removeLiquidityParams = {
                        baseToken: baseToken.address,
                        lowerTick,
                        upperTick,
                        liquidity: "0",
                    }

                    // expect 1% of base = 0.000007582881393
                    // expect 1% of quote = 0.001135501475
                    // there's one wei of imprecision, thus expecting 0.000007582881391999 & 0.001135501474999999
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
                            parseEther("0.000007582881392999"),
                            parseEther("0.001135501474999999"),
                        )

                    // 100 - 0.000816820841 + 0.000007582881393 = 99.999190762
                    expect(await clearingHouse.getTokenInfo(alice.address, baseToken.address)).to.deep.eq([
                        parseEther("99.999190762040392999"), // available
                        parseEther("100"), // debt
                    ])
                    // 10000 + 0.001135501474999999 = 10000.001135501474999999
                    expect(await clearingHouse.getTokenInfo(alice.address, quoteToken.address)).to.deep.eq([
                        parseEther("10000.001135501474999999"), // available
                        parseEther("10000"), // debt
                    ])
                    // FIXME: skipping Bob's balances as currently the logic of swap() does not include balance updates

                    // feeGrowthInsideLastBase: 0.000007582881393 * 2 ^ 128 = 2.580320828E33
                    // feeGrowthInsideLastQuote: 0.001135501474999999 * 2 ^ 128 = 3.863911296E35
                    expect(
                        await clearingHouse.getOpenOrder(alice.address, baseToken.address, lowerTick, upperTick),
                    ).to.deep.eq([
                        liquidity,
                        Number(lowerTick), // lowerTick
                        Number(upperTick), // upperTick
                        // add the decimal point to prevent overflow, according to the following 10^18 comparison
                        //   2580320828505202335869569733397150
                        // 386391129557376066102652522378417873
                        //                  1000000000000000000
                        parseEther("2580320828505202.335869569733397150"), // feeGrowthInsideLastBase
                        parseEther("386391129557376066.102652522378417873"), // feeGrowthInsideLastQuote
                    ])

                    // verify CH balance changes
                    // base diff: 0.000816820841 (alice addLiquidity) - 0.0007507052579 (bob gets (from swap)) +
                    // 0.0007582881393 (bob swap) - 0.000007582881393 (alice removeLiquidity) = 0.000816820841
                    expect(baseBefore.sub(await baseToken.balanceOf(clearingHouse.address))).to.eq(
                        parseEther("0.000816820840792349"),
                    )
                    // quote diff: 0.1135501475 (bob swap) - 0.001135501475 (alice removeLiquidity) - 0.112414646 (bob gets (from swap)) = 2.5E-11
                    expect(quoteBefore.sub(await quoteToken.balanceOf(clearingHouse.address))).to.eq(
                        // 30810663 == 3.0810663E-11
                        parseEther("0.000000000030810663"),
                    )
                })
            })

            describe("multi makers", () => {
                // expect to have more tests
                describe("current price is in makers' range:", () => {
                    it("alice receives 3/4 of fee, while carol receives only 1/4", async () => {
                        await pool.initialize(encodePriceSqrt(148.3760629, 1))
                        const baseBefore = await baseToken.balanceOf(clearingHouse.address)
                        const quoteBefore = await quoteToken.balanceOf(clearingHouse.address)

                        const lowerTick = "50000"
                        const upperTick = "50200"
                        const base = 0.000816820841

                        // add base liquidity
                        // 0.000816820841 * 3 = 0.002450462523
                        const addLiquidityParamsAlice = {
                            baseToken: baseToken.address,
                            lowerTick, // 148.3760629
                            upperTick, // 151.3733069
                            base: parseEther((base * 3).toString()),
                            quote: "0",
                        }
                        await clearingHouse.connect(alice).addLiquidity(addLiquidityParamsAlice)

                        // add base liquidity
                        const addLiquidityParamsCarol = {
                            baseToken: baseToken.address,
                            lowerTick, // 148.3760629
                            upperTick, // 151.3733069
                            base: parseEther(base.toString()),
                            quote: "0",
                        }
                        await clearingHouse.connect(carol).addLiquidity(addLiquidityParamsCarol)

                        // liquidity ~= 3
                        const liquidityAlice = (
                            await clearingHouse.getOpenOrder(alice.address, baseToken.address, lowerTick, upperTick)
                        ).liquidity

                        // liquidity ~= 1
                        const liquidityCarol = (
                            await clearingHouse.getOpenOrder(carol.address, baseToken.address, lowerTick, upperTick)
                        ).liquidity

                        // bob swap
                        // quote: 0.112414646 / 0.99 = 0.1135501475
                        // to base: 0.0007558893279
                        const swapParams1 = {
                            baseToken: baseToken.address,
                            isBaseToQuote: false,
                            isExactInput: true,
                            amount: parseEther("0.1135501475"),
                            sqrtPriceLimitX96: "0",
                        }
                        await clearingHouse.connect(bob).swap(swapParams1)

                        // Note that Bob does not use all base he gets to swap into quote here
                        // base: 0.0007507052579 (instead of 0.0007558893279) / 0.99 = 0.0007582881393
                        // to quote: ~= 0.1116454419
                        const swapParams2 = {
                            baseToken: baseToken.address,
                            isBaseToQuote: true,
                            isExactInput: true,
                            amount: parseEther("0.0007582881393"),
                            sqrtPriceLimitX96: "0",
                        }
                        await clearingHouse.connect(bob).swap(swapParams2)

                        // alice & carol both remove 0 liquidity; should both get fee
                        const removeLiquidityParams = {
                            baseToken: baseToken.address,
                            lowerTick,
                            upperTick,
                            liquidity: "0",
                        }

                        // expect 75% of 1% of base = 0.000007582881393 * 0.75 = 0.000005687161045
                        // expect 75% of 1% of quote = 0.001135501475 * 0.75 = 0.0008516261063
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
                                parseEther("0.000005687161044749"),
                                parseEther("0.000851626106249999"),
                            )

                        // expect 25% of 1% of base = 0.000007582881393 * 0.25 = 0.000001895720348
                        // expect 25% of 1% of quote = 0.001135501475 * 0.25 = 0.0002838753688
                        await expect(clearingHouse.connect(carol).removeLiquidity(removeLiquidityParams))
                            .to.emit(clearingHouse, "LiquidityChanged")
                            .withArgs(
                                carol.address,
                                baseToken.address,
                                quoteToken.address,
                                Number(lowerTick),
                                Number(upperTick),
                                "0",
                                "0",
                                "0",
                                parseEther("0.000001895720348249"),
                                parseEther("0.000283875368749999"),
                            )

                        // 100 - (0.000816820841 * 3) + 0.000005687161044749 = 99.9975552246
                        expect(await clearingHouse.getTokenInfo(alice.address, baseToken.address)).to.deep.eq([
                            parseEther("99.997555224638044749"), // available
                            parseEther("100"), // debt
                        ])
                        // 10000 + 0.0008516261063 = 10000.0008516261
                        expect(await clearingHouse.getTokenInfo(alice.address, quoteToken.address)).to.deep.eq([
                            parseEther("10000.000851626106249999"), // available
                            parseEther("10000"), // debt
                        ])

                        // 100 - 0.000816820841 + 0.000001895720348 = 99.9991850749
                        expect(await clearingHouse.getTokenInfo(carol.address, baseToken.address)).to.deep.eq([
                            parseEther("99.999185074879348249"), // available
                            parseEther("100"), // debt
                        ])
                        // 10000 + 0.0002838753688 = 10000.0002838754
                        expect(await clearingHouse.getTokenInfo(carol.address, quoteToken.address)).to.deep.eq([
                            parseEther("10000.000283875368749999"), // available
                            parseEther("10000"), // debt
                        ])
                        // FIXME: skipping Bob's balances as currently the logic of swap() does not include balance updates

                        // feeGrowthInsideLastBase: (0.000007582881393 / 4) * 2 ^ 128 = 6.450802071E32
                        // feeGrowthInsideLastQuote: (0.001135501474999999 / 4) * 2 ^ 128 = 9.659778239E34
                        //    645080207126300583967392433349287
                        //  96597782389344016525663130594604468
                        //                  1000000000000000000
                        // add the decimal point to prevent overflow, according to the above 10^18 comparison
                        const feeGrowthInsideLastBase = parseEther("645080207126300.583967392433349287")
                        const feeGrowthInsideLastQuote = parseEther("96597782389344016.525663130594604468")
                        expect(
                            await clearingHouse.getOpenOrder(alice.address, baseToken.address, lowerTick, upperTick),
                        ).to.deep.eq([
                            liquidityAlice,
                            Number(lowerTick), // lowerTick
                            Number(upperTick), // upperTick
                            feeGrowthInsideLastBase,
                            feeGrowthInsideLastQuote,
                        ])
                        expect(
                            await clearingHouse.getOpenOrder(carol.address, baseToken.address, lowerTick, upperTick),
                        ).to.deep.eq([
                            liquidityCarol,
                            Number(lowerTick), // lowerTick
                            Number(upperTick), // upperTick
                            feeGrowthInsideLastBase,
                            feeGrowthInsideLastQuote,
                        ])

                        // verify CH balance changes
                        // base diff:
                        // 0.002450462523 (alice addLiquidity) + 0.000816820841 (carol addLiquidity)
                        // - 0.0007558893279 (bob gets (from swap); note the difference)
                        // + 0.0007582881393 (bob swap) - 0.000007582881393 (alice & carol removeLiquidity)
                        // = 0.003262099294
                        expect(baseBefore.sub(await baseToken.balanceOf(clearingHouse.address))).to.eq(
                            parseEther("0.003262099293798643"),
                        )
                        // quote diff:
                        // 0.1135501475 (bob swap) - 0.001135501475 (alice & carol removeLiquidity)
                        // - 0.1116454419 (bob gets (from swap); note the difference)
                        // = 0.000769204125
                        expect(quoteBefore.sub(await quoteToken.balanceOf(clearingHouse.address))).to.eq(
                            parseEther("0.000769204069628756"),
                        )
                    })

                    it("alice receives all fee since carol removes her liquidity before taker's swap", async () => {
                        await pool.initialize(encodePriceSqrt(148.3760629, 1))
                        const baseBefore = await baseToken.balanceOf(clearingHouse.address)
                        const quoteBefore = await quoteToken.balanceOf(clearingHouse.address)

                        const lowerTick = "50000"
                        const upperTick = "50200"
                        const base = 0.000816820841

                        // add base liquidity
                        // 0.000816820841 * 3 = 0.002450462523
                        const addLiquidityParamsAlice = {
                            baseToken: baseToken.address,
                            lowerTick, // 148.3760629
                            upperTick, // 151.3733069
                            base: parseEther((base * 3).toString()),
                            quote: "0",
                        }
                        await clearingHouse.connect(alice).addLiquidity(addLiquidityParamsAlice)

                        // add base liquidity
                        const addLiquidityParamsCarol = {
                            baseToken: baseToken.address,
                            lowerTick, // 148.3760629
                            upperTick, // 151.3733069
                            base: parseEther(base.toString()),
                            quote: "0",
                        }
                        await clearingHouse.connect(carol).addLiquidity(addLiquidityParamsCarol)

                        // liquidity ~= 3
                        const liquidityAlice = (
                            await clearingHouse.getOpenOrder(alice.address, baseToken.address, lowerTick, upperTick)
                        ).liquidity

                        // liquidity = 999999999994411796 ~= 10^18
                        const liquidityCarol = (
                            await clearingHouse.getOpenOrder(carol.address, baseToken.address, lowerTick, upperTick)
                        ).liquidity

                        // carol removes all liquidity
                        const removeLiquidityParamsCarol = {
                            baseToken: baseToken.address,
                            lowerTick,
                            upperTick,
                            liquidity: liquidityCarol,
                        }

                        await expect(clearingHouse.connect(carol).removeLiquidity(removeLiquidityParamsCarol))
                            .to.emit(clearingHouse, "LiquidityChanged")
                            .withArgs(
                                carol.address,
                                baseToken.address,
                                quoteToken.address,
                                Number(lowerTick),
                                Number(upperTick),
                                // 1 wei of imprecision
                                parseEther((-0.000816820840999999).toString()),
                                "0",
                                // (-liquidityCarol).toString() will cause underflow;
                                // can also use: "-" + liquidityCarol.toString()
                                "-999999999994411796",
                                "0",
                                "0",
                            )

                        // bob swap
                        // quote: 0.112414646 / 0.99 = 0.1135501475
                        // to base: 0.0007553097871
                        const swapParams1 = {
                            baseToken: baseToken.address,
                            isBaseToQuote: false,
                            isExactInput: true,
                            amount: parseEther("0.1135501475"),
                            sqrtPriceLimitX96: "0",
                        }
                        await clearingHouse.connect(bob).swap(swapParams1)

                        // Note that Bob does not use all base he gets to swap into quote here
                        // base: 0.0007507052579 (instead of 0.0007558893279) / 0.99 = 0.0007582881393
                        // to quote: ~= 0.1117314313
                        const swapParams2 = {
                            baseToken: baseToken.address,
                            isBaseToQuote: true,
                            isExactInput: true,
                            amount: parseEther("0.0007582881393"),
                            sqrtPriceLimitX96: "0",
                        }
                        await clearingHouse.connect(bob).swap(swapParams2)

                        const removeLiquidityParamsAlice = {
                            baseToken: baseToken.address,
                            lowerTick,
                            upperTick,
                            liquidity: 0,
                        }

                        // expect 1% of base = 0.000007582881393
                        // expect 1% of quote = 0.001135501475
                        await expect(clearingHouse.connect(alice).removeLiquidity(removeLiquidityParamsAlice))
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
                                parseEther("0.000007582881392999"),
                                parseEther("0.001135501474999999"),
                            )

                        // 100 - 0.002450462523 + 0.000007582881393 = 99.9975571204
                        expect(await clearingHouse.getTokenInfo(alice.address, baseToken.address)).to.deep.eq([
                            parseEther("99.997557120358392999"), // available
                            parseEther("100"), // debt
                        ])
                        // 10000 + 0.001135501474999999 = 10000.001135501474999999
                        expect(await clearingHouse.getTokenInfo(alice.address, quoteToken.address)).to.deep.eq([
                            parseEther("10000.001135501474999999"), // available
                            parseEther("10000"), // debt
                        ])

                        // 1 wei of imprecision
                        expect(await clearingHouse.getTokenInfo(carol.address, baseToken.address)).to.deep.eq([
                            parseEther("99.999999999999999999"), // available
                            parseEther("100"), // debt
                        ])
                        expect(await clearingHouse.getTokenInfo(carol.address, quoteToken.address)).to.deep.eq([
                            parseEther("10000"), // available
                            parseEther("10000"), // debt
                        ])
                        // FIXME: skipping Bob's balances as currently the logic of swap() does not include balance updates

                        // feeGrowthInsideLastBase: (0.000007582881393 / 3) * 2 ^ 128 = 8.601069428E32
                        // feeGrowthInsideLastQuote: (0.001135501474999999 / 3) * 2 ^ 128 = 1.287970432E35
                        //    860106942835067445289856577799050
                        // 128797043185792022034217507459472624
                        //                  1000000000000000000
                        // add the decimal point to prevent overflow, according to the above 10^18 comparison
                        const feeGrowthInsideLastBase = parseEther("860106942835067.445289856577799050")
                        const feeGrowthInsideLastQuote = parseEther("128797043185792022.034217507459472624")
                        expect(
                            await clearingHouse.getOpenOrder(alice.address, baseToken.address, lowerTick, upperTick),
                        ).to.deep.eq([
                            liquidityAlice,
                            Number(lowerTick), // lowerTick
                            Number(upperTick), // upperTick
                            feeGrowthInsideLastBase,
                            feeGrowthInsideLastQuote,
                        ])
                        expect(
                            await clearingHouse.getOpenOrder(carol.address, baseToken.address, lowerTick, upperTick),
                        ).to.deep.eq([
                            parseEther("0"),
                            0, // lowerTick
                            0, // upperTick
                            parseEther("0"),
                            parseEther("0"),
                        ])

                        // verify CH balance changes
                        // base diff:
                        // 0.002450462523 (alice addLiquidity)
                        // - 0.0007553097871 (bob gets(from swap); note the difference)
                        // + 0.0007582881393 (bob swap) - 0.000007582881393 (alice removeLiquidity)
                        // = 0.002445857994
                        expect(baseBefore.sub(await baseToken.balanceOf(clearingHouse.address))).to.eq(
                            parseEther("0.002445857993579665"),
                        )
                        // quote diff:
                        // 0.1135501475 (bob swap) - 0.001135501475 (alice removeLiquidity)
                        // - 0.1117314313 (bob gets (from swap); note the difference)
                        // = 0.000683214725
                        expect(quoteBefore.sub(await quoteToken.balanceOf(clearingHouse.address))).to.eq(
                            parseEther("0.00068321472030382"),
                        )
                    })
                })

                it("out of maker's range; alice receives more fee as the price goes beyond carol's range", async () => {
                    await pool.initialize(encodePriceSqrt(148.3760629, 1))
                    const baseBefore = await baseToken.balanceOf(clearingHouse.address)
                    const quoteBefore = await quoteToken.balanceOf(clearingHouse.address)

                    const lowerTick = "50000"
                    const middleTick = "50200"
                    const upperTick = "50400"
                    const baseIn50000And50200 = 0.000816820841
                    const baseIn50200And50400 = 0.0008086937422

                    // add base
                    // 0.000816820841 + 0.0008086937422 = 0.001625514583
                    const addLiquidityParamsAlice = {
                        baseToken: baseToken.address,
                        lowerTick: lowerTick, // 148.3760629
                        upperTick: upperTick, // 154.4310961
                        base: parseEther((baseIn50000And50200 + baseIn50200And50400).toString()),
                        quote: "0",
                    }
                    await clearingHouse.connect(alice).addLiquidity(addLiquidityParamsAlice)

                    // add base
                    const addLiquidityParamsCarol = {
                        baseToken: baseToken.address,
                        lowerTick: lowerTick, // 148.3760629
                        upperTick: middleTick, // 151.3733069
                        base: parseEther(baseIn50000And50200.toString()),
                        quote: "0",
                    }
                    await clearingHouse.connect(carol).addLiquidity(addLiquidityParamsCarol)

                    // liquidity ~= 1
                    const liquidityAlice = (
                        await clearingHouse.getOpenOrder(alice.address, baseToken.address, lowerTick, upperTick)
                    ).liquidity

                    // liquidity ~= 1
                    const liquidityCarol = (
                        await clearingHouse.getOpenOrder(carol.address, baseToken.address, lowerTick, middleTick)
                    ).liquidity

                    // bob swap
                    // quote: (0.244829292 + 0.09891589745) / 0.99 = 0.3437451895 / 0.99 = 0.3472173631
                    // to base: 0.001633641682 + 0.0006482449586 = 0.002281886641
                    const swapParams1 = {
                        baseToken: baseToken.address,
                        isBaseToQuote: false,
                        isExactInput: true,
                        amount: parseEther("0.3472173631"),
                        sqrtPriceLimitX96: "0",
                    }
                    await clearingHouse.connect(bob).swap(swapParams1)

                    // To achieve the same price after two swaps, Bob is using more base than he gets from the previous swap
                    // NOTE: thus, after this tx, the price becomes extremely small while does not affect us testing the tx fee
                    // base: 0.002281886641 / 0.99 = 0.002304936001
                    // to quote: 0.3437451895
                    const swapParams2 = {
                        baseToken: baseToken.address,
                        isBaseToQuote: true,
                        isExactInput: true,
                        amount: parseEther("0.002304936001"),
                        sqrtPriceLimitX96: "0",
                    }
                    await clearingHouse.connect(bob).swap(swapParams2)

                    // alice  remove 0 liquidity; should get fee
                    const removeLiquidityParamsAlice = {
                        baseToken: baseToken.address,
                        lowerTick: lowerTick,
                        upperTick: upperTick,
                        liquidity: "0",
                    }

                    // expect 50% of 1% of base in range (50000, 50200) = 0.001633641682 / 0.99 * 0.5 * 0.01 = 0.000008250715566
                    // expect 100% of 1% of base in range (50200, 50400) = 0.0006482449586 / 0.99 * 0.01 = 0.000006547928875
                    // base sum: 0.000008250715566 + 0.000006547928875 = 0.00001479864444
                    // expect 50% of 1% of quote in range (50000, 50200) = 0.244829292 / 0.99 * 0.5 * 0.01 = 0.001236511576
                    // expect 100% of 1% of quote in range (50200, 50400) = 0.09891589745 / 0.99 * 0.01 = 0.0009991504793
                    // quote sum: 0.001236511576 + 0.0009991504793 = 0.002235662055
                    await expect(clearingHouse.connect(alice).removeLiquidity(removeLiquidityParamsAlice))
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
                            parseEther("0.000014798644443168"),
                            parseEther("0.002235662055384689"),
                        )

                    // carol remove 0 liquidity; should get fee
                    const removeLiquidityParamsCarol = {
                        baseToken: baseToken.address,
                        lowerTick: lowerTick,
                        upperTick: middleTick,
                        liquidity: "0",
                    }

                    // expect 50% of 1% of base in range (50000, 50200) = 0.001633641682 / 0.99 * 0.5 * 0.01 = 0.000008250715566
                    // expect 50% of 1% of quote in range (50000, 50200) = 0.244829292 / 0.99 * 0.5 * 0.01 = 0.001236511576
                    await expect(clearingHouse.connect(carol).removeLiquidity(removeLiquidityParamsCarol))
                        .to.emit(clearingHouse, "LiquidityChanged")
                        .withArgs(
                            carol.address,
                            baseToken.address,
                            quoteToken.address,
                            Number(lowerTick),
                            Number(middleTick),
                            "0",
                            "0",
                            "0",
                            parseEther("0.000008250715565656"),
                            parseEther("0.001236511575615311"),
                        )

                    // verify account states
                    // 100 - 0.001625514583 + 0.00001479864444 = 99.9983892841
                    expect(await clearingHouse.getTokenInfo(alice.address, baseToken.address)).to.deep.eq([
                        parseEther("99.998389284061243168"), // available
                        parseEther("100"), // debt
                    ])
                    // 10000 + 0.002235662055 = 10000.0022356621
                    expect(await clearingHouse.getTokenInfo(alice.address, quoteToken.address)).to.deep.eq([
                        parseEther("10000.002235662055384689"), // available
                        parseEther("10000"), // debt
                    ])

                    // 100 - 0.000816820841 + 0.000008250715566 = 99.9991914299
                    expect(await clearingHouse.getTokenInfo(carol.address, baseToken.address)).to.deep.eq([
                        parseEther("99.999191429874565656"), // available
                        parseEther("100"), // debt
                    ])
                    // 10000 + 0.001236511576 = 10000.0012365116
                    expect(await clearingHouse.getTokenInfo(carol.address, quoteToken.address)).to.deep.eq([
                        parseEther("10000.001236511575615311"), // available
                        parseEther("10000"), // debt
                    ])
                    // FIXME: skipping Bob's balances as currently the logic of swap() does not include balance updates

                    // alice's range: 50000 - 50400
                    // to get feeGrowthInsideLastBase:
                    // 50000 - 50200: 0.001633641682 / 0.99 * 0.01 / 2 = 0.000008250715566
                    // 50200 - 50400: 0.0006482449586 / 0.99 * 0.01 = 0.000006547928875
                    // 0.000008250715566 + 0.000006547928875 = 0.00001479864444
                    // = all fee alice gets, as alice's liquidity = 1, fits the definition of feeGrowthInside...
                    // feeGrowthInsideLastBase: 0.00001479864444 * 2 ^ 128 = 5.035717757E33
                    // feeGrowthInsideLastQuote: 0.002235662055 * 2 ^ 128 = 7.607563757E35
                    //   5035717758230611089140033642599728
                    // 760756375824692728591374008493999483
                    //                  1000000000000000000
                    // add the decimal point to prevent overflow, according to the above 10^18 comparison
                    expect(
                        await clearingHouse.getOpenOrder(alice.address, baseToken.address, lowerTick, upperTick),
                    ).to.deep.eq([
                        liquidityAlice,
                        Number(lowerTick), // lowerTick
                        Number(upperTick), // upperTick
                        parseEther("5035717758230611.089140033642599728"),
                        parseEther("760756375824692728.591374008493999483"),
                    ])

                    // carol's range: 50000 - 50200
                    // feeGrowthInsideLastBase: 0.000008250715566 * 2 ^ 128 = 2.807573022E33
                    // feeGrowthInsideLastQuote: 0.001236511576 * 2 ^ 128 = 4.207630858E35
                    //   2807573021488742689904099117881306
                    // 420763085677868466632071754987713111
                    //                  1000000000000000000
                    // add the decimal point to prevent overflow, according to the above 10^18 comparison
                    expect(
                        await clearingHouse.getOpenOrder(carol.address, baseToken.address, lowerTick, middleTick),
                    ).to.deep.eq([
                        liquidityCarol,
                        Number(lowerTick), // lowerTick
                        Number(middleTick), // upperTick
                        parseEther("2807573021488742.689904099117881306"),
                        parseEther("420763085677868466.632071754987713111"),
                    ])

                    // verify CH balance changes
                    // base diff:
                    // 0.001625514583 (alice addLiquidity) + 0.000816820841 (carol addLiquidity)
                    // - 0.002281886641 (bob gets (from swap); note the difference)
                    // + 0.002304936001 (bob swap) - (0.000008250715566 * 2 + 0.000006547928875) (alice & carol removeLiquidity)
                    // = 0.002442335424
                    expect(baseBefore.sub(await baseToken.balanceOf(clearingHouse.address))).to.eq(
                        parseEther("0.002442335424200003"),
                    )
                    // quote diff:
                    // 0.3472173631 (bob swap) - (0.001236511576 * 2 + 0.0009991504793) (alice & carol removeLiquidity)
                    // - 0.3437451895 (bob gets (from swap); note the difference)
                    // = -3.13E-11 (extremely small, negligible)
                    expect(quoteBefore.sub(await quoteToken.balanceOf(clearingHouse.address))).to.eq(
                        parseEther("0.000000000000000003"),
                    )
                })
            })
        })
    })
})

// // === useful console.log for verifying stats ===
// console.log("alice stats:")
// console.log("base, available")
// console.log((await clearingHouse.getTokenInfo(alice.address, baseToken.address))[0].toString())
// console.log("base, debt")
// console.log((await clearingHouse.getTokenInfo(alice.address, baseToken.address))[1].toString())
// console.log("quote, available")
// console.log((await clearingHouse.getTokenInfo(alice.address, quoteToken.address))[0].toString())
// console.log("quote, debt")
// console.log((await clearingHouse.getTokenInfo(alice.address, quoteToken.address))[1].toString())

// console.log("----------------------")
// console.log("carol stats:")
// console.log("base, available")
// console.log((await clearingHouse.getTokenInfo(carol.address, baseToken.address))[0].toString())
// console.log("base, debt")
// console.log((await clearingHouse.getTokenInfo(carol.address, baseToken.address))[1].toString())
// console.log("quote, available")
// console.log((await clearingHouse.getTokenInfo(carol.address, quoteToken.address))[0].toString())
// console.log("quote, debt")
// console.log((await clearingHouse.getTokenInfo(carol.address, quoteToken.address))[1].toString())

// console.log("----------------------")
// console.log("feeGrowthInsideLastBase carol 50000 - 50200")
// console.log((await clearingHouse.getOpenOrder(carol.address, baseToken.address, lowerTick, middleTick))[3].toString())
// console.log("feeGrowthInsideLastQuote carol 50000 - 50200")
// console.log((await clearingHouse.getOpenOrder(carol.address, baseToken.address, lowerTick, middleTick))[4].toString())
// console.log("feeGrowthInsideLastBase alice 50000 - 50400")
// console.log((await clearingHouse.getOpenOrder(alice.address, baseToken.address, lowerTick, upperTick))[3].toString())
// console.log("feeGrowthInsideLastQuote alice 50000 - 50400")
// console.log((await clearingHouse.getOpenOrder(alice.address, baseToken.address, lowerTick, upperTick))[4].toString())

// console.log("----------------------")
// console.log("base diff")
// console.log(baseBefore.sub(await baseToken.balanceOf(clearingHouse.address)).toString())
// console.log("quote diff")
// console.log(quoteBefore.sub(await quoteToken.balanceOf(clearingHouse.address)).toString())
// // === useful console.log for verifying stats ===
