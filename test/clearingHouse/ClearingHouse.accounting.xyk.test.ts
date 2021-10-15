import { MockContract } from "@eth-optimism/smock"
import { expect } from "chai"
import { BigNumber, BigNumberish, ContractTransaction } from "ethers"
import { parseEther, parseUnits } from "ethers/lib/utils"
import { ethers, waffle } from "hardhat"
import {
    AccountBalance,
    BaseToken,
    Exchange,
    InsuranceFund,
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
import { createClearingHouseFixture } from "./fixtures"

// https://docs.google.com/spreadsheets/d/1QwN_UZOiASv3dPBP7bNVdLR_GTaZGUrHW3-29ttMbLs/edit#gid=1341567235
describe("ClearingHouse accounting verification in xyk pool", () => {
    const [admin, maker, taker] = waffle.provider.getWallets()
    const loadFixture: ReturnType<typeof waffle.createFixtureLoader> = waffle.createFixtureLoader([admin])
    let clearingHouse: TestClearingHouse
    let marketRegistry: MarketRegistry
    let exchange: Exchange
    let orderBook: OrderBook
    let accountBalance: AccountBalance
    let vault: Vault
    let insuranceFund: InsuranceFund
    let collateral: TestERC20
    let baseToken: BaseToken
    let quoteToken: QuoteToken
    let pool: UniswapV3Pool
    let mockedBaseAggregator: MockContract
    let collateralDecimals: number
    let lowerTick: number
    let upperTick: number

    beforeEach(async () => {
        const uniFeeRatio = 500 // 0.05%
        const exFeeRatio = 1000 // 0.1%

        const _clearingHouseFixture = await loadFixture(createClearingHouseFixture(true, uniFeeRatio))
        clearingHouse = _clearingHouseFixture.clearingHouse as TestClearingHouse
        orderBook = _clearingHouseFixture.orderBook
        exchange = _clearingHouseFixture.exchange
        accountBalance = _clearingHouseFixture.accountBalance
        marketRegistry = _clearingHouseFixture.marketRegistry
        vault = _clearingHouseFixture.vault
        collateral = _clearingHouseFixture.USDC
        baseToken = _clearingHouseFixture.baseToken
        quoteToken = _clearingHouseFixture.quoteToken
        insuranceFund = _clearingHouseFixture.insuranceFund
        mockedBaseAggregator = _clearingHouseFixture.mockedBaseAggregator
        pool = _clearingHouseFixture.pool
        collateralDecimals = await collateral.decimals()

        mockedBaseAggregator.smocked.latestRoundData.will.return.with(async () => {
            return [0, parseUnits("10", 6), 0, 0, 0]
        })

        await pool.initialize(encodePriceSqrt("10", "1"))
        // the initial number of oracle can be recorded is 1; thus, have to expand it
        await pool.increaseObservationCardinalityNext((2 ^ 16) - 1)

        // update config
        await marketRegistry.addPool(baseToken.address, uniFeeRatio)
        await marketRegistry.setFeeRatio(baseToken.address, exFeeRatio)
        await marketRegistry.setInsuranceFundFeeRatio(baseToken.address, 100000) // 10%

        const tickSpacing = await pool.tickSpacing()
        lowerTick = getMinTick(tickSpacing)
        upperTick = getMaxTick(tickSpacing)

        // prepare collateral for maker
        const makerCollateralAmount = parseUnits("1000", collateralDecimals)
        await collateral.mint(maker.address, makerCollateralAmount)
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
            deadline: ethers.constants.MaxUint256,
        })

        // prepare collateral for taker
        const takerCollateral = parseUnits("100", collateralDecimals)
        await collateral.mint(taker.address, takerCollateral)
        await collateral.connect(taker).approve(clearingHouse.address, takerCollateral)
        await deposit(taker, vault, 100, collateral)

        // expect all available and debt are zero
        const [baseBalance, quoteBalance] = await clearingHouse.getTokenBalance(taker.address, baseToken.address)
        expect(baseBalance).be.deep.eq(parseEther("0"))
        expect(quoteBalance).be.deep.eq(parseEther("0"))
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
        const takerPosSize = await accountBalance.getPositionSize(taker.address, baseToken.address)
        const makerPosSize = await accountBalance.getPositionSize(maker.address, baseToken.address)
        return takerPosSize.add(makerPosSize)
    }

    it("taker's balance after = taker's balance before + realizedPnl", async () => {
        await takerLongExactInput(100)
        await takerCloseEth()
        const freeCollateral = await vault.getFreeCollateral(taker.address)

        await vault.connect(taker).withdraw(collateral.address, freeCollateral.toString())

        // 100 - 0.199900000000000024 ~= 99.800099
        expect(await collateral.balanceOf(taker.address)).eq(parseUnits("99.800099", 6))
    })

    it("won't emit funding payment settled event since the time is freeze", async () => {
        const openPositionTx = await takerLongExactInput(100)
        expect(openPositionTx).not.to.emit(exchange, "FundingPaymentSettled")
        const closePositionTx = await takerCloseEth()
        expect(closePositionTx).not.to.emit(exchange, "FundingPaymentSettled")
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
            await takerLongExactInput(100)
            expect(await getTakerMakerPositionSizeDelta()).be.closeTo(BigNumber.from(0), 2)

            await takerCloseEth()
            expect((await accountBalance.getPositionSize(maker.address, baseToken.address)).toString()).eq("0")

            await makerRemoveLiquidity()
        })

        it("taker short exact input", async () => {
            await takerShortExactInput(1)
            expect(await getTakerMakerPositionSizeDelta()).be.closeTo(BigNumber.from(0), 2)

            await takerCloseEth()
            expect((await accountBalance.getPositionSize(maker.address, baseToken.address)).toString()).eq("0")

            await makerRemoveLiquidity()
        })

        it("taker long exact output", async () => {
            await takerLongExactOutput(1)
            expect(await getTakerMakerPositionSizeDelta()).be.closeTo(BigNumber.from(0), 2)

            await takerCloseEth()
            expect((await accountBalance.getPositionSize(maker.address, baseToken.address)).toString()).eq("0")

            await makerRemoveLiquidity()
        })

        it("taker short exact output", async () => {
            await takerShortExactOutput(100)
            expect(await getTakerMakerPositionSizeDelta()).be.closeTo(BigNumber.from(0), 2)

            await takerCloseEth()
            expect((await accountBalance.getPositionSize(maker.address, baseToken.address)).toString()).eq("0")

            await makerRemoveLiquidity()
        })
    })

    it("has same realizedPnl once everyone close their position", async () => {
        const openPositionTx = await takerLongExactInput(100)
        expect(openPositionTx).to.emit(exchange, "PositionChanged").withArgs(
            taker.address, // trader
            baseToken.address, // baseToken
            "9082643876716065096", // exchangedPositionSize
            "-99900000000000000000", // exchangedPositionNotional
            "100000000000000001", // fee
            "-100000000000000000001", // openNotional
            "0", // realizedPnl
            "275570539067715219511427190085", // sqrtPriceAfter
        )

        const closePositionTx = await takerCloseEth()
        expect(closePositionTx).to.emit(exchange, "PositionChanged").withArgs(
            taker.address, // trader
            baseToken.address, // baseToken
            "-9082643876716065096", // exchangedPositionSize
            "99899999999999999978", // exchangedPositionNotional
            "99900000000000001", // fee
            "-199900000000000024", // openNotional
            "-199900000000000024", // realizedPnl
            "250541448375047931191432615077", // sqrtPriceAfter
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
        expect(makerRemoveLiquidityTx).to.emit(orderBook, "LiquidityChanged").withArgs(
            maker.address,
            baseToken.address,
            quoteToken.address,
            lowerTick,
            upperTick,
            "-99999999999999999982", // return base
            "-1000000000000000000019", // return quote
            "-316227766016837933205", // liquidity
            "179909999999999999", // fee (100000000000000001 + 99900000000000001) * 90%
        )

        // ifOwedRealizedPnl + taker's realizedPnl from event + maker's quoteFee from event ~= 0
        const ifOwedRealizedPnl = (await accountBalance.getOwedAndUnrealizedPnl(insuranceFund.address))[0]
        expect(
            ifOwedRealizedPnl.add(BigNumber.from("179909999999999999")).sub(BigNumber.from("199900000000000024")),
        ).be.closeTo(BigNumber.from("0"), 25)
    })
})
