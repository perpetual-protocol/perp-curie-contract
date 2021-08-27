import { MockContract } from "@eth-optimism/smock"
import { parseEther } from "@ethersproject/units"
import { expect } from "chai"
import { parseUnits } from "ethers/lib/utils"
import { ethers, waffle } from "hardhat"
import { ClearingHouse, Exchange, TestERC20, UniswapV3Pool, Vault } from "../../typechain"
import { VirtualToken } from "../../typechain/VirtualToken"
import { deposit } from "../helper/token"
import { forward } from "../shared/time"
import { encodePriceSqrt } from "../shared/utilities"
import { BaseQuoteOrdering, createClearingHouseFixture } from "./fixtures"

describe("ClearingHouse funding", () => {
    const [admin, alice, bob, carol] = waffle.provider.getWallets()
    const loadFixture: ReturnType<typeof waffle.createFixtureLoader> = waffle.createFixtureLoader([admin])
    let clearingHouse: ClearingHouse
    let exchange: Exchange
    let vault: Vault
    let collateral: TestERC20
    let baseToken: VirtualToken
    let quoteToken: VirtualToken
    let mockedBaseAggregator: MockContract
    let pool: UniswapV3Pool
    let collateralDecimals: number

    beforeEach(async () => {
        const _clearingHouseFixture = await loadFixture(
            createClearingHouseFixture(BaseQuoteOrdering.BASE_0_QUOTE_1, false),
        )
        clearingHouse = _clearingHouseFixture.clearingHouse as ClearingHouse
        exchange = _clearingHouseFixture.exchange
        vault = _clearingHouseFixture.vault
        collateral = _clearingHouseFixture.USDC
        baseToken = _clearingHouseFixture.baseToken
        quoteToken = _clearingHouseFixture.quoteToken
        mockedBaseAggregator = _clearingHouseFixture.mockedBaseAggregator
        pool = _clearingHouseFixture.pool
        collateralDecimals = await collateral.decimals()

        // price at 50400 == 154.4310961
        await pool.initialize(encodePriceSqrt("154.4310961", "1"))
        // the initial number of oracle can be recorded is 1; thus, have to expand it
        await pool.increaseObservationCardinalityNext((2 ^ 16) - 1)

        // add pool after it's initialized
        await exchange.addPool(baseToken.address, 10000)

        // alice add long limit order
        await collateral.mint(alice.address, parseUnits("10000", collateralDecimals))
        await deposit(alice, vault, 10000, collateral)
        await clearingHouse.connect(alice).mint(quoteToken.address, parseEther("1000"))
        await clearingHouse.connect(alice).mint(baseToken.address, parseEther("10"))

        // note that alice opens an order before we have a meaningful index price value, this is fine (TM)
        // because the very first funding settlement on the market only records the timestamp and
        // does not calculate or change anything else
        await clearingHouse.connect(alice).addLiquidity({
            baseToken: baseToken.address,
            base: parseEther("0"),
            quote: parseEther("100"),
            lowerTick: 50200,
            upperTick: 50400,
            minBase: 0,
            minQuote: 0,
            deadline: ethers.constants.MaxUint256,
        })

        await collateral.mint(bob.address, parseUnits("1000", collateralDecimals))
        await deposit(bob, vault, 1000, collateral)
        await clearingHouse.connect(bob).mint(baseToken.address, parseEther("2"))
        await clearingHouse.connect(bob).mint(quoteToken.address, parseEther("1000"))

        await collateral.mint(carol.address, parseUnits("1000", collateralDecimals))
        await deposit(carol, vault, 1000, collateral)
        await clearingHouse.connect(carol).mint(baseToken.address, parseEther("2"))
        await clearingHouse.connect(carol).mint(quoteToken.address, parseEther("1000"))
    })

    describe("# getPendingFundingPayment", () => {
        beforeEach(async () => {
            // bob short
            await clearingHouse.connect(bob).openPosition({
                baseToken: baseToken.address,
                isBaseToQuote: true,
                isExactInput: true,
                amount: parseEther("0.099"),
                sqrtPriceLimitX96: 0,
            })

            // alice:
            //   base.liquidity = 0
            //   quote.liquidity = 100
            // bob:
            //   base.available = 2 - 0.099 = 1.901
            //   base.debt = 2
            //   quote.available = 15.1128025359
            //   quote.debt = 0
            // mark price should be 153.9623330511 (tick ~= 50369)

            // TODO somehow mark TWAP becomes 153.9531248192 which is not exactly the same as the mark price immediately after bob swap
            // check why is that the case
        })

        it("no funding payment when it's still the same block as swapping", async () => {
            // carol's position size = 0
            expect(await clearingHouse.getPendingFundingPayment(bob.address, baseToken.address)).eq(0)
        })

        it("no funding payment when there is no position/ no such a trader", async () => {
            // carol's position size = 0
            expect(await clearingHouse.getPendingFundingPayment(carol.address, baseToken.address)).eq(0)
        })

        it("force error, base token does not exist", async () => {
            await expect(clearingHouse.getPendingFundingPayment(alice.address, quoteToken.address)).to.be.revertedWith(
                "CH_BTNE",
            )
        })
    })

    describe("# _settleFundingAndUpdateFundingGrowth without TWAP/ with consistent prices", () => {
        describe("one maker with one order, multiple takers", () => {
            describe("without twap/ prices are consistent in the twapInterval", () => {
                it("one taker swaps once; positive funding", async () => {
                    // set index price for a positive funding
                    mockedBaseAggregator.smocked.latestRoundData.will.return.with(async () => {
                        return [0, parseUnits("150.953124", 6), 0, 0, 0]
                    })

                    // bob's position 0 -> -0.099
                    await clearingHouse.connect(bob).openPosition({
                        baseToken: baseToken.address,
                        isBaseToQuote: true,
                        isExactInput: true,
                        amount: parseEther("0.099"),
                        sqrtPriceLimitX96: 0,
                    })
                    await forward(3600)

                    // bob's funding payment = -0.099 * (153.9531248192 - 150.953124) * 3600 / 86400 = -0.01237500338
                    expect(await clearingHouse.getPendingFundingPayment(bob.address, baseToken.address)).to.eq(
                        parseEther("-0.012375003379192556"),
                    )
                    // alice's funding payment = -(bob's funding payment)
                    expect(await clearingHouse.getPendingFundingPayment(alice.address, baseToken.address)).to.eq(
                        parseEther("0.012375003379192556"),
                    )

                    await forward(3600)

                    // bob's funding payment = -0.099 * (153.9531248192 - 150.953124) * 7200 / 86400 = -0.02475000676
                    expect(await clearingHouse.getPendingFundingPayment(bob.address, baseToken.address)).to.eq(
                        parseEther("-0.024750006758385112"),
                    )
                    // alice's funding payment = -(bob's funding payment)
                    expect(await clearingHouse.getPendingFundingPayment(alice.address, baseToken.address)).to.eq(
                        parseEther("0.024750006758385112"),
                    )

                    const owedRealizedPnlBefore = await clearingHouse.getOwedRealizedPnl(bob.address)

                    // swaps arbitrary amount to trigger funding settlement
                    // note that the swap timestamp is 1 second ahead due to hardhat's default block timestamp increment
                    // -0.099 * (153.9531248192 - 150.953124) * 7201 / 86400 = -0.02475344426
                    await expect(
                        clearingHouse.connect(bob).openPosition({
                            baseToken: baseToken.address,
                            isBaseToQuote: true,
                            isExactInput: true,
                            amount: parseEther("0.0000000001"),
                            sqrtPriceLimitX96: 0,
                        }),
                    )
                        .to.emit(clearingHouse, "FundingSettled")
                        .withArgs(bob.address, baseToken.address, parseEther("-0.024753444259323776"))

                    // verify owedRealizedPnl
                    const owedRealizedPnlAfter = await clearingHouse.getOwedRealizedPnl(bob.address)
                    expect(owedRealizedPnlAfter.sub(owedRealizedPnlBefore)).to.eq(parseEther("0.024753444259323776"))
                    expect(await clearingHouse.getPendingFundingPayment(bob.address, baseToken.address)).to.eq(0)
                })

                it("one taker swaps twice; add liquidity in between; negative funding", async () => {
                    // set index price for a negative funding
                    mockedBaseAggregator.smocked.latestRoundData.will.return.with(async () => {
                        return [0, parseUnits("156.953124", 6), 0, 0, 0]
                    })

                    // bob's position 0 -> -0.099
                    await clearingHouse.connect(bob).openPosition({
                        baseToken: baseToken.address,
                        isBaseToQuote: true,
                        isExactInput: true,
                        amount: parseEther("0.099"),
                        sqrtPriceLimitX96: 0,
                    })

                    // alice add arbitrarily more liquidity. This should not impact alice's position size
                    // 0.099 * (153.9531248192 - 156.953124) * 1 / 86400 = -0.000003437499061
                    await expect(
                        clearingHouse.connect(alice).addLiquidity({
                            baseToken: baseToken.address,
                            base: parseEther("2"),
                            quote: parseEther("100"),
                            lowerTick: 50200,
                            upperTick: 50400,
                            minBase: 0,
                            minQuote: 0,
                            deadline: ethers.constants.MaxUint256,
                        }),
                    )
                        .to.emit(clearingHouse, "FundingSettled")
                        .withArgs(alice.address, baseToken.address, parseEther("-0.000003437499061335"))

                    await forward(3600)

                    // bob's funding payment = -0.099 * (153.9531248192 - 156.953124) * 3601 / 86400 = 0.01237843412
                    expect(await clearingHouse.getPendingFundingPayment(bob.address, baseToken.address)).to.eq(
                        parseEther("0.012378434119868779"),
                    )
                    // alice's funding payment = 0.099 * (153.9531248192 - 156.953124) * 3600 / 86400 = -0.01237499662
                    expect(await clearingHouse.getPendingFundingPayment(alice.address, baseToken.address)).to.eq(
                        parseEther("-0.012374996620807443"),
                    )

                    // bob's position -0.099 -> -0.2
                    // note that the swap timestamp is 1 second ahead due to hardhat's default block timestamp increment
                    // -0.099 * (153.9531248192 - 156.953124) * 3602 / 86400 = 0.01238187162
                    await expect(
                        clearingHouse.connect(bob).openPosition({
                            baseToken: baseToken.address,
                            isBaseToQuote: true,
                            isExactInput: true,
                            amount: parseEther("0.101"),
                            sqrtPriceLimitX96: 0,
                        }),
                    )
                        .to.emit(clearingHouse, "FundingSettled")
                        .withArgs(bob.address, baseToken.address, parseEther("0.012381871618930114"))

                    await forward(3600)

                    // bob's funding payment = -0.2 * (153.7377520091 - 156.953124) * 3600 / 86400 = 0.02679476659
                    expect(await clearingHouse.getPendingFundingPayment(bob.address, baseToken.address)).to.eq(
                        parseEther("0.026794766591206201"),
                    )
                    // alice's pending funding payment =
                    //    -(bob's settled funding payment + bob's pending funding payment - alice's settled funding payment)
                    // -(0.01238187162 + 0.02679476659) - -0.000003437499061 = -0.03917320071
                    expect(await clearingHouse.getPendingFundingPayment(alice.address, baseToken.address)).to.eq(
                        parseEther("-0.039173200711074980"),
                    )
                })

                it("two takers; first positive then negative funding", async () => {
                    // set index price for a positive funding
                    mockedBaseAggregator.smocked.latestRoundData.will.return.with(async () => {
                        return [0, parseUnits("150.953124", 6), 0, 0, 0]
                    })

                    // bob's position 0 -> -0.099
                    await clearingHouse.connect(bob).openPosition({
                        baseToken: baseToken.address,
                        isBaseToQuote: true,
                        isExactInput: true,
                        amount: parseEther("0.099"),
                        sqrtPriceLimitX96: 0,
                    })
                    await forward(3600)

                    // carol's position 0 -> 0.09
                    await clearingHouse.connect(carol).openPosition({
                        baseToken: baseToken.address,
                        isBaseToQuote: false,
                        isExactInput: false,
                        amount: parseEther("0.09"),
                        sqrtPriceLimitX96: 0,
                    })

                    // alice's funding payment shouldn't change after carol swaps
                    // note that the swap timestamp is 1 second ahead due to hardhat's default block timestamp increment
                    // -(-0.099 * (153.9531248192 - 150.953124) * 3601 / 86400) = 0.01237844088
                    expect(await clearingHouse.getPendingFundingPayment(alice.address, baseToken.address)).to.eq(
                        parseEther("0.012378440880131220"),
                    )

                    await forward(3600)

                    // set index price for a negative funding
                    mockedBaseAggregator.smocked.latestRoundData.will.return.with(async () => {
                        return [0, parseUnits("156.953124", 6), 0, 0, 0]
                    })

                    // bob's funding payment = -0.099 * ((153.9531248192 - 150.953124) * 3601 + (154.3847760162 - 156.953124) * 3600) / 86400 = -0.001784005447
                    expect(await clearingHouse.getPendingFundingPayment(bob.address, baseToken.address)).to.eq(
                        parseEther("-0.001784005446830714"),
                    )
                    // carol's funding payment = 0.09 * (154.3847760162 - 156.953124) * 3600 / 86400 = -0.009631304939
                    expect(await clearingHouse.getPendingFundingPayment(carol.address, baseToken.address)).to.eq(
                        parseEther("-0.009631304939364096"),
                    )
                    // alice's funding payment = -(sum of takers' funding payments) = -(-0.001784005447 + -0.009631304939) = 0.01141531039
                    expect(await clearingHouse.getPendingFundingPayment(alice.address, baseToken.address)).to.eq(
                        parseEther("0.011415310386194810"),
                    )

                    // settle bob's funding
                    let owedRealizedPnlBefore = await clearingHouse.getOwedRealizedPnl(bob.address)

                    // swaps arbitrary amount to trigger funding settlement
                    // note that the swap timestamp is 1 second ahead due to hardhat's default block timestamp increment
                    // -0.099 * ((153.9531248192 - 150.953124) * 3601 + (154.3847760162 - 156.953124) * 3601) / 86400 = -0.001781062548
                    await expect(
                        clearingHouse.connect(bob).openPosition({
                            baseToken: baseToken.address,
                            isBaseToQuote: true,
                            isExactInput: true,
                            amount: parseEther("0.0000000001"),
                            sqrtPriceLimitX96: 0,
                        }),
                    )
                        .to.emit(clearingHouse, "FundingSettled")
                        .withArgs(bob.address, baseToken.address, parseEther("-0.001781062548099241"))

                    // verify owedRealizedPnl
                    let owedRealizedPnlAfter = await clearingHouse.getOwedRealizedPnl(bob.address)
                    expect(owedRealizedPnlAfter.sub(owedRealizedPnlBefore)).to.eq(parseEther("0.001781062548099241"))
                    expect(await clearingHouse.getPendingFundingPayment(bob.address, baseToken.address)).to.eq(0)

                    // ----------------------
                    // settle carol's funding
                    owedRealizedPnlBefore = await clearingHouse.getOwedRealizedPnl(carol.address)

                    // swaps arbitrary amount to trigger funding settlement
                    // note that the swap timestamp is 1 second ahead due to hardhat's default block timestamp increment
                    // 0.09 * (154.3847760162 - 156.953124) * 3602 / 86400 = -0.009636655664
                    await expect(
                        clearingHouse.connect(carol).openPosition({
                            baseToken: baseToken.address,
                            isBaseToQuote: false,
                            isExactInput: false,
                            amount: parseEther("0.0000000001"),
                            sqrtPriceLimitX96: 0,
                        }),
                    )
                        .to.emit(clearingHouse, "FundingSettled")
                        .withArgs(carol.address, baseToken.address, parseEther("-0.009636655664330410"))

                    // verify owedRealizedPnl
                    owedRealizedPnlAfter = await clearingHouse.getOwedRealizedPnl(carol.address)
                    expect(owedRealizedPnlAfter.sub(owedRealizedPnlBefore)).to.eq(parseEther("0.009636655664330410"))
                    expect(await clearingHouse.getPendingFundingPayment(carol.address, baseToken.address)).to.eq(0)
                })
            })

            // twap is introduced by not always setting forward() with values > twapInterval = 900 (default)
            // can notice that markTwaps in this case are different from those in "two takers; first positive then negative funding"
            it("with twap; two takers; positive, negative then positive funding", async () => {
                // set index price for a positive funding
                mockedBaseAggregator.smocked.latestRoundData.will.return.with(async () => {
                    return [0, parseUnits("150.953124", 6), 0, 0, 0]
                })

                // bob's position 0 -> -0.099
                await clearingHouse.connect(bob).openPosition({
                    baseToken: baseToken.address,
                    isBaseToQuote: true,
                    isExactInput: true,
                    amount: parseEther("0.099"),
                    sqrtPriceLimitX96: 0,
                })
                await forward(300)

                // bob's funding payment = -0.099 * (153.9531248192 - 150.953124) * 300 / 86400 = -0.001031250282
                expect(await clearingHouse.getPendingFundingPayment(bob.address, baseToken.address)).to.eq(
                    parseEther("-0.001031250281599379"),
                )

                // carol's position 0 -> 0.09
                await clearingHouse.connect(carol).openPosition({
                    baseToken: baseToken.address,
                    isBaseToQuote: false,
                    isExactInput: false,
                    amount: parseEther("0.09"),
                    sqrtPriceLimitX96: 0,
                })

                // alice's funding payment shouldn't change after carol swaps
                // note that the swap timestamp is 1 second ahead due to hardhat's default block timestamp increment
                // -(-0.099 * (153.9531248192 - 150.953124) * 301 / 86400) = 0.001034687783
                expect(await clearingHouse.getPendingFundingPayment(alice.address, baseToken.address)).to.eq(
                    parseEther("0.001034687782538044"),
                )

                await forward(450)

                // set index price for a negative funding
                mockedBaseAggregator.smocked.latestRoundData.will.return.with(async () => {
                    return [0, parseUnits("156.953124", 6), 0, 0, 0]
                })

                // notice that markTwap here is not 154.3847760162 as in "two takers; first positive then negative funding", though having the same amount swapped
                // bob's funding payment = -0.099 * ((153.9531248192 - 150.953124) * 301 + (154.1996346489 - 156.953124) * 450) / 86400 = 0.0003850801641
                expect(await clearingHouse.getPendingFundingPayment(bob.address, baseToken.address)).to.eq(
                    parseEther("0.000385080164122650"),
                )
                // carol's funding payment = 0.09 * (154.1996346489 - 156.953124) * 450 / 86400 = -0.001290698133
                expect(await clearingHouse.getPendingFundingPayment(carol.address, baseToken.address)).to.eq(
                    parseEther("-0.001290698133327903"),
                )
                // alice's funding payment = -(sum of takers' funding payments) = -(0.0003850801641 + -0.001290698133) = 0.0009056179689
                expect(await clearingHouse.getPendingFundingPayment(alice.address, baseToken.address)).to.eq(
                    parseEther("0.000905617969205253"),
                )

                // bob swaps to trigger funding update
                // -0.099 * ((153.9531248192 - 150.953124) * 301 + (154.1996346489 - 156.953124) * 451) / 86400 = 0.000388235204
                await expect(
                    clearingHouse.connect(bob).openPosition({
                        baseToken: baseToken.address,
                        isBaseToQuote: true,
                        isExactInput: true,
                        amount: parseEther("0.0000000001"),
                        sqrtPriceLimitX96: 0,
                    }),
                )
                    .to.emit(clearingHouse, "FundingSettled")
                    .withArgs(bob.address, baseToken.address, parseEther("0.000388235204004118"))

                // note that bob will settle his pending funding payment here
                await forward(250)

                // set index price for a positive funding
                mockedBaseAggregator.smocked.latestRoundData.will.return.with(async () => {
                    return [0, parseUnits("152.953124", 6), 0, 0, 0]
                })

                // bob's funding payment = -0.099 * (154.2767498877 - 152.953124) * 250 / 86400 = -0.0003791636657
                expect(await clearingHouse.getPendingFundingPayment(bob.address, baseToken.address)).to.eq(
                    parseEther("-0.000379163666139115"),
                )
                // carol's funding payment = 0.09 * ((154.1996346489 - 156.953124) * 451 + (154.2767498877 - 152.953124) * 250) / 86400 = -0.0009488721098
                expect(await clearingHouse.getPendingFundingPayment(carol.address, baseToken.address)).to.eq(
                    parseEther("-0.000948872109805491"),
                )
                // alice's funding payment = -(sum of takers' funding payments) = 0.0009056179689 + -(-0.0003791636657 + 0.09 * (154.2767498877 - 152.953124) * 250 / 86400) = 0.000940087393
                // there is minor imprecision thx to hardhat and choose to ignore it in this case
                expect(await clearingHouse.getPendingFundingPayment(alice.address, baseToken.address)).to.eq(
                    parseEther("0.000939800571940488"),
                )
            })
        })

        describe("two orders with different ranges, one taker; positive funding", () => {
            beforeEach(async () => {
                // set index price for a positive funding
                mockedBaseAggregator.smocked.latestRoundData.will.return.with(async () => {
                    return [0, parseUnits("150.953124", 6), 0, 0, 0]
                })
            })

            it("one maker; reduce one order and then remove both", async () => {
                //           |-----| alice range #0
                //      |----------| alice range #1
                //   -----------------------------> p
                //                 50400             (154.4310960807)
                //           50200                   (151.3733068587)
                //     50000                         (148.3760629231)
                //         <--------x
                //         end      current

                // add opens another order with larger range
                await clearingHouse.connect(alice).addLiquidity({
                    baseToken: baseToken.address,
                    base: parseEther("0"),
                    quote: parseEther("100"),
                    lowerTick: 50000,
                    upperTick: 50400,
                    minBase: 0,
                    minQuote: 0,
                    deadline: ethers.constants.MaxUint256,
                })

                // bob's position 0 -> -1.2
                await clearingHouse.connect(bob).openPosition({
                    baseToken: baseToken.address,
                    isBaseToQuote: true,
                    isExactInput: true,
                    amount: parseEther("1.2"),
                    sqrtPriceLimitX96: 0,
                })
                await forward(3600)

                // bob's funding payment = -1.2 * (149.3884076058 - 150.953124) * 3600 / 86400 = 0.07823581971
                expect(await clearingHouse.getPendingFundingPayment(bob.address, baseToken.address)).to.eq(
                    parseEther("0.078235819711065467"),
                )
                // alice's funding payment = -(bob's funding payment)
                expect(await clearingHouse.getPendingFundingPayment(alice.address, baseToken.address)).to.eq(
                    parseEther("-0.078235819711065467"),
                )

                let owedRealizedPnlBefore = await clearingHouse.getOwedRealizedPnl(alice.address)
                let liquidity = (await exchange.getOpenOrder(alice.address, baseToken.address, 50000, 50400)).liquidity

                // remove half of the liquidity of the order (50000, 50400); all pending funding payment should be settled
                // note that the swap timestamp is 1 second ahead due to hardhat's default block timestamp increment
                // 1.2 * (149.3884076058 - 150.953124) * 3601 / 86400 = -0.07825755188
                await expect(
                    clearingHouse.connect(alice).removeLiquidity({
                        baseToken: baseToken.address,
                        lowerTick: 50000,
                        upperTick: 50400,
                        liquidity: liquidity.div(2),
                        minBase: 0,
                        minQuote: 0,
                        deadline: ethers.constants.MaxUint256,
                    }),
                )
                    .to.emit(clearingHouse, "FundingSettled")
                    .withArgs(alice.address, baseToken.address, parseEther("-0.078257551883207429"))

                // verify owedRealizedPnl
                let owedRealizedPnlAfter = await clearingHouse.getOwedRealizedPnl(alice.address)
                expect(owedRealizedPnlAfter.sub(owedRealizedPnlBefore)).to.eq(parseEther("0.078257551883207429"))
                expect(await clearingHouse.getPendingFundingPayment(alice.address, baseToken.address)).to.eq(0)

                await forward(3600)

                // 1.2 * (149.3884076058 - 150.953124) * 3600 / 86400 = -0.07823581971
                expect(await clearingHouse.getPendingFundingPayment(alice.address, baseToken.address)).to.eq(
                    parseEther("-0.078235819711065467"),
                )

                owedRealizedPnlBefore = await clearingHouse.getOwedRealizedPnl(alice.address)
                liquidity = (await exchange.getOpenOrder(alice.address, baseToken.address, 50000, 50400)).liquidity

                // remove all the remaining liquidity of the order (50000, 50400)
                // note that the swap timestamp is 1 second ahead due to hardhat's default block timestamp increment
                // 1.2 * (149.3884076058 - 150.953124) * 3601 / 86400 = -0.07825755188
                await expect(
                    clearingHouse.connect(alice).removeLiquidity({
                        baseToken: baseToken.address,
                        lowerTick: 50000,
                        upperTick: 50400,
                        liquidity: liquidity,
                        minBase: 0,
                        minQuote: 0,
                        deadline: ethers.constants.MaxUint256,
                    }),
                )
                    .to.emit(clearingHouse, "FundingSettled")
                    .withArgs(alice.address, baseToken.address, parseEther("-0.078257551883207429"))

                // verify owedRealizedPnl
                owedRealizedPnlAfter = await clearingHouse.getOwedRealizedPnl(alice.address)
                expect(owedRealizedPnlAfter.sub(owedRealizedPnlBefore)).to.eq(parseEther("0.078257551883207429"))
                expect(await clearingHouse.getPendingFundingPayment(alice.address, baseToken.address)).to.eq(0)

                await forward(3600)

                // 1.2 * (149.3884076058 - 150.953124) * 3600 / 86400 = -0.07823581971
                expect(await clearingHouse.getPendingFundingPayment(alice.address, baseToken.address)).to.eq(
                    parseEther("-0.078235819711065467"),
                )

                owedRealizedPnlBefore = await clearingHouse.getOwedRealizedPnl(alice.address)
                liquidity = (await exchange.getOpenOrder(alice.address, baseToken.address, 50200, 50400)).liquidity

                // remove all liquidity of the order (50200, 50400)
                // note that the swap timestamp is 1 second ahead due to hardhat's default block timestamp increment
                // 1.2 * (149.3884076058 - 150.953124) * 3601 / 86400 = -0.07825755188
                await expect(
                    clearingHouse.connect(alice).removeLiquidity({
                        baseToken: baseToken.address,
                        lowerTick: 50200,
                        upperTick: 50400,
                        liquidity: liquidity,
                        minBase: 0,
                        minQuote: 0,
                        deadline: ethers.constants.MaxUint256,
                    }),
                )
                    .to.emit(clearingHouse, "FundingSettled")
                    .withArgs(alice.address, baseToken.address, parseEther("-0.078257551883207429"))

                // verify owedRealizedPnl
                owedRealizedPnlAfter = await clearingHouse.getOwedRealizedPnl(alice.address)
                expect(owedRealizedPnlAfter.sub(owedRealizedPnlBefore)).to.eq(parseEther("0.078257551883207429"))
                expect(await clearingHouse.getPendingFundingPayment(alice.address, baseToken.address)).to.eq(0)
            })

            describe("two makers with one order each", () => {
                it("one taker swaps, one maker reduces liquidity and then the taker swaps again in different direction", async () => {
                    //           |-----| alice range
                    //      |----------| carol range
                    //   -----------------------------> p
                    //                 50400             (154.4310960807)
                    //           50200                   (151.3733068587)
                    //     50000                         (148.3760629231)
                    //         <-------x
                    //         ---->
                    //           end  current

                    // carol opens an order with larger range
                    await clearingHouse.connect(carol).addLiquidity({
                        baseToken: baseToken.address,
                        base: parseEther("0"),
                        quote: parseEther("100"),
                        lowerTick: 50000,
                        upperTick: 50400,
                        minBase: 0,
                        minQuote: 0,
                        deadline: ethers.constants.MaxUint256,
                    })

                    // set index price for a positive funding
                    mockedBaseAggregator.smocked.latestRoundData.will.return.with(async () => {
                        return [0, parseUnits("150.953124", 6), 0, 0, 0]
                    })

                    // bob's position 0 -> -1.2
                    await clearingHouse.connect(bob).openPosition({
                        baseToken: baseToken.address,
                        isBaseToQuote: true,
                        isExactInput: true,
                        amount: parseEther("1.2"),
                        sqrtPriceLimitX96: 0,
                    })
                    await forward(3600)

                    // bob's funding payment = -1.2 * (149.3884076058 - 150.953124) * 3600 / 86400 = 0.07823581971
                    expect(await clearingHouse.getPendingFundingPayment(bob.address, baseToken.address)).to.eq(
                        parseEther("0.078235819711065467"),
                    )
                    // alice's funding payment = -(bob's funding payment) * liquidity share = -(0.07823581971 * 0.6540455179 / 1.2) = -0.04264148935
                    //                         = 0.6540455179 * (149.3884076058 - 150.953124) * 3600 / 86400 = -0.04264148935
                    expect(await clearingHouse.getPendingFundingPayment(alice.address, baseToken.address)).to.eq(
                        parseEther("-0.042641489348233958"),
                    )
                    // carol's funding payment = -(bob's funding payment) * liquidity share = -(0.07823581971 * (1.2 - 0.6540455179) / 1.2) = -0.03559433036
                    //                         = 0.5459544821 * (149.3884076058 - 150.953124) * 3600 / 86400 = -0.03559433036
                    expect(await clearingHouse.getPendingFundingPayment(carol.address, baseToken.address)).to.eq(
                        parseEther("-0.035594330362831508"),
                    )

                    let owedRealizedPnlBefore = await clearingHouse.getOwedRealizedPnl(alice.address)
                    let liquidity = (await exchange.getOpenOrder(alice.address, baseToken.address, 50000, 50400))
                        .liquidity

                    // carol removes half of her liquidity; all pending funding payment should be settled
                    // note that the swap timestamp is 1 second ahead due to hardhat's default block timestamp increment
                    // 0.5459544821 * (149.3884076058 - 150.953124) * 3601 / 86400 = -0.03560421767
                    await expect(
                        clearingHouse.connect(carol).removeLiquidity({
                            baseToken: baseToken.address,
                            lowerTick: 50000,
                            upperTick: 50400,
                            liquidity: liquidity.div(2),
                            minBase: 0,
                            minQuote: 0,
                            deadline: ethers.constants.MaxUint256,
                        }),
                    )
                        .to.emit(clearingHouse, "FundingSettled")
                        .withArgs(carol.address, baseToken.address, parseEther("-0.035604217676821184"))

                    // verify owedRealizedPnl
                    let owedRealizedPnlAfter = await clearingHouse.getOwedRealizedPnl(carol.address)
                    expect(owedRealizedPnlAfter.sub(owedRealizedPnlBefore)).to.eq(parseEther("0.035604217676821184"))
                    expect(await clearingHouse.getPendingFundingPayment(carol.address, baseToken.address)).to.eq(0)

                    // alice's funding payment shouldn't be affected by carol's liquidity removal
                    // however, the timestamp is 1 second ahead thx to hardhat: 0.6540455179 * (149.3884076058 - 150.953124) * 3601 / 86400 = -0.04265333421
                    expect(await clearingHouse.getPendingFundingPayment(alice.address, baseToken.address)).to.eq(
                        parseEther("-0.042653334206386245"),
                    )

                    // bob's position -1.2 -> -0.8
                    await clearingHouse.connect(bob).openPosition({
                        baseToken: baseToken.address,
                        isBaseToQuote: false,
                        isExactInput: false,
                        amount: parseEther("0.4"),
                        sqrtPriceLimitX96: 0,
                    })
                    // note that bob will settle his pending funding payment here
                    await forward(3600)

                    // bob's funding payment = -0.8 * (151.9343974175 - 150.953124) * 3600 / 86400 = -0.03270911392
                    expect(await clearingHouse.getPendingFundingPayment(bob.address, baseToken.address)).to.eq(
                        parseEther("-0.032709113916506038"),
                    )
                    // note that the swap timestamp is 2 second ahead due to hardhat's default block timestamp increment
                    // alice's previous funding payment = 0.6540455179 * (149.3884076058 - 150.953124) * 3602 / 86400 = -0.04266517907
                    // alice's funding payment = previous funding payment + -(bob's funding payment) * liquidity share
                    //                         = -0.04266517907 +  -(-0.03270911392 * 0.532445975136213017 / 0.8) = -0.020895384
                    //                         = -0.04266517907 + 0.532445975136213017 * (151.9343974175 - 150.953124) * 3600 / 86400 = -0.020895384
                    expect(await clearingHouse.getPendingFundingPayment(alice.address, baseToken.address)).to.eq(
                        parseEther("-0.020895383995644115"),
                    )
                    // carol's funding payment = -(bob's funding payment) * liquidity share = -(-0.03270911392 * 0.267554024863786981 / 0.8) = 0.01093931885
                    //                         = 0.267554024863786981 * (151.9343974175 - 150.953124) * 3600 / 86400 = 0.01093931885
                    expect(await clearingHouse.getPendingFundingPayment(carol.address, baseToken.address)).to.eq(
                        parseEther("0.010929431533621946"),
                    )
                })

                it("one maker swaps twice (becoming also taker); the first time does not use his/her own liquidity but the second one does", async () => {
                    //           |-----| alice range
                    //     |-----|       carol range
                    //   -----------------------------> p
                    //               50400               (154.4310960807)
                    //         50200                     (151.3733068587)
                    //   50000                           (148.3760629231)
                    //             <---x
                    //        <----
                    //       end    current

                    // carol opens an order, lower than alice's range
                    await clearingHouse.connect(carol).addLiquidity({
                        baseToken: baseToken.address,
                        base: parseEther("0"),
                        quote: parseEther("100"),
                        lowerTick: 50000,
                        upperTick: 50200,
                        minBase: 0,
                        minQuote: 0,
                        deadline: ethers.constants.MaxUint256,
                    })

                    // carol's position 0 -> -0.2
                    await clearingHouse.connect(carol).openPosition({
                        baseToken: baseToken.address,
                        isBaseToQuote: true,
                        isExactInput: true,
                        amount: parseEther("0.2"),
                        sqrtPriceLimitX96: 0,
                    })
                    await forward(3600)

                    // carol's funding payment = -0.2 * (153.4766329005 - 150.953124) * 3600 / 86400 = -0.02102924084
                    expect(await clearingHouse.getPendingFundingPayment(carol.address, baseToken.address)).to.eq(
                        parseEther("-0.021029240837525072"),
                    )
                    // alice's funding payment = -(carol's funding payment) = -(-0.02102924084) = 0.02102924084
                    expect(await clearingHouse.getPendingFundingPayment(alice.address, baseToken.address)).to.eq(
                        parseEther("0.021029240837525072"),
                    )

                    // carol's position -0.2 -> -1.2
                    await clearingHouse.connect(carol).openPosition({
                        baseToken: baseToken.address,
                        isBaseToQuote: true,
                        isExactInput: true,
                        amount: parseEther("1"),
                        sqrtPriceLimitX96: 0,
                    })
                    await forward(3600)

                    // carol's funding payment = -0.654045517856872802 * (148.9111525791 - 150.953124) * 3600 / 86400 = 0.05564759398
                    expect(await clearingHouse.getPendingFundingPayment(carol.address, baseToken.address)).to.eq(
                        parseEther("0.055647593977026512"),
                    )
                    // alice's previous funding payment = -(-0.2 * (153.4766329005 - 150.953124) * 3601 / 86400) = 0.02103508229
                    // alice's funding payment = previous funding payment + -(carol's funding payment) = 0.02103508229 - 0.05564759398 = -0.03461251169
                    expect(await clearingHouse.getPendingFundingPayment(alice.address, baseToken.address)).to.eq(
                        parseEther("-0.034612511683713238"),
                    )

                    const owedRealizedPnlBefore = await clearingHouse.getOwedRealizedPnl(carol.address)
                    let liquidity = (await exchange.getOpenOrder(carol.address, baseToken.address, 50000, 50200))
                        .liquidity

                    // carol removes all her liquidity; all pending funding payment should be settled
                    // note that the swap timestamp is 1 second ahead due to hardhat's default block timestamp increment
                    // -0.654045517856872802 * (148.9111525791 - 150.953124) * 3601 / 86400 = 0.05566305164
                    await expect(
                        clearingHouse.connect(carol).removeLiquidity({
                            baseToken: baseToken.address,
                            lowerTick: 50000,
                            upperTick: 50200,
                            liquidity: liquidity,
                            minBase: 0,
                            minQuote: 0,
                            deadline: ethers.constants.MaxUint256,
                        }),
                    )
                        .to.emit(clearingHouse, "FundingSettled")
                        .withArgs(carol.address, baseToken.address, parseEther("0.055663051642020131"))

                    // verify owedRealizedPnl
                    const owedRealizedPnlAfter = await clearingHouse.getOwedRealizedPnl(carol.address)
                    expect(owedRealizedPnlAfter.sub(owedRealizedPnlBefore)).to.eq(parseEther("-0.055663051642020131"))
                    expect(await clearingHouse.getPendingFundingPayment(carol.address, baseToken.address)).to.eq(0)

                    // alice's funding payment shouldn't be affected by carol's liquidity removal
                    // 0.02103508229 - 0.055663051642020131 = -0.03462796935
                    expect(await clearingHouse.getPendingFundingPayment(alice.address, baseToken.address)).to.eq(
                        parseEther("-0.034627969348706857"),
                    )
                })
            })
        })
    })
})

// // === useful console.log for verifying stats ===
// console.log("markTwapX96")
// console.log((await clearingHouse.getMarkTwapX96(baseToken.address, twapInterval)).toString())
// console.log("pendingFundingPayment")
// console.log("bob")
// console.log((await clearingHouse.getPendingFundingPayment(bob.address, baseToken.address)).toString())
// console.log("carol")
// console.log(
//     "pendingFundingPayment: ",
//     (await clearingHouse.getPendingFundingPayment(carol.address, baseToken.address)).toString(),
// )
// console.log("positionSize: ", (await clearingHouse.getPositionSize(carol.address, baseToken.address)).toString())
// console.log("alice")
// console.log(
//     "pendingFundingPayment: ",
//     (await clearingHouse.getPendingFundingPayment(alice.address, baseToken.address)).toString(),
// )
// console.log("positionSize: ", (await clearingHouse.getPositionSize(alice.address, baseToken.address)).toString())
// // === useful console.log for verifying stats ===
