import { MockContract } from "@eth-optimism/smock"
import { expect } from "chai"
import { parseUnits } from "ethers/lib/utils"
import { waffle } from "hardhat"
import {
    BaseToken,
    InsuranceFund,
    OrderBook,
    QuoteToken,
    TestClearingHouse,
    TestERC20,
    TestExchange,
    Vault,
} from "../../typechain"
import { addOrder, b2qExactOutput, closePosition, q2bExactInput, removeAllOrders } from "../helper/clearingHouseHelper"
import { initMarket } from "../helper/marketHelper"
import { deposit, mintAndDeposit } from "../helper/token"
import { withdrawAll } from "../helper/vaultHelper"
import { token0Fixture } from "../shared/fixtures"
import { forwardBothTimestamps, initiateBothTimestamps } from "../shared/time"
import { mockIndexPrice } from "../shared/utilities"
import { ClearingHouseFixture, createClearingHouseFixture } from "./fixtures"

describe("ClearingHouse new market listing", () => {
    const [admin, alice, bob, davis] = waffle.provider.getWallets()
    const loadFixture: ReturnType<typeof waffle.createFixtureLoader> = waffle.createFixtureLoader([admin])
    let fixture: ClearingHouseFixture
    let clearingHouse: TestClearingHouse
    let exchange: TestExchange
    let orderBook: OrderBook
    let insuranceFund: InsuranceFund
    let vault: Vault
    let collateral: TestERC20
    let quoteToken: QuoteToken
    let baseToken: BaseToken
    let baseToken3: BaseToken
    let mockedPriceFeedDispatcher: MockContract
    let mockedPriceFeedDispatcher3: MockContract
    let pool3Addr: string

    let lowerTick: number
    let upperTick: number
    let collateralDecimals: number

    beforeEach(async () => {
        fixture = await loadFixture(createClearingHouseFixture())
        clearingHouse = fixture.clearingHouse as TestClearingHouse
        orderBook = fixture.orderBook
        exchange = fixture.exchange as TestExchange
        insuranceFund = fixture.insuranceFund as InsuranceFund
        vault = fixture.vault
        collateral = fixture.USDC
        baseToken = fixture.baseToken
        quoteToken = fixture.quoteToken
        collateralDecimals = await collateral.decimals()
        mockedPriceFeedDispatcher = fixture.mockedPriceFeedDispatcher

        const _token0Fixture = await token0Fixture(quoteToken.address)
        baseToken3 = _token0Fixture.baseToken
        mockedPriceFeedDispatcher3 = _token0Fixture.mockedPriceFeedDispatcher

        const uniAndExFeeTier = 10000
        const ifFeeRatio = 100000
        await fixture.uniV3Factory.createPool(baseToken3.address, quoteToken.address, uniAndExFeeTier)
        pool3Addr = await fixture.uniV3Factory.getPool(baseToken3.address, quoteToken.address, fixture.uniFeeTier)

        await baseToken3.addWhitelist(pool3Addr)
        await quoteToken.addWhitelist(pool3Addr)

        await baseToken3.mintMaximumTo(clearingHouse.address)
        await baseToken3.addWhitelist(clearingHouse.address)

        const initPrice = "148"
        // initial baseToken market
        await initMarket(fixture, initPrice, uniAndExFeeTier, ifFeeRatio, 1000, baseToken.address)
        await mockIndexPrice(mockedPriceFeedDispatcher, initPrice)

        // initial baseToken3 market
        const { minTick, maxTick } = await initMarket(
            fixture,
            initPrice,
            uniAndExFeeTier,
            ifFeeRatio,
            0,
            baseToken3.address,
        )
        await mockIndexPrice(mockedPriceFeedDispatcher3, initPrice)

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

        // increase insuranceFund capacity
        await collateral.mint(insuranceFund.address, parseUnits("1000000", 6))

        // initiate both the real and mocked timestamps to enable hard-coded funding related numbers
        // NOTE: Should be the last step in beforeEach
        await initiateBothTimestamps(clearingHouse)
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

            // pause market temporary
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
            await clearingHouse.connect(bob).settleAllFunding(bob.address)
            await clearingHouse.connect(davis).settleAllFunding(davis.address)

            await forwardBothTimestamps(clearingHouse, 100)
            const bobPendingFundingBefore = await exchange.getPendingFundingPayment(bob.address, baseToken3.address)
            const davisPendingFundingBefore = await exchange.getPendingFundingPayment(davis.address, baseToken3.address)

            await forwardBothTimestamps(clearingHouse, 100)
            const bobPendingFundingAfter = await exchange.getPendingFundingPayment(bob.address, baseToken3.address)
            const davisPendingFundingAfter = await exchange.getPendingFundingPayment(davis.address, baseToken3.address)

            expect(bobPendingFundingAfter.abs()).to.be.gt(bobPendingFundingBefore.abs())
            expect(davisPendingFundingAfter.abs()).to.be.gt(davisPendingFundingBefore.abs())
        })
    })

    describe("liquidate when trader has order in temporary paused market", () => {
        beforeEach(async () => {
            await withdrawAll(fixture, bob)
            // prepare collateral for trader bob
            await mintAndDeposit(fixture, bob, 200)
            // prepare collateral for liquidator davis
            await mintAndDeposit(fixture, davis, 1000)
        })

        it("Can cancel order and liquidate successfully", async () => {
            // Test scenario:
            // Pre-work:
            // 1. alice adds large liquidities on market1 and market3
            // 2. bob adds small liquidities on market1 and market3
            // 3. bob opens long positions on market1 and market3
            // 4. pause market3 temporary
            // 5. drop market1's mark price to make bob to be liquidatable
            // Expected:
            // 1. Can cancel bob's all excess orders
            // 2. Can liquidate bob's positions on market1 and market3.

            // alice add liquidity to baseToken, baseToken3 market
            await addOrder(fixture, alice, 1000, 10000, 48000, 52000, false, baseToken3.address)
            await addOrder(fixture, alice, 1000, 10000, 48000, 52000, false, baseToken.address)

            // bob add liquidity to baseToken, baseToken3 market
            await addOrder(fixture, bob, 1, 10, lowerTick, upperTick, false, baseToken.address)
            await addOrder(fixture, bob, 1, 10, lowerTick, upperTick, false, baseToken3.address)

            // open market
            await exchange.setMaxTickCrossedWithinBlock(baseToken.address, "100000")
            await exchange.setMaxTickCrossedWithinBlock(baseToken3.address, "100000")

            // bob open position in baseToken, baseToken3 market
            await q2bExactInput(fixture, bob, 800, baseToken.address)
            await q2bExactInput(fixture, bob, 800, baseToken3.address)
            // pause any swap in baseToken3 market, not delist
            await exchange.setMaxTickCrossedWithinBlock(baseToken3.address, "0")

            // drop index price to let alice open short position
            await mockIndexPrice(mockedPriceFeedDispatcher, "123")

            // drop baseToken mark price to make bob to be liquidatable
            await b2qExactOutput(fixture, alice, 10000, baseToken.address)
            await forwardBothTimestamps(clearingHouse, 1800)

            // pump index price to let alice close short position
            await mockIndexPrice(mockedPriceFeedDispatcher, "151")
            await closePosition(fixture, alice, 0, baseToken.address)
            // For market 1:
            //   indexPrice: 148.0
            //   marketPrice: 150.211872311820248604
            //   markPrice: 123.526929021317272912
            //

            // can cancelAllExcessOrders from baseToken, baseToken3 market
            await clearingHouse.cancelAllExcessOrders(bob.address, baseToken.address)
            await clearingHouse.cancelAllExcessOrders(bob.address, baseToken3.address)

            // can liquidate position in baseToken3(paused market),
            // due to liquidator takes over the position from trader instead of selling the position in market.
            await clearingHouse.connect(davis)["liquidate(address,address)"](bob.address, baseToken3.address)

            // can liquidate position in baseToken market
            await clearingHouse.connect(davis)["liquidate(address,address)"](bob.address, baseToken.address)
        })
    })
})
