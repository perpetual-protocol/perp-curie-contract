import { MockContract } from "@eth-optimism/smock"
import { expect } from "chai"
import { BigNumber } from "ethers"
import { parseEther, parseUnits } from "ethers/lib/utils"
import { ethers, waffle } from "hardhat"
import {
    AccountBalance,
    BaseToken,
    ClearingHouseConfig,
    Exchange,
    MarketRegistry,
    OrderBook,
    QuoteToken,
    TestClearingHouse,
    TestERC20,
    UniswapV3Pool,
    Vault,
} from "../../typechain"
import { findPnlRealizedEvents, q2bExactOutput, removeOrder } from "../helper/clearingHouseHelper"
import { initAndAddPool } from "../helper/marketHelper"
import { getMaxTickRange } from "../helper/number"
import { deposit } from "../helper/token"
import { encodePriceSqrt } from "../shared/utilities"
import { ClearingHouseFixture, createClearingHouseFixture } from "./fixtures"

describe("ClearingHouse realizedPnl", () => {
    const [admin, maker, taker, alice] = waffle.provider.getWallets()
    const loadFixture: ReturnType<typeof waffle.createFixtureLoader> = waffle.createFixtureLoader([admin])
    let fixture: ClearingHouseFixture
    let clearingHouse: TestClearingHouse
    let marketRegistry: MarketRegistry
    let clearingHouseConfig: ClearingHouseConfig
    let exchange: Exchange
    let orderBook: OrderBook
    let accountBalance: AccountBalance
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
    let takerUsdcBalanceBefore: BigNumber
    const lowerTick: number = 46200
    const upperTick: number = 46400

    beforeEach(async () => {
        fixture = await loadFixture(createClearingHouseFixture())
        clearingHouse = fixture.clearingHouse as TestClearingHouse
        orderBook = fixture.orderBook
        accountBalance = fixture.accountBalance
        clearingHouseConfig = fixture.clearingHouseConfig
        vault = fixture.vault
        exchange = fixture.exchange
        marketRegistry = fixture.marketRegistry
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
            return [0, parseUnits("100", 6), 0, 0, 0]
        })

        await initAndAddPool(
            fixture,
            pool,
            baseToken.address,
            encodePriceSqrt("100", "1"), // tick = 46000 (1.0001^46000 = 99.4614384055)
            10000,
            // set maxTickCrossed as maximum tick range of pool by default, that means there is no over price when swap
            getMaxTickRange(),
        )

        await marketRegistry.setFeeRatio(baseToken.address, 10000)

        // prepare collateral for maker
        const makerCollateralAmount = parseUnits("1000000", collateralDecimals)
        await collateral.mint(maker.address, makerCollateralAmount)
        await deposit(maker, vault, 1000000, collateral)

        // maker add liquidity
        await clearingHouse.connect(maker).addLiquidity({
            baseToken: baseToken.address,
            base: parseEther("100"),
            quote: parseEther("0"),
            lowerTick,
            upperTick,
            minBase: 0,
            minQuote: 0,
            useTakerBalance: false,
            deadline: ethers.constants.MaxUint256,
        })
        // maker base token amount in pool = 99.999999999999999999

        // prepare collateral for taker
        takerUsdcBalanceBefore = parseUnits("1000", collateralDecimals)
        await collateral.mint(taker.address, takerUsdcBalanceBefore)
        await collateral.connect(taker).approve(clearingHouse.address, takerUsdcBalanceBefore)
        await deposit(taker, vault, 1000, collateral)

        // prepare collateral for alice
        await collateral.mint(alice.address, takerUsdcBalanceBefore)
        await collateral.connect(alice).approve(clearingHouse.address, takerUsdcBalanceBefore)
        await deposit(alice, vault, 1000, collateral)
    })

    it("has balanced realized PnL", async () => {
        let takerRealizedPnl = BigNumber.from(0)
        let makerRealizedPnl = BigNumber.from(0)

        // taker long $100 ETH
        await clearingHouse.connect(taker).openPosition({
            baseToken: baseToken.address,
            isBaseToQuote: false,
            isExactInput: true,
            amount: parseEther("100"),
            oppositeAmountBound: parseEther("0"),
            deadline: ethers.constants.MaxUint256,
            sqrtPriceLimitX96: parseEther("0"),
            referralCode: ethers.constants.HashZero,
        })
        // taker.positionSize: 0.975557443213784206
        // taker.openNotional: -100.0
        // maker.positionSize: -0.975557443213784207
        // maker.openNotional: 99.999999999999999998

        // maker move liquidity range down 10% and collect fee (first step: remove liquidity)
        const makerMoveLiquidityRemoveReceipt = await (
            await clearingHouse.connect(maker).removeLiquidity({
                baseToken: baseToken.address,
                lowerTick,
                upperTick,
                liquidity: (
                    await orderBook.getOpenOrder(maker.address, baseToken.address, lowerTick, upperTick)
                ).liquidity,
                minBase: parseEther("0"),
                minQuote: parseEther("0"),
                deadline: ethers.constants.MaxUint256,
            })
        ).wait()
        makerRealizedPnl = makerRealizedPnl.add(
            findPnlRealizedEvents(fixture, makerMoveLiquidityRemoveReceipt)[0].args.amount,
        )
        // maker.realizedPnlDelta = 0.999999999999999999

        // maker move liquidity range down 10% (second step: add liquidity)
        await clearingHouse.connect(maker).addLiquidity({
            baseToken: baseToken.address,
            base: parseEther("0"),
            quote: parseEther("10000"),
            lowerTick: lowerTick - 1000, // lower the price for about 10%
            upperTick: upperTick - 1000, // lower the price for about 10%
            minBase: parseEther("0"),
            minQuote: parseEther("0"),
            useTakerBalance: false,
            deadline: ethers.constants.MaxUint256,
        })
        // taker.positionSize: 0.975557443213784206
        // taker.openNotional: -100.0
        // maker.positionSize: -0.975557443213784207
        // maker.openNotional: 98.999999999999999998

        // taker close position
        const takerCloseReceipt = await (
            await clearingHouse.connect(taker).closePosition({
                baseToken: baseToken.address,
                sqrtPriceLimitX96: parseEther("0"),
                oppositeAmountBound: parseEther("0"),
                deadline: ethers.constants.MaxUint256,
                referralCode: ethers.constants.HashZero,
            })
        ).wait()
        takerRealizedPnl = takerRealizedPnl.add(findPnlRealizedEvents(fixture, takerCloseReceipt)[0].args.amount)
        // taker.realizedPnlDelta: -9.542011399247233633
        // taker.positionSize: 0.0
        // taker.openNotional: 0.0
        // maker.positionSize: 0.0
        // maker.openNotional: 8.54201139924723363

        // maker remove all liquidity and collect fee
        const makerRemoveLiquidityReceipt = await (
            await clearingHouse.connect(maker).removeLiquidity({
                baseToken: baseToken.address,
                lowerTick: lowerTick - 1000,
                upperTick: upperTick - 1000,
                liquidity: (
                    await orderBook.getOpenOrder(maker.address, baseToken.address, lowerTick - 1000, upperTick - 1000)
                ).liquidity,
                minBase: parseEther("0"),
                minQuote: parseEther("0"),
                deadline: ethers.constants.MaxUint256,
            })
        ).wait()

        const events = findPnlRealizedEvents(fixture, makerRemoveLiquidityReceipt)
        makerRealizedPnl = makerRealizedPnl.add(events[0].args.amount)
        // maker.realizedPnlDelta: 0.913717056573260266
        // maker.positionSize: 0.0
        // maker.liquidity: 0.0

        makerRealizedPnl = makerRealizedPnl.add(events[1].args.amount)
        // maker.realizedPnlDelta: 7.628294342673973364
        // maker.positionSize: 0.0
        // maker.openNotional: 0.0
        // maker.owedRealizedPnl: 9.542011399247233629

        // taker and maker's realized PnL should balance out each other (with some precision errors)
        expect(takerRealizedPnl.add(makerRealizedPnl)).to.be.closeTo("0", 10)

        // taker withdraw all collaterals
        const takerFreeCollateral = await vault.getFreeCollateral(taker.address)
        // taker.vaultBalanceOf: 1000.0
        // taker.freeCollateral: 990.457988
        // taker.owedRealizedPnl: -9.542011399247233633
        // taker.USDCbalance: 0.0

        await vault.connect(taker).withdraw(collateral.address, takerFreeCollateral)
        const takerUsdcBalance = await collateral.balanceOf(taker.address)
        // taker.vaultBalanceOf: 0.0
        // taker.freeCollateral: 0.0
        // taker.USDCbalance: 990.457989

        // 1000 + (-9.542011399247233633) = 990.457989
        expect(takerUsdcBalance).to.deep.eq(parseUnits("990.457989", collateralDecimals))

        // maker withdraw all
        const makerFreeCollateral = await vault.getFreeCollateral(maker.address)
        // maker.vaultBalanceOf: 1000000.0
        // maker.freeCollateral: 1000001.989998
        // maker.owedRealizedPnl: 9.542011399247233629
        // maker.USDCbalance: 0.0

        await vault.connect(maker).withdraw(collateral.address, makerFreeCollateral)
        const makerUsdcBalance = await collateral.balanceOf(maker.address)
        // maker.vaultBalanceOf(after): 0.000001
        // maker.freeCollateral(after): 0.0
        // maker.USDCbalance(after): 1,000,009.542011

        // 1,000,000 + 9.542011399247233629 = 1,000,009.542011
        expect(makerUsdcBalance).to.deep.eq(parseUnits("1000009.542011", collateralDecimals))
    })

    describe("realize pnl when removing liquidity without fee", () => {
        beforeEach(async () => {
            await marketRegistry.setFeeRatio(baseToken.address, 0)
        })

        it("long first and get short position when removing liquidity", async () => {
            // alice long 1 base token
            await q2bExactOutput(fixture, alice, 1)
            // base: 1.0
            // quote: -101.480688273230966335
            // takerBase 1.0
            // takerQuote: -101.480688273230966335

            // remove maker liquidity to maker test easier
            const makerLiquidity = (
                await orderBook.getOpenOrder(maker.address, baseToken.address, lowerTick, upperTick)
            ).liquidity
            await removeOrder(fixture, maker, makerLiquidity, lowerTick, upperTick, baseToken.address)

            // alice add liquidity without from taker
            const aliceLowerTick = 46400
            const aliceUpperTick = 46600
            await clearingHouse.connect(alice).addLiquidity({
                baseToken: baseToken.address,
                base: parseEther("2"),
                quote: 0,
                lowerTick: aliceLowerTick,
                upperTick: aliceUpperTick,
                minBase: parseEther("0"),
                minQuote: parseEther("0"),
                useTakerBalance: false,
                deadline: ethers.constants.MaxUint256,
            })
            // base: 1 - 2 = -1
            // quote: -101.480688273230966335
            // takerBase 1.0
            // takerQuote: -101.480688273230966335
            // makerBaseDebt: 2
            // makerQuoteDebt: 0

            // taker long 1 base token
            await q2bExactOutput(fixture, taker, 1)
            // taker's base: 1
            // taker's quote: -104.037901139401867011

            const aliceLiquidity = (
                await orderBook.getOpenOrder(alice.address, baseToken.address, aliceLowerTick, aliceUpperTick)
            ).liquidity

            // remove 50% liquidity
            await removeOrder(fixture, alice, aliceLiquidity.div(2), aliceLowerTick, aliceUpperTick, baseToken.address)
            // baseFromPool: 0.5
            // quoteFromPool: (104.037901139401867011) / 2 = 52.0189505697
            // deltaTakerBase: -0.5
            // deltaTakerQuote: 52.0189505697
            // makerBaseDebt: 1
            // makerQuoteDebt: 0
            // realizedPnL: takerOpenNotional * reduceRatio + deltaTakerQuote
            //            = -101.480688273230966335 * 0.5 + 52.0189505697
            //            = 1.27860643308

            // takerBase = 1 + (-0.5) = 0.5
            // takerQuote: takerOpenNotional + deltaTakerQuote - realizedPnL
            //           = -101.480688273230966335 + 52.0189505697 - 1.27860643308
            //           = -50.7403441366

            // base: base + baseFromPool = -1 + 0.5 = -0.5
            // quote: quote + quoteFromPool - realizedPnL
            //      = -101.480688273230966335 + 52.0189505697 - 1.27860643308
            //      = -50.7403441366

            expect(await accountBalance.getTakerPositionSize(alice.address, baseToken.address)).to.be.closeTo(
                parseEther("0.5"),
                1,
            )
            expect(await accountBalance.getTakerOpenNotional(alice.address, baseToken.address)).to.be.eq(
                parseEther("-50.740344136615483168"),
            )
            expect(await accountBalance.getBase(alice.address, baseToken.address)).to.be.closeTo(parseEther("-0.5"), 1)
            expect(await accountBalance.getQuote(alice.address, baseToken.address)).to.be.eq(
                parseEther("-50.740344136615483168"),
            )
            let owedRealizedPnl = (await accountBalance.getPnlAndPendingFee(alice.address))[0]
            expect(owedRealizedPnl).to.be.eq(parseEther("1.278606433085450338"))

            // remove the remaining liquidity
            await removeOrder(
                fixture,
                alice,
                (
                    await orderBook.getOpenOrder(alice.address, baseToken.address, aliceLowerTick, aliceUpperTick)
                ).liquidity,
                aliceLowerTick,
                aliceUpperTick,
                baseToken.address,
            )
            // baseFromPool: 0.5
            // quoteFromPool: (104.037901139401867011) / 2 = 52.0189505697
            // deltaTakerBase: -0.5
            // deltaTakerQuote: 52.0189505697

            // before settle:
            // base: base + baseFromPool = -0.5 + 0.5 = 0
            // takerBase = 0.5 + (-0.5) = 0
            // quote = takerQuote (no open order)
            //       = quote + quoteFromPool
            //       = -50.7403441366 + 52.0189505697
            //       = 1.2786064331
            // takerQuote: takerOpenNotional + deltaTakerQuote
            //           = -50.740344136615483168 + 52.0189505697 - 1.27860643308
            //           = -50.7403441366
            // realizedPnL = quoteBalance = 1.2786064331

            // after settle:
            // quote = takerQuote
            //       = quote - realizedPnL
            //       = 1.2786064331 - 1.2786064331 = 0
            // owedRealizedPnl = 1.278606433085450338 + 1.2786064331  = 2.55721286619

            // alice might have dust position. so can not totally settle alice's quote and base balance
            expect(await accountBalance.getTakerPositionSize(alice.address, baseToken.address)).to.be.eq(0)
            expect(await accountBalance.getTakerOpenNotional(alice.address, baseToken.address)).to.be.eq(0)
            expect(await accountBalance.getBase(alice.address, baseToken.address)).to.be.eq(0)
            expect(await accountBalance.getQuote(alice.address, baseToken.address)).to.be.eq(0)
            owedRealizedPnl = (await accountBalance.getPnlAndPendingFee(alice.address))[0]
            expect(owedRealizedPnl).to.be.eq(parseEther("2.557212866170900675"))
        })
    })
})
