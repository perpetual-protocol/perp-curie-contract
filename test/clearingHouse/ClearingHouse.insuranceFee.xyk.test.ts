import { MockContract } from "@eth-optimism/smock"
import { expect } from "chai"
import { parseEther, parseUnits } from "ethers/lib/utils"
import { ethers, waffle } from "hardhat"
import { ClearingHouse, InsuranceFund, TestERC20, UniswapV3Pool, Vault, VirtualToken } from "../../typechain"
import { getMaxTick, getMinTick } from "../helper/number"
import { deposit } from "../helper/token"
import { encodePriceSqrt } from "../shared/utilities"
import { BaseQuoteOrdering, createClearingHouseFixture } from "./fixtures"

describe.only("ClearingHouse insurance fee in xyk pool", () => {
    const [admin, maker1, maker2, taker1, taker2, insurance] = waffle.provider.getWallets()
    const loadFixture: ReturnType<typeof waffle.createFixtureLoader> = waffle.createFixtureLoader([admin])
    let clearingHouse: ClearingHouse
    let vault: Vault
    let insuranceFund: InsuranceFund
    let collateral: TestERC20
    let baseToken: VirtualToken
    let quoteToken: VirtualToken
    let pool: UniswapV3Pool
    let mockedBaseAggregator: MockContract
    let collateralDecimals: number
    let lowerTick: number
    let upperTick: number

    beforeEach(async () => {
        const _clearingHouseFixture = await loadFixture(createClearingHouseFixture(BaseQuoteOrdering.BASE_0_QUOTE_1))
        clearingHouse = _clearingHouseFixture.clearingHouse
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
        await pool.initialize(encodePriceSqrt("10", "1"))
        await clearingHouse.addPool(baseToken.address, "10000")
        await clearingHouse.setInsuranceFundFeeRatio(baseToken.address, "400000")

        const tickSpacing = await pool.tickSpacing()
        lowerTick = getMinTick(tickSpacing)
        upperTick = getMaxTick(tickSpacing)

        // prepare collateral for maker1
        await collateral.mint(maker1.address, parseUnits("1000", collateralDecimals))
        await deposit(maker1, vault, 1000, collateral)
        await clearingHouse.connect(maker1).mint(baseToken.address, parseEther("90"))
        await clearingHouse.connect(maker1).mint(quoteToken.address, parseEther("900"))
        await clearingHouse.connect(maker1).addLiquidity({
            baseToken: baseToken.address,
            base: parseEther("90"),
            quote: parseEther("900"),
            lowerTick,
            upperTick,
            minBase: 0,
            minQuote: 0,
            deadline: ethers.constants.MaxUint256,
        })

        // prepare collateral for maker2
        await collateral.mint(maker2.address, parseUnits("1000", collateralDecimals))
        await deposit(maker2, vault, 1000, collateral)
        await clearingHouse.connect(maker2).mint(baseToken.address, parseEther("10"))
        await clearingHouse.connect(maker2).mint(quoteToken.address, parseEther("100"))
        await clearingHouse.connect(maker2).addLiquidity({
            baseToken: baseToken.address,
            base: parseEther("10"),
            quote: parseEther("100"),
            lowerTick,
            upperTick,
            minBase: 0,
            minQuote: 0,
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
                amount: parseEther("250"),
                sqrtPriceLimitX96: 0,
            })
        })

        it("exact output 19.83B", async () => {
            await clearingHouse.connect(taker1).openPosition({
                baseToken: baseToken.address,
                isBaseToQuote: false,
                isExactInput: false,
                amount: parseEther("19.839679358717434869"),
                sqrtPriceLimitX96: 0,
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
            expect(resp2.fee).eq(parseEther("0.15"))

            const owedRealizedPnl = await clearingHouse.getOwedRealizedPnl(insuranceFund.address)
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
                amount: parseEther("25"),
                sqrtPriceLimitX96: 0,
            })
        })

        it("exact output 198Q", async () => {
            await clearingHouse.connect(taker1).openPosition({
                baseToken: baseToken.address,
                isBaseToQuote: true,
                isExactInput: false,
                amount: parseEther("198"),
                sqrtPriceLimitX96: 0,
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
            // 200 * 1% * 90% = 1.8
            expect(resp1.fee).eq(parseEther("1.8"))

            const resp2 = await clearingHouse.connect(maker2).callStatic.removeLiquidity({
                baseToken: baseToken.address,
                lowerTick,
                upperTick,
                liquidity: "0",
                minBase: 0,
                minQuote: 0,
                deadline: ethers.constants.MaxUint256,
            })
            // 200 * 1% * 10% ~= 0.2
            expect(resp2.fee).eq(parseEther("0.199999999999999999"))
        })
    })
})
