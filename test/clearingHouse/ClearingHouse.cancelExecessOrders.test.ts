import { MockContract } from "@eth-optimism/smock"
import { BigNumber } from "@ethersproject/bignumber"
import { expect } from "chai"
import { parseEther, parseUnits } from "ethers/lib/utils"
import { ethers, waffle } from "hardhat"
import {
    BaseToken,
    Exchange,
    ExchangeRegistry,
    OrderBook,
    QuoteToken,
    TestClearingHouse,
    TestERC20,
    UniswapV3Pool,
    Vault,
} from "../../typechain"
import { deposit } from "../helper/token"
import { encodePriceSqrt } from "../shared/utilities"
import { BaseQuoteOrdering, createClearingHouseFixture } from "./fixtures"

describe("ClearingHouse cancelExcessOrders", () => {
    const [admin, alice, bob, carol] = waffle.provider.getWallets()
    const loadFixture: ReturnType<typeof waffle.createFixtureLoader> = waffle.createFixtureLoader([admin])
    let clearingHouse: TestClearingHouse
    let exchangeRegistry: ExchangeRegistry
    let exchange: Exchange
    let orderBook: OrderBook
    let vault: Vault
    let collateral: TestERC20
    let baseToken: BaseToken
    let baseToken2: BaseToken
    let quoteToken: QuoteToken
    let pool: UniswapV3Pool
    let pool2: UniswapV3Pool
    let mockedBaseAggregator: MockContract
    let collateralDecimals: number
    let baseAmount: BigNumber

    beforeEach(async () => {
        const _clearingHouseFixture = await loadFixture(createClearingHouseFixture(BaseQuoteOrdering.BASE_0_QUOTE_1))
        clearingHouse = _clearingHouseFixture.clearingHouse as TestClearingHouse
        orderBook = _clearingHouseFixture.orderBook
        exchange = _clearingHouseFixture.exchange
        exchangeRegistry = _clearingHouseFixture.exchangeRegistry
        vault = _clearingHouseFixture.vault
        collateral = _clearingHouseFixture.USDC
        baseToken = _clearingHouseFixture.baseToken
        baseToken2 = _clearingHouseFixture.baseToken2
        quoteToken = _clearingHouseFixture.quoteToken
        mockedBaseAggregator = _clearingHouseFixture.mockedBaseAggregator
        pool = _clearingHouseFixture.pool
        pool2 = _clearingHouseFixture.pool2
        collateralDecimals = await collateral.decimals()

        mockedBaseAggregator.smocked.latestRoundData.will.return.with(async () => {
            return [0, parseUnits("100", 6), 0, 0, 0]
        })

        // mint
        collateral.mint(admin.address, parseUnits("10000", collateralDecimals))

        // prepare collateral for alice
        const amount = parseUnits("10", await collateral.decimals())
        await collateral.transfer(alice.address, amount)
        await deposit(alice, vault, 10, collateral)

        await pool.initialize(encodePriceSqrt("100", "1"))
        // add pool after it's initialized
        await exchangeRegistry.addPool(baseToken.address, 10000)

        await pool2.initialize(encodePriceSqrt("50000", "1"))
        // add pool after it's initialized
        await exchangeRegistry.addPool(baseToken2.address, 10000)

        // alice collateral = 10
        // mint 1 base (now 1 eth = $100)
        // accountValue = 10
        // freeCollateral = 0
        // alice adds liquidity (base only) above the current price
        baseAmount = parseUnits("1", await baseToken.decimals())
        await clearingHouse.connect(alice).addLiquidity({
            baseToken: baseToken.address,
            base: baseAmount,
            quote: 0,
            lowerTick: 92200, // 10092.4109643974
            upperTick: 92400, // 10296.2808943793
            minBase: 0,
            minQuote: 0,
            deadline: ethers.constants.MaxUint256,
        })
        const [baseBalance] = await clearingHouse.getTokenBalance(alice.address, baseToken.address)

        // parseUnits("-1", await baseToken.decimals()) or -baseAmount
        expect(baseBalance).be.deep.eq(parseUnits("-1", await baseToken.decimals()))
    })

    describe("cancel alice's all open orders (single order)", () => {
        beforeEach(async () => {
            mockedBaseAggregator.smocked.latestRoundData.will.return.with(async () => {
                return [0, parseUnits("100000", 6), 0, 0, 0]
            })
            await clearingHouse.connect(bob).cancelAllExcessOrders(alice.address, baseToken.address)
        })

        it("has 0 open orders left", async () => {
            const openOrderIds = await exchange.getOpenOrderIds(alice.address, baseToken.address)
            expect(openOrderIds).be.deep.eq([])
        })

        // there will be 1 wei dust of base token due to _removeLiquidity
        it("base balance should reduce", async () => {
            const [baseBalance] = await clearingHouse.getTokenBalance(alice.address, baseToken.address)
            expect(baseBalance).be.deep.eq("-1")
        })

        it("quote balance should return to zero", async () => {
            const [, quoteBalance] = await clearingHouse.getTokenBalance(alice.address, baseToken.address)
            expect(quoteBalance).be.deep.eq(parseUnits("0", await quoteToken.decimals()))
        })
    })

    describe("cancel alice's all open orders (multiple orders)", () => {
        beforeEach(async () => {
            // alice adds another liquidity (base only) above the current price
            const amount = parseUnits("20", await collateral.decimals())
            await collateral.transfer(alice.address, amount)
            await deposit(alice, vault, 20, collateral)

            await clearingHouse.connect(alice).addLiquidity({
                baseToken: baseToken.address,
                base: baseAmount,
                quote: amount,
                lowerTick: 92400,
                upperTick: 92800,
                minBase: 0,
                minQuote: 0,
                deadline: ethers.constants.MaxUint256,
            })

            mockedBaseAggregator.smocked.latestRoundData.will.return.with(async () => {
                return [0, parseUnits("100000", 6), 0, 0, 0]
            })

            await clearingHouse.connect(bob).cancelAllExcessOrders(alice.address, baseToken.address)
        })

        it("has 0 open orders left", async () => {
            // bob as a keeper
            const openOrderIds = await exchange.getOpenOrderIds(alice.address, baseToken.address)
            expect(openOrderIds).be.deep.eq([])
        })

        // there will be 2 wei dust (2 orders) of base token due to _removeLiquidity
        it("base balance should reduce", async () => {
            const [baseBalance] = await clearingHouse.getTokenBalance(alice.address, baseToken.address)
            expect(baseBalance).deep.eq("-2")
        })

        it("quote balance should return to zero", async () => {
            const [, quoteBalance] = await clearingHouse.getTokenBalance(alice.address, baseToken.address)
            expect(quoteBalance).deep.eq(parseUnits("0", await quoteToken.decimals()))
        })
    })

    describe("conservative margin model specific", () => {
        it("can cancel orders even when account value is higher due to positive unrealized PnL", async () => {
            // carol to open a long position (so alice incurs a short position)
            const amount = parseUnits("10", await collateral.decimals())
            await collateral.transfer(carol.address, amount)
            await deposit(carol, vault, 10, collateral)
            // carol position size: 0 -> 0.000490465148677081
            // alice position size: 0 -> -0.000490465148677081
            await clearingHouse.connect(carol).openPosition({
                baseToken: baseToken.address,
                isBaseToQuote: false,
                isExactInput: true,
                oppositeAmountBound: 0,
                amount: parseEther("5"),
                sqrtPriceLimitX96: 0,
                deadline: ethers.constants.MaxUint256,
                referralCode: ethers.constants.HashZero,
            })
            mockedBaseAggregator.smocked.latestRoundData.will.return.with(async () => {
                return [0, parseUnits("101", 6), 0, 0, 0]
            })
            // alice unrealizedPnl = 5 + 101 * -0.000490465148677081 = 4.95046302

            // freeCollateral = min(collateral, accountValue) - imReq
            //                = min(10, 14.95) - 10.1 = -0.1 < 0
            await clearingHouse.connect(bob).cancelAllExcessOrders(alice.address, baseToken.address)
            const openOrderIds = await exchange.getOpenOrderIds(alice.address, baseToken.address)
            expect(openOrderIds).be.deep.eq([])
        })
    })

    it("force fail, alice has enough free collateral so shouldn't be canceled", async () => {
        mockedBaseAggregator.smocked.latestRoundData.will.return.with(async () => {
            return [0, parseUnits("100", 6), 0, 0, 0]
        })

        const openOrderIdsBefore = await exchange.getOpenOrderIds(alice.address, baseToken.address)
        expect(openOrderIdsBefore.length == 1).to.be.true

        // bob as a keeper
        await expect(clearingHouse.cancelAllExcessOrders(alice.address, baseToken.address)).to.be.revertedWith("CH_EFC")

        const openOrderIdsAfter = await exchange.getOpenOrderIds(alice.address, baseToken.address)
        expect(openOrderIdsBefore).be.deep.eq(openOrderIdsAfter)
    })

    it("force fail, alice has only baseToken open orders, but want to cancel orders in baseToken2", async () => {
        mockedBaseAggregator.smocked.latestRoundData.will.return.with(async () => {
            return [0, parseUnits("100000", 6), 0, 0, 0]
        })

        const openOrderIdsBefore = await exchange.getOpenOrderIds(alice.address, baseToken.address)
        expect(openOrderIdsBefore.length == 1).to.be.true

        // _getOrderId() with baseToken2 would generate a non-existent orderId
        await expect(
            clearingHouse.connect(bob).cancelExcessOrders(alice.address, baseToken2.address, openOrderIdsBefore),
        ).to.be.revertedWith("EX_NEO")

        const openOrderIdsAfter = await exchange.getOpenOrderIds(alice.address, baseToken.address)
        expect(openOrderIdsBefore).be.deep.eq(openOrderIdsAfter)
    })
})
