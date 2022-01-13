import { MockContract } from "@eth-optimism/smock"
import { expect } from "chai"
import { parseEther, parseUnits } from "ethers/lib/utils"
import { ethers, waffle } from "hardhat"
import {
    AccountBalance,
    BaseToken,
    ClearingHouse,
    Exchange,
    InsuranceFund,
    MarketRegistry,
    OrderBook,
    QuoteToken,
    TestERC20,
    UniswapV3Pool,
    Vault,
} from "../../typechain"
import { initAndAddPool } from "../helper/marketHelper"
import { getMaxTick, getMaxTickRange, getMinTick } from "../helper/number"
import { deposit } from "../helper/token"
import { encodePriceSqrt } from "../shared/utilities"
import { createClearingHouseFixture } from "./fixtures"

describe("ClearingHouse insurance fee in xyk pool", () => {
    const [admin, maker1, maker2, taker1, taker2, insurance] = waffle.provider.getWallets()
    const loadFixture: ReturnType<typeof waffle.createFixtureLoader> = waffle.createFixtureLoader([admin])
    let clearingHouse: ClearingHouse
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
        const _clearingHouseFixture = await loadFixture(createClearingHouseFixture())
        clearingHouse = _clearingHouseFixture.clearingHouse
        orderBook = _clearingHouseFixture.orderBook
        exchange = _clearingHouseFixture.exchange
        accountBalance = _clearingHouseFixture.accountBalance
        marketRegistry = _clearingHouseFixture.marketRegistry
        vault = _clearingHouseFixture.vault
        insuranceFund = _clearingHouseFixture.insuranceFund
        collateral = _clearingHouseFixture.USDC
        baseToken = _clearingHouseFixture.baseToken
        quoteToken = _clearingHouseFixture.quoteToken
        mockedBaseAggregator = _clearingHouseFixture.mockedBaseAggregator
        pool = _clearingHouseFixture.pool
        collateralDecimals = await collateral.decimals()

        mockedBaseAggregator.smocked.latestRoundData.will.return.with(async () => {
            return [0, parseUnits("10", 6), 0, 0, 0]
        })

        const tickSpacing = await pool.tickSpacing()
        lowerTick = getMinTick(tickSpacing)
        upperTick = getMaxTick(tickSpacing)

        await initAndAddPool(
            _clearingHouseFixture,
            pool,
            baseToken.address,
            encodePriceSqrt("10", "1"),
            10000,
            // set maxTickCrossed as maximum tick range of pool by default, that means there is no over price when swap
            getMaxTickRange(),
        )

        await marketRegistry.setInsuranceFundFeeRatio(baseToken.address, "400000")

        // prepare collateral for maker1
        await collateral.mint(maker1.address, parseUnits("1000", collateralDecimals))
        await deposit(maker1, vault, 1000, collateral)
        await clearingHouse.connect(maker1).addLiquidity({
            baseToken: baseToken.address,
            base: parseEther("90"),
            quote: parseEther("900"),
            lowerTick,
            upperTick,
            minBase: 0,
            minQuote: 0,
            useTakerBalance: false,
            deadline: ethers.constants.MaxUint256,
        })

        // prepare collateral for maker2
        await collateral.mint(maker2.address, parseUnits("1000", collateralDecimals))
        await deposit(maker2, vault, 1000, collateral)
        await clearingHouse.connect(maker2).addLiquidity({
            baseToken: baseToken.address,
            base: parseEther("10"),
            quote: parseEther("100"),
            lowerTick,
            upperTick,
            minBase: 0,
            minQuote: 0,
            useTakerBalance: false,
            deadline: ethers.constants.MaxUint256,
        })

        // prepare collateral for taker1 and taker 2
        const takerCollateral = parseUnits("1000", collateralDecimals)
        await collateral.mint(taker1.address, takerCollateral)
        await collateral.connect(taker1).approve(clearingHouse.address, takerCollateral)
        await deposit(taker1, vault, 1000, collateral)

        await collateral.mint(taker2.address, takerCollateral)
        await collateral.connect(taker2).approve(clearingHouse.address, takerCollateral)
        await deposit(taker2, vault, 1000, collateral)
    })

    // https://docs.google.com/spreadsheets/d/1cAldl4tb4HcnyEkxnSEnjXWYrWjt4bw2L2kstasN3VA/edit?usp=sharing
    describe("quote to base: 250q => 19.83B, maker get fee", () => {
        it("exact input 250Q", async () => {
            await clearingHouse.connect(taker1).openPosition({
                baseToken: baseToken.address,
                isBaseToQuote: false,
                isExactInput: true,
                oppositeAmountBound: 0,
                amount: parseEther("250"),
                sqrtPriceLimitX96: 0,
                deadline: ethers.constants.MaxUint256,
                referralCode: ethers.constants.HashZero,
            })
        })

        it("exact output 19.83B", async () => {
            await clearingHouse.connect(taker1).openPosition({
                baseToken: baseToken.address,
                isBaseToQuote: false,
                isExactInput: false,
                oppositeAmountBound: ethers.constants.MaxUint256,
                amount: parseEther("19.839679358717434869"),
                sqrtPriceLimitX96: 0,
                deadline: ethers.constants.MaxUint256,
                referralCode: ethers.constants.HashZero,
            })
        })

        afterEach(async () => {
            const resp1 = await clearingHouse.connect(maker1).callStatic.removeLiquidity({
                baseToken: baseToken.address,
                lowerTick,
                upperTick,
                liquidity: "0",
                minBase: 0,
                minQuote: 0,
                deadline: ethers.constants.MaxUint256,
            })
            // maker fee = swapped quote * ClearingHouseFeeRatio * (100% - InsuranceFundFeeRatio) * (maker's liquidity / total liquidity within the range)
            // 250 * 1% * 60% * 90% = 1.35
            expect(resp1.fee).eq(parseEther("1.35"))

            const resp2 = await clearingHouse.connect(maker2).callStatic.removeLiquidity({
                baseToken: baseToken.address,
                lowerTick,
                upperTick,
                liquidity: "0",
                minBase: 0,
                minQuote: 0,
                deadline: ethers.constants.MaxUint256,
            })
            // 250 * 1% * 60% * 10% ~= 0.15
            expect(resp2.fee).eq(parseEther("0.149999999999999999"))

            const [owedRealizedPnl] = await accountBalance.getPnlAndPendingFee(insuranceFund.address)
            // 250 * 1% * 40% ~= 1
            expect(owedRealizedPnl).eq(parseEther("1"))
        })
    })

    describe("base to quote: 25B => 198Q, maker get fee", () => {
        it("exact input 25B", async () => {
            await clearingHouse.connect(taker1).openPosition({
                baseToken: baseToken.address,
                isBaseToQuote: true,
                isExactInput: true,
                oppositeAmountBound: 0,
                amount: parseEther("25"),
                sqrtPriceLimitX96: 0,
                deadline: ethers.constants.MaxUint256,
                referralCode: ethers.constants.HashZero,
            })
        })

        it("exact output 198Q", async () => {
            await clearingHouse.connect(taker1).openPosition({
                baseToken: baseToken.address,
                isBaseToQuote: true,
                isExactInput: false,
                oppositeAmountBound: ethers.constants.MaxUint256,
                amount: parseEther("198"),
                sqrtPriceLimitX96: 0,
                deadline: ethers.constants.MaxUint256,
                referralCode: ethers.constants.HashZero,
            })
        })

        afterEach(async () => {
            const resp1 = await clearingHouse.connect(maker1).callStatic.removeLiquidity({
                baseToken: baseToken.address,
                lowerTick,
                upperTick,
                liquidity: "0",
                minBase: 0,
                minQuote: 0,
                deadline: ethers.constants.MaxUint256,
            })
            // 200 * 1% * 60% * 90% = 1.08
            expect(resp1.fee).eq(parseEther("1.08"))

            const resp2 = await clearingHouse.connect(maker2).callStatic.removeLiquidity({
                baseToken: baseToken.address,
                lowerTick,
                upperTick,
                liquidity: "0",
                minBase: 0,
                minQuote: 0,
                deadline: ethers.constants.MaxUint256,
            })
            // 200 * 1% * 60% * 10% ~= 0.12
            expect(resp2.fee).eq(parseEther("0.119999999999999999"))

            const [owedRealizedPnl] = await accountBalance.getPnlAndPendingFee(insuranceFund.address)
            // 200 * 1% * 40% ~= 0.8
            expect(owedRealizedPnl).eq(parseEther("0.8"))
        })
    })
})
