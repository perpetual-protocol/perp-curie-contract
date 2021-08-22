import { MockContract } from "@eth-optimism/smock"
import { expect } from "chai"
import { parseEther, parseUnits } from "ethers/lib/utils"
import { ethers, waffle } from "hardhat"
import { TestClearingHouse, TestERC20, UniswapV3Pool, Vault, VirtualToken } from "../../typechain"
import { deposit } from "../helper/token"
import { encodePriceSqrt } from "../shared/utilities"
import { BaseQuoteOrdering, createClearingHouseFixture } from "./fixtures"

describe("ClearingHouse getTotalUnrealizedPnl", () => {
    const [admin, maker, taker, taker2] = waffle.provider.getWallets()
    const loadFixture: ReturnType<typeof waffle.createFixtureLoader> = waffle.createFixtureLoader([admin])
    let clearingHouse: TestClearingHouse
    let vault: Vault
    let collateral: TestERC20
    let baseToken: VirtualToken
    let quoteToken: VirtualToken
    let pool: UniswapV3Pool
    let mockedBaseAggregator: MockContract
    let collateralDecimals: number
    const lowerTick: number = 0
    const upperTick: number = 100000

    beforeEach(async () => {
        const _clearingHouseFixture = await loadFixture(createClearingHouseFixture(BaseQuoteOrdering.BASE_0_QUOTE_1))
        clearingHouse = _clearingHouseFixture.clearingHouse as TestClearingHouse
        vault = _clearingHouseFixture.vault
        collateral = _clearingHouseFixture.USDC
        baseToken = _clearingHouseFixture.baseToken
        quoteToken = _clearingHouseFixture.quoteToken
        mockedBaseAggregator = _clearingHouseFixture.mockedBaseAggregator
        pool = _clearingHouseFixture.pool
        collateralDecimals = await collateral.decimals()

        mockedBaseAggregator.smocked.latestRoundData.will.return.with(async () => {
            return [0, parseUnits("100", 6), 0, 0, 0]
        })

        await pool.initialize(encodePriceSqrt("100", "1"))
        // the initial number of oracle can be recorded is 1; thus, have to expand it
        await pool.increaseObservationCardinalityNext((2 ^ 16) - 1)

        // add pool after it's initialized
        await clearingHouse.addPool(baseToken.address, 10000)

        // prepare collateral for maker
        const makerCollateralAmount = parseUnits("1000000", collateralDecimals)
        await collateral.mint(maker.address, makerCollateralAmount)
        await deposit(maker, vault, 1000000, collateral)

        // maker add liquidity
        await clearingHouse.connect(maker).mint(baseToken.address, parseEther("10000"))
        await clearingHouse.connect(maker).mint(quoteToken.address, parseEther("10000"))
        await clearingHouse.connect(maker).addLiquidity({
            baseToken: baseToken.address,
            base: parseEther("100"),
            quote: parseEther("10000"),
            lowerTick,
            upperTick,
            minBase: 0,
            minQuote: 0,
            deadline: ethers.constants.MaxUint256,
        })

        // prepare collateral for taker
        const takerCollateral = parseUnits("10000", collateralDecimals)
        await collateral.mint(taker.address, takerCollateral)
        await deposit(taker, vault, 10000, collateral)

        // prepare collateral for taker2
        await collateral.mint(taker2.address, takerCollateral)
        await deposit(taker2, vault, 10000, collateral)
    })

    describe("taker", () => {
        it("taker open long and price goes up", async () => {
            // taker1 open a long position
            await clearingHouse.connect(taker).openPosition({
                baseToken: baseToken.address,
                isBaseToQuote: false,
                isExactInput: true,
                amount: parseEther("100"),
                sqrtPriceLimitX96: 0,
            })
            // price after swap: 101.855079
            // position size = 0.980943170969551031
            // position value = 0.980943170969551031 * 101.855079 = 99.9140441736
            // cost basis = -100
            // pnl = -100 + 99.9140441736 = -0.0859558264
            mockedBaseAggregator.smocked.latestRoundData.will.return.with(async () => {
                return [0, parseUnits("101.855079", 6), 0, 0, 0]
            })
            expect(await clearingHouse.getTotalUnrealizedPnl(taker.address)).to.eq("-85955826385873143")

            // taker2 open a long position
            await clearingHouse.connect(taker2).openPosition({
                baseToken: baseToken.address,
                isBaseToQuote: false,
                isExactInput: true,
                amount: parseEther("100"),
                sqrtPriceLimitX96: 0,
            })

            // price after swap: 103.727208
            // taker1
            // position value = 0.980943170969551031 * 103.727208 = 101.7504963313
            // pnl = -100 + 101.7504963313 = 1.7504963313
            mockedBaseAggregator.smocked.latestRoundData.will.return.with(async () => {
                return [0, parseUnits("103.727208", 6), 0, 0, 0]
            })
            expect(await clearingHouse.getTotalUnrealizedPnl(taker.address)).to.eq("1750496331338181459")
        })

        it("taker open long and price goes down", async () => {
            // taker1 open a long position
            await clearingHouse.connect(taker).openPosition({
                baseToken: baseToken.address,
                isBaseToQuote: false,
                isExactInput: true,
                amount: parseEther("100"),
                sqrtPriceLimitX96: 0,
            })
            // price after swap: 101.855079
            // position size = 0.980943170969551031
            // position value = 0.980943170969551031 * 101.855079 = 99.9140441736
            // cost basis = -100
            // pnl = -100 + 99.9140441736 = -0.0859558264
            mockedBaseAggregator.smocked.latestRoundData.will.return.with(async () => {
                return [0, parseUnits("101.855079", 6), 0, 0, 0]
            })
            expect(await clearingHouse.getTotalUnrealizedPnl(taker.address)).to.eq("-85955826385873143")

            // taker2 open a short position
            await clearingHouse.connect(taker2).openPosition({
                baseToken: baseToken.address,
                isBaseToQuote: true,
                isExactInput: false,
                amount: parseEther("198"),
                sqrtPriceLimitX96: 0,
            })
            // B2QFee: CH actually shorts 198 / 0.99 = 200

            // price after swap: 98.125012
            // taker1
            // position value = 0.980943170969551031 * 98.125012 = 96.2550604227
            // pnl = -100 + 96.2550604227 = -3.7449395773
            mockedBaseAggregator.smocked.latestRoundData.will.return.with(async () => {
                return [0, parseUnits("98.125012", 6), 0, 0, 0]
            })
            expect(await clearingHouse.getTotalUnrealizedPnl(taker.address)).to.eq("-3744939577294753449")
        })

        it("taker open short and price goes up", async () => {
            // taker1 open a short position
            await clearingHouse.connect(taker).openPosition({
                baseToken: baseToken.address,
                isBaseToQuote: true,
                isExactInput: false,
                amount: parseEther("99"),
                sqrtPriceLimitX96: 0,
            })
            // B2QFee: CH actually shorts 99 / 0.99 = 100

            // price after swap: 98.143490
            // position size = -1.009413830572328542
            // position value = -1.009413830572328542 * 98.143490 = -99.0673961866
            // net quote amount = 99
            // pnl = 99 + -99.0673961866 = -0.0673961866
            mockedBaseAggregator.smocked.latestRoundData.will.return.with(async () => {
                return [0, parseUnits("98.143490", 6), 0, 0, 0]
            })
            expect(await clearingHouse.getTotalUnrealizedPnl(taker.address)).to.eq(parseEther("-0.067396186637020538"))

            // taker2 open a long position
            await clearingHouse.connect(taker2).openPosition({
                baseToken: baseToken.address,
                isBaseToQuote: false,
                isExactInput: true,
                amount: parseEther("100"),
                sqrtPriceLimitX96: 0,
            })

            // price after swap: 99.981348
            // taker1
            // position value = -1.009413830572328542 * 99.981348 = -100.9225554705
            // pnl = 99 + -100.9225554705 = -1.9225554705
            mockedBaseAggregator.smocked.latestRoundData.will.return.with(async () => {
                return [0, parseUnits("99.981348", 6), 0, 0, 0]
            })
            expect(await clearingHouse.getTotalUnrealizedPnl(taker.address)).to.eq(parseEther("-1.922555470465019128"))
        })

        it("taker open short and price goes down", async () => {
            // taker1 open a short position
            await clearingHouse.connect(taker).openPosition({
                baseToken: baseToken.address,
                isBaseToQuote: true,
                isExactInput: false,
                amount: parseEther("99"),
                sqrtPriceLimitX96: 0,
            })
            // B2QFee: CH actually shorts 99 / 0.99 = 100

            // price after swap: 98.143490
            // position size = -1.009413830572328542
            // position value = -1.009413830572328542 * 98.143490 = -99.0673961866
            // cost basis = 99
            // pnl = 99 + -99.0673961866 = -0.0673961866
            mockedBaseAggregator.smocked.latestRoundData.will.return.with(async () => {
                return [0, parseUnits("98.143490", 6), 0, 0, 0]
            })
            expect(await clearingHouse.getTotalUnrealizedPnl(taker.address)).to.eq(parseEther("-0.067396186637020538"))

            // taker2 open a short position
            await clearingHouse.connect(taker2).openPosition({
                baseToken: baseToken.address,
                isBaseToQuote: true,
                isExactInput: false,
                amount: parseEther("198"),
                sqrtPriceLimitX96: 0,
            })
            // B2QFee: CH actually shorts 198 / 0.99 = 200

            // price after swap: 94.446032
            // taker1
            // position value = -1.009413830572328542 * 94.446032 = -95.3351309435
            // pnl = 99 + -95.3351309435 = 3.6648690565
            mockedBaseAggregator.smocked.latestRoundData.will.return.with(async () => {
                return [0, parseUnits("94.446032", 6), 0, 0, 0]
            })
            expect(await clearingHouse.getTotalUnrealizedPnl(taker.address)).to.eq(parseEther("3.664869056523280208"))
        })
    })

    describe("maker", () => {
        it("verify maker's pnl when price goes up", async () => {
            // taker1 open a long position
            await clearingHouse.connect(taker).openPosition({
                baseToken: baseToken.address,
                isBaseToQuote: false,
                isExactInput: true,
                amount: parseEther("100"),
                sqrtPriceLimitX96: 0,
            })

            // price after swap: 101.855079
            // taker
            //  - position size = 0.980943170969551031
            // maker
            //  - position size = -0.980943170969551031
            //  - position value = -0.980943170969551031 * 101.855079 = -99.9140441736
            //  - costBasis = 100 * (1 - 1%) + 1(fee) = 100
            //  - pnl = 100 + (-99.9140441736) = 0.0859558264
            mockedBaseAggregator.smocked.latestRoundData.will.return.with(async () => {
                return [0, parseUnits("101.855079", 6), 0, 0, 0]
            })
            expect(await clearingHouse.getTotalUnrealizedPnl(maker.address)).to.eq("85955826385873040")
        })

        it("verify maker's pnl when price goes down", async () => {
            // taker1 open a short position
            await clearingHouse.connect(taker).openPosition({
                baseToken: baseToken.address,
                isBaseToQuote: true,
                isExactInput: false,
                amount: parseEther("99"),
                sqrtPriceLimitX96: 0,
            })
            // B2QFee: CH actually shorts 99 / 0.99 = 100

            // price after swap: 98.143490
            // taker
            //  - position size = -1.009413830572328542
            // maker
            //  - position size = 1.009413830572328542
            //  - position value = 1.009413830572328542 * 98.143490 = 99.0673961866
            //  - costBasis = -99
            //  - pnl = -99 + 99.0673961866 = 0.0673961866
            mockedBaseAggregator.smocked.latestRoundData.will.return.with(async () => {
                return [0, parseUnits("98.143490", 6), 0, 0, 0]
            })
            expect(await clearingHouse.getTotalUnrealizedPnl(taker.address)).to.eq(parseEther("-0.067396186637020538"))
        })

        it("maker open a long position then verify maker's pnl", async () => {
            // maker open a long position
            await clearingHouse.connect(maker).openPosition({
                baseToken: baseToken.address,
                isBaseToQuote: false,
                isExactInput: true,
                amount: parseEther("100"),
                sqrtPriceLimitX96: 0,
            })

            // maker before swap:
            //              base    quote
            //   pool       100     10000
            //   pool.fee   n/a     0
            //   CH         9900    0
            //   CH.fee     n/a     0
            //   debt       10000   10000
            //
            //   position size = 100 + 9900 - 10000 = 0
            //   cost basis = 10000 + 0 - 10000 = 0
            //   pnl = 0 + 0 = 0
            //
            // maker after swap:
            //              base            quote
            //   pool       99.0099009901   10099
            //   pool.fee   n/a             1
            //   CH         9900.9900990099 0
            //   CH.fee     n/a             0
            // TODO verify quote debt did increase by 100
            //   debt       10000           10100
            //
            //   position size = 99.0099009901 + 9900.9900990099 - 10000 = 0
            //   cost basis = 10099 + 1 - 10100 = 0
            //   pnl = 0 + 0 = 0
            expect(await clearingHouse.getTotalUnrealizedPnl(maker.address)).to.eq("0")
        })

        it("maker open a short position then verify maker's pnl", async () => {
            // maker open a short position
            await clearingHouse.connect(maker).openPosition({
                baseToken: baseToken.address,
                isBaseToQuote: true,
                isExactInput: false,
                amount: parseEther("99"),
                sqrtPriceLimitX96: 0,
            })

            // maker before swap:
            //              base        quote
            //   pool       100         10000
            //   pool.fee   n/a         0
            //   CH         9900        0
            //   CH.fee     n/a         0
            //   debt       10000       10000
            //
            //   position size = 100 + 9900 - 10000 = 0
            //   cost basis = 10000 + 0 - 10000 = 0
            //   pnl = 0 + 0 = 0
            //
            // maker after swap:
            //              base            quote
            //   pool       101.0101010101  9900
            //   pool.fee   n/a             0
            //   CH         9898.9898989899 99
            //   CH.fee     n/a             1
            //   debt       10000           10000
            //
            //   position size = 101.0101010101 + 9898.9898989899 - 10000 = 0
            //   cost basis = 9900 + 99 + 1 - 10000 = 0
            //   pnl = 0 + 0 = 0

            expect(await clearingHouse.getTotalUnrealizedPnl(maker.address)).to.eq("0")
        })
    })
})
