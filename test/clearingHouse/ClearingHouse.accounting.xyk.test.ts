import { MockContract } from "@eth-optimism/smock"
import { expect } from "chai"
import { BigNumber, BigNumberish, ContractTransaction } from "ethers"
import { parseEther, parseUnits } from "ethers/lib/utils"
import { ethers, waffle } from "hardhat"
import { it } from "mocha"
import {
    BaseToken,
    InsuranceFund,
    OrderBook,
    QuoteToken,
    TestAccountBalance,
    TestClearingHouse,
    TestERC20,
    TestExchange,
    UniswapV3Pool,
    Vault,
} from "../../typechain"
import {
    addOrder,
    b2qExactInput,
    b2qExactOutput,
    closePosition,
    q2bExactInput,
    removeAllOrders,
} from "../helper/clearingHouseHelper"
import { initMarket } from "../helper/marketHelper"
import { deposit, mintAndDeposit } from "../helper/token"
import { forwardBothTimestamps, initiateBothTimestamps } from "../shared/time"
import { mockIndexPrice, mockMarkPrice, syncIndexToMarketPrice } from "../shared/utilities"
import { ClearingHouseFixture, createClearingHouseFixture } from "./fixtures"

// https://docs.google.com/spreadsheets/d/1QwN_UZOiASv3dPBP7bNVdLR_GTaZGUrHW3-29ttMbLs/edit#gid=1341567235
describe("ClearingHouse accounting verification in xyk pool", () => {
    const [admin, maker, taker, maker2, taker2, maker3, taker3] = waffle.provider.getWallets()
    const loadFixture: ReturnType<typeof waffle.createFixtureLoader> = waffle.createFixtureLoader([admin])
    let clearingHouse: TestClearingHouse
    let exchange: TestExchange
    let orderBook: OrderBook
    let accountBalance: TestAccountBalance
    let vault: Vault
    let insuranceFund: InsuranceFund
    let collateral: TestERC20
    let baseToken: BaseToken
    let quoteToken: QuoteToken
    let pool: UniswapV3Pool
    let mockedPriceFeedDispatcher: MockContract
    let collateralDecimals: number
    let lowerTick: number
    let upperTick: number
    let fixture: ClearingHouseFixture

    let makerCollateral: BigNumber
    let takerCollateral: BigNumber

    beforeEach(async () => {
        const uniFeeRatio = 500 // 0.05%
        const exFeeRatio = 1000 // 0.1%

        fixture = await loadFixture(createClearingHouseFixture(undefined, uniFeeRatio))
        clearingHouse = fixture.clearingHouse as TestClearingHouse
        orderBook = fixture.orderBook
        exchange = fixture.exchange as TestExchange
        accountBalance = fixture.accountBalance as TestAccountBalance
        vault = fixture.vault
        collateral = fixture.USDC
        baseToken = fixture.baseToken
        quoteToken = fixture.quoteToken
        insuranceFund = fixture.insuranceFund
        mockedPriceFeedDispatcher = fixture.mockedPriceFeedDispatcher
        pool = fixture.pool
        collateralDecimals = await collateral.decimals()

        const initPrice = "10"
        const { maxTick, minTick } = await initMarket(fixture, initPrice, exFeeRatio)
        await syncIndexToMarketPrice(mockedPriceFeedDispatcher, pool)

        lowerTick = minTick
        upperTick = maxTick

        // prepare collateral for maker
        makerCollateral = parseUnits("1000", collateralDecimals)
        await collateral.mint(maker.address, makerCollateral)
        await deposit(maker, vault, 1000, collateral)

        // maker add liquidity
        await clearingHouse.connect(maker).addLiquidity({
            baseToken: baseToken.address,
            base: parseEther("100"),
            quote: parseEther("1000"),
            lowerTick,
            upperTick,
            minBase: 0,
            minQuote: 0,
            useTakerBalance: false,
            deadline: ethers.constants.MaxUint256,
        })

        // prepare collateral for taker
        takerCollateral = parseUnits("100", collateralDecimals)
        await collateral.mint(taker.address, takerCollateral)
        await collateral.connect(taker).approve(clearingHouse.address, takerCollateral)
        await deposit(taker, vault, 100, collateral)

        // expect all available and debt are zero
        const [baseBalance, quoteBalance] = await clearingHouse.getTokenBalance(taker.address, baseToken.address)
        expect(baseBalance).be.deep.eq(parseEther("0"))
        expect(quoteBalance).be.deep.eq(parseEther("0"))

        // maker2
        // prepare collateral for maker2
        await collateral.mint(maker2.address, makerCollateral)
        await deposit(maker2, vault, 1000, collateral)

        // taker2
        // prepare collateral for taker2
        await collateral.mint(taker2.address, takerCollateral)
        await deposit(taker2, vault, 100, collateral)

        // maker3
        // prepare collateral for maker2
        await collateral.mint(maker3.address, makerCollateral)
        await deposit(maker3, vault, 1000, collateral)

        // taker3
        // prepare collateral for taker2
        await collateral.mint(taker3.address, takerCollateral)
        await deposit(taker3, vault, 100, collateral)

        // increase insuranceFund capacity
        await collateral.mint(insuranceFund.address, parseUnits("1000000", 6))

        // initiate both the real and mocked timestamps to enable hard-coded funding related numbers
        // NOTE: Should be the last step in beforeEach
        await initiateBothTimestamps(clearingHouse)
    })

    function takerLongExactInput(amount): Promise<ContractTransaction> {
        return clearingHouse.connect(taker).openPosition({
            baseToken: baseToken.address,
            isBaseToQuote: false,
            isExactInput: true,
            oppositeAmountBound: 0,
            amount: parseEther(amount.toString()),
            sqrtPriceLimitX96: 0,
            deadline: ethers.constants.MaxUint256,
            referralCode: ethers.constants.HashZero,
        })
    }

    function takerShortExactInput(amount): Promise<ContractTransaction> {
        return clearingHouse.connect(taker).openPosition({
            baseToken: baseToken.address,
            isBaseToQuote: true,
            isExactInput: true,
            oppositeAmountBound: 0,
            amount: parseEther(amount.toString()),
            sqrtPriceLimitX96: 0,
            deadline: ethers.constants.MaxUint256,
            referralCode: ethers.constants.HashZero,
        })
    }

    function takerLongExactOutput(amount): Promise<ContractTransaction> {
        return clearingHouse.connect(taker).openPosition({
            baseToken: baseToken.address,
            isBaseToQuote: false,
            isExactInput: false,
            oppositeAmountBound: 0,
            amount: parseEther(amount.toString()),
            sqrtPriceLimitX96: 0,
            deadline: ethers.constants.MaxUint256,
            referralCode: ethers.constants.HashZero,
        })
    }

    function takerShortExactOutput(amount): Promise<ContractTransaction> {
        return clearingHouse.connect(taker).openPosition({
            baseToken: baseToken.address,
            isBaseToQuote: true,
            isExactInput: false,
            oppositeAmountBound: 0,
            amount: parseEther(amount.toString()),
            sqrtPriceLimitX96: 0,
            deadline: ethers.constants.MaxUint256,
            referralCode: ethers.constants.HashZero,
        })
    }

    function takerCloseEth(): Promise<ContractTransaction> {
        return clearingHouse.connect(taker).closePosition({
            baseToken: baseToken.address,
            sqrtPriceLimitX96: 0,
            oppositeAmountBound: 0,
            deadline: ethers.constants.MaxUint256,
            referralCode: ethers.constants.HashZero,
        })
    }

    async function makerRemoveLiquidity(): Promise<ContractTransaction> {
        const order = await orderBook.getOpenOrder(maker.address, baseToken.address, lowerTick, upperTick)
        const liquidity = order.liquidity
        return clearingHouse.connect(maker).removeLiquidity({
            baseToken: baseToken.address,
            lowerTick,
            upperTick,
            liquidity,
            minBase: 0,
            minQuote: 0,
            deadline: ethers.constants.MaxUint256,
        })
    }

    async function getTakerMakerPositionSizeDelta(): Promise<BigNumberish> {
        const takerPosSize = await accountBalance.getTotalPositionSize(taker.address, baseToken.address)
        const makerPosSize = await accountBalance.getTotalPositionSize(maker.address, baseToken.address)
        return takerPosSize.add(makerPosSize)
    }

    it("taker's balance after = taker's balance before + realizedPnl", async () => {
        await takerLongExactInput(10)
        await takerCloseEth()
        const freeCollateral = await vault.getFreeCollateral(taker.address)

        await vault.connect(taker).withdraw(collateral.address, freeCollateral.toString())

        // 100 - 0.0199900000000000024 ~= 99.98001
        expect(await collateral.balanceOf(taker.address)).eq(parseUnits("99.980009", 6))
    })

    it("won't emit funding payment settled event since the time is freeze", async () => {
        const openPositionTx = await takerLongExactInput(10)
        await expect(openPositionTx).not.to.emit(clearingHouse, "FundingPaymentSettled")
        const closePositionTx = await takerCloseEth()
        await expect(closePositionTx).not.to.emit(clearingHouse, "FundingPaymentSettled")
    })

    describe("zero sum game", () => {
        afterEach(async () => {
            // taker original 100 + maker original 1000 = taker after + maker after + insurance fund
            const takerFreeCollateral = await vault.getFreeCollateral(taker.address)
            const makerFreeCollateral = await vault.getFreeCollateral(maker.address)
            const insuranceFreeCollateral = await vault.getFreeCollateral(insuranceFund.address)
            expect(takerFreeCollateral.add(makerFreeCollateral).add(insuranceFreeCollateral)).to.be.closeTo(
                parseUnits("1100", 6),
                2,
            )
        })

        it("taker long exact input", async () => {
            await takerLongExactInput(10)
            expect(await getTakerMakerPositionSizeDelta()).be.closeTo(BigNumber.from(0), 2)

            await takerCloseEth()
            expect((await accountBalance.getTotalPositionSize(maker.address, baseToken.address)).toString()).eq("0")

            await makerRemoveLiquidity()
        })

        it("taker short exact input", async () => {
            await takerShortExactInput(1)
            expect(await getTakerMakerPositionSizeDelta()).be.closeTo(BigNumber.from(0), 2)

            await takerCloseEth()
            expect((await accountBalance.getTotalPositionSize(maker.address, baseToken.address)).toString()).eq("0")

            await makerRemoveLiquidity()
        })

        it("taker long exact output", async () => {
            await takerLongExactOutput(1)
            expect(await getTakerMakerPositionSizeDelta()).be.closeTo(BigNumber.from(0), 2)

            await takerCloseEth()
            expect((await accountBalance.getTotalPositionSize(maker.address, baseToken.address)).toString()).eq("0")

            await makerRemoveLiquidity()
        })

        it("taker short exact output", async () => {
            await takerShortExactOutput(10)
            expect(await getTakerMakerPositionSizeDelta()).be.closeTo(BigNumber.from(0), 2)

            await takerCloseEth()
            expect((await accountBalance.getTotalPositionSize(maker.address, baseToken.address)).toString()).eq("0")

            await makerRemoveLiquidity()
        })
    })

    it("has same realizedPnl once everyone close their position", async () => {
        const openPositionTx = await takerLongExactInput(10)
        await expect(openPositionTx).to.emit(clearingHouse, "PositionChanged").withArgs(
            taker.address, // trader
            baseToken.address, // baseToken
            "989118704145585599", // exchangedPositionSize
            "-9989999999999999999", // exchangedPositionNotional
            "10000000000000001", // fee
            "-10000000000000000000", // openNotional
            "0", // realizedPnl
            "253044357444314660018820777121", // sqrtPriceAfterX96
        )

        const closePositionTx = await takerCloseEth()
        await expect(closePositionTx).to.emit(clearingHouse, "PositionChanged").withArgs(
            taker.address, // trader
            baseToken.address, // baseToken
            "-989118704145585599", // exchangedPositionSize
            "9989999999999999988", // exchangedPositionNotional
            "9990000000000001", // fee
            "0", // openNotional
            "-19990000000000013", // realizedPnl
            "250541448375047931188927200593", // sqrtPriceAfterX96
        )

        // maker remove liquidity
        const order = await orderBook.getOpenOrder(maker.address, baseToken.address, lowerTick, upperTick)
        const liquidity = order.liquidity
        const makerRemoveLiquidityTx = await clearingHouse.connect(maker).removeLiquidity({
            baseToken: baseToken.address,
            lowerTick,
            upperTick,
            liquidity,
            minBase: 0,
            minQuote: 0,
            deadline: ethers.constants.MaxUint256,
        })
        await expect(makerRemoveLiquidityTx).to.emit(clearingHouse, "LiquidityChanged").withArgs(
            maker.address,
            baseToken.address,
            quoteToken.address,
            lowerTick,
            upperTick,
            "-99999999999999999983", // return base
            "-1000000000000000000009", // return quote
            "-316227766016837933205", // liquidity
            "17990999999999999", // fee (10000000000000001 + 9990000000000001) * 90%
        )

        // ifOwedRealizedPnl + taker's realizedPnl from event + maker's quoteFee from event ~= 0
        const ifOwedRealizedPnl = (await accountBalance.getPnlAndPendingFee(insuranceFund.address))[0]
        expect(
            ifOwedRealizedPnl.add(BigNumber.from("17990999999999999")).sub(BigNumber.from("19990000000000013")),
        ).be.closeTo(BigNumber.from("0"), 25)
    })

    describe("complicated test", async () => {
        let totalCollateralWithdrawn: BigNumber

        beforeEach(() => {
            totalCollateralWithdrawn = BigNumber.from(0)
        })

        afterEach(async () => {
            const users = [maker, maker2, maker3, taker, taker2, taker3]

            let totalAccountValue = BigNumber.from(0)
            const totalCollateralDeposited = makerCollateral.mul(3).add(takerCollateral.mul(3))

            for (const user of users) {
                const accountValue = await clearingHouse.getAccountValue(user.address)
                totalAccountValue = totalAccountValue.add(accountValue)
            }
            const insuranceFundSettlementTokenValue = await vault.getSettlementTokenValue(insuranceFund.address)

            // rounding error in 6 decimals with 1wei
            expect(totalAccountValue.div(1e12).add(insuranceFundSettlementTokenValue)).to.be.closeTo(
                totalCollateralDeposited.sub(totalCollateralWithdrawn),
                4,
            )
        })

        it("single take", async () => {
            // taker open, taker fee 10 * 0.1% = 0.01
            await q2bExactInput(fixture, taker, 10)

            // maker move liquidity
            await removeAllOrders(fixture, maker)
            await syncIndexToMarketPrice(mockedPriceFeedDispatcher, pool)
            await addOrder(fixture, maker, 100, 1000, lowerTick + 6000, upperTick - 6000)

            // taker close
            await closePosition(fixture, taker)
            expect(await accountBalance.getTotalPositionSize(maker.address, baseToken.address)).to.be.deep.eq(0)

            // maker account value = freeCollateral + unsettled PnL
            const makerAccountValue = await clearingHouse.getAccountValue(maker.address)
            const makerCollateral = await vault.getBalance(maker.address)
            const [makerOwedRealizedPnl, makerUnsettledPnL, fee] = await accountBalance.getPnlAndPendingFee(
                maker.address,
            )
            expect(makerAccountValue).to.be.deep.eq(
                makerCollateral.add(makerOwedRealizedPnl.add(makerUnsettledPnL).add(fee).div(1e12)).mul(1e12),
            )

            // maker remove liquidity
            await removeAllOrders(fixture, maker)
        })

        it("multiple takes with rounding error", async () => {
            // taker, taker2, taker3 open
            await q2bExactInput(fixture, taker, 12.345678)
            await q2bExactInput(fixture, taker2, 26.54321)
            await b2qExactInput(fixture, taker3, 0.321)

            // maker move liquidity
            await removeAllOrders(fixture, maker)
            await syncIndexToMarketPrice(mockedPriceFeedDispatcher, pool)
            await addOrder(fixture, maker, 100, 1000, lowerTick + 2000, upperTick - 2000)

            // taker, taker2, taker3 close
            await closePosition(fixture, taker)
            await closePosition(fixture, taker2)
            await closePosition(fixture, taker3)

            expect(await accountBalance.getTotalPositionSize(maker.address, baseToken.address)).to.be.deep.eq(0)

            // maker remove liquidity
            await removeAllOrders(fixture, maker)
        })

        it("multiple makers with multiple takers", async () => {
            // taker, taker2, taker3 open
            await q2bExactInput(fixture, taker, 5.456)
            await q2bExactInput(fixture, taker2, 0.123)
            await b2qExactInput(fixture, taker3, 0.987)

            // maker2, maker3 add liquidity
            await syncIndexToMarketPrice(mockedPriceFeedDispatcher, pool)
            await addOrder(fixture, maker2, 100, 1000, lowerTick, upperTick)
            await addOrder(fixture, maker3, 100, 1000, lowerTick, upperTick)

            // taker, taker2, taker3 close
            await closePosition(fixture, taker)
            await closePosition(fixture, taker2)
            await closePosition(fixture, taker3)

            const maker1PositionSize = await accountBalance.getTotalPositionSize(maker.address, baseToken.address)
            const maker2PositionSize = await accountBalance.getTotalPositionSize(maker2.address, baseToken.address)
            const maker3PositionSize = await accountBalance.getTotalPositionSize(maker3.address, baseToken.address)
            expect(maker1PositionSize.add(maker2PositionSize).add(maker3PositionSize)).to.be.closeTo("0", 10)

            // makers remove liquidity
            await removeAllOrders(fixture, maker)
            await removeAllOrders(fixture, maker2)
            await removeAllOrders(fixture, maker3)
        })

        it("discontinuous liquidity", async () => {
            // remove maker1 liquidity
            await removeAllOrders(fixture, maker)

            // maker1 and maker2 add liquidity
            // current tick = 23027
            await addOrder(fixture, maker, 2, 200, 23000, 23600)
            await addOrder(fixture, maker2, 2, 200, 24000, 27000)

            // end tick = 23445
            await q2bExactInput(fixture, taker, 15)

            // taker close position
            await closePosition(fixture, taker)

            const maker1PositionSize = await accountBalance.getTotalPositionSize(maker.address, baseToken.address)
            const maker2PositionSize = await accountBalance.getTotalPositionSize(maker2.address, baseToken.address)
            expect(maker1PositionSize.add(maker2PositionSize)).to.be.closeTo("0", 10)

            // maker remove liquidity
            await removeAllOrders(fixture, maker)
            await removeAllOrders(fixture, maker2)
        })

        it("taker takes profit", async () => {
            // taker open, taker fee 10 * 0.1% = 0.01
            await q2bExactInput(fixture, taker, 10)

            // maker move
            await removeAllOrders(fixture, maker)
            await syncIndexToMarketPrice(mockedPriceFeedDispatcher, pool)
            await addOrder(fixture, maker, 100, 1000, lowerTick + 2000, upperTick - 2000)

            // taker reduce position
            await b2qExactOutput(fixture, taker, 3)

            // taker withdraw
            const takerFreeCollateral = await vault.getFreeCollateral(taker.address)
            await vault.connect(taker).withdraw(collateral.address, takerFreeCollateral)
            totalCollateralWithdrawn = totalCollateralWithdrawn.add(takerFreeCollateral)

            // taker close
            await closePosition(fixture, taker)

            expect(await accountBalance.getTotalPositionSize(maker.address, baseToken.address)).to.be.deep.eq(0)

            // maker remove liquidity
            await removeAllOrders(fixture, maker)
        })

        it("maker takes profit", async () => {
            // maker, maker2 add liquidity
            await addOrder(fixture, maker, 2, 200, lowerTick, upperTick)
            await addOrder(fixture, maker2, 2, 200, lowerTick, upperTick)

            // taker open
            await q2bExactInput(fixture, taker, 32.123)

            // maker2 remove liquidity & close position
            await removeAllOrders(fixture, maker2)
            await closePosition(fixture, maker2)

            // taker close
            await closePosition(fixture, taker)

            expect(await accountBalance.getTotalPositionSize(maker.address, baseToken.address)).to.be.deep.eq(0)

            // maker remove liquidity
            await removeAllOrders(fixture, maker)
        })

        it("funding payment arbitrage", async () => {
            // taker open
            await q2bExactInput(fixture, taker, 2.1234)
            await forwardBothTimestamps(clearingHouse, 300)

            // index price change and funding rate reversed
            // market price: 10.042470530144136
            await mockIndexPrice(mockedPriceFeedDispatcher, "11")

            // taker open reverse
            await b2qExactOutput(fixture, taker, 3)
            await forwardBothTimestamps(clearingHouse, 300)

            // taker close
            await closePosition(fixture, taker)

            // remove liquidity
            await removeAllOrders(fixture, maker)
        })

        it("price-induced liquidation", async () => {
            // maker add liquidity
            await addOrder(fixture, maker, 100, 10000, lowerTick, upperTick)

            // taker open short
            await b2qExactOutput(fixture, taker, 100)

            // mock mark price to let taker underwater
            await mockMarkPrice(accountBalance, baseToken.address, "20")

            // liquidate taker
            while (!(await accountBalance.getTotalPositionSize(taker.address, baseToken.address)).eq(0)) {
                await clearingHouse
                    .connect(taker2)
                    ["liquidate(address,address,int256)"](taker.address, baseToken.address, 0)
            }

            // liquidator takes over the trader's position
            await closePosition(fixture, taker2)
            expect(await accountBalance.getTotalPositionSize(taker2.address, baseToken.address)).to.be.deep.eq(0)

            expect(await accountBalance.getTotalPositionSize(maker.address, baseToken.address)).to.be.deep.eq(0)

            // maker remove liquidity
            await removeAllOrders(fixture, maker)
        })

        it("funding-induced liquidation", async () => {
            // maker add liquidity
            await addOrder(fixture, maker, 100, 10000, lowerTick, upperTick)
            // taker open
            await q2bExactInput(fixture, taker, 90)

            await mockMarkPrice(accountBalance, baseToken.address, "4")

            // set index price to let taker pay funding fee
            await mockIndexPrice(mockedPriceFeedDispatcher, "4")

            // taker is not liquidatable yet, even he has loss
            const marginRequirement = await accountBalance.getMarginRequirementForLiquidation(taker.address)
            expect(await clearingHouse.getAccountValue(taker.address)).to.be.gt(marginRequirement)

            // taker pays funding until bankrupt
            while ((await clearingHouse.getAccountValue(taker.address)).gt(0)) {
                await forwardBothTimestamps(clearingHouse, 8 * 60 * 60)
                await clearingHouse.connect(taker).settleAllFunding(taker.address)
            }

            // liquidate taker
            while ((await accountBalance.getTotalPositionSize(taker.address, baseToken.address)).gt(0)) {
                await clearingHouse
                    .connect(taker2)
                    ["liquidate(address,address,int256)"](taker.address, baseToken.address, 0)
            }
        })

        it("bad debt", async () => {
            // maker add liquidity
            await addOrder(fixture, maker, 100, 10000, lowerTick, upperTick)

            // taker open, quote input: 300, base output: 26.06426925
            // set index price higher, let taker can open long position
            await mockIndexPrice(mockedPriceFeedDispatcher, "15")

            await q2bExactInput(fixture, taker, 300)

            // maker move liquidity
            await removeAllOrders(fixture, maker)
            await syncIndexToMarketPrice(mockedPriceFeedDispatcher, pool)
            await addOrder(fixture, maker, 30, 10000, lowerTick, upperTick)

            // mock mark price to let taker be liquidated
            await mockMarkPrice(accountBalance, baseToken.address, "4")

            // set index price to let taker be liquidated
            await mockIndexPrice(mockedPriceFeedDispatcher, "4")

            // taker cannot close position (quote output: 184.21649272), but can be liquidated
            await expect(closePosition(fixture, taker)).to.be.revertedWith("CH_NEFCM")

            await clearingHouse
                .connect(taker2)
                ["liquidate(address,address,int256)"](taker.address, baseToken.address, parseEther("26"))

            // taker has bad debt
            expect(await clearingHouse.getAccountValue(taker.address)).to.be.lt(0)

            // maker remove liquidity
            await removeAllOrders(fixture, maker)
        })

        it("maker account value should reflect unsettled PnL", async () => {
            // maker add liquidity
            await addOrder(fixture, maker, 100, 10000, lowerTick, upperTick)

            // taker open
            await q2bExactInput(fixture, taker, 90)
        })
    })

    describe("Liquidity outage", async () => {
        it("swap all liquidity", async () => {
            // maker remove liquidity
            await removeAllOrders(fixture, maker)

            await mintAndDeposit(fixture, maker, 10000)

            // maker add liquidity, current tick 23027
            await addOrder(fixture, maker, 10, 100, 22000, 24000)

            // set index price to let taker pay funding fee
            await mockIndexPrice(mockedPriceFeedDispatcher, "11")
            // prepare collateral
            await mintAndDeposit(fixture, taker, 1000)

            // there is only around 1000 USD in the pool
            // taker swap all liquidity, current tick in pool is over 24000 (the upper tick of order)
            await clearingHouse.connect(taker).openPosition({
                baseToken: baseToken.address,
                isBaseToQuote: false,
                isExactInput: true,
                amount: parseEther("2000"),
                oppositeAmountBound: 0,
                deadline: ethers.constants.MaxUint256,
                // swap to tick 24060
                sqrtPriceLimitX96: BigNumber.from("26382122004").mul("10000000000000000000"),
                referralCode: ethers.constants.HashZero,
            })

            const { tick } = await pool.slot0()
            expect(tick).to.be.eq(24060)

            // failed to swap again, there is no liquidity in pool
            await expect(q2bExactInput(fixture, taker2, 100)).to.revertedWith("CH_F0S")

            // maker's fee are collected
            const fee = (
                await clearingHouse.connect(maker).callStatic.removeLiquidity({
                    baseToken: baseToken.address,
                    lowerTick: 22000,
                    upperTick: 24000,
                    liquidity: 0,
                    minBase: 0,
                    minQuote: 0,
                    deadline: ethers.constants.MaxUint256,
                })
            ).fee
            expect(fee).to.be.gt("0")

            // Can only open opposite positions
            await mockIndexPrice(mockedPriceFeedDispatcher, "10")

            await closePosition(fixture, taker, 0, baseToken.address)

            // taker2 can keep on swapping
            await q2bExactInput(fixture, taker2, 1)
        })
    })
})
