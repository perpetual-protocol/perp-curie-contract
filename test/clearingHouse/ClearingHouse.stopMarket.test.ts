import { MockContract } from "@eth-optimism/smock"
import { expect } from "chai"
import { parseEther, parseUnits } from "ethers/lib/utils"
import { waffle } from "hardhat"
import {
    BaseToken,
    MarketRegistry,
    OrderBook,
    QuoteToken,
    TestAccountBalance,
    TestClearingHouse,
    TestERC20,
    TestExchange,
    UniswapV3Pool,
    Vault,
} from "../../typechain"
import { addOrder, closePosition, q2bExactInput, q2bExactOutput, removeOrder } from "../helper/clearingHouseHelper"
import { getMaxTick, getMinTick } from "../helper/number"
import { deposit } from "../helper/token"
import { forward } from "../shared/time"
import { encodePriceSqrt } from "../shared/utilities"
import { ClearingHouseFixture, createClearingHouseFixture } from "./fixtures"

describe("Clearinghouse StopMarket", async () => {
    const [admin, alice, bob, carol] = waffle.provider.getWallets()
    const loadFixture: ReturnType<typeof waffle.createFixtureLoader> = waffle.createFixtureLoader([admin])
    let fixture: ClearingHouseFixture
    let clearingHouse: TestClearingHouse
    let accountBalance: TestAccountBalance
    let marketRegistry: MarketRegistry
    let exchange: TestExchange
    let orderBook: OrderBook
    let vault: Vault
    let collateral: TestERC20
    let baseToken: BaseToken
    let baseToken2: BaseToken
    let quoteToken: QuoteToken
    let pool: UniswapV3Pool
    let pool2: UniswapV3Pool
    let mockedBaseAggregator: MockContract
    let mockedBaseAggregator2: MockContract
    let collateralDecimals: number

    let lowerTick: number, upperTick: number

    beforeEach(async () => {
        fixture = await loadFixture(createClearingHouseFixture(false))
        clearingHouse = fixture.clearingHouse as TestClearingHouse
        accountBalance = fixture.accountBalance as TestAccountBalance
        orderBook = fixture.orderBook
        exchange = fixture.exchange as TestExchange
        marketRegistry = fixture.marketRegistry
        vault = fixture.vault
        collateral = fixture.USDC
        baseToken = fixture.baseToken
        baseToken2 = fixture.baseToken2
        quoteToken = fixture.quoteToken
        mockedBaseAggregator = fixture.mockedBaseAggregator
        mockedBaseAggregator2 = fixture.mockedBaseAggregator2
        pool = fixture.pool
        pool2 = fixture.pool2
        collateralDecimals = await collateral.decimals()

        mockedBaseAggregator.smocked.latestRoundData.will.return.with(async () => {
            return [0, parseUnits("151", 6), 0, 0, 0]
        })

        mockedBaseAggregator2.smocked.latestRoundData.will.return.with(async () => {
            return [0, parseUnits("151", 6), 0, 0, 0]
        })

        await pool.initialize(encodePriceSqrt(151.3733069, 1))
        await pool2.initialize(encodePriceSqrt(151.3733069, 1))

        // add pool after it's initialized
        await marketRegistry.addPool(baseToken.address, 10000)
        await marketRegistry.addPool(baseToken2.address, 10000)

        const tickSpacing = await pool.tickSpacing()
        lowerTick = getMinTick(tickSpacing)
        upperTick = getMaxTick(tickSpacing)

        // mint
        collateral.mint(alice.address, parseUnits("10000", collateralDecimals))
        collateral.mint(bob.address, parseUnits("10000", collateralDecimals))
        collateral.mint(carol.address, parseUnits("10000", collateralDecimals))
        await deposit(alice, vault, 10000, collateral)
        await deposit(bob, vault, 10000, collateral)
        await deposit(carol, vault, 10000, collateral)

        // maker add liquidity
        await addOrder(fixture, alice, 50, 5000, lowerTick, upperTick, false, baseToken.address)
        await addOrder(fixture, alice, 50, 5000, lowerTick, upperTick, false, baseToken2.address)
    })

    describe("# pause market", async () => {
        beforeEach(async () => {
            // open position
            await q2bExactInput(fixture, bob, 10, baseToken.address)

            mockedBaseAggregator.smocked.latestRoundData.will.return.with(async () => {
                return [0, parseUnits("100", 6), 0, 0, 0]
            })
        })

        it("force error, can not operate in paused market", async () => {
            // stop market for baseToken
            await baseToken.pause(15 * 60 * 1000)

            // can't open position
            await expect(q2bExactInput(fixture, bob, 10, baseToken.address)).to.be.revertedWith("CH_MNO")

            // can't close position
            await expect(closePosition(fixture, bob, 0, baseToken.address)).to.be.revertedWith("CH_MNO")

            // can't add liquidity
            await expect(
                addOrder(fixture, bob, 1, 10, lowerTick, upperTick, false, baseToken.address),
            ).to.be.revertedWith("CH_MNO")

            // can't remove liquidity
            await expect(removeOrder(fixture, alice, 0, lowerTick, upperTick, baseToken.address)).to.be.revertedWith(
                "CH_MNONC",
            )
        })

        it("should be able to query unrealized Pnl in paused market", async () => {
            const [, unrealizedPnl] = await accountBalance.getPnlAndPendingFee(bob.address)
            expect(unrealizedPnl).not.eq("0")
        })

        describe("funding payment", async () => {
            beforeEach(async () => {
                await forward(1)
                await exchange.settleFunding(bob.address, baseToken.address)

                // pause market for baseToken
                await baseToken.pause(15 * 60 * 1000)
            })

            it("fundingPayment should not change anymore in paused market", async () => {
                const pendingFundingPayment1 = await exchange.getPendingFundingPayment(bob.address, baseToken.address)
                expect(pendingFundingPayment1).not.eq("0")

                // forward
                await forward(3000)
                const pendingFundingPayment2 = await exchange.getPendingFundingPayment(bob.address, baseToken.address)

                // pendingFundingPayment should not change
                expect(pendingFundingPayment1).to.be.eq(pendingFundingPayment2)
            })

            it("should be able to settle funding", async () => {
                const pendingFundingPayment = await exchange.getPendingFundingPayment(bob.address, baseToken.address)

                // settleFunding
                const settleFunding = (await exchange.callStatic.settleFunding(bob.address, baseToken.address))
                    .fundingPayment
                expect(settleFunding).to.be.eq(pendingFundingPayment)

                await expect(exchange.settleFunding(bob.address, baseToken.address)).to.be.not.reverted
            })
        })
    })

    describe("# close market", async () => {
        beforeEach(async () => {
            await q2bExactOutput(fixture, bob, "0.1", baseToken.address)
            // close market
            await baseToken.pause(600)
            await baseToken["close(uint256)"](parseEther("100"))
        })

        describe("remove liquidity", async () => {
            it("should be able to removeLiquidity in closed market", async () => {
                const { liquidity } = await orderBook.getOpenOrder(
                    alice.address,
                    baseToken.address,
                    lowerTick,
                    upperTick,
                )
                expect(liquidity).to.be.gt("0")
                await removeOrder(fixture, alice, liquidity, lowerTick, upperTick, baseToken.address)
                expect(await orderBook.hasOrder(alice.address, [baseToken.address])).to.be.eq(false)
            })

            it("remove liquidity and settled to taker position", async () => {
                // removeLiquidity
                const { liquidity } = await orderBook.getOpenOrder(
                    alice.address,
                    baseToken.address,
                    lowerTick,
                    upperTick,
                )
                await removeOrder(fixture, alice, liquidity, lowerTick, upperTick, baseToken.address)

                const positionSizeAfterClosed = await accountBalance.getTakerPositionSize(
                    alice.address,
                    baseToken.address,
                )
                expect(positionSizeAfterClosed).to.be.closeTo(parseEther("-0.1"), 1)
            })
        })

        describe("close position", async () => {
            it("force error, trader still has order in closed market, can not close position")

            it("should be able to closePositionInClosedMarket in closed market", async () => {
                const positionSize = await accountBalance.getTakerPositionSize(bob.address, baseToken.address)
                expect(positionSize).to.be.eq(parseEther("0.1"))

                await expect(clearingHouse.closePositionInClosedMarket(bob.address, baseToken.address)).to.be.emit(
                    clearingHouse,
                    "PositionChanged",
                )
            })

            it("should deregister closed market baseToken", async () => {
                await clearingHouse.closePositionInClosedMarket(bob.address, baseToken.address)

                const baseTokens = await accountBalance.getBaseTokens(bob.address)
                expect(baseTokens.length).to.be.eq(0)
            })
        })
    })

    // describe.only("baseToken of closed market should be deregistered", async () => {
    //     it("deregister closed market baseToken after closePositionInClosedMarket", async () => {
    //         // open position on two market
    //         await q2bExactInput(fixture, bob, 10, baseToken.address)
    //         await q2bExactInput(fixture, bob, 10, baseToken2.address)

    //         // stop baseToken2 pool

    //         await marketRegistry.stopMarket(baseToken2.address, parseEther("1000"))

    //         await expect(clearingHouse.closePositionInClosedMarket(bob.address, baseToken2.address)).to.emit(
    //             accountBalance,
    //             "PnlRealized",
    //         )

    //         const baseTokens = await accountBalance.getBaseTokens(bob.address)

    //         expect(baseTokens.length).to.be.eq(1)
    //     })
    // })

    // describe("settle pnl on closed market", async () => {
    //     it("taker has positive pnl on paused market", async () => {
    //         // open position on two market
    //         await q2bExactInput(fixture, bob, 10, baseToken.address)
    //         await q2bExactInput(fixture, bob, 10, baseToken2.address)

    //         // pause baseToken2 pool
    //         await baseToken2.pause(600)

    //         // taker settle on stopped market
    //         const stoppedMarketPositionSize = await accountBalance.getTakerPositionSize(bob.address, baseToken2.address)
    //         const stoppedMarketQuoteBalance = await accountBalance.getTotalOpenNotional(bob.address, baseToken2.address)
    //         const settledPnl = await clearingHouse.callStatic.closePositionInClosedMarket(
    //             bob.address,
    //             baseToken2.address,
    //         )

    //         const expectedPnl = stoppedMarketPositionSize.mul("1000").add(stoppedMarketQuoteBalance)
    //         expect(settledPnl).to.be.eq(expectedPnl)

    //         await expect(clearingHouse.closePositionInClosedMarket(bob.address, baseToken2.address))
    //             .to.emit(accountBalance, "PnlRealized")
    //             .withArgs(bob.address, expectedPnl)

    //         const [realizedPnl] = await accountBalance.getPnlAndPendingFee(bob.address)
    //         expect(realizedPnl).to.be.eq(expectedPnl)

    //         // maker settle on stopped market
    //         const settledPnlForMaker = await clearingHouse.callStatic.closePositionInClosedMarket(
    //             alice.address,
    //             baseToken2.address,
    //         )
    //         expect(settledPnlForMaker).to.be.closeTo(expectedPnl.mul("-1"), 1010) // error of 1wei * 1000
    //     })

    //     it("taker has negative pnl on paused market", async () => {
    //         // open position on two market
    //         await q2bExactInput(fixture, bob, 10, baseToken.address)
    //         await q2bExactInput(fixture, bob, 10, baseToken2.address)

    //         // stop baseToken2 pool
    //         await marketRegistry.stopMarket(baseToken2.address, parseEther("50"))

    //         const stoppedMarketPositionSize = await accountBalance.getTakerPositionSize(bob.address, baseToken2.address)
    //         const stoppedMarketQuoteBalance = await accountBalance.getTotalOpenNotional(bob.address, baseToken2.address)
    //         const settledPnl = await clearingHouse.callStatic.closePositionInClosedMarket(
    //             bob.address,
    //             baseToken2.address,
    //         )

    //         const expectedPnl = stoppedMarketPositionSize.mul("50").add(stoppedMarketQuoteBalance)
    //         expect(settledPnl).to.be.eq(expectedPnl)

    //         await expect(clearingHouse.closePositionInClosedMarket(bob.address, baseToken2.address))
    //             .to.emit(accountBalance, "PnlRealized")
    //             .withArgs(bob.address, expectedPnl)

    //         const [realizedPnl] = await accountBalance.getPnlAndPendingFee(bob.address)
    //         expect(realizedPnl).to.be.eq(expectedPnl)

    //         // maker settle on stopped market
    //         const settledPnlForMaker = await clearingHouse.callStatic.closePositionInClosedMarket(
    //             alice.address,
    //             baseToken2.address,
    //         )
    //         expect(settledPnlForMaker).to.be.closeTo(expectedPnl.mul("-1"), 60) // error of 1wei * 50
    //     })

    //     it("can not settle pnl twice from stopped market", async () => {
    //         // open position on two market
    //         await q2bExactInput(fixture, bob, 10, baseToken.address)
    //         await q2bExactInput(fixture, bob, 10, baseToken2.address)

    //         // stop baseToken2 pool
    //         await marketRegistry.stopMarket(baseToken2.address, parseEther("1000"))

    //         await expect(clearingHouse.closePositionInClosedMarket(bob.address, baseToken2.address)).to.emit(
    //             accountBalance,
    //             "PnlRealized",
    //         )

    //         const [realizedPnlBeforeSettle] = await accountBalance.getPnlAndPendingFee(bob.address)

    //         await expect(clearingHouse.closePositionInClosedMarket(bob.address, baseToken2.address)).to.not.emit(
    //             accountBalance,
    //             "PnlRealized",
    //         )

    //         const [realizedPnlAfterSettle] = await accountBalance.getPnlAndPendingFee(bob.address)

    //         expect(realizedPnlBeforeSettle).to.be.eq(realizedPnlAfterSettle)
    //     })
    // })

    // describe("check free collateral and withdrawal after stopping market", async () => {
    //     it("taker has positive pnl on stopped market", async () => {
    //         // open position on two market
    //         await q2bExactInput(fixture, bob, 10, baseToken.address)
    //         await q2bExactInput(fixture, bob, 10, baseToken2.address)

    //         // stop baseToken2 pool
    //         await marketRegistry.stopMarket(baseToken2.address, parseEther("1000"))

    //         // accountValue: 10051.799187, totalCollateralValue: 10000
    //         // freeCollateral = 10000 - 1 = 9999
    //         const freeCollateralBefore = await vault.getFreeCollateral(bob.address)
    //         expect(freeCollateralBefore).to.be.eq(parseUnits("9999", collateralDecimals))

    //         // taker settle on stopped market
    //         await clearingHouse.closePositionInClosedMarket(bob.address, baseToken2.address)

    //         // stoppedMarketPositionSize: 0.065271988421256964, stoppedMarketQuoteBalance: -10
    //         // accountValue: 10051.799187, totalCollateralValue: 10000 + stoppedMarketPositionSize.mul("1000").add(stoppedMarketQuoteBalance) = 10055.271988
    //         // freeCollateral = 10051.799187 - 1 = 10050.799187
    //         const freeCollateralAfter = await vault.getFreeCollateral(bob.address)
    //         expect(freeCollateralAfter).to.be.eq(parseUnits("10050.799187", collateralDecimals))

    //         await vault.connect(bob).withdraw(collateral.address, freeCollateralAfter)

    //         expect(await vault.getFreeCollateral(bob.address)).to.be.eq("0")
    //     })

    //     it("taker has negative pnl on stopped market", async () => {
    //         // open position on two market
    //         await q2bExactInput(fixture, bob, 10, baseToken.address)
    //         await q2bExactInput(fixture, bob, 100, baseToken2.address)

    //         // make profit on baseToken market
    //         mockedBaseAggregator.smocked.latestRoundData.will.return.with(async () => {
    //             return [0, parseUnits("200", 6), 0, 0, 0]
    //         })

    //         // stop baseToken2 pool
    //         await marketRegistry.stopMarket(baseToken2.address, parseEther("50"))

    //         // accountValue: 9935.120110058408606450, totalCollateralValue: 10000
    //         // freeCollateral = 9935.120110 - 1 = 9934.120110
    //         const freeCollateralBefore = await vault.getFreeCollateral(bob.address)
    //         expect(freeCollateralBefore).to.be.eq(parseUnits("9934.120111", collateralDecimals))

    //         // taker settle on stopped market
    //         await clearingHouse.closePositionInClosedMarket(bob.address, baseToken2.address)

    //         // stoppedMarketPositionSize: 0.641314247483144273, stoppedMarketQuoteBalance: -100
    //         // accountValue: 9993.0543976843, totalCollateralValue: 10000 + stoppedMarketPositionSize.mul("50").add(stoppedMarketQuoteBalance) = 9932.0657123742
    //         // freeCollateral = 9932.0657123742 - 1 = 9931.0657123742
    //         const freeCollateralAfter = await vault.getFreeCollateral(bob.address)
    //         expect(freeCollateralAfter).to.be.eq(parseUnits("9931.065713", collateralDecimals))

    //         await vault.connect(bob).withdraw(collateral.address, freeCollateralAfter)

    //         expect(await vault.getFreeCollateral(bob.address)).to.be.eq("0")
    //     })
    // })

    // describe("check accounting after stopping market", async () => {
    //     beforeEach(async () => {
    //         // open position on two market
    //         await q2bExactInput(fixture, bob, 10, baseToken.address)

    //         mockedBaseAggregator.smocked.latestRoundData.will.return.with(async () => {
    //             return [0, parseUnits("100", 6), 0, 0, 0]
    //         })
    //         // stop baseToken pool
    //         await marketRegistry.stopMarket(baseToken.address, parseEther("50"))
    //     })

    //     it("unrealized pnl", async () => {
    //         const bobStoppedMarketPositionSize = await accountBalance.getTakerPositionSize(
    //             bob.address,
    //             baseToken.address,
    //         )
    //         const bobStoppedMarketQuoteBalance = await accountBalance.getTotalOpenNotional(
    //             bob.address,
    //             baseToken.address,
    //         )
    //         const [, bobUnrealizedPnl] = await accountBalance.getPnlAndPendingFee(bob.address)

    //         expect(bobUnrealizedPnl).to.be.eq(bobStoppedMarketPositionSize.mul("50").add(bobStoppedMarketQuoteBalance))

    //         const aliceStoppedMarketPositionSize = await accountBalance.getTotalPositionSize(
    //             bob.address,
    //             baseToken.address,
    //         )
    //         const aliceStoppedMarketQuoteBalance = await accountBalance.getTotalOpenNotional(
    //             bob.address,
    //             baseToken.address,
    //         )
    //         const [, aliceUnrealizedPnl] = await accountBalance.getPnlAndPendingFee(bob.address)

    //         expect(aliceUnrealizedPnl).to.be.eq(
    //             aliceStoppedMarketPositionSize.mul("50").add(aliceStoppedMarketQuoteBalance),
    //         )
    //     })

    //     it("total position value", async () => {
    //         const bobStoppedMarketPositionSize = await accountBalance.getTotalPositionSize(
    //             bob.address,
    //             baseToken.address,
    //         )
    //         const bobStoppedMarketPositionValue = await accountBalance.getTotalPositionValue(
    //             bob.address,
    //             baseToken.address,
    //         )

    //         const aliceStoppedMarketPositionSize = await accountBalance.getTotalPositionSize(
    //             alice.address,
    //             baseToken.address,
    //         )
    //         const aliceStoppedMarketPositionValue = await accountBalance.getTotalPositionValue(
    //             alice.address,
    //             baseToken.address,
    //         )

    //         expect(bobStoppedMarketPositionValue).to.be.eq(bobStoppedMarketPositionSize.mul("50"))
    //         expect(aliceStoppedMarketPositionValue).to.be.eq(aliceStoppedMarketPositionSize.mul("50"))
    //     })
    // })

    // describe("maker has order on different markets", async () => {
    //     beforeEach(async () => {
    //         await q2bExactInput(fixture, bob, 100, baseToken.address)
    //         await q2bExactInput(fixture, bob, 100, baseToken2.address)
    //     })
    //     it("can withdraw after closePositionInClosedMarket", async () => {
    //         await clearingHouse.closePositionInClosedMarket(alice.address, baseToken2.address)

    //         const aliceFreeCollateralBefore = await vault.getFreeCollateral(alice.address)
    //         console.log(`aliceFreeCollateralBefore ${aliceFreeCollateralBefore.toString()}`)

    //         expect(await vault.connect(alice).withdraw(collateral.address, aliceFreeCollateralBefore))
    //             .to.emit(vault, "Withdrawn")
    //             .withArgs(collateral.address, alice.address, aliceFreeCollateralBefore)

    //         const aliceFreeCollateralAfter = await vault.getFreeCollateral(alice.address)

    //         expect(aliceFreeCollateralAfter).to.be.eq("0")
    //     })
    // })
})
