import { MockContract } from "@eth-optimism/smock"
import { BigNumber } from "@ethersproject/bignumber"
import { expect } from "chai"
import { parseEther, parseUnits } from "ethers/lib/utils"
import { ethers, waffle } from "hardhat"
import {
    BaseToken,
    OrderBook,
    QuoteToken,
    TestAccountBalance,
    TestClearingHouse,
    TestERC20,
    UniswapV3Pool,
    Vault,
} from "../../typechain"
import { addOrder, q2bExactInput, removeAllOrders } from "../helper/clearingHouseHelper"
import { initMarket } from "../helper/marketHelper"
import { deposit } from "../helper/token"
import { encodePriceSqrt, mockIndexPrice, mockMarkPrice, syncIndexToMarketPrice } from "../shared/utilities"
import { ClearingHouseFixture, createClearingHouseFixture } from "./fixtures"

describe("ClearingHouse cancelExcessOrders", () => {
    const [admin, alice, bob, carol] = waffle.provider.getWallets()
    const loadFixture: ReturnType<typeof waffle.createFixtureLoader> = waffle.createFixtureLoader([admin])
    let fixture: ClearingHouseFixture
    let clearingHouse: TestClearingHouse
    let accountBalance: TestAccountBalance
    let orderBook: OrderBook
    let vault: Vault
    let collateral: TestERC20
    let baseToken: BaseToken
    let baseToken2: BaseToken
    let quoteToken: QuoteToken
    let pool: UniswapV3Pool
    let mockedPriceFeedDispatcher: MockContract
    let mockedPriceFeedDispatcher2: MockContract
    let collateralDecimals: number
    let baseAmount: BigNumber

    beforeEach(async () => {
        fixture = await loadFixture(createClearingHouseFixture())
        clearingHouse = fixture.clearingHouse as TestClearingHouse
        accountBalance = fixture.accountBalance as TestAccountBalance
        orderBook = fixture.orderBook
        vault = fixture.vault
        collateral = fixture.USDC
        baseToken = fixture.baseToken
        baseToken2 = fixture.baseToken2
        quoteToken = fixture.quoteToken
        mockedPriceFeedDispatcher = fixture.mockedPriceFeedDispatcher
        mockedPriceFeedDispatcher2 = fixture.mockedPriceFeedDispatcher2
        pool = fixture.pool
        collateralDecimals = await collateral.decimals()

        await mockIndexPrice(mockedPriceFeedDispatcher, "100")

        await mockIndexPrice(mockedPriceFeedDispatcher2, "50000")

        // mint
        collateral.mint(admin.address, parseUnits("100000", collateralDecimals))

        // prepare collateral for alice
        const amount = parseUnits("10", await collateral.decimals())
        await collateral.transfer(alice.address, amount)
        await deposit(alice, vault, 10, collateral)

        let initPrice = "100"
        await initMarket(fixture, initPrice)
        initPrice = "50000"
        await initMarket(fixture, initPrice, undefined, undefined, undefined, baseToken2.address)

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
            useTakerBalance: false,
            deadline: ethers.constants.MaxUint256,
        })
        const [baseBalance] = await clearingHouse.getTokenBalance(alice.address, baseToken.address)

        // parseUnits("-1", await baseToken.decimals()) or -baseAmount
        expect(baseBalance).be.deep.eq(parseUnits("-1", await baseToken.decimals()))
    })

    describe("cancel alice's all open orders (single order)", () => {
        beforeEach(async () => {
            // mock mark price to make alice is liquidatable
            await mockMarkPrice(accountBalance, baseToken.address, "100000")
            const tx = await clearingHouse.connect(bob).cancelAllExcessOrders(alice.address, baseToken.address)
            await expect(tx).to.emit(clearingHouse, "LiquidityChanged")
            await expect(tx).to.emit(clearingHouse, "PositionChanged").withArgs(
                alice.address, // trader
                baseToken.address, // baseToken
                "-1", // exchangedPositionSize. it's rounding difference.
                "0", // exchangedPositionNotional
                "0", // fee
                "0", // openNotional
                "0", // realizedPnl
                encodePriceSqrt("100", "1"), // sqrtPriceAfterX96
            )
        })

        it("has 0 open orders left", async () => {
            const openOrderIds = await orderBook.getOpenOrderIds(alice.address, baseToken.address)
            expect(openOrderIds).be.deep.eq([])
        })

        it("base balance should return to zero", async () => {
            const [baseBalance] = await clearingHouse.getTokenBalance(alice.address, baseToken.address)
            expect(baseBalance).be.deep.eq("0")
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
                useTakerBalance: false,
                deadline: ethers.constants.MaxUint256,
            })

            // mock mark price to make alice is liquidatable
            await mockMarkPrice(accountBalance, baseToken.address, "100000")

            const tx = await clearingHouse.connect(bob).cancelAllExcessOrders(alice.address, baseToken.address)
            await expect(tx).to.emit(clearingHouse, "LiquidityChanged")
            await expect(tx).to.emit(clearingHouse, "PositionChanged").withArgs(
                alice.address, // trader
                baseToken.address, // baseToken
                "-2", // exchangedPositionSize, it's rounding difference.
                "0", // exchangedPositionNotional
                "0", // fee
                "0", // openNotional
                "0", // realizedPnl
                encodePriceSqrt("100", "1"), // sqrtPriceAfterX96
            )
        })

        it("has 0 open orders left", async () => {
            // bob as a keeper
            const openOrderIds = await orderBook.getOpenOrderIds(alice.address, baseToken.address)
            expect(openOrderIds).be.deep.eq([])
        })

        it("base balance should return to zero", async () => {
            const [baseBalance] = await clearingHouse.getTokenBalance(alice.address, baseToken.address)
            expect(baseBalance).deep.eq("0")
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

            // set index price to near market price (alice tick range is 92200 ~ 92400)
            await mockIndexPrice(mockedPriceFeedDispatcher, "10101")

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

            // mock mark price to make alice is liquidatable
            await mockMarkPrice(accountBalance, baseToken.address, "162")

            // alice unrealizedPnl = 5 + 162 * -0.000490465148677081 = 4.9205446459
            // pos value = |-0.000490465148677081 * 162| = 0.07945535409
            // total debt value = base debt * price + quote debt = 1 * 162 + 0 = 162
            // total margin req = max(pos value, total debt value) = 162
            // mmReq = 162 * 6.25% = 10.125

            // use mmRatio here to calculate required collateral
            // https://app.asana.com/0/1200338471046334/1200394318059946/f

            // requiredCollateral = min(collateral, accountValue) - mmReq
            //                = min(10, 14.95) - 10.125  < 0
            const tx = await clearingHouse.connect(bob).cancelAllExcessOrders(alice.address, baseToken.address)
            await expect(tx).to.emit(clearingHouse, "LiquidityChanged")
            await expect(tx).to.emit(clearingHouse, "PositionChanged").withArgs(
                alice.address, // trader
                baseToken.address, // baseToken
                parseEther("-0.000490465148677081"), // exchangedPositionSize
                parseEther("4.949999999999999999"), // exchangedPositionNotional
                "0", // fee
                parseEther("4.949999999999999999"), // openNotional
                "0", // realizedPnl
                "7959378662046472307986903031465", // sqrtPriceAfterX96
            )

            const openOrderIds = await orderBook.getOpenOrderIds(alice.address, baseToken.address)
            expect(openOrderIds).be.deep.eq([])
        })
    })

    describe("realize Pnl after cancel orders", () => {
        beforeEach(async () => {
            const amount = parseUnits("2000", await collateral.decimals())
            await collateral.transfer(bob.address, amount)
            await deposit(bob, vault, 2000, collateral)

            await collateral.transfer(carol.address, parseUnits("20", await collateral.decimals()))
            await deposit(carol, vault, 20, collateral)
        })

        it("bob should get realizedPnl after cancel orders", async () => {
            // set index price to near market price (alice tick range is 92200 ~ 92400)
            await mockIndexPrice(mockedPriceFeedDispatcher, "10101")

            // 1. bob opens a long position, position size: 0.000490465148677081
            await clearingHouse.connect(bob).openPosition({
                baseToken: baseToken.address,
                isBaseToQuote: false,
                isExactInput: true,
                oppositeAmountBound: 0,
                amount: parseEther("5"),
                sqrtPriceLimitX96: 0,
                deadline: ethers.constants.MaxUint256,
                referralCode: ethers.constants.HashZero,
            })

            // 2. alice remove liquidity to make test easier
            await removeAllOrders(fixture, alice, baseToken.address)

            // 3. bob add liquidity
            // sync index price to market price to pass price spread checking
            await syncIndexToMarketPrice(mockedPriceFeedDispatcher, pool)
            await addOrder(fixture, bob, 1, 0, 92400, 92800, false, baseToken.address)

            // 4. set mark price lower to withdraw bob's collateral
            await mockMarkPrice(accountBalance, baseToken.address, "100")

            await vault
                .connect(bob)
                .withdraw(collateral.address, parseUnits("1984.553951", await collateral.decimals()))

            // 5. carol opens a long position and bob incurs a short position
            // carol position size: 0 -> 0.000961493924477756
            // bob position size: 0 -> -0.000961493924477756
            // set index price higher to let carol can open a long position
            await mockIndexPrice(mockedPriceFeedDispatcher, "10101")

            await q2bExactInput(fixture, carol, "10", baseToken.address)

            // mock mark price to cancel bob's order
            await mockMarkPrice(accountBalance, baseToken.address, "1000")

            // 6. cancel bob's open orders
            // bob's taker base = 0.000490465148677081
            // bob's taker quote = -5
            // bob's maker base = -0.000961493924477757
            // bob's maker quote = 9.9
            // realized pnl after cancel order:  -5 + (9.9 / (0.000961493924477757/0.000490465148677081)) = 0.05006308234
            // bob's taker base = 0.000490465148677081 - 0.000961493924477757 = -0.0004710287758
            // bob's taker quote = takerQuote + makerQuote - realizedPnl
            //                   = -5 + 9.9 - 0.05006308234 = 4.8499369177
            const tx = await clearingHouse.cancelAllExcessOrders(bob.address, baseToken.address)
            await expect(tx).to.emit(clearingHouse, "LiquidityChanged")
            await expect(tx).to.emit(clearingHouse, "PositionChanged").withArgs(
                bob.address, // trader
                baseToken.address, // baseToken
                parseEther("-0.000961493924477757"), // exchangedPositionSize, close to -0.000961493924477756 due to rounding difference
                parseEther("9.899999999999999999"), // exchangedPositionNotional, close to 9.9 due to rounding difference
                "0", // fee
                parseEther("4.849936917656081816"), // openNotional
                parseEther("0.050063082343918183"), // realizedPnl
                "8039481551169820550306381345628", // sqrtPriceAfterX96
            )
        })
    })

    it("force fail, alice has enough free collateral so shouldn't be canceled", async () => {
        await mockMarkPrice(accountBalance, baseToken.address, "160")

        const openOrderIdsBefore = await orderBook.getOpenOrderIds(alice.address, baseToken.address)
        expect(openOrderIdsBefore.length == 1).to.be.true

        // bob as a keeper
        await expect(clearingHouse.cancelAllExcessOrders(alice.address, baseToken.address)).to.be.revertedWith(
            "CH_NEXO",
        )

        const openOrderIdsAfter = await orderBook.getOpenOrderIds(alice.address, baseToken.address)
        expect(openOrderIdsBefore).be.deep.eq(openOrderIdsAfter)
    })

    it("force fail, alice has only baseToken open orders, but want to cancel orders in baseToken2", async () => {
        await mockMarkPrice(accountBalance, baseToken.address, "100000")

        const openOrderIdsBefore = await orderBook.getOpenOrderIds(alice.address, baseToken.address)
        expect(openOrderIdsBefore.length == 1).to.be.true

        // _getOrderId() with baseToken2 would generate a non-existent orderId
        await expect(
            clearingHouse.connect(bob).cancelExcessOrders(alice.address, baseToken2.address, openOrderIdsBefore),
        ).to.be.reverted

        const openOrderIdsAfter = await orderBook.getOpenOrderIds(alice.address, baseToken.address)
        expect(openOrderIdsBefore).be.deep.eq(openOrderIdsAfter)
    })

    describe("cancel excess orders when account is liquidable", () => {
        beforeEach(async () => {
            // mock eth mark price = 100
            await mockMarkPrice(accountBalance, baseToken.address, "100")

            // mock btc index price = 50000
            await mockMarkPrice(accountBalance, baseToken2.address, "50000")

            await collateral.transfer(alice.address, parseUnits("10000", await collateral.decimals()))
            await deposit(alice, vault, 10000, collateral)

            // alice adds eth liquidity
            // current price tick: 46054.0044065994
            await clearingHouse.connect(alice).addLiquidity({
                baseToken: baseToken.address,
                base: 0,
                quote: parseUnits("1000", await quoteToken.decimals()),
                lowerTick: 45800, // 97.4920674557
                upperTick: 46000, // 99.4614384055
                minBase: 0,
                minQuote: 0,
                useTakerBalance: false,
                deadline: ethers.constants.MaxUint256,
            })

            // alice adds btc liquidity
            // current price tick: 108203.1926430847
            await clearingHouse.connect(alice).addLiquidity({
                baseToken: baseToken2.address,
                base: parseUnits("1", await baseToken.decimals()),
                quote: 0,
                lowerTick: 108400, // 50993.7337306258
                upperTick: 108600, // 52023.8234645706
                minBase: 0,
                minQuote: 0,
                useTakerBalance: false,
                deadline: ethers.constants.MaxUint256,
            })

            // scenario:
            // 0. bob's collateral: 30
            // 1. bob short 1 eth
            // 2. bob long 0.004 btc
            // 3. eth price increased
            // 4. bob add btc liquidity
            // 5. bob account is liquidable
            // 6. should cancel bob's excess orders
            await collateral.transfer(bob.address, parseUnits("30", await collateral.decimals()))
            await deposit(bob, vault, 30, collateral)

            // bob short 1 eth, quote = 98.369476739760354
            await clearingHouse.connect(bob).openPosition({
                baseToken: baseToken.address,
                isBaseToQuote: true,
                isExactInput: true,
                oppositeAmountBound: 0,
                amount: parseEther("1"),
                sqrtPriceLimitX96: 0,
                deadline: ethers.constants.MaxUint256,
                referralCode: ethers.constants.HashZero,
            })

            // bob long 0.004 btc, quote = -206.043488060393185524
            await clearingHouse.connect(bob).openPosition({
                baseToken: baseToken2.address,
                isBaseToQuote: false,
                isExactInput: false,
                oppositeAmountBound: 0,
                amount: parseEther("0.004"),
                sqrtPriceLimitX96: 0,
                deadline: ethers.constants.MaxUint256,
                referralCode: ethers.constants.HashZero,
            })

            // bob adds liquidity on btc pool
            await clearingHouse.connect(bob).addLiquidity({
                baseToken: baseToken2.address,
                base: 0,
                quote: parseEther("0.001"),
                lowerTick: 200,
                upperTick: 400,
                minBase: 0,
                minQuote: 0,
                useTakerBalance: false,
                deadline: ethers.constants.MaxUint256,
            })
        })

        it("can cancel orders successfully when account is liquidable", async () => {
            // x: new eth price
            // openNotional = openNotional(eth) + openNotional(btc)
            //              = 98.369476739760354 + (-206.043488060393185524)
            //              = -107.6740113206
            // positionValue = -1 * x + 50000*0.004 = -x + 200
            // unrealizePnL = (-x + 200) + (-107.6740113206) = -x + 92.3259886794
            // accountValue = 30 + (-x+92.3259886794)
            // liquidate: accountValue < sum(positionValue) * mmRatio
            //         => 122.3259886794 - x < (1*x + 50000*0.004) * 0.0625
            //         => x > 103.3656364041
            // cancel order: accountValue < totalDebtValue * mmRatio
            //            => 122.3259886794 - x < (1*x + 107.6740113206) * 0.0625
            //            => x > 108.7965769147
            //
            // when 103.3656364041 < x < 108.7965769147, bob's account is liquidable but can't cancel order

            await mockMarkPrice(accountBalance, baseToken2.address, "105")

            // Bob has no order in ETH market, and can cancel order in ETH market successfully
            const tx = await clearingHouse.cancelAllExcessOrders(bob.address, baseToken.address)
            await expect(tx).to.not.emit(clearingHouse, "LiquidityChanged")

            // cancel order in BTC market successfully
            const tx2 = await clearingHouse.cancelAllExcessOrders(bob.address, baseToken2.address)
            await expect(tx2).to.emit(clearingHouse, "LiquidityChanged")
        })
    })

    it("can't liquidate others order", async () => {
        const aliceOrderId = (await orderBook.getOpenOrderIds(alice.address, baseToken.address))[0]

        // prepare collateral for bob, bob adds liquidity
        const amount = parseUnits("10", await collateral.decimals())
        await collateral.transfer(bob.address, amount)
        await deposit(bob, vault, 10, collateral)
        baseAmount = parseUnits("1", await baseToken.decimals())
        await clearingHouse.connect(bob).addLiquidity({
            baseToken: baseToken.address,
            base: baseAmount,
            quote: 0,
            lowerTick: 92000,
            upperTick: 92400,
            minBase: 0,
            minQuote: 0,
            useTakerBalance: false,
            deadline: ethers.constants.MaxUint256,
        })
        const bobOrderId = (await orderBook.getOpenOrderIds(bob.address, baseToken.address))[0]

        // alice add another range same as bob
        await collateral.transfer(alice.address, amount)
        await deposit(alice, vault, 10, collateral)
        await clearingHouse.connect(alice).addLiquidity({
            baseToken: baseToken.address,
            base: baseAmount,
            quote: 0,
            lowerTick: 92000,
            upperTick: 92400,
            minBase: 0,
            minQuote: 0,
            useTakerBalance: false,
            deadline: ethers.constants.MaxUint256,
        })
        expect(aliceOrderId).not.eq(bobOrderId)

        // mock mark price to make alice's position liquidatable
        await mockMarkPrice(accountBalance, baseToken.address, "100000")

        await expect(
            clearingHouse.connect(bob).cancelExcessOrders(alice.address, baseToken.address, [aliceOrderId, bobOrderId]),
        ).be.revertedWith("CH_ONBM")
    })
})
