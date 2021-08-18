import { MockContract } from "@eth-optimism/smock"
import { parseEther } from "@ethersproject/units"
import { expect } from "chai"
import { parseUnits } from "ethers/lib/utils"
import { ethers, waffle } from "hardhat"
import { ClearingHouse, TestERC20, UniswapV3Pool, Vault } from "../../typechain"
import { VirtualToken } from "../../typechain/VirtualToken"
import { deposit } from "../helper/token"
import { forward } from "../shared/time"
import { encodePriceSqrt } from "../shared/utilities"
import { BaseQuoteOrdering, createClearingHouseFixture } from "./fixtures"

describe.only("ClearingHouse.funding", () => {
    const [admin, alice, bob, carol] = waffle.provider.getWallets()
    const loadFixture: ReturnType<typeof waffle.createFixtureLoader> = waffle.createFixtureLoader([admin])
    const twapInterval = 15 * 90 // 5 minutes
    let clearingHouse: ClearingHouse
    let vault: Vault
    let collateral: TestERC20
    let baseToken: VirtualToken
    let quoteToken: VirtualToken
    let mockedBaseAggregator: MockContract
    let pool: UniswapV3Pool
    let collateralDecimals: number

    beforeEach(async () => {
        const _clearingHouseFixture = await loadFixture(createClearingHouseFixture(BaseQuoteOrdering.BASE_0_QUOTE_1))
        clearingHouse = _clearingHouseFixture.clearingHouse
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
        await clearingHouse.addPool(baseToken.address, 10000)
        // set twapInterval
        await clearingHouse.setTwapInterval(twapInterval)

        // alice add long limit order
        await collateral.mint(alice.address, parseUnits("10000", collateralDecimals))
        await deposit(alice, vault, 10000, collateral)
        await clearingHouse.connect(alice).mint(quoteToken.address, parseEther("1000"))
        await clearingHouse.connect(alice).mint(baseToken.address, parseEther("10"))

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

        await collateral.mint(carol.address, parseUnits("1000", collateralDecimals))
        await deposit(carol, vault, 1000, collateral)
        await clearingHouse.connect(carol).mint(quoteToken.address, parseEther("1000"))
    })

    describe("# getPendingFundingPayment", () => {
        beforeEach(async () => {
            // bob short
            await clearingHouse.connect(bob).swap({
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

    describe("# _settleFundingAndUpdateFundingGrowth", () => {
        describe("one maker with one order, multiple takers", () => {
            it("one taker swaps once; positive funding", async () => {
                // set index price for a positive funding
                mockedBaseAggregator.smocked.latestRoundData.will.return.with(async () => {
                    return [0, parseUnits("150.953124", 6), 0, 0, 0]
                })

                // bob's position 0 -> -0.099
                await clearingHouse.connect(bob).swap({
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
                    clearingHouse.connect(bob).swap({
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

            it("one taker swaps twice; negative funding", async () => {
                // set index price for a negative funding
                mockedBaseAggregator.smocked.latestRoundData.will.return.with(async () => {
                    return [0, parseUnits("156.953124", 6), 0, 0, 0]
                })

                // bob's position 0 -> -0.099
                await clearingHouse.connect(bob).swap({
                    baseToken: baseToken.address,
                    isBaseToQuote: true,
                    isExactInput: true,
                    amount: parseEther("0.099"),
                    sqrtPriceLimitX96: 0,
                })
                await forward(3600)

                // bob's funding payment = -0.099 * (153.9531248192 - 156.953124) * 3600 / 86400 = 0.01237499662
                expect(await clearingHouse.getPendingFundingPayment(bob.address, baseToken.address)).to.eq(
                    parseEther("0.012374996620807443"),
                )
                // alice's funding payment = -(bob's funding payment)
                expect(await clearingHouse.getPendingFundingPayment(alice.address, baseToken.address)).to.eq(
                    parseEther("-0.012374996620807443"),
                )

                const owedRealizedPnlBefore = await clearingHouse.getOwedRealizedPnl(bob.address)

                // bob's position -0.099 -> -0.2
                // note that the swap timestamp is 1 second ahead due to hardhat's default block timestamp increment
                // -0.099 * (153.9531248192 - 156.953124) * 3601 / 86400 = 0.01237843412
                await expect(
                    clearingHouse.connect(bob).swap({
                        baseToken: baseToken.address,
                        isBaseToQuote: true,
                        isExactInput: true,
                        amount: parseEther("0.101"),
                        sqrtPriceLimitX96: 0,
                    }),
                )
                    .to.emit(clearingHouse, "FundingSettled")
                    .withArgs(bob.address, baseToken.address, parseEther("0.012378434119868779"))

                await forward(3600)

                // bob's funding payment = -0.2 * (153.4766329005 - 156.953124) * 3600 / 86400 = 0.02897075916
                expect(await clearingHouse.getPendingFundingPayment(bob.address, baseToken.address)).to.eq(
                    parseEther("0.028970759162474927"),
                )
                // alice's pending funding payment = -(bob's settled funding payment + pending funding payment)
                // -(0.01237843412 + 0.02897075916) = -0.04134919328
                expect(await clearingHouse.getPendingFundingPayment(alice.address, baseToken.address)).to.eq(
                    parseEther("-0.041349193282343706"),
                )

                // swaps arbitrary amount to trigger funding settlement
                // note that the swap timestamp is 1 second ahead due to hardhat's default block timestamp increment
                // -0.2 * (153.4766329005 - 156.953124) * 3601 / 86400 = 0.0289788066
                await expect(
                    clearingHouse.connect(bob).swap({
                        baseToken: baseToken.address,
                        isBaseToQuote: true,
                        isExactInput: true,
                        amount: parseEther("0.0000000001"),
                        sqrtPriceLimitX96: 0,
                    }),
                )
                    .to.emit(clearingHouse, "FundingSettled")
                    .withArgs(bob.address, baseToken.address, parseEther("0.028978806595575614"))

                // verify owedRealizedPnl
                const owedRealizedPnlAfter = await clearingHouse.getOwedRealizedPnl(bob.address)
                // -(0.01237843412 + 0.0289788066) = -0.04135724072
                expect(owedRealizedPnlAfter.sub(owedRealizedPnlBefore)).to.eq(parseEther("-0.041357240715444393"))
                expect(await clearingHouse.getPendingFundingPayment(bob.address, baseToken.address)).to.eq(0)
            })

            it("two takers; first positive then negative funding", async () => {
                // set index price for a positive funding
                mockedBaseAggregator.smocked.latestRoundData.will.return.with(async () => {
                    return [0, parseUnits("150.953124", 6), 0, 0, 0]
                })

                // bob's position 0 -> -0.099
                await clearingHouse.connect(bob).swap({
                    baseToken: baseToken.address,
                    isBaseToQuote: true,
                    isExactInput: true,
                    amount: parseEther("0.099"),
                    sqrtPriceLimitX96: 0,
                })
                await forward(3600)

                // carol's position 0 -> 0.09
                await clearingHouse.connect(carol).swap({
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
                    clearingHouse.connect(bob).swap({
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
                    clearingHouse.connect(carol).swap({
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

        describe("one maker with multiple orders, one taker", () => {
            //           |-----|
            //      |-------------------|
            //   -----------------------------> p
            //         x-----------> trade
            //
            it("two orders are both used, and then reduce & remove liquidity of one order; positive funding", async () => {})
        })

        describe("multiple makers with one order each and one maker also becomes taker", () => {
            it("does not swap his/her own liquidity", async () => {})

            it("swaps his/her own liquidity; positive funding", async () => {})

            it("swaps his/her own liquidity; negative funding", async () => {})
        })
    })
})

// // === useful console.log for verifying stats ===
// console.log("markTwapX96")
// console.log((await clearingHouse.getMarkTwapX96(baseToken.address, twapInterval)).toString())
// console.log("pending funding payment")
// console.log("bob")
// console.log((await clearingHouse.getPendingFundingPayment(bob.address, baseToken.address)).toString())
// console.log("carol")
// console.log((await clearingHouse.getPendingFundingPayment(carol.address, baseToken.address)).toString())
// console.log("alice")
// console.log((await clearingHouse.getPendingFundingPayment(alice.address, baseToken.address)).toString())
// // === useful console.log for verifying stats ===
