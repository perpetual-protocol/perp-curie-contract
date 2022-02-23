import { MockContract } from "@eth-optimism/smock"
import { expect } from "chai"
import { parseEther, parseUnits } from "ethers/lib/utils"
import { waffle } from "hardhat"
import {
    BaseToken,
    ClearingHouse,
    Exchange,
    MarketRegistry,
    OrderBook,
    QuoteToken,
    TestERC20,
    Vault,
} from "../../typechain"
import { addOrder, b2qExactOutput, closePosition, q2bExactInput, removeAllOrders } from "../helper/clearingHouseHelper"
import { initMarket } from "../helper/marketHelper"
import { deposit } from "../helper/token"
import { emergencyPriceFeedFixture, token0Fixture } from "../shared/fixtures"
import { forward } from "../shared/time"
import { getMarketTwap } from "../shared/utilities"
import { ClearingHouseFixture, createClearingHouseFixture } from "./fixtures"

describe("ClearingHouse new market listing", () => {
    const [admin, alice, bob, davis] = waffle.provider.getWallets()
    const loadFixture: ReturnType<typeof waffle.createFixtureLoader> = waffle.createFixtureLoader([admin])
    let fixture: ClearingHouseFixture
    let clearingHouse: ClearingHouse
    let marketRegistry: MarketRegistry
    let exchange: Exchange
    let orderBook: OrderBook
    let vault: Vault
    let collateral: TestERC20
    let quoteToken: QuoteToken
    let baseToken: BaseToken
    let baseToken3: BaseToken
    let mockedBaseAggregator: MockContract
    let mockedBaseAggregator3: MockContract
    let pool3Addr: string

    let lowerTick: number
    let upperTick: number
    let collateralDecimals: number

    beforeEach(async () => {
        fixture = await loadFixture(createClearingHouseFixture(false))
        clearingHouse = fixture.clearingHouse
        orderBook = fixture.orderBook
        exchange = fixture.exchange
        marketRegistry = fixture.marketRegistry
        vault = fixture.vault
        collateral = fixture.USDC
        baseToken = fixture.baseToken
        quoteToken = fixture.quoteToken
        collateralDecimals = await collateral.decimals()
        mockedBaseAggregator = fixture.mockedBaseAggregator

        const _token0Fixture = await token0Fixture(quoteToken.address)
        baseToken3 = _token0Fixture.baseToken
        mockedBaseAggregator3 = _token0Fixture.mockedAggregator

        const uniFeeTier = 10000
        const ifFeeRatio = 100000
        await fixture.uniV3Factory.createPool(baseToken3.address, quoteToken.address, uniFeeTier)
        pool3Addr = await fixture.uniV3Factory.getPool(baseToken3.address, quoteToken.address, fixture.uniFeeTier)

        await baseToken3.addWhitelist(pool3Addr)
        await quoteToken.addWhitelist(pool3Addr)

        await baseToken3.mintMaximumTo(clearingHouse.address)
        await baseToken3.addWhitelist(clearingHouse.address)

        // initial baseToken market
        await initMarket(fixture, 148, uniFeeTier, ifFeeRatio, 0, baseToken.address, mockedBaseAggregator)

        // initial baseToken3 market
        const { minTick, maxTick } = await initMarket(
            fixture,
            148,
            uniFeeTier,
            ifFeeRatio,
            0,
            baseToken3.address,
            mockedBaseAggregator3,
        )

        lowerTick = minTick
        upperTick = maxTick

        // mint
        collateral.mint(admin.address, parseUnits("100000", collateralDecimals))

        // prepare collateral for alice
        const amount = parseUnits("10000", await collateral.decimals())
        await collateral.transfer(alice.address, amount)
        await deposit(alice, vault, 10000, collateral)
        await collateral.transfer(bob.address, amount)
        await deposit(bob, vault, 1000, collateral)
        await collateral.transfer(davis.address, amount)
        await deposit(davis, vault, 1000, collateral)
    })

    describe("list new market but not enable to trade", () => {
        it("force error when open position", async () => {
            await expect(q2bExactInput(fixture, bob, 100, baseToken3.address)).to.be.revertedWith("EX_MIP")
        })
        it("can add/remove liquidity", async () => {
            const orderLowerTick = lowerTick + 6000
            const orderUpperTick = upperTick - 6000

            // add liquidity
            await addOrder(fixture, alice, 100, 1000, orderLowerTick, orderUpperTick, false, baseToken3.address)

            let orderIds = await orderBook.getOpenOrderIds(alice.address, baseToken3.address)
            expect(orderIds.length).eq(1)

            // remove liquidity
            await removeAllOrders(fixture, alice, baseToken3.address)

            expect(await orderBook.hasOrder(alice.address, [baseToken3.address])).eq(false)
        })
    })

    describe("pause market", () => {
        beforeEach(async () => {
            // add liquidity
            await addOrder(fixture, alice, 100, 10000, 48000, 52000, false, baseToken3.address)

            // open market
            await exchange.setMaxTickCrossedWithinBlock(baseToken3.address, "1000")

            // open position, bob long, davis short
            await q2bExactInput(fixture, bob, 4, baseToken3.address)
            await b2qExactOutput(fixture, davis, 2, baseToken3.address)

            // pause market
            await exchange.setMaxTickCrossedWithinBlock(baseToken3.address, "0")
        })
        it("force error when close position", async () => {
            await expect(closePosition(fixture, bob, 0, baseToken3.address)).to.be.revertedWith("EX_MIP")
        })
        it("force error when open position", async () => {
            await expect(q2bExactInput(fixture, bob, 10, baseToken3.address)).to.be.revertedWith("EX_MIP")
        })
        it("can add/remove liquidity", async () => {
            const orderLowerTick = lowerTick + 6000
            const orderUpperTick = upperTick - 6000

            // add liquidity
            await addOrder(fixture, alice, 100, 1000, orderLowerTick, orderUpperTick, false, baseToken3.address)

            let orderIds = await orderBook.getOpenOrderIds(alice.address, baseToken3.address)
            expect(orderIds.length).eq(2)

            // remove liquidity
            await removeAllOrders(fixture, alice, baseToken3.address)

            expect(await orderBook.hasOrder(alice.address, [baseToken3.address])).eq(false)
        })
        it("funding will cumulate", async () => {
            await clearingHouse.settleAllFunding(bob.address)
            await clearingHouse.settleAllFunding(davis.address)

            await forward(100)
            const bobPendingFundingBefore = await exchange.getPendingFundingPayment(bob.address, baseToken3.address)
            const davisPendingFundingBefore = await exchange.getPendingFundingPayment(davis.address, baseToken3.address)

            await forward(100)
            const bobPendingFundingAfter = await exchange.getPendingFundingPayment(bob.address, baseToken3.address)
            const davisPendingFundingAfter = await exchange.getPendingFundingPayment(davis.address, baseToken3.address)

            expect(bobPendingFundingAfter.abs()).to.be.gt(bobPendingFundingBefore.abs())
            expect(davisPendingFundingAfter.abs()).to.be.gt(davisPendingFundingBefore.abs())
        })

        it("Stop to cumulate funding after change to emergency oracle", async () => {
            await forward(100)
            // Random to update global funding
            await clearingHouse.settleAllFunding(bob.address)

            // Bob's funding has been settled
            const bobBefore = await exchange.getPendingFundingPayment(bob.address, baseToken3.address)
            expect(bobBefore).to.be.eq(0)

            // Davis's funding still cumulate
            const davisBefore = await exchange.getPendingFundingPayment(davis.address, baseToken3.address)
            expect(davisBefore.abs()).to.be.gt(0)

            const emergencyPriceFeed = await emergencyPriceFeedFixture(pool3Addr, baseToken3)
            const priceFeed = await baseToken3.getPriceFeed()
            expect(priceFeed).to.be.eq(emergencyPriceFeed.address)

            // Ensure index twap should be equal market twap
            // There's rounding difference when converting sqrtPriceX96 to price
            const interval = 60
            const indexTwap = await baseToken3.getIndexPrice(interval)
            const markTwap = parseEther(await getMarketTwap(exchange, baseToken, interval))
            expect(indexTwap).to.be.closeTo(markTwap, 1)

            // Should not cumulate funding after forward timestamp
            await forward(100)
            const bobAfter100 = await exchange.getPendingFundingPayment(bob.address, baseToken3.address)
            expect(bobAfter100).to.be.eq(0)
            const davisAfter100 = await exchange.getPendingFundingPayment(davis.address, baseToken3.address)
            expect(davisAfter100).to.be.eq(davisBefore)

            // Davis should get zero pending funding after funding settlement
            await clearingHouse.settleAllFunding(davis.address)
            await forward(100)
            const davisAfterSettle = await exchange.getPendingFundingPayment(davis.address, baseToken3.address)
            expect(davisAfterSettle).to.be.eq(0)
        })
    })
    describe("liquidate when trader has order in paused market", () => {
        beforeEach(async () => {
            // alice add liquidity to baseToken, baseToken3 market
            await addOrder(fixture, alice, 1000, 10000, 48000, 52000, false, baseToken3.address)
            await addOrder(fixture, alice, 1000, 10000, 48000, 52000, false, baseToken.address)

            // bob add liquidity to baseToken, baseToken3 market
            await addOrder(fixture, bob, 1, 10, lowerTick, upperTick, false, baseToken.address)
            await addOrder(fixture, bob, 1, 10, lowerTick, upperTick, false, baseToken3.address)

            // open market
            await exchange.setMaxTickCrossedWithinBlock(baseToken.address, "1000")
            await exchange.setMaxTickCrossedWithinBlock(baseToken3.address, "1000")

            // bob open position in baseToken, baseToken3 market
            await q2bExactInput(fixture, bob, 800, baseToken.address)
            await q2bExactInput(fixture, bob, 800, baseToken3.address)

            // pause baseToken3 market
            await exchange.setMaxTickCrossedWithinBlock(baseToken3.address, "0")

            // drop baseToken market price
            mockedBaseAggregator.smocked.latestRoundData.will.return.with(async () => {
                return [0, parseUnits("0.000001", 6), 0, 0, 0]
            })

            // drop baseToken3 market price
            mockedBaseAggregator3.smocked.latestRoundData.will.return.with(async () => {
                return [0, parseUnits("0.000001", 6), 0, 0, 0]
            })
        })
        it("liquidate process", async () => {
            // can cancelAllExcessOrders from baseToken, baseToken3 market
            await clearingHouse.cancelAllExcessOrders(bob.address, baseToken.address)
            await clearingHouse.cancelAllExcessOrders(bob.address, baseToken3.address)

            // can't liquidate position in baseToken3(paused market)
            await expect(
                clearingHouse["liquidate(address,address,uint256)"](bob.address, baseToken3.address, 0),
            ).to.be.revertedWith("EX_MIP")

            // can liquidate position in baseToken market
            await clearingHouse["liquidate(address,address,uint256)"](bob.address, baseToken.address, 0)
        })
    })
})
