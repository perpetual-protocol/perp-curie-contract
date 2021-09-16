import { expect } from "chai"
import { parseEther, parseUnits } from "ethers/lib/utils"
import { ethers, waffle } from "hardhat"
import {
    BaseToken,
    Exchange,
    MarketRegistry,
    OrderBook,
    QuoteToken,
    TestClearingHouse,
    TestERC20,
    UniswapV3Pool,
    Vault,
} from "../../typechain"
import { getMaxTick, getMinTick } from "../helper/number"
import { deposit } from "../helper/token"
import { encodePriceSqrt } from "../shared/utilities"
import { BaseQuoteOrdering, createClearingHouseFixture } from "./fixtures"

describe("ClearingHouse.swap", () => {
    const [admin, alice, bob, carol] = waffle.provider.getWallets()
    const loadFixture: ReturnType<typeof waffle.createFixtureLoader> = waffle.createFixtureLoader([admin])
    let clearingHouse: TestClearingHouse
    let marketRegistry: MarketRegistry
    let exchange: Exchange
    let orderBook: OrderBook
    let vault: Vault
    let collateral: TestERC20
    let baseToken: BaseToken
    let quoteToken: QuoteToken
    let pool: UniswapV3Pool
    let collateralDecimals: number
    let lowerTick: number
    let upperTick: number

    beforeEach(async () => {
        const _clearingHouseFixture = await loadFixture(createClearingHouseFixture(BaseQuoteOrdering.BASE_0_QUOTE_1))
        clearingHouse = _clearingHouseFixture.clearingHouse as TestClearingHouse
        orderBook = _clearingHouseFixture.orderBook
        exchange = _clearingHouseFixture.exchange
        marketRegistry = _clearingHouseFixture.marketRegistry
        vault = _clearingHouseFixture.vault
        collateral = _clearingHouseFixture.USDC
        baseToken = _clearingHouseFixture.baseToken
        quoteToken = _clearingHouseFixture.quoteToken
        pool = _clearingHouseFixture.pool
        collateralDecimals = await collateral.decimals()

        await pool.initialize(encodePriceSqrt("10", "1"))
        // the initial number of oracle can be recorded is 1; thus, have to expand it
        await pool.increaseObservationCardinalityNext((2 ^ 16) - 1)

        // add pool after it's initialized
        await marketRegistry.addPool(baseToken.address, "10000")

        const tickSpacing = await pool.tickSpacing()
        lowerTick = getMinTick(tickSpacing)
        upperTick = getMaxTick(tickSpacing)

        // prepare maker alice
        await collateral.mint(alice.address, parseUnits("1000", collateralDecimals))
        await deposit(alice, vault, 1000, collateral)
        await clearingHouse.connect(alice).addLiquidity({
            baseToken: baseToken.address,
            base: parseEther("100"),
            quote: parseEther("1000"),
            lowerTick,
            upperTick,
            minBase: 0,
            minQuote: 0,
            deadline: ethers.constants.MaxUint256,
        })
    })

    // https://docs.google.com/spreadsheets/d/1fqUUUOofl2ovpW1Du5expYPc_aDI43lyGw50_55oE7k/edit#gid=879273398
    describe("increase short position (B2Q)", () => {
        let bobQuoteBalanceBefore
        let initOpenNotional
        beforeEach(async () => {
            await collateral.mint(bob.address, parseUnits("100", collateralDecimals))
            await deposit(bob, vault, 100, collateral)
            ;[, bobQuoteBalanceBefore] = await clearingHouse.getTokenBalance(bob.address, baseToken.address)
            await clearingHouse.connect(bob).swap({
                // sell 1 base
                baseToken: baseToken.address,
                isBaseToQuote: true,
                isExactInput: true,
                amount: parseEther("1"),
                sqrtPriceLimitX96: 0,
            })
            initOpenNotional = await clearingHouse.getOpenNotional(bob.address, baseToken.address)
        })

        it("openNotional++", async () => {
            const [, bobQuoteBalanceAfter] = await clearingHouse.getTokenBalance(bob.address, baseToken.address)
            const bobQuoteSpent = bobQuoteBalanceAfter.sub(bobQuoteBalanceBefore)
            expect(initOpenNotional).to.deep.eq(bobQuoteSpent)
        })

        it("base balance--", async () => {
            const [bobBaseBalance] = await clearingHouse.getTokenBalance(bob.address, baseToken.address)
            expect(bobBaseBalance).to.deep.eq(parseEther("-1"))
        })

        it("quote balance++", async () => {
            const [, bobQuoteBalance] = await clearingHouse.getTokenBalance(bob.address, baseToken.address)
            expect(bobQuoteBalance.gt(0)).to.be.true
        })

        it("realizedPnl remains", async () => {
            const pnl = await accountBalance.getOwedRealizedPnl(bob.address)
            expect(pnl).eq(0)
        })

        describe("reduce 25% position (exactInput), profit", () => {
            beforeEach(async () => {
                // another trader carol sell base, price down
                await collateral.mint(carol.address, parseUnits("100", collateralDecimals))
                await deposit(carol, vault, 100, collateral)
                await clearingHouse.connect(carol).swap({
                    baseToken: baseToken.address,
                    isBaseToQuote: true,
                    isExactInput: true,
                    amount: parseEther("10"),
                    sqrtPriceLimitX96: 0,
                })

                // bob reduce 25% position
                await clearingHouse.connect(bob).swap({
                    baseToken: baseToken.address,
                    isBaseToQuote: false, // quote to base
                    isExactInput: false, // is exact output (base)
                    amount: parseEther("0.25"),
                    sqrtPriceLimitX96: 0,
                })
            })

            it("openNotionalAbs--", async () => {
                const openNotional = await clearingHouse.getOpenNotional(bob.address, baseToken.address)
                // expect openNotion are same signed
                expect(openNotional.mul(initOpenNotional).gt(0))
                expect(openNotional.abs().lt(initOpenNotional.abs())).be.true
            })

            it("realizedPnl++", async () => {
                const pnl = await accountBalance.getOwedRealizedPnl(bob.address)
                expect(pnl.gt(0)).be.true
            })
        })

        describe("reduce 25% position, loss", () => {
            it("openNotional--")
            it("realizedPnl--")
            it("settle realizePnl to collateral (decreased)")
        })

        describe("reduce 100% position (close), profit", () => {
            it("clear openNotional")
            it("realizedPnl++")
            it("settle realizePnl to collateral (decreased)")
        })

        describe("reduce 100% position (close), loss", () => {
            it("clear openNotional")
            it("realizedPnl--")
            it("settle realizePnl to collateral (decreased)")
        })

        describe("swap reverse and larger amount, only fee loss", () => {
            it("reverse open notional 's signed", async () => {})
            it("realizedPnl only includes fee", async () => {})
        })

        describe("swap reverse and larger amount, profit", () => {
            it("openNotional")
            it("realizedPnl++")
            it("settle realizePnl to collateral (decreased)")
        })

        describe("swap reverse and larger amount, loss", () => {
            it("clear openNotional")
            it("realizedPnl--")
            it("settle realizePnl to collateral (decreased)")
        })
    })

    describe("increase long position (Q2B)", () => {
        let bobQuoteBalanceBefore
        let initOpenNotional
        let posSizeBefore
        beforeEach(async () => {
            await collateral.mint(bob.address, parseUnits("25", collateralDecimals))
            await deposit(bob, vault, 25, collateral)
            ;[, bobQuoteBalanceBefore] = await clearingHouse.getTokenBalance(bob.address, quoteToken.address)
            await clearingHouse.connect(bob).swap({
                // buy base
                baseToken: baseToken.address,
                isBaseToQuote: false, // quote to base
                isExactInput: true, // exact quote
                amount: parseEther("250"),
                sqrtPriceLimitX96: 0,
            })
            initOpenNotional = await clearingHouse.getOpenNotional(bob.address, baseToken.address)
            posSizeBefore = await accountBalance.getPositionSize(bob.address, baseToken.address)
        })

        it("openNotional++", async () => {
            expect(initOpenNotional).to.deep.eq(parseEther("-250"))
        })

        it("base balance++", async () => {
            const [baseBalance] = await clearingHouse.getTokenBalance(bob.address, baseToken.address)
            expect(baseBalance).be.gt(0)
        })

        it("quote balance--", async () => {
            const [, quoteBalance] = await clearingHouse.getTokenBalance(bob.address, baseToken.address)
            expect(quoteBalance).to.deep.eq(parseEther("-250"))
        })

        it("realizedPnl remains", async () => {
            const pnl = await accountBalance.getOwedRealizedPnl(bob.address)
            expect(pnl).eq(0)
        })

        describe("reduce 75% position (exactOutput), loss", () => {
            beforeEach(async () => {
                // another trader carol sell base, price down
                await collateral.mint(carol.address, parseUnits("10000", collateralDecimals))
                await deposit(carol, vault, 10000, collateral)
                await clearingHouse.connect(carol).swap({
                    baseToken: baseToken.address,
                    isBaseToQuote: true,
                    isExactInput: false, // exact output (quote)
                    amount: parseEther("50"),
                    sqrtPriceLimitX96: 0,
                })

                const bobPosSize = await accountBalance.getPositionSize(bob.address, baseToken.address)
                const partial = bobPosSize.div(4).mul(3)
                // bob reduce 75% position
                await clearingHouse.connect(bob).swap({
                    baseToken: baseToken.address,
                    isBaseToQuote: true,
                    isExactInput: true, // is exact input (base)
                    amount: partial,
                    sqrtPriceLimitX96: 0,
                })
            })

            it("openNotional--", async () => {
                const openNotional = await clearingHouse.getOpenNotional(bob.address, baseToken.address)
                // expect openNotion are same signed
                expect(openNotional.mul(initOpenNotional).gt(0))
                expect(openNotional.abs().lt(initOpenNotional.abs())).be.true
            })

            // problem: it might increase the realized pnl when reducing position
            it("realizedPnl--", async () => {
                const pnl = await accountBalance.getOwedRealizedPnl(bob.address)
                expect(pnl.lt(0)).be.true
            })
        })

        describe("swap reverse and larger amount, only fee loss", () => {
            beforeEach(async () => {
                // bob opens a larger reverse position (short)
                await collateral.mint(bob.address, parseUnits("1000", collateralDecimals))
                await deposit(bob, vault, 1000, collateral)
                await clearingHouse.connect(bob).swap({
                    baseToken: baseToken.address,
                    isBaseToQuote: true,
                    isExactInput: false, // is exact output (quote)
                    amount: parseEther("400"),
                    sqrtPriceLimitX96: 0,
                })
            })

            it("realizedPnl is negative", async () => {
                // 1st 250 USD -> 19.839679358717434869 ETH
                // 2nd 38.3990039298 ETH -> 400 USD
                // closedNotional = 400/(38.3990039298/19.839679358717434869) = 206.6686875002
                // pnl = 206.6686875002 - 250 = -43.3313124998
                const pnl = await accountBalance.getOwedRealizedPnl(bob.address)
                expect(pnl).eq(parseEther("-43.331312499999999962"))
            })

            it("reverse open notional 's signed", async () => {
                // 400 - 206.6686875002 = 193.3313124998
                const openNotional = await clearingHouse.getOpenNotional(bob.address, baseToken.address)
                expect(openNotional).eq(parseEther("193.331312499999999962"))
            })
        })
    })
})
